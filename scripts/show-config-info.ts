#!/usr/bin/env ts-node

import { getAllLeafNodes, getAllNodes, getConfigInfo, institutionTreeConfig } from '../config/institutions'
import { InstitutionNode } from '../types'

/**
 * 显示机构配置的详细信息
 * 包括总体统计、机构层级结构、时间窗口分析等
 */

function formatTimeWindow(window: { start: number; end: number } | undefined): string {
  if (!window) return '未设置'
  return `${window.start.toFixed(1)} - ${window.end.toFixed(1)} 分钟`
}

// Helper function for formatting depth (may be used in future enhancements)
// function formatDepth(depth: number): string {
//   return '  '.repeat(depth) + '└─ '
// }

function analyzeTimeWindows(nodes: InstitutionNode[], type: 'gas' | 'token') {
  const allNodes = getAllNodes(nodes)
  const windows = allNodes
    .map(node => (type === 'gas' ? node.gasReceiveWindow : node.tokenReceiveWindow))
    .filter(window => window !== undefined)

  if (windows.length === 0) return null

  const starts = windows.map(w => w!.start)
  const ends = windows.map(w => w!.end)

  return {
    earliest: Math.min(...starts),
    latest: Math.max(...ends),
    totalDuration: Math.max(...ends) - Math.min(...starts),
    windowCount: windows.length,
  }
}

interface GasLimitConfig {
  transferToken: {
    baseGas: number // 基础转账 gas
    erc20Logic: number // ERC20 transfer 逻辑 gas
    total: number // 总 gas limit
    estimatedCost: string // 预估费用 (ETH)
  }
  swapToken: {
    baseGas: number // 基础转账 gas
    swapLogic: number // swap 逻辑 gas
    total: number // 总 gas limit
    estimatedCost: string // 预估费用 (ETH)
  }
}

function calculateGasLimits(gasPriceGwei: number = 10): GasLimitConfig {
  const transferTokenGasLimit = 21000 + 50000 // 使用上限 50000
  const swapTokenGasLimit = 21000 + 200000

  const gasPriceWei = gasPriceGwei * 1e9 // 转换为 wei

  const transferCost = (transferTokenGasLimit * gasPriceWei) / 1e18
  const swapCost = (swapTokenGasLimit * gasPriceWei) / 1e18

  return {
    transferToken: {
      baseGas: 21000,
      erc20Logic: 50000,
      total: transferTokenGasLimit,
      estimatedCost: transferCost.toFixed(6),
    },
    swapToken: {
      baseGas: 21000,
      swapLogic: 200000,
      total: swapTokenGasLimit,
      estimatedCost: swapCost.toFixed(6),
    },
  }
}

function analyzeGasRequirements(nodes: InstitutionNode[]): {
  totalTransferOperations: number
  totalSwapOperations: number
  totalGasRequired: {
    transferGas: string // ETH
    swapGas: string // ETH
    total: string // ETH
  }
  gasLimitConfig: GasLimitConfig
  addressBreakdown: {
    distributorAddresses: number
    holderAddresses: number
    totalSwapAddresses: number
  }
  institutionGasFees: Array<{
    institutionName: string
    hdPath: string
    distributionGasFee: string // ETH
    tradingGasFee: string // ETH
    totalGasFee: string // ETH
    addressCount: number
    operations: {
      transferOperations: number
      swapOperations: number
    }
  }>
} {
  const allNodes = getAllNodes(nodes)

  // 计算转账操作数量（所有非叶子节点向子节点转账）
  let transferOperations = 0
  allNodes.forEach(node => {
    if (node.childNodes.length > 0) {
      // 非叶子节点需要向子节点转账
      transferOperations += node.childNodes.reduce((sum, child) => sum + child.addressCount, 0)
    }
  })

  // 计算所有需要进行swap操作的地址数量
  let totalSwapAddresses = 0
  let distributorCount = 0
  let holderCount = 0

  allNodes.forEach(node => {
    if (node.retentionConfig) {
      // 分发地址（需要进行token转账操作，但不一定swap）
      if (node.retentionConfig.distributorAddressIndex >= 0) {
        distributorCount++
      }

      // Holder addresses（持有token的地址，通常需要swap）
      holderCount += node.retentionConfig.holderAddressIndices.length

      // 根据gasUsageConfig判断哪些地址需要进行swap
      if (node.gasUsageConfig) {
        if (node.gasUsageConfig.isEndUser) {
          // 最终用户：所有地址都可能进行swap
          totalSwapAddresses += node.addressCount
        } else {
          // 非最终用户：只有holder addresses进行swap
          totalSwapAddresses += node.retentionConfig.holderAddressIndices.length
        }
      }
    }
  })

  const gasLimits = calculateGasLimits(10) // 使用 10 gwei gas price

  const totalTransferGas = transferOperations * parseFloat(gasLimits.transferToken.estimatedCost)
  const totalSwapGas = totalSwapAddresses * parseFloat(gasLimits.swapToken.estimatedCost)

  // 计算每个机构的 gas fee
  const institutionGasFees = allNodes.map(node => {
    const institutionName = node.institutionName || `Institution-${node.hdPath}`

    // 计算该机构的转账操作数量
    let nodeTransferOperations = 0
    if (node.childNodes.length > 0) {
      nodeTransferOperations = node.childNodes.reduce((sum, child) => sum + child.addressCount, 0)
    }

    // 计算该机构的swap操作数量
    let nodeSwapOperations = 0
    if (node.retentionConfig && node.gasUsageConfig) {
      if (node.gasUsageConfig.isEndUser) {
        // 最终用户：所有地址都可能进行swap
        nodeSwapOperations = node.addressCount
      } else {
        // 非最终用户：只有holder addresses进行swap
        nodeSwapOperations = node.retentionConfig.holderAddressIndices.length
      }
    }

    // 计算gas费用
    const distributionGasFee = nodeTransferOperations * parseFloat(gasLimits.transferToken.estimatedCost)
    const tradingGasFee = nodeSwapOperations * parseFloat(gasLimits.swapToken.estimatedCost)
    const totalGasFee = distributionGasFee + tradingGasFee

    return {
      institutionName,
      hdPath: node.hdPath,
      distributionGasFee: distributionGasFee.toFixed(6),
      tradingGasFee: tradingGasFee.toFixed(6),
      totalGasFee: totalGasFee.toFixed(6),
      addressCount: node.addressCount,
      operations: {
        transferOperations: nodeTransferOperations,
        swapOperations: nodeSwapOperations,
      },
    }
  })

  return {
    totalTransferOperations: transferOperations,
    totalSwapOperations: totalSwapAddresses,
    totalGasRequired: {
      transferGas: totalTransferGas.toFixed(6),
      swapGas: totalSwapGas.toFixed(6),
      total: (totalTransferGas + totalSwapGas).toFixed(6),
    },
    gasLimitConfig: gasLimits,
    addressBreakdown: {
      distributorAddresses: distributorCount,
      holderAddresses: holderCount,
      totalSwapAddresses,
    },
    institutionGasFees,
  }
}

function showInstitutionTree(nodes: InstitutionNode[], prefix = '') {
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1
    const currentPrefix = prefix + (isLast ? '└── ' : '├── ')
    const nextPrefix = prefix + (isLast ? '    ' : '│   ')

    console.log(`${currentPrefix}${node.institutionName} (${node.hdPath})`)
    console.log(`${nextPrefix}├─ 深度: ${node.depth}`)
    console.log(`${nextPrefix}├─ 地址数: ${node.addressCount}`)
    console.log(`${nextPrefix}├─ Gas窗口: ${formatTimeWindow(node.gasReceiveWindow)}`)
    console.log(`${nextPrefix}├─ Token窗口: ${formatTimeWindow(node.tokenReceiveWindow)}`)

    if (node.childNodes.length > 0) {
      console.log(`${nextPrefix}└─ 子机构:`)
      showInstitutionTree(node.childNodes, nextPrefix + '    ')
    } else {
      console.log(`${nextPrefix}└─ 叶子节点 (最终接收者)`)
    }

    if (index < nodes.length - 1) {
      console.log(`${prefix}│`)
    }
  })
}

function showDetailedAnalysis() {
  const config = institutionTreeConfig
  const configInfo = getConfigInfo(config)
  const allNodes = getAllNodes(config)
  const leafNodes = getAllLeafNodes(config)

  console.log('='.repeat(80))
  console.log('🏛️  机构配置详细信息')
  console.log('='.repeat(80))

  // 总体统计
  console.log('\n📊 总体统计:')
  console.log(`   总机构数量: ${configInfo.institutionCount}`)
  console.log(`   叶子机构数量: ${leafNodes.length}`)
  console.log(`   总地址数量: ${configInfo.totalAddresses}`)
  console.log(`   最大深度: ${configInfo.maxDepth}`)
  console.log(`   预估完成时间: ${configInfo.estimatedDurationMinutes} 分钟`)

  // 时间窗口分析
  const gasAnalysis = analyzeTimeWindows(config, 'gas')
  const tokenAnalysis = analyzeTimeWindows(config, 'token')

  console.log('\n⏱️  时间窗口分析:')
  if (gasAnalysis) {
    console.log(`   Gas分发期间: ${gasAnalysis.earliest.toFixed(1)} - ${gasAnalysis.latest.toFixed(1)} 分钟`)
    console.log(`   Gas分发总时长: ${gasAnalysis.totalDuration.toFixed(1)} 分钟`)
    console.log(`   参与Gas接收的机构: ${gasAnalysis.windowCount}`)
  }

  if (tokenAnalysis) {
    console.log(`   Token分发期间: ${tokenAnalysis.earliest.toFixed(1)} - ${tokenAnalysis.latest.toFixed(1)} 分钟`)
    console.log(`   Token分发总时长: ${tokenAnalysis.totalDuration.toFixed(1)} 分钟`)
    console.log(`   参与Token接收的机构: ${tokenAnalysis.windowCount}`)
  }

  // Gas 需求分析
  const gasRequirements = analyzeGasRequirements(config)
  console.log('\n⛽ Gas 需求分析:')
  console.log(`   Token转账操作数量: ${gasRequirements.totalTransferOperations}`)
  console.log(`   Token交换操作数量: ${gasRequirements.totalSwapOperations}`)
  console.log('\n   📊 地址分解:')
  console.log(`   分发地址 (Distributor): ${gasRequirements.addressBreakdown.distributorAddresses}`)
  console.log(`   持有地址 (Holder): ${gasRequirements.addressBreakdown.holderAddresses}`)
  console.log(`   需要Swap的地址总数: ${gasRequirements.addressBreakdown.totalSwapAddresses}`)

  console.log('\n   Gas Limit 配置:')
  console.log(`   📤 Token转账 Gas Limit: ${gasRequirements.gasLimitConfig.transferToken.total.toLocaleString()} gas`)
  console.log(`      - 基础转账: ${gasRequirements.gasLimitConfig.transferToken.baseGas.toLocaleString()} gas`)
  console.log(`      - ERC20逻辑: ${gasRequirements.gasLimitConfig.transferToken.erc20Logic.toLocaleString()} gas`)
  console.log(`      - 单次费用 (10 gwei): ${gasRequirements.gasLimitConfig.transferToken.estimatedCost} ETH`)

  console.log(`   🔄 Token交换 Gas Limit: ${gasRequirements.gasLimitConfig.swapToken.total.toLocaleString()} gas`)
  console.log(`      - 基础转账: ${gasRequirements.gasLimitConfig.swapToken.baseGas.toLocaleString()} gas`)
  console.log(`      - 交换逻辑: ${gasRequirements.gasLimitConfig.swapToken.swapLogic.toLocaleString()} gas`)
  console.log(`      - 单次费用 (10 gwei): ${gasRequirements.gasLimitConfig.swapToken.estimatedCost} ETH`)

  console.log('\n   💰 总 Gas 费用预估 (10 gwei):')
  console.log(`   所有转账操作: ${gasRequirements.totalGasRequired.transferGas} ETH`)
  console.log(`   所有交换操作: ${gasRequirements.totalGasRequired.swapGas} ETH`)
  console.log(`   📊 总计: ${gasRequirements.totalGasRequired.total} ETH`)

  // 每个机构的 Gas Fee 详情
  console.log('\n🏛️  各机构 Gas Fee 详情:')
  gasRequirements.institutionGasFees.forEach((institution, index) => {
    console.log(`   ${index + 1}. ${institution.institutionName}`)
    console.log(`      路径: ${institution.hdPath}`)
    console.log(`      地址数量: ${institution.addressCount}`)
    console.log(`      📤 分发操作: ${institution.operations.transferOperations} 次 → ${institution.distributionGasFee} ETH`)
    console.log(`      🔄 交易操作: ${institution.operations.swapOperations} 次 → ${institution.tradingGasFee} ETH`)
    console.log(`      💰 机构总费用: ${institution.totalGasFee} ETH`)
    if (index < gasRequirements.institutionGasFees.length - 1) {
      console.log('')
    }
  })

  // 机构 Gas Fee 汇总表
  console.log('\n📋 机构 Gas Fee 汇总表:')
  console.log('   ┌─────────────────────────────┬──────────┬──────────┬──────────┬──────────┐')
  console.log('   │         机构名称            │ 分发费用 │ 交易费用 │ 总费用   │ 占比(%)  │')
  console.log('   ├─────────────────────────────┼──────────┼──────────┼──────────┼──────────┤')

  const totalGasSum = gasRequirements.institutionGasFees.reduce((sum, inst) => sum + parseFloat(inst.totalGasFee), 0)

  gasRequirements.institutionGasFees.forEach(institution => {
    const percentage = totalGasSum > 0 ? ((parseFloat(institution.totalGasFee) / totalGasSum) * 100).toFixed(1) : '0.0'
    const nameDisplay =
      institution.institutionName.length > 25 ? institution.institutionName.substring(0, 22) + '...' : institution.institutionName

    console.log(
      `   │ ${nameDisplay.padEnd(27)} │ ${institution.distributionGasFee.padStart(8)} │ ${institution.tradingGasFee.padStart(8)} │ ${institution.totalGasFee.padStart(8)} │ ${percentage.padStart(7)}% │`,
    )
  })

  console.log('   ├─────────────────────────────┼──────────┼──────────┼──────────┼──────────┤')
  console.log(
    `   │ ${'总计'.padEnd(27)} │ ${gasRequirements.totalGasRequired.transferGas.padStart(8)} │ ${gasRequirements.totalGasRequired.swapGas.padStart(8)} │ ${gasRequirements.totalGasRequired.total.padStart(8)} │ ${' 100.0%'.padStart(9)} │`,
  )
  console.log('   └─────────────────────────────┴──────────┴──────────┴──────────┴──────────┘')

  // 按深度统计
  console.log('\n🌳 按深度统计:')
  const depthStats: { [depth: number]: { count: number; addresses: number } } = {}

  allNodes.forEach(node => {
    if (!depthStats[node.depth]) {
      depthStats[node.depth] = { count: 0, addresses: 0 }
    }
    depthStats[node.depth].count++
    depthStats[node.depth].addresses += node.addressCount
  })

  Object.keys(depthStats)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach(depth => {
      const stats = depthStats[depth]
      console.log(`   深度 ${depth}: ${stats.count} 个机构, ${stats.addresses} 个地址`)
    })

  // 叶子节点详情
  console.log('\n🍃 叶子节点 (最终Token接收者):')
  leafNodes.forEach((node, index) => {
    console.log(`   ${index + 1}. ${node.institutionName}`)
    console.log(`      路径: ${node.hdPath}`)
    console.log(`      地址数: ${node.addressCount}`)
    console.log(`      Token窗口: ${formatTimeWindow(node.tokenReceiveWindow)}`)
  })

  // 机构树结构
  console.log('\n🌲 机构层级结构:')
  showInstitutionTree(config)

  // 配置验证
  console.log('\n✅ 配置验证:')
  const issues: string[] = []

  // 未来可能需要的窗口数据（暂时注释掉未使用的变量）
  // const gasWindows = allNodes
  //   .filter(n => n.gasReceiveWindow)
  //   .map(n => ({ name: n.institutionName, window: n.gasReceiveWindow! }))

  // const tokenWindows = leafNodes
  //   .filter(n => n.tokenReceiveWindow)
  //   .map(n => ({ name: n.institutionName, window: n.tokenReceiveWindow! }))

  // 检查Gas窗口是否在Token窗口之前
  if (gasAnalysis && tokenAnalysis) {
    if (gasAnalysis.latest > tokenAnalysis.earliest) {
      issues.push('⚠️  Gas分发窗口与Token分发窗口存在重叠')
    }
  }

  // 检查HD路径格式
  allNodes.forEach(node => {
    if (!node.hdPath.match(/^m\/44'\/60'\/0'(\/\d+'?)*$/)) {
      issues.push(`⚠️  ${node.institutionName} 的HD路径格式可能不正确: ${node.hdPath}`)
    }
  })

  // 检查深度一致性
  allNodes.forEach(node => {
    const expectedDepth = node.hdPath.split('/').length - 5 // m/44'/60'/0'/0' 后的层级数
    if (node.depth !== expectedDepth) {
      issues.push(`⚠️  ${node.institutionName} 的深度标记不一致: 标记为${node.depth}, 应为${expectedDepth}`)
    }
  })

  if (issues.length === 0) {
    console.log('   ✅ 配置检查通过，未发现问题')
  } else {
    issues.forEach(issue => console.log(`   ${issue}`))
  }

  console.log('\n' + '='.repeat(80))
  console.log('分析完成!')
  console.log('='.repeat(80))
}

// 检查是否直接运行此脚本
if (require.main === module) {
  showDetailedAnalysis()
}

export { showDetailedAnalysis }
