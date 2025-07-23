import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { join } from 'path'
import { DistributionSystemConfig, InstitutionNode } from '../types'
import { formatTokenAmount, loadAllWallets, Logger } from './utils'

// 叶子节点乱序转账接口
interface LeafNodeShuffleTransferPlan {
  planId: string
  fromAddress: string
  toAddress: string
  institutionName: string
  holdRatio: string
  estimatedAmount?: string
}

interface LeafNodeShuffleTransferResult {
  success: boolean
  totalPlans: number
  completedPlans: number
  results: Array<{
    planId: string
    fromAddress: string
    toAddress: string
    institutionName: string
    success: boolean
    error?: string
    actualAmount?: string
  }>
}

// 添加叶子节点乱序转账任务
task('leaf-shuffle-transfer', '在所有机构叶子节点之间进行随机Token转账')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('tokenAddress', 'Token合约地址')
  .addOptionalParam('transferCount', '转账次数 (每个叶子节点的转账次数)', '3')
  .addOptionalParam('precision', '随机金额精度 (小数位数)')
  .addOptionalParam('trailingZeros', '末尾零的最小数量', '1')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('delayMin', '转账间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '转账间最大延迟（毫秒）', '5000')
  .addOptionalParam('ethTransferDelay', '并发执行时ETH转账等待延迟（毫秒）', '1000')
  .addOptionalParam('autoFundGas', '当ETH余额不足时自动转账ETH', 'true')
  .addOptionalParam('minHoldRatio', '最小保留比例', '0.01')
  .addOptionalParam('maxHoldRatio', '最大保留比例', '0.15')
  .addOptionalParam('minBalance', '最小余额阈值（低于此值跳过转账）', '100')
  .addOptionalParam('batchSize', '每批次执行的转账数量', '10')
  .addOptionalParam('batchDelay', '批次间延迟时间（毫秒）', '2000')
  .addOptionalParam('dryRun', '只显示转账计划不实际执行', 'false')
  .setAction(async (taskArgs, hre) => {
    const {
      configDir,
      tokenAddress,
      transferCount,
      precision,
      trailingZeros,
      gasPrice,
      delayMin,
      delayMax,
      ethTransferDelay,
      autoFundGas,
      minHoldRatio,
      maxHoldRatio,
      minBalance,
      batchSize,
      batchDelay,
      dryRun,
    } = taskArgs

    const tokenAddressReal = tokenAddress || process.env.TOKEN_ADDRESS

    try {
      // 检查是否已经有 Logger 初始化，如果没有则初始化任务专用的日志文件
      const existingLogFile = Logger.getLogFile()
      const shouldCreateTaskLog = !existingLogFile || existingLogFile.includes('hardhat-')

      if (shouldCreateTaskLog) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').split('.')[0]
        const logFilename = `leaf-shuffle-transfer-${hre.network.name}-${timestamp}.log`
        Logger.setLogFile(logFilename)
        Logger.info(`📝 创建任务专用日志文件: ${Logger.getLogFile()}`)
      } else {
        Logger.info(`📝 使用现有日志文件: ${existingLogFile}`)
      }

      Logger.info('🔀 开始执行叶子节点乱序转账任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`Token地址: ${tokenAddressReal}`)

      const transferCountNum = parseInt(transferCount)
      const isDryRun = dryRun === 'true'

      if (isDryRun) {
        Logger.info('🔍 DRY RUN 模式 - 仅显示转账计划，不会实际执行转账')
      }

      // 验证Token合约地址
      if (!ethers.isAddress(tokenAddressReal)) {
        Logger.error('无效的Token合约地址')
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

      Logger.info(`找到 ${config.institutionTree.length} 个机构`)

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)
      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      // 创建Token合约实例
      const [firstWallet] = allWallets.values()
      const tokenContract = new ethers.Contract(
        tokenAddressReal,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
          'function name() view returns (string)',
        ],
        firstWallet,
      )

      // 获取Token信息
      const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
      ])

      Logger.info(`Token信息: ${tokenName} (${tokenSymbol}), ${tokenDecimals} decimals`)

      // 收集所有机构的叶子节点地址
      const leafAddresses = await collectAllLeafNodeAddresses(config.institutionTree)

      if (leafAddresses.length === 0) {
        Logger.error('没有找到叶子节点地址')
        return
      }

      Logger.info(`找到 ${leafAddresses.length} 个叶子节点地址`)
      Logger.info(`转账次数: ${transferCountNum} 次/节点`)

      // 生成乱序转账计划
      const shufflePlans = await generateLeafShuffleTransferPlan(
        leafAddresses,
        transferCountNum,
        parseFloat(minHoldRatio),
        parseFloat(maxHoldRatio),
        parseFloat(minBalance),
        tokenContract,
        tokenDecimals,
        'AllInstitutions',
      )

      if (shufflePlans.length === 0) {
        Logger.error('没有生成有效的转账计划')
        return
      }

      Logger.info(`\n📋 叶子节点乱序转账计划:`)
      Logger.info(`总计 ${shufflePlans.length} 笔转账`)

      //   shufflePlans.forEach((plan, index) => {
      //     Logger.info(`\n转账 ${index + 1}: ${plan.planId}`)
      //     Logger.info(`  从: ${plan.fromAddress}`)
      //     Logger.info(`  到: ${plan.toAddress}`)
      //     Logger.info(`  保留比例: ${(parseFloat(plan.holdRatio) * 100).toFixed(1)}%`)
      //     if (plan.estimatedAmount) {
      //       Logger.info(`  预估转账量: ${plan.estimatedAmount} ${tokenSymbol}`)
      //     }
      //   })

      if (isDryRun) {
        Logger.info('\n🔍 DRY RUN 完成 - 以上为转账计划预览')
        return
      }

      // 执行乱序转账
      Logger.info('\n🚀 开始执行叶子节点乱序转账...')
      const results = await executeLeafShuffleTransfer(
        shufflePlans,
        {
          configDir,
          tokenAddress: tokenAddressReal,
          precision,
          trailingZeros,
          gasPrice,
          delayMin,
          delayMax,
          autoFundGas,
          ethTransferDelay,
        },
        {
          batchSize: parseInt(batchSize),
          batchDelay: parseInt(batchDelay),
        },
        hre,
      )

      // 输出结果统计
      Logger.info('\n📊 叶子节点乱序转账结果:')
      Logger.info(`成功完成: ${results.completedPlans}/${results.totalPlans} 笔转账`)

      results.results.forEach(result => {
        const status = result.success ? '✅' : '❌'
        Logger.info(`${status} ${result.planId}: ${result.fromAddress} → ${result.toAddress}`)
        if (result.actualAmount) {
          Logger.info(`     实际转账: ${result.actualAmount} ${tokenSymbol}`)
        }
        if (result.error) {
          Logger.error(`     错误: ${result.error}`)
        }
      })

      if (results.success) {
        Logger.info('🎉 叶子节点乱序转账完成!')
      } else {
        Logger.error('❌ 叶子节点乱序转账部分失败，请检查错误信息')
      }

      // 显示日志文件位置
      if (Logger.getLogFile()) {
        Logger.info(`📝 详细日志已保存到: ${Logger.getLogFile()}`)
      }
    } catch (error) {
      Logger.error('❌ 叶子节点乱序转账任务失败:', error)
      if (Logger.getLogFile()) {
        Logger.info(`📝 错误日志已保存到: ${Logger.getLogFile()}`)
      }
      throw error
    }
  })

// 收集所有机构的叶子节点地址
async function collectAllLeafNodeAddresses(institutions: InstitutionNode[]): Promise<string[]> {
  const allLeafAddresses: string[] = []

  for (const institution of institutions) {
    const leafAddresses = await collectLeafNodeAddresses(institution)
    allLeafAddresses.push(...leafAddresses)
  }

  return allLeafAddresses
}

// 收集单个机构的叶子节点地址
async function collectLeafNodeAddresses(institution: InstitutionNode): Promise<string[]> {
  const leafAddresses: string[] = []

  // 递归收集叶子节点
  function collectLeafNodes(node: InstitutionNode) {
    // 首先收集当前节点的地址（如果有的话）
    if (node.addresses && node.addresses.length > 0) {
      leafAddresses.push(...node.addresses)
    }

    if (node.childNodes.length === 0) {
      // 这是叶子节点（已经在上面收集了地址）
      return
    } else {
      // 继续遍历子节点
      for (const child of node.childNodes) {
        collectLeafNodes(child)
      }
    }
  }

  collectLeafNodes(institution)
  return leafAddresses
}

// 生成叶子节点乱序转账计划
async function generateLeafShuffleTransferPlan(
  leafAddresses: string[],
  transferCount: number,
  minHoldRatio: number,
  maxHoldRatio: number,
  minBalanceThreshold: number,
  tokenContract: ethers.Contract,
  tokenDecimals: number,
  institutionName: string,
): Promise<LeafNodeShuffleTransferPlan[]> {
  const plans: LeafNodeShuffleTransferPlan[] = []

  Logger.info(`\n🔍 开始筛选有效的发送地址（余额阈值: ${minBalanceThreshold} Token）...`)

  // 首先筛选出余额足够的地址作为潜在发送者
  const validSenders: string[] = []
  for (const address of leafAddresses) {
    try {
      const balance = await tokenContract.balanceOf(address)
      const balanceFormatted = parseFloat(formatTokenAmount(balance, tokenDecimals))

      if (balanceFormatted >= minBalanceThreshold) {
        validSenders.push(address)
        Logger.info(`✅ 发送者候选: ${address} (余额: ${balanceFormatted.toFixed(2)} Token)`)
      } else {
        Logger.info(`⏭️ 跳过低余额地址: ${address} (余额: ${balanceFormatted.toFixed(2)} Token, 低于阈值)`)
      }
    } catch {
      Logger.warn(`⚠️ 无法查询地址余额: ${address}`)
    }
  }

  if (validSenders.length === 0) {
    Logger.error('❌ 没有找到余额足够的发送地址')
    return plans
  }

  Logger.info(`\n📊 找到 ${validSenders.length} 个有效发送地址，开始生成转账计划...`)

  // 为每个转账生成随机的发送者和接收者
  const totalTransfers = transferCount * leafAddresses.length
  for (let i = 0; i < totalTransfers; i++) {
    // 随机选择发送者（从有余额的地址中选择）
    const randomSenderIndex = Math.floor(Math.random() * validSenders.length)
    const fromAddress = validSenders[randomSenderIndex]

    // 随机选择接收者（从所有叶子节点中选择，但不能是发送者自己）
    const availableTargets = leafAddresses.filter(addr => addr !== fromAddress)
    if (availableTargets.length === 0) continue

    const randomTargetIndex = Math.floor(Math.random() * availableTargets.length)
    const toAddress = availableTargets[randomTargetIndex]

    // 随机生成保留比例
    const holdRatio = (Math.random() * (maxHoldRatio - minHoldRatio) + minHoldRatio).toFixed(3)

    // 获取当前余额用于估算
    let estimatedAmount: string | undefined
    try {
      const balance = await tokenContract.balanceOf(fromAddress)
      if (balance > 0n) {
        const retentionRatio = parseFloat(holdRatio)
        const availableAmount = balance - (balance * BigInt(Math.floor(retentionRatio * 10000))) / 10000n
        if (availableAmount > 0n) {
          estimatedAmount = formatTokenAmount(availableAmount, tokenDecimals)
        }
      }
    } catch {
      // 忽略余额查询错误
    }

    const planId = `${institutionName}-R${i + 1}`

    plans.push({
      planId,
      fromAddress,
      toAddress,
      institutionName,
      holdRatio,
      estimatedAmount,
    })
  }

  // 打乱计划顺序以增加随机性
  return plans.sort(() => Math.random() - 0.5)
}

// 执行叶子节点乱序转账
async function executeLeafShuffleTransfer(
  shufflePlans: LeafNodeShuffleTransferPlan[],
  batchTransferOptions: {
    configDir: string
    tokenAddress: string
    precision?: string
    trailingZeros: string
    gasPrice: string
    delayMin: string
    delayMax: string
    autoFundGas: string
    ethTransferDelay?: string
  },
  batchOptions: {
    batchSize: number
    batchDelay: number
  },
  hre: HardhatRuntimeEnvironment,
): Promise<LeafNodeShuffleTransferResult> {
  const results: LeafNodeShuffleTransferResult = {
    success: true,
    totalPlans: shufflePlans.length,
    completedPlans: 0,
    results: [],
  }

  const { batchSize, batchDelay } = batchOptions
  Logger.info(`📊 开始分批执行 ${shufflePlans.length} 个转账计划 (每批 ${batchSize} 个)...`)

  // 将转账计划分成批次
  const batches: LeafNodeShuffleTransferPlan[][] = []
  for (let i = 0; i < shufflePlans.length; i += batchSize) {
    batches.push(shufflePlans.slice(i, i + batchSize))
  }

  Logger.info(`📦 共分为 ${batches.length} 个批次执行`)

  // 逐批次执行转账
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const currentBatch = batches[batchIndex]
    const batchNum = batchIndex + 1

    Logger.info(`\n🔄 开始执行第 ${batchNum}/${batches.length} 批次 (${currentBatch.length} 个转账)...`)

    // 创建当前批次的转账任务 Promise 数组
    const batchTasks = currentBatch.map(async (plan, planIndexInBatch) => {
      // 为避免并发冲突，错开任务启动时间
      const startupDelay = planIndexInBatch * 100
      await new Promise(resolve => setTimeout(resolve, startupDelay))

      const globalPlanIndex = batchIndex * batchSize + planIndexInBatch
      const taskResult = {
        plan,
        planIndex: globalPlanIndex,
        success: false,
        error: undefined as string | undefined,
      }

      try {
        // 为每个并发任务分配不同的ETH转账延迟时间，避免nonce冲突
        const baseEthTransferDelay = parseInt(batchTransferOptions.ethTransferDelay || '2000')
        const taskSpecificDelay = baseEthTransferDelay + planIndexInBatch * 1000

        // 构建 batch-transfer-token 任务参数
        const taskParams = {
          configDir: batchTransferOptions.configDir,
          tokenAddress: batchTransferOptions.tokenAddress,
          from: plan.fromAddress,
          tos: plan.toAddress, // 只有一个接收地址
          holdRatio: plan.holdRatio,
          trailingZeros: batchTransferOptions.trailingZeros,
          delayMin: batchTransferOptions.delayMin,
          delayMax: batchTransferOptions.delayMax,
          autoFundGas: batchTransferOptions.autoFundGas,
          ethTransferDelay: taskSpecificDelay.toString(),
          ...(batchTransferOptions.precision && { precision: batchTransferOptions.precision }),
          ...(batchTransferOptions.gasPrice && { gasPrice: batchTransferOptions.gasPrice }),
        }

        Logger.info(`\n🔄 [批次${batchNum}-转账${planIndexInBatch + 1}] ${plan.planId}`)
        Logger.info(`${plan.fromAddress} → ${plan.toAddress} (保留${(parseFloat(plan.holdRatio) * 100).toFixed(1)}%)`)

        // 直接运行 Hardhat 任务
        await hre.run('batch-transfer-token', taskParams)

        Logger.info(`✅ [批次${batchNum}-转账${planIndexInBatch + 1}] 转账成功: ${plan.planId}`)
        taskResult.success = true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        Logger.error(`❌ [批次${batchNum}-转账${planIndexInBatch + 1}] 转账失败: ${plan.planId}`, error)
        taskResult.error = errorMessage
      }

      return taskResult
    })

    // 等待当前批次的所有任务完成
    const batchResults = await Promise.allSettled(batchTasks)

    // 处理当前批次的结果
    let batchSuccessCount = 0
    let batchFailureCount = 0

    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const taskResult = result.value
        if (taskResult.success) {
          batchSuccessCount++
          results.completedPlans++
          results.results.push({
            planId: taskResult.plan.planId,
            fromAddress: taskResult.plan.fromAddress,
            toAddress: taskResult.plan.toAddress,
            institutionName: taskResult.plan.institutionName,
            success: true,
            actualAmount: taskResult.plan.estimatedAmount,
          })
        } else {
          batchFailureCount++
          results.success = false
          results.results.push({
            planId: taskResult.plan.planId,
            fromAddress: taskResult.plan.fromAddress,
            toAddress: taskResult.plan.toAddress,
            institutionName: taskResult.plan.institutionName,
            success: false,
            error: taskResult.error,
          })
        }
      } else {
        batchFailureCount++
        results.success = false
        const plan = currentBatch[index]
        results.results.push({
          planId: plan.planId,
          fromAddress: plan.fromAddress,
          toAddress: plan.toAddress,
          institutionName: plan.institutionName,
          success: false,
          error: `任务执行异常: ${result.reason}`,
        })
      }
    })

    Logger.info(`\n📊 批次 ${batchNum} 执行完成: 成功 ${batchSuccessCount}/${currentBatch.length}, 失败 ${batchFailureCount}`)

    // 如果不是最后一个批次，等待指定的延迟时间
    if (batchIndex < batches.length - 1) {
      Logger.info(`⏱️  批次 ${batchNum} 完成，等待 ${Math.round(batchDelay / 1000)}s 后执行下一批次...`)
      await new Promise(resolve => setTimeout(resolve, batchDelay))
    }
  }

  Logger.info(`\n📊 所有批次执行完成: 总成功 ${results.completedPlans}/${shufflePlans.length}`)

  return results
}

export { collectAllLeafNodeAddresses, collectLeafNodeAddresses, executeLeafShuffleTransfer, generateLeafShuffleTransferPlan }
