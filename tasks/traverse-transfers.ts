import { ethers } from 'ethers'
import fs from 'fs'
import { task } from 'hardhat/config'
import path from 'path'
import { Logger } from './utils'

// 类型定义
interface TraverseOptions {
  startAddress: string
  tokenAddress?: string
  fromBlock?: number
  toBlock?: number
  maxDepth?: number
  concurrency?: number
  collectAllBalances?: boolean
  balanceAggregationMode?: 'onchain' | 'derived' | 'both'
  balanceBatchSize?: number
  rpcRateLimit?: number
  useMulticall?: boolean
  retryOptions?: { retries?: number; backoffMs?: number }
  maxVisitedNodes?: number
  allowContractsAsEndpoints?: boolean
  useOnchainBalanceForEndpoint?: boolean
  output?: string
  outputFormat?: 'csv'
  atomicWrite?: boolean
  streamThreshold?: number
}

interface InternalTraverseOptions extends Omit<TraverseOptions, 'fromBlock' | 'toBlock'> {
  startAddress: string
  tokenAddress: string
  fromBlock?: number
  toBlock?: number
  maxDepth: number
  concurrency: number
  collectAllBalances: boolean
  balanceAggregationMode: 'onchain' | 'derived' | 'both'
  balanceBatchSize: number
  rpcRateLimit: number
  useMulticall: boolean
  retryOptions: { retries: number; backoffMs: number }
  maxVisitedNodes: number
  allowContractsAsEndpoints: boolean
  useOnchainBalanceForEndpoint: boolean
  output: string
  outputFormat: 'csv'
  atomicWrite: boolean
  streamThreshold: number
}

interface TransferEvent {
  id: string
  token: string
  from: string
  to: string
  amount: string
  txHash: string
  logIndex: number
  blockNumber: number
}

interface TransferPath {
  id: string
  edges: TransferEvent[]
  totalAmount: string
  depth: number
  endpoint: string
}

interface Node {
  address: string
  isContract?: boolean
  firstSeenBlock?: number
  balances?: Record<string, string> // token -> balance
}

interface EndpointSummary {
  address: string
  paths: string[]
  onchainBalance?: string
  netReceived: string
}

interface TraverseResult {
  metadata: {
    startAddress: string
    tokens: string[]
    fromBlock?: number
    toBlock?: number
    maxDepth: number
    collectAllBalances: boolean
    balanceMode: string
    concurrency: number
    timestamp: string
    runId: string
  }
  nodes: Node[]
  edges: TransferEvent[]
  paths: TransferPath[]
  endpoints: EndpointSummary[]
  stats: {
    pathsFound: number
    edges: number
    visitedNodes: number
    uniqueAddresses: number
    totalTransferValue: string
    executionTimeMs: number
  }
  errors: string[]
}

// ERC-20 Transfer 事件签名
const TRANSFER_EVENT_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// 速率限制器
class RateLimiter {
  private queue: Array<() => Promise<unknown>> = []
  private running = 0
  private maxConcurrent: number
  private minInterval: number
  private lastExecution = 0

  constructor(maxConcurrent: number, requestsPerSecond: number) {
    this.maxConcurrent = maxConcurrent
    this.minInterval = 1000 / requestsPerSecond
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn()
          resolve(result)
        } catch (error) {
          reject(error)
        }
      })
      void this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return
    }

    const now = Date.now()
    const timeSinceLastExecution = now - this.lastExecution
    if (timeSinceLastExecution < this.minInterval) {
      setTimeout(() => {
        void this.processQueue()
      }, this.minInterval - timeSinceLastExecution)
      return
    }

    const task = this.queue.shift()
    if (task) {
      this.running++
      this.lastExecution = Date.now()

      try {
        await task()
      } finally {
        this.running--
        setTimeout(() => {
          void this.processQueue()
        }, this.minInterval)
      }
    }
  }
}

// ERC-20 ABI 片段
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]

class TransferTraverser {
  private provider: ethers.Provider
  private options: InternalTraverseOptions
  private rateLimiter: RateLimiter
  private visitedNodes = new Set<string>()
  private pathsFound: TransferPath[] = []
  private allEdges: TransferEvent[] = []
  private allNodes = new Map<string, Node>()
  private errors: string[] = []
  private runId: string
  private startTime: number
  private tokenDecimals?: number
  private tokenSymbol?: string

  constructor(provider: ethers.Provider, options: TraverseOptions) {
    this.provider = provider
    this.runId = `traverse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    this.startTime = Date.now()

    // 获取 token 地址
    const tokenAddress = options.tokenAddress || process.env.TOKEN_ADDRESS
    if (!tokenAddress) {
      throw new Error('Token 地址未指定，请设置 TOKEN_ADDRESS 环境变量或传入 tokenAddress 参数')
    }

    // 设置默认值
    this.options = {
      startAddress: options.startAddress,
      tokenAddress,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      maxDepth: options.maxDepth || 10,
      concurrency: options.concurrency || 8,
      collectAllBalances: options.collectAllBalances || false,
      balanceAggregationMode: options.balanceAggregationMode || 'onchain',
      balanceBatchSize: options.balanceBatchSize || 200,
      rpcRateLimit: options.rpcRateLimit || 10,
      useMulticall: options.useMulticall !== false,
      retryOptions: {
        retries: options.retryOptions?.retries || 3,
        backoffMs: options.retryOptions?.backoffMs || 1000,
      },
      maxVisitedNodes: options.maxVisitedNodes || 10000,
      allowContractsAsEndpoints: options.allowContractsAsEndpoints !== false,
      useOnchainBalanceForEndpoint: options.useOnchainBalanceForEndpoint !== false,
      output: options.output || path.join('.ws', 'traverse-result.csv'),
      outputFormat: options.outputFormat || 'csv',
      atomicWrite: options.atomicWrite !== false,
      streamThreshold: options.streamThreshold || 5_000_000,
    }

    this.rateLimiter = new RateLimiter(this.options.concurrency, this.options.rpcRateLimit)

    Logger.info(`🚀 TransferTraverser 初始化完成 - runId: ${this.runId}`)
    Logger.info(`🪙 使用 Token 地址: ${this.options.tokenAddress}`)
  }

  async traverse(): Promise<TraverseResult> {
    Logger.info(`📍 开始从地址 ${this.options.startAddress} 追踪转账路径`)
    Logger.info(`⚙️ 配置参数:`)
    Logger.info(`   - 最大深度: ${this.options.maxDepth}`)
    Logger.info(`   - 并发数: ${this.options.concurrency}`)
    Logger.info(`   - 区块范围: ${this.options.fromBlock || 'earliest'} -> ${this.options.toBlock || 'latest'}`)
    Logger.info(`   - 收集余额: ${this.options.collectAllBalances}`)
    Logger.info(`   - 输出格式: ${this.options.outputFormat}`)
    Logger.info(`   - Token 地址: ${this.options.tokenAddress}`)
    Logger.info(`   - RunID: ${this.runId}`)

    try {
      // 获取 token 信息
      Logger.info(`🔍 获取 Token 信息...`)
      await this.fetchTokenInfo()

      // BFS 遍历
      Logger.info(`🔄 开始 BFS 遍历...`)
      const bfsStartTime = Date.now()
      await this.performBFS()
      const bfsTime = Date.now() - bfsStartTime
      Logger.info(`✅ BFS 遍历完成，耗时: ${bfsTime}ms`)
      Logger.info(`📊 遍历统计: 访问了 ${this.visitedNodes.size} 个节点，发现 ${this.allEdges.length} 个转账事件`)

      // 收集所有地址余额（如果需要）
      if (this.options.collectAllBalances) {
        Logger.info(`💰 开始收集所有地址余额...`)
        const balanceStartTime = Date.now()
        await this.collectAllBalances()
        const balanceTime = Date.now() - balanceStartTime
        Logger.info(`✅ 余额收集完成，耗时: ${balanceTime}ms`)
      }

      // 生成结果
      Logger.info(`📝 生成结果报告...`)
      const result = this.generateResult()

      // 保存到文件
      Logger.info(`💾 保存结果到文件...`)
      await this.saveResult(result)

      const totalTime = Date.now() - this.startTime
      Logger.info(`✅ 遍历完成 - 找到 ${result.paths.length} 条路径，${result.nodes.length} 个地址，总耗时: ${totalTime}ms`)

      if (this.errors.length > 0) {
        Logger.warn(`⚠️ 执行过程中遇到 ${this.errors.length} 个错误，详见错误列表`)
      }

      return result
    } catch (error) {
      Logger.error(`❌ 遍历失败: ${error}`)
      throw error
    }
  }

  private async fetchTokenInfo() {
    try {
      const contract = new ethers.Contract(this.options.tokenAddress, ERC20_ABI, this.provider)

      // 获取 decimals 和 symbol
      const [decimals, symbol] = await Promise.all([
        this.rateLimiter.schedule(() => contract.decimals()),
        this.rateLimiter.schedule(() => contract.symbol()),
      ])

      this.tokenDecimals = Number(decimals)
      this.tokenSymbol = symbol

      Logger.info(`💰 Token 信息:`)
      Logger.info(`   - Symbol: ${this.tokenSymbol}`)
      Logger.info(`   - Decimals: ${this.tokenDecimals}`)
    } catch (error) {
      Logger.warn(`⚠️ 获取 Token 信息失败: ${error}`)
      Logger.warn(`使用默认值: decimals=18, symbol="Token"`)
      this.tokenDecimals = 18
      this.tokenSymbol = 'Token'
    }
  }

  private formatAmount(amount: string): string {
    if (!this.tokenDecimals) return amount

    try {
      const value = ethers.formatUnits(amount, this.tokenDecimals)
      // 格式化为最多 6 位小数，去掉尾部零
      const formatted = parseFloat(value)
        .toFixed(6)
        .replace(/\.?0+$/, '')
      return `${formatted} ${this.tokenSymbol || ''}`
    } catch (error) {
      Logger.warn(`⚠️ 格式化金额失败: ${error}`)
      return amount
    }
  }

  private async performBFS() {
    const queue: Array<{ address: string; path: TransferEvent[]; depth: number }> = [
      { address: this.options.startAddress, path: [], depth: 0 },
    ]

    this.addNode(this.options.startAddress, 0)
    Logger.info(`🌱 初始化 BFS 队列，起始地址: ${this.options.startAddress}`)

    let processedNodes = 0
    let queuePeakSize = 1

    while (queue.length > 0 && this.visitedNodes.size < this.options.maxVisitedNodes) {
      queuePeakSize = Math.max(queuePeakSize, queue.length)
      const { address, path, depth } = queue.shift()!

      if (depth >= this.options.maxDepth) {
        this.recordEndpoint(address, path)
        Logger.debug(`🎯 达到最大深度 ${this.options.maxDepth}，记录终点: ${address}`)
        continue
      }

      const nodeKey = `${address}-${depth}`
      if (this.visitedNodes.has(nodeKey)) {
        Logger.debug(`⏭️ 跳过已访问节点: ${address} (深度: ${depth})`)
        continue
      }

      this.visitedNodes.add(nodeKey)
      processedNodes++

      if (processedNodes % 10 === 0 || depth === 0) {
        Logger.info(`🔍 处理第 ${processedNodes} 个节点: ${address} (深度: ${depth}, 队列长度: ${queue.length})`)
      }

      // 查找从该地址发出的转账
      const outgoingTransfers = await this.fetchOutgoingTransfers(address, depth)

      if (outgoingTransfers.length === 0) {
        // 没有更多转账，这是一个终点
        this.recordEndpoint(address, path)
        Logger.debug(`🏁 终点地址 (无转出): ${address}`)
        continue
      }

      Logger.debug(`📤 地址 ${address} 有 ${outgoingTransfers.length} 笔转出`)

      // 处理每个转账
      for (const transfer of outgoingTransfers) {
        const newPath = [...path, transfer]

        // 检查循环
        if (this.hasCircle(newPath)) {
          Logger.warn(`🔄 检测到循环: ${transfer.from} -> ${transfer.to}`)
          this.recordEndpoint(transfer.to, newPath)
          continue
        }

        // 添加到队列继续遍历
        queue.push({
          address: transfer.to,
          path: newPath,
          depth: depth + 1,
        })

        this.addNode(transfer.to, transfer.blockNumber)
        Logger.debug(`➕ 添加到队列: ${transfer.to} (深度: ${depth + 1})`)
      }
    }

    Logger.info(`🏁 BFS 遍历完成:`)
    Logger.info(`   - 处理节点数: ${processedNodes}`)
    Logger.info(`   - 队列峰值: ${queuePeakSize}`)
    Logger.info(`   - 访问节点数: ${this.visitedNodes.size}`)
    Logger.info(`   - 发现路径数: ${this.pathsFound.length}`)
    Logger.info(`   - 转账事件数: ${this.allEdges.length}`)

    if (this.visitedNodes.size >= this.options.maxVisitedNodes) {
      Logger.warn(`⚠️ 达到最大访问节点数限制: ${this.options.maxVisitedNodes}`)
    }
  }

  private async fetchOutgoingTransfers(address: string, depth: number): Promise<TransferEvent[]> {
    const transfers: TransferEvent[] = []
    Logger.debug(`🔎 查询地址 ${address} 的转出记录 (深度: ${depth})`)

    try {
      Logger.debug(`   查询 Token: ${this.options.tokenAddress}`)

      const filter = {
        address: this.options.tokenAddress,
        fromBlock: this.options.fromBlock || 'earliest',
        toBlock: this.options.toBlock || 'latest',
        topics: [
          TRANSFER_EVENT_SIGNATURE,
          ethers.zeroPadValue(address, 32), // from
          null, // to (any)
        ],
      }

      const queryStartTime = Date.now()
      const logs = await this.rateLimiter.schedule(() => this.provider.getLogs(filter))
      const queryTime = Date.now() - queryStartTime

      Logger.debug(`   获得 ${logs.length} 条日志，耗时: ${queryTime}ms`)

      for (const log of logs) {
        const transferEvent = this.parseTransferEvent(log, this.options.tokenAddress)
        if (transferEvent && !this.isDuplicateEdge(transferEvent)) {
          transfers.push(transferEvent)
          this.allEdges.push(transferEvent)
        }
      }
    } catch (error) {
      Logger.error(`❌ 获取 token ${this.options.tokenAddress} 的转账失败: ${error}`)
      this.errors.push(`Failed to fetch transfers for token ${this.options.tokenAddress}: ${error}`)
    }

    if (transfers.length > 0) {
      Logger.debug(`📤 地址 ${address} 发出 ${transfers.length} 笔转账`)
      transfers.forEach((transfer, index) => {
        Logger.debug(`   ${index + 1}. ${transfer.from} -> ${transfer.to} (${transfer.amount})`)
      })
    } else {
      Logger.debug(`📭 地址 ${address} 无转出记录`)
    }

    return transfers
  }

  private parseTransferEvent(log: ethers.Log, token: string): TransferEvent | null {
    try {
      const iface = new ethers.Interface(ERC20_ABI)
      const decoded = iface.parseLog({ topics: log.topics, data: log.data })

      if (!decoded) return null

      return {
        id: `${log.transactionHash}-${log.index}`,
        token,
        from: decoded.args.from,
        to: decoded.args.to,
        amount: decoded.args.value.toString(),
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
      }
    } catch (error) {
      Logger.warn(`⚠️ 解析转账事件失败: ${error}`)
      return null
    }
  }

  private isDuplicateEdge(transfer: TransferEvent): boolean {
    return this.allEdges.some(edge => edge.id === transfer.id)
  }

  private hasCircle(path: TransferEvent[]): boolean {
    const addresses = new Set<string>()
    for (const edge of path) {
      if (addresses.has(edge.to)) {
        return true
      }
      addresses.add(edge.from)
    }
    return false
  }

  private addNode(address: string, blockNumber: number) {
    if (!this.allNodes.has(address)) {
      this.allNodes.set(address, {
        address,
        firstSeenBlock: blockNumber,
        isContract: undefined, // 将在后续检查
      })
    }
  }

  private recordEndpoint(address: string, path: TransferEvent[]) {
    if (path.length === 0) {
      Logger.debug(`🎯 记录起始地址作为终点: ${address} (无转账路径)`)
      return
    }

    const pathId = `path-${this.pathsFound.length + 1}`
    const totalAmount = path[path.length - 1]?.amount || '0'

    this.pathsFound.push({
      id: pathId,
      edges: path,
      totalAmount,
      depth: path.length,
      endpoint: address,
    })

    Logger.debug(`🎯 记录终点: ${address}`)
    Logger.debug(`   路径ID: ${pathId}`)
    Logger.debug(`   路径长度: ${path.length}`)
    Logger.debug(`   最终金额: ${totalAmount}`)

    if (path.length > 0) {
      const firstTransfer = path[0]
      const lastTransfer = path[path.length - 1]
      Logger.debug(`   路径: ${firstTransfer.from} -> ... -> ${lastTransfer.to}`)
    }
  }

  private async collectAllBalances() {
    Logger.info(`💰 开始收集所有地址余额...`)
    Logger.info(`📊 需要查询的地址数: ${this.allNodes.size}`)
    Logger.info(`🪙 查询 Token: ${this.options.tokenAddress}`)
    Logger.info(`📦 批次大小: ${this.options.balanceBatchSize}`)

    const addresses = Array.from(this.allNodes.keys())
    const chunks = this.chunkArray(addresses, this.options.balanceBatchSize)

    Logger.info(`🔄 分为 ${chunks.length} 个批次处理`)

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      Logger.info(`⏳ 处理批次 ${i + 1}/${chunks.length} (${chunk.length} 个地址)`)

      const batchStartTime = Date.now()
      await this.collectBalancesForChunk(chunk)
      const batchTime = Date.now() - batchStartTime

      Logger.info(`✅ 批次 ${i + 1} 完成，耗时: ${batchTime}ms`)
    }

    Logger.info(`✅ 所有地址余额收集完成`)
  }

  private async collectBalancesForChunk(addresses: string[]) {
    const promises = addresses.map(address => this.collectBalanceForAddress(address))
    await Promise.allSettled(promises)
  }

  private async collectBalanceForAddress(address: string) {
    const node = this.allNodes.get(address)
    if (!node) return

    Logger.debug(`💰 查询地址 ${address} 的余额`)
    node.balances = {}

    try {
      const contract = new ethers.Contract(this.options.tokenAddress, ERC20_ABI, this.provider)
      const balance = await this.rateLimiter.schedule(() => contract.balanceOf(address))
      node.balances[this.options.tokenAddress] = balance.toString()
      Logger.debug(`   余额: ${balance.toString()}`)
    } catch (error) {
      Logger.warn(`⚠️ 获取地址 ${address} 余额失败: ${error}`)
      node.balances[this.options.tokenAddress] = 'ERROR'
    }

    // 检查是否为合约
    try {
      const code = await this.rateLimiter.schedule(() => this.provider.getCode(address))
      node.isContract = code !== '0x'
      Logger.debug(`   地址类型: ${node.isContract ? '合约' : 'EOA'}`)
    } catch (error) {
      Logger.warn(`⚠️ 检查地址 ${address} 类型失败: ${error}`)
    }
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }

  private generateResult(): TraverseResult {
    const endpoints = this.generateEndpointsSummary()
    const totalTransferValue = this.allEdges.reduce((sum, edge) => sum + BigInt(edge.amount), 0n).toString()

    return {
      metadata: {
        startAddress: this.options.startAddress,
        tokens: [this.options.tokenAddress],
        fromBlock: this.options.fromBlock,
        toBlock: this.options.toBlock,
        maxDepth: this.options.maxDepth,
        collectAllBalances: this.options.collectAllBalances,
        balanceMode: this.options.balanceAggregationMode,
        concurrency: this.options.concurrency,
        timestamp: new Date().toISOString(),
        runId: this.runId,
      },
      nodes: Array.from(this.allNodes.values()),
      edges: this.allEdges,
      paths: this.pathsFound,
      endpoints,
      stats: {
        pathsFound: this.pathsFound.length,
        edges: this.allEdges.length,
        visitedNodes: this.visitedNodes.size,
        uniqueAddresses: this.allNodes.size,
        totalTransferValue,
        executionTimeMs: Date.now() - this.startTime,
      },
      errors: this.errors,
    }
  }

  private generateEndpointsSummary(): EndpointSummary[] {
    const endpointMap = new Map<string, EndpointSummary>()

    for (const path of this.pathsFound) {
      const endpoint = path.endpoint
      const lastEdge = path.edges[path.edges.length - 1]

      if (!lastEdge) continue

      if (!endpointMap.has(endpoint)) {
        const node = this.allNodes.get(endpoint)
        endpointMap.set(endpoint, {
          address: endpoint,
          paths: [],
          netReceived: '0',
          onchainBalance: node?.balances?.[this.options.tokenAddress],
        })
      }

      const summary = endpointMap.get(endpoint)!
      summary.paths.push(path.id)
      summary.netReceived = (BigInt(summary.netReceived) + BigInt(lastEdge.amount)).toString()
    }

    return Array.from(endpointMap.values())
  }

  private async saveResult(result: TraverseResult) {
    Logger.info(`💾 保存结果到文件: ${this.options.output}`)

    try {
      switch (this.options.outputFormat) {
        case 'csv':
          await this.generateCSVOutput(result)
          return
        default:
          throw new Error(`不支持的输出格式: ${this.options.outputFormat}`)
      }
    } catch (error) {
      Logger.error(`❌ 保存结果失败: ${error}`)
      throw error
    }
  }

  private async generateCSVOutput(result: TraverseResult) {
    const basePath = path.dirname(this.options.output)

    // 确保目录存在
    await fs.promises.mkdir(basePath, { recursive: true })

    // 生成多个 CSV 文件，使用固定的文件名
    const files = [
      { name: 'edges.csv', content: this.generateEdgesCSV(result.edges) },
      { name: 'nodes.csv', content: this.generateNodesCSV(result.nodes) },
      { name: 'endpoints.csv', content: this.generateEndpointsCSV(result.endpoints) },
      { name: 'paths.csv', content: this.generatePathsCSV(result.paths) },
    ]

    for (const file of files) {
      const filePath = path.join(basePath, file.name)
      await fs.promises.writeFile(filePath, file.content, 'utf8')
      Logger.info(`📄 CSV 文件已生成: ${filePath}`)
    }
  }

  private generateEdgesCSV(edges: TransferEvent[]): string {
    const headers = ['ID', 'From', 'To', 'Amount_Raw', 'Amount_Formatted', 'TxHash', 'LogIndex', 'BlockNumber']
    const rows = edges.map(edge => [
      edge.id,
      edge.from,
      edge.to,
      edge.amount,
      this.formatAmount(edge.amount),
      edge.txHash,
      edge.logIndex.toString(),
      edge.blockNumber.toString(),
    ])

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
  }

  private generateNodesCSV(nodes: Node[]): string {
    const headers = ['Address', 'IsContract', 'FirstSeenBlock', 'Balance_Raw', 'Balance_Formatted']
    const rows = nodes.map(node => {
      const rawBalance = node.balances?.[this.options.tokenAddress] || '0'
      return [
        node.address,
        (node.isContract || false).toString(),
        (node.firstSeenBlock || 0).toString(),
        rawBalance,
        rawBalance !== 'ERROR' ? this.formatAmount(rawBalance) : 'ERROR',
      ]
    })

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
  }

  private generateEndpointsCSV(endpoints: EndpointSummary[]): string {
    const headers = ['Address', 'NetReceived_Raw', 'NetReceived_Formatted', 'OnchainBalance_Raw', 'OnchainBalance_Formatted', 'PathsCount']
    const rows = endpoints.map(endpoint => [
      endpoint.address,
      endpoint.netReceived,
      this.formatAmount(endpoint.netReceived),
      endpoint.onchainBalance || '',
      endpoint.onchainBalance ? this.formatAmount(endpoint.onchainBalance) : '',
      endpoint.paths.length.toString(),
    ])

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
  }

  private generatePathsCSV(paths: TransferPath[]): string {
    const headers = ['PathID', 'Endpoint', 'Depth', 'TotalAmount_Raw', 'TotalAmount_Formatted', 'EdgeCount']
    const rows = paths.map(path => [
      path.id,
      path.endpoint,
      path.depth.toString(),
      path.totalAmount,
      this.formatAmount(path.totalAmount),
      path.edges.length.toString(),
    ])

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
  }
}

// Hardhat Task 定义
task('traverse-transfers', 'Traverse ERC-20 transfer paths from a starting address')
  .addParam('start', 'Starting address to traverse from')
  .addOptionalParam('tokenAddress', 'Token contract address', process.env.TOKEN_ADDRESS)
  .addOptionalParam('fromBlock', 'Starting block number', undefined, undefined)
  .addOptionalParam('toBlock', 'Ending block number', undefined, undefined)
  .addOptionalParam('maxDepth', 'Maximum traversal depth', '10')
  .addOptionalParam('concurrency', 'Concurrent requests limit', '8')
  .addOptionalParam('collectBalances', 'Collect all address balances', 'true')
  .addOptionalParam('balanceMode', 'Balance aggregation mode', 'onchain')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre

    // 设置日志文件
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').split('.')[0]
    const logFilename = `traverse-transfers-${timestamp}.log`
    Logger.setLogFile(logFilename)

    Logger.info('🚀 开始执行转账路径追踪任务')
    Logger.info(`📅 执行时间: ${new Date().toISOString()}`)
    Logger.info(`🆔 时间戳: ${timestamp}`)

    // 记录输入参数
    Logger.info('📋 输入参数:')
    Logger.info(`   起始地址: ${taskArgs.start}`)
    Logger.info(`   Token 地址: ${taskArgs.tokenAddress || process.env.TOKEN_ADDRESS || '未设置'}`)
    Logger.info(`   起始区块: ${taskArgs.fromBlock || 'earliest'}`)
    Logger.info(`   结束区块: ${taskArgs.toBlock || 'latest'}`)
    Logger.info(`   最大深度: ${taskArgs.maxDepth}`)
    Logger.info(`   并发数: ${taskArgs.concurrency}`)
    Logger.info(`   收集余额: ${taskArgs.collectBalances}`)
    Logger.info(`   余额模式: ${taskArgs.balanceMode}`)
    Logger.info(`   输出格式: CSV`)
    Logger.info(`   配置目录: ${taskArgs.configDir}`)

    try {
      // 确保配置目录存在
      const fs = await import('fs')
      Logger.info(`📁 检查配置目录: ${taskArgs.configDir}`)
      if (!fs.existsSync(taskArgs.configDir)) {
        Logger.info(`📁 创建配置目录: ${taskArgs.configDir}`)
        fs.mkdirSync(taskArgs.configDir, { recursive: true })
      }

      // 创建带时间戳的结果子目录
      const resultDir = path.join(taskArgs.configDir, 'traverse-result', `traverse-${timestamp}`)
      if (!fs.existsSync(resultDir)) {
        Logger.info(`📁 创建结果目录: ${resultDir}`)
        fs.mkdirSync(resultDir, { recursive: true })
      }

      // 设置输出文件路径到带时间戳的子目录
      const outputFile = path.join(resultDir, 'traverse-result.csv')
      Logger.info(`📄 输出目录: ${resultDir}`)
      Logger.info(`📄 基础文件名: traverse-result.csv`)

      // 准备参数
      const options: TraverseOptions = {
        startAddress: taskArgs.start,
        tokenAddress: taskArgs.tokenAddress,
        fromBlock: taskArgs.fromBlock ? parseInt(taskArgs.fromBlock) : undefined,
        toBlock: taskArgs.toBlock ? parseInt(taskArgs.toBlock) : undefined,
        maxDepth: parseInt(taskArgs.maxDepth),
        concurrency: parseInt(taskArgs.concurrency),
        collectAllBalances: taskArgs.collectBalances === 'true',
        balanceAggregationMode: taskArgs.balanceMode as 'onchain' | 'derived' | 'both',
        output: outputFile,
        outputFormat: 'csv',
      }

      // 准备 provider
      Logger.info('🔗 连接到区块链网络...')
      const provider = ethers.provider
      const network = await provider.getNetwork()
      Logger.info(`🌐 已连接到网络: ${network.name} (Chain ID: ${network.chainId})`)

      // 执行遍历
      Logger.info('🚀 开始执行遍历...')
      const startTime = Date.now()
      const traverser = new TransferTraverser(provider, options)
      const result = await traverser.traverse()
      const totalTime = Date.now() - startTime

      Logger.info(`✅ 任务完成！结果已保存到: ${options.output}`)
      Logger.info(`📊 执行统计:`)
      Logger.info(`   - 发现路径: ${result.stats.pathsFound}`)
      Logger.info(`   - 唯一地址: ${result.stats.uniqueAddresses}`)
      Logger.info(`   - 转账事件: ${result.stats.edges}`)
      Logger.info(`   - 访问节点: ${result.stats.visitedNodes}`)
      Logger.info(`   - 总执行时间: ${totalTime}ms`)
      Logger.info(`   - 总转账价值: ${result.stats.totalTransferValue}`)
      Logger.info(`📝 日志文件: logs/${logFilename}`)

      if (result.errors.length > 0) {
        Logger.warn(`⚠️ 执行过程中遇到 ${result.errors.length} 个错误`)
        result.errors.forEach((error, index) => {
          Logger.warn(`   ${index + 1}. ${error}`)
        })
      }
    } catch (error) {
      Logger.error(`❌ 任务执行失败: ${error}`)
      if (error instanceof Error) {
        Logger.error(`错误堆栈: ${error.stack}`)
      }
      throw error
    }
  })

export { TransferTraverser, TraverseOptions, TraverseResult }
