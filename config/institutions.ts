import { InstitutionNode } from '../types'

// 默认机构树配置
// 模拟真实的投资者分发树形结构
export const institutionTreeConfig: InstitutionNode[] = [
  {
    hdPath: "m/44'/60'/0'/0", // 主要机构A
    depth: 0,
    addressCount: 5,
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/0'/0", // A的子机构A1
        depth: 1,
        addressCount: 8,
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/0'/0", // A1的子机构A1a
            depth: 2,
            addressCount: 12,
            childNodes: [],
          },
          {
            hdPath: "m/44'/60'/0'/0'/0'/1", // A1的子机构A1b
            depth: 2,
            addressCount: 15,
            childNodes: [],
          },
        ],
      },
      {
        hdPath: "m/44'/60'/0'/0'/1", // A的子机构A2
        depth: 1,
        addressCount: 6,
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/0'/1'/0", // A2的子机构A2a
            depth: 2,
            addressCount: 20,
            childNodes: [],
          },
        ],
      },
    ],
  },
  {
    hdPath: "m/44'/60'/0'/1", // 主要机构B
    depth: 0,
    addressCount: 4,
    childNodes: [
      {
        hdPath: "m/44'/60'/0'/1'/0", // B的子机构B1
        depth: 1,
        addressCount: 10,
        childNodes: [
          {
            hdPath: "m/44'/60'/0'/1'/0'/0", // B1的子机构B1a
            depth: 2,
            addressCount: 18,
            childNodes: [],
          },
        ],
      },
      {
        hdPath: "m/44'/60'/0'/1'/1", // B的子机构B2
        depth: 1,
        addressCount: 7,
        childNodes: [],
      },
    ],
  },
  {
    hdPath: "m/44'/60'/0'/2", // 独立小机构C
    depth: 0,
    addressCount: 3,
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
