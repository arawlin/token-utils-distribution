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
  retry,
  Logger,
  generateTaskId,
} from './utils'

task('distribute-gas', 'Gas费分发任务')
  .addOptionalParam('configDir', '配置目录', './generated')
  .addOptionalParam('batchSize', '批处理大小', '10')
  .addOptionalParam('delayMs', '批次间延迟(毫秒)', '5000')
  .addFlag('dryRun', '干运行模式（不执行实际交易）')
  .setAction(async (taskArgs, hre) => {
    const { configDir, batchSize, delayMs, dryRun } = taskArgs

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

    try {
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
    } catch (error) {
      Logger.error('Gas分发任务失败:', error)
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

  for (let i = 0; i < intermediateWallets.length; i++) {
    const intermediateWallet = intermediateWallets[i]
    const exchangeWallet = exchangeWallets[i % exchangeWallets.length]

    const amount = gasPerIntermediate + ethers.parseEther('0.01') // 额外0.01 ETH作为交易费
    const gasPrice = generateRandomGasPrice(gasConfig.gasPriceRandomization.min, gasConfig.gasPriceRandomization.max)

    Logger.info(`${exchangeWallet.address} -> ${intermediateWallet.address}: ${formatEther(amount)} ETH`)

    if (!dryRun) {
      try {
        const tx = await retry(async () => {
          return await exchangeWallet.sendTransaction({
            to: intermediateWallet.address,
            value: amount,
            gasPrice: gasPrice,
          })
        })

        Logger.info(`交易已发送: ${tx.hash}`)
      } catch (error) {
        Logger.error(`交易失败: ${exchangeWallet.address} -> ${intermediateWallet.address}`, error)
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

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]

    Logger.info(`执行第 ${batchIndex + 1}/${batches.length} 批任务 (${batch.length} 个)`)

    // 并行执行批次内的任务
    const promises = batch.map(async task => {
      const walletIndex = intermediateWallets.findIndex(w => w.address === task.fromAddress)
      const wallet = intermediateWallets[walletIndex].connect(provider)

      const gasPrice = generateRandomGasPrice(gasConfig.gasPriceRandomization.min, gasConfig.gasPriceRandomization.max)

      if (!dryRun) {
        try {
          const tx = await retry(async () => {
            return await wallet.sendTransaction({
              to: task.toAddress,
              value: BigInt(task.amount),
              gasPrice: gasPrice,
            })
          })

          task.status = 'completed'
          task.txHash = tx.hash
          Logger.debug(`Gas分发完成: ${task.fromAddress} -> ${task.toAddress} (${tx.hash})`)
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

    // 批次间延迟
    if (batchIndex < batches.length - 1) {
      Logger.info(`等待 ${delayMs}ms 后执行下一批...`)
      await delay(delayMs)
    }
  }

  // 统计结果
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length

  Logger.info(`\n=== Gas分发统计 ===`)
  Logger.info(`总任务数: ${tasks.length}`)
  Logger.info(`成功: ${completed}`)
  Logger.info(`失败: ${failed}`)
  Logger.info(`成功率: ${((completed / tasks.length) * 100).toFixed(2)}%`)
}

// 数组分块工具函数
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}
