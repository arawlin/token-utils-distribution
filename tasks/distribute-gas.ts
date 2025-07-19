import { task } from 'hardhat/config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import type { Wallet, Provider } from 'ethers'
import { DistributionSystemConfig, DistributionTask, InstitutionNode, GasDistributionConfig } from '../types'
import { getAllNodes } from '../config/institutions'
import {
  generateWalletFromPath,
  generateRandomGasPrice,
  generateRandomEthAmount,
  formatEther,
  delay,
  Logger,
  generateTaskId,
} from './utils'
import { coordinator } from './coordinator'

task('distribute-gas', 'Gas费分发任务')
  .addOptionalParam('configDir', '配置目录', './generated')
  .addOptionalParam('batchSize', '批处理大小', '10')
  .addOptionalParam('delayMs', '批次间延迟(毫秒)', '5000')
  .addFlag('dryRun', '干运行模式（不执行实际交易）')
  .addFlag('force', '强制执行（跳过锁检查）')
  .setAction(async (taskArgs, hre) => {
    const { configDir, batchSize, delayMs, dryRun, force } = taskArgs
    let taskId = ''

    try {
      // 获取任务锁
      if (!force) {
        taskId = await coordinator.acquireTaskLock('distribute-gas')
      }

      Logger.info('开始执行Gas分发任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`批处理大小: ${batchSize}`)
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

      // 加载配置
      const config: DistributionSystemConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      const seedConfig = JSON.parse(readFileSync(seedPath, 'utf8'))
      const masterSeed = seedConfig.masterSeed

      const provider = hre.ethers.provider
      const gasConfig = config.gasDistribution

      // 验证交易所钱包余额
      Logger.info('验证交易所钱包余额...')
      const exchangeWallets = await validateExchangeWallets(provider, gasConfig.exchangeSources)
      if (exchangeWallets.length === 0) {
        Logger.error('没有可用的交易所钱包')
        return
      }

      // 生成中间钱包
      Logger.info('生成中间钱包...')
      const intermediateWallets = generateIntermediateWallets(
        masterSeed,
        gasConfig.intermediateWallets.hdPath,
        gasConfig.intermediateWallets.count,
      )

      // 获取所有需要Gas的地址
      Logger.info('收集目标地址...')
      const allNodes = getAllNodes(config.institutionTree)
      const targetAddresses = collectTargetAddresses(allNodes)

      Logger.info(`需要分发Gas的地址总数: ${targetAddresses.length}`)

      // 阶段1: 从交易所向中间钱包分发Gas
      Logger.info('\n=== 阶段1: 交易所 -> 中间钱包 ===')
      await distributeToIntermediateWallets(
        provider,
        exchangeWallets,
        intermediateWallets,
        targetAddresses.length,
        gasConfig,
        dryRun,
      )

      if (!dryRun) {
        Logger.info('等待中间钱包交易确认...')
        await delay(30000) // 等待30秒让交易确认
      }

      // 阶段2: 从中间钱包向目标地址分发Gas
      Logger.info('\n=== 阶段2: 中间钱包 -> 目标地址 ===')
      await distributeToTargetAddresses(
        provider,
        intermediateWallets,
        targetAddresses,
        gasConfig,
        parseInt(batchSize),
        parseInt(delayMs),
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
function generateIntermediateWallets(masterSeed: string, hdPath: string, count: number): Wallet[] {
  const wallets: Wallet[] = []

  for (let i = 0; i < count; i++) {
    const wallet = generateWalletFromPath(masterSeed, hdPath, i)
    wallets.push(wallet)
  }

  return wallets
}

// 收集所有目标地址
function collectTargetAddresses(nodes: InstitutionNode[]): string[] {
  const addresses: string[] = []

  for (const node of nodes) {
    if (node.addresses) {
      addresses.push(...node.addresses)
    }
  }

  return addresses
}

// 阶段1: 向中间钱包分发Gas
async function distributeToIntermediateWallets(
  provider: Provider,
  exchangeWallets: Wallet[],
  intermediateWallets: Wallet[],
  totalTargetAddresses: number,
  gasConfig: GasDistributionConfig,
  dryRun: boolean,
) {
  const totalGasNeeded = BigInt(totalTargetAddresses) * ethers.parseEther(gasConfig.gasAmounts.max)
  const gasPerIntermediate = totalGasNeeded / BigInt(intermediateWallets.length)

  Logger.info(`每个中间钱包需要: ${formatEther(gasPerIntermediate)} ETH`)

  const gasPriceRec = await coordinator.getGasPriceRecommendation(provider)

  for (let i = 0; i < intermediateWallets.length; i++) {
    const intermediateWallet = intermediateWallets[i]
    const exchangeWallet = exchangeWallets[i % exchangeWallets.length]

    const amount = gasPerIntermediate + ethers.parseEther('0.01') // 额外0.01 ETH作为交易费

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
            maxRetries: 5,
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

// 阶段2: 向目标地址分发Gas
async function distributeToTargetAddresses(
  provider: Provider,
  intermediateWallets: Wallet[],
  targetAddresses: string[],
  gasConfig: GasDistributionConfig,
  batchSize: number,
  delayMs: number,
  dryRun: boolean,
) {
  const tasks: DistributionTask[] = []

  // 为每个目标地址创建Gas分发任务
  for (let i = 0; i < targetAddresses.length; i++) {
    const targetAddress = targetAddresses[i]
    const intermediateWallet = intermediateWallets[i % intermediateWallets.length]

    const amount = generateRandomEthAmount(gasConfig.gasAmounts.min, gasConfig.gasAmounts.max)

    tasks.push({
      id: generateTaskId(),
      type: 'gas',
      fromAddress: intermediateWallet.address,
      toAddress: targetAddress,
      amount: amount.toString(),
      scheduledTime: Date.now(),
      status: 'pending',
    })
  }

  Logger.info(`创建了 ${tasks.length} 个Gas分发任务`)

  // 分批执行任务
  const batches = chunkArray(tasks, batchSize)
  let totalCompleted = 0
  let totalFailed = 0

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]

    Logger.info(`执行第 ${batchIndex + 1}/${batches.length} 批任务 (${batch.length} 个)`)

    // 并行执行批次内的任务
    const promises = batch.map(async task => {
      const walletIndex = intermediateWallets.findIndex(w => w.address === task.fromAddress)
      const wallet = intermediateWallets[walletIndex].connect(provider)

      if (!dryRun) {
        try {
          // 检查余额
          const balanceCheck = await coordinator.checkWalletBalance(
            wallet.address,
            BigInt(task.amount) + ethers.parseUnits('20', 'gwei') * 21000n,
            provider,
          )

          if (!balanceCheck.sufficient) {
            throw new Error(
              `钱包余额不足: ${formatEther(balanceCheck.current)} < ${formatEther(balanceCheck.required)}`,
            )
          }

          await coordinator.smartRetry(
            async () => {
              const nonce = await coordinator.getNextNonce(wallet.address, provider)
              const gasPrice = generateRandomGasPrice(
                gasConfig.gasPriceRandomization.min,
                gasConfig.gasPriceRandomization.max,
              )

              const tx = await wallet.sendTransaction({
                to: task.toAddress,
                value: BigInt(task.amount),
                gasPrice: gasPrice,
                nonce: nonce,
              })

              task.status = 'completed'
              task.txHash = tx.hash
              Logger.debug(`Gas分发完成: ${task.fromAddress} -> ${task.toAddress} (${tx.hash})`)
              return tx
            },
            {
              maxRetries: 3,
              baseDelay: 1000,
              retryCondition: (error: Error) => {
                const msg = error.message.toLowerCase()
                return (
                  msg.includes('nonce') ||
                  msg.includes('replacement') ||
                  msg.includes('network') ||
                  msg.includes('insufficient')
                )
              },
            },
          )
        } catch (error) {
          task.status = 'failed'
          task.error = (error as Error).message
          Logger.error(`Gas分发失败: ${task.fromAddress} -> ${task.toAddress}`, error)
        }
      } else {
        task.status = 'completed'
        Logger.debug(
          `[DRY-RUN] Gas分发: ${task.fromAddress} -> ${task.toAddress}: ${formatEther(BigInt(task.amount))} ETH`,
        )
      }
    })

    await Promise.all(promises)

    // 统计批次结果
    const batchCompleted = batch.filter(t => t.status === 'completed').length
    const batchFailed = batch.filter(t => t.status === 'failed').length
    totalCompleted += batchCompleted
    totalFailed += batchFailed

    Logger.info(`批次 ${batchIndex + 1} 完成: ${batchCompleted}/${batch.length} 成功`)

    // 批次间延迟
    if (batchIndex < batches.length - 1) {
      Logger.info(`等待 ${delayMs}ms 后执行下一批...`)
      await delay(delayMs)
    }
  }

  // 统计结果
  Logger.info(`\n=== Gas分发统计 ===`)
  Logger.info(`总任务数: ${tasks.length}`)
  Logger.info(`成功: ${totalCompleted}`)
  Logger.info(`失败: ${totalFailed}`)
  Logger.info(`成功率: ${((totalCompleted / tasks.length) * 100).toFixed(2)}%`)

  // 显示失败的任务详情
  if (totalFailed > 0) {
    Logger.info(`\n失败的任务:`)
    tasks
      .filter(t => t.status === 'failed')
      .forEach(task => {
        Logger.info(`  ${task.fromAddress} -> ${task.toAddress}: ${task.error}`)
      })
  }
}

// 数组分块工具函数
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}
