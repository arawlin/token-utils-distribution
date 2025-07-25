import { ethers } from 'ethers'
import { Logger } from './utils'

// 交易确认超时配置
export interface TransactionTimeoutConfig {
  confirmations: number // 确认数量
  timeoutMs: number // 超时时间（毫秒）
  maxRetries: number // 最大重试次数
  retryDelayMs: number // 重试间隔（毫秒）
}

// 默认配置
export const DEFAULT_TIMEOUT_CONFIG: TransactionTimeoutConfig = {
  confirmations: 1,
  timeoutMs: 60000, // 60秒
  maxRetries: 3,
  retryDelayMs: 5000, // 5秒
}

// 网络特定的超时配置
export const NETWORK_TIMEOUT_CONFIGS: Record<string, TransactionTimeoutConfig> = {
  mainnet: {
    confirmations: 3,
    timeoutMs: 300000, // 5分钟
    maxRetries: 5,
    retryDelayMs: 10000, // 10秒
  },
  sepolia: {
    confirmations: 2,
    timeoutMs: 120000, // 2分钟
    maxRetries: 3,
    retryDelayMs: 5000, // 5秒
  },
  localhost: {
    confirmations: 1,
    timeoutMs: 30000, // 30秒
    maxRetries: 2,
    retryDelayMs: 2000, // 2秒
  },
  hardhat: {
    confirmations: 1,
    timeoutMs: 10000, // 10秒
    maxRetries: 1,
    retryDelayMs: 1000, // 1秒
  },
}

/**
 * 获取网络特定的超时配置
 */
export function getTimeoutConfig(networkName: string): TransactionTimeoutConfig {
  return NETWORK_TIMEOUT_CONFIGS[networkName] || DEFAULT_TIMEOUT_CONFIG
}

/**
 * 带超时和重试的交易确认等待
 */
export async function waitForTransactionWithTimeout(
  tx: ethers.TransactionResponse,
  config?: Partial<TransactionTimeoutConfig>,
  networkName = 'localhost',
): Promise<ethers.TransactionReceipt | null> {
  const finalConfig = {
    ...getTimeoutConfig(networkName),
    ...config,
  }

  const { confirmations, timeoutMs, maxRetries, retryDelayMs } = finalConfig

  Logger.info(`等待交易确认: ${tx.hash}`)
  Logger.info(`配置: ${confirmations}个确认, ${timeoutMs}ms超时, 最多重试${maxRetries}次`)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      Logger.info(`第 ${attempt}/${maxRetries} 次尝试确认交易...`)

      // 在 ethers v6 中，wait() 方法的签名是：
      // wait(confirmations?: number, timeout?: number): Promise<TransactionReceipt | null>
      const receipt = await tx.wait(confirmations, timeoutMs)

      if (receipt) {
        Logger.info(`✅ 交易确认成功: ${tx.hash}`)
        Logger.info(`区块号: ${receipt.blockNumber}, Gas使用: ${receipt.gasUsed}`)
        return receipt
      } else {
        Logger.warn(`⚠️ 交易返回空收据: ${tx.hash}`)
        if (attempt < maxRetries) {
          Logger.info(`等待 ${retryDelayMs}ms 后重试...`)
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          continue
        }
        return null
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      // 检查是否是超时错误
      if (errorMsg.includes('timeout') || errorMsg.includes('TIMEOUT')) {
        Logger.warn(`⏰ 交易确认超时 (尝试 ${attempt}/${maxRetries}): ${tx.hash}`)

        if (attempt < maxRetries) {
          Logger.info(`等待 ${retryDelayMs}ms 后重试...`)
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          continue
        } else {
          Logger.error(`❌ 交易确认最终超时: ${tx.hash}`)
          throw new Error(`Transaction confirmation timeout after ${maxRetries} attempts: ${tx.hash}`)
        }
      }

      // 其他错误直接抛出
      Logger.error(`❌ 交易确认失败: ${tx.hash}`, error)
      throw error
    }
  }

  throw new Error(`Transaction confirmation failed after ${maxRetries} attempts: ${tx.hash}`)
}

/**
 * 创建带超时的 Promise
 */
export function createTimeoutPromise<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage?: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    // 清理定时器
    void promise.finally(() => clearTimeout(timer))
  })

  return Promise.race([promise, timeoutPromise])
}

/**
 * 增强的交易发送和确认
 */
export async function sendTransactionWithTimeout(
  wallet: ethers.Wallet,
  transaction: ethers.TransactionRequest,
  config?: Partial<TransactionTimeoutConfig>,
  networkName = 'localhost',
): Promise<ethers.TransactionReceipt | null> {
  const timeoutConfig = {
    ...getTimeoutConfig(networkName),
    ...config,
  }

  Logger.info(`发送交易到 ${transaction.to}`)

  // 发送交易时也可以设置超时
  const tx = await createTimeoutPromise(
    wallet.sendTransaction(transaction),
    30000, // 30秒发送超时
    'Transaction send timeout',
  )

  Logger.info(`交易已发送: ${tx.hash}`)

  // 等待确认
  return waitForTransactionWithTimeout(tx, timeoutConfig, networkName)
}
