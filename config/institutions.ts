import { InstitutionGroup, InstitutionNode } from '../types'

// 大规模配置：200+个地址，3个主要机构，深度3层
// 层级分发机构树配置用于生产环境
// 配置结构：
// - 主要机构A (1地址) -> 子机构A1 (8地址) -> 子机构A1a (12地址) -> 子机构A1a1 (15地址, 最终用户)
//                                      -> 子机构A1a2 (18地址, 最终用户)
//                  -> 子机构A2 (10地址) -> 子机构A2a (14地址, 最终用户)
//                                       -> 子机构A2b (16地址, 最终用户)
// - 主要机构B (1地址) -> 子机构B1 (9地址) -> 子机构B1a (13地址, 最终用户)
//                                      -> 子机构B1b (17地址, 最终用户)
//                  -> 子机构B2 (11地址) -> 子机构B2a (19地址, 最终用户)
// - 主要机构C (1地址) -> 子机构C1 (12地址) -> 子机构C1a (20地址, 最终用户)
//                                       -> 子机构C1b (15地址, 最终用户)
// 总计: 230个地址，16个机构，3层深度，预计30分钟完成
export const institutionTreeConfig: InstitutionNode[] = [
  {
    hdPath: "m/44'/60'/0'/0", // 主要机构A
    depth: 0,
    addressCount: 1, // 1个分发地址 + 4个持有地址
    institutionName: '主要机构A',
    gasReceiveWindow: { start: 0, end: 2 }, // 0-2分钟
    tokenReceiveWindow: { start: 5, end: 8 }, // 5-8分钟
    retentionConfig: {
      percentage: 30, // 保留30%的token
      distributorAddressIndex: 0, // 第1个地址用于分发
      holderAddressIndices: [], // 其余地址用于持有
    },
    gasUsageConfig: {
      distributionGasAmount: '0.02', // 分发用gas
      tradingGasAmount: '0.008', // 交易用gas
      isEndUser: false,
    },
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/0'/0", // A的子机构A1
        depth: 1,
        addressCount: 8, // 1个分发地址 + 7个持有地址
        institutionName: '子机构A1',
        gasReceiveWindow: { start: 1, end: 3 }, // 1-3分钟
        tokenReceiveWindow: { start: 6, end: 9 }, // 6-9分钟
        retentionConfig: {
          percentage: 25,
          distributorAddressIndex: 0,
          holderAddressIndices: [1, 2, 3, 4, 5, 6, 7],
        },
        gasUsageConfig: {
          distributionGasAmount: '0.015',
          tradingGasAmount: '0.006',
          isEndUser: false,
        },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/0'/0", // A1的子机构A1a
            depth: 2,
            addressCount: 12,
            institutionName: '子机构A1a',
            gasReceiveWindow: { start: 2, end: 4 }, // 2-4分钟
            tokenReceiveWindow: { start: 7, end: 10 }, // 7-10分钟
            retentionConfig: {
              percentage: 40, // 保留40%，60%分发给子机构
              distributorAddressIndex: 0,
              holderAddressIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            },
            gasUsageConfig: {
              distributionGasAmount: '0.012',
              tradingGasAmount: '0.005',
              isEndUser: false,
            },
            childNodes: [
              {
                hdPath: "m/44'/60'/0'/0'/0'/0'/0", // A1a的子机构A1a1 (最终用户)
                depth: 3,
                addressCount: 15,
                institutionName: '子机构A1a1',
                gasReceiveWindow: { start: 3, end: 5 }, // 3-5分钟
                tokenReceiveWindow: { start: 8, end: 11 }, // 8-11分钟
                retentionConfig: {
                  percentage: 100, // 叶子节点保留全部token
                  distributorAddressIndex: -1, // 不需要分发
                  holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
                },
                gasUsageConfig: {
                  distributionGasAmount: '0',
                  tradingGasAmount: '0.01', // 最终用户需要更多交易gas
                  isEndUser: true,
                },
                childNodes: [],
              },
              {
                hdPath: "m/44'/60'/0'/0'/0'/0'/1", // A1a的子机构A1a2 (最终用户)
                depth: 3,
                addressCount: 18,
                institutionName: '子机构A1a2',
                gasReceiveWindow: { start: 3.5, end: 5.5 }, // 3.5-5.5分钟
                tokenReceiveWindow: { start: 8.5, end: 11.5 }, // 8.5-11.5分钟
                retentionConfig: {
                  percentage: 100,
                  distributorAddressIndex: -1,
                  holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
                },
                gasUsageConfig: {
                  distributionGasAmount: '0',
                  tradingGasAmount: '0.01',
                  isEndUser: true,
                },
                childNodes: [],
              },
            ],
          },
        ],
      },
      {
        hdPath: "m/44'/60'/0'/0'/1", // A的子机构A2
        depth: 1,
        addressCount: 10,
        institutionName: '子机构A2',
        gasReceiveWindow: { start: 1.5, end: 3.5 }, // 1.5-3.5分钟
        tokenReceiveWindow: { start: 6.5, end: 9.5 }, // 6.5-9.5分钟
        retentionConfig: {
          percentage: 30,
          distributorAddressIndex: 0,
          holderAddressIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        },
        gasUsageConfig: {
          distributionGasAmount: '0.015',
          tradingGasAmount: '0.006',
          isEndUser: false,
        },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/1'/0", // A2的子机构A2a (最终用户)
            depth: 2,
            addressCount: 14,
            institutionName: '子机构A2a',
            gasReceiveWindow: { start: 2.5, end: 4.5 }, // 2.5-4.5分钟
            tokenReceiveWindow: { start: 7.5, end: 10.5 }, // 7.5-10.5分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
          {
            hdPath: "m/44'/60'/0'/0'/1'/1", // A2的子机构A2b (最终用户)
            depth: 2,
            addressCount: 16,
            institutionName: '子机构A2b',
            gasReceiveWindow: { start: 3, end: 5 }, // 3-5分钟
            tokenReceiveWindow: { start: 8, end: 11 }, // 8-11分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
        ],
      },
    ],
  },
  {
    hdPath: "m/44'/60'/0'/1", // 主要机构B
    depth: 0,
    addressCount: 1,
    institutionName: '主要机构B',
    gasReceiveWindow: { start: 0.5, end: 2.5 }, // 0.5-2.5分钟
    tokenReceiveWindow: { start: 5.5, end: 8.5 }, // 5.5-8.5分钟
    retentionConfig: {
      percentage: 25, // 保留25%的token
      distributorAddressIndex: 0,
      holderAddressIndices: [],
    },
    gasUsageConfig: {
      distributionGasAmount: '0.02',
      tradingGasAmount: '0.008',
      isEndUser: false,
    },
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/1'/0", // B的子机构B1
        depth: 1,
        addressCount: 9,
        institutionName: '子机构B1',
        gasReceiveWindow: { start: 1.2, end: 3.2 }, // 1.2-3.2分钟
        tokenReceiveWindow: { start: 6.2, end: 9.2 }, // 6.2-9.2分钟
        retentionConfig: {
          percentage: 30,
          distributorAddressIndex: 0,
          holderAddressIndices: [1, 2, 3, 4, 5, 6, 7, 8],
        },
        gasUsageConfig: {
          distributionGasAmount: '0.015',
          tradingGasAmount: '0.006',
          isEndUser: false,
        },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/1'/0'/0", // B1的子机构B1a (最终用户)
            depth: 2,
            addressCount: 13,
            institutionName: '子机构B1a',
            gasReceiveWindow: { start: 2.2, end: 4.2 }, // 2.2-4.2分钟
            tokenReceiveWindow: { start: 7.2, end: 10.2 }, // 7.2-10.2分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
          {
            hdPath: "m/44'/60'/0'/1'/0'/1", // B1的子机构B1b (最终用户)
            depth: 2,
            addressCount: 17,
            institutionName: '子机构B1b',
            gasReceiveWindow: { start: 2.7, end: 4.7 }, // 2.7-4.7分钟
            tokenReceiveWindow: { start: 7.7, end: 10.7 }, // 7.7-10.7分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
        ],
      },
      {
        hdPath: "m/44'/60'/0'/1'/1", // B的子机构B2
        depth: 1,
        addressCount: 11,
        institutionName: '子机构B2',
        gasReceiveWindow: { start: 1.8, end: 3.8 }, // 1.8-3.8分钟
        tokenReceiveWindow: { start: 6.8, end: 9.8 }, // 6.8-9.8分钟
        retentionConfig: {
          percentage: 40,
          distributorAddressIndex: 0,
          holderAddressIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        },
        gasUsageConfig: {
          distributionGasAmount: '0.015',
          tradingGasAmount: '0.006',
          isEndUser: false,
        },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/1'/1'/0", // B2的子机构B2a (最终用户)
            depth: 2,
            addressCount: 19,
            institutionName: '子机构B2a',
            gasReceiveWindow: { start: 2.8, end: 4.8 }, // 2.8-4.8分钟
            tokenReceiveWindow: { start: 7.8, end: 10.8 }, // 7.8-10.8分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
        ],
      },
    ],
  },
  {
    hdPath: "m/44'/60'/0'/2", // 主要机构C
    depth: 0,
    addressCount: 1,
    institutionName: '主要机构C',
    gasReceiveWindow: { start: 1, end: 3 }, // 1-3分钟
    tokenReceiveWindow: { start: 6, end: 9 }, // 6-9分钟
    retentionConfig: {
      percentage: 35, // 保留35%的token
      distributorAddressIndex: 0,
      holderAddressIndices: [],
    },
    gasUsageConfig: {
      distributionGasAmount: '0.02',
      tradingGasAmount: '0.008',
      isEndUser: false,
    },
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/2'/0", // C的子机构C1
        depth: 1,
        addressCount: 12,
        institutionName: '子机构C1',
        gasReceiveWindow: { start: 2, end: 4 }, // 2-4分钟
        tokenReceiveWindow: { start: 7, end: 10 }, // 7-10分钟
        retentionConfig: {
          percentage: 20,
          distributorAddressIndex: 0,
          holderAddressIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        },
        gasUsageConfig: {
          distributionGasAmount: '0.015',
          tradingGasAmount: '0.006',
          isEndUser: false,
        },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/2'/0'/0", // C1的子机构C1a (最终用户)
            depth: 2,
            addressCount: 20,
            institutionName: '子机构C1a',
            gasReceiveWindow: { start: 3, end: 5 }, // 3-5分钟
            tokenReceiveWindow: { start: 8, end: 11 }, // 8-11分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
          {
            hdPath: "m/44'/60'/0'/2'/0'/1", // C1的子机构C1b (最终用户)
            depth: 2,
            addressCount: 15,
            institutionName: '子机构C1b',
            gasReceiveWindow: { start: 3.5, end: 5.5 }, // 3.5-5.5分钟
            tokenReceiveWindow: { start: 8.5, end: 11.5 }, // 8.5-11.5分钟
            retentionConfig: {
              percentage: 100,
              distributorAddressIndex: -1,
              holderAddressIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
            },
            gasUsageConfig: {
              distributionGasAmount: '0',
              tradingGasAmount: '0.01',
              isEndUser: true,
            },
            childNodes: [],
          },
        ],
      },
    ],
  },
]

// 获取所有叶子节点（最终接收Token的地址）
export function getAllLeafNodes(nodes: InstitutionNode[]): InstitutionNode[] {
  const leafNodes: InstitutionNode[] = []

  function traverse(node: InstitutionNode) {
    if (node.childNodes.length === 0) {
      leafNodes.push(node)
    } else {
      node.childNodes.forEach(traverse)
    }
  }

  nodes.forEach(traverse)
  return leafNodes
}

// 获取所有节点（用于Gas分发）
export function getAllNodes(nodes: InstitutionNode[]): InstitutionNode[] {
  const allNodes: InstitutionNode[] = []

  function traverse(node: InstitutionNode) {
    allNodes.push(node)
    node.childNodes.forEach(traverse)
  }

  nodes.forEach(traverse)
  return allNodes
}

// 获取按深度分组的节点
export function getNodesByDepth(nodes: InstitutionNode[]): Map<number, InstitutionNode[]> {
  const depthMap = new Map<number, InstitutionNode[]>()

  function traverse(node: InstitutionNode, currentDepth: number = 0) {
    // 使用计算的深度而不是节点的depth属性，确保准确性
    if (!depthMap.has(currentDepth)) {
      depthMap.set(currentDepth, [])
    }
    depthMap.get(currentDepth)!.push(node)

    // 验证节点的depth属性是否与计算的深度一致
    if (node.depth !== currentDepth) {
      console.warn(
        `Warning: Node ${node.institutionName} has depth=${node.depth} but calculated depth=${currentDepth}. Using calculated depth.`,
      )
    }

    // 递归处理子节点，深度+1
    node.childNodes.forEach(child => traverse(child, currentDepth + 1))
  }

  nodes.forEach(node => traverse(node, 0))
  return depthMap
}

// 计算节点应该接收的token数量
export function calculateDistributionAmounts(
  nodes: InstitutionNode[],
  totalTokens: bigint,
): Map<string, { receive: bigint; retain: bigint; distribute: bigint }> {
  const amountMap = new Map<string, { receive: bigint; retain: bigint; distribute: bigint }>()

  function calculateForNode(node: InstitutionNode, receivedAmount: bigint) {
    const retainPercentage = node.retentionConfig?.percentage || 100
    const retainAmount = (receivedAmount * BigInt(retainPercentage)) / 100n
    const distributeAmount = receivedAmount - retainAmount

    amountMap.set(node.hdPath, {
      receive: receivedAmount,
      retain: retainAmount,
      distribute: distributeAmount,
    })

    // 如果有子节点，计算子节点应该接收的数量
    if (node.childNodes.length > 0 && distributeAmount > 0) {
      const totalChildWeight = node.childNodes.reduce((sum, child) => sum + (child.addressCount || 1), 0)

      node.childNodes.forEach(child => {
        const childWeight = child.addressCount || 1
        const childReceiveAmount = (distributeAmount * BigInt(childWeight)) / BigInt(totalChildWeight)
        calculateForNode(child, childReceiveAmount)
      })
    }
  }

  // 为根节点计算（它们接收全部token）
  const totalRootWeight = nodes.reduce((sum, node) => sum + (node.addressCount || 1), 0)
  nodes.forEach(rootNode => {
    const rootWeight = rootNode.addressCount || 1
    const rootReceiveAmount = (totalTokens * BigInt(rootWeight)) / BigInt(totalRootWeight)
    calculateForNode(rootNode, rootReceiveAmount)
  })

  return amountMap
}

// 获取分发者地址（用于向子机构分发的地址）
export function getDistributorAddresses(nodes: InstitutionNode[]): Map<string, string> {
  const distributorMap = new Map<string, string>()

  function traverse(node: InstitutionNode) {
    if (node.addresses && node.retentionConfig && node.retentionConfig.distributorAddressIndex >= 0) {
      const distributorAddress = node.addresses[node.retentionConfig.distributorAddressIndex]
      if (distributorAddress) {
        distributorMap.set(node.hdPath, distributorAddress)
      }
    }

    node.childNodes.forEach(traverse)
  }

  nodes.forEach(traverse)
  return distributorMap
}

// 获取持有者地址（用于持有token的地址）
export function getHolderAddresses(nodes: InstitutionNode[]): Map<string, string[]> {
  const holderMap = new Map<string, string[]>()

  function traverse(node: InstitutionNode) {
    if (node.addresses && node.retentionConfig) {
      const holderAddresses = node.retentionConfig.holderAddressIndices.map(index => node.addresses![index]).filter(addr => addr) // 过滤undefined

      if (holderAddresses.length > 0) {
        holderMap.set(node.hdPath, holderAddresses)
      }
    }

    node.childNodes.forEach(traverse)
  }

  nodes.forEach(traverse)
  return holderMap
}

// 获取需要分发gas的机构地址（区分用途）
export function getGasDistributionTargets(nodes: InstitutionNode[]): {
  distributionGas: Array<{ address: string; amount: string; institutionName: string }>
  tradingGas: Array<{ address: string; amount: string; institutionName: string }>
} {
  const distributionTargets: Array<{ address: string; amount: string; institutionName: string }> = []
  const tradingTargets: Array<{ address: string; amount: string; institutionName: string }> = []

  function traverse(node: InstitutionNode) {
    if (node.addresses && node.gasUsageConfig) {
      const config = node.gasUsageConfig
      const institutionName = node.institutionName || node.hdPath

      // 分发gas：给分发者地址
      if (
        config.distributionGasAmount !== '0' &&
        node.retentionConfig?.distributorAddressIndex !== undefined &&
        node.retentionConfig.distributorAddressIndex >= 0
      ) {
        const distributorAddress = node.addresses[node.retentionConfig.distributorAddressIndex]
        if (distributorAddress) {
          distributionTargets.push({
            address: distributorAddress,
            amount: config.distributionGasAmount,
            institutionName,
          })
        }
      }

      // 交易gas：给所有地址（或持有者地址）
      if (config.tradingGasAmount !== '0') {
        const targetAddresses = config.isEndUser
          ? node.addresses
          : node.retentionConfig?.holderAddressIndices.map(i => node.addresses![i]) || node.addresses

        targetAddresses.forEach(addr => {
          if (addr) {
            tradingTargets.push({
              address: addr,
              amount: config.tradingGasAmount,
              institutionName,
            })
          }
        })
      }
    }

    node.childNodes.forEach(traverse)
  }

  nodes.forEach(traverse)
  return { distributionGas: distributionTargets, tradingGas: tradingTargets }
}

// 计算总地址数量
export function getTotalAddressCount(nodes: InstitutionNode[]): number {
  return getAllNodes(nodes).reduce((sum, node) => sum + node.addressCount, 0)
}

// 获取所有机构的分组信息
export function getInstitutionGroups(nodes: InstitutionNode[]): InstitutionGroup[] {
  const groups: InstitutionGroup[] = []

  function traverse(node: InstitutionNode) {
    if (node.addresses && node.addresses.length > 0) {
      groups.push({
        institutionName: node.institutionName || `Institution-${node.hdPath}`,
        hdPath: node.hdPath,
        addresses: [...node.addresses],
        gasReceiveWindow: node.gasReceiveWindow!,
        tokenReceiveWindow: node.tokenReceiveWindow!,
      })
    }

    node.childNodes.forEach(traverse)
  }

  nodes.forEach(traverse)
  return groups
}

// 获取按时间窗口排序的机构组
export function getInstitutionGroupsByTimeWindow(nodes: InstitutionNode[], type: 'gas' | 'token'): InstitutionGroup[] {
  const groups = getInstitutionGroups(nodes)

  return groups.sort((a, b) => {
    const windowA = type === 'gas' ? a.gasReceiveWindow : a.tokenReceiveWindow
    const windowB = type === 'gas' ? b.gasReceiveWindow : b.tokenReceiveWindow
    return windowA.start - windowB.start
  })
}

// 检查某个时间是否在机构的接收窗口内
export function isInReceiveWindow(node: InstitutionNode, relativeTimeMinutes: number, type: 'gas' | 'token'): boolean {
  const window = type === 'gas' ? node.gasReceiveWindow : node.tokenReceiveWindow
  if (!window) return true

  return relativeTimeMinutes >= window.start && relativeTimeMinutes <= window.end
}

// 为机构组生成时间分布的任务
export function generateInstitutionBasedTasks(
  groups: InstitutionGroup[],
  type: 'gas' | 'token',
  baseTime: number,
  generateAmount: () => bigint,
): { group: InstitutionGroup; address: string; scheduledTime: number; amount: string }[] {
  const tasks: { group: InstitutionGroup; address: string; scheduledTime: number; amount: string }[] = []

  for (const group of groups) {
    const window = type === 'gas' ? group.gasReceiveWindow : group.tokenReceiveWindow
    const windowDurationMs = (window.end - window.start) * 60 * 1000 // 转换为毫秒
    const windowStartTime = baseTime + window.start * 60 * 1000

    // 在时间窗口内为该机构的所有地址分配时间
    for (let i = 0; i < group.addresses.length; i++) {
      const address = group.addresses[i]

      // 在窗口内随机分布时间，但同一机构内相对集中
      const randomOffset = Math.random() * windowDurationMs * 0.8 // 使用80%的窗口时间
      const clusterOffset = i * ((windowDurationMs * 0.2) / group.addresses.length) // 20%时间用于集中分布

      const scheduledTime = windowStartTime + randomOffset + clusterOffset
      const amount = generateAmount()

      tasks.push({
        group,
        address,
        scheduledTime,
        amount: amount.toString(),
      })
    }
  }

  return tasks.sort((a, b) => a.scheduledTime - b.scheduledTime)
}

// 获取配置信息
export function getConfigInfo(config: InstitutionNode[]): {
  totalAddresses: number
  maxDepth: number
  estimatedDurationMinutes: number
  institutionCount: number
} {
  const totalAddresses = getTotalAddressCount(config)

  let maxDepth = 0
  let maxTokenTime = 0
  let institutionCount = 0

  function traverse(node: InstitutionNode) {
    maxDepth = Math.max(maxDepth, node.depth)
    institutionCount++

    if (node.tokenReceiveWindow) {
      maxTokenTime = Math.max(maxTokenTime, node.tokenReceiveWindow.end)
    }

    node.childNodes.forEach(traverse)
  }

  config.forEach(traverse)

  return {
    totalAddresses,
    maxDepth,
    estimatedDurationMinutes: Math.ceil(maxTokenTime + 1), // 加1分钟缓冲，大规模配置约12分钟
    institutionCount,
  }
}
