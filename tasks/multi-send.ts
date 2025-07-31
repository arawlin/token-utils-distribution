import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { createTimestampFilename, Logger } from './utils'

interface CSVRecord {
  address: string
  amount: string
  amountBigInt: bigint
}

interface MultiSendResult {
  success: boolean
  txHash?: string
  gasUsed?: bigint
  gasPrice?: bigint
  totalGasCost?: bigint
  error?: string
  recipientCount: number
  totalAmount: string
}

// 解析 CSV 文件
function parseCSV(csvContent: string, decimals: number = 18): CSVRecord[] {
  const lines = csvContent.trim().split('\n')
  if (lines.length === 0) {
    throw new Error('CSV 文件为空')
  }

  const records: CSVRecord[] = []
  const headers = lines[0]
    .toLowerCase()
    .split(',')
    .map(h => h.trim())

  // 检查必需的列
  const addressIndex = headers.findIndex(h => h.includes('address') || h.includes('addr') || h.includes('to'))
  const amountIndex = headers.findIndex(h => h.includes('amount') || h.includes('value') || h.includes('balance'))

  if (addressIndex === -1) {
    throw new Error('CSV 文件中未找到地址列 (应包含 "address", "addr" 或 "to")')
  }
  if (amountIndex === -1) {
    throw new Error('CSV 文件中未找到金额列 (应包含 "amount", "value" 或 "balance")')
  }

  // 解析数据行
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim())
    if (values.length < Math.max(addressIndex, amountIndex) + 1) {
      Logger.warn(`第 ${i + 1} 行数据格式不正确，跳过: ${lines[i]}`)
      continue
    }

    const address = values[addressIndex]
    const amountStr = values[amountIndex]

    // 验证地址格式
    if (!ethers.isAddress(address)) {
      Logger.warn(`第 ${i + 1} 行地址格式不正确，跳过: ${address}`)
      continue
    }

    // 解析金额
    try {
      const amountBigInt = ethers.parseUnits(amountStr, decimals)
      if (amountBigInt <= 0n) {
        Logger.warn(`第 ${i + 1} 行金额必须大于0，跳过: ${amountStr}`)
        continue
      }

      records.push({
        address,
        amount: amountStr,
        amountBigInt,
      })
    } catch {
      Logger.warn(`第 ${i + 1} 行金额解析失败，跳过: ${amountStr}`)
      continue
    }
  }

  return records
}

task('multi-send', '使用 MultiSend 合约批量发送 ETH 或 ERC20 代币')
  .addParam('csv', 'CSV 文件路径 (包含 address 和 amount 列)')
  .addParam('type', '发送类型: eth 或 token')
  .addOptionalParam('tokenAddress', 'Token 合约地址 (type=token 时必需)', process.env.TOKEN_ADDRESS)
  .addOptionalParam('multiSendAddress', 'MultiSend 合约地址', process.env.MULTISEND_ADDRESS)
  .addOptionalParam('gasPrice', 'Gas 价格 (gwei)', '')
  .addOptionalParam('gasLimit', 'Gas 限制', '')
  .addOptionalParam('from', '发送者钱包地址 (如果不指定，使用默认签名者)')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('approve', '是否自动 approve token (type=token 时)', 'true')
  .addOptionalParam('dryRun', '是否仅模拟执行，不实际发送交易', 'false')
  .setAction(async (taskArgs, hre) => {
    const { csv, type, tokenAddress, multiSendAddress, gasPrice, gasLimit, from, configDir, approve, dryRun } = taskArgs

    try {
      // 初始化日志
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').split('.')[0]
      const logFilename = `multi-send-${type}-${hre.network.name}-${timestamp}.log`
      Logger.setLogFile(logFilename)

      Logger.info('🚀 开始执行 MultiSend 批量发送任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`发送类型: ${type.toUpperCase()}`)
      Logger.info(`CSV 文件: ${csv}`)
      Logger.info(`模拟执行: ${dryRun === 'true' ? '是' : '否'}`)

      // 验证参数
      if (!['eth', 'token'].includes(type.toLowerCase())) {
        throw new Error('type 参数必须是 "eth" 或 "token"')
      }

      if (type.toLowerCase() === 'token' && !tokenAddress) {
        throw new Error('发送 token 时必须指定 tokenAddress 参数')
      }

      if (!multiSendAddress) {
        throw new Error('未指定 MultiSend 合约地址，请设置 --multiSendAddress 参数或环境变量 MULTISEND_ADDRESS')
      }

      if (!ethers.isAddress(multiSendAddress)) {
        throw new Error('无效的 MultiSend 合约地址')
      }

      // 检查 CSV 文件
      if (!existsSync(csv)) {
        throw new Error(`CSV 文件不存在: ${csv}`)
      }

      // 读取和解析 CSV
      Logger.info('📄 读取 CSV 文件...')
      const csvContent = readFileSync(csv, 'utf8')

      let decimals = 18 // ETH 默认 18 位小数
      let tokenSymbol = 'ETH'
      let tokenContract: ethers.Contract | null = null

      // 如果是 token 类型，获取 token 信息
      if (type.toLowerCase() === 'token') {
        if (!ethers.isAddress(tokenAddress!)) {
          throw new Error('无效的 Token 合约地址')
        }

        tokenContract = new ethers.Contract(
          tokenAddress!,
          [
            'function decimals() view returns (uint8)',
            'function symbol() view returns (string)',
            'function name() view returns (string)',
            'function balanceOf(address) view returns (uint256)',
            'function allowance(address,address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)',
          ],
          hre.ethers.provider,
        )

        try {
          decimals = await tokenContract.decimals()
          tokenSymbol = await tokenContract.symbol()
          const tokenName = await tokenContract.name()
          Logger.info(`Token 信息: ${tokenName} (${tokenSymbol}), 小数位: ${decimals}`)
        } catch (error) {
          throw new Error(`无法获取 Token 信息，请检查合约地址: ${error}`)
        }
      }

      const records = parseCSV(csvContent, decimals)
      Logger.info(`✅ 成功解析 ${records.length} 条有效记录`)

      if (records.length === 0) {
        throw new Error('没有有效的发送记录')
      }

      // 计算总金额
      const totalAmount = records.reduce((sum, record) => sum + record.amountBigInt, 0n)
      Logger.info(`📊 发送统计:`)
      Logger.info(`   接收地址数量: ${records.length}`)
      Logger.info(`   总金额: ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)

      // 显示前几条记录作为预览
      Logger.info(`📋 发送记录预览 (前5条):`)
      records.slice(0, 5).forEach((record, index) => {
        Logger.info(`   ${index + 1}. ${record.address} -> ${record.amount} ${tokenSymbol}`)
      })
      if (records.length > 5) {
        Logger.info(`   ... 还有 ${records.length - 5} 条记录`)
      }

      // 获取发送者钱包
      const [defaultSigner] = await hre.ethers.getSigners()
      let signer = defaultSigner

      if (from) {
        // 如果指定了发送地址，需要从配置中加载对应的钱包
        Logger.info(`尝试加载指定的发送钱包: ${from}`)

        const seedPath = join(configDir, 'master-seed.json')
        const configPath = join(configDir, 'distribution-config.json')

        if (existsSync(seedPath) && existsSync(configPath)) {
          const { loadAllWallets } = await import('./utils')
          const seedConfig = JSON.parse(readFileSync(seedPath, 'utf8'))
          const config = JSON.parse(readFileSync(configPath, 'utf8'))
          const allWallets = await loadAllWallets(seedConfig.masterSeed, config, hre.ethers.provider)

          const fromWallet = allWallets.get(from.toLowerCase())
          if (fromWallet) {
            // 将 Wallet 转换为 HardhatEthersSigner
            signer = await hre.ethers.getSigner(fromWallet.address)
            Logger.info(`✅ 已加载发送钱包: ${from}`)
          } else {
            Logger.warn(`未找到指定的发送钱包，使用默认签名者`)
          }
        } else {
          Logger.warn(`配置文件不存在，使用默认签名者`)
        }
      }

      Logger.info(`发送钱包地址: ${signer.address}`)

      // 检查发送者余额
      if (type.toLowerCase() === 'eth') {
        const ethBalance = await hre.ethers.provider.getBalance(signer.address)
        Logger.info(`发送钱包 ETH 余额: ${ethers.formatEther(ethBalance)} ETH`)

        if (ethBalance < totalAmount) {
          throw new Error(`ETH 余额不足: 需要 ${ethers.formatEther(totalAmount)} ETH，当前只有 ${ethers.formatEther(ethBalance)} ETH`)
        }
      } else {
        // Token 发送
        if (!tokenContract) {
          throw new Error('Token 合约未初始化')
        }

        const tokenBalance = await tokenContract.balanceOf(signer.address)
        Logger.info(`发送钱包 ${tokenSymbol} 余额: ${ethers.formatUnits(tokenBalance, decimals)} ${tokenSymbol}`)

        if (tokenBalance < totalAmount) {
          throw new Error(
            `${tokenSymbol} 余额不足: 需要 ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}，当前只有 ${ethers.formatUnits(tokenBalance, decimals)} ${tokenSymbol}`,
          )
        }

        // 检查授权额度
        const currentAllowance = await tokenContract.allowance(signer.address, multiSendAddress)
        Logger.info(`当前授权额度: ${ethers.formatUnits(currentAllowance, decimals)} ${tokenSymbol}`)

        if (currentAllowance < totalAmount) {
          if (approve === 'true') {
            Logger.info(`🔐 需要授权 ${tokenSymbol} 给 MultiSend 合约...`)

            if (dryRun === 'true') {
              Logger.info(`[模拟] 将授权 ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)
            } else {
              const tokenWithSigner = tokenContract.connect(signer) as ethers.Contract & {
                approve: (spender: string, amount: bigint) => Promise<ethers.ContractTransactionResponse>
              }
              const approveTx = await tokenWithSigner.approve(multiSendAddress, totalAmount)
              Logger.info(`授权交易已提交: ${approveTx.hash}`)

              const approveReceipt = await approveTx.wait()
              if (approveReceipt?.status === 1) {
                Logger.info(`✅ 授权成功`)
              } else {
                throw new Error('授权失败')
              }
            }
          } else {
            throw new Error(`授权额度不足，请先授权或设置 --approve true`)
          }
        }
      }

      // 创建 MultiSend 合约实例
      const multiSend = new ethers.Contract(
        multiSendAddress,
        [
          'function batchSendETH(address[] calldata recipients, uint256[] calldata amounts) external payable',
          'function batchSendToken(address token, address[] calldata recipients, uint256[] calldata amounts) external',
          'function owner() view returns (address)',
          'function getETHBalance() view returns (uint256)',
        ],
        signer,
      )

      // 准备交易参数
      const recipients = records.map(r => r.address)
      const amounts = records.map(r => r.amountBigInt)

      // 估算 Gas
      Logger.info('⛽ 估算 Gas 费用...')
      let estimatedGas: bigint
      let txValue = 0n

      try {
        if (type.toLowerCase() === 'eth') {
          txValue = totalAmount
          estimatedGas = await multiSend.batchSendETH.estimateGas(recipients, amounts, { value: txValue })
        } else {
          estimatedGas = await multiSend.batchSendToken.estimateGas(tokenAddress, recipients, amounts)
        }

        Logger.info(`预估 Gas 使用量: ${estimatedGas.toString()}`)
      } catch (error) {
        Logger.error('Gas 估算失败:', error)
        throw new Error(`无法估算 Gas 费用，请检查参数和余额`)
      }

      // 获取 Gas 价格
      const gasPriceWei = gasPrice
        ? ethers.parseUnits(gasPrice, 'gwei')
        : (await hre.ethers.provider.getFeeData()).gasPrice || ethers.parseUnits('20', 'gwei')

      const estimatedGasCost = estimatedGas * gasPriceWei
      Logger.info(`预估 Gas 费用: ${ethers.formatEther(estimatedGasCost)} ETH (${ethers.formatUnits(gasPriceWei, 'gwei')} gwei)`)

      // 检查 ETH 余额是否足够支付 Gas 费
      const ethBalance = await hre.ethers.provider.getBalance(signer.address)
      const requiredETH = type.toLowerCase() === 'eth' ? totalAmount + estimatedGasCost : estimatedGasCost

      if (ethBalance < requiredETH) {
        throw new Error(
          `ETH 余额不足支付 Gas 费: 需要 ${ethers.formatEther(requiredETH)} ETH，当前只有 ${ethers.formatEther(ethBalance)} ETH`,
        )
      }

      // 执行交易
      let result: MultiSendResult = {
        success: false,
        recipientCount: records.length,
        totalAmount: ethers.formatUnits(totalAmount, decimals),
      }

      if (dryRun === 'true') {
        Logger.info('\n🔍 模拟执行完成 - 所有检查通过')
        Logger.info(`如果实际执行，将会:`)
        Logger.info(`  - 发送 ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol} 到 ${records.length} 个地址`)
        Logger.info(`  - 消耗约 ${estimatedGas.toString()} Gas`)
        Logger.info(`  - 花费约 ${ethers.formatEther(estimatedGasCost)} ETH Gas 费`)

        result.success = true
        result.gasUsed = estimatedGas
        result.gasPrice = gasPriceWei
        result.totalGasCost = estimatedGasCost
      } else {
        Logger.info('\n🚀 开始执行批量发送...')

        try {
          let tx: ethers.ContractTransactionResponse
          const txOptions: {
            gasPrice: bigint
            gasLimit?: bigint
            value?: bigint
          } = {
            gasPrice: gasPriceWei,
          }

          if (gasLimit) {
            txOptions.gasLimit = BigInt(gasLimit)
          }

          if (type.toLowerCase() === 'eth') {
            txOptions.value = txValue
            tx = await multiSend.batchSendETH(recipients, amounts, txOptions)
          } else {
            tx = await multiSend.batchSendToken(tokenAddress, recipients, amounts, txOptions)
          }

          Logger.info(`交易已提交: ${tx.hash}`)
          Logger.info('等待交易确认...')

          const receipt = await tx.wait()

          if (receipt?.status === 1) {
            Logger.info(`✅ 批量发送成功!`)
            Logger.info(`   交易哈希: ${tx.hash}`)
            Logger.info(`   Gas 使用量: ${receipt.gasUsed}`)
            Logger.info(`   Gas 价格: ${ethers.formatUnits(receipt.gasPrice || gasPriceWei, 'gwei')} gwei`)
            Logger.info(`   实际 Gas 费用: ${ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || gasPriceWei))} ETH`)
            Logger.info(`   发送到 ${records.length} 个地址`)
            Logger.info(`   总金额: ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)

            result = {
              success: true,
              txHash: tx.hash,
              gasUsed: receipt.gasUsed,
              gasPrice: receipt.gasPrice || gasPriceWei,
              totalGasCost: BigInt(receipt.gasUsed) * (receipt.gasPrice || gasPriceWei),
              recipientCount: records.length,
              totalAmount: ethers.formatUnits(totalAmount, decimals),
            }
          } else {
            throw new Error('交易失败')
          }
        } catch (error) {
          Logger.error('交易执行失败:', error)
          result.error = error instanceof Error ? error.message : String(error)
          throw error
        }
      }

      // 保存结果
      const resultDir = join(configDir, 'multi-send-results')
      if (!existsSync(resultDir)) {
        mkdirSync(resultDir, { recursive: true })
      }

      const resultFileName = createTimestampFilename(`multi-send-${type}`)
      const resultPath = join(resultDir, resultFileName)

      const resultData = {
        ...result,
        metadata: {
          timestamp: new Date().toISOString(),
          network: hre.network.name,
          type,
          tokenAddress: type === 'token' ? tokenAddress : null,
          tokenSymbol,
          decimals,
          multiSendAddress,
          fromAddress: signer.address,
          csvFile: csv,
          dryRun: dryRun === 'true',
          records: records.map(r => ({
            address: r.address,
            amount: r.amount,
          })),
        },
      }

      writeFileSync(resultPath, JSON.stringify(resultData, null, 2))
      Logger.info(`📄 结果已保存到: ${resultPath}`)

      Logger.info('\n✅ MultiSend 批量发送任务完成!')
      Logger.info(`📝 详细日志已保存到: ${Logger.getLogFile()}`)
    } catch (error) {
      Logger.error('❌ MultiSend 批量发送任务失败:', error)
      if (Logger.getLogFile()) {
        Logger.info(`📝 错误日志已保存到: ${Logger.getLogFile()}`)
      }
      throw error
    }
  })
