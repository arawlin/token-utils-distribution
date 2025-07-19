import { GasDistributionConfig, ObfuscationConfig, TokenDistributionConfig } from '../types'

// Gas 分发配置
export const gasDistributionConfig: GasDistributionConfig = {
  // 模拟交易所热钱包（在实际使用时应该从环境变量读取）
  exchangeSources: [
    {
      address: process.env.EXCHANGE_ADDRESS_1 || '',
      privateKey: process.env.EXCHANGE_PRIVATE_KEY_1 || '',
    },
    {
      address: process.env.EXCHANGE_ADDRESS_2 || '',
      privateKey: process.env.EXCHANGE_PRIVATE_KEY_2 || '',
    },
  ],
  // 中间钱包配置
  intermediateWallets: {
    hdPath: "m/44'/60'/1", // 专门用于Gas分发的HD路径
    count: 5, // 中间钱包数量
  },
  // 每个地址分配的Gas范围(ETH)
  gasAmounts: {
    min: '0.001', // 最少0.001 ETH  21000（基础转账） + 约 25000~50000（ERC20 transfer 逻辑） ≈ 45000~70000 gas. 70000 * 10 * 1e9 / 1e18 = 0.0007
    max: '0.005', // 最多0.005 ETH
  },
  // Gas Price 随机化范围(gwei)
  gasPriceRandomization: {
    min: 5, // 最低5 gwei
    max: 20, // 最高20 gwei
  },
}

// Token 分发配置
export const tokenDistributionConfig: TokenDistributionConfig = {
  tokenAddress: process.env.TOKEN_ADDRESS || '0x...', // ERC20 Token地址
  sourceAddress: {
    address: process.env.SOURCE_ADDRESS || '',
    privateKey: process.env.SOURCE_PRIVATE_KEY || '',
  },
  distributionPlan: {
    amounts: {
      mean: '1000000', // 正态分布均值: 1,000,000 tokens
      stdDev: '200000', // 正态分布标准差: 200,000 tokens
    },
    timing: {
      lambda: 12, // 泊松过程参数: 平均每小时12笔交易
    },
    safetyCheck: {
      initialSmallAmount: '1000', // 初始小额测试: 1,000 tokens
      waitBlocks: 3, // 小额测试后等待3个区块
    },
  },
}

// 抗检测配置
export const obfuscationConfig: ObfuscationConfig = {
  circularTransactions: {
    enabled: true,
    percentage: 0.15, // 循环交易占正常交易的15%
    wallets: {
      hdPath: "m/44'/60'/2", // 专门用于循环交易的HD路径
      count: 10, // 循环交易钱包数量
    },
  },
  randomTransfers: {
    enabled: true,
    ethAmounts: {
      min: '0.0001', // 最少0.0001 ETH
      max: '0.001', // 最多0.001 ETH
    },
  },
}

// 网络特定配置
export const networkConfigs = {
  local: {
    gasPrice: 20000000000, // 20 gwei
    gasLimit: 21000,
    confirmations: 1,
  },
  sepolia: {
    gasPrice: 'auto',
    gasLimit: 'auto',
    confirmations: 2,
  },
  mainnet: {
    gasPrice: 'auto',
    gasLimit: 'auto',
    confirmations: 3,
  },
}

// 获取网络配置
export function getNetworkConfig(networkName: string) {
  return networkConfigs[networkName as keyof typeof networkConfigs] || networkConfigs.local
}
