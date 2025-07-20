import type { Provider, Wallet } from 'ethers'
import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { getGasDistributionTargets, getNodesByDepth } from '../config/institutions'
import { DistributionSystemConfig, DistributionTask, GasDistributionConfig } from '../types'
import { coordinator } from './coordinator'
import {
  chunkArray,
  delay,
  formatEther,
  generateRandomGasPrice,
  generateTaskId,
  generateWalletFromPath,
  Logger,
} from './utils'

task('distribute-gas', 'Gas费分发任务')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('batchSize', '批处理大小', '10')
  .addOptionalParam('delayMs', '批次间延迟(毫秒)', '5000')
  .addOptionalParam('maxRetries', '最大重试次数', '3')
  .addFlag('dryRun', '干运行模式（不执行实际交易）')
  .addFlag('force', '强制执行（跳过锁检查）')
  .setAction(async (taskArgs, hre) => {
    const { configDir, batchSize, delayMs, maxRetries, dryRun, force } = taskArgs
    let taskId = ''

    try {
      // 获取任务锁
      if (!force) {
        taskId = await coordinator.acquireTaskLock('distribute-gas')
      }

      Logger.info('开始执行Gas分发任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`批处理大小: ${batchSize}`)
      Logger.info(`最大重试次数: ${maxRetries}`)
      Logger.info(`干运行模式: ${dryRun}`)

      const configPath = join(configDir, 'distribution-config.json')
      const seedPath = join(configDir, 'master-seed.json')

      // 检查配置文件
      if (!existsSync(configPath) || !existsSync(seedPath)) {
        Logger.error('配置文件不存在，请先运行 init-hd-tree 任务')
        return
      }

      // 清理资源文件
      await coordinator.cleanup()

      const provider = hre.ethers.provider

      // 加载配置
      const seedConfig = JSON.parse(readFileSync(seedPath, 'utf8'))
      const masterSeed = seedConfig.masterSeed

      const config: DistributionSystemConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      const gasConfig = config.gasDistribution

      // 生成中间钱包
      Logger.info('生成中间钱包...')
      const intermediateWallets = generateIntermediateWallets(
        provider,
        masterSeed,
        gasConfig.intermediateWallets.hdPath,
        gasConfig.intermediateWallets.count,
      )

      // 获取所有需要Gas的地址 - 使用层级机构配置
      Logger.info('收集目标地址...')
      const allNodes = Array.from(getNodesByDepth(config.institutionTree).values()).flat()
      const distributionTargets = getGasDistributionTargets(config.institutionTree)

      const totalDistributionAddresses = distributionTargets.distributionGas.length
      const totalTradingAddresses = distributionTargets.tradingGas.length

      Logger.info(`分发Gas地址数 (用于分发token): ${totalDistributionAddresses}`)
      Logger.info(`交易Gas地址数 (最终用户): ${totalTradingAddresses}`)
      Logger.info(`机构节点数: ${allNodes.length}`)

      // 阶段1: 从交易所向中间钱包分发Gas
      Logger.info('\n=== 阶段1: 交易所 -> 中间钱包 ===')

      // 验证交易所钱包余额
      Logger.info('验证交易所钱包余额...')
      const exchangeWallets = await validateExchangeWallets(provider, gasConfig.exchangeSources)
      if (exchangeWallets.length === 0) {
        Logger.error('没有可用的交易所钱包')
        return
      }

      const totalTargetAddresses = totalDistributionAddresses + totalTradingAddresses

      await distributeToIntermediateWallets(
        provider,
        exchangeWallets,
        intermediateWallets,
        totalTargetAddresses,
        gasConfig,
        parseInt(maxRetries),
        dryRun,
      )

      if (!dryRun) {
        Logger.info('等待中间钱包交易确认...')
        await delay(2000)
      }

      // 阶段2: 从中间钱包向目标地址分发Gas - 使用层级分发
      Logger.info('\n=== 阶段2: 中间钱包 -> 目标地址 ===')
      await distributeHierarchicalGas(
        provider,
        intermediateWallets,
        config,
        parseInt(batchSize),
        parseInt(delayMs),
        parseInt(maxRetries),
        dryRun,
      )

      Logger.info('Gas分发任务完成!')

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'completed')
      }
    } catch (error) {
      Logger.error('Gas分发任务失败:', error)

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'failed')
      }

      throw error
    }
  })

// 验证交易所钱包余额
async function validateExchangeWallets(
  provider: Provider,
  exchangeSources: Array<{ address: string; privateKey: string }>,
): Promise<Wallet[]> {
  const validWallets: Wallet[] = []

  for (const source of exchangeSources) {
    if (!source.address || !source.privateKey) {
      Logger.warn('跳过无效的交易所配置')
      continue
    }

    try {
      const wallet = new ethers.Wallet(source.privateKey, provider)
      const balance = await provider.getBalance(wallet.address)

      Logger.info(`交易所钱包 ${wallet.address}: ${formatEther(balance)} ETH`)

      // 至少需要0.1 ETH才能参与分发
      if (balance > ethers.parseEther('0.1')) {
        validWallets.push(wallet)
      } else {
        Logger.warn(`钱包余额不足: ${wallet.address}`)
      }
    } catch (error) {
      Logger.warn(`无效的交易所钱包: ${source.address}`, error)
    }
  }

  return validWallets
}

// 生成中间钱包
function generateIntermediateWallets(provider: Provider, masterSeed: string, hdPath: string, count: number): Wallet[] {
  const wallets: Wallet[] = []

  for (let i = 0; i < count; i++) {
    const wallet = generateWalletFromPath(masterSeed, hdPath, i).connect(provider)
    wallets.push(wallet)
  }

  return wallets
}

// 阶段2: 按机构分组向目标地址分发Gas
// 层级Gas分发：按机构和用途分发Gas
async function distributeHierarchicalGas(
  provider: Provider,
  intermediateWallets: Wallet[],
  config: DistributionSystemConfig,
  batchSize: number,
  delayMs: number,
  maxRetries: number,
  dryRun: boolean,
) {
  const { institutionTree, gasDistribution } = config
  const baseTime = Date.now()

  const allNodes = Array.from(getNodesByDepth(config.institutionTree).values()).flat()
  // 获取不同类型的gas分发目标
  const gasTargets = getGasDistributionTargets(institutionTree)

  Logger.info(
    `分发Gas目标: ${gasTargets.distributionGas.length} 个分发地址, ${gasTargets.tradingGas.length} 个交易地址`,
  )

  // 1. 首先分发给分发者地址（用于分发token的gas）
  if (gasTargets.distributionGas.length > 0) {
    Logger.info(`\n=== 分发Gas阶段1: 分发者地址 (${gasTargets.distributionGas.length} 个) ===`)

    const distributionTasks: DistributionTask[] = gasTargets.distributionGas.map(target => {
      const node = allNodes.find(n => n.institutionName === target.institutionName)
      const window = node?.gasReceiveWindow || { start: 0, end: 30 }

      const windowStartMs = baseTime + window.start * 60 * 1000
      const windowEndMs = baseTime + window.end * 60 * 1000
      const scheduledTime = windowStartMs + Math.random() * (windowEndMs - windowStartMs)

      return {
        id: generateTaskId(),
        type: 'gas',
        subType: 'distribution-gas',
        fromAddress: '',
        toAddress: target.address,
        amount: ethers.parseEther(target.amount).toString(),
        scheduledTime,
        status: 'pending',
        institutionGroup: target.institutionName,
        hierarchyLevel: 0,
      }
    })

    await executeGasDistributionTasks(
      provider,
      intermediateWallets,
      distributionTasks,
      gasDistribution,
      batchSize,
      delayMs,
      maxRetries,
      dryRun,
    )
  }

  // 2. 然后分发给最终用户地址（用于交易的gas）
  if (gasTargets.tradingGas.length > 0) {
    Logger.info(`\n=== 分发Gas阶段2: 最终用户地址 (${gasTargets.tradingGas.length} 个) ===`)

    // 按机构分组，添加延迟以避免被检测
    const institutionGroups = new Map<string, typeof gasTargets.tradingGas>()

    for (const target of gasTargets.tradingGas) {
      if (!institutionGroups.has(target.institutionName)) {
        institutionGroups.set(target.institutionName, [])
      }
      institutionGroups.get(target.institutionName)!.push(target)
    }

    let institutionIndex = 0
    for (const [institutionName, targets] of institutionGroups) {
      Logger.info(`处理机构 ${institutionName}: ${targets.length} 个地址`)

      // 每个机构之间添加延迟
      if (institutionIndex > 0) {
        const institutionDelay = 60000 + Math.random() * 30000 // 60-90秒随机延迟
        Logger.info(`机构间延迟 ${Math.round(institutionDelay / 1000)} 秒...`)
        if (!dryRun) {
          await delay(institutionDelay)
        }
      }

      const tradingTasks: DistributionTask[] = targets.map(target => {
        const node = allNodes.find(n => n.institutionName === target.institutionName)
        const window = node?.gasReceiveWindow || { start: 0, end: 30 }

        const windowStartMs = baseTime + window.start * 60 * 1000 + 30 * 60 * 1000 // 分发gas后30分钟开始交易gas
        const windowEndMs = baseTime + window.end * 60 * 1000 + 30 * 60 * 1000
        const scheduledTime = windowStartMs + Math.random() * (windowEndMs - windowStartMs)

        return {
          id: generateTaskId(),
          type: 'gas',
          subType: 'trading-gas',
          fromAddress: '',
          toAddress: target.address,
          amount: ethers.parseEther(target.amount).toString(),
          scheduledTime,
          status: 'pending',
          institutionGroup: target.institutionName,
          hierarchyLevel: 1,
        }
      })

      await executeGasDistributionTasks(
        provider,
        intermediateWallets,
        tradingTasks,
        gasDistribution,
        batchSize,
        delayMs,
        maxRetries,
        dryRun,
      )

      institutionIndex++
    }
  }

  Logger.info('层级Gas分发完成!')
}

// Gas分发任务执行器
async function executeGasDistributionTasks(
  provider: Provider,
  sourceWallets: Wallet[],
  tasks: DistributionTask[],
  gasConfig: GasDistributionConfig,
  batchSize: number,
  delayMs: number,
  maxRetries: number,
  dryRun: boolean,
) {
  if (tasks.length === 0) return

  // 按时间排序任务
  tasks.sort((a, b) => a.scheduledTime - b.scheduledTime)

  Logger.info(`执行 ${tasks.length} 个Gas分发任务`)

  let totalCompleted = 0
  let totalFailed = 0
  let currentWalletIndex = 0

  // 分批执行任务
  const batches = chunkArray(tasks, batchSize)

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]

    Logger.info(`执行第 ${batchIndex + 1}/${batches.length} 批Gas分发 (${batch.length} 个)`)

    // 等待到第一个任务的计划时间
    const firstTaskTime = Math.min(...batch.map(t => t.scheduledTime))
    const currentTime = Date.now()

    if (currentTime < firstTaskTime) {
      const waitTime = firstTaskTime - currentTime
      Logger.info(`等待 ${Math.round(waitTime / 1000)} 秒直到批次开始时间...`)
      if (!dryRun) {
        await delay(waitTime)
      }
    }

    // 并行执行批次内的任务
    const promises = batch.map(async task => {
      try {
        // 轮询使用不同的中间钱包
        const sourceWallet = sourceWallets[currentWalletIndex % sourceWallets.length]
        currentWalletIndex++

        // 等待到任务的具体计划时间
        const currentTime = Date.now()
        if (currentTime < task.scheduledTime) {
          const waitTime = task.scheduledTime - currentTime
          if (!dryRun && waitTime > 0) {
            await delay(waitTime)
          }
        }

        const amount = BigInt(task.amount)
        const gasPrice = (await coordinator.getGasPriceRecommendation(provider)).standard

        Logger.info(`Gas分发: ${task.toAddress} - ${formatEther(amount)} ETH (${task.institutionGroup || '未知机构'})`)

        if (!dryRun) {
          await coordinator.smartRetry(
            async () => {
              // 获取nonce并验证余额
              const nonce = await coordinator.getNextNonce(sourceWallet.address, provider)

              // 检查ETH余额
              const ethBalance = await provider.getBalance(sourceWallet.address)
              const totalCost = amount + gasPrice * 21000n // 估算交易费用

              if (ethBalance < totalCost) {
                throw new Error(`ETH余额不足: 需要 ${formatEther(totalCost)}, 拥有 ${formatEther(ethBalance)}`)
              }

              const tx = await sourceWallet.sendTransaction({
                to: task.toAddress,
                value: amount,
                gasPrice: gasPrice,
                nonce: nonce,
              })

              const receipt = await tx.wait()

              if (receipt && receipt.status === 1) {
                Logger.info(`✅ Gas分发成功: ${task.toAddress} (${tx.hash})`)
                return receipt
              } else {
                throw new Error(`Gas分发交易失败: ${tx.hash}`)
              }
            },
            { maxRetries },
          )
          totalCompleted++
        } else {
          totalCompleted++
          Logger.info(`[DRY-RUN] ✅ Gas分发: ${task.toAddress}`)
        }
      } catch (error) {
        totalFailed++
        Logger.error(`❌ Gas分发失败: ${task.toAddress}`, error)
      }

      // 随机延迟避免被检测
      const randomDelay = Math.random() * 3000 + 1000 // 1-4秒随机延迟
      await delay(randomDelay)
    })

    await Promise.all(promises)

    Logger.info(`批次 ${batchIndex + 1} 完成: ${totalCompleted - totalFailed} 成功`)

    // 批次间延迟
    if (batchIndex < batches.length - 1 && !dryRun) {
      Logger.info(`批次间延迟 ${delayMs / 1000} 秒...`)
      await delay(delayMs)
    }
  }

  // 输出统计
  Logger.info(`Gas分发任务完成: ${totalCompleted} 成功, ${totalFailed} 失败`)
}

// 阶段1: 向中间钱包分发Gas
async function distributeToIntermediateWallets(
  provider: Provider,
  exchangeWallets: Wallet[],
  intermediateWallets: Wallet[],
  totalTargetAddresses: number,
  gasConfig: GasDistributionConfig,
  maxRetries: number,
  dryRun: boolean,
) {
  const totalGasNeeded = BigInt(totalTargetAddresses) * ethers.parseEther(gasConfig.gasAmounts.max)
  const gasPerIntermediate = totalGasNeeded / BigInt(intermediateWallets.length)

  Logger.info(`每个中间钱包需要: ${formatEther(gasPerIntermediate)} ETH`)

  const gasPriceRec = await coordinator.getGasPriceRecommendation(provider)

  for (let i = 0; i < intermediateWallets.length; i++) {
    const intermediateWallet = intermediateWallets[i]
    const exchangeWallet = exchangeWallets[i % exchangeWallets.length]

    const amount = gasPerIntermediate + ethers.parseEther('0.001') // 额外0.001 ETH作为交易费

    // 检查余额
    const balanceCheck = await coordinator.checkWalletBalance(
      exchangeWallet.address,
      amount + gasPriceRec.standard * 21000n,
      provider,
    )

    if (!balanceCheck.sufficient) {
      Logger.error(`交易所钱包余额不足: ${exchangeWallet.address}`)
      Logger.error(`需要: ${formatEther(balanceCheck.required)}, 拥有: ${formatEther(balanceCheck.current)}`)
      continue
    }

    Logger.info(`${exchangeWallet.address} -> ${intermediateWallet.address}: ${formatEther(amount)} ETH`)

    if (!dryRun) {
      try {
        await coordinator.smartRetry(
          async () => {
            const nonce = await coordinator.getNextNonce(exchangeWallet.address, provider)
            const gasPrice = generateRandomGasPrice(
              gasConfig.gasPriceRandomization.min,
              gasConfig.gasPriceRandomization.max,
            )

            const tx = await exchangeWallet.sendTransaction({
              to: intermediateWallet.address,
              value: amount,
              gasPrice: gasPrice,
              nonce: nonce,
            })

            Logger.info(`交易已发送: ${tx.hash}`)
            return tx
          },
          {
            maxRetries,
            baseDelay: 2000,
            retryCondition: (error: Error) => {
              const msg = error.message.toLowerCase()
              return msg.includes('nonce') || msg.includes('replacement') || msg.includes('network')
            },
          },
        )
      } catch (error) {
        Logger.error(`交易失败: ${exchangeWallet.address} -> ${intermediateWallet.address}`, error)
        // 继续下一个，不中断整个流程
      }
    }

    await delay(2000) // 2秒间隔避免nonce冲突
  }
}
