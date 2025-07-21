import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig, InstitutionNode } from '../types'
import {
  chunkArray,
  createTimestampFilename,
  delay,
  determineWalletCategory,
  formatEther,
  generateWalletFromPath,
  loadAllWallets,
  Logger,
} from './utils'

// ERC20 Token ABI (只需要 balanceOf 方法)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]

interface WalletBalance {
  address: string
  ethBalance: bigint
  tokenBalance: bigint
  category: string
  institutionPath?: string
  institutionName?: string
  depth?: number
}

interface HierarchicalBalance {
  institutionName: string
  hdPath: string
  depth: number
  totalEth: bigint
  totalToken: bigint
  wallets: WalletBalance[]
  children: HierarchicalBalance[]
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

// 构建层级余额结构
function buildHierarchicalBalance(
  institutionNodes: InstitutionNode[],
  allWallets: Map<string, { address: string; privateKey: string }>,
  balances: WalletBalance[],
  masterSeed?: string,
): HierarchicalBalance[] {
  const hierarchicalBalances: HierarchicalBalance[] = []

  function processNode(node: InstitutionNode, depth: number = 0): HierarchicalBalance {
    const nodeBalance: HierarchicalBalance = {
      institutionName: node.institutionName || `机构-${node.hdPath}`,
      hdPath: node.hdPath,
      depth,
      totalEth: 0n,
      totalToken: 0n,
      wallets: [],
      children: [],
    }

    // 查找属于这个机构的钱包地址
    // 1. 如果节点已经有addresses字段，直接使用
    if (node.addresses && node.addresses.length > 0) {
      for (const address of node.addresses) {
        const balance = balances.find(b => b.address.toLowerCase() === address.toLowerCase())
        if (balance) {
          nodeBalance.wallets.push({
            ...balance,
            institutionPath: node.hdPath,
            institutionName: node.institutionName,
            depth,
          })
          nodeBalance.totalEth += balance.ethBalance
          nodeBalance.totalToken += balance.tokenBalance
        }
      }
    } else {
      // 2. 如果没有addresses字段，通过HD路径和addressCount查找
      // 从allWallets中查找匹配该HD路径的钱包
      const nodeWallets: WalletBalance[] = []

      // 遍历所有钱包，查找属于当前机构的地址
      for (const [address] of allWallets) {
        // 检查这个地址是否在余额列表中
        const balance = balances.find(b => b.address.toLowerCase() === address.toLowerCase())
        if (balance) {
          // 通过HD路径匹配来确定是否属于当前机构
          // 这里我们需要一个更好的方式来匹配，暂时使用简单的启发式方法

          // 如果我们能确定钱包属于这个机构，就添加它
          // 注意：这需要更精确的实现，但作为临时解决方案
          if (shouldWalletBelongToNode(address, node, allWallets, balances, masterSeed)) {
            nodeWallets.push({
              ...balance,
              institutionPath: node.hdPath,
              institutionName: node.institutionName,
              depth,
            })
            nodeBalance.totalEth += balance.ethBalance
            nodeBalance.totalToken += balance.tokenBalance
          }
        }
      }

      // 按addressCount限制添加的钱包数量
      nodeBalance.wallets = nodeWallets.slice(0, node.addressCount)
    }

    // 递归处理子节点
    for (const child of node.childNodes) {
      const childBalance = processNode(child, depth + 1)
      nodeBalance.children.push(childBalance)
      nodeBalance.totalEth += childBalance.totalEth
      nodeBalance.totalToken += childBalance.totalToken
    }

    return nodeBalance
  }

  // 处理机构树节点
  for (const rootNode of institutionNodes) {
    hierarchicalBalances.push(processNode(rootNode))
  }

  // 添加其他类型的钱包作为单独的顶层节点
  const institutionWalletAddresses = new Set<string>()

  // 收集所有机构钱包地址
  function collectInstitutionAddresses(node: InstitutionNode) {
    if (node.addresses) {
      node.addresses.forEach(addr => institutionWalletAddresses.add(addr.toLowerCase()))
    }
    node.childNodes.forEach(collectInstitutionAddresses)
  }
  institutionNodes.forEach(collectInstitutionAddresses)

  // 按类别分组其他钱包
  const otherWalletsByCategory = new Map<string, WalletBalance[]>()

  for (const balance of balances) {
    const address = balance.address.toLowerCase()
    // 如果不是机构钱包，按类别分组
    if (!institutionWalletAddresses.has(address)) {
      const category = balance.category
      if (!otherWalletsByCategory.has(category)) {
        otherWalletsByCategory.set(category, [])
      }
      otherWalletsByCategory.get(category)!.push(balance)
    }
  }

  // 为每个类别创建顶层节点
  for (const [category, categoryWallets] of otherWalletsByCategory) {
    if (categoryWallets.length > 0) {
      const categoryNode: HierarchicalBalance = {
        institutionName: category,
        hdPath: `category-${category}`,
        depth: 0,
        totalEth: 0n,
        totalToken: 0n,
        wallets: categoryWallets.map(wallet => ({
          ...wallet,
          institutionPath: `category-${category}`,
          institutionName: category,
          depth: 0,
        })),
        children: [],
      }

      // 计算总余额
      for (const wallet of categoryWallets) {
        categoryNode.totalEth += wallet.ethBalance
        categoryNode.totalToken += wallet.tokenBalance
      }

      hierarchicalBalances.push(categoryNode)
    }
  }

  return hierarchicalBalances
}

// 判断钱包是否属于特定机构节点的辅助函数
function shouldWalletBelongToNode(
  address: string,
  node: InstitutionNode,
  allWallets: Map<string, { address: string; privateKey: string }>,
  balances: WalletBalance[],
  masterSeed?: string,
): boolean {
  // 方法1：通过HD路径生成地址来匹配
  if (masterSeed) {
    for (let i = 0; i < node.addressCount; i++) {
      try {
        const generatedWallet = generateWalletFromPath(masterSeed, node.hdPath, i)
        if (generatedWallet.address.toLowerCase() === address.toLowerCase()) {
          return true
        }
      } catch {
        // 忽略生成错误
      }
    }
  }

  // 方法2：通过余额记录中的category信息匹配
  const balance = balances.find(b => b.address.toLowerCase() === address.toLowerCase())
  if (balance && balance.category) {
    const institutionName = node.institutionName || ''
    if (
      balance.category.includes(institutionName) ||
      balance.category.includes(node.hdPath) ||
      balance.category.includes(`depth-${node.depth}`)
    ) {
      return true
    }
  }

  return false
}

// 按层级显示余额信息
function displayHierarchicalBalances(hierarchicalBalances: HierarchicalBalance[], tokenSymbol: string, tokenDecimals: number) {
  function displayNode(node: HierarchicalBalance, indent: string = '', isLast: boolean = true) {
    const prefix = indent + (isLast ? '└── ' : '├── ')
    const nextIndent = indent + (isLast ? '    ' : '│   ')

    // 显示机构信息
    console.log(`${prefix}${node.institutionName} (${node.hdPath}) [深度${node.depth}]`)
    console.log(
      `${nextIndent}机构汇总: ETH ${formatEther(node.totalEth)} | ${tokenSymbol} ${ethers.formatUnits(node.totalToken, tokenDecimals)}`,
    )

    // 显示该机构的钱包地址
    if (node.wallets.length > 0) {
      console.log(`${nextIndent}地址列表 (${node.wallets.length}个):`)
      node.wallets.forEach((wallet, walletIndex) => {
        const isLastWallet = walletIndex === node.wallets.length - 1 && node.children.length === 0
        const walletPrefix = nextIndent + (isLastWallet ? '└── ' : '├── ')
        console.log(
          `${walletPrefix}${wallet.address} | ETH: ${formatEther(wallet.ethBalance).padStart(12)} | ${tokenSymbol}: ${ethers.formatUnits(wallet.tokenBalance, tokenDecimals).padStart(15)}`,
        )
      })
    }

    // 递归显示子机构
    node.children.forEach((child, childIndex) => {
      const isLastChild = childIndex === node.children.length - 1
      displayNode(child, nextIndent, isLastChild)
    })
  }

  console.log('\n=== 层级余额结构 ===')
  hierarchicalBalances.forEach((rootNode, index) => {
    const isLast = index === hierarchicalBalances.length - 1
    displayNode(rootNode, '', isLast)
    if (!isLast) {
      console.log('')
    }
  })
}

// 生成层级格式的文本报告
function generateHierarchicalReport(
  hierarchicalBalances: HierarchicalBalance[],
  tokenSymbol: string,
  tokenDecimals: number,
  summary: BalanceSummary,
  balances: WalletBalance[],
  network: string,
  tokenInfo: { address: string; name: string; symbol: string; decimals: number },
): string {
  let report = ''

  // 添加报告头部信息
  report += '================================================================================\n'
  report += '钱包余额统计报告\n'
  report += '================================================================================\n\n'
  report += `生成时间: ${new Date().toISOString()}\n`
  report += `网络: ${network}\n`
  report += `Token信息: ${tokenInfo.name} (${tokenInfo.symbol}), ${tokenInfo.decimals} decimals\n`
  report += `Token地址: ${tokenInfo.address}\n\n`

  // 添加汇总统计
  report += '=== 余额汇总统计 ===\n'
  report += `总钱包数: ${summary.totalWallets}\n`
  report += `总ETH余额: ${formatEther(summary.totalEthBalance)} ETH\n`
  report += `总${tokenSymbol}余额: ${ethers.formatUnits(summary.totalTokenBalance, tokenDecimals)} ${tokenSymbol}\n\n`

  // 添加按类别统计
  report += '=== 按类别统计 ===\n'
  for (const [category, categoryData] of Object.entries(summary.categories)) {
    report += `${category}:\n`
    report += `  钱包数: ${categoryData.count}\n`
    report += `  ETH余额: ${formatEther(categoryData.ethBalance)} ETH\n`
    report += `  ${tokenSymbol}余额: ${ethers.formatUnits(categoryData.tokenBalance, tokenDecimals)} ${tokenSymbol}\n`
  }
  report += '\n'

  // 添加层级余额结构
  function addNodeToReport(node: HierarchicalBalance, indent: string = '', isLast: boolean = true): void {
    const prefix = indent + (isLast ? '└── ' : '├── ')
    const nextIndent = indent + (isLast ? '    ' : '│   ')

    // 添加机构信息
    report += `${prefix}${node.institutionName} (${node.hdPath}) [深度${node.depth}]\n`
    report += `${nextIndent}机构汇总: ETH ${formatEther(node.totalEth)} | ${tokenSymbol} ${ethers.formatUnits(node.totalToken, tokenDecimals)}\n`

    // 添加该机构的钱包地址
    if (node.wallets.length > 0) {
      report += `${nextIndent}地址列表 (${node.wallets.length}个):\n`
      node.wallets.forEach((wallet, walletIndex) => {
        const isLastWallet = walletIndex === node.wallets.length - 1 && node.children.length === 0
        const walletPrefix = nextIndent + (isLastWallet ? '└── ' : '├── ')
        report += `${walletPrefix}${wallet.address} | ETH: ${formatEther(wallet.ethBalance).padStart(12)} | ${tokenSymbol}: ${ethers.formatUnits(wallet.tokenBalance, tokenDecimals).padStart(15)}\n`
      })
    }

    // 递归添加子机构
    node.children.forEach((child, childIndex) => {
      const isLastChild = childIndex === node.children.length - 1
      addNodeToReport(child, nextIndent, isLastChild)
    })
  }

  report += '=== 层级余额结构 ===\n'
  hierarchicalBalances.forEach((rootNode, index) => {
    const isLast = index === hierarchicalBalances.length - 1
    addNodeToReport(rootNode, '', isLast)
    if (!isLast) {
      report += '\n'
    }
  })

  // 添加特殊统计
  const zeroEthWallets = balances.filter(b => b.ethBalance === 0n)
  const zeroTokenWallets = balances.filter(b => b.tokenBalance === 0n)
  const bothZeroWallets = balances.filter(b => b.ethBalance === 0n && b.tokenBalance === 0n)
  const bothNonZeroWallets = balances.filter(b => b.ethBalance > 0n && b.tokenBalance > 0n)

  report += '\n=== 特殊统计 ===\n'
  report += `ETH余额为0的钱包: ${zeroEthWallets.length}\n`
  report += `${tokenSymbol}余额为0的钱包: ${zeroTokenWallets.length}\n`
  report += `ETH和${tokenSymbol}都为0的钱包: ${bothZeroWallets.length}\n`
  report += `ETH和${tokenSymbol}都不为0的钱包: ${bothNonZeroWallets.length}\n`

  // 添加平均值
  if (summary.totalWallets > 0) {
    const avgEth = summary.totalEthBalance / BigInt(summary.totalWallets)
    const avgToken = summary.totalTokenBalance / BigInt(summary.totalWallets)
    report += `平均ETH余额: ${formatEther(avgEth)} ETH\n`
    report += `平均${tokenSymbol}余额: ${ethers.formatUnits(avgToken, tokenDecimals)} ${tokenSymbol}\n`
  }

  report += '\n共显示 ' + balances.length + ' 个地址\n\n'
  report += '================================================================================\n'
  report += '报告结束\n'
  report += '================================================================================\n'

  return report
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
      console.log('\n=== 余额汇总统计 ===')
      console.log(`总钱包数: ${summary.totalWallets}`)
      console.log(`总ETH余额: ${formatEther(summary.totalEthBalance)} ETH`)
      console.log(`总${tokenSymbol}余额: ${ethers.formatUnits(summary.totalTokenBalance, tokenDecimals)} ${tokenSymbol}`)

      // 按类别显示统计
      console.log('\n=== 按类别统计 ===')
      for (const [category, categoryData] of Object.entries(summary.categories)) {
        console.log(`${category}:`)
        console.log(`  钱包数: ${categoryData.count}`)
        console.log(`  ETH余额: ${formatEther(categoryData.ethBalance)} ETH`)
        console.log(`  ${tokenSymbol}余额: ${ethers.formatUnits(categoryData.tokenBalance, tokenDecimals)} ${tokenSymbol}`)
      }

      // 显示详细余额 - 使用层级结构显示
      if (!summaryOnly && balances.length > 0) {
        // 构建层级余额结构
        const hierarchicalBalances = buildHierarchicalBalance(config.institutionTree, allWallets, balances, masterSeed)

        // 使用层级显示
        displayHierarchicalBalances(hierarchicalBalances, tokenSymbol, tokenDecimals)

        console.log(`\n共显示 ${balances.length} 个地址`)
      }

      // 显示特殊统计
      console.log('\n=== 特殊统计 ===')
      const zeroEthWallets = balances.filter(b => b.ethBalance === 0n)
      const zeroTokenWallets = balances.filter(b => b.tokenBalance === 0n)
      const bothZeroWallets = balances.filter(b => b.ethBalance === 0n && b.tokenBalance === 0n)
      const bothNonZeroWallets = balances.filter(b => b.ethBalance > 0n && b.tokenBalance > 0n)

      console.log(`ETH余额为0的钱包: ${zeroEthWallets.length}`)
      console.log(`${tokenSymbol}余额为0的钱包: ${zeroTokenWallets.length}`)
      console.log(`ETH和${tokenSymbol}都为0的钱包: ${bothZeroWallets.length}`)
      console.log(`ETH和${tokenSymbol}都不为0的钱包: ${bothNonZeroWallets.length}`)

      // 计算平均值
      if (summary.totalWallets > 0) {
        const avgEth = summary.totalEthBalance / BigInt(summary.totalWallets)
        const avgToken = summary.totalTokenBalance / BigInt(summary.totalWallets)
        console.log(`平均ETH余额: ${formatEther(avgEth)} ETH`)
        console.log(`平均${tokenSymbol}余额: ${ethers.formatUnits(avgToken, tokenDecimals)} ${tokenSymbol}`)
      }

      Logger.info('\n余额统计完成!')

      // 保存结果到文件 (除非指定了 noSave)
      if (!noSave) {
        const resultDir = join(configDir, 'balance-results')
        const resultFileName = createTimestampFilename('balance-report', '.txt') // 改为.txt格式
        const resultFilePath = join(resultDir, resultFileName)

        try {
          // 确保目录存在
          if (!existsSync(resultDir)) {
            mkdirSync(resultDir, { recursive: true })
          }

          // 构建层级余额结构（用于生成报告）
          const hierarchicalBalances = buildHierarchicalBalance(config.institutionTree, allWallets, balances, masterSeed)

          // 生成层级格式的文本报告
          const reportContent = generateHierarchicalReport(
            hierarchicalBalances,
            tokenSymbol,
            tokenDecimals,
            summary,
            balances,
            hre.network.name,
            {
              address: finalTokenAddress,
              name: tokenName,
              symbol: tokenSymbol,
              decimals: tokenDecimals,
            },
          )

          // 写入文本文件
          writeFileSync(resultFilePath, reportContent, 'utf8')

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
