import { ethers } from 'ethers'
import { task, types } from 'hardhat/config'
import { Logger } from './utils'

/**
 * 任务: derive-path-addresses
 * 功能: 提供一个私钥，按从短到长的路径依次导出钱包地址并打印。
 *
 * 参数:
 *  - privateKey (必填): 32字节私钥。支持带/不带 0x 前缀。
 *  - basePath (可选): 渐进路径的基底，默认 "m/44'/60'/0'/0"。
 *  - count (可选): 在最终基底下追加的索引数量（0..count-1），默认 5。
 *  - showPrivateKeys (flag): 额外打印对应私钥（默认不打印）。
 */
task('derive-path-addresses', '根据私钥按由短到长的路径导出并打印地址')
  .addParam('privateKey', '用于生成 HD 根节点的私钥（32字节十六进制）')
  .addOptionalParam('basePath', '渐进路径基底', "m/44'/60'/0'/0'/0")
  .addOptionalParam('count', '最终路径下追加索引的数量（0..count-1）', 5, types.int)
  .addFlag('showPrivateKeys', '是否打印对应的私钥（谨慎使用）')
  .setAction(async (args, hre) => {
    const { privateKey, basePath, count, showPrivateKeys } = args as {
      privateKey: string
      basePath: string
      count: number
      showPrivateKeys: boolean
    }

    // 初始化日志器（如果未初始化）
    if (!Logger.isInitialized()) {
      Logger.setLogFile()
    }

    try {
      const normalizedPk = normalizePrivateKey(privateKey)
      // 使用私钥字节作为 seed 构造 HD 根（非标准，但可用于内部派生演示）
      const seedBytes = ethers.getBytes(normalizedPk)
      const root = ethers.HDNodeWallet.fromSeed(seedBytes)

      const normalizedBase = normalizeBasePath(basePath)
      const progressivePaths = buildProgressivePaths(normalizedBase)

      Logger.info(`根指纹: ${root.fingerprint}`)
      Logger.info(`基底路径: ${normalizedBase}，索引数量: ${count}`)
      Logger.info('开始派生:')

      const provider = hre.ethers.provider

      const printEntry = async (path: string) => {
        const node = root.derivePath(path)
        const wallet = new ethers.Wallet(node.privateKey)
        let balanceStr = 'N/A'
        try {
          const balance = await provider.getBalance(wallet.address)
          balanceStr = `${ethers.formatEther(balance)} ETH`
        } catch {
          Logger.warn(`获取余额失败: ${wallet.address}`)
        }
        const baseMsg = `${path} -> ${wallet.address} | balance: ${balanceStr}`
        if (showPrivateKeys) {
          Logger.info(`${baseMsg} | pk: ${wallet.privateKey}`)
        } else {
          Logger.info(baseMsg)
        }
      }

      // 由短到长：每个路径打印 count 个子索引地址
      for (const p of progressivePaths) {
        Logger.info(`\n[路径] ${p}`)
        const n = Math.max(0, count)
        for (let i = 0; i < n; i++) {
          const childPath = `${p}/${i}`
          await printEntry(childPath)
        }
      }

      Logger.info('派生完成。')
    } catch (err) {
      Logger.error('派生失败', err)
      throw err
    }
  })

function normalizePrivateKey(pk: string): string {
  const hex = pk.startsWith('0x') ? pk : `0x${pk}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('privateKey 必须是32字节十六进制字符串（64个hex字符）')
  }
  return hex.toLowerCase()
}

function normalizeBasePath(path: string): string {
  let p = path.trim()
  if (p === '' || p === 'm') return 'm'
  if (!p.startsWith('m')) p = `m/${p}`
  p = p.replace(/\\/g, '/').replace(/\/+/, '/') // 规范斜杠
  return p
}

function buildProgressivePaths(basePath: string): string[] {
  // 将 basePath 拆分，并从 m 开始逐段累进
  const parts = basePath.split('/').filter(Boolean) // e.g., ['m', "44'", "60'", "0'", '0']
  const result: string[] = []
  let acc = parts[0] === 'm' ? 'm' : 'm'
  result.push(acc) // m
  for (let i = 1; i < parts.length; i++) {
    acc = `${acc}/${parts[i]}`
    result.push(acc)
  }
  return result
}
