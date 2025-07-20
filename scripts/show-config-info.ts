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
