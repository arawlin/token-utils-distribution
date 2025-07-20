// Type definitions for Token Distribution System

// HD Wallet 树结构
export interface InstitutionNode {
  hdPath: string // HD钱包路径
  depth: number // 树深度
  childNodes: InstitutionNode[] // 子机构
  addressCount: number // 该机构生成的地址数量
  addresses?: string[] // 生成的地址列表
  privateKeys?: string[] // 生成的私钥列表
  institutionName?: string // 机构名称
  gasReceiveWindow?: { start: number; end: number } // Gas费接收时间窗口(相对时间，分钟)
  tokenReceiveWindow?: { start: number; end: number } // Token接收时间窗口(相对时间，分钟)

  // 新增：层级分发配置
  retentionConfig?: {
    percentage: number // 该机构保留的token百分比（0-100）
    distributorAddressIndex: number // 用于分发的地址索引
    holderAddressIndices: number[] // 用于持有token的地址索引
  }

  // 新增：Gas用途配置
  gasUsageConfig?: {
    distributionGasAmount: string // 用于分发token的gas数量(ETH)
    tradingGasAmount: string // 用于交易的gas数量(ETH)
    isEndUser: boolean // 是否为最终用户（需要交易gas）
  }
}

// 按机构分组地址信息
export interface InstitutionGroup {
  institutionName: string
  hdPath: string
  addresses: string[]
  gasReceiveWindow: { start: number; end: number }
  tokenReceiveWindow: { start: number; end: number }
}

// Gas 分发配置
export interface GasDistributionConfig {
  exchangeSources: { address: string; privateKey: string }[] // 交易所热钱包
  intermediateWallets: { hdPath: string; count: number; wallets?: { address: string; privateKey: string }[] } // 中间HD钱包
  gasAmounts: { min: string; max: string } // 每个地址分配的Gas范围(ETH)
  gasPriceRandomization: { min: number; max: number } // Gas Price随机范围(gwei)
}

// Token 分发配置
export interface TokenDistributionConfig {
  tokenAddress: string
  sourceAddress: { address: string; privateKey: string }
  distributionPlan: {
    amounts: {
      mean: string // 正态分布均值
      stdDev: string // 正态分布标准差
    }
    timing: {
      lambda: number // 泊松过程参数(交易/小时)
    }
    safetyCheck: {
      initialSmallAmount: string // 初始小额测试数量
      waitBlocks: number // 小额测试后等待区块数
    }
  }
}

// 抗检测配置
export interface ObfuscationConfig {
  circularTransactions: {
    enabled: boolean
    percentage: number // 占正常交易的比例
    wallets: { hdPath: string; count: number } // 用于循环交易的HD钱包
  }
  randomTransfers: {
    enabled: boolean
    ethAmounts: { min: string; max: string } // 随机ETH转账数量
  }
}

// 分发任务状态
export interface DistributionTask {
  id: string
  type: 'gas' | 'token'
  subType?: 'distribution-gas' | 'trading-gas' | 'hierarchical-token' // 新增：任务子类型
  fromAddress: string
  toAddress: string
  amount: string
  scheduledTime: number
  status: 'pending' | 'executing' | 'completed' | 'failed'
  txHash?: string
  error?: string
  institutionGroup?: string // 所属机构组
  dependsOn?: string[] // 依赖的任务ID（如token转账依赖gas转账完成）
  hierarchyLevel?: number // 层级等级（用于token分发）
  retentionAmount?: string // 该机构保留的token数量
}

// 分发进度
export interface DistributionProgress {
  totalTasks: number
  completedTasks: number
  failedTasks: number
  currentPhase: string
  lastUpdateTime: number
}

// 完整配置
export interface DistributionSystemConfig {
  masterSeed: string
  institutionTree: InstitutionNode[]
  gasDistribution: GasDistributionConfig
  tokenDistribution: TokenDistributionConfig
  obfuscation: ObfuscationConfig
  dryRun: boolean
  networkName: string
}
