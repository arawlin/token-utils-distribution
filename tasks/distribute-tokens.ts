import type { Contract, Provider, Wallet } from 'ethers'
import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import {
  calculateDistributionAmounts,
  getDistributorAddresses,
  getHolderAddresses,
  getNodesByDepth,
  institutionTreeConfig,
} from '../config/institutions'
import { DistributionSystemConfig, DistributionTask, TokenDistributionConfig } from '../types'
import { coordinator } from './coordinator'
import { chunkArray, delay, formatTokenAmount, generateRandomGasPrice, Logger } from './utils'

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

      // 获取所有机构节点
      Logger.info('收集Token分发目标...')
      const allNodes = Array.from(getNodesByDepth(institutionTreeConfig).values()).flat()
      const totalTargetAddresses = allNodes.reduce((sum, node) => sum + node.addressCount, 0)

      Logger.info(`需要分发Token的地址总数: ${totalTargetAddresses}`)
      Logger.info(`机构节点数: ${allNodes.length}`)
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
        // 使用主机构的一些地址进行安全检查
        const mainInstitutions = getNodesByDepth(institutionTreeConfig).get(0) || []
        const testAddresses = mainInstitutions
          .slice(0, 2)
          .flatMap(institution => (institution.addresses || []).slice(0, 2))
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

      // 执行主要分发 - 层级分发
      Logger.info('\n=== 执行层级Token分发 ===')
      await executeHierarchicalTokenDistribution(
        tokenContract,
        sourceWallet,
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
// Token分发任务执行器
async function executeTokenDistributionTasks(
  tokenContract: Contract,
  sourceWallet: Wallet,
  tasks: DistributionTask[],
  tokenInfo: { decimals: number; symbol: string },
  batchSize: number,
  maxRetries: number,
  dryRun: boolean,
) {
  if (tasks.length === 0) return

  // 按时间排序任务
  tasks.sort((a, b) => a.scheduledTime - b.scheduledTime)

  Logger.info(`执行 ${tasks.length} 个Token分发任务`)

  let totalCompleted = 0
  let totalFailed = 0

  // 分批执行任务
  const batches = chunkArray(tasks, batchSize)

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]

    Logger.info(`执行第 ${batchIndex + 1}/${batches.length} 批Token分发 (${batch.length} 个)`)

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
        // 等待到任务的具体计划时间
        const currentTime = Date.now()
        if (currentTime < task.scheduledTime) {
          const waitTime = task.scheduledTime - currentTime
          if (!dryRun && waitTime > 0) {
            await delay(waitTime)
          }
        }

        const amount = BigInt(task.amount)
        const gasPrice = generateRandomGasPrice(20, 60)

        Logger.info(
          `Token分发: ${task.toAddress} - ${formatTokenAmount(amount, tokenInfo.decimals)} ${tokenInfo.symbol} (${task.institutionGroup || '未知机构'})`,
        )

        if (!dryRun) {
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

              const tx = await tokenContract.transfer(task.toAddress, amount, {
                gasPrice: gasPrice,
                nonce: nonce,
              })

              const receipt = await tx.wait()

              if (receipt.status === 1) {
                Logger.info(`✅ Token分发成功: ${task.toAddress} (${tx.hash})`)
                return receipt
              } else {
                throw new Error(`Token分发交易失败: ${tx.hash}`)
              }
            },
            { maxRetries },
          )
          totalCompleted++
        } else {
          totalCompleted++
          Logger.info(`[DRY-RUN] ✅ Token分发: ${task.toAddress}`)
        }
      } catch (error) {
        totalFailed++
        Logger.error(`❌ Token分发失败: ${task.toAddress}`, error)
      }

      // 随机延迟避免被检测
      const randomDelay = Math.random() * 3000 + 1000 // 1-4秒随机延迟
      await delay(randomDelay)
    })

    await Promise.all(promises)

    Logger.info(`批次 ${batchIndex + 1} 完成: ${totalCompleted - totalFailed} 成功`)

    // 批次间短暂暂停
    if (batchIndex < batches.length - 1 && !dryRun) {
      await delay(2000)
    }
  }

  // 输出统计
  Logger.info(`Token分发任务完成: ${totalCompleted} 成功, ${totalFailed} 失败`)
}

// 层级Token分发：分层执行Token分发
async function executeHierarchicalTokenDistribution(
  tokenContract: Contract,
  sourceWallet: Wallet,
  tokenConfig: TokenDistributionConfig,
  tokenInfo: { decimals: number; symbol: string },
  batchSize: number,
  maxRetries: number,
  dryRun: boolean,
) {
  const baseTime = Date.now()

  // 1. 首先分发给所有主要机构（深度0）
  const depthMap = getNodesByDepth(institutionTreeConfig)
  const mainInstitutions = depthMap.get(0) || []
  Logger.info(`\n=== 阶段1：分发给 ${mainInstitutions.length} 个主要机构 ===`)

  // 使用配置中的均值作为总量
  const totalTokensToDistribute = BigInt(tokenConfig.distributionPlan.amounts.mean)

  // 计算各主机构应得的token数量
  const mainInstitutionAmounts = calculateDistributionAmounts(mainInstitutions, totalTokensToDistribute)

  const mainTasks: DistributionTask[] = []

  for (const institution of mainInstitutions) {
    const amounts = mainInstitutionAmounts.get(institution.hdPath)
    if (!amounts) continue

    // 为主机构生成分发时间（在窗口内分散）
    const window = institution.tokenReceiveWindow || { start: 0, end: 30 } // 默认30分钟窗口
    const windowStartMs = baseTime + window.start * 60 * 1000
    const windowEndMs = baseTime + window.end * 60 * 1000
    const scheduledTime = windowStartMs + Math.random() * (windowEndMs - windowStartMs)

    // 获取分发者地址（用于从源钱包分发）
    const distributorAddresses = getDistributorAddresses([institution])
    const targetAddress = distributorAddresses.get(institution.hdPath)

    if (!targetAddress) {
      Logger.warn(`机构 ${institution.institutionName} 没有分发者地址`)
      continue
    }

    mainTasks.push({
      id: `main-${institution.institutionName}-${Date.now()}`,
      type: 'token',
      subType: 'hierarchical-token',
      fromAddress: sourceWallet.address,
      toAddress: targetAddress,
      scheduledTime,
      amount: amounts.receive.toString(),
      status: 'pending',
      institutionGroup: institution.institutionName,
      hierarchyLevel: 0,
      retentionAmount: amounts.retain.toString(),
    })
  }

  // 执行主机构分发
  await executeTokenDistributionTasks(tokenContract, sourceWallet, mainTasks, tokenInfo, batchSize, maxRetries, dryRun)

  // 2. 然后按深度层级处理子机构分发
  const maxDepth = Math.max(...Array.from(depthMap.keys()))

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nodesAtDepth = depthMap.get(depth) || []

    if (nodesAtDepth.length === 0) continue

    Logger.info(`\n=== 阶段${depth + 1}：深度${depth}的分发 (${nodesAtDepth.length} 个机构) ===`)

    const depthTasks: DistributionTask[] = []

    for (const institution of nodesAtDepth) {
      // 计算该机构应当收到的token数量（来自父机构的分发）
      const amounts = mainInstitutionAmounts.get(institution.hdPath)
      if (!amounts) continue

      // 获取分发目标地址
      if (institution.childNodes.length === 0) {
        // 最终用户：分发给所有持有者地址
        const holderAddresses = getHolderAddresses([institution])
        const holderAddressList = holderAddresses.get(institution.hdPath) || []
        const amountPerAddress = amounts.receive / BigInt(holderAddressList.length)

        for (const targetAddress of holderAddressList) {
          const window = institution.tokenReceiveWindow || { start: 0, end: 30 }
          const windowStartMs = baseTime + window.start * 60 * 1000 + depth * 10 * 60 * 1000 // 每层延迟10分钟
          const windowEndMs = baseTime + window.end * 60 * 1000 + depth * 10 * 60 * 1000
          const scheduledTime = windowStartMs + Math.random() * (windowEndMs - windowStartMs)

          depthTasks.push({
            id: `end-user-${institution.institutionName}-${targetAddress}-${Date.now()}`,
            type: 'token',
            subType: 'hierarchical-token',
            fromAddress: sourceWallet.address, // 实际应该是父机构的分发者地址
            toAddress: targetAddress,
            scheduledTime,
            amount: amountPerAddress.toString(),
            status: 'pending',
            institutionGroup: institution.institutionName,
            dependsOn: [],
            hierarchyLevel: depth,
          })
        }
      } else {
        // 中间机构：分发给分发者地址
        const distributorAddresses = getDistributorAddresses([institution])
        const targetAddress = distributorAddresses.get(institution.hdPath)

        if (!targetAddress) {
          Logger.warn(`机构 ${institution.institutionName} 没有分发者地址`)
          continue
        }

        const window = institution.tokenReceiveWindow || { start: 0, end: 30 }
        const windowStartMs = baseTime + window.start * 60 * 1000 + depth * 10 * 60 * 1000
        const windowEndMs = baseTime + window.end * 60 * 1000 + depth * 10 * 60 * 1000
        const scheduledTime = windowStartMs + Math.random() * (windowEndMs - windowStartMs)

        depthTasks.push({
          id: `mid-${institution.institutionName}-${Date.now()}`,
          type: 'token',
          subType: 'hierarchical-token',
          fromAddress: sourceWallet.address, // 实际应该是父机构的分发者地址
          toAddress: targetAddress,
          scheduledTime,
          amount: amounts.receive.toString(),
          status: 'pending',
          institutionGroup: institution.institutionName,
          hierarchyLevel: depth,
          retentionAmount: amounts.retain.toString(),
        })
      }
    }

    // 执行这一层的分发任务
    if (depthTasks.length > 0) {
      // 对于中间层机构，需要从父机构的分发者钱包执行分发
      // 这里简化处理，假设我们有权限使用各机构的分发者钱包
      await executeTokenDistributionTasks(
        tokenContract,
        sourceWallet, // 实际应该是各父机构的分发者钱包
        depthTasks,
        tokenInfo,
        batchSize,
        maxRetries,
        dryRun,
      )
    }
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
