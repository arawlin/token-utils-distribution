# 机构分组时间窗口分发系统改进

## 改进概述

根据您的需求，我对现有的gas费和token分发系统进行了重大改进，使其更真实地模拟机构投资者的行为模式。

## 主要改进

### 1. 机构分组和时间窗口系统

#### 新增类型定义 (`types/index.ts`)

- `InstitutionNode` 增加了 `institutionName`、`gasReceiveWindow`、`tokenReceiveWindow` 字段
- `DistributionTask` 增加了 `institutionGroup` 和 `dependsOn` 字段以支持任务依赖关系

#### 机构配置 (`config/institutions.ts`)

- 为每个机构和子机构配置了独立的时间窗口：
  - **主要机构A**: Gas接收0-30分钟，Token接收45-75分钟
  - **主要机构B**: Gas接收90-120分钟（与A有较大间隔），Token接收135-165分钟
  - **独立小机构C**: Gas接收200-230分钟，Token接收245-275分钟
- 子机构的时间窗口与父机构略有重叠，但整体保持分组特征

#### 新增辅助函数

- `getInstitutionGroups()`: 获取所有机构的分组信息
- `getInstitutionGroupsByTimeWindow()`: 按时间窗口排序获取机构组
- `isInReceiveWindow()`: 检查时间是否在接收窗口内
- `generateInstitutionBasedTasks()`: 为机构组生成时间分布的任务

### 2. Gas分发改进 (`tasks/distribute-gas.ts`)

#### 主要变化

- 替换了原有的简单地址收集为机构分组系统
- 新函数 `distributeToTargetAddressesByInstitution()` 替代原有分发逻辑

#### 时间分布特征

- **同机构内**: 用户在收到通知后集中转gas fee，时间相对集中（2-5秒间隔）
- **不同机构间**: 较长的时间间隔（10-40秒随机延迟）
- **批次内处理**: 并行执行以模拟用户同时操作
- **窗口控制**: 严格按照机构的gasReceiveWindow执行

### 3. Token分发改进 (`tasks/distribute-tokens.ts`)

#### 依赖关系管理

- Token分发必须在对应机构的Gas分发窗口结束后至少5分钟才开始
- 确保用户有足够的gas费来执行token转账

#### 新分发函数

- `executeInstitutionBasedTokenDistribution()` 实现机构分组的token分发
- 自动计算token分发的开始时间（基于gas窗口结束时间）
- 在token窗口内进行时间分布，同机构内用户操作相对集中

#### 时间分布特征

- **依赖等待**: 等待gas分发完成后才开始
- **同机构集中**: 同机构用户在收到token后相对集中地执行转账
- **机构间隔离**: 不同机构之间有30-90秒的较长间隔
- **随机化**: 在时间窗口内加入随机偏移，避免过于规律

### 4. 真实性模拟改进

#### 时间窗口设计

```
机构A系列: 0-100分钟
├── Gas: 0-55分钟（各子机构略有错开）
└── Token: 45-100分钟（在gas完成后）

机构B系列: 90-190分钟
├── Gas: 90-145分钟
└── Token: 135-190分钟

独立机构C: 200-275分钟
├── Gas: 200-230分钟
└── Token: 245-275分钟
```

#### 行为模拟

1. **消息传播**: 机构收到分发消息后，用户开始准备gas费
2. **集中响应**: 同机构用户在相似时间窗口内操作，体现组织性
3. **依赖关系**: Token转账严格依赖Gas费到账，符合实际操作流程
4. **机构差异**: 不同机构间有显著的时间间隔，体现独立决策

## 使用方式

### Gas分发

```bash
npx hardhat distribute-gas --dry-run
```

### Token分发

```bash
npx hardhat distribute-tokens --dry-run
```

### 配置调整

- 修改 `config/institutions.ts` 中的时间窗口配置
- 调整各机构的 `gasReceiveWindow` 和 `tokenReceiveWindow`
- 增减机构或调整层级结构

## 关键改进点

1. **真实时间模拟**: 不再是简单的批次处理，而是基于真实的机构行为模式
2. **依赖关系管理**: Token分发严格依赖Gas分发完成，符合实际逻辑
3. **分组集中效应**: 同机构用户行为相对集中，不同机构间有明显间隔
4. **可配置性**: 通过institutions.ts轻松调整各机构的时间窗口
5. **日志详细化**: 提供按机构分组的执行日志，便于监控和调试

这些改进使分发系统更接近真实的机构投资者行为，提高了模拟的可信度和效果。
