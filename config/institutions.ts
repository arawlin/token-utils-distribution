import { InstitutionGroup, InstitutionNode } from '../types'

// 测试用机构树配置
// 总地址数约20个，最大深度3，5分钟内完成所有操作
export const institutionTreeConfig: InstitutionNode[] = [
  {
    hdPath: "m/44'/60'/0'/0", // 测试机构A
    depth: 0,
    addressCount: 1,
    institutionName: '测试机构A',
    gasReceiveWindow: { start: 0, end: 1 }, // 0-1分钟内接收gas
    tokenReceiveWindow: { start: 2.5, end: 3.5 }, // 2.5-3.5分钟内接收token
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/0'/0", // A的子机构A1
        depth: 1,
        addressCount: 2,
        institutionName: '测试子机构A1',
        gasReceiveWindow: { start: 0.2, end: 1.2 },
        tokenReceiveWindow: { start: 2.7, end: 3.7 },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/0'/0", // A1的子机构A1a
            depth: 2,
            addressCount: 4,
            institutionName: '测试子机构A1a',
            gasReceiveWindow: { start: 0.4, end: 1.4 },
            tokenReceiveWindow: { start: 2.9, end: 3.9 },
            childNodes: [
              {
                hdPath: "m/44'/60'/0'/0'/0'/0'/0", // A1a的子机构A1a1
                depth: 3,
                addressCount: 3,
                institutionName: '测试子机构A1a1',
                gasReceiveWindow: { start: 0.6, end: 1.6 },
                tokenReceiveWindow: { start: 3.1, end: 4.1 },
                childNodes: [],
              },
            ],
          },
          {
            hdPath: "m/44'/60'/0'/0'/0'/1", // A1的子机构A1b
            depth: 2,
            addressCount: 3,
            institutionName: '测试子机构A1b',
            gasReceiveWindow: { start: 0.8, end: 1.8 },
            tokenReceiveWindow: { start: 3.3, end: 4.3 },
            childNodes: [],
          },
        ],
      },
    ],
  },
  {
    hdPath: "m/44'/60'/0'/1", // 测试机构B
    depth: 0,
    addressCount: 1,
    institutionName: '测试机构B',
    gasReceiveWindow: { start: 1.5, end: 2.5 }, // 与机构A略有时间间隔
    tokenReceiveWindow: { start: 4, end: 5 },
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/1'/0", // B的子机构B1
        depth: 1,
        addressCount: 2,
        institutionName: '测试子机构B1',
        gasReceiveWindow: { start: 1.7, end: 2.7 },
        tokenReceiveWindow: { start: 4.2, end: 5.2 },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/1'/0'/0", // B1的子机构B1a
            depth: 2,
            addressCount: 4,
            institutionName: '测试子机构B1a',
            gasReceiveWindow: { start: 1.9, end: 2.9 },
            tokenReceiveWindow: { start: 4.4, end: 5.4 },
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
    estimatedDurationMinutes: Math.ceil(maxTokenTime + 0.5), // 加0.5分钟缓冲
    institutionCount,
  }
}
