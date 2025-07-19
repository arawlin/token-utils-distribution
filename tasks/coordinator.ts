import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import type { Provider } from 'ethers'
import { Logger } from './utils'

export interface TaskLockInfo {
  taskId: string
  taskName: string
  startTime: number
  pid: number
  status: 'running' | 'completed' | 'failed'
}

export interface ResourceUsage {
  nonce: number
  gasUsed: bigint
  lastUpdate: number
}

/**
 * 任务协调器 - 管理并发任务的资源竞争和状态同步
 */
export class TaskCoordinator {
  private lockDir: string
  private resourceFile: string
  private lockFile: string

  constructor(configDir: string = './.ws') {
    this.lockDir = configDir
    this.resourceFile = join(configDir, 'resource-usage.json')
    this.lockFile = join(configDir, 'task-locks.json')
  }

  /**
   * 获取任务锁，防止重复执行
   */
  async acquireTaskLock(taskName: string): Promise<string> {
    const taskId = `${taskName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    let existingLocks: TaskLockInfo[] = []
    if (existsSync(this.lockFile)) {
      try {
        existingLocks = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      } catch (error) {
        Logger.warn('读取锁文件失败，将创建新的锁文件:', error)
        existingLocks = []
      }
    }

    // 清理过期的锁（超过1小时）
    const now = Date.now()
    existingLocks = existingLocks.filter(lock => now - lock.startTime < 60 * 60 * 1000 && lock.status === 'running')

    // 检查是否有相同任务正在运行
    const runningTask = existingLocks.find(lock => lock.taskName === taskName && lock.status === 'running')

    if (runningTask) {
      Logger.warn(`任务 ${taskName} 已在运行中 (任务ID: ${runningTask.taskId})`)
      // 不抛出错误，而是等待一段时间后重试
      await this.delay(5000)
      return this.acquireTaskLock(taskName)
    }

    // 添加新的锁
    const newLock: TaskLockInfo = {
      taskId,
      taskName,
      startTime: now,
      pid: process.pid,
      status: 'running',
    }

    existingLocks.push(newLock)
    writeFileSync(this.lockFile, JSON.stringify(existingLocks, null, 2))

    Logger.info(`获取任务锁: ${taskName} (任务ID: ${taskId})`)
    return taskId
  }

  /**
   * 释放任务锁
   */
  async releaseTaskLock(taskId: string, status: 'completed' | 'failed' = 'completed'): Promise<void> {
    if (!existsSync(this.lockFile)) return

    try {
      const existingLocks: TaskLockInfo[] = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      const lockIndex = existingLocks.findIndex(lock => lock.taskId === taskId)

      if (lockIndex >= 0) {
        existingLocks[lockIndex].status = status
        writeFileSync(this.lockFile, JSON.stringify(existingLocks, null, 2))
        Logger.info(`释放任务锁: ${taskId} (状态: ${status})`)
      }
    } catch (error) {
      Logger.warn('释放锁时出错:', error)
    }
  }

  /**
   * 获取下一个可用的nonce（避免nonce冲突）
   */
  async getNextNonce(walletAddress: string, provider: Provider): Promise<number> {
    let resourceUsage: Record<string, ResourceUsage> = {}

    if (existsSync(this.resourceFile)) {
      try {
        resourceUsage = JSON.parse(readFileSync(this.resourceFile, 'utf8'))
      } catch (error) {
        Logger.warn('读取资源使用文件失败:', error)
      }
    }

    // 从链上获取最新nonce
    const chainNonce = await provider.getTransactionCount(walletAddress, 'pending')

    // 获取本地记录的nonce
    const localUsage = resourceUsage[walletAddress]
    const localNonce = localUsage ? localUsage.nonce + 1 : chainNonce

    // 使用较大的nonce值
    const nextNonce = Math.max(chainNonce, localNonce)

    // 更新本地记录
    resourceUsage[walletAddress] = {
      nonce: nextNonce,
      gasUsed: localUsage?.gasUsed || 0n,
      lastUpdate: Date.now(),
    }

    writeFileSync(this.resourceFile, JSON.stringify(resourceUsage, null, 2))

    Logger.debug(`获取nonce: ${walletAddress} -> ${nextNonce}`)
    return nextNonce
  }

  /**
   * 检查钱包余额是否足够
   */
  async checkWalletBalance(
    walletAddress: string,
    requiredAmount: bigint,
    provider: Provider,
  ): Promise<{ sufficient: boolean; current: bigint; required: bigint }> {
    try {
      const balance = await provider.getBalance(walletAddress)
      const sufficient = balance >= requiredAmount

      return {
        sufficient,
        current: balance,
        required: requiredAmount,
      }
    } catch (error) {
      Logger.error(`检查余额失败: ${walletAddress}`, error)
      return {
        sufficient: false,
        current: 0n,
        required: requiredAmount,
      }
    }
  }

  /**
   * 智能重试机制
   */
  async smartRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number
      baseDelay?: number
      backoffMultiplier?: number
      retryCondition?: (error: Error) => boolean
    } = {},
  ): Promise<T> {
    const { maxRetries = 3, baseDelay = 1000, backoffMultiplier = 2, retryCondition = () => true } = options

    let lastError: Error = new Error('Unknown error')
    let delay = baseDelay

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        lastError = err

        if (attempt === maxRetries || !retryCondition(err)) {
          throw err
        }

        // 检查是否是可重试的错误
        const errorMessage = err.message?.toLowerCase() || ''
        const isRetryable =
          errorMessage.includes('nonce') ||
          errorMessage.includes('replacement') ||
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('insufficient')

        if (!isRetryable) {
          throw err
        }

        Logger.warn(`操作失败，${delay}ms后重试 (${attempt + 1}/${maxRetries + 1}):`, err.message)
        await this.delay(delay)
        delay *= backoffMultiplier
      }
    }

    throw lastError
  }

  /**
   * 获取网络gas价格建议
   */
  async getGasPriceRecommendation(provider: Provider): Promise<{
    slow: bigint
    standard: bigint
    fast: bigint
  }> {
    try {
      // 尝试获取EIP-1559 gas price
      if (provider.getFeeData) {
        const feeData = await provider.getFeeData()
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          const base = feeData.maxFeePerGas
          return {
            slow: (base * 8n) / 10n, // 80%
            standard: base, // 100%
            fast: (base * 12n) / 10n, // 120%
          }
        }
      }

      // 回退到传统gas price
      const gasPrice = await (provider as unknown as { getGasPrice(): Promise<bigint> }).getGasPrice()
      return {
        slow: (gasPrice * 8n) / 10n,
        standard: gasPrice,
        fast: (gasPrice * 12n) / 10n,
      }
    } catch (error) {
      Logger.warn('获取gas price失败，使用默认值:', error)
      // 默认值 (20 Gwei)
      const defaultGasPrice = ethers.parseUnits('20', 'gwei')
      return {
        slow: (defaultGasPrice * 8n) / 10n,
        standard: defaultGasPrice,
        fast: (defaultGasPrice * 12n) / 10n,
      }
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 清理资源文件
   */
  async cleanup(): Promise<void> {
    try {
      // 清理过期的资源使用记录
      if (existsSync(this.resourceFile)) {
        const resourceUsage: Record<string, ResourceUsage> = JSON.parse(readFileSync(this.resourceFile, 'utf8'))
        const now = Date.now()

        Object.keys(resourceUsage).forEach(address => {
          if (now - resourceUsage[address].lastUpdate > 24 * 60 * 60 * 1000) {
            // 24小时
            delete resourceUsage[address]
          }
        })

        writeFileSync(this.resourceFile, JSON.stringify(resourceUsage, null, 2))
      }

      // 清理过期的锁
      if (existsSync(this.lockFile)) {
        const locks: TaskLockInfo[] = JSON.parse(readFileSync(this.lockFile, 'utf8'))
        const validLocks = locks.filter(
          lock => Date.now() - lock.startTime < 60 * 60 * 1000, // 1小时
        )

        writeFileSync(this.lockFile, JSON.stringify(validLocks, null, 2))
      }
    } catch (error) {
      Logger.warn('清理资源文件时出错:', error)
    }
  }
}

export const coordinator = new TaskCoordinator()
