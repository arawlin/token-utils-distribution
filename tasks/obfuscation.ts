import { task } from 'hardhat/config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import type { Wallet, Provider } from 'ethers'
import { DistributionSystemConfig, ObfuscationConfig } from '../types'
import {
  generateWalletFromPath,
  generateRandomEthAmount,
  generateRandomGasPrice,
  formatEther,
  delay,
  Logger,
  shuffleArray,
} from './utils'
import { coordinator } from './coordinator'

task('obfuscation', '抗检测干扰交易模块')
  .addOptionalParam('configDir', '配置目录', './generated')
  .addOptionalParam('duration', '执行时长(分钟)', '60')
  .addOptionalParam('intensity', '干扰强度(0.1-1.0)', '0.3')
  .addOptionalParam('maxRetries', '最大重试次数', '3')
  .addFlag('dryRun', '干运行模式（不执行实际交易）')
  .addFlag('circularOnly', '只执行循环交易')
  .addFlag('randomOnly', '只执行随机转账')
  .addFlag('force', '强制执行（跳过锁检查）')
  .setAction(async (taskArgs, hre) => {
    const { configDir, duration, intensity, maxRetries, dryRun, circularOnly, randomOnly, force } = taskArgs
    let taskId = ''

    try {
      // 获取任务锁
      if (!force) {
        taskId = await coordinator.acquireTaskLock('obfuscation')
      }

      Logger.info('开始执行抗检测干扰交易')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`执行时长: ${duration} 分钟`)
      Logger.info(`干扰强度: ${intensity}`)
      Logger.info(`干运行模式: ${dryRun}`)
      Logger.info(`最大重试次数: ${maxRetries}`)

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
      const obfuscationConfig = config.obfuscation

      // 计算执行参数
      const durationMs = parseInt(duration) * 60 * 1000 // 转换为毫秒
      const intensityValue = Math.min(1.0, Math.max(0.1, parseFloat(intensity)))
      const endTime = Date.now() + durationMs

      Logger.info(`将运行至: ${new Date(endTime).toLocaleString()}`)

      // 生成循环交易钱包
      let circularWallets: Wallet[] = []
      if ((obfuscationConfig.circularTransactions.enabled && !randomOnly) || circularOnly) {
        Logger.info('生成循环交易钱包...')
        circularWallets = await generateCircularWallets(provider, masterSeed, obfuscationConfig)
        Logger.info(`生成了 ${circularWallets.length} 个循环交易钱包`)
      }

      // 主执行循环
      let transactionCount = 0
      let circularCount = 0
      let randomCount = 0

      while (Date.now() < endTime) {
        try {
          // 根据强度和配置决定执行什么类型的交易
          const shouldExecuteCircular =
            (obfuscationConfig.circularTransactions.enabled && !randomOnly && circularWallets.length > 0) ||
            circularOnly

          const shouldExecuteRandom = (obfuscationConfig.randomTransfers.enabled && !circularOnly) || randomOnly

          const actionType =
            Math.random() < 0.5 && shouldExecuteCircular ? 'circular' : shouldExecuteRandom ? 'random' : null

          if (actionType === 'circular' && circularWallets.length >= 2) {
            await executeCircularTransaction(circularWallets, obfuscationConfig, dryRun)
            circularCount++
          } else if (actionType === 'random' && circularWallets.length >= 1) {
            await executeRandomTransfer(circularWallets, obfuscationConfig, dryRun)
            randomCount++
          }

          transactionCount++

          // 基于强度计算延迟时间
          const baseDelay = 30000 // 30秒基础延迟
          const maxDelay = 180000 // 3分钟最大延迟
          const delayTime = baseDelay + Math.random() * (maxDelay - baseDelay) * (1 - intensityValue)

          Logger.debug(`执行了 ${transactionCount} 个干扰交易，等待 ${Math.round(delayTime / 1000)} 秒...`)

          if (!dryRun) {
            await delay(delayTime)
          } else {
            await delay(1000) // 干运行模式下快速执行
          }
        } catch (error) {
          Logger.error('执行干扰交易时发生错误:', error)
          await delay(60000) // 发生错误时等待1分钟
        }
      }

      Logger.info('\n=== 抗检测执行统计 ===')
      Logger.info(`总干扰交易数: ${transactionCount}`)
      Logger.info(`循环交易数: ${circularCount}`)
      Logger.info(`随机转账数: ${randomCount}`)
      Logger.info(`平均间隔: ${Math.round(durationMs / 1000 / transactionCount)} 秒`)
      Logger.info('抗检测模块执行完成!')

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'completed')
      }
    } catch (error) {
      Logger.error('抗检测模块执行失败:', error)

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'failed')
      }

      throw error
    }
  })

// 生成循环交易钱包
async function generateCircularWallets(
  provider: Provider,
  masterSeed: string,
  obfuscationConfig: ObfuscationConfig,
): Promise<Wallet[]> {
  const wallets: Wallet[] = []
  const walletConfig = obfuscationConfig.circularTransactions.wallets

  // 生成钱包
  for (let i = 0; i < walletConfig.count; i++) {
    const wallet = generateWalletFromPath(masterSeed, walletConfig.hdPath, i)
    const connectedWallet = wallet.connect(provider)
    wallets.push(connectedWallet)
  }

  // 检查余额并显示警告
  Logger.info('检查循环交易钱包余额...')
  for (let i = 0; i < Math.min(3, wallets.length); i++) {
    // 只检查前3个钱包避免过多日志
    const balance = await provider.getBalance(wallets[i].address)
    if (balance < ethers.parseEther('0.01')) {
      Logger.warn(`钱包 ${wallets[i].address} 余额较低: ${formatEther(balance)} ETH`)
    }
  }

  return wallets
}

// 执行循环交易
async function executeCircularTransaction(wallets: Wallet[], obfuscationConfig: ObfuscationConfig, dryRun: boolean) {
  if (wallets.length < 2) return

  // 随机选择两个不同的钱包
  const shuffledWallets = shuffleArray(wallets)
  const fromWallet = shuffledWallets[0]
  const toWallet = shuffledWallets[1]

  // 生成随机金额
  const amount = generateRandomEthAmount(
    obfuscationConfig.randomTransfers.ethAmounts.min,
    obfuscationConfig.randomTransfers.ethAmounts.max,
  )

  const gasPrice = generateRandomGasPrice(15, 40)

  Logger.info(`循环交易: ${fromWallet.address} -> ${toWallet.address} (${formatEther(amount)} ETH)`)

  if (!dryRun) {
    try {
      // 检查余额是否足够
      const balance = (await fromWallet.provider?.getBalance(fromWallet.address)) || 0n
      const estimatedGas = 21000n
      const totalCost = amount + gasPrice * estimatedGas

      if (balance < totalCost) {
        Logger.warn(`钱包余额不足，跳过循环交易: ${fromWallet.address}`)
        return
      }

      await coordinator.smartRetry(
        async () => {
          // 获取nonce并验证余额
          const nonce = await coordinator.getNextNonce(fromWallet.address, fromWallet.provider!)
          const balanceCheck = await coordinator.checkWalletBalance(fromWallet.address, totalCost, fromWallet.provider!)

          if (!balanceCheck.sufficient) {
            throw new Error(`钱包余额不足: 需要 ${totalCost}, 拥有 ${balanceCheck.current}`)
          }

          const tx = await fromWallet.sendTransaction({
            to: toWallet.address,
            value: amount,
            gasPrice: gasPrice,
            gasLimit: estimatedGas,
            nonce: nonce,
          })

          const receipt = await tx.wait()
          if (receipt && receipt.status === 1) {
            Logger.debug(`循环交易完成: ${tx.hash}`)
            return receipt
          } else {
            throw new Error(`循环交易失败: ${tx.hash}`)
          }
        },
        { maxRetries: 3 },
      )

      // 50%概率执行反向交易（形成真正的循环）
      if (Math.random() < 0.5) {
        await delay(Math.random() * 30000 + 10000) // 10-40秒后执行反向交易

        const reverseAmount = amount / 2n // 反向金额稍小避免余额不足
        const reverseBalance = (await toWallet.provider?.getBalance(toWallet.address)) || 0n
        const reverseTotalCost = reverseAmount + gasPrice * estimatedGas

        if (reverseBalance >= reverseTotalCost) {
          await coordinator.smartRetry(
            async () => {
              // 获取nonce并验证余额
              const nonce = await coordinator.getNextNonce(toWallet.address, toWallet.provider!)
              const balanceCheck = await coordinator.checkWalletBalance(
                toWallet.address,
                reverseTotalCost,
                toWallet.provider!,
              )

              if (!balanceCheck.sufficient) {
                throw new Error(`钱包余额不足进行反向交易: 需要 ${reverseTotalCost}, 拥有 ${balanceCheck.current}`)
              }

              const reverseTx = await toWallet.sendTransaction({
                to: fromWallet.address,
                value: reverseAmount,
                gasPrice: gasPrice,
                gasLimit: estimatedGas,
                nonce: nonce,
              })

              const receipt = await reverseTx.wait()
              if (receipt && receipt.status === 1) {
                Logger.debug(`反向循环交易完成: ${reverseTx.hash}`)
                return receipt
              } else {
                throw new Error(`反向循环交易失败: ${reverseTx.hash}`)
              }
            },
            { maxRetries: 3 },
          )
        }
      }
    } catch (error) {
      Logger.error(`循环交易失败: ${fromWallet.address} -> ${toWallet.address}`, error)
    }
  } else {
    Logger.debug(`[DRY-RUN] 循环交易: ${fromWallet.address} -> ${toWallet.address}`)
  }
}

// 执行随机转账
async function executeRandomTransfer(wallets: Wallet[], obfuscationConfig: ObfuscationConfig, dryRun: boolean) {
  if (wallets.length < 1) return

  // 随机选择源钱包
  const sourceWallet = wallets[Math.floor(Math.random() * wallets.length)]

  // 生成随机目标地址（可以是另一个循环钱包或随机地址）
  let targetAddress: string
  if (wallets.length > 1 && Math.random() < 0.7) {
    // 70%概率选择另一个循环钱包作为目标
    const otherWallets = wallets.filter(w => w.address !== sourceWallet.address)
    targetAddress = otherWallets[Math.floor(Math.random() * otherWallets.length)].address
  } else {
    // 30%概率生成随机地址
    targetAddress = ethers.Wallet.createRandom().address
  }

  const amount = generateRandomEthAmount(
    obfuscationConfig.randomTransfers.ethAmounts.min,
    obfuscationConfig.randomTransfers.ethAmounts.max,
  )

  const gasPrice = generateRandomGasPrice(15, 40)

  Logger.info(`随机转账: ${sourceWallet.address} -> ${targetAddress} (${formatEther(amount)} ETH)`)

  if (!dryRun) {
    try {
      // 检查余额
      const balance = (await sourceWallet.provider?.getBalance(sourceWallet.address)) || 0n
      const estimatedGas = 21000n
      const totalCost = amount + gasPrice * estimatedGas

      if (balance < totalCost) {
        Logger.warn(`钱包余额不足，跳过随机转账: ${sourceWallet.address}`)
        return
      }

      await coordinator.smartRetry(
        async () => {
          // 获取nonce并验证余额
          const nonce = await coordinator.getNextNonce(sourceWallet.address, sourceWallet.provider!)
          const balanceCheck = await coordinator.checkWalletBalance(
            sourceWallet.address,
            totalCost,
            sourceWallet.provider!,
          )

          if (!balanceCheck.sufficient) {
            throw new Error(`钱包余额不足: 需要 ${totalCost}, 拥有 ${balanceCheck.current}`)
          }

          const tx = await sourceWallet.sendTransaction({
            to: targetAddress,
            value: amount,
            gasPrice: gasPrice,
            gasLimit: estimatedGas,
            nonce: nonce,
          })

          const receipt = await tx.wait()
          if (receipt && receipt.status === 1) {
            Logger.debug(`随机转账完成: ${tx.hash}`)
            return receipt
          } else {
            throw new Error(`随机转账失败: ${tx.hash}`)
          }
        },
        { maxRetries: 3 },
      )
    } catch (error) {
      Logger.error(`随机转账失败: ${sourceWallet.address} -> ${targetAddress}`, error)
    }
  } else {
    Logger.debug(`[DRY-RUN] 随机转账: ${sourceWallet.address} -> ${targetAddress}`)
  }
}
