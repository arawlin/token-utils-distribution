import { InstitutionGroup, InstitutionNode } from '../types'

// 默认机构树配置
// 模拟真实的投资者分发树形结构
export const institutionTreeConfig: InstitutionNode[] = [
  {
    hdPath: "m/44'/60'/0'/0", // 主要机构A
    depth: 0,
    addressCount: 1,
    institutionName: '主要机构A',
    gasReceiveWindow: { start: 0, end: 30 }, // 0-30分钟内接收gas
    tokenReceiveWindow: { start: 45, end: 75 }, // 45-75分钟内接收token
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/0'/0", // A的子机构A1
        depth: 1,
        addressCount: 4,
        institutionName: '子机构A1',
        gasReceiveWindow: { start: 5, end: 35 }, // 与父机构略有重叠
        tokenReceiveWindow: { start: 50, end: 80 },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/0'/0", // A1的子机构A1a
            depth: 2,
            addressCount: 12,
            institutionName: '子机构A1a',
            gasReceiveWindow: { start: 10, end: 40 },
            tokenReceiveWindow: { start: 55, end: 85 },
            childNodes: [],
          },
          {
            hdPath: "m/44'/60'/0'/0'/0'/1", // A1的子机构A1b
            depth: 2,
            addressCount: 15,
            institutionName: '子机构A1b',
            gasReceiveWindow: { start: 15, end: 45 },
            tokenReceiveWindow: { start: 60, end: 90 },
            childNodes: [],
          },
        ],
      },
      {
        hdPath: "m/44'/60'/0'/0'/1", // A的子机构A2
        depth: 1,
        addressCount: 6,
        institutionName: '子机构A2',
        gasReceiveWindow: { start: 20, end: 50 },
        tokenReceiveWindow: { start: 65, end: 95 },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/1'/0", // A2的子机构A2a
            depth: 2,
            addressCount: 7,
            institutionName: '子机构A2a',
            gasReceiveWindow: { start: 25, end: 55 },
            tokenReceiveWindow: { start: 70, end: 100 },
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
    gasReceiveWindow: { start: 90, end: 120 }, // 与机构A有较大时间间隔
    tokenReceiveWindow: { start: 135, end: 165 },
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/1'/0", // B的子机构B1
        depth: 1,
        addressCount: 7,
        institutionName: '子机构B1',
        gasReceiveWindow: { start: 95, end: 125 },
        tokenReceiveWindow: { start: 140, end: 170 },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/1'/0'/0", // B1的子机构B1a
            depth: 2,
            addressCount: 18,
            institutionName: '子机构B1a',
            gasReceiveWindow: { start: 100, end: 130 },
            tokenReceiveWindow: { start: 145, end: 175 },
            childNodes: [],
          },
        ],
      },
      {
        hdPath: "m/44'/60'/0'/1'/1", // B的子机构B2
        depth: 1,
        addressCount: 1,
        institutionName: '子机构B2',
        gasReceiveWindow: { start: 105, end: 135 },
        tokenReceiveWindow: { start: 150, end: 180 },
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/1'/1'/0", // B1的子机构B2a
            depth: 2,
            addressCount: 5,
            institutionName: '子机构B2a',
            gasReceiveWindow: { start: 110, end: 140 },
            tokenReceiveWindow: { start: 155, end: 185 },
            childNodes: [
              {
                hdPath: "m/44'/60'/0'/1'/1'/0'/0", // B1的子机构B2a1
                depth: 3,
                addressCount: 10,
                institutionName: '子机构B2a1',
                gasReceiveWindow: { start: 115, end: 145 },
                tokenReceiveWindow: { start: 160, end: 190 },
                childNodes: [],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    hdPath: "m/44'/60'/0'/2", // 独立小机构C
    depth: 0,
    addressCount: 2,
    institutionName: '独立小机构C',
    gasReceiveWindow: { start: 200, end: 230 }, // 独立时间窗口
    tokenReceiveWindow: { start: 245, end: 275 },
    childNodes: [],
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
        gasReceiveWindow: node.gasReceiveWindow || { start: 0, end: 30 },
        tokenReceiveWindow: node.tokenReceiveWindow || { start: 60, end: 90 },
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
