import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { createTimestampFilename, formatTokenAmount, generateRandomTokenAmount, loadAllWallets, Logger } from './utils'

interface BatchTokenTransferResult {
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

interface TokenTransferPlan {
  from: string
  to: string
  amount: string
  amountBigInt: bigint
}

// ERC20 transfer gas: `21000 + 约 25000~50000 ≈ 45000~70000 gas. 70000 * 10 * 1e9 / 1e18 = 0.0007`

task('batch-transfer-token', '批量转账Token到多个地址')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addParam('tokenAddress', 'Token合约地址')
  .addParam('from', '发送地址')
  .addParam('tos', '接收地址列表，用逗号分隔 (例: 0x123...,0x456...)')
  .addParam('amountMin', '最小转账金额', '1')
  .addParam('amountMax', '最大转账金额', '100')
  .addOptionalParam('precision', '随机金额精度 (小数位数)')
  .addOptionalParam('trailingZeros', '末尾零的最小数量 (例: 3 表示至少以000结尾)', '0')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('batchSize', '批处理大小（并发交易数量）', '5')
  .addOptionalParam('delayMin', '交易间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '交易间最大延迟（毫秒）', '5000')
  .setAction(async (taskArgs, hre) => {
    const { configDir, tokenAddress, from, tos, amountMin, amountMax, precision, trailingZeros, gasPrice, batchSize, delayMin, delayMax } =
      taskArgs

    try {
      Logger.info('开始执行批量转账Token任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`Token地址: ${tokenAddress}`)
      Logger.info(`发送地址: ${from}`)
      Logger.info(`转账金额范围: ${amountMin} - ${amountMax}`)
      if (precision) {
        Logger.info(`指定随机金额精度: ${precision} 位小数`)
      }
      const trailingZerosNum = parseInt(trailingZeros)
      if (trailingZerosNum > 0) {
        Logger.info(`末尾零的最小数量: ${trailingZerosNum}`)
      }

      // 验证Token合约地址
      if (!ethers.isAddress(tokenAddress)) {
        Logger.error('无效的Token合约地址')
        return
      }

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

      // 验证参数
      const precisionNum = precision ? parseInt(precision) : undefined

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

      // 创建Token合约实例
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function transfer(address to, uint256 amount) returns (bool)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
          'function name() view returns (string)',
        ],
        fromWallet,
      )

      // 获取Token信息
      const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
      ])

      // 验证精度参数
      if (precisionNum !== undefined && (precisionNum < 0 || precisionNum > tokenDecimals)) {
        Logger.error(`随机金额精度必须在0-${tokenDecimals}之间`)
        return
      }

      // 验证金额范围
      try {
        const min = ethers.parseUnits(amountMin, tokenDecimals)
        const max = ethers.parseUnits(amountMax, tokenDecimals)

        if (min >= max) {
          Logger.error('最小金额必须小于最大金额')
          return
        }

        if (min <= 0n) {
          Logger.error('转账金额必须大于0')
          return
        }
      } catch (error) {
        Logger.error('无效的金额格式:', error)
        return
      }

      // 获取发送钱包Token余额
      const fromTokenBalance = await tokenContract.balanceOf(fromWallet.address)
      Logger.info(`发送钱包Token余额: ${formatTokenAmount(fromTokenBalance, tokenDecimals)} ${await tokenContract.symbol()}`)

      // 获取发送钱包ETH余额(用于gas费)
      const fromEthBalance = await provider.getBalance(fromWallet.address)
      Logger.info(`发送钱包ETH余额: ${ethers.formatEther(fromEthBalance)} ETH`)

      // 获取Gas价格
      const gasPriceWei = gasPrice ? ethers.parseUnits(gasPrice, 'gwei') : (await coordinator.getGasPriceRecommendation(provider)).standard

      Logger.info(`使用Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)

      // 生成随机转账金额并预估总费用
      const transferPlans = toAddresses.map((toAddress: string) => {
        const randomAmount = generateRandomTokenAmount(amountMin, amountMax, Number(tokenDecimals), precisionNum, trailingZerosNum)
        return {
          from: fromWallet.address,
          to: toAddress,
          amount: formatTokenAmount(randomAmount, tokenDecimals),
          amountBigInt: randomAmount,
        }
      })

      const totalTransferAmount = transferPlans.reduce((sum: bigint, plan: TokenTransferPlan) => sum + plan.amountBigInt, 0n)
      const gasLimit = 70000n // ERC20 transfer通常需要更多gas
      const totalGasFee = gasLimit * gasPriceWei * BigInt(transferPlans.length)

      Logger.info(`转账计划:`)
      Logger.info(`  转账笔数: ${transferPlans.length}`)
      Logger.info(`  总转账金额: ${formatTokenAmount(totalTransferAmount, tokenDecimals)} ${await tokenContract.symbol()}`)
      Logger.info(`  预估总gas费: ${ethers.formatEther(totalGasFee)} ETH`)

      // 检查Token余额是否足够
      if (fromTokenBalance < totalTransferAmount) {
        Logger.error(`Token余额不足:`)
        Logger.error(`  当前余额: ${formatTokenAmount(fromTokenBalance, tokenDecimals)} ${tokenSymbol}`)
        Logger.error(`  总计需要: ${formatTokenAmount(totalTransferAmount, tokenDecimals)} ${tokenSymbol}`)
        Logger.error(`  缺少: ${ethers.formatUnits(totalTransferAmount - fromTokenBalance, tokenDecimals)} ${tokenSymbol}`)
        return
      }

      // 检查ETH余额是否足够支付gas费
      if (fromEthBalance < totalGasFee) {
        Logger.error(`ETH余额不足支付gas费:`)
        Logger.error(`  当前ETH余额: ${ethers.formatEther(fromEthBalance)} ETH`)
        Logger.error(`  预估总gas费: ${ethers.formatEther(totalGasFee)} ETH`)
        Logger.error(`  缺少: ${ethers.formatEther(totalGasFee - fromEthBalance)} ETH`)
        return
      }

      Logger.info(`转账计划预览:`)
      transferPlans.forEach((plan: TokenTransferPlan, index: number) => {
        Logger.info(`  ${index + 1}. 转账 ${plan.amount} ${tokenSymbol} 到 ${plan.to}`)
      })

      // 初始化结果统计
      const results: BatchTokenTransferResult = {
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
        const batchPromises = batch.map(async (plan: TokenTransferPlan, batchIndex: number) => {
          const globalIndex = i + batchIndex

          try {
            // 添加随机延迟，避免nonce冲突
            if (batchIndex > 0) {
              const delay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
              await new Promise(resolve => setTimeout(resolve, delay))
            }

            const nonce = await provider.getTransactionCount(fromWallet.address, 'pending')

            Logger.info(
              `[${globalIndex + 1}/${transferPlans.length}] 转账 ${plan.amount} ${await tokenContract.symbol()} 到 ${plan.to.slice(0, 10)}...`,
            )

            const tx = await tokenContract.transfer(plan.to, plan.amountBigInt, {
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
      const finalTokenBalance = await tokenContract.balanceOf(fromWallet.address)
      const finalEthBalance = await provider.getBalance(fromWallet.address)
      const finalTokenSymbol = await tokenContract.symbol()
      Logger.info(`发送钱包最终Token余额: ${formatTokenAmount(finalTokenBalance, tokenDecimals)} ${finalTokenSymbol}`)
      Logger.info(`发送钱包最终ETH余额: ${ethers.formatEther(finalEthBalance)} ETH`)
      Logger.info(`实际转账: ${ethers.formatUnits(fromTokenBalance - finalTokenBalance, tokenDecimals)} ${finalTokenSymbol}`)
      Logger.info(`实际gas费: ${ethers.formatEther(fromEthBalance - finalEthBalance)} ETH`)

      // 保存结果到文件
      const resultDir = join(configDir, 'transfer-results')
      const resultFileName = createTimestampFilename('batch-transfer-token')
      const resultPath = join(resultDir, resultFileName)

      if (!existsSync(resultDir)) {
        mkdirSync(resultDir, { recursive: true })
      }

      const resultData = {
        ...results,
        metadata: {
          timestamp: new Date().toISOString(),
          network: hre.network.name,
          tokenAddress,
          tokenName,
          tokenSymbol,
          tokenDecimals: Number(tokenDecimals),
          fromAddress: from,
          totalAddresses: toAddresses.length,
          amountRange: { min: amountMin, max: amountMax },
          precision: precisionNum,
          gasPrice: ethers.formatUnits(gasPriceWei, 'gwei') + ' gwei',
        },
      }

      writeFileSync(resultPath, JSON.stringify(resultData, null, 2))
      Logger.info(`结果已保存到: ${resultPath}`)

      Logger.info('批量转账Token任务完成!')
    } catch (error) {
      Logger.error('批量转账Token任务失败:', error)
      throw error
    }
  })
