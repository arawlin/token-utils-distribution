import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { createTimestampFilename, formatTokenAmount, generateWalletFromPath, loadAllWallets, Logger } from './utils'

interface ConsolidationResult {
  success: number
  failed: number
  totalCollected: bigint
  transactions: Array<{
    from: string
    to: string
    amount: string
    txHash?: string
    error?: string
    status: 'success' | 'failed' | 'pending'
    type: 'token' | 'gas'
  }>
}

interface ConsolidationPlan {
  from: string
  to: string
  amount: bigint
  formattedAmount: string
  needsGas: boolean // 保留以兼容现有代码结构
  gasAmount?: bigint // 保留以兼容现有代码结构
}

task('auto-consolidate-tokens', '自动将所有钱包中的Token归集到指定地址')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('tokenAddress', 'Token合约地址')
  .addParam('targets', '目标归集地址列表，用逗号分隔 (例: 0x123...,0x456...)')
  .addOptionalParam('minBalance', '最小归集余额阈值（低于此值不归集）', '10')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('delayMin', '交易间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '交易间最大延迟（毫秒）', '5000')
  .addOptionalParam('batchSize', '每批次并发执行的转账数量', '10')
  .addOptionalParam('batchDelay', '批次间延迟时间（毫秒）', '2000')
  .addOptionalParam('autoFundGas', '当ETH余额不足时自动转账ETH', 'true')
  .addOptionalParam('fundingSource', '资助钱包地址（传递给batch-transfer-token）', process.env.FUNDING_WALLET_ADDRESS)
  .addOptionalParam('fundingDelay', '转账后等待时间（毫秒）', '5000')
  .addOptionalParam('dryRun', '是否为试运行模式（不执行实际交易）', 'false')
  .setAction(async (taskArgs, hre) => {
    const {
      configDir,
      tokenAddress,
      targets,
      minBalance,
      gasPrice,
      delayMin,
      delayMax,
      batchSize,
      batchDelay,
      autoFundGas,
      fundingSource,
      fundingDelay,
      dryRun,
    } = taskArgs

    const tokenAddressReal = tokenAddress || process.env.TOKEN_ADDRESS
    const isDryRun = dryRun === 'true'

    try {
      // 检查是否已经有 Logger 初始化，如果没有则初始化任务专用的日志文件
      const existingLogFile = Logger.getLogFile()
      const shouldCreateTaskLog = !existingLogFile || existingLogFile.includes('hardhat-')

      if (shouldCreateTaskLog) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').split('.')[0]
        const logFilename = `auto-consolidate-tokens-${hre.network.name}-${timestamp}.log`
        Logger.setLogFile(logFilename)
        Logger.info(`📝 创建任务专用日志文件: ${Logger.getLogFile()}`)
      } else {
        Logger.info(`📝 使用现有日志文件: ${existingLogFile}`)
      }

      Logger.info('🔄 开始执行Token自动归集任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`Token地址: ${tokenAddressReal}`)
      Logger.info(`试运行模式: ${isDryRun ? '是' : '否'}`)

      const minBalanceNum = parseFloat(minBalance)
      Logger.info(`最小归集余额阈值: ${minBalanceNum} Token`)

      // 验证Token合约地址
      if (!ethers.isAddress(tokenAddressReal)) {
        Logger.error('无效的Token合约地址')
        return
      }

      // 解析目标地址列表
      const targetAddresses = targets
        .split(',')
        .map((addr: string) => addr.trim())
        .filter((addr: string) => addr.length > 0)
        .map((addr: string) => addr.toLowerCase())

      if (targetAddresses.length === 0) {
        Logger.error('未提供有效的目标归集地址')
        return
      }

      Logger.info(`目标归集地址数量: ${targetAddresses.length}`)

      // 验证所有目标地址格式
      const invalidAddresses = targetAddresses.filter((addr: string) => !ethers.isAddress(addr))
      if (invalidAddresses.length > 0) {
        Logger.error(`无效的地址格式:`)
        invalidAddresses.forEach((addr: string) => Logger.error(`  ${addr}`))
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

      // 过滤出需要归集的钱包（排除目标地址与中间钱包）
      const sourceWallets = new Map<string, ethers.Wallet>()

      // 计算中间钱包地址集合
      const intermediateAddresses = new Set<string>()
      if (config?.gasDistribution?.intermediateWallets) {
        const { hdPath, count } = config.gasDistribution.intermediateWallets
        for (let i = 0; i < count; i++) {
          const w = generateWalletFromPath(masterSeed, hdPath, i)
          intermediateAddresses.add(w.address.toLowerCase())
        }
      }

      for (const [address, wallet] of allWallets) {
        if (!targetAddresses.includes(address) && !intermediateAddresses.has(address)) {
          sourceWallets.set(address, wallet)
        }
      }

      Logger.info(`已排除中间钱包数量: ${intermediateAddresses.size}`)

      Logger.info(`源钱包数量: ${sourceWallets.size}`)
      Logger.info(`目标归集地址数量: ${targetAddresses.length}`)

      // 验证目标地址是否有效（不需要在钱包列表中）
      Logger.info('目标归集地址列表:')
      targetAddresses.forEach((address: string, index: number) => {
        Logger.info(`  ${index + 1}. ${address}`)
      })

      // 创建Token合约实例
      const tokenContract = new ethers.Contract(
        tokenAddressReal,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function transfer(address to, uint256 amount) returns (bool)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
          'function name() view returns (string)',
        ],
        provider,
      )

      // 获取Token信息
      const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
      ])

      Logger.info(`Token信息: ${tokenName} (${tokenSymbol}), 精度: ${tokenDecimals}`)

      // 计算最小余额阈值（转换为bigint）
      const minBalanceThreshold = ethers.parseUnits(minBalanceNum.toString(), tokenDecimals)

      // 扫描所有源钱包的Token余额
      Logger.info('扫描所有钱包Token余额...')
      const balances = new Map<string, bigint>()
      let totalTokens = 0n
      let walletsWithTokens = 0

      const balancePromises = Array.from(sourceWallets.entries()).map(async ([address, _wallet]) => {
        try {
          const balance = await tokenContract.balanceOf(address)
          if (balance >= minBalanceThreshold) {
            balances.set(address, balance)
            totalTokens += balance
            walletsWithTokens++
            Logger.info(`  ${address}: ${formatTokenAmount(balance, tokenDecimals)} ${tokenSymbol}`)
          }
          return { address, balance }
        } catch (error) {
          Logger.error(`获取余额失败 ${address}:`, error)
          return { address, balance: 0n }
        }
      })

      await Promise.all(balancePromises)

      Logger.info(`发现 ${walletsWithTokens} 个钱包有足够Token需要归集`)
      Logger.info(`总Token数量: ${formatTokenAmount(totalTokens, tokenDecimals)} ${tokenSymbol}`)

      if (walletsWithTokens === 0) {
        Logger.info('没有钱包需要归集Token')
        return
      }

      // 获取Gas价格
      const gasPriceWei = gasPrice ? ethers.parseUnits(gasPrice, 'gwei') : (await coordinator.getGasPriceRecommendation(provider)).standard
      Logger.info(`使用Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)

      // 生成归集计划
      const consolidationPlans: ConsolidationPlan[] = []
      let targetIndex = 0

      for (const [address, balance] of balances) {
        const targetAddress = targetAddresses[targetIndex % targetAddresses.length]

        consolidationPlans.push({
          from: address,
          to: targetAddress,
          amount: balance,
          formattedAmount: formatTokenAmount(balance, tokenDecimals),
          needsGas: false, // 由 batch-transfer-token 任务自动处理
          gasAmount: undefined,
        })

        targetIndex++
      }

      Logger.info(`生成 ${consolidationPlans.length} 个归集计划`)

      // 显示归集计划预览
      Logger.info(`归集计划预览:`)
      consolidationPlans.forEach((plan, index) => {
        Logger.info(`  ${index + 1}. ${plan.from.slice(0, 10)}... → ${plan.to.slice(0, 10)}... : ${plan.formattedAmount} ${tokenSymbol}`)
      })

      if (isDryRun) {
        Logger.info('试运行模式，不执行实际交易')
        return
      }

      // 初始化结果统计
      const results: ConsolidationResult = {
        success: 0,
        failed: 0,
        totalCollected: 0n,
        transactions: [],
      }

      const batchSizeNum = parseInt(batchSize)
      const batchDelayNum = parseInt(batchDelay)

      // 执行归集 - 使用 batch-transfer-token 任务
      Logger.info('开始执行Token归集...')

      // 随机打乱归集计划
      const shuffledPlans = [...consolidationPlans]
      for (let i = shuffledPlans.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffledPlans[i], shuffledPlans[j]] = [shuffledPlans[j], shuffledPlans[i]]
      }

      Logger.info(`已随机打乱 ${shuffledPlans.length} 个归集计划`)
      shuffledPlans.forEach((plan, index) => {
        Logger.info(`  ${index + 1}. ${plan.from.slice(0, 10)}... → ${plan.to.slice(0, 10)}... : ${plan.formattedAmount} ${tokenSymbol}`)
      })

      // 将所有计划按 batchSize 分为多个批次
      const batches: ConsolidationPlan[][] = []
      for (let i = 0; i < shuffledPlans.length; i += batchSizeNum) {
        batches.push(shuffledPlans.slice(i, i + batchSizeNum))
      }

      Logger.info(`将分为 ${batches.length} 个批次执行，每批次最多 ${batchSizeNum} 个并发转账`)

      // 逐个批次执行
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const currentBatch = batches[batchIndex]
        const batchNum = batchIndex + 1

        Logger.info(`\n🔄 [批次${batchNum}/${batches.length}] 开始执行 ${currentBatch.length} 个并发转账...`)

        // 为当前批次创建并发任务
        const batchPromises = currentBatch.map(async (plan, planIndexInBatch) => {
          const globalPlanIndex = batchIndex * batchSizeNum + planIndexInBatch
          Logger.info(`\n--- [批次${batchNum}-转账${planIndexInBatch + 1}] 准备归集 ---`)
          Logger.info(`从 ${plan.from.slice(0, 10)}... 归集 ${plan.formattedAmount} ${tokenSymbol} 到 ${plan.to.slice(0, 10)}...`)

          try {
            // 调用 batch-transfer-token 任务执行单个转账，让它自动处理 gas 费
            await hre.run('batch-transfer-token', {
              configDir,
              tokenAddress: tokenAddressReal,
              from: plan.from,
              tos: plan.to, // 单个目标地址
              holdRatio: '0', // 转移所有Token，不保留
              trailingZeros: '0',
              gasPrice: gasPrice || '',
              delayMin: delayMin, // 使用用户指定的延迟
              delayMax: delayMax,
              autoFundGas: autoFundGas, // 传递给 batch-transfer-token
              fundingSource: fundingSource || '',
              fundingDelay: fundingDelay,
              ethTransferDelay: (planIndexInBatch * 1000).toString(), // 为并发任务分配不同的ETH转账延迟
            })

            Logger.info(
              `✅ [批次${batchNum}-转账${planIndexInBatch + 1}] Token归集成功: ${plan.from.slice(0, 10)}... → ${plan.to.slice(0, 10)}...`,
            )

            return {
              success: true,
              plan,
              planIndex: globalPlanIndex,
            }
          } catch (error) {
            Logger.error(`❌ [批次${batchNum}-转账${planIndexInBatch + 1}] Token归集失败:`, error)

            return {
              success: false,
              plan,
              planIndex: globalPlanIndex,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        })

        // 等待当前批次的所有转账完成
        const batchResults = await Promise.allSettled(batchPromises)

        // 处理批次结果
        let batchSuccessCount = 0
        let batchFailureCount = 0

        batchResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const taskResult = result.value
            if (taskResult.success) {
              batchSuccessCount++
              results.success++
              results.totalCollected += taskResult.plan.amount

              results.transactions.push({
                from: taskResult.plan.from,
                to: taskResult.plan.to,
                amount: taskResult.plan.formattedAmount,
                status: 'success',
                type: 'token',
              })
            } else {
              batchFailureCount++
              results.failed++

              results.transactions.push({
                from: taskResult.plan.from,
                to: taskResult.plan.to,
                amount: taskResult.plan.formattedAmount,
                error: taskResult.error,
                status: 'failed',
                type: 'token',
              })
            }
          } else {
            batchFailureCount++
            results.failed++
            const plan = currentBatch[index]

            results.transactions.push({
              from: plan.from,
              to: plan.to,
              amount: plan.formattedAmount,
              error: `任务执行异常: ${result.reason}`,
              status: 'failed',
              type: 'token',
            })
          }
        })

        Logger.info(`\n📊 [批次${batchNum}] 执行完成: 成功 ${batchSuccessCount}/${currentBatch.length}, 失败 ${batchFailureCount}`)

        // 批次间延迟（除了最后一个批次）
        if (batchIndex < batches.length - 1) {
          Logger.info(`等待 ${batchDelayNum}ms 后执行下一个批次...`)
          await new Promise(resolve => setTimeout(resolve, batchDelayNum))
        }
      }

      Logger.info('\n=== Token自动归集完成 ===')
      Logger.info(`总计: ${results.success} 成功, ${results.failed} 失败`)
      Logger.info(`总归集Token数量: ${formatTokenAmount(results.totalCollected, tokenDecimals)} ${tokenSymbol}`)

      // 显示目标地址最终余额
      Logger.info('\n=== 目标地址最终余额 ===')
      for (const targetAddress of targetAddresses) {
        try {
          const finalBalance = await tokenContract.balanceOf(targetAddress)
          Logger.info(`${targetAddress}: ${formatTokenAmount(finalBalance, tokenDecimals)} ${tokenSymbol}`)
        } catch (error) {
          Logger.error(`获取 ${targetAddress} 最终余额失败:`, error)
        }
      }

      // 保存结果到文件
      const resultDir = join(configDir, 'consolidation-results')
      const resultFileName = createTimestampFilename('auto-consolidate-tokens')
      const resultPath = join(resultDir, resultFileName)

      if (!existsSync(resultDir)) {
        mkdirSync(resultDir, { recursive: true })
      }

      const resultData = {
        ...results,
        totalCollected: results.totalCollected.toString(),
        metadata: {
          timestamp: new Date().toISOString(),
          network: hre.network.name,
          tokenAddress: tokenAddressReal,
          tokenName,
          tokenSymbol,
          tokenDecimals: Number(tokenDecimals),
          targetAddresses,
          minBalanceThreshold: minBalanceNum,
          sourceWalletsScanned: sourceWallets.size,
          walletsWithTokens,
          gasPrice: ethers.formatUnits(gasPriceWei, 'gwei') + ' gwei',
          isDryRun,
        },
      }

      writeFileSync(resultPath, JSON.stringify(resultData, null, 2))
      Logger.info(`📄 结果已保存到: ${resultPath}`)

      Logger.info('🎉 Token自动归集任务完成!')

      // 显示日志文件位置
      if (Logger.getLogFile()) {
        Logger.info(`📝 详细日志已保存到: ${Logger.getLogFile()}`)
      }
    } catch (error) {
      Logger.error('❌ Token自动归集任务失败:', error)
      if (Logger.getLogFile()) {
        Logger.info(`📝 错误日志已保存到: ${Logger.getLogFile()}`)
      }
      throw error
    }
  })
