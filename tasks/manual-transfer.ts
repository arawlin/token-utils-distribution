import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { createTimestampFilename, formatEther, loadAllWallets, Logger } from './utils'

task('manual-transfer', '手动转账ETH')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addParam('from', '发送地址')
  .addParam('to', '接收地址')
  .addParam('amount', '转账金额 (例: 0.01, -1表示转移所有余额)')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .setAction(async (taskArgs, hre) => {
    const { configDir, from, to, amount, gasPrice } = taskArgs

    // 创建记录对象
    const operationRecord = {
      taskType: 'manual-transfer',
      network: hre.network.name,
      timestamp: new Date().toISOString(),
      parameters: {
        from,
        to,
        amount,
        gasPrice: gasPrice || 'auto',
      },
      result: {
        success: false,
        transactionHash: '',
        blockNumber: 0,
        actualGasFee: '',
        error: '',
        balancesBefore: {
          from: '',
          to: '',
        },
        balancesAfter: {
          from: '',
          to: '',
        },
      },
    }

    try {
      Logger.info('开始执行手动转账任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`发送地址: ${from}`)
      Logger.info(`接收地址: ${to}`)
      Logger.info(`转账金额: ${amount} ETH`)

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
        Logger.info('可用的钱包地址:')
        Array.from(allWallets.keys()).forEach(address => {
          Logger.info(`  ${address}`)
        })
        return
      }

      // 验证接收地址格式
      if (!ethers.isAddress(to)) {
        Logger.error(`无效的接收地址: ${to}`)
        return
      }

      // 获取发送钱包余额
      const fromBalance = await provider.getBalance(fromWallet.address)
      const toBalance = await provider.getBalance(to)

      // 记录初始余额
      operationRecord.result.balancesBefore.from = formatEther(fromBalance)
      operationRecord.result.balancesBefore.to = formatEther(toBalance)

      Logger.info(`发送钱包余额: ${formatEther(fromBalance)} ETH`)
      Logger.info(`接收钱包余额: ${formatEther(toBalance)} ETH`)

      // 处理转账金额
      let transferAmount: bigint
      if (amount === '-1') {
        // 转移所有余额，需要预留gas费
        const gasLimit = 21000n
        const gasPriceWei = gasPrice
          ? ethers.parseUnits(gasPrice, 'gwei')
          : (await coordinator.getGasPriceRecommendation(provider)).standard

        const gasFee = gasLimit * gasPriceWei

        if (fromBalance <= gasFee) {
          Logger.error(`余额不足以支付gas费用: ${formatEther(fromBalance)} ETH < ${formatEther(gasFee)} ETH`)
          return
        }

        transferAmount = fromBalance - gasFee
        Logger.info(`转移所有余额: ${formatEther(transferAmount)} ETH (预留gas: ${formatEther(gasFee)} ETH)`)
      } else {
        try {
          transferAmount = ethers.parseEther(amount)
        } catch {
          Logger.error(`无效的金额格式: ${amount}`)
          return
        }
      }

      // 检查余额是否足够
      const gasLimit = 21000n
      const gasPriceWei = gasPrice ? ethers.parseUnits(gasPrice, 'gwei') : (await coordinator.getGasPriceRecommendation(provider)).standard

      const estimatedGasFee = gasLimit * gasPriceWei
      const totalNeeded = transferAmount + estimatedGasFee

      if (fromBalance < totalNeeded) {
        Logger.error(`余额不足:`)
        Logger.error(`  当前余额: ${formatEther(fromBalance)} ETH`)
        Logger.error(`  转账金额: ${formatEther(transferAmount)} ETH`)
        Logger.error(`  预估gas费: ${formatEther(estimatedGasFee)} ETH`)
        Logger.error(`  总计需要: ${formatEther(totalNeeded)} ETH`)
        return
      }

      Logger.info(`转账详情:`)
      Logger.info(`  从: ${fromWallet.address}`)
      Logger.info(`  到: ${to}`)
      Logger.info(`  金额: ${formatEther(transferAmount)} ETH`)
      Logger.info(`  Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)
      Logger.info(`  预估gas费: ${formatEther(estimatedGasFee)} ETH`)

      // 执行转账
      Logger.info('执行转账...')

      try {
        const nonce = await coordinator.getNextNonce(fromWallet.address, provider)

        const tx = await fromWallet.sendTransaction({
          to: to,
          value: transferAmount,
          gasPrice: gasPriceWei,
          gasLimit: gasLimit,
          nonce: nonce,
        })

        Logger.info(`交易已提交: ${tx.hash}`)
        Logger.info('等待交易确认...')

        const receipt = await tx.wait()

        if (receipt?.status === 1) {
          operationRecord.result.success = true
          operationRecord.result.transactionHash = tx.hash
          operationRecord.result.blockNumber = receipt.blockNumber || 0
          operationRecord.result.actualGasFee = formatEther(receipt.gasUsed * gasPriceWei)

          Logger.info(`✅ 转账成功!`)
          Logger.info(`  交易哈希: ${tx.hash}`)
          Logger.info(`  区块号: ${receipt.blockNumber}`)
          Logger.info(`  实际gas费: ${formatEther(receipt.gasUsed * gasPriceWei)} ETH`)

          // 显示转账后余额
          const newFromBalance = await provider.getBalance(fromWallet.address)
          const newToBalance = await provider.getBalance(to)

          // 记录最终余额
          operationRecord.result.balancesAfter.from = formatEther(newFromBalance)
          operationRecord.result.balancesAfter.to = formatEther(newToBalance)

          Logger.info(`  转账后余额: ${formatEther(newFromBalance)} ETH`)
          Logger.info(`  接收钱包余额: ${formatEther(newToBalance)} ETH`)
        } else {
          Logger.error('❌ 交易失败')
          operationRecord.result.error = 'Transaction failed - status 0'
        }
      } catch (error) {
        Logger.error('转账失败:', error)
        operationRecord.result.error = error instanceof Error ? error.message : String(error)
        throw error
      }

      Logger.info('手动转账任务完成!')
    } catch (error) {
      Logger.error('手动转账任务失败:', error)

      // 记录错误信息
      operationRecord.result.error = error instanceof Error ? error.message : String(error)
    }

    // 保存操作记录
    const resultsDir = join(configDir, 'transfer-results')
    if (!existsSync(resultsDir)) {
      mkdirSync(resultsDir, { recursive: true })
    }

    const resultPath = join(resultsDir, createTimestampFilename('manual-transfer-eth'))
    writeFileSync(resultPath, JSON.stringify(operationRecord, null, 2))
    Logger.info(`操作记录已保存到: ${resultPath}`)
  })
