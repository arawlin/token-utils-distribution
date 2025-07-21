import { randomBytes } from 'crypto'
import type { Provider, Wallet } from 'ethers'
import { ethers } from 'ethers'
import { getInstitutionGroups } from '../config/institutions'
import { DistributionSystemConfig, GasDistributionConfig, InstitutionNode } from '../types'

// 生成正态分布随机数（Box-Muller变换）
export function generateNormalDistribution(mean: number, stdDev: number): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random() // 转换 [0,1) 到 (0,1)
  while (v === 0) v = Math.random()

  const z0 = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return z0 * stdDev + mean
}

// 生成符合正态分布的Token数量
export function generateNormalDistributionAmount(mean: string, stdDev: string): bigint {
  const meanNum = parseFloat(mean)
  const stdDevNum = parseFloat(stdDev)

  let amount = generateNormalDistribution(meanNum, stdDevNum)
  // 确保数量为正数
  amount = Math.max(amount, meanNum * 0.1)

  return BigInt(Math.floor(amount))
}

// 生成泊松过程的时间间隔（指数分布）
export function generatePoissonInterval(lambda: number): number {
  // lambda: 每小时的平均交易数
  // 返回毫秒间隔
  const rate = lambda / 3600000 // 转换为每毫秒的速率
  return Math.floor(-Math.log(1.0 - Math.random()) / rate)
}

// 生成随机Gas价格
export function generateRandomGasPrice(min: number, max: number): bigint {
  const randomGwei = Math.random() * (max - min) + min
  return ethers.parseUnits(randomGwei.toFixed(2), 'gwei')
}

// 生成随机ETH数量（模拟真实用户行为的精度）
export function generateRandomEthAmount(min: string, max: string): bigint {
  const minNum = parseFloat(min)
  const maxNum = parseFloat(max)

  // 计算最小值的小数位数
  const minDecimals = (min.split('.')[1] || '').length
  // 精度最多比min小两位，但至少保持4位小数（模拟真实用户）
  const precision = Math.max(4, minDecimals + 1)

  // 生成随机数
  const randomAmount = Math.random() * (maxNum - minNum) + minNum

  // 根据计算的精度进行四舍五入，模拟用户行为
  // 用户通常不会使用超过6位小数的ETH金额
  const finalPrecision = Math.min(precision, 6)
  const roundedAmount = Math.round(randomAmount * Math.pow(10, finalPrecision)) / Math.pow(10, finalPrecision)

  return ethers.parseEther(roundedAmount.toFixed(finalPrecision))
}

// 从HD钱包路径生成钱包
export function generateWalletFromPath(masterSeed: string, hdPath: string, index: number): ethers.Wallet {
  const hdNode = ethers.HDNodeWallet.fromSeed(masterSeed)
  const childHdNode = hdNode.derivePath(`${hdPath}/${index}`)
  return new ethers.Wallet(childHdNode.privateKey)
}

// 生成机构节点的所有地址
export async function generateInstitutionAddresses(masterSeed: string, node: InstitutionNode): Promise<void> {
  const addresses: string[] = []
  const privateKeys: string[] = []

  for (let i = 0; i < node.addressCount; i++) {
    const wallet = generateWalletFromPath(masterSeed, node.hdPath, i)
    addresses.push(wallet.address)
    privateKeys.push(wallet.privateKey)
  }

  node.addresses = addresses
  node.privateKeys = privateKeys

  // 递归生成子节点地址
  for (const childNode of node.childNodes) {
    await generateInstitutionAddresses(masterSeed, childNode)
  }
}

// 生成安全的主种子
export function generateMasterSeed(): string {
  return ethers.hexlify(randomBytes(32))
}

// 生成中间钱包地址和私钥
export function generateIntermediateWallets(masterSeed: string, config: GasDistributionConfig): void {
  const intermediateWallets = []

  // 生成Gas分发中间钱包
  const gasConfig = config.intermediateWallets
  Logger.debug(`生成Gas分发中间钱包: ${gasConfig.count} 个`)

  for (let i = 0; i < gasConfig.count; i++) {
    const wallet = generateWalletFromPath(masterSeed, gasConfig.hdPath, i)
    intermediateWallets.push({
      address: wallet.address,
      privateKey: wallet.privateKey,
    })
    Logger.debug(`Gas中间钱包 ${i}: ${wallet.address}`)
  }

  config.intermediateWallets.wallets = intermediateWallets
}

// 格式化ETH数量显示
export function formatEther(amount: bigint): string {
  return ethers.formatEther(amount)
}

// 格式化Token数量显示
export function formatTokenAmount(amount: bigint, decimals: number = 18): string {
  return ethers.formatUnits(amount, decimals)
}

// 生成随机Token数量（支持末尾零控制）
export function generateRandomTokenAmount(
  minAmount: string,
  maxAmount: string,
  decimals: number,
  precision?: number,
  trailingZeros?: number,
): bigint {
  const minNum = parseFloat(minAmount)
  const maxNum = parseFloat(maxAmount)

  if (minNum >= maxNum) {
    throw new Error('最小金额必须小于最大金额')
  }

  // 生成基础随机数
  let randomAmount = Math.random() * (maxNum - minNum) + minNum

  // 应用精度设置
  if (precision !== undefined && precision >= 0) {
    const multiplier = Math.pow(10, precision)
    randomAmount = Math.round(randomAmount * multiplier) / multiplier
  }

  // 应用末尾零控制
  if (trailingZeros !== undefined && trailingZeros > 0) {
    const divisor = Math.pow(10, trailingZeros)
    // 确保末尾至少有指定数量的零
    randomAmount = Math.floor(randomAmount / divisor) * divisor

    // 如果结果为0，至少保证一个有效的数值
    if (randomAmount === 0) {
      randomAmount = divisor
    }
  }

  // 转换为最小单位（考虑token的decimals）
  return ethers.parseEther(randomAmount + '')
}

// 延迟执行
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 重试机制
export async function retry<T>(fn: () => Promise<T>, maxRetries: number = 3, baseDelay: number = 1000): Promise<T> {
  let lastError: Error

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      if (i === maxRetries) break

      const delayMs = baseDelay * Math.pow(2, i) // 指数退避
      await delay(delayMs)
    }
  }

  throw lastError!
}

// 验证以太坊地址
export function isValidAddress(address: string): boolean {
  return ethers.isAddress(address)
}

// 验证私钥
export function isValidPrivateKey(privateKey: string): boolean {
  try {
    new ethers.Wallet(privateKey)
    return true
  } catch {
    return false
  }
}

// 生成任务ID
export function generateTaskId(): string {
  return ethers.hexlify(randomBytes(16))
}

// 计算交易费用
export function calculateTransactionCost(gasUsed: bigint, gasPrice: bigint): bigint {
  return gasUsed * gasPrice
}

// 获取当前时间戳
export function getCurrentTimestamp(): number {
  return Date.now()
}

// 打乱数组顺序
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// 分批处理数组
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}

// 日志工具
export class Logger {
  private static logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'

  static setLogLevel(level: 'debug' | 'info' | 'warn' | 'error') {
    this.logLevel = level
  }

  static debug(message: string, data?: unknown) {
    if (this.shouldLog('debug')) {
      console.log(`[DEBUG] ${new Date().toISOString()}: ${message}`, data || '')
    }
  }

  static info(message: string, data?: unknown) {
    if (this.shouldLog('info')) {
      console.log(`[INFO] ${new Date().toISOString()}: ${message}`, data || '')
    }
  }

  static warn(message: string, data?: unknown) {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${new Date().toISOString()}: ${message}`, data || '')
    }
  }

  static error(message: string, error?: unknown) {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${new Date().toISOString()}: ${message}`, error || '')
    }
  }

  private static shouldLog(level: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.logLevel)
  }
}

// 加载所有钱包地址
export async function loadAllWallets(
  masterSeed: string,
  config: DistributionSystemConfig,
  provider: Provider,
): Promise<Map<string, Wallet>> {
  const wallets = new Map<string, Wallet>()

  // 1. 加载中间钱包
  Logger.info('加载中间钱包...')
  const gasConfig = config.gasDistribution
  const tokenConfig = config.tokenDistribution

  // Gas分发中间钱包
  if (gasConfig?.intermediateWallets) {
    for (let i = 0; i < gasConfig.intermediateWallets.count; i++) {
      const wallet = generateWalletFromPath(masterSeed, gasConfig.intermediateWallets.hdPath, i).connect(provider)

      wallets.set(wallet.address.toLowerCase(), wallet)
      Logger.debug(`Gas中间钱包 ${i}: ${wallet.address}`)
    }
  }

  // Token分发中间钱包 - 注意：TokenDistributionConfig可能没有intermediateWallets字段
  // 这里我们暂时跳过，因为类型定义中没有这个字段

  // 2. 加载所有机构地址
  Logger.info('加载机构地址...')
  const institutionGroups = getInstitutionGroups(config.institutionTree)

  for (const group of institutionGroups) {
    Logger.debug(`加载机构: ${group.institutionName} (${group.addresses.length} 个地址)`)

    for (let i = 0; i < group.addresses.length; i++) {
      const wallet = generateWalletFromPath(masterSeed, group.hdPath, i).connect(provider)

      wallets.set(wallet.address.toLowerCase(), wallet)
      Logger.debug(`  ${group.institutionName}[${i}]: ${wallet.address}`)
    }
  }

  // 3. 加载交易所钱包（如果配置中有私钥）
  Logger.info('加载交易所钱包...')
  if (gasConfig?.exchangeSources) {
    for (const source of gasConfig.exchangeSources) {
      if (source.privateKey) {
        try {
          const wallet = new ethers.Wallet(source.privateKey, provider)
          wallets.set(wallet.address.toLowerCase(), wallet)
          Logger.debug(`交易所钱包: ${wallet.address}`)
        } catch {
          Logger.warn(`无效的交易所私钥: ${source.address}`)
        }
      }
    }
  }

  // Token交易所钱包 - 注意：TokenDistributionConfig可能没有exchangeSources字段
  // 检查tokenConfig.sourceAddress
  if (tokenConfig?.sourceAddress?.privateKey) {
    try {
      const wallet = new ethers.Wallet(tokenConfig.sourceAddress.privateKey, provider)
      wallets.set(wallet.address.toLowerCase(), wallet)
      Logger.debug(`Token源钱包: ${wallet.address}`)
    } catch {
      Logger.warn(`无效的Token源钱包私钥: ${tokenConfig.sourceAddress.address}`)
    }
  }

  return wallets
}

// 确定钱包类别
export function determineWalletCategory(address: string, config: DistributionSystemConfig): string {
  const lowerAddress = address.toLowerCase()

  // 检查是否是交易所钱包
  if (config.gasDistribution?.exchangeSources) {
    for (const source of config.gasDistribution.exchangeSources) {
      if (source.address.toLowerCase() === lowerAddress) {
        return 'Gas交易所钱包'
      }
    }
  }

  // 检查是否是Token源钱包
  if (config.tokenDistribution?.sourceAddress?.address.toLowerCase() === lowerAddress) {
    return 'Token源钱包'
  }

  // 检查是否是Gas分发中间钱包
  if (config.gasDistribution?.intermediateWallets?.wallets) {
    for (const wallet of config.gasDistribution.intermediateWallets.wallets) {
      if (wallet.address.toLowerCase() === lowerAddress) {
        return 'Gas中间钱包'
      }
    }
  }

  // 默认归类为机构地址
  return '机构地址'
}

// 创建时间戳文件名
export function createTimestampFilename(prefix: string, extension: string = 'json'): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0] // YYYY-MM-DD
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-') // HH-MM-SS
  return `${prefix}-${date}_${time}.${extension}`
}
