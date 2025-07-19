import type { Contract, Provider, Wallet } from 'ethers'
import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { getAllLeafNodes, getInstitutionGroups } from '../config/institutions'
import { DistributionSystemConfig, InstitutionGroup, TokenDistributionConfig } from '../types'
import { coordinator } from './coordinator'
import {
  chunkArray,
  delay,
  formatTokenAmount,
  generateNormalDistributionAmount,
  generateRandomGasPrice,
  Logger,
} from './utils'

// ERC20 Token ABI (简化版，只包含需要的方法)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

task('distribute-tokens', 'Token分发任务')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('batchSize', '批处理大小', '5')
  .addOptionalParam('maxRetries', '最大重试次数', '3')
  .addFlag('dryRun', '干运行模式（不执行实际交易）')
  .addFlag('skipSafetyCheck', '跳过安全检查（小额测试）')
  .addFlag('force', '强制执行（跳过锁检查）')
  .setAction(async (taskArgs, hre) => {
    const { configDir, batchSize, maxRetries, dryRun, skipSafetyCheck, force } = taskArgs
    let taskId = ''

    try {
      // 获取任务锁
      if (!force) {
        taskId = await coordinator.acquireTaskLock('distribute-tokens')
      }

      Logger.info('开始执行Token分发任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`批处理大小: ${batchSize}`)
      Logger.info(`干运行模式: ${dryRun}`)
      Logger.info(`跳过安全检查: ${skipSafetyCheck}`)

      const configPath = join(configDir, 'distribution-config.json')
      const seedPath = join(configDir, 'master-seed.json')

      // 检查配置文件
      if (!existsSync(configPath) || !existsSync(seedPath)) {
        Logger.error('配置文件不存在，请先运行 init-hd-tree 任务')
        return
      }

      // 清理资源文件
      await coordinator.cleanup()

      // 加载配置
      const config: DistributionSystemConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      // const seedConfig = JSON.parse(readFileSync(seedPath, 'utf8'))
      // const masterSeed = seedConfig.masterSeed // 暂时不需要使用

      const provider = hre.ethers.provider
      const tokenConfig = config.tokenDistribution

      // 初始化Token合约和源钱包
      Logger.info('初始化Token合约和源钱包...')
      const { tokenContract, sourceWallet, tokenInfo } = await initializeTokenContract(provider, tokenConfig)

      // 获取所有叶子节点（最终接收者）- 使用机构分组
      Logger.info('收集Token分发目标...')
      const leafNodes = getAllLeafNodes(config.institutionTree)
      const institutionGroups = getInstitutionGroups(leafNodes)
      const totalTargetAddresses = institutionGroups.reduce((sum, group) => sum + group.addresses.length, 0)

      Logger.info(`需要分发Token的地址总数: ${totalTargetAddresses}`)
      Logger.info(`机构组数: ${institutionGroups.length}`)
      Logger.info(`Token信息: ${tokenInfo.symbol} (小数位: ${tokenInfo.decimals})`)

      // 验证源钱包Token余额和计算总量
      const sourceBalance = await tokenContract.balanceOf(sourceWallet.address)
      Logger.info(`源钱包Token余额: ${formatTokenAmount(sourceBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`)

      // 粗略估算总Token需求（用于余额检查）
      const estimatedAverageAmount = BigInt(tokenConfig.distributionPlan.amounts.mean)
      const estimatedTotalAmount = estimatedAverageAmount * BigInt(totalTargetAddresses)

      Logger.info(`预估分发总量: ${formatTokenAmount(estimatedTotalAmount, tokenInfo.decimals)} ${tokenInfo.symbol}`)

      if (estimatedTotalAmount > sourceBalance) {
        Logger.error(
          `源钱包余额可能不足! 预估需要: ${formatTokenAmount(estimatedTotalAmount, tokenInfo.decimals)}, 拥有: ${formatTokenAmount(sourceBalance, tokenInfo.decimals)}`,
        )
        return
      }

      // 执行安全检查（小额测试）- 使用前几个机构组的地址
      if (!skipSafetyCheck) {
        Logger.info('\n=== 执行安全检查 ===')
        const testAddresses = institutionGroups.slice(0, 2).flatMap(group => group.addresses.slice(0, 2))
        await performSafetyCheck(
          tokenContract,
          sourceWallet,
          testAddresses, // 使用前2个机构组的前2个地址进行安全检查
          tokenConfig,
          tokenInfo.decimals,
          dryRun,
        )

        if (!dryRun) {
          Logger.info(`等待 ${tokenConfig.distributionPlan.safetyCheck.waitBlocks} 个区块确认...`)
          await waitForBlocks(provider, tokenConfig.distributionPlan.safetyCheck.waitBlocks)
        }
      }

      // 执行主要分发 - 按机构分组
      Logger.info('\n=== 执行主要Token分发 ===')
      await executeInstitutionBasedTokenDistribution(
        tokenContract,
        sourceWallet,
        institutionGroups,
        tokenConfig, // 传递token配置
        tokenInfo,
        parseInt(batchSize),
        parseInt(maxRetries),
        dryRun,
      )

      Logger.info('Token分发任务完成!')

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'completed')
      }
    } catch (error) {
      Logger.error('Token分发任务失败:', error)

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'failed')
      }

      throw error
    }
  })

// 初始化Token合约和源钱包
async function initializeTokenContract(provider: Provider, tokenConfig: TokenDistributionConfig) {
  if (!tokenConfig.sourceAddress.privateKey || !tokenConfig.tokenAddress) {
    throw new Error('Token配置不完整，请检查源地址私钥和Token地址')
  }

  const sourceWallet = new ethers.Wallet(tokenConfig.sourceAddress.privateKey, provider)
  const tokenContract = new ethers.Contract(tokenConfig.tokenAddress, ERC20_ABI, sourceWallet)

  // 获取Token信息
  const [decimals, symbol] = await Promise.all([tokenContract.decimals(), tokenContract.symbol()])

  const tokenInfo = {
    decimals: Number(decimals),
    symbol: symbol as string,
  }

  return { tokenContract, sourceWallet, tokenInfo }
}

// 按机构分组执行Token分发
async function executeInstitutionBasedTokenDistribution(
  tokenContract: Contract,
  sourceWallet: Wallet,
  institutionGroups: InstitutionGroup[],
  tokenConfig: TokenDistributionConfig,
  tokenInfo: { decimals: number; symbol: string },
  batchSize: number,
  maxRetries: number,
  dryRun: boolean,
) {
  const baseTime = Date.now()

  // 为每个机构组生成Token分发任务，考虑它们的token接收窗口
  const allTasks: Array<{
    group: InstitutionGroup
    address: string
    scheduledTime: number
    amount: string
    dependsOnGas: boolean
  }> = []

  for (const group of institutionGroups) {
    const tokenWindow = group.tokenReceiveWindow
    const gasWindow = group.gasReceiveWindow

    // Token分发应该在Gas分发完成后进行
    const gasCompletionTime = baseTime + gasWindow.end * 60 * 1000 // Gas窗口结束时间
    const tokenStartTime = Math.max(gasCompletionTime + 5 * 60 * 1000, baseTime + tokenWindow.start * 60 * 1000) // 至少等5分钟
    const tokenEndTime = baseTime + tokenWindow.end * 60 * 1000

    const windowDurationMs = tokenEndTime - tokenStartTime

    for (let i = 0; i < group.addresses.length; i++) {
      const address = group.addresses[i]

      // 在token窗口内随机分布时间
      const randomOffset = Math.random() * windowDurationMs * 0.8
      const clusterOffset = i * ((windowDurationMs * 0.2) / group.addresses.length)
      const scheduledTime = tokenStartTime + randomOffset + clusterOffset

      // 生成正态分布的Token数量 - 使用配置参数
      const amount = generateNormalDistributionAmount(
        tokenConfig.distributionPlan.amounts.mean,
        tokenConfig.distributionPlan.amounts.stdDev,
      )

      allTasks.push({
        group,
        address,
        scheduledTime,
        amount: amount.toString(),
        dependsOnGas: true,
      })
    }
  }

  // 按时间排序任务
  allTasks.sort((a, b) => a.scheduledTime - b.scheduledTime)

  Logger.info(`创建了 ${allTasks.length} 个Token分发任务，按 ${institutionGroups.length} 个机构分组`)

  // 按机构分组执行任务
  const institutionNames = [...new Set(allTasks.map(t => t.group.institutionName))]
  let totalCompleted = 0
  let totalFailed = 0

  for (const institutionName of institutionNames) {
    const institutionTasks = allTasks.filter(t => t.group.institutionName === institutionName)

    Logger.info(`\n=== 开始处理 ${institutionName} Token分发 (${institutionTasks.length} 个地址) ===`)

    // 等待到第一个任务的计划时间
    const firstTaskTime = Math.min(...institutionTasks.map(t => t.scheduledTime))
    const currentTime = Date.now()

    if (currentTime < firstTaskTime) {
      const waitTime = firstTaskTime - currentTime
      Logger.info(`等待 ${Math.round(waitTime / 1000)} 秒直到 ${institutionName} 的Token分发窗口...`)
      if (!dryRun) {
        await delay(waitTime)
      }
    }

    // 分批执行该机构的任务
    const batches = chunkArray(institutionTasks, batchSize)

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex]

      Logger.info(`执行 ${institutionName} 第 ${batchIndex + 1}/${batches.length} 批Token分发 (${batch.length} 个)`)

      // 并行执行批次内的任务
      const promises = batch.map(async task => {
        const amount = BigInt(task.amount)
        const gasPrice = generateRandomGasPrice(20, 60)

        Logger.info(`Token分发: ${task.address} - ${formatTokenAmount(amount, tokenInfo.decimals)} ${tokenInfo.symbol}`)

        if (!dryRun) {
          try {
            await coordinator.smartRetry(
              async () => {
                // 获取nonce并验证余额
                const provider = sourceWallet.provider!
                const nonce = await coordinator.getNextNonce(sourceWallet.address, provider)

                // 检查Token余额
                const tokenBalance = await tokenContract.balanceOf(sourceWallet.address)
                if (tokenBalance < amount) {
                  throw new Error(
                    `Token余额不足: 需要 ${formatTokenAmount(amount, tokenInfo.decimals)}, 拥有 ${formatTokenAmount(tokenBalance, tokenInfo.decimals)}`,
                  )
                }

                const tx = await tokenContract.transfer(task.address, amount, {
                  gasPrice: gasPrice,
                  nonce: nonce,
                })

                const receipt = await tx.wait()

                if (receipt.status === 1) {
                  totalCompleted++
                  Logger.info(`✅ Token分发成功: ${task.address} (${tx.hash})`)
                  return receipt
                } else {
                  throw new Error(`Token分发交易失败: ${tx.hash}`)
                }
              },
              { maxRetries },
            )
          } catch (error) {
            totalFailed++
            Logger.error(`❌ Token分发失败: ${task.address}`, error)
          }
        } else {
          totalCompleted++
          Logger.info(`[DRY-RUN] ✅ Token分发: ${task.address}`)
        }

        // 随机延迟避免被检测
        const randomDelay = Math.random() * 3000 + 1000 // 1-4秒随机延迟
        await delay(randomDelay)
      })

      await Promise.all(promises)

      Logger.info(`${institutionName} 批次 ${batchIndex + 1} 完成`)

      // 批次间较短延迟（同一机构内）
      if (batchIndex < batches.length - 1) {
        const shortDelay = Math.random() * 5000 + 3000 // 3-8秒随机延迟
        await delay(shortDelay)
      }
    }

    Logger.info(`${institutionName} Token分发完成`)

    // 机构间较长延迟
    const currentInstitutionIndex = institutionNames.indexOf(institutionName)
    if (currentInstitutionIndex < institutionNames.length - 1) {
      const longDelay = Math.random() * 60000 + 30000 // 30-90秒随机延迟
      Logger.info(`等待 ${Math.round(longDelay / 1000)} 秒后处理下一个机构的Token分发...`)
      if (!dryRun) {
        await delay(longDelay)
      }
    }
  }

  // 输出最终统计
  Logger.info(`\n=== Token分发统计 ===`)
  Logger.info(`总任务数: ${allTasks.length}`)
  Logger.info(`成功: ${totalCompleted}`)
  Logger.info(`失败: ${totalFailed}`)
  Logger.info(`成功率: ${((totalCompleted / allTasks.length) * 100).toFixed(2)}%`)

  if (totalFailed > 0) {
    Logger.info('\n失败的任务详情将在日志中查看')
  }
}

// 执行安全检查（小额测试）
async function performSafetyCheck(
  tokenContract: Contract,
  sourceWallet: Wallet,
  testAddresses: string[],
  tokenConfig: TokenDistributionConfig,
  decimals: number,
  dryRun: boolean,
) {
  const smallAmount = BigInt(tokenConfig.distributionPlan.safetyCheck.initialSmallAmount)

  Logger.info(`对 ${testAddresses.length} 个地址执行小额测试，每个地址: ${formatTokenAmount(smallAmount, decimals)}`)

  for (const address of testAddresses) {
    const gasPrice = generateRandomGasPrice(15, 30) // 使用较低的Gas价格进行测试

    Logger.info(`小额测试: ${sourceWallet.address} -> ${address}`)

    if (!dryRun) {
      try {
        await coordinator.smartRetry(
          async () => {
            // 获取nonce并验证余额
            const provider = sourceWallet.provider!
            const nonce = await coordinator.getNextNonce(sourceWallet.address, provider)
            const balanceCheck = await coordinator.checkWalletBalance(sourceWallet.address, smallAmount, provider)

            if (!balanceCheck.sufficient) {
              throw new Error(`钱包余额不足进行安全检查: 需要 ${smallAmount}, 拥有 ${balanceCheck.current}`)
            }

            const tx = await tokenContract.transfer(address, smallAmount, {
              gasPrice: gasPrice,
              nonce: nonce,
            })

            const receipt = await tx.wait()
            if (receipt.status === 1) {
              Logger.info(`小额测试成功: ${tx.hash}`)
              return receipt
            } else {
              throw new Error(`小额测试交易失败: ${tx.hash}`)
            }
          },
          { maxRetries: 3 },
        )

        await delay(2000) // 2秒间隔
      } catch (error) {
        Logger.error(`小额测试失败: ${address}`, error)
        throw new Error('安全检查失败，停止执行')
      }
    } else {
      Logger.info(`[DRY-RUN] 小额测试: ${address}`)
    }
  }
}

// 等待指定数量的区块
async function waitForBlocks(provider: Provider, blockCount: number) {
  const startBlock = await provider.getBlockNumber()
  const targetBlock = startBlock + blockCount

  Logger.info(`当前区块: ${startBlock}, 目标区块: ${targetBlock}`)

  while (true) {
    const currentBlock = await provider.getBlockNumber()
    if (currentBlock >= targetBlock) {
      Logger.info(`已到达目标区块: ${currentBlock}`)
      break
    }

    Logger.info(`等待区块确认... 当前: ${currentBlock}, 目标: ${targetBlock}`)
    await delay(10000) // 10秒检查一次
  }
}
