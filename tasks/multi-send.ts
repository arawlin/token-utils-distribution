import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { coordinator } from './coordinator'
import { Logger } from './utils'

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
  batchDetails?: Array<{
    batchIndex: number
    txHash: string
    gasUsed: bigint
    gasPrice: bigint
    recipientCount: number
    batchAmount: string
  }>
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
  .addOptionalParam('batchSize', '每批处理的地址数量', '50')
  .addOptionalParam('from', '发送者钱包地址 (如果不指定，使用默认签名者)')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('approve', '是否自动 approve token (type=token 时)', 'true')
  .addOptionalParam('dryRun', '是否仅模拟执行，不实际发送交易', 'false')
  .setAction(async (taskArgs, hre) => {
    const { csv, type, tokenAddress, multiSendAddress, gasPrice, gasLimit, batchSize, from, configDir, approve, dryRun } = taskArgs

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

      // 分批参数
      const batchSizeNum = parseInt(batchSize)
      if (isNaN(batchSizeNum) || batchSizeNum <= 0) {
        throw new Error('batchSize 必须是大于0的数字')
      }

      // 将记录分批
      const batches: CSVRecord[][] = []
      for (let i = 0; i < records.length; i += batchSizeNum) {
        batches.push(records.slice(i, i + batchSizeNum))
      }

      Logger.info(`📦 分批处理信息:`)
      Logger.info(`   每批大小: ${batchSizeNum}`)
      Logger.info(`   总批次数: ${batches.length}`)
      batches.forEach((batch, index) => {
        const batchAmount = batch.reduce((sum, r) => sum + r.amountBigInt, 0n)
        Logger.info(`   批次 ${index + 1}: ${batch.length} 个地址, ${ethers.formatUnits(batchAmount, decimals)} ${tokenSymbol}`)
      })

      // 检查基本的 ETH 余额（不进行精确的 Gas 费预估）
      const ethBalance = await hre.ethers.provider.getBalance(signer.address)
      const minRequiredETH = type.toLowerCase() === 'eth' ? totalAmount : 0n

      Logger.info(`当前 ETH 余额: ${ethers.formatEther(ethBalance)} ETH`)
      if (ethBalance < minRequiredETH) {
        throw new Error(`ETH 余额不足: 需要至少 ${ethers.formatEther(minRequiredETH)} ETH，当前只有 ${ethers.formatEther(ethBalance)} ETH`)
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
        Logger.info(`  - 分 ${batches.length} 批次发送 ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)
        Logger.info(`  - 发送到 ${records.length} 个地址`)
        Logger.info(`  - Gas 价格和费用将在每个批次中实时计算`)

        result.success = true
      } else {
        Logger.info('\n🚀 开始执行分批量发送...')

        let totalGasUsed = 0n
        let totalGasCost = 0n
        const batchResults: Array<{
          batchIndex: number
          txHash: string
          gasUsed: bigint
          gasPrice: bigint
          recipientCount: number
          batchAmount: string
        }> = []

        try {
          for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex]
            const batchRecipients = batch.map(r => r.address)
            const batchAmounts = batch.map(r => r.amountBigInt)
            const batchTotalAmount = batch.reduce((sum, r) => sum + r.amountBigInt, 0n)

            Logger.info(`\n=== 执行批次 ${batchIndex + 1}/${batches.length} ===`)
            Logger.info(`   地址数量: ${batch.length}`)
            Logger.info(`   批次金额: ${ethers.formatUnits(batchTotalAmount, decimals)} ${tokenSymbol}`)

            // 🔍 DEBUG: 记录批次执行前的余额状态
            Logger.info('\n   🔍 [DEBUG] 批次执行前余额状态:')
            const beforeSenderEthBalance = await hre.ethers.provider.getBalance(signer.address)
            Logger.info(`     发送者 ETH 余额: ${ethers.formatEther(beforeSenderEthBalance)} ETH`)

            let beforeSenderTokenBalance = 0n
            if (type.toLowerCase() === 'token' && tokenContract) {
              beforeSenderTokenBalance = await tokenContract.balanceOf(signer.address)
              Logger.info(`     发送者 ${tokenSymbol} 余额: ${ethers.formatUnits(beforeSenderTokenBalance, decimals)} ${tokenSymbol}`)
            }

            // 记录接收者批次前余额（前3个作为示例）
            const sampleRecipients = batchRecipients.slice(0, 3)
            const beforeRecipientBalances: Array<{ address: string; ethBalance: bigint; tokenBalance?: bigint }> = []

            for (const recipient of sampleRecipients) {
              const ethBalance = await hre.ethers.provider.getBalance(recipient)
              let tokenBalance: bigint | undefined

              if (type.toLowerCase() === 'token' && tokenContract) {
                tokenBalance = await tokenContract.balanceOf(recipient)
              }

              beforeRecipientBalances.push({ address: recipient, ethBalance, tokenBalance })

              if (type.toLowerCase() === 'token') {
                Logger.info(
                  `     接收者 ${recipient.slice(0, 6)}...${recipient.slice(-4)}: ${ethers.formatEther(ethBalance)} ETH, ${ethers.formatUnits(tokenBalance!, decimals)} ${tokenSymbol}`,
                )
              } else {
                Logger.info(`     接收者 ${recipient.slice(0, 6)}...${recipient.slice(-4)}: ${ethers.formatEther(ethBalance)} ETH`)
              }
            }

            if (batchRecipients.length > 3) {
              Logger.info(`     ... 还有 ${batchRecipients.length - 3} 个接收者的余额未显示`)
            }

            // 实时获取当前批次的 Gas 价格
            Logger.info('\n   💰 获取实时 Gas 价格...')
            let currentGasPriceWei: bigint
            if (gasPrice) {
              // 如果用户指定了 gas price，就使用指定的
              currentGasPriceWei = ethers.parseUnits(gasPrice, 'gwei')
              Logger.info(`   使用指定 Gas 价格: ${ethers.formatUnits(currentGasPriceWei, 'gwei')} gwei`)
            } else {
              // 否则实时获取推荐的 gas price
              currentGasPriceWei = (await coordinator.getGasPriceRecommendation(hre.ethers.provider)).standard
              Logger.info(`   当前推荐 Gas 价格: ${ethers.formatUnits(currentGasPriceWei, 'gwei')} gwei`)
            }

            // 实时估算当前批次的 Gas
            Logger.info('   ⛽ 估算当前批次 Gas...')
            let estimatedGas: bigint
            try {
              if (type.toLowerCase() === 'eth') {
                estimatedGas = await multiSend.batchSendETH.estimateGas(batchRecipients, batchAmounts, {
                  value: batchTotalAmount,
                })
              } else {
                estimatedGas = await multiSend.batchSendToken.estimateGas(tokenAddress, batchRecipients, batchAmounts)
              }
              const estimatedGasCost = estimatedGas * currentGasPriceWei
              Logger.info(`   预估 Gas: ${estimatedGas} (${ethers.formatEther(estimatedGasCost)} ETH)`)

              // 检查当前余额是否足够支付这批次的费用
              const currentEthBalance = await hre.ethers.provider.getBalance(signer.address)
              const thisRequiredETH = type.toLowerCase() === 'eth' ? batchTotalAmount + estimatedGasCost : estimatedGasCost

              if (currentEthBalance < thisRequiredETH) {
                throw new Error(
                  `批次 ${batchIndex + 1} ETH 余额不足: 需要 ${ethers.formatEther(thisRequiredETH)} ETH，当前只有 ${ethers.formatEther(currentEthBalance)} ETH`,
                )
              }
            } catch (error) {
              Logger.error(`   批次 ${batchIndex + 1} Gas 估算失败:`, error)
              throw new Error(`批次 ${batchIndex + 1} 无法估算 Gas 费用: ${error}`)
            }

            const txOptions: {
              gasPrice: bigint
              gasLimit?: bigint
              value?: bigint
            } = {
              gasPrice: currentGasPriceWei,
            }

            if (gasLimit) {
              txOptions.gasLimit = BigInt(gasLimit)
            } else {
              // 使用估算的 Gas + 10% 缓冲
              txOptions.gasLimit = estimatedGas + (estimatedGas * 10n) / 100n
            }

            let tx: ethers.ContractTransactionResponse
            if (type.toLowerCase() === 'eth') {
              txOptions.value = batchTotalAmount
              tx = await multiSend.batchSendETH(batchRecipients, batchAmounts, txOptions)
            } else {
              tx = await multiSend.batchSendToken(tokenAddress, batchRecipients, batchAmounts, txOptions)
            }

            Logger.info(`   交易已提交: ${tx.hash}`)
            Logger.info('   等待交易确认...')

            const receipt = await tx.wait()

            if (receipt?.status === 1) {
              const batchGasUsed = receipt.gasUsed
              const batchGasPrice = receipt.gasPrice || currentGasPriceWei
              const batchGasCost = batchGasUsed * batchGasPrice

              totalGasUsed += batchGasUsed
              totalGasCost += batchGasCost

              batchResults.push({
                batchIndex: batchIndex + 1,
                txHash: tx.hash,
                gasUsed: batchGasUsed,
                gasPrice: batchGasPrice,
                recipientCount: batch.length,
                batchAmount: ethers.formatUnits(batchTotalAmount, decimals),
              })

              Logger.info(`   ✅ 批次 ${batchIndex + 1} 发送成功!`)
              Logger.info(`      交易哈希: ${tx.hash}`)
              Logger.info(`      Gas 使用量: ${batchGasUsed}`)
              Logger.info(`      Gas 费用: ${ethers.formatEther(batchGasCost)} ETH`)
              Logger.info(`      发送到 ${batch.length} 个地址`)

              // 🔍 DEBUG: 记录批次执行后的余额变化
              Logger.info('\n   🔍 [DEBUG] 批次执行后余额变化:')
              const afterSenderEthBalance = await hre.ethers.provider.getBalance(signer.address)
              const senderEthChange = afterSenderEthBalance - beforeSenderEthBalance
              Logger.info(
                `     发送者 ETH 余额: ${ethers.formatEther(beforeSenderEthBalance)} -> ${ethers.formatEther(afterSenderEthBalance)} (变化: ${ethers.formatEther(senderEthChange)} ETH)`,
              )

              if (type.toLowerCase() === 'token' && tokenContract) {
                const afterSenderTokenBalance = await tokenContract.balanceOf(signer.address)
                const senderTokenChange = afterSenderTokenBalance - beforeSenderTokenBalance
                Logger.info(
                  `     发送者 ${tokenSymbol} 余额: ${ethers.formatUnits(beforeSenderTokenBalance, decimals)} -> ${ethers.formatUnits(afterSenderTokenBalance, decimals)} (变化: ${ethers.formatUnits(senderTokenChange, decimals)} ${tokenSymbol})`,
                )
              }

              // 检查接收者余额变化
              for (let i = 0; i < beforeRecipientBalances.length; i++) {
                const recipientData = beforeRecipientBalances[i]
                const afterEthBalance = await hre.ethers.provider.getBalance(recipientData.address)
                const ethChange = afterEthBalance - recipientData.ethBalance

                if (type.toLowerCase() === 'token' && tokenContract) {
                  const afterTokenBalance = await tokenContract.balanceOf(recipientData.address)
                  const tokenChange = afterTokenBalance - recipientData.tokenBalance!
                  const expectedTokenAmount = batchAmounts[sampleRecipients.indexOf(recipientData.address)]

                  Logger.info(`     接收者 ${recipientData.address.slice(0, 6)}...${recipientData.address.slice(-4)}:`)
                  Logger.info(
                    `       ETH: ${ethers.formatEther(recipientData.ethBalance)} -> ${ethers.formatEther(afterEthBalance)} (变化: ${ethers.formatEther(ethChange)})`,
                  )
                  Logger.info(
                    `       ${tokenSymbol}: ${ethers.formatUnits(recipientData.tokenBalance!, decimals)} -> ${ethers.formatUnits(afterTokenBalance, decimals)} (变化: ${ethers.formatUnits(tokenChange, decimals)}, 期望: ${ethers.formatUnits(expectedTokenAmount, decimals)})`,
                  )

                  // 验证接收金额是否正确
                  if (tokenChange === expectedTokenAmount) {
                    Logger.info(`       ✅ 接收金额正确`)
                  } else {
                    Logger.info(
                      `       ⚠️  接收金额不匹配! 实际: ${ethers.formatUnits(tokenChange, decimals)}, 期望: ${ethers.formatUnits(expectedTokenAmount, decimals)}`,
                    )
                  }
                } else {
                  const expectedEthAmount = batchAmounts[sampleRecipients.indexOf(recipientData.address)]
                  Logger.info(`     接收者 ${recipientData.address.slice(0, 6)}...${recipientData.address.slice(-4)}:`)
                  Logger.info(
                    `       ETH: ${ethers.formatEther(recipientData.ethBalance)} -> ${ethers.formatEther(afterEthBalance)} (变化: ${ethers.formatEther(ethChange)}, 期望: ${ethers.formatEther(expectedEthAmount)})`,
                  )

                  // 验证接收金额是否正确
                  if (ethChange === expectedEthAmount) {
                    Logger.info(`       ✅ 接收金额正确`)
                  } else {
                    Logger.info(
                      `       ⚠️  接收金额不匹配! 实际: ${ethers.formatEther(ethChange)}, 期望: ${ethers.formatEther(expectedEthAmount)}`,
                    )
                  }
                }
              }

              // 批次间延迟（避免 nonce 问题）
              if (batchIndex < batches.length - 1) {
                const delay = 2000 // 2秒延迟
                Logger.info(`   ⏱️  等待 ${delay}ms 后执行下一批次...`)
                await new Promise(resolve => setTimeout(resolve, delay))
              }
            } else {
              throw new Error(`批次 ${batchIndex + 1} 交易失败`)
            }
          }

          Logger.info(`\n✅ 所有批次发送完成!`)
          Logger.info(`📊 总体统计:`)
          Logger.info(`   总批次数: ${batches.length}`)
          Logger.info(`   总地址数: ${records.length}`)
          Logger.info(`   总金额: ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)
          Logger.info(`   总 Gas 使用量: ${totalGasUsed}`)
          Logger.info(`   总 Gas 费用: ${ethers.formatEther(totalGasCost)} ETH`)
          Logger.info(`   平均每批次 Gas: ${totalGasUsed / BigInt(batches.length)}`)

          // 🔍 DEBUG: 最终余额变化汇总
          Logger.info(`\n🔍 [DEBUG] 整体余额变化汇总:`)
          const finalSenderEthBalance = await hre.ethers.provider.getBalance(signer.address)
          const initialSenderEthBalance = ethBalance // 使用之前记录的初始余额
          const totalEthChange = finalSenderEthBalance - initialSenderEthBalance

          Logger.info(`发送者最终余额变化:`)
          Logger.info(
            `  ETH: ${ethers.formatEther(initialSenderEthBalance)} -> ${ethers.formatEther(finalSenderEthBalance)} (总变化: ${ethers.formatEther(totalEthChange)} ETH)`,
          )

          if (type.toLowerCase() === 'token' && tokenContract) {
            const finalSenderTokenBalance = await tokenContract.balanceOf(signer.address)
            Logger.info(`  ${tokenSymbol}: 总发送量 ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)
            Logger.info(`  ${tokenSymbol}: 剩余余额 ${ethers.formatUnits(finalSenderTokenBalance, decimals)} ${tokenSymbol}`)
          } else {
            Logger.info(`  ${tokenSymbol}: 总发送量 ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol}`)
          }

          Logger.info(`费用分析:`)
          Logger.info(`  Gas 费用: ${ethers.formatEther(totalGasCost)} ETH`)
          Logger.info(
            `  发送金额: ${ethers.formatUnits(totalAmount, decimals)} ${tokenSymbol} ${type.toLowerCase() === 'eth' ? `(${ethers.formatEther(totalAmount)} ETH)` : ''}`,
          )
          Logger.info(
            `  总成本: ${type.toLowerCase() === 'eth' ? ethers.formatEther(totalAmount + totalGasCost) + ' ETH' : ethers.formatEther(totalGasCost) + ' ETH (Gas) + ' + ethers.formatUnits(totalAmount, decimals) + ' ' + tokenSymbol}`,
          )

          result = {
            success: true,
            txHash: batchResults.map(b => b.txHash).join(','), // 多个交易哈希用逗号连接
            gasUsed: totalGasUsed,
            gasPrice: batchResults.length > 0 ? batchResults[batchResults.length - 1].gasPrice : 0n, // 使用最后一个批次的 gas price，如果没有批次则为0
            totalGasCost: totalGasCost,
            recipientCount: records.length,
            totalAmount: ethers.formatUnits(totalAmount, decimals),
          }

          // 将批次详情添加到结果中
          result.batchDetails = batchResults
        } catch (error) {
          Logger.error('分批量发送失败:', error)
          result.error = error instanceof Error ? error.message : String(error)
          throw error
        }
      }

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
