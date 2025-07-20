import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { createTimestampFilename, formatEther, generateRandomEthAmount, loadAllWallets, Logger } from './utils'

interface BatchTransferResult {
  success: number
  failed: number
  transactions: Array<{
    from: string
    to: string
    amount: string
    txHash?: string
    error?: string
    status: 'success' | 'failed' | 'pending'
  }>
}

interface TransferPlan {
  from: string
  to: string
  amount: string
  amountWei: bigint
}

task('batch-transfer-eth', '批量转账ETH到多个地址')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addParam('from', '发送地址')
  .addParam('tos', '接收地址列表，用逗号分隔 (例: 0x123...,0x456...)')
  .addParam('amountMin', '最小转账金额 (ETH)', '0.001')
  .addParam('amountMax', '最大转账金额 (ETH)', '0.01')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('batchSize', '批处理大小（并发交易数量）', '5')
  .addOptionalParam('delayMin', '交易间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '交易间最大延迟（毫秒）', '5000')
  .setAction(async (taskArgs, hre) => {
    const { configDir, from, tos, amountMin, amountMax, gasPrice, batchSize, delayMin, delayMax } = taskArgs

    try {
      Logger.info('开始执行批量转账ETH任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`发送地址: ${from}`)
      Logger.info(`转账金额范围: ${amountMin} - ${amountMax} ETH`)

      // 解析接收地址列表
      const toAddresses = tos
        .split(',')
        .map((addr: string) => addr.trim())
        .filter((addr: string) => addr.length > 0)
      if (toAddresses.length === 0) {
        Logger.error('未提供有效的接收地址')
        return
      }

      Logger.info(`接收地址数量: ${toAddresses.length}`)

      // 验证所有接收地址格式
      const invalidAddresses = toAddresses.filter((addr: string) => !ethers.isAddress(addr))
      if (invalidAddresses.length > 0) {
        Logger.error(`无效的地址格式:`)
        invalidAddresses.forEach((addr: string) => Logger.error(`  ${addr}`))
        return
      }

      // 验证金额范围
      let minAmount: bigint
      let maxAmount: bigint
      try {
        minAmount = ethers.parseEther(amountMin)
        maxAmount = ethers.parseEther(amountMax)

        if (minAmount >= maxAmount) {
          Logger.error('最小金额必须小于最大金额')
          return
        }

        if (minAmount <= 0n) {
          Logger.error('转账金额必须大于0')
          return
        }
      } catch (error) {
        Logger.error('无效的金额格式:', error)
        return
      }

      const configPath = join(configDir, 'distribution-config.json')
      const seedPath = join(configDir, 'master-seed.json')

      // 检查配置文件
      if (!existsSync(configPath) || !existsSync(seedPath)) {
        Logger.error('配置文件不存在，请先运行 init-hd-tree 任务')
        return
      }

      const provider = hre.ethers.provider

      // 加载配置
      const seedConfig = JSON.parse(readFileSync(seedPath, 'utf8'))
      const masterSeed = seedConfig.masterSeed

      const config: DistributionSystemConfig = JSON.parse(readFileSync(configPath, 'utf8'))

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)

      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      // 查找发送钱包
      const fromWallet = allWallets.get(from.toLowerCase())
      if (!fromWallet) {
        Logger.error(`未找到发送地址对应的钱包: ${from}`)
        return
      }

      // 获取发送钱包余额
      const fromBalance = await provider.getBalance(fromWallet.address)
      Logger.info(`发送钱包余额: ${formatEther(fromBalance)} ETH`)

      // 获取Gas价格
      const gasPriceWei = gasPrice ? ethers.parseUnits(gasPrice, 'gwei') : (await coordinator.getGasPriceRecommendation(provider)).standard

      Logger.info(`使用Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)

      // 生成随机转账金额并预估总费用
      const transferPlans = toAddresses.map((toAddress: string) => {
        const randomAmount = generateRandomEthAmount(amountMin, amountMax)
        return {
          from: fromWallet.address,
          to: toAddress,
          amount: formatEther(randomAmount),
          amountWei: randomAmount,
        }
      })

      const totalTransferAmount = transferPlans.reduce((sum: bigint, plan: TransferPlan) => sum + plan.amountWei, 0n)
      const gasLimit = 21000n
      const totalGasFee = gasLimit * gasPriceWei * BigInt(transferPlans.length)
      const totalNeeded = totalTransferAmount + totalGasFee

      Logger.info(`转账计划:`)
      Logger.info(`  转账笔数: ${transferPlans.length}`)
      Logger.info(`  总转账金额: ${formatEther(totalTransferAmount)} ETH`)
      Logger.info(`  预估总gas费: ${formatEther(totalGasFee)} ETH`)
      Logger.info(`  总计需要: ${formatEther(totalNeeded)} ETH`)

      // 检查余额是否足够
      if (fromBalance < totalNeeded) {
        Logger.error(`余额不足:`)
        Logger.error(`  当前余额: ${formatEther(fromBalance)} ETH`)
        Logger.error(`  总计需要: ${formatEther(totalNeeded)} ETH`)
        Logger.error(`  缺少: ${formatEther(totalNeeded - fromBalance)} ETH`)
        return
      }

      // 显示部分转账计划
      Logger.info(`转账计划预览:`)
      transferPlans.forEach((plan: TransferPlan, index: number) => {
        Logger.info(`  ${index + 1}. 转账 ${plan.amount} ETH 到 ${plan.to}`)
      })

      // 初始化结果统计
      const results: BatchTransferResult = {
        success: 0,
        failed: 0,
        transactions: [],
      }

      // 执行实际转账
      Logger.info('开始执行批量转账...')

      const batchSizeNum = parseInt(batchSize)
      const delayMinNum = parseInt(delayMin)
      const delayMaxNum = parseInt(delayMax)

      // 分批处理转账
      for (let i = 0; i < transferPlans.length; i += batchSizeNum) {
        const batch = transferPlans.slice(i, i + batchSizeNum)
        Logger.info(`\n=== 执行第 ${Math.floor(i / batchSizeNum) + 1} 批次 (${batch.length} 笔交易) ===`)

        // 并发执行当前批次
        const batchPromises = batch.map(async (plan: TransferPlan, batchIndex: number) => {
          const globalIndex = i + batchIndex

          try {
            // 添加随机延迟，避免nonce冲突
            if (batchIndex > 0) {
              const delay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
              await new Promise(resolve => setTimeout(resolve, delay))
            }

            const nonce = await provider.getTransactionCount(fromWallet.address, 'pending')

            Logger.info(`[${globalIndex + 1}/${transferPlans.length}] 转账 ${plan.amount} ETH 到 ${plan.to.slice(0, 10)}...`)

            const tx = await fromWallet.sendTransaction({
              to: plan.to,
              value: plan.amountWei,
              gasPrice: gasPriceWei,
              gasLimit: gasLimit,
              nonce: nonce,
            })

            Logger.info(`[${globalIndex + 1}] 交易已提交: ${tx.hash}`)

            // 等待确认
            const receipt = await tx.wait()

            const transaction = {
              from: plan.from,
              to: plan.to,
              amount: plan.amount,
              txHash: tx.hash,
              status: receipt?.status === 1 ? ('success' as const) : ('failed' as const),
              error: undefined as string | undefined,
            }

            if (receipt?.status === 1) {
              Logger.info(`[${globalIndex + 1}] ✅ 转账成功: ${tx.hash}`)
              results.success++
            } else {
              Logger.error(`[${globalIndex + 1}] ❌ 交易失败: ${tx.hash}`)
              transaction.error = '交易执行失败'
              results.failed++
            }

            results.transactions.push(transaction)
            return transaction
          } catch (error) {
            Logger.error(`[${globalIndex + 1}] ❌ 转账失败:`, error)

            const transaction = {
              from: plan.from,
              to: plan.to,
              amount: plan.amount,
              error: error instanceof Error ? error.message : String(error),
              status: 'failed' as const,
            }

            results.transactions.push(transaction)
            results.failed++
            return transaction
          }
        })

        // 等待当前批次完成
        await Promise.all(batchPromises)

        // 批次间延迟
        if (i + batchSizeNum < transferPlans.length) {
          const batchDelay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
          Logger.info(`批次完成，等待 ${Math.round(batchDelay)}ms 后执行下一批次...`)
          await new Promise(resolve => setTimeout(resolve, batchDelay))
        }
      }

      Logger.info('\n=== 批量转账完成 ===')
      Logger.info(`总计: ${results.success} 成功, ${results.failed} 失败`)

      // 显示最终余额
      const finalBalance = await provider.getBalance(fromWallet.address)
      Logger.info(`发送钱包最终余额: ${formatEther(finalBalance)} ETH`)
      Logger.info(`实际消耗: ${formatEther(fromBalance - finalBalance)} ETH`)

      // 保存结果到文件
      const resultDir = join(configDir, 'transfer-results')
      const resultFileName = createTimestampFilename('batch-transfer-eth')
      const resultPath = join(resultDir, resultFileName)

      if (!existsSync(resultDir)) {
        mkdirSync(resultDir, { recursive: true })
      }

      const resultData = {
        ...results,
        metadata: {
          timestamp: new Date().toISOString(),
          network: hre.network.name,
          fromAddress: from,
          totalAddresses: toAddresses.length,
          amountRange: { min: amountMin, max: amountMax },
          gasPrice: ethers.formatUnits(gasPriceWei, 'gwei') + ' gwei',
        },
      }

      writeFileSync(resultPath, JSON.stringify(resultData, null, 2))
      Logger.info(`结果已保存到: ${resultPath}`)

      Logger.info('批量转账ETH任务完成!')
    } catch (error) {
      Logger.error('批量转账ETH任务失败:', error)

      throw error
    }
  })
