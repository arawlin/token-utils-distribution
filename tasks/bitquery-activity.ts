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

interface BitqueryCurrency {
  address?: string | null
  symbol?: string | null
  name?: string | null
  protocolName?: string | null
  decimals?: number | null
  native?: boolean | null
  fungible?: boolean | null
}

interface BitqueryBalanceEntry {
  balance?: {
    address?: string | null
    amount?: string | null
    amountUsd?: string | null
  } | null
  currency?: BitqueryCurrency | null
}

interface BitqueryBlockInfo {
  number?: string | null
  time?: string | null
}

interface BitqueryTransferEntry {
  block?: BitqueryBlockInfo | null
  transaction?: {
    hash?: string | null
    to?: string | null
  } | null
  transfer?: {
    sender?: string | null
    receiver?: string | null
    amount?: string | null
    amountUsd?: string | null
    currency?: BitqueryCurrency | null
  } | null
}

interface BitqueryContractCallEntry {
  block?: BitqueryBlockInfo | null
  transaction?: {
    hash?: string | null
    to?: string | null
  } | null
  call?: {
    from?: string | null
    to?: string | null
    value?: string | null
    valueUsd?: string | null
    signature?: {
      name?: string | null
      signature?: string | null
      signatureHash?: string | null
    } | null
  } | null
}

interface BitqueryTransactionEntry {
  block?: BitqueryBlockInfo | null
  transaction?: {
    hash?: string | null
    from?: string | null
    to?: string | null
    value?: string | null
    valueUsd?: string | null
    gas?: string | null
    gasPrice?: string | null
    nonce?: string | number | null
  } | null
}

interface BitqueryNetworkDataset {
  balances?: BitqueryBalanceEntry[] | null
  transfersSent?: BitqueryTransferEntry[] | null
  transfersReceived?: BitqueryTransferEntry[] | null
  contractInteractions?: BitqueryContractCallEntry[] | null
  transactions?: BitqueryTransactionEntry[] | null
}

interface ContractInteractionSummary {
  contractAddress: string
  contractAnnotation?: string
  contractType?: string
  protocolType?: string
  protocolSubtype?: string
  interactions: number
}

interface BitqueryQueryResponse {
  result?: BitqueryNetworkDataset | null
}

interface AddressBalanceSummary {
  address: string
  annotation?: string
  contractType?: string
  protocolType?: string
  protocolSubtype?: string
  balances: Array<{
    symbol?: string
    tokenAddress?: string
    name?: string
    protocolName?: string
    decimals?: number
    native?: boolean
    fungible?: boolean
    rawBalance?: string
    value?: string
    valueUsd?: string
  }>
}

interface TransferLog {
  direction: 'in' | 'out'
  timestamp?: string
  blockNumber?: number
  txHash?: string
  sender?: string
  receiver?: string
  amount?: string
  symbol?: string
  tokenAddress?: string
  tokenName?: string
  protocolName?: string
  decimals?: number
  native?: boolean
  fungible?: boolean
}

interface ContractInteractionLog {
  timestamp?: string
  blockNumber?: number
  txHash?: string
  caller?: string
  contractAddress?: string
  txTo?: string
  contractAnnotation?: string
  contractType?: string
  protocolType?: string
  protocolSubtype?: string
  method?: string
  signature?: string
}

type TransactionDirection = 'in' | 'out' | 'unknown'

interface TransactionLog {
  timestamp?: string
  blockNumber?: number
  txHash?: string
  direction: TransactionDirection
  from?: string
  to?: string
  value?: string
  valueUsd?: string
  gas?: string
  gasPrice?: string
  nonce?: number
  kind: 'contract' | 'contract_creation' | 'eoa' | 'unknown'
  contractAddress?: string
}

interface TransactionSummary {
  contractInteractions: number
  eoaTransfers: number
  contractCreations: number
  unknown: number
  total: number
}

interface TransferCounterpartySummary {
  direction: 'in' | 'out'
  counterparty: string
  transferCount: number
}

interface NetworkActivitySummary {
  network: string
  balances: AddressBalanceSummary[]
  assetTransfers: TransferLog[]
  contractInteractions: ContractInteractionLog[]
  interactedContracts: ContractInteractionSummary[]
  transferCounterparties: TransferCounterpartySummary[]
  excludedContractInteractions: number
  transactions: TransactionLog[]
  transactionSummary: TransactionSummary
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

function buildNetworkQuery(network: string): string {
  const safeNetwork = sanitizeNetworkName(network)
  return `
    query AddressActivity($addresses: [String!], $limit: Int!, $dataset: dataset_arg_enum!) {
      result: EVM(network: ${safeNetwork}, dataset: $dataset) {
        balances: BalanceUpdates(
          where: { any: [{ BalanceUpdate: { Address: { in: $addresses } } }] }
          orderBy: [{ descending: Block_Time }]
          limit: { count: $limit }
        ) {
          balance: BalanceUpdate {
            address: Address
            amount: Amount
            amountUsd: AmountInUSD
          }
          currency: Currency {
            address: SmartContract
            symbol: Symbol
            name: Name
            protocolName: ProtocolName
            decimals: Decimals
            native: Native
            fungible: Fungible
          }
        }
        transfersSent: Transfers(
          where: { any: [{ Transfer: { Sender: { in: $addresses } } }] }
          orderBy: [{ descending: Block_Time }]
          limit: { count: $limit }
        ) {
          block: Block {
            number: Number
            time: Time
          }
          transaction: Transaction {
            hash: Hash
            to: To
          }
          transfer: Transfer {
            sender: Sender
            receiver: Receiver
            amount: Amount
            amountUsd: AmountInUSD
            currency: Currency {
              address: SmartContract
              symbol: Symbol
              name: Name
              protocolName: ProtocolName
              decimals: Decimals
              native: Native
              fungible: Fungible
            }
          }
        }
        transfersReceived: Transfers(
          where: { any: [{ Transfer: { Receiver: { in: $addresses } } }] }
          orderBy: [{ descending: Block_Time }]
          limit: { count: $limit }
        ) {
          block: Block {
            number: Number
            time: Time
          }
          transaction: Transaction {
            hash: Hash
          }
          transfer: Transfer {
            sender: Sender
            receiver: Receiver
            amount: Amount
            amountUsd: AmountInUSD
            currency: Currency {
              address: SmartContract
              symbol: Symbol
              name: Name
              protocolName: ProtocolName
              decimals: Decimals
              native: Native
              fungible: Fungible
            }
          }
        }
        contractInteractions: Calls(
          where: { any: [{ Call: { From: { in: $addresses } } }] }
          orderBy: [{ descending: Block_Time }]
          limit: { count: $limit }
        ) {
          block: Block {
            number: Number
            time: Time
          }
          transaction: Transaction {
            hash: Hash
          }
          call: Call {
            from: From
            to: To
            value: Value
            valueUsd: ValueInUSD
            signature: Signature {
              name: Name
              signature: Signature
              signatureHash: SignatureHash
            }
          }
        }
        transactions: Transactions(
          where: { any: [
            { Transaction: { From: { in: $addresses } } },
            { Transaction: { To: { in: $addresses } } }
          ] }
          orderBy: [{ descending: Block_Time }]
          limit: { count: $limit }
        ) {
          block: Block {
            number: Number
            time: Time
          }
          transaction: Transaction {
            hash: Hash
            from: From
            to: To
            value: Value
            valueUsd: ValueInUSD
            gas: Gas
            gasPrice: GasPrice
            nonce: Nonce
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

function normalizeTimestamp(timestamp?: string | null): string | undefined {
  if (!timestamp) return undefined
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return timestamp || undefined
  }
  return date.toISOString()
}

function mapBalances(records: BitqueryBalanceEntry[] | null | undefined): AddressBalanceSummary[] {
  if (!records) return []

  const summaries = new Map<string, AddressBalanceSummary>()

  for (const record of records) {
    const address = record.balance?.address
    if (!address) continue

    let summary = summaries.get(address)
    if (!summary) {
      summary = {
        address,
        balances: [],
      }
      summaries.set(address, summary)
    }

    summary.balances.push({
      symbol: record.currency?.symbol ?? undefined,
      tokenAddress: record.currency?.address ?? undefined,
      name: record.currency?.name ?? undefined,
      protocolName: record.currency?.protocolName ?? undefined,
      decimals: record.currency?.decimals ?? undefined,
      native: record.currency?.native ?? undefined,
      fungible: record.currency?.fungible ?? undefined,
      rawBalance: record.balance?.amount ?? undefined,
      value: record.balance?.amount ?? undefined,
      valueUsd: record.balance?.amountUsd ?? undefined,
    })
  }

  return Array.from(summaries.values())
}

function mapTransfers(records: BitqueryTransferEntry[] | null | undefined, direction: 'in' | 'out'): TransferLog[] {
  if (!records) return []

  return records.map(record => {
    const rawBlockNumber = record.block?.number ? Number(record.block.number) : undefined
    const blockNumber = rawBlockNumber !== undefined && !Number.isNaN(rawBlockNumber) ? rawBlockNumber : undefined
    const transfer = record.transfer

    return {
      direction,
      timestamp: normalizeTimestamp(record.block?.time ?? undefined),
      blockNumber,
      txHash: record.transaction?.hash ?? undefined,
      sender: transfer?.sender ?? undefined,
      receiver: transfer?.receiver ?? undefined,
      amount: transfer?.amount ?? undefined,
      symbol: transfer?.currency?.symbol ?? undefined,
      tokenAddress: transfer?.currency?.address ?? undefined,
      tokenName: transfer?.currency?.name ?? undefined,
      protocolName: transfer?.currency?.protocolName ?? undefined,
      decimals: transfer?.currency?.decimals ?? undefined,
      native: transfer?.currency?.native ?? undefined,
      fungible: transfer?.currency?.fungible ?? undefined,
    }
  })
}

function mapContractInteractions(records: BitqueryContractCallEntry[] | null | undefined): {
  logs: ContractInteractionLog[]
  summary: ContractInteractionSummary[]
  excludedDueToTransactionTo: number
  contractTransactionHashes: string[]
  calledContractAddresses: string[]
} {
  if (!records) {
    return { logs: [], summary: [], excludedDueToTransactionTo: 0, contractTransactionHashes: [], calledContractAddresses: [] }
  }

  const logs: ContractInteractionLog[] = []
  const summaryMap = new Map<string, ContractInteractionSummary>()
  let excludedDueToTransactionTo = 0
  const contractTransactionHashes = new Set<string>()
  const calledContractAddresses = new Set<string>()

  for (const record of records) {
    const rawBlockNumber = record.block?.number ? Number(record.block.number) : undefined
    const blockNumber = rawBlockNumber !== undefined && !Number.isNaN(rawBlockNumber) ? rawBlockNumber : undefined
    const caller = record.call?.from ?? undefined
    const contractAddress = record.call?.to ?? undefined
    const transactionTo = record.transaction?.to ?? undefined
    const txHash = record.transaction?.hash ?? undefined

    const log: ContractInteractionLog = {
      timestamp: normalizeTimestamp(record.block?.time ?? undefined),
      blockNumber,
      txHash: record.transaction?.hash ?? undefined,
      caller,
      contractAddress,
      txTo: transactionTo ?? undefined,
      method: record.call?.signature?.name ?? undefined,
      signature: record.call?.signature?.signature ?? undefined,
    }

    logs.push(log)

    if (txHash) {
      contractTransactionHashes.add(txHash.toLowerCase())
    }
    if (contractAddress) {
      calledContractAddresses.add(contractAddress.toLowerCase())
    }

    const key = (contractAddress || '').toLowerCase()
    const matchesTransactionTo = transactionTo && contractAddress && transactionTo.toLowerCase() === contractAddress.toLowerCase()

    if (!key || matchesTransactionTo) {
      if (matchesTransactionTo && key) {
        excludedDueToTransactionTo += 1
      }
      continue
    }

    const existing = summaryMap.get(key)
    if (existing) {
      existing.interactions += 1
    } else {
      summaryMap.set(key, {
        contractAddress: contractAddress!,
        contractAnnotation: undefined,
        contractType: undefined,
        protocolType: undefined,
        protocolSubtype: undefined,
        interactions: 1,
      })
    }
  }

  return {
    logs,
    summary: Array.from(summaryMap.values()),
    excludedDueToTransactionTo,
    contractTransactionHashes: Array.from(contractTransactionHashes.values()),
    calledContractAddresses: Array.from(calledContractAddresses.values()),
  }
}

function summarizeTransferCounterparties(transfers: TransferLog[]): TransferCounterpartySummary[] {
  const summaryMap = new Map<string, TransferCounterpartySummary>()

  for (const transfer of transfers) {
    const direction = transfer.direction
    const counterparty = direction === 'out' ? transfer.receiver : transfer.sender
    if (!counterparty) continue

    const key = `${direction}:${counterparty.toLowerCase()}`
    const existing = summaryMap.get(key)
    if (existing) {
      existing.transferCount += 1
    } else {
      summaryMap.set(key, {
        direction,
        counterparty,
        transferCount: 1,
      })
    }
  }

  return Array.from(summaryMap.values()).sort((a, b) => b.transferCount - a.transferCount)
}

function mapTransactions(
  records: BitqueryTransactionEntry[] | null | undefined,
  trackedAddresses: string[],
  contractTransactionHashes?: string[],
  knownContractAddresses?: string[],
): { logs: TransactionLog[]; summary: TransactionSummary } {
  const summary: TransactionSummary = {
    contractInteractions: 0,
    eoaTransfers: 0,
    contractCreations: 0,
    unknown: 0,
    total: 0,
  }

  if (!records || records.length === 0) {
    return { logs: [], summary }
  }

  const addressSet = new Set(trackedAddresses.map(address => address.toLowerCase()))
  const contractHashSet = new Set((contractTransactionHashes || []).filter(Boolean).map(hash => hash.toLowerCase()))
  const contractAddressSet = new Set((knownContractAddresses || []).filter(Boolean).map(address => address.toLowerCase()))
  const logs: TransactionLog[] = []

  for (const record of records) {
    const rawBlockNumber = record.block?.number ? Number(record.block.number) : undefined
    const blockNumber = rawBlockNumber !== undefined && !Number.isNaN(rawBlockNumber) ? rawBlockNumber : undefined
    const timestamp = normalizeTimestamp(record.block?.time ?? undefined)
    const tx = record.transaction

    const from = tx?.from ?? undefined
    const to = tx?.to ?? undefined
    const normalizedTo = to ? to.toLowerCase() : undefined
    const normalizedHash = tx?.hash ? tx.hash.toLowerCase() : undefined
    const isZeroAddress = normalizedTo === '0x0000000000000000000000000000000000000000'

    let direction: TransactionDirection = 'unknown'
    if (from && addressSet.has(from.toLowerCase())) {
      direction = 'out'
    } else if (to && addressSet.has(to.toLowerCase())) {
      direction = 'in'
    }

    const isContractCreation = !to || normalizedTo === '0x' || isZeroAddress
    const hasKnownCall = normalizedHash ? contractHashSet.has(normalizedHash) : false
    const targetsKnownContract = normalizedTo ? contractAddressSet.has(normalizedTo) : false
    const isContractInteraction = hasKnownCall || targetsKnownContract

    let kind: TransactionLog['kind']
    if (isContractCreation) {
      kind = 'contract_creation'
      summary.contractCreations += 1
    } else if (isContractInteraction) {
      kind = 'contract'
      summary.contractInteractions += 1
    } else if (to || from) {
      kind = 'eoa'
      summary.eoaTransfers += 1
    } else {
      kind = 'unknown'
      summary.unknown += 1
    }

    summary.total += 1

    const nonceRaw = tx?.nonce
    const nonceNumber = typeof nonceRaw === 'number' ? nonceRaw : nonceRaw ? Number(nonceRaw) : undefined
    const nonce = nonceNumber !== undefined && !Number.isNaN(nonceNumber) ? nonceNumber : undefined

    logs.push({
      timestamp,
      blockNumber,
      txHash: tx?.hash ?? undefined,
      direction,
      from,
      to,
      value: tx?.value ?? undefined,
      valueUsd: tx?.valueUsd ?? undefined,
      gas: tx?.gas ?? undefined,
      gasPrice: tx?.gasPrice ?? undefined,
      nonce,
      contractAddress: isContractInteraction && to ? to : undefined,
      kind,
    })
  }

  logs.sort((a, b) => {
    const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0
    return bTime - aTime
  })

  return { logs, summary }
}

async function fetchNetworkActivity({
  network,
  addresses,
  limit,
  apiKey,
  endpoint,
  dataset,
}: {
  network: string
  addresses: string[]
  limit: number
  apiKey: string
  endpoint: string
  dataset: DatasetArg
}): Promise<NetworkActivitySummary> {
  Logger.info(`查询网络 ${network} 的资产与交互日志...`)

  const query = buildNetworkQuery(network)
  const variables = { addresses, limit, dataset }
  const data = await executeBitqueryQuery<BitqueryQueryResponse>({ query, variables, apiKey, endpoint })
  const datasetResult = data.result

  const balances = mapBalances(datasetResult?.balances)
  const transfersOut = mapTransfers(datasetResult?.transfersSent, 'out')
  const transfersIn = mapTransfers(datasetResult?.transfersReceived, 'in')
  const transfers = [...transfersOut, ...transfersIn]

  transfers.sort((a, b) => {
    const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0
    return bTime - aTime
  })

  const {
    logs: contractLogs,
    summary: contractSummaries,
    excludedDueToTransactionTo,
    contractTransactionHashes,
    calledContractAddresses,
  } = mapContractInteractions(datasetResult?.contractInteractions)
  const transferCounterparties = summarizeTransferCounterparties(transfers)
  const { logs: transactionLogs, summary: transactionSummary } = mapTransactions(
    datasetResult?.transactions,
    addresses,
    contractTransactionHashes,
    calledContractAddresses,
  )

  return {
    network,
    balances,
    assetTransfers: transfers,
    contractInteractions: contractLogs,
    interactedContracts: contractSummaries,
    transferCounterparties,
    excludedContractInteractions: excludedDueToTransactionTo,
    transactions: transactionLogs,
    transactionSummary,
  }
}

function buildGlobalSummary(results: NetworkActivitySummary[]) {
  const contractMap = new Map<
    string,
    {
      contractAddress: string
      contractAnnotation?: string
      contractType?: string
      protocolType?: string
      protocolSubtype?: string
      networks: Set<string>
      interactions: number
    }
  >()
  const counterpartyMap = new Map<
    string,
    {
      counterparty: string
      direction: 'in' | 'out'
      networks: Set<string>
      transferCount: number
    }
  >()
  const transactionTotals: TransactionSummary = {
    contractInteractions: 0,
    eoaTransfers: 0,
    contractCreations: 0,
    unknown: 0,
    total: 0,
  }

  for (const result of results) {
    for (const contract of result.interactedContracts) {
      const key = contract.contractAddress.toLowerCase()
      const existing = contractMap.get(key)
      if (existing) {
        existing.interactions += contract.interactions
        existing.networks.add(result.network)
        existing.contractAnnotation = existing.contractAnnotation || contract.contractAnnotation
        existing.contractType = existing.contractType || contract.contractType
        existing.protocolType = existing.protocolType || contract.protocolType
        existing.protocolSubtype = existing.protocolSubtype || contract.protocolSubtype
      } else {
        contractMap.set(key, {
          contractAddress: contract.contractAddress,
          contractAnnotation: contract.contractAnnotation,
          contractType: contract.contractType,
          protocolType: contract.protocolType,
          protocolSubtype: contract.protocolSubtype,
          networks: new Set([result.network]),
          interactions: contract.interactions,
        })
      }
    }

    for (const counterparty of result.transferCounterparties) {
      const key = `${counterparty.direction}:${counterparty.counterparty.toLowerCase()}`
      const existing = counterpartyMap.get(key)
      if (existing) {
        existing.transferCount += counterparty.transferCount
        existing.networks.add(result.network)
      } else {
        counterpartyMap.set(key, {
          counterparty: counterparty.counterparty,
          direction: counterparty.direction,
          networks: new Set([result.network]),
          transferCount: counterparty.transferCount,
        })
      }
    }

    transactionTotals.contractInteractions += result.transactionSummary.contractInteractions
    transactionTotals.eoaTransfers += result.transactionSummary.eoaTransfers
    transactionTotals.contractCreations += result.transactionSummary.contractCreations
    transactionTotals.unknown += result.transactionSummary.unknown
    transactionTotals.total += result.transactionSummary.total
  }

  return {
    interactedContracts: Array.from(contractMap.values()).map(item => ({
      contractAddress: item.contractAddress,
      contractAnnotation: item.contractAnnotation,
      contractType: item.contractType,
      protocolType: item.protocolType,
      protocolSubtype: item.protocolSubtype,
      interactions: item.interactions,
      networks: Array.from(item.networks.values()),
    })),
    transferCounterparties: Array.from(counterpartyMap.values()).map(item => ({
      counterparty: item.counterparty,
      direction: item.direction,
      transferCount: item.transferCount,
      networks: Array.from(item.networks.values()),
    })),
    transactionSummary: transactionTotals,
  }
}

task('bitquery-activity', '使用 Bitquery 查询地址的多链资产及交互日志')
  .addOptionalParam('addresses', '逗号/空格分隔的地址列表')
  .addOptionalParam('file', '包含地址列表的文件路径')
  .addOptionalParam('networks', 'Bitquery 支持的网络列表，逗号分隔', DEFAULT_NETWORKS.join(','))
  .addOptionalParam('limit', '每种日志在每个网络中返回的最大数量', 100, types.int)
  .addOptionalParam('dataset', 'Bitquery 数据集，可选 realtime、archive 或 combined', DEFAULT_DATASET)
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

    if (!apiKey) {
      throw new Error('未找到 Bitquery API Key，请通过 --api-key 参数或设置 BITQUERY_API_KEY 环境变量')
    }

    Logger.info(`Hardhat 网络: ${hre.network.name}`)
    Logger.info(`查询地址数量: ${addresses.length}`)
    Logger.info(`查询网络: ${networks.join(', ')}`)
    Logger.info(`每种日志最大返回数量: ${limit}`)
    Logger.info(`Bitquery 端点: ${endpoint}`)
    Logger.info(`Bitquery 数据集: ${datasetArg}`)

    const results: NetworkActivitySummary[] = []

    for (const network of networks) {
      try {
        const result = await fetchNetworkActivity({ network, addresses, limit, apiKey, endpoint, dataset: datasetArg })
        results.push(result)
        const excludedNote =
          result.excludedContractInteractions > 0
            ? `（其中 ${result.excludedContractInteractions} 条调用因等于交易 To 地址而被排除出统计）`
            : ''
        const txSummary = result.transactionSummary
        const txSummaryParts = [
          `合约交互 ${txSummary.contractInteractions} 条`,
          `普通交易 ${txSummary.eoaTransfers} 条`,
          `合约创建 ${txSummary.contractCreations} 条`,
        ]
        if (txSummary.unknown > 0) {
          txSummaryParts.push(`未知 ${txSummary.unknown} 条`)
        }
        Logger.info(
          `网络 ${network} 查询完成: 余额记录 ${result.balances.length} 条，转账日志 ${result.assetTransfers.length} 条，对手方 ${result.transferCounterparties.length} 个，合约交互 ${result.contractInteractions.length} 条${excludedNote}，交易 ${result.transactions.length} 条（${txSummaryParts.join('，')}）`,
        )
      } catch (error) {
        Logger.error(`查询网络 ${network} 失败`, error)
      }
    }

    const summary = buildGlobalSummary(results)
    const totalExcludedContractInteractions = results.reduce((acc, item) => acc + item.excludedContractInteractions, 0)
    const outputPath = path.resolve(taskArgs.output || DEFAULT_OUTPUT_PATH)
    ensureOutputDirectory(outputPath)

    const payload = {
      metadata: {
        addresses,
        networks,
        limit,
        endpoint,
        dataset: datasetArg,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startTime,
      },
      results,
      summary,
      excludedContractInteractions: totalExcludedContractInteractions,
    }

    writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8')
    Logger.info(`结果已保存到 ${outputPath}`)

    if (summary.transactionSummary.total > 0) {
      const tx = summary.transactionSummary
      const summaryParts = [
        `合约交互 ${tx.contractInteractions} 条`,
        `普通交易 ${tx.eoaTransfers} 条`,
        `合约创建 ${tx.contractCreations} 条`,
      ]
      if (tx.unknown > 0) {
        summaryParts.push(`未知 ${tx.unknown} 条`)
      }
      Logger.info(`所有网络交易汇总: 总计 ${tx.total} 条 (${summaryParts.join('，')})`)
    }

    if (summary.interactedContracts.length > 0) {
      Logger.info('交互过的合约 (按交互次数排序):')
      summary.interactedContracts
        .sort((a, b) => b.interactions - a.interactions)
        .slice(0, 10)
        .forEach((contract, index) => {
          Logger.info(
            `${index + 1}. ${contract.contractAddress} | 合约类型: ${contract.contractType || '-'} | 协议类型: ${contract.protocolType || '-'} | 合作网络: ${contract.networks.join(', ')} | 交互次数: ${contract.interactions}`,
          )
        })
    } else if (totalExcludedContractInteractions > 0) {
      Logger.info(
        `未统计到新的合约交互；检测到 ${totalExcludedContractInteractions} 条调用的目标地址与交易 To 相同，已从统计中排除，可在详细日志中查看。`,
      )
    }

    if (summary.transferCounterparties.length > 0) {
      Logger.info('主要转账对手方 (按出现次数排序):')
      summary.transferCounterparties
        .sort((a, b) => b.transferCount - a.transferCount)
        .slice(0, 10)
        .forEach((counterparty, index) => {
          Logger.info(
            `${index + 1}. ${counterparty.counterparty} | 方向: ${counterparty.direction} | 涉及网络: ${counterparty.networks.join(', ')} | 记录次数: ${counterparty.transferCount}`,
          )
        })
    }
  })
