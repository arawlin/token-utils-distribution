import type { Provider, Wallet } from 'ethers'
import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { generateInstitutionBasedTasks, getInstitutionGroups } from '../config/institutions'
import { DistributionSystemConfig, DistributionTask, GasDistributionConfig, InstitutionGroup } from '../types'
import { coordinator } from './coordinator'
import {
  chunkArray,
  delay,
  formatEther,
  generateRandomEthAmount,
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
        masterSeed,
        gasConfig.intermediateWallets.hdPath,
        gasConfig.intermediateWallets.count,
      )

      // 获取所有需要Gas的地址 - 使用机构分组
      Logger.info('收集目标地址...')
      const institutionGroups = getInstitutionGroups(config.institutionTree)
      const totalTargetAddresses = institutionGroups.reduce((sum, group) => sum + group.addresses.length, 0)

      Logger.info(`需要分发Gas的地址总数: ${totalTargetAddresses}`)
      Logger.info(`机构组数: ${institutionGroups.length}`)

      // 阶段1: 从交易所向中间钱包分发Gas for test
      Logger.info('\n=== 阶段1: 交易所 -> 中间钱包 ===')

      // 验证交易所钱包余额
      Logger.info('验证交易所钱包余额...')
      const exchangeWallets = await validateExchangeWallets(provider, gasConfig.exchangeSources)
      if (exchangeWallets.length === 0) {
        Logger.error('没有可用的交易所钱包')
        return
      }

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
        await delay(2000) // 等待30秒让交易确认
      }

      // 阶段2: 从中间钱包向目标地址分发Gas - 使用机构时间窗口
      Logger.info('\n=== 阶段2: 中间钱包 -> 目标地址 ===')
      await distributeToTargetAddressesByInstitution(
        provider,
        intermediateWallets,
        institutionGroups,
        gasConfig,
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
function generateIntermediateWallets(masterSeed: string, hdPath: string, count: number): Wallet[] {
  const wallets: Wallet[] = []

  for (let i = 0; i < count; i++) {
    const wallet = generateWalletFromPath(masterSeed, hdPath, i)
    wallets.push(wallet)
  }

  return wallets
}

// 阶段2: 按机构分组向目标地址分发Gas
async function distributeToTargetAddressesByInstitution(
  provider: Provider,
  intermediateWallets: Wallet[],
  institutionGroups: InstitutionGroup[],
  gasConfig: GasDistributionConfig,
  batchSize: number,
  delayMs: number,
  maxRetries: number,
  dryRun: boolean,
) {
  const baseTime = Date.now()

  // 使用新的机构基础任务生成器
  const institutionTasks = generateInstitutionBasedTasks(institutionGroups, 'gas', baseTime, () =>
    generateRandomEthAmount(gasConfig.gasAmounts.min, gasConfig.gasAmounts.max),
  )

  // 转换为标准的DistributionTask格式
  const tasks: DistributionTask[] = institutionTasks.map(task => ({
    id: generateTaskId(),
    type: 'gas',
    fromAddress: intermediateWallets[Math.floor(Math.random() * intermediateWallets.length)].address,
    toAddress: task.address,
    amount: task.amount,
    scheduledTime: task.scheduledTime,
    status: 'pending',
    institutionGroup: task.group.institutionName,
  }))

  Logger.info(`创建了 ${tasks.length} 个Gas分发任务，按 ${institutionGroups.length} 个机构分组`)

  // 按机构分组执行任务
  const institutionNames = [...new Set(tasks.map(t => t.institutionGroup))]
  let totalCompleted = 0
  let totalFailed = 0

  for (const institutionName of institutionNames) {
    const institutionTasks = tasks.filter(t => t.institutionGroup === institutionName)

    Logger.info(`\n=== 开始处理 ${institutionName} (${institutionTasks.length} 个地址) ===`)

    // 等待到第一个任务的计划时间
    const firstTaskTime = Math.min(...institutionTasks.map(t => t.scheduledTime))
    const currentTime = Date.now()

    if (currentTime < firstTaskTime) {
      const waitTime = firstTaskTime - currentTime
      Logger.info(`等待 ${Math.round(waitTime / 1000)} 秒直到 ${institutionName} 的Gas分发窗口...`)
      if (!dryRun) {
        await delay(waitTime)
      }
    }

    // 分批执行该机构的任务
    const batches = chunkArray(institutionTasks, batchSize)

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex]

      Logger.info(`执行 ${institutionName} 第 ${batchIndex + 1}/${batches.length} 批任务 (${batch.length} 个)`)

      // 并行执行批次内的任务
      const promises = batch.map(async task => {
        const walletIndex = intermediateWallets.findIndex(w => w.address === task.fromAddress)
        const wallet =
          walletIndex >= 0
            ? intermediateWallets[walletIndex].connect(provider)
            : intermediateWallets[Math.floor(Math.random() * intermediateWallets.length)].connect(provider)

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
                maxRetries,
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

      Logger.info(`${institutionName} 批次 ${batchIndex + 1} 完成: ${batchCompleted}/${batch.length} 成功`)

      // 批次间延迟（同一机构内较短）
      if (batchIndex < batches.length - 1) {
        const shortDelay = Math.random() * 3000 + 2000 // 2-5秒随机延迟
        await delay(shortDelay)
      }
    }

    Logger.info(
      `${institutionName} 完成: ${institutionTasks.filter(t => t.status === 'completed').length}/${institutionTasks.length} 成功`,
    )

    // 机构间较长延迟
    const currentInstitutionIndex = institutionNames.indexOf(institutionName)
    if (currentInstitutionIndex < institutionNames.length - 1) {
      const longDelay = Math.random() * 30000 + 10000 // 10-40秒随机延迟
      Logger.info(`等待 ${Math.round(longDelay / 1000)} 秒后处理下一个机构...`)
      if (!dryRun) {
        await delay(longDelay)
      }
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
        Logger.info(`  [${task.institutionGroup}] ${task.fromAddress} -> ${task.toAddress}: ${task.error}`)
      })
  }
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
