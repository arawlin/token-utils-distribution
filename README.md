# Token Distribution System

## 项目概述

本系统设计用于模拟项目方将 ERC20 代币分发给投资者的树形结构分发过程，使用 Hardhat 和 ethers.js 实现，不依赖任何智能合约，完全通过基础交易完成。

## 核心需求

### 系统描述

从一个有 ERC20 token 的地址将 token 分散到多个不同地址，中间有多层级，像树形结构一样的分发，模拟项目方将 token 分发给投资者的行为，后面的投资者又可能分发给他下面的子投资者。

### 主要特性

- **无合约设计**: 不使用任何合约，某些机构可以使用批量转账 token，而 gas 的分发只使用基础转账行为
- **任务模块化**: 使用 Hardhat、ethers 完成功能，多个任务放在 tasks 目录下
- **独立分支**: 每条树的分支都是一个独立的机构，各分支在时间上独立操作，层数可能不同
- **HD Wallet 架构**: 树的每个分支使用不同的 HD wallet 创建多个地址，一个 HD wallet 代表一个机构

### 功能模块

#### Gas Fee 分发

- Gas fee 来源于不同交易所转出
- 转到中间地址，再由中间地址分发给其他地址
- 中间地址使用 HD wallet 管理
- 提前随机化 Gas Price 到不同地址上
- Gas 数量仅用于 ERC20 transfer 的 gas

#### Token 分发

- 分发数量随机，使用正态分布（高斯分布）
- 分发时间按一定规则随机，使用泊松过程模拟
- 模拟真实用户行为：当数量大于某个阈值的时候，随机出现这种情况：小额 transfer，没有问题后再转其他数量

#### 执行策略

- Gas 分发和 token 分发可以同时执行
- 单个 gas 的转账总是先于 token 的 transfer
- 抗检测优化：随机插入"循环交易"

## 详细设计

### 系统架构

#### 核心组件

- **HD Wallet 树**: 代表不同机构的分支结构
- **Gas 分发系统**: 从交易所到中间地址再到分发地址的 Gas 供应链
- **Token 分发系统**: 按照树形结构分发 ERC20 代币
- **随机化引擎**: 控制分发数量和时间
- **抗检测模块**: 插入干扰交易

#### 技术栈

- Hardhat
- Ethers.js
- HD Wallet
- TypeScript

## 数据结构定义

### HD Wallet 树结构

```typescript
interface InstitutionNode {
  hdPath: string // HD钱包路径
  depth: number // 树深度
  childNodes: InstitutionNode[] // 子机构
  addressCount: number // 该机构生成的地址数量
}
```

### Gas 分发配置

```typescript
interface GasDistributionConfig {
  exchangeSources: { address: string; privateKey: string }[] // 交易所热钱包
  intermediateWallets: { hdPath: string; count: number } // 中间HD钱包
  gasAmounts: { min: string; max: string } // 每个地址分配的Gas范围(ETH)
  gasPriceRandomization: { min: number; max: number } // Gas Price随机范围(gwei)
}
```

### Token 分发配置

```typescript
interface TokenDistributionConfig {
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
```

### 抗检测配置

```typescript
interface ObfuscationConfig {
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
```

## 任务分解

### 任务1: 初始化 HD Wallet 树

- 生成主 HD Wallet
- 按照配置生成机构分支
- 每个分支生成指定数量的地址
- 保存种子和派生路径到加密配置文件

### 任务2: Gas 分发系统

- 从交易所热钱包分发到中间地址
- 中间地址再分发到目标地址
- 随机化 Gas Price
- 确保每个地址有足够 Gas 进行 ERC20 转账

### 任务3: Token 分发系统

- 按树形结构分发代币
- 使用正态分布随机化数量
- 使用泊松过程随机化时间
- 实现安全检查机制

### 任务4: 抗检测模块

- 插入循环交易
- 随机 ETH 转账
- 模拟真实用户行为模式

## 核心算法

### 正态分布数量生成

```typescript
function generateNormalDistributionAmount(mean: BigNumber, stdDev: BigNumber): BigNumber {
  // 使用Box-Muller变换生成正态分布随机数
  // 返回符合指定均值和标准差的随机数量
}
```

### 泊松过程时间生成

```typescript
function generatePoissonInterval(lambda: number): number {
  // 生成符合泊松过程的间隔时间(毫秒)
  // 使用指数分布实现
  return (-Math.log(1.0 - Math.random()) / lambda) * 3600000
}
```

### 交易执行流程

```mermaid
graph TD
  A[开始] --> B{是否有待处理Gas分发}
  B -->|是| C[执行Gas分发到目标地址]
  B -->|否| D{是否有待处理Token分发}
  D -->|是| E[检查目标地址Gas余额]
  E --> F{Gas是否充足}
  F -->|否| G[跳过该地址]
  F -->|是| H[执行Token转账]
  H --> I[插入随机干扰交易]
  D -->|否| J[结束]
```

## 实现细节

### 目录结构

```text
tasks/
├── init-hd-tree.ts       # 初始化HD钱包树
├── distribute-gas.ts     # Gas分发任务
├── distribute-tokens.ts  # Token分发任务
├── obfuscation.ts        # 抗检测干扰交易
└── utils.ts              # 公共工具函数

config/
├── institutions.ts       # 机构树配置
└── distribution.ts       # 分发参数配置
```

## 测试方案

### 测试用例

- HD Wallet 树生成正确性测试
- Gas 分发完整性测试
- Token 分发数量正态分布验证
- 交易时间间隔泊松过程验证
- 抗检测干扰交易比例测试

### 本地测试网络配置

```typescript
// hardhat.config.ts
export default {
  networks: {
    local: {
      url: 'http://localhost:8545',
      chainId: 31337,
      accounts: {
        mnemonic: 'test test test test test test test test test test test junk',
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 20,
      },
    },
  },
}
```

## 安全考虑

- 所有敏感信息(私钥、助记词)使用加密存储
- 配置从 .env 文件中读取
- 交易发送前进行本地预估 Gas 消耗
- 实现交易失败的重试机制
- 关键操作需要人工确认
- 提供 dry-run 模式测试交易

## 扩展性设计

- 支持多链部署配置
- 可插拔的随机分布算法
- 模块化的抗检测策略
- 交易监控和报警系统集成点
- 分发进度持久化和恢复功能

## 性能优化

- 批量交易并行发送
- 动态 Gas Price 调整
- 交易 nonce 本地管理
- 交易池状态监控
- 网络拥堵自动降级

## 使用指南

### 环境设置

1. 安装依赖

   ```bash
   npm install
   ```

2. 初始化 HD Wallet 树

   ```bash
   npx hardhat run tasks/init-hd-tree.ts
   ```

### 执行分发

1. 启动 Gas 分发

   ```bash
   npx hardhat run tasks/distribute-gas.ts
   ```

2. 启动 Token 分发

   ```bash
   npx hardhat run tasks/distribute-tokens.ts
   ```

3. 启动抗检测模块

   ```bash
   npx hardhat run tasks/obfuscation.ts
   ```
