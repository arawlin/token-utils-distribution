import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { createTimestampFilename, formatTokenAmount, loadAllWallets, Logger } from './utils'

interface ConsolidationResult {
  success: number
  failed: number
  totalCollected: bigint
  transactions: Array<{
    from: string
    to: string
    amount: string
    txHash?: string
    error?: string
    status: 'success' | 'failed' | 'pending'
    type: 'token' | 'gas'
  }>
}

interface ConsolidationPlan {
  from: string
  to: string
  amount: bigint
  formattedAmount: string
  needsGas: boolean
  gasAmount?: bigint
}

task('auto-consolidate-tokens', '自动将所有钱包中的Token归集到指定地址')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('tokenAddress', 'Token合约地址')
  .addParam('targets', '目标归集地址列表，用逗号分隔 (例: 0x123...,0x456...)')
  .addOptionalParam('minBalance', '最小归集余额阈值（低于此值不归集）', '0.01')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('delayMin', '交易间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '交易间最大延迟（毫秒）', '5000')
  .addOptionalParam('autoFundGas', '当ETH余额不足时自动转账ETH', 'true')
  .addOptionalParam('fundingSource', '资助钱包私钥或地址（默认使用目标地址中ETH余额最高的）', process.env.FUNDING_WALLET_ADDRESS)
  .addOptionalParam('fundingMultiplier', '资助金额倍数（gas费的倍数）', '1.2')
  .addOptionalParam('fundingDelay', '转账后等待时间（毫秒）', '5000')
  .addOptionalParam('dryRun', '是否为试运行模式（不执行实际交易）', 'false')
  .setAction(async (taskArgs, hre) => {
    const {
      configDir,
      tokenAddress,
      targets,
      minBalance,
      gasPrice,
      delayMin,
      delayMax,
      autoFundGas,
      fundingSource,
      fundingMultiplier,
      fundingDelay,
      dryRun,
    } = taskArgs

    const tokenAddressReal = tokenAddress || process.env.TOKEN_ADDRESS
    const isDryRun = dryRun === 'true'

    try {
      Logger.info('开始执行Token自动归集任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`Token地址: ${tokenAddressReal}`)
      Logger.info(`试运行模式: ${isDryRun ? '是' : '否'}`)

      const minBalanceNum = parseFloat(minBalance)
      Logger.info(`最小归集余额阈值: ${minBalanceNum} Token`)

      // 验证Token合约地址
      if (!ethers.isAddress(tokenAddressReal)) {
        Logger.error('无效的Token合约地址')
        return
      }

      // 解析目标地址列表
      const targetAddresses = targets
        .split(',')
        .map((addr: string) => addr.trim())
        .filter((addr: string) => addr.length > 0)
        .map((addr: string) => addr.toLowerCase())

      if (targetAddresses.length === 0) {
        Logger.error('未提供有效的目标归集地址')
        return
      }

      Logger.info(`目标归集地址数量: ${targetAddresses.length}`)

      // 验证所有目标地址格式
      const invalidAddresses = targetAddresses.filter((addr: string) => !ethers.isAddress(addr))
      if (invalidAddresses.length > 0) {
        Logger.error(`无效的地址格式:`)
        invalidAddresses.forEach((addr: string) => Logger.error(`  ${addr}`))
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

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)

      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      // 过滤出需要归集的钱包（排除目标地址）
      const sourceWallets = new Map<string, ethers.Wallet>()
      const targetWallets = new Map<string, ethers.Wallet>()

      for (const [address, wallet] of allWallets) {
        if (targetAddresses.includes(address)) {
          targetWallets.set(address, wallet)
        } else {
          sourceWallets.set(address, wallet)
        }
      }

      Logger.info(`源钱包数量: ${sourceWallets.size}`)
      Logger.info(`目标钱包数量: ${targetWallets.size}`)

      if (targetWallets.size === 0) {
        Logger.error('目标地址中没有找到对应的钱包')
        return
      }

      // 创建Token合约实例
      const tokenContract = new ethers.Contract(
        tokenAddressReal,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function transfer(address to, uint256 amount) returns (bool)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
          'function name() view returns (string)',
        ],
        provider,
      )

      // 获取Token信息
      const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
      ])

      Logger.info(`Token信息: ${tokenName} (${tokenSymbol}), 精度: ${tokenDecimals}`)

      // 计算最小余额阈值（转换为bigint）
      const minBalanceThreshold = ethers.parseUnits(minBalanceNum.toString(), tokenDecimals)

      // 扫描所有源钱包的Token余额
      Logger.info('扫描所有钱包Token余额...')
      const balances = new Map<string, bigint>()
      let totalTokens = 0n
      let walletsWithTokens = 0

      const balancePromises = Array.from(sourceWallets.entries()).map(async ([address, _wallet]) => {
        try {
          const balance = await tokenContract.balanceOf(address)
          if (balance >= minBalanceThreshold) {
            balances.set(address, balance)
            totalTokens += balance
            walletsWithTokens++
            Logger.info(`  ${address}: ${formatTokenAmount(balance, tokenDecimals)} ${tokenSymbol}`)
          }
          return { address, balance }
        } catch (error) {
          Logger.error(`获取余额失败 ${address}:`, error)
          return { address, balance: 0n }
        }
      })

      await Promise.all(balancePromises)

      Logger.info(`发现 ${walletsWithTokens} 个钱包有足够Token需要归集`)
      Logger.info(`总Token数量: ${formatTokenAmount(totalTokens, tokenDecimals)} ${tokenSymbol}`)

      if (walletsWithTokens === 0) {
        Logger.info('没有钱包需要归集Token')
        return
      }

      // 获取Gas价格
      const gasPriceWei = gasPrice ? ethers.parseUnits(gasPrice, 'gwei') : (await coordinator.getGasPriceRecommendation(provider)).standard
      Logger.info(`使用Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)

      // 生成归集计划
      const consolidationPlans: ConsolidationPlan[] = []
      const gasLimit = 70000n // ERC20 transfer gas limit
      let targetIndex = 0

      for (const [address, balance] of balances) {
        const targetAddress = targetAddresses[targetIndex % targetAddresses.length]

        // 检查ETH余额是否足够支付gas费
        const ethBalance = await provider.getBalance(address)
        const requiredGasFee = gasLimit * gasPriceWei
        const needsGas = ethBalance < requiredGasFee

        let gasAmount: bigint | undefined
        if (needsGas) {
          const multiplier = parseFloat(fundingMultiplier)
          gasAmount = (requiredGasFee * BigInt(Math.ceil(multiplier * 100))) / 100n
        }

        consolidationPlans.push({
          from: address,
          to: targetAddress,
          amount: balance,
          formattedAmount: formatTokenAmount(balance, tokenDecimals),
          needsGas,
          gasAmount,
        })

        targetIndex++
      }

      Logger.info(`生成 ${consolidationPlans.length} 个归集计划`)

      // 显示归集计划预览
      Logger.info(`归集计划预览:`)
      consolidationPlans.forEach((plan, index) => {
        const gasInfo = plan.needsGas ? ` (需要Gas: ${ethers.formatEther(plan.gasAmount!)} ETH)` : ''
        Logger.info(
          `  ${index + 1}. ${plan.from.slice(0, 10)}... → ${plan.to.slice(0, 10)}... : ${plan.formattedAmount} ${tokenSymbol}${gasInfo}`,
        )
      })

      if (isDryRun) {
        Logger.info('试运行模式，不执行实际交易')
        return
      }

      // 获取资助钱包（用于gas费转账）
      let fundingWallet: ethers.Wallet | undefined = undefined
      if (autoFundGas === 'true') {
        if (!fundingSource) {
          Logger.error('未提供资助钱包地址或私钥，请设置环境变量 FUNDING_WALLET_ADDRESS')
          return
        }

        // 如果提供的是地址，尝试从已加载的钱包中查找
        const sourceLowerCase = fundingSource.toLowerCase()
        for (const [address, wallet] of allWallets) {
          if (address === sourceLowerCase) {
            fundingWallet = wallet
            break
          }
        }
      }
      if (!fundingWallet) {
        Logger.error(`未在配置的钱包中找到资助地址: ${fundingSource}`)
        return
      }

      const fundingBalance = await provider.getBalance(fundingWallet.address)
      Logger.info(`使用资助钱包: ${fundingWallet.address}`)
      Logger.info(`资助钱包ETH余额: ${ethers.formatEther(fundingBalance)} ETH`)

      // 初始化结果统计
      const results: ConsolidationResult = {
        success: 0,
        failed: 0,
        totalCollected: 0n,
        transactions: [],
      }

      const delayMinNum = parseInt(delayMin)
      const delayMaxNum = parseInt(delayMax)
      const fundingDelayNum = parseInt(fundingDelay)

      // 执行归集
      Logger.info('开始执行Token归集...')

      for (let i = 0; i < consolidationPlans.length; i++) {
        const plan = consolidationPlans[i]
        const sourceWallet = sourceWallets.get(plan.from)!

        Logger.info(`\n=== 执行第 ${i + 1}/${consolidationPlans.length} 个归集计划 ===`)
        Logger.info(`从 ${plan.from.slice(0, 10)}... 归集 ${plan.formattedAmount} ${tokenSymbol} 到 ${plan.to.slice(0, 10)}...`)

        try {
          // 1. 如果需要gas费，先转账ETH
          if (plan.needsGas) {
            if (!fundingWallet) {
              Logger.warn(`跳过 ${plan.from.slice(0, 10)}... 的归集，因为需要gas费但没有资助钱包`)
              results.failed++
              results.transactions.push({
                from: plan.from,
                to: plan.to,
                amount: plan.formattedAmount,
                error: '需要gas费但没有资助钱包',
                status: 'failed',
                type: 'token',
              })
              continue
            }

            Logger.info(`需要转账Gas费: ${ethers.formatEther(plan.gasAmount!)} ETH`)

            try {
              const fundingTx = await fundingWallet.sendTransaction({
                to: plan.from,
                value: plan.gasAmount!,
                gasPrice: gasPriceWei,
              })

              Logger.info(`Gas费转账已提交: ${fundingTx.hash}`)

              const fundingReceipt = await fundingTx.wait()
              if (fundingReceipt?.status === 1) {
                Logger.info(`✅ Gas费转账成功`)

                results.transactions.push({
                  from: fundingWallet.address,
                  to: plan.from,
                  amount: ethers.formatEther(plan.gasAmount!),
                  txHash: fundingTx.hash,
                  status: 'success',
                  type: 'gas',
                })

                // 等待余额更新
                Logger.info(`等待 ${fundingDelayNum}ms 确保余额更新...`)
                await new Promise(resolve => setTimeout(resolve, fundingDelayNum))
              } else {
                throw new Error('Gas费转账失败')
              }
            } catch (error) {
              Logger.error(`❌ Gas费转账失败:`, error)

              results.transactions.push({
                from: fundingWallet.address,
                to: plan.from,
                amount: ethers.formatEther(plan.gasAmount!),
                error: error instanceof Error ? error.message : String(error),
                status: 'failed',
                type: 'gas',
              })

              // 跳过这个归集计划
              results.failed++
              continue
            }
          }

          // 2. 执行Token转账
          const nonce = await provider.getTransactionCount(plan.from, 'pending')

          Logger.info(`执行Token转账... (nonce: ${nonce})`)

          const tx = await sourceWallet.sendTransaction({
            to: tokenAddressReal,
            data: tokenContract.interface.encodeFunctionData('transfer', [plan.to, plan.amount]),
            gasPrice: gasPriceWei,
            gasLimit: gasLimit,
            nonce: nonce,
          })

          Logger.info(`Token转账已提交: ${tx.hash}`)

          // 等待确认
          const receipt = await tx.wait()

          const transaction = {
            from: plan.from,
            to: plan.to,
            amount: plan.formattedAmount,
            txHash: tx.hash,
            status: receipt?.status === 1 ? ('success' as const) : ('failed' as const),
            error: undefined as string | undefined,
            type: 'token' as const,
          }

          if (receipt?.status === 1) {
            Logger.info(`✅ Token归集成功: ${tx.hash}`)
            results.success++
            results.totalCollected += plan.amount
          } else {
            Logger.error(`❌ Token归集失败: ${tx.hash}`)
            transaction.error = '交易执行失败'
            results.failed++
          }

          results.transactions.push(transaction)

          // 交易间延迟
          if (i < consolidationPlans.length - 1) {
            const delay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
            Logger.info(`等待 ${Math.round(delay)}ms 后执行下一个归集...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        } catch (error) {
          Logger.error(`❌ 归集失败:`, error)

          const transaction = {
            from: plan.from,
            to: plan.to,
            amount: plan.formattedAmount,
            error: error instanceof Error ? error.message : String(error),
            status: 'failed' as const,
            type: 'token' as const,
          }

          results.transactions.push(transaction)
          results.failed++

          // 即使失败也要延迟
          if (i < consolidationPlans.length - 1) {
            const delay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
            Logger.info(`失败后等待 ${Math.round(delay)}ms 再继续...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }

      Logger.info('\n=== Token自动归集完成 ===')
      Logger.info(`总计: ${results.success} 成功, ${results.failed} 失败`)
      Logger.info(`总归集Token数量: ${formatTokenAmount(results.totalCollected, tokenDecimals)} ${tokenSymbol}`)

      // 显示目标地址最终余额
      Logger.info('\n=== 目标地址最终余额 ===')
      for (const targetAddress of targetAddresses) {
        try {
          const finalBalance = await tokenContract.balanceOf(targetAddress)
          Logger.info(`${targetAddress}: ${formatTokenAmount(finalBalance, tokenDecimals)} ${tokenSymbol}`)
        } catch (error) {
          Logger.error(`获取 ${targetAddress} 最终余额失败:`, error)
        }
      }

      // 保存结果到文件
      const resultDir = join(configDir, 'consolidation-results')
      const resultFileName = createTimestampFilename('auto-consolidate-tokens')
      const resultPath = join(resultDir, resultFileName)

      if (!existsSync(resultDir)) {
        mkdirSync(resultDir, { recursive: true })
      }

      const resultData = {
        ...results,
        totalCollected: results.totalCollected.toString(),
        metadata: {
          timestamp: new Date().toISOString(),
          network: hre.network.name,
          tokenAddress: tokenAddressReal,
          tokenName,
          tokenSymbol,
          tokenDecimals: Number(tokenDecimals),
          targetAddresses,
          minBalanceThreshold: minBalanceNum,
          sourceWalletsScanned: sourceWallets.size,
          walletsWithTokens,
          gasPrice: ethers.formatUnits(gasPriceWei, 'gwei') + ' gwei',
          isDryRun,
        },
      }

      writeFileSync(resultPath, JSON.stringify(resultData, null, 2))
      Logger.info(`结果已保存到: ${resultPath}`)

      Logger.info('Token自动归集任务完成!')
    } catch (error) {
      Logger.error('Token自动归集任务失败:', error)
      throw error
    }
  })
