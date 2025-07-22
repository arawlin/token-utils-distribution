import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { join } from 'path'
import { DistributionSystemConfig, InstitutionNode } from '../types'
import { formatTokenAmount, loadAllWallets, Logger } from './utils'

interface HierarchicalDistributionPlan {
  level: number
  fromAddress: string
  toAddresses: string[]
  institutionName: string
  holdRatio: string
  estimatedAmount?: string
}

interface HierarchicalDistributionResult {
  success: boolean
  completedLevels: number
  totalLevels: number
  results: Array<{
    level: number
    institutionName: string
    fromAddress: string
    toAddressesCount: number
    success: boolean
    error?: string
    actualAmount?: string
  }>
}

task('hierarchical-distribution', '按机构层级自动执行Token分发')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('tokenAddress', 'Token合约地址')
  .addParam('institutionIndex', '主要机构索引 (0=机构A, 1=机构B, 2=机构C)', '0')
  .addOptionalParam('startFromLevel', '从哪个层级开始分发 (0=主机构层级)', '0')
  .addOptionalParam('maxLevel', '最大分发层级 (-1=分发到最深层)', '-1')
  .addOptionalParam('precision', '随机金额精度 (小数位数)')
  .addOptionalParam('trailingZeros', '末尾零的最小数量', '1')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('delayMin', '层级间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '层级间最大延迟（毫秒）', '3000')
  .addOptionalParam('ethTransferDelay', '并发执行时ETH转账等待延迟（毫秒）', '1000')
  .addOptionalParam('autoFundGas', '当ETH余额不足时自动转账ETH', 'true')
  .addOptionalParam('dryRun', '只显示分发计划不实际执行', 'false')
  .setAction(async (taskArgs, hre) => {
    const {
      configDir,
      tokenAddress,
      institutionIndex,
      startFromLevel,
      maxLevel,
      precision,
      trailingZeros,
      gasPrice,
      delayMin,
      delayMax,
      autoFundGas,
      ethTransferDelay,
      dryRun,
    } = taskArgs

    const tokenAddressReal = tokenAddress || process.env.TOKEN_ADDRESS

    try {
      Logger.info('🌳 开始执行层级分发Token任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`Token地址: ${tokenAddressReal}`)

      const institutionIndexNum = parseInt(institutionIndex)
      const startFromLevelNum = parseInt(startFromLevel)
      const maxLevelNum = maxLevel === '-1' ? -1 : parseInt(maxLevel)
      const isDryRun = dryRun === 'true'

      if (isDryRun) {
        Logger.info('🔍 DRY RUN 模式 - 仅显示分发计划，不会实际执行转账')
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

      // 加载机构配置

      if (institutionIndexNum < 0 || institutionIndexNum >= config.institutionTree.length) {
        Logger.error(`无效的机构索引: ${institutionIndexNum}. 可用范围: 0-${config.institutionTree.length - 1}`)
        return
      }

      const selectedInstitution = config.institutionTree[institutionIndexNum]
      Logger.info(`选择的机构: ${selectedInstitution.institutionName} (${selectedInstitution.hdPath})`)
      Logger.info(`开始层级: ${startFromLevelNum}`)
      Logger.info(`最大层级: ${maxLevelNum === -1 ? '全部' : maxLevelNum}`)

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)
      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      // 创建Token合约实例（用于查询信息）
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

      // 生成层级分发计划
      const distributionPlan = await generateHierarchicalPlan(
        selectedInstitution,
        tokenContract,
        tokenDecimals,
        startFromLevelNum,
        maxLevelNum,
      )

      if (distributionPlan.length === 0) {
        Logger.error('没有生成有效的分发计划')
        return
      }

      Logger.info(`\n📋 层级分发计划:`)
      Logger.info(`总计 ${distributionPlan.length} 个层级需要分发`)

      distributionPlan.forEach(plan => {
        Logger.info(`\n层级 ${plan.level}: ${plan.institutionName}`)
        Logger.info(`  从地址: ${plan.fromAddress}`)
        Logger.info(`  分发到: ${plan.toAddresses.length} 个子地址`)
        Logger.info(`  保留比例: ${(parseFloat(plan.holdRatio) * 100).toFixed(1)}%`)
        if (plan.estimatedAmount) {
          Logger.info(`  预估可分发量: ${plan.estimatedAmount} ${tokenSymbol}`)
        }
        Logger.info(
          `  目标地址: ${plan.toAddresses.slice(0, 3).join(', ')}${plan.toAddresses.length > 3 ? `... (+${plan.toAddresses.length - 3} 个)` : ''}`,
        )
      })

      // 执行层级分发（DRY RUN 模式将显示任务参数但不实际执行）
      const executionModeText = isDryRun ? '🔍 开始显示层级分发参数...' : '🚀 开始执行层级分发...'
      Logger.info(`\n${executionModeText}`)
      const results = await executeHierarchicalDistribution(
        distributionPlan,
        {
          configDir,
          tokenAddress: tokenAddressReal,
          precision,
          trailingZeros,
          gasPrice,
          delayMin,
          delayMax,
          autoFundGas,
          ethTransferDelay, // 传递ETH转账延迟参数
        },
        {
          delayMin: parseInt(delayMin),
          delayMax: parseInt(delayMax),
        },
        hre,
        isDryRun, // 传递 dryRun 参数
      )

      // 输出结果统计
      const resultModeText = isDryRun ? '📊 DRY RUN 模式结果:' : '📊 层级分发结果:'
      Logger.info(`\n${resultModeText}`)
      Logger.info(`成功完成: ${results.completedLevels}/${results.totalLevels} 个层级`)

      results.results.forEach(result => {
        const status = result.success ? '✅' : '❌'
        Logger.info(`${status} 层级 ${result.level}: ${result.institutionName}`)
        Logger.info(`     从 ${result.fromAddress} 分发到 ${result.toAddressesCount} 个地址`)
        if (result.actualAmount && !isDryRun) {
          Logger.info(`     实际分发: ${result.actualAmount} ${tokenSymbol}`)
        }
        if (result.error) {
          Logger.error(`     错误: ${result.error}`)
        }
      })

      if (results.success) {
        const completionText = isDryRun ? '🎉 DRY RUN 参数显示完成!' : '🎉 层级分发完成!'
        Logger.info(completionText)
      } else {
        Logger.error('❌ 层级分发部分失败，请检查错误信息')
      }
    } catch (error) {
      Logger.error('层级分发任务失败:', error)
      throw error
    }
  })

// 生成层级分发计划
async function generateHierarchicalPlan(
  institution: InstitutionNode,
  tokenContract: ethers.Contract,
  tokenDecimals: number,
  startFromLevel: number,
  maxLevel: number,
): Promise<HierarchicalDistributionPlan[]> {
  const plan: HierarchicalDistributionPlan[] = []

  // 递归遍历机构树生成分发计划
  async function traverseInstitution(node: InstitutionNode, currentLevel: number) {
    // 检查是否在指定的层级范围内
    if (currentLevel < startFromLevel) {
      // 跳过当前层级，继续遍历子节点
      for (const child of node.childNodes) {
        await traverseInstitution(child, currentLevel + 1)
      }
      return
    }

    if (maxLevel !== -1 && currentLevel > maxLevel) {
      return // 超过最大层级，停止遍历
    }

    // 如果有子节点且有地址，随机选择分发者进行分发
    if (node.childNodes.length > 0 && node.addresses && node.addresses.length > 0) {
      const nodeAddresses = node.addresses

      // 随机选择1-3个地址作为分发者（根据可用地址数量决定）
      const maxDistributors = Math.min(5, Math.max(1, Math.floor(nodeAddresses.length / 2)))
      const distributorCount = Math.floor(Math.random() * maxDistributors) + 1

      // 随机选择分发者地址
      const shuffledAddresses = [...nodeAddresses].sort(() => Math.random() - 0.5)
      const distributorAddresses = shuffledAddresses.slice(0, distributorCount)

      Logger.info(`机构 ${node.institutionName} (${node.hdPath}) 随机选择了 ${distributorCount} 个分发者`)

      // 收集所有子机构的所有接收地址
      const childAddresses: string[] = []
      for (const child of node.childNodes) {
        const childAddresses_temp = child.addresses || []
        if (childAddresses_temp.length > 0) {
          // 添加该子机构的所有地址
          childAddresses.push(...childAddresses_temp)
        }
      }

      if (childAddresses.length > 0 && distributorAddresses.length > 0) {
        // 为每个分发者创建一个分发计划
        for (let i = 0; i < distributorAddresses.length; i++) {
          const distributorAddress = distributorAddresses[i]

          // 随机保留比例
          const retentionPercentage = Math.floor(Math.random() * 3) + 1
          const holdRatio = (retentionPercentage / 100).toFixed(3)

          // 获取当前余额用于估算
          let estimatedAmount: string | undefined
          try {
            const balance = await tokenContract.balanceOf(distributorAddress)
            if (balance > 0n) {
              const availableAmount = balance - (balance * BigInt(retentionPercentage * 100)) / 10000n
              if (availableAmount > 0n) {
                estimatedAmount = formatTokenAmount(availableAmount, tokenDecimals)
              }
            }
          } catch {
            // 忽略余额查询错误
          }

          // 为每个分发者分配子地址（平均分配或随机分配）
          const addressesPerDistributor = Math.ceil(childAddresses.length / distributorAddresses.length)
          const startIndex = i * addressesPerDistributor
          const endIndex = Math.min(startIndex + addressesPerDistributor, childAddresses.length)
          const assignedAddresses = childAddresses.slice(startIndex, endIndex)

          if (assignedAddresses.length > 0) {
            plan.push({
              level: currentLevel,
              fromAddress: distributorAddress,
              toAddresses: assignedAddresses,
              institutionName: `${node.institutionName || `Level ${currentLevel}`} - 分发者${i + 1}`,
              holdRatio,
              estimatedAmount,
            })
          }
        }
      }
    }

    // 继续遍历子节点
    for (const child of node.childNodes) {
      await traverseInstitution(child, currentLevel + 1)
    }
  }

  await traverseInstitution(institution, institution.depth)
  return plan.sort((a, b) => a.level - b.level) // 按层级排序
}

// 执行层级分发
async function executeHierarchicalDistribution(
  distributionPlan: HierarchicalDistributionPlan[],
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
  levelDelayOptions: {
    delayMin: number
    delayMax: number
  },
  hre: HardhatRuntimeEnvironment,
  isDryRun: boolean = false,
): Promise<HierarchicalDistributionResult> {
  const results: HierarchicalDistributionResult = {
    success: true,
    completedLevels: 0,
    totalLevels: distributionPlan.length,
    results: [],
  }

  // 按层级分组执行分发计划（相同层级并发执行）
  const levelGroups = new Map<number, HierarchicalDistributionPlan[]>()

  // 按层级分组
  distributionPlan.forEach(plan => {
    if (!levelGroups.has(plan.level)) {
      levelGroups.set(plan.level, [])
    }
    levelGroups.get(plan.level)!.push(plan)
  })

  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b)
  const executionMode = isDryRun ? ' (DRY RUN 模式)' : ''
  Logger.info(
    `📊 分发层级分组${executionMode}: ${sortedLevels.map(level => `Level ${level} (${levelGroups.get(level)!.length}个任务)`).join(', ')}`,
  )

  for (let levelIndex = 0; levelIndex < sortedLevels.length; levelIndex++) {
    const currentLevel = sortedLevels[levelIndex]
    const plansInLevel = levelGroups.get(currentLevel)!

    const levelModeInfo = isDryRun ? ' (DRY RUN - 仅显示参数)' : ''
    Logger.info(`\n🔄 开始执行层级 ${currentLevel} (${plansInLevel.length} 个并发任务)${levelModeInfo}`)

    // 创建所有任务的 Promise 数组
    const levelTasks = plansInLevel.map(async (plan, planIndex) => {
      const taskResult = {
        plan,
        planIndex,
        success: false,
        error: undefined as string | undefined,
      }

      try {
        // 为每个并发任务分配不同的ETH转账延迟时间，避免nonce冲突
        const baseEthTransferDelay = parseInt(batchTransferOptions.ethTransferDelay || '2000')
        const taskSpecificDelay = baseEthTransferDelay + planIndex * 2000

        // 构建 batch-transfer-token 任务参数
        const taskParams = {
          configDir: batchTransferOptions.configDir,
          tokenAddress: batchTransferOptions.tokenAddress,
          from: plan.fromAddress,
          tos: plan.toAddresses.join(','),
          holdRatio: plan.holdRatio,
          trailingZeros: batchTransferOptions.trailingZeros,
          delayMin: batchTransferOptions.delayMin,
          delayMax: batchTransferOptions.delayMax,
          autoFundGas: batchTransferOptions.autoFundGas,
          ethTransferDelay: taskSpecificDelay.toString(), // 为每个任务分配不同的延迟
          ...(batchTransferOptions.precision && { precision: batchTransferOptions.precision }),
          ...(batchTransferOptions.gasPrice && { gasPrice: batchTransferOptions.gasPrice }),
        }

        Logger.info(`\n🔄 [层级${currentLevel}-任务${planIndex + 1}] ${plan.institutionName}`)
        // Logger.info(`参数: ${JSON.stringify(taskParams, null, 2)}`)

        // 构造等效的命令行参数用于手动调试
        const cliArgs = [
          'npx hardhat batch-transfer-token',
          `--config-dir "${taskParams.configDir}"`,
          `--token-address "${taskParams.tokenAddress}"`,
          `--from "${taskParams.from}"`,
          `--tos "${taskParams.tos}"`,
          `--hold-ratio "${taskParams.holdRatio}"`,
          `--trailing-zeros "${taskParams.trailingZeros}"`,
          `--delay-min "${taskParams.delayMin}"`,
          `--delay-max "${taskParams.delayMax}"`,
          `--auto-fund-gas "${taskParams.autoFundGas}"`,
          `--eth-transfer-delay "${taskParams.ethTransferDelay}"`,
          `--network ${hre.network.name}`,
        ]

        // 添加可选参数到CLI
        if (taskParams.precision) {
          cliArgs.push(`--precision "${taskParams.precision}"`)
        }
        if (taskParams.gasPrice) {
          cliArgs.push(`--gas-price "${taskParams.gasPrice}"`)
        }

        Logger.info(`📋 [层级${currentLevel}-任务${planIndex + 1}] 等效命令行参数:`)
        Logger.info(`${cliArgs.join(' \\\n  ')}`)

        if (isDryRun) {
          Logger.info(`🔍 [层级${currentLevel}-任务${planIndex + 1}] DRY RUN 模式 - 跳过实际执行`)
          taskResult.success = true
        } else {
          // 直接运行 Hardhat 任务
          await hre.run('batch-transfer-token', taskParams)
          Logger.info(`✅ [层级${currentLevel}-任务${planIndex + 1}] 分发成功: ${plan.institutionName}`)
          taskResult.success = true
        }
      } catch (error) {
        if (isDryRun) {
          // DRY RUN 模式下不应该有实际错误，只是显示参数
          Logger.info(`🔍 [层级${currentLevel}-任务${planIndex + 1}] DRY RUN 完成: ${plan.institutionName}`)
          taskResult.success = true
        } else {
          const errorMessage = error instanceof Error ? error.message : String(error)
          Logger.error(`❌ [层级${currentLevel}-任务${planIndex + 1}] 分发失败: ${plan.institutionName}`, error)
          taskResult.error = errorMessage
        }
      }

      return taskResult
    })

    // 等待当前层级的所有任务完成
    const levelResults = await Promise.allSettled(levelTasks)

    // 处理结果
    let levelSuccessCount = 0
    let levelFailureCount = 0

    levelResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const taskResult = result.value
        if (taskResult.success) {
          levelSuccessCount++
          results.completedLevels++
          results.results.push({
            level: taskResult.plan.level,
            institutionName: taskResult.plan.institutionName,
            fromAddress: taskResult.plan.fromAddress,
            toAddressesCount: taskResult.plan.toAddresses.length,
            success: true,
            actualAmount: taskResult.plan.estimatedAmount,
          })
        } else {
          levelFailureCount++
          results.success = false
          results.results.push({
            level: taskResult.plan.level,
            institutionName: taskResult.plan.institutionName,
            fromAddress: taskResult.plan.fromAddress,
            toAddressesCount: taskResult.plan.toAddresses.length,
            success: false,
            error: taskResult.error,
          })
        }
      } else {
        levelFailureCount++
        results.success = false
        const plan = plansInLevel[index]
        results.results.push({
          level: plan.level,
          institutionName: plan.institutionName,
          fromAddress: plan.fromAddress,
          toAddressesCount: plan.toAddresses.length,
          success: false,
          error: `任务执行异常: ${result.reason}`,
        })
      }
    })

    Logger.info(`\n📊 层级 ${currentLevel} 执行完成: 成功 ${levelSuccessCount}/${plansInLevel.length}, 失败 ${levelFailureCount}`)

    // 如果当前层级有失败的任务，停止后续层级的执行
    if (levelFailureCount > 0) {
      Logger.error(`❌ 层级 ${currentLevel} 有 ${levelFailureCount} 个任务失败，停止后续层级执行`)
      break
    }

    // 层级间延迟 (只有不是最后一个层级时才延迟)
    if (levelIndex < sortedLevels.length - 1) {
      const delay = Math.random() * (levelDelayOptions.delayMax - levelDelayOptions.delayMin) + levelDelayOptions.delayMin
      Logger.info(`⏱️  层级 ${currentLevel} 完成，等待 ${Math.round(delay / 1000)}s 后执行下一层级...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  return results
}

export { executeHierarchicalDistribution, generateHierarchicalPlan }
