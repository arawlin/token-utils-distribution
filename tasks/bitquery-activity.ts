import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task, types } from 'hardhat/config'
import https from 'https'
import path from 'path'
import { Logger, isValidAddress } from './utils'

const BITQUERY_DEFAULT_ENDPOINT = 'https://streaming.bitquery.io/graphql'
const DEFAULT_OUTPUT_PATH = path.join('.ws', 'bitquery-activity.json')
const DEFAULT_NETWORKS = ['eth', 'matic', 'arbitrum']
// const DEFAULT_NETWORKS = ['eth', 'bsc', 'matic', 'arbitrum', 'optimism', 'base']
const DATASETS = ['realtime', 'archive', 'combined'] as const
type DatasetArg = (typeof DATASETS)[number]
const DEFAULT_DATASET: DatasetArg = 'combined'

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message?: string }>
}

interface BitqueryBalanceEntry {
  BalanceUpdate?: {
    Address?: string | null
  } | null
  Currency?: {
    SmartContract?: string | null
    Symbol?: string | null
    Name?: string | null
    ProtocolName?: string | null
    Decimals?: number | null
    Native?: boolean | null
    Fungible?: boolean | null
  } | null
  balance?: string | null
}

interface BitqueryTransactionEntry {
  Block?: {
    Number?: string | null
    Time?: string | null
  } | null
  Transaction?: {
    Hash?: string | null
    From?: string | null
    To?: string | null
    Value?: string | null
    ValueInUSD?: string | null
    Gas?: string | null
    GasPrice?: string | null
    Nonce?: string | number | null
    Type?: string | number | null
  } | null
}

interface BitqueryNetworkDataset {
  currentBalances?: BitqueryBalanceEntry[] | null
  transactions?: BitqueryTransactionEntry[] | null
}

interface BitqueryQueryResponse {
  result?: BitqueryNetworkDataset | null
}

type CounterpartyDirection = 'incoming' | 'outgoing' | 'both'

interface CounterpartySummary {
  address: string
  direction: CounterpartyDirection
  transactions: number
}

interface NetworkActivitySummary {
  network: string
  result: {
    currentBalances: BitqueryBalanceEntry[]
    transactions: BitqueryTransactionEntry[]
    counterparties: CounterpartySummary[]
  }
  stats: {
    currentBalances: number
    transactions: number
    counterparties: number
  }
}

function sanitizeNetworkName(network: string): string {
  const trimmed = network.trim()
  if (!/^[a-z0-9_]+$/i.test(trimmed)) {
    throw new Error(`非法的网络名称: ${network}`)
  }
  return trimmed
}

function sanitizeDataset(dataset?: string): DatasetArg {
  const fallback = DEFAULT_DATASET
  if (!dataset) {
    return fallback
  }
  const normalized = dataset.trim().toLowerCase()
  if ((DATASETS as readonly string[]).includes(normalized)) {
    return normalized as DatasetArg
  }
  throw new Error(`非法的 Bitquery 数据集名称: ${dataset}，可选值为 ${DATASETS.join(', ')}`)
}

function parseSince(input?: string): string | undefined {
  if (!input) {
    return undefined
  }
  const trimmed = input.trim()
  if (!trimmed) {
    return undefined
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析的开始时间: ${input}，请使用 ISO8601 格式，例如 2024-01-01T00:00:00Z`)
  }
  return parsed.toISOString()
}

function buildNetworkQuery(network: string): string {
  const safeNetwork = sanitizeNetworkName(network)
  return `
    query AddressActivity($addresses: [String!], $limit: Int!, $dataset: dataset_arg_enum!, $since: DateTime) {
      result: EVM(network: ${safeNetwork}, dataset: $dataset) {
        currentBalances: BalanceUpdates(
          where: { BalanceUpdate: { Address: { in: $addresses } } }
          orderBy: [{ descendingByField: "balance" }]
        ) {
          BalanceUpdate {
            Address
          }
          Currency {
            SmartContract
            Symbol
            Name
            Decimals
            Native
            Fungible
          }
          balance: sum(of: BalanceUpdate_Amount, selectWhere: { gt: "0" })
        }
        transactions: Transactions(
          where: {
            any: [
              { Transaction: { From: { in: $addresses } } },
              { Transaction: { To: { in: $addresses } } }
            ]
            Block: { Time: { since: $since } }
          }
          orderBy: [{ descending: Block_Time }]
          limit: { count: $limit }
        ) {
          Block {
            Number
            Time
          }
          Transaction {
            Hash
            From
            To
            Value
            ValueInUSD
            Gas
            GasPrice
            Nonce
            Type
          }
        }
      }
    }
  `
}

async function executeBitqueryQuery<T>({
  query,
  variables,
  apiKey,
  endpoint,
}: {
  query: string
  variables: Record<string, unknown>
  apiKey: string
  endpoint: string
}): Promise<T> {
  const payload = JSON.stringify({ query, variables })
  const url = new URL(endpoint)

  return await new Promise<T>((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'token-utils-distribution/bitquery-task',
          Authorization: `Bearer ${apiKey}`,
          'X-API-KEY': apiKey,
        },
      },
      res => {
        const chunks: Uint8Array[] = []
        res.on('data', chunk => {
          chunks.push(chunk)
        })

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')

          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Bitquery 请求失败 (${res.statusCode}): ${body}`))
            return
          }

          try {
            const parsed = JSON.parse(body) as GraphQLResponse<T>
            if (parsed.errors && parsed.errors.length > 0) {
              reject(new Error(`Bitquery 返回错误: ${parsed.errors.map(e => e.message || 'Unknown error').join('; ')}`))
              return
            }
            if (!parsed.data) {
              reject(new Error('Bitquery 返回数据为空'))
              return
            }
            resolve(parsed.data)
          } catch (error) {
            reject(new Error(`解析 Bitquery 响应失败: ${(error as Error).message}`))
          }
        })
      },
    )

    request.on('error', error => {
      reject(new Error(`Bitquery 请求异常: ${(error as Error).message}`))
    })

    request.write(payload)
    request.end()
  })
}

function parseAddressInput(input?: string): string[] {
  if (!input) return []
  return input
    .split(/[,\n\r\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseAddresses(addressInput?: string, filePath?: string): { addresses: string[]; invalid: string[] } {
  const candidates: string[] = []

  candidates.push(...parseAddressInput(addressInput))

  if (filePath) {
    const resolved = path.resolve(filePath)
    if (!existsSync(resolved)) {
      throw new Error(`地址文件不存在: ${resolved}`)
    }
    const fileContent = readFileSync(resolved, 'utf8')
    candidates.push(...parseAddressInput(fileContent))
  }

  const valid = new Set<string>()
  const invalid: string[] = []

  for (const candidate of candidates) {
    if (!isValidAddress(candidate)) {
      invalid.push(candidate)
      continue
    }
    try {
      const checksum = ethers.getAddress(candidate)
      valid.add(checksum)
    } catch {
      invalid.push(candidate)
    }
  }

  return {
    addresses: Array.from(valid.values()),
    invalid,
  }
}

function parseNetworks(input?: string): string[] {
  if (!input) {
    return DEFAULT_NETWORKS
  }
  const list = input
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean)

  if (list.length === 0) {
    return DEFAULT_NETWORKS
  }

  return Array.from(new Set(list.map(sanitizeNetworkName)))
}

function ensureOutputDirectory(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function mapCurrentBalances(records: BitqueryBalanceEntry[] | null | undefined): BitqueryBalanceEntry[] {
  if (!records) return []
  return records
    .filter((record): record is BitqueryBalanceEntry => Boolean(record))
    .map(record => ({
      BalanceUpdate: record.BalanceUpdate ?? null,
      Currency: record.Currency ?? null,
      balance: record.balance ?? null,
    }))
}

function mapTransactions(records: BitqueryTransactionEntry[] | null | undefined): BitqueryTransactionEntry[] {
  if (!records) return []
  return records
    .filter((record): record is BitqueryTransactionEntry => Boolean(record))
    .map(record => {
      const originalTime = record.Block?.Time ?? null
      const block = record.Block
        ? {
            Number: record.Block.Number ?? null,
            Time: originalTime,
          }
        : null

      return {
        Block: block,
        Transaction: record.Transaction
          ? {
              Hash: record.Transaction.Hash ?? null,
              From: record.Transaction.From ?? null,
              To: record.Transaction.To ?? null,
              Value: record.Transaction.Value ?? null,
              ValueInUSD: record.Transaction.ValueInUSD ?? null,
              Gas: record.Transaction.Gas ?? null,
              GasPrice: record.Transaction.GasPrice ?? null,
              Nonce: record.Transaction.Nonce ?? null,
              Type: record.Transaction.Type ?? null,
            }
          : null,
      }
    })
}

function summarizeCounterparties(transactions: BitqueryTransactionEntry[], trackedAddresses: string[]): CounterpartySummary[] {
  if (transactions.length === 0) {
    return []
  }

  const trackedSet = new Set(trackedAddresses.map(address => address.toLowerCase()))
  const summary = new Map<
    string,
    {
      address: string
      direction: CounterpartyDirection
      transactions: number
    }
  >()

  const update = (address: string, direction: CounterpartyDirection) => {
    const key = address.toLowerCase()
    if (trackedSet.has(key)) {
      return
    }
    const existing = summary.get(key)
    if (existing) {
      existing.transactions += 1
      if (existing.direction !== direction) {
        existing.direction = 'both'
      }
    } else {
      summary.set(key, {
        address,
        direction,
        transactions: 1,
      })
    }
  }

  for (const entry of transactions) {
    const tx = entry.Transaction
    if (!tx) continue

    const from = tx.From ?? undefined
    const to = tx.To ?? undefined
    const fromLower = from ? from.toLowerCase() : undefined
    const toLower = to ? to.toLowerCase() : undefined

    const fromTracked = fromLower ? trackedSet.has(fromLower) : false
    const toTracked = toLower ? trackedSet.has(toLower) : false

    if (fromTracked && to) {
      update(to, 'outgoing')
    }
    if (toTracked && from) {
      update(from, 'incoming')
    }
  }

  return Array.from(summary.values()).sort((a, b) => b.transactions - a.transactions)
}

async function fetchNetworkActivity({
  network,
  addresses,
  limit,
  apiKey,
  endpoint,
  dataset,
  since,
}: {
  network: string
  addresses: string[]
  limit: number
  apiKey: string
  endpoint: string
  dataset: DatasetArg
  since?: string
}): Promise<NetworkActivitySummary> {
  Logger.info(`查询网络 ${network} 的资产与交互日志...`)

  const query = buildNetworkQuery(network)
  const variables = { addresses, limit, dataset, since: since ?? null }
  const data = await executeBitqueryQuery<BitqueryQueryResponse>({ query, variables, apiKey, endpoint })
  const datasetResult = data.result

  const currentBalances = mapCurrentBalances(datasetResult?.currentBalances)
  const transactions = mapTransactions(datasetResult?.transactions)
  const counterparties = summarizeCounterparties(transactions, addresses)

  Logger.info(
    `网络 ${network} 查询完成: 余额记录 ${currentBalances.length} 条，交易 ${transactions.length} 条，对手方 ${counterparties.length} 个`,
  )

  return {
    network,
    result: {
      currentBalances,
      transactions,
      counterparties,
    },
    stats: {
      currentBalances: currentBalances.length,
      transactions: transactions.length,
      counterparties: counterparties.length,
    },
  }
}

function buildGlobalSummary(results: NetworkActivitySummary[]) {
  let totalBalances = 0
  let totalTransactions = 0
  let totalCounterparties = 0
  const networkBreakdown: Array<{
    network: string
    currentBalances: number
    transactions: number
    counterparties: number
  }> = []

  for (const result of results) {
    totalBalances += result.stats.currentBalances
    totalTransactions += result.stats.transactions
    totalCounterparties += result.stats.counterparties
    networkBreakdown.push({
      network: result.network,
      currentBalances: result.stats.currentBalances,
      transactions: result.stats.transactions,
      counterparties: result.stats.counterparties,
    })
  }

  return {
    totalNetworks: results.length,
    totalBalances,
    totalTransactions,
    totalCounterparties,
    networkBreakdown,
  }
}

task('bitquery-activity', '使用 Bitquery 查询地址的多链资产及交互日志')
  .addOptionalParam('addresses', '逗号/空格分隔的地址列表')
  .addOptionalParam('file', '包含地址列表的文件路径')
  .addOptionalParam('networks', 'Bitquery 支持的网络列表，逗号分隔', DEFAULT_NETWORKS.join(','))
  .addOptionalParam('limit', '每种日志在每个网络中返回的最大数量', 100, types.int)
  .addOptionalParam('dataset', 'Bitquery 数据集，可选 realtime、archive 或 combined', DEFAULT_DATASET)
  .addOptionalParam('since', '限制交易的开始时间 (ISO8601)', '2025-01-01T00:00:00Z', types.string)
  .addOptionalParam('output', '保存结果的 JSON 文件路径', DEFAULT_OUTPUT_PATH)
  .addOptionalParam('endpoint', 'Bitquery GraphQL 端点', BITQUERY_DEFAULT_ENDPOINT)
  .addOptionalParam('apiKey', 'Bitquery API Key，默认读取 BITQUERY_API_KEY 环境变量')
  .setAction(async (taskArgs, hre) => {
    const startTime = Date.now()

    const { addresses, invalid } = parseAddresses(taskArgs.addresses, taskArgs.file)

    if (invalid.length > 0) {
      Logger.warn(`以下地址无效，将被忽略: ${invalid.join(', ')}`)
    }

    if (addresses.length === 0) {
      throw new Error('未提供任何有效地址，请通过 --addresses 或 --file 参数指定')
    }

    const networks = parseNetworks(taskArgs.networks)
    if (networks.length === 0) {
      throw new Error('未提供任何有效网络名称')
    }

    const limit = Number(taskArgs.limit) > 0 ? Number(taskArgs.limit) : 100
    const endpoint: string = taskArgs.endpoint || BITQUERY_DEFAULT_ENDPOINT
    const apiKey: string = (taskArgs.apiKey || process.env.BITQUERY_API_KEY || '').trim()
    const datasetArg: DatasetArg = sanitizeDataset(taskArgs.dataset)
    const since = parseSince(taskArgs.since)

    if (!apiKey) {
      throw new Error('未找到 Bitquery API Key，请通过 --api-key 参数或设置 BITQUERY_API_KEY 环境变量')
    }

    Logger.info(`Hardhat 网络: ${hre.network.name}`)
    Logger.info(`查询地址数量: ${addresses.length}`)
    Logger.info(`查询网络: ${networks.join(', ')}`)
    Logger.info(`每种日志最大返回数量: ${limit}`)
    Logger.info(`Bitquery 端点: ${endpoint}`)
    Logger.info(`Bitquery 数据集: ${datasetArg}`)
    if (since) {
      Logger.info(`交易筛选起始时间: ${since}`)
    }

    const results: NetworkActivitySummary[] = []

    for (const network of networks) {
      try {
        const result = await fetchNetworkActivity({
          network,
          addresses,
          limit,
          apiKey,
          endpoint,
          dataset: datasetArg,
          since,
        })
        results.push(result)
      } catch (error) {
        Logger.error(`查询网络 ${network} 失败`, error)
      }
    }

    const summary = buildGlobalSummary(results)
    const outputPath = path.resolve(taskArgs.output || DEFAULT_OUTPUT_PATH)
    ensureOutputDirectory(outputPath)

    const payload = {
      metadata: {
        addresses,
        networks,
        limit,
        endpoint,
        dataset: datasetArg,
        since,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startTime,
      },
      results,
      summary,
    }

    writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8')
    Logger.info(`结果已保存到 ${outputPath}`)

    Logger.info(
      `所有网络汇总: 余额记录 ${summary.totalBalances} 条，交易 ${summary.totalTransactions} 条，对手方 ${summary.totalCounterparties} 个，覆盖 ${summary.totalNetworks} 个网络`,
    )
  })
