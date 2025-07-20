import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { chunkArray, delay, determineWalletCategory, formatEther, loadAllWallets, Logger } from './utils'

// ERC20 Token ABI (只需要 balanceOf 方法)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]

// 创建时间戳文件名
function createTimestampFilename(prefix: string, extension: string = 'json'): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0] // YYYY-MM-DD
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-') // HH-MM-SS
  return `${prefix}-${date}_${time}.${extension}`
}

interface WalletBalance {
  address: string
  ethBalance: bigint
  tokenBalance: bigint
  category: string
}

interface BalanceSummary {
  totalWallets: number
  totalEthBalance: bigint
  totalTokenBalance: bigint
  categories: {
    [key: string]: {
      count: number
      ethBalance: bigint
      tokenBalance: bigint
    }
  }
}

task('wallet-balance', '统计所有钱包地址的ETH和Token余额')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('tokenAddress', 'Token合约地址 (如不指定则从配置读取)', '')
  .addOptionalParam('concurrency', '并发查询数量', '10')
  .addOptionalParam('delayMs', '批次间延迟(毫秒)', '100')
  .addFlag('detailed', '显示详细的每个地址余额 (默认已开启)')
  .addFlag('sortByEth', '按ETH余额排序 (默认按Token余额排序)')
  .addFlag('summaryOnly', '只显示汇总信息，不显示详细地址列表')
  .addFlag('onlyNonZero', '只显示非零余额的地址')
  .addFlag('noSave', '不保存结果到文件')
  .setAction(async (taskArgs, hre) => {
    const { configDir, tokenAddress, concurrency, delayMs, sortByEth, summaryOnly, onlyNonZero, noSave } = taskArgs

    try {
      Logger.info('开始统计钱包余额')
      Logger.info(`网络: ${hre.network.name}`)

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

      // 确定Token地址
      const finalTokenAddress = tokenAddress || config.tokenDistribution?.tokenAddress
      if (!finalTokenAddress) {
        Logger.error('未指定Token地址，请在参数中指定或确保配置文件中包含Token地址')
        return
      }

      // 验证Token地址
      if (!ethers.isAddress(finalTokenAddress)) {
        Logger.error(`无效的Token地址: ${finalTokenAddress}`)
        return
      }

      Logger.info(`Token合约地址: ${finalTokenAddress}`)

      // 获取Token信息
      const tokenContract = new ethers.Contract(finalTokenAddress, ERC20_ABI, provider)
      let tokenSymbol = 'TOKEN'
      let tokenDecimals = 18
      let tokenName = 'Unknown Token'

      try {
        tokenSymbol = await tokenContract.symbol()
        tokenDecimals = await tokenContract.decimals()
        tokenName = await tokenContract.name()
        Logger.info(`Token信息: ${tokenName} (${tokenSymbol}), ${tokenDecimals} decimals`)
      } catch {
        Logger.warn('无法获取Token信息，使用默认值')
      }

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)
      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      Logger.info(`并发查询配置: ${concurrency} 个并发，批次间延迟 ${delayMs}ms`)

      // 统计余额 - 使用并发查询
      Logger.info('开始统计余额...')
      const balances: WalletBalance[] = []
      const summary: BalanceSummary = {
        totalWallets: 0,
        totalEthBalance: 0n,
        totalTokenBalance: 0n,
        categories: {},
      }

      // 将钱包地址转换为数组并分批处理
      const walletArray = Array.from(allWallets.values())
      const batches = chunkArray(walletArray, parseInt(concurrency))

      let processedCount = 0
      const totalCount = walletArray.length

      Logger.info(`将 ${totalCount} 个地址分为 ${batches.length} 批处理`)

      // 处理每一批
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex]

        Logger.info(`处理第 ${batchIndex + 1}/${batches.length} 批 (${batch.length} 个地址)`)

        // 并发查询当前批次的所有地址
        const batchPromises = batch.map(async wallet => {
          try {
            // 并发获取ETH余额和Token余额
            const [ethBalance, tokenBalance] = await Promise.all([
              provider.getBalance(wallet.address),
              tokenContract.balanceOf(wallet.address).catch(() => 0n),
            ])

            // 确定钱包类别
            const category = determineWalletCategory(wallet.address, config)

            const walletBalance: WalletBalance = {
              address: wallet.address,
              ethBalance,
              tokenBalance,
              category,
            }

            // 应用过滤条件
            if (onlyNonZero && ethBalance === 0n && tokenBalance === 0n) {
              return null
            }

            return walletBalance
          } catch (error) {
            Logger.warn(`处理地址 ${wallet.address} 时出错:`, error)
            return null
          }
        })

        // 等待当前批次完成
        const batchResults = await Promise.all(batchPromises)

        // 处理结果并更新统计
        for (const result of batchResults) {
          if (result) {
            balances.push(result)

            // 更新统计
            summary.totalEthBalance += result.ethBalance
            summary.totalTokenBalance += result.tokenBalance
            summary.totalWallets++

            if (!summary.categories[result.category]) {
              summary.categories[result.category] = {
                count: 0,
                ethBalance: 0n,
                tokenBalance: 0n,
              }
            }

            summary.categories[result.category].count++
            summary.categories[result.category].ethBalance += result.ethBalance
            summary.categories[result.category].tokenBalance += result.tokenBalance
          }
        }

        processedCount += batch.length

        // 显示进度
        Logger.info(`进度: ${processedCount}/${totalCount} (${((processedCount / totalCount) * 100).toFixed(1)}%)`)

        // 批次间延迟，避免过快请求
        if (batchIndex < batches.length - 1) {
          await delay(parseInt(delayMs))
        }
      }

      // 排序 - 默认按Token余额降序排列
      if (sortByEth) {
        balances.sort((a, b) => (a.ethBalance > b.ethBalance ? -1 : 1))
        Logger.info('按ETH余额降序排序')
      } else {
        // 默认或明确指定按Token排序
        balances.sort((a, b) => (a.tokenBalance > b.tokenBalance ? -1 : 1))
        Logger.info('按Token余额降序排序')
      }

      // 显示汇总统计
      Logger.info('\n=== 余额汇总统计 ===')
      Logger.info(`总钱包数: ${summary.totalWallets}`)
      Logger.info(`总ETH余额: ${formatEther(summary.totalEthBalance)} ETH`)
      Logger.info(
        `总${tokenSymbol}余额: ${ethers.formatUnits(summary.totalTokenBalance, tokenDecimals)} ${tokenSymbol}`,
      )

      // 按类别显示统计
      Logger.info('\n=== 按类别统计 ===')
      for (const [category, categoryData] of Object.entries(summary.categories)) {
        Logger.info(`${category}:`)
        Logger.info(`  钱包数: ${categoryData.count}`)
        Logger.info(`  ETH余额: ${formatEther(categoryData.ethBalance)} ETH`)
        Logger.info(
          `  ${tokenSymbol}余额: ${ethers.formatUnits(categoryData.tokenBalance, tokenDecimals)} ${tokenSymbol}`,
        )
      }

      // 显示详细余额 - 默认显示，除非指定了 summaryOnly
      if (!summaryOnly && balances.length > 0) {
        Logger.info('\n=== 所有地址详细余额信息 (按Token余额降序) ===')

        balances.forEach((balance, index) => {
          const ethAmount = formatEther(balance.ethBalance)
          const tokenAmount = ethers.formatUnits(balance.tokenBalance, tokenDecimals)
          const indexStr = `${(index + 1).toString().padStart(3)}. `

          // 格式：序号. 地址 | ETH: 数量 | TOKEN: 数量 | 类别
          Logger.info(
            `${indexStr}${balance.address} | ETH: ${ethAmount.padStart(12)} | ${tokenSymbol}: ${tokenAmount.padStart(15)} | ${balance.category}`,
          )
        })

        Logger.info(`\n共显示 ${balances.length} 个地址`)
      }

      // 显示特殊统计
      Logger.info('\n=== 特殊统计 ===')
      const zeroEthWallets = balances.filter(b => b.ethBalance === 0n)
      const zeroTokenWallets = balances.filter(b => b.tokenBalance === 0n)
      const bothZeroWallets = balances.filter(b => b.ethBalance === 0n && b.tokenBalance === 0n)
      const bothNonZeroWallets = balances.filter(b => b.ethBalance > 0n && b.tokenBalance > 0n)

      Logger.info(`ETH余额为0的钱包: ${zeroEthWallets.length}`)
      Logger.info(`${tokenSymbol}余额为0的钱包: ${zeroTokenWallets.length}`)
      Logger.info(`ETH和${tokenSymbol}都为0的钱包: ${bothZeroWallets.length}`)
      Logger.info(`ETH和${tokenSymbol}都不为0的钱包: ${bothNonZeroWallets.length}`)

      // 计算平均值
      if (summary.totalWallets > 0) {
        const avgEth = summary.totalEthBalance / BigInt(summary.totalWallets)
        const avgToken = summary.totalTokenBalance / BigInt(summary.totalWallets)
        Logger.info(`平均ETH余额: ${formatEther(avgEth)} ETH`)
        Logger.info(`平均${tokenSymbol}余额: ${ethers.formatUnits(avgToken, tokenDecimals)} ${tokenSymbol}`)
      }

      Logger.info('\n余额统计完成!')

      // 保存结果到文件 (除非指定了 noSave)
      if (!noSave) {
        const resultDir = join(configDir, 'balance-results')
        const resultFileName = createTimestampFilename('balance-report')
        const resultFilePath = join(resultDir, resultFileName)

        try {
          // 确保目录存在
          if (!existsSync(resultDir)) {
            mkdirSync(resultDir, { recursive: true })
          }

          // 准备要保存的数据
          const resultData = {
            timestamp: new Date().toISOString(),
            network: hre.network.name,
            tokenInfo: {
              address: finalTokenAddress,
              name: tokenName,
              symbol: tokenSymbol,
              decimals: tokenDecimals,
            },
            summary: {
              totalWallets: summary.totalWallets,
              totalEthBalance: summary.totalEthBalance.toString(),
              totalTokenBalance: summary.totalTokenBalance.toString(),
              categories: Object.fromEntries(
                Object.entries(summary.categories).map(([key, value]) => [
                  key,
                  {
                    count: value.count,
                    ethBalance: value.ethBalance.toString(),
                    tokenBalance: value.tokenBalance.toString(),
                  },
                ]),
              ),
            },
            specialStats: {
              zeroEthWallets: balances.filter(b => b.ethBalance === 0n).length,
              zeroTokenWallets: balances.filter(b => b.tokenBalance === 0n).length,
              bothZeroWallets: balances.filter(b => b.ethBalance === 0n && b.tokenBalance === 0n).length,
              bothNonZeroWallets: balances.filter(b => b.ethBalance > 0n && b.tokenBalance > 0n).length,
            },
            averages:
              summary.totalWallets > 0
                ? {
                    avgEthBalance: (summary.totalEthBalance / BigInt(summary.totalWallets)).toString(),
                    avgTokenBalance: (summary.totalTokenBalance / BigInt(summary.totalWallets)).toString(),
                  }
                : null,
            detailedBalances: balances.map(balance => ({
              address: balance.address,
              ethBalance: balance.ethBalance.toString(),
              tokenBalance: balance.tokenBalance.toString(),
              category: balance.category,
              ethBalanceFormatted: formatEther(balance.ethBalance),
              tokenBalanceFormatted: ethers.formatUnits(balance.tokenBalance, tokenDecimals),
            })),
            queryConfig: {
              concurrency: parseInt(concurrency),
              delayMs: parseInt(delayMs),
              onlyNonZero,
              sortByEth,
              configDir,
              outputDir: resultDir,
            },
          }

          // 写入文件
          writeFileSync(
            resultFilePath,
            JSON.stringify(
              resultData,
              (key, value) => {
                // 自定义序列化函数处理BigInt
                return typeof value === 'bigint' ? value.toString() : value
              },
              2,
            ),
            'utf8',
          )
          Logger.info(`\n✅ 余额统计结果已保存到: ${resultFilePath}`)
          Logger.info(`📁 结果目录: ${resultDir}`)
          Logger.info(`📄 文件名: ${resultFileName}`)
        } catch (error) {
          Logger.warn('保存结果文件时出错:', error)
        }
      } else {
        Logger.info('\n⏩ 跳过保存结果文件 (指定了 --noSave 参数)')
      }
    } catch (error) {
      Logger.error('余额统计失败:', error)
      throw error
    }
  })
