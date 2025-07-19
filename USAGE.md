# Token Distribution System - 使用指南

## 快速开始

### 1. 环境设置

```bash
# 克隆项目
git clone <your-repo-url>
cd token-distribution

# 安装依赖
npm install

# 复制环境变量模板
cp .env.example .env

# 编辑环境变量（重要！）
vim .env
```

### 2. 配置环境变量

在 `.env` 文件中设置以下变量：

```bash
# 网络RPC（可选，有默认值）
RPC=https://ethereum-sepolia-rpc.publicnode.com

# 交易所源钱包（必须）
EXCHANGE_ADDRESS_1=0x1234...
EXCHANGE_PRIVATE_KEY_1=0xabcd...
EXCHANGE_ADDRESS_2=0x5678...
EXCHANGE_PRIVATE_KEY_2=0xefgh...

# Token分发源（必须）
TOKEN_ADDRESS=0x9abc...
SOURCE_ADDRESS=0xdef1...
SOURCE_PRIVATE_KEY=0x2345...
```

### 3. 本地测试

```bash
# 启动本地网络
npx hardhat node

# 在另一个终端部署测试Token
npx hardhat deploy --network localhost

# 运行完整测试流程
npm run dry-run:all
```

### 4. 主网部署流程

```bash
# 1. 初始化HD钱包树
npm run init-tree

# 2. 分发Gas费（干运行测试）
npm run dry-run:gas

# 3. 执行Gas分发
npm run distribute-gas

# 4. 分发Token（干运行测试）
npm run dry-run:tokens

# 5. 执行Token分发
npm run distribute-tokens

# 6. 启动抗检测模块（可选，后台运行）
npm run obfuscation
```

## 高级配置

### 机构树配置

编辑 `config/institutions.ts` 来自定义机构层级结构：

```typescript
export const institutionTreeConfig: InstitutionNode[] = [
  {
    hdPath: "m/44'/60'/0'/0", // 主要机构A
    depth: 0,
    addressCount: 5, // 该机构生成5个地址
    childNodes: [
      // 子机构...
    ],
  },
  // 更多根机构...
]
```

### 分发参数配置

编辑 `config/distribution.ts` 调整分发参数：

```typescript
export const tokenDistributionConfig: TokenDistributionConfig = {
  distributionPlan: {
    amounts: {
      mean: '1000000', // 平均每个地址1M tokens
      stdDev: '200000', // 标准差200K tokens
    },
    timing: {
      lambda: 12, // 每小时平均12笔交易
    },
  },
}
```

## 任务详解

### init-hd-tree

初始化HD钱包树结构，生成所有需要的地址。

```bash
# 基本用法
npx hardhat init-hd-tree

# 高级选项
npx hardhat init-hd-tree --output-dir ./custom-output --force --dry-run
```

选项说明：

- `--output-dir`: 指定配置文件输出目录
- `--force`: 强制重新生成（覆盖已有文件）
- `--dry-run`: 干运行模式，不实际创建文件

### distribute-gas

Gas费分发任务，确保所有地址都有足够的ETH进行Token转账。

```bash
# 基本用法
npx hardhat distribute-gas

# 高级选项
npx hardhat distribute-gas --config-dir ./generated --batch-size 5 --delay-ms 3000 --dry-run
```

选项说明：

- `--config-dir`: 配置文件目录
- `--batch-size`: 每批处理的交易数量
- `--delay-ms`: 批次间延迟时间（毫秒）
- `--dry-run`: 干运行模式，不执行实际交易

### distribute-tokens

Token分发任务，按照树形结构分发代币。

```bash
# 基本用法
npx hardhat distribute-tokens

# 高级选项
npx hardhat distribute-tokens --batch-size 3 --max-retries 5 --dry-run --skip-safety-check
```

选项说明：

- `--batch-size`: 批处理大小（推荐3-5）
- `--max-retries`: 失败重试次数
- `--skip-safety-check`: 跳过安全检查（小额测试）
- `--dry-run`: 干运行模式

### obfuscation

抗检测干扰交易模块，插入随机交易增加隐蔽性。

```bash
# 基本用法
npx hardhat obfuscation

# 高级选项
npx hardhat obfuscation --duration 120 --intensity 0.5 --circular-only --dry-run
```

选项说明：

- `--duration`: 运行时长（分钟）
- `--intensity`: 干扰强度（0.1-1.0）
- `--circular-only`: 只执行循环交易
- `--random-only`: 只执行随机转账
- `--dry-run`: 干运行模式

## 安全注意事项

### 私钥管理

- 所有私钥都存储在 `.env` 文件中
- 生成的主种子保存在 `generated/master-seed.json`
- **绝对不要** 将这些文件提交到版本控制系统
- 建议使用硬件钱包或多重签名钱包管理大额资金

### 测试流程

1. **总是先使用 `--dry-run` 模式测试**
2. 在测试网络上完整测试流程
3. 小额测试主网功能
4. 确认无误后再进行大额操作

### 网络拥堵处理

- 系统会自动调整Gas价格
- 如果网络拥堵，考虑增加 `--delay-ms` 参数
- 监控交易池状态，必要时暂停执行

## 故障排除

### 常见错误

**1. 配置文件不存在**

```
错误: 配置文件不存在，请先运行 init-hd-tree 任务
解决: 运行 npx hardhat init-hd-tree
```

**2. 余额不足**

```
错误: 源钱包余额不足
解决: 检查环境变量中的地址是否正确，确保有足够余额
```

**3. Gas价格过高**

```
错误: 交易失败，Gas价格过高
解决: 等待网络拥堵缓解，或调整配置中的Gas价格范围
```

**4. nonce错误**

```
错误: nonce too low 或 nonce too high
解决: 等待之前的交易确认，或重启任务
```

### 日志级别

设置环境变量控制日志详细程度：

```bash
# 在任务执行前设置
export LOG_LEVEL=debug  # debug | info | warn | error

# 执行任务
npx hardhat distribute-tokens
```

### 恢复中断的任务

如果任务执行中断，可以：

1. 检查 `generated/` 目录中的配置文件
2. 查看日志确定执行进度
3. 手动调整配置或重新运行任务

## 监控和分析

### 链上分析

使用区块浏览器监控交易：

```bash
# 获取所有生成的地址
cat generated/distribution-config.json | grep -o "0x[a-fA-F0-9]\{40\}"

# 使用Etherscan API批量查询余额
# （需要实现自定义脚本）
```

### 性能监控

- 交易成功率
- 平均确认时间
- Gas消耗统计
- 网络拥堵影响

### 合规性检查

- 确保符合当地法规
- 实现必要的KYC/AML流程
- 保留审计追踪记录

## 扩展开发

### 添加新的分发算法

1. 在 `tasks/utils.ts` 中实现新的随机分布函数
2. 更新 `config/distribution.ts` 添加配置选项
3. 修改分发任务使用新算法

### 集成监控系统

可以集成以下监控系统：

- Grafana + Prometheus
- DataDog
- New Relic
- 自定义webhook通知

### 多链支持

1. 扩展 `hardhat.config.ts` 添加新链配置
2. 更新环境变量模板
3. 测试跨链兼容性
