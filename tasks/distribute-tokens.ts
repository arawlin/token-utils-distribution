import { task } from 'hardhat/config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import type { Wallet, Provider, Contract } from 'ethers'
import { DistributionSystemConfig, DistributionTask, InstitutionNode, TokenDistributionConfig } from '../types'
import { getAllLeafNodes } from '../config/institutions'
import {
  generateNormalDistributionAmount,
  generatePoissonInterval,
  generateRandomGasPrice,
  formatTokenAmount,
  delay,
  Logger,
  generateTaskId,
  getCurrentTimestamp,
} from './utils'
import { coordinator } from './coordinator'

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

      // 获取所有叶子节点（最终接收者）
      Logger.info('收集Token分发目标...')
      const leafNodes = getAllLeafNodes(config.institutionTree)
      const targetAddresses = collectTargetAddresses(leafNodes)

      Logger.info(`需要分发Token的地址总数: ${targetAddresses.length}`)
      Logger.info(`Token信息: ${tokenInfo.symbol} (小数位: ${tokenInfo.decimals})`)

      // 验证源钱包Token余额
      const sourceBalance = await tokenContract.balanceOf(sourceWallet.address)
      Logger.info(`源钱包Token余额: ${formatTokenAmount(sourceBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`)

      // 创建分发任务
      Logger.info('创建Token分发任务...')
      const distributionTasks = createDistributionTasks(targetAddresses, tokenConfig, tokenInfo.decimals)

      // 计算总分发量
      const totalAmount = distributionTasks.reduce((sum, task) => sum + BigInt(task.amount), 0n)

      Logger.info(`计划分发总量: ${formatTokenAmount(totalAmount, tokenInfo.decimals)} ${tokenInfo.symbol}`)

      if (totalAmount > sourceBalance) {
        Logger.error(
          `源钱包余额不足! 需要: ${formatTokenAmount(totalAmount, tokenInfo.decimals)}, 拥有: ${formatTokenAmount(sourceBalance, tokenInfo.decimals)}`,
        )
        return
      }

      // 执行安全检查（小额测试）
      if (!skipSafetyCheck) {
        Logger.info('\n=== 执行安全检查 ===')
        await performSafetyCheck(
          tokenContract,
          sourceWallet,
          targetAddresses.slice(0, 3), // 只对前3个地址进行安全检查
          tokenConfig,
          tokenInfo.decimals,
          dryRun,
        )

        if (!dryRun) {
          Logger.info(`等待 ${tokenConfig.distributionPlan.safetyCheck.waitBlocks} 个区块确认...`)
          await waitForBlocks(provider, tokenConfig.distributionPlan.safetyCheck.waitBlocks)
        }
      }

      // 执行主要分发
      Logger.info('\n=== 执行主要Token分发 ===')
      await executeDistributionTasks(
        tokenContract,
        sourceWallet,
        distributionTasks,
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

// 收集目标地址
function collectTargetAddresses(leafNodes: InstitutionNode[]): string[] {
  const addresses: string[] = []

  for (const node of leafNodes) {
    if (node.addresses) {
      addresses.push(...node.addresses)
    }
  }

  return addresses
}

// 创建分发任务
function createDistributionTasks(
  targetAddresses: string[],
  tokenConfig: TokenDistributionConfig,
  _decimals: number,
): DistributionTask[] {
  const tasks: DistributionTask[] = []
  const currentTime = getCurrentTimestamp()

  for (let i = 0; i < targetAddresses.length; i++) {
    const address = targetAddresses[i]

    // 生成正态分布的Token数量
    const amount = generateNormalDistributionAmount(
      tokenConfig.distributionPlan.amounts.mean,
      tokenConfig.distributionPlan.amounts.stdDev,
    )

    // 生成泊松过程的时间间隔
    const interval = generatePoissonInterval(tokenConfig.distributionPlan.timing.lambda)
    const scheduledTime = currentTime + i * interval

    tasks.push({
      id: generateTaskId(),
      type: 'token',
      fromAddress: tokenConfig.sourceAddress.address,
      toAddress: address,
      amount: amount.toString(),
      scheduledTime: scheduledTime,
      status: 'pending',
    })
  }

  // 按计划时间排序
  tasks.sort((a, b) => a.scheduledTime - b.scheduledTime)

  return tasks
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

// 执行分发任务
async function executeDistributionTasks(
  tokenContract: Contract,
  sourceWallet: Wallet,
  tasks: DistributionTask[],
  tokenInfo: { decimals: number; symbol: string },
  batchSize: number,
  maxRetries: number,
  dryRun: boolean,
) {
  Logger.info(`开始执行 ${tasks.length} 个Token分发任务`)

  let completedTasks = 0
  let failedTasks = 0

  // 按时间顺序处理任务
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize)
    const currentTime = getCurrentTimestamp()

    Logger.info(
      `执行第 ${Math.floor(i / batchSize) + 1}/${Math.ceil(tasks.length / batchSize)} 批任务 (${batch.length} 个)`,
    )

    // 等待直到第一个任务的计划时间
    const firstTaskTime = batch[0].scheduledTime
    if (currentTime < firstTaskTime) {
      const waitTime = firstTaskTime - currentTime
      Logger.info(`等待 ${Math.round(waitTime / 1000)} 秒直到计划执行时间...`)
      if (!dryRun) {
        await delay(waitTime)
      }
    }

    // 并行执行批次内的任务
    const promises = batch.map(async task => {
      const amount = BigInt(task.amount)
      const gasPrice = generateRandomGasPrice(20, 60)

      Logger.info(`Token分发: ${task.toAddress} - ${formatTokenAmount(amount, tokenInfo.decimals)} ${tokenInfo.symbol}`)

      if (!dryRun) {
        try {
          let txHash = ''

          await coordinator.smartRetry(
            async () => {
              // 获取nonce并验证余额
              const provider = sourceWallet.provider!
              const nonce = await coordinator.getNextNonce(sourceWallet.address, provider)
              const balanceCheck = await coordinator.checkWalletBalance(sourceWallet.address, amount, provider)

              if (!balanceCheck.sufficient) {
                throw new Error(`钱包余额不足: 需要 ${amount}, 拥有 ${balanceCheck.current}`)
              }

              const tx = await tokenContract.transfer(task.toAddress, amount, {
                gasPrice: gasPrice,
                nonce: nonce,
              })

              txHash = tx.hash
              const receipt = await tx.wait()

              if (receipt.status === 1) {
                return receipt
              } else {
                throw new Error(`Token分发交易失败: ${tx.hash}`)
              }
            },
            { maxRetries },
          )

          task.status = 'completed'
          task.txHash = txHash
          completedTasks++

          Logger.info(`✅ Token分发成功: ${task.toAddress} (${txHash})`)
        } catch (error) {
          task.status = 'failed'
          task.error = (error as Error).message
          failedTasks++

          Logger.error(`❌ Token分发失败: ${task.toAddress}`, error)
        }
      } else {
        task.status = 'completed'
        completedTasks++
        Logger.info(`[DRY-RUN] ✅ Token分发: ${task.toAddress}`)
      }

      // 随机延迟避免被检测
      const randomDelay = Math.random() * 3000 + 1000 // 1-4秒随机延迟
      await delay(randomDelay)
    })

    await Promise.all(promises)

    // 批次间较长延迟
    if (i + batchSize < tasks.length) {
      const batchDelay = Math.random() * 10000 + 5000 // 5-15秒随机延迟
      Logger.info(`批次完成，等待 ${Math.round(batchDelay / 1000)} 秒后继续...`)
      if (!dryRun) {
        await delay(batchDelay)
      }
    }
  }

  // 输出最终统计
  Logger.info(`\n=== Token分发统计 ===`)
  Logger.info(`总任务数: ${tasks.length}`)
  Logger.info(`成功: ${completedTasks}`)
  Logger.info(`失败: ${failedTasks}`)
  Logger.info(`成功率: ${((completedTasks / tasks.length) * 100).toFixed(2)}%`)

  if (failedTasks > 0) {
    Logger.info('\n失败的任务:')
    tasks
      .filter(t => t.status === 'failed')
      .forEach(task => {
        Logger.info(`  ${task.toAddress}: ${task.error}`)
      })
  }
}
