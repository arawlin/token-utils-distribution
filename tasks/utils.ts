import { ethers } from 'ethers'
import { randomBytes } from 'crypto'
import { InstitutionNode } from '../types'

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

// 生成随机ETH数量
export function generateRandomEthAmount(min: string, max: string): bigint {
  const minNum = parseFloat(min)
  const maxNum = parseFloat(max)
  const randomAmount = Math.random() * (maxNum - minNum) + minNum
  return ethers.parseEther(randomAmount.toFixed(18))
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

// 格式化ETH数量显示
export function formatEther(amount: bigint): string {
  return ethers.formatEther(amount)
}

// 格式化Token数量显示
export function formatTokenAmount(amount: bigint, decimals: number = 18): string {
  return ethers.formatUnits(amount, decimals)
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
