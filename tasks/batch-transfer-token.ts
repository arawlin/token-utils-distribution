import { ethers } from 'ethers'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { createTimestampFilename, formatTokenAmount, loadAllWallets, Logger } from './utils'

interface BatchTokenTransferResult {
  success: number
  failed: number
  transactions: Array<{
    from: string
    to: string
    amount: string
    txHash?: string
    error?: string
    status: 'success' | 'failed' | 'pending'
  }>
}

interface TokenTransferPlan {
  from: string
  to: string
  amount: string
  amountBigInt: bigint
}

// ERC20 transfer gas: `21000 + 约 25000~50000 ≈ 45000~70000 gas. 70000 * 10 * 1e9 / 1e18 = 0.0007`

task('batch-transfer-token', '批量转账Token到多个地址')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addOptionalParam('tokenAddress', 'Token合约地址')
  .addParam('from', '发送地址')
  .addParam('tos', '接收地址列表，用逗号分隔 (例: 0x123...,0x456...)')
  .addParam('holdRatio', '发送地址保留的token比例 (0-1之间的小数，例如 0.1 表示保留10%)', '0.1')
  .addOptionalParam('precision', '随机金额精度 (小数位数)')
  .addOptionalParam('trailingZeros', '末尾零的最小数量 (例: 3 表示至少以000结尾)', '2')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addOptionalParam('delayMin', '交易间最小延迟（毫秒）', '1000')
  .addOptionalParam('delayMax', '交易间最大延迟（毫秒）', '5000')
  .addOptionalParam('autoFundGas', '当ETH余额不足时自动转账ETH', 'true')
  .addOptionalParam(
    'fundingSource',
    '资助钱包地址列表，用逗号分隔 (例: 0x123...,0x456...)，随机选择一个进行转账',
    process.env.FUNDING_WALLET_ADDRESS,
  )
  .addOptionalParam('fundingAmount', '自动转账的ETH数量，默认为所需gas费的指定倍数')
  .addOptionalParam('fundingMultiplier', '自动转账ETH的扩大倍数', '1.5')
  .addOptionalParam('fundingDelay', '转账后等待时间（毫秒）', '5000')
  .addOptionalParam('ethTransferDelay', '并发执行时ETH转账前等待延迟（毫秒）', '0')
  .setAction(async (taskArgs, hre) => {
    const {
      configDir,
      tokenAddress,
      from,
      tos,
      holdRatio,
      precision,
      trailingZeros,
      gasPrice,
      delayMin,
      delayMax,
      autoFundGas,
      fundingSource,
      fundingAmount,
      fundingMultiplier,
      fundingDelay,
      ethTransferDelay,
    } = taskArgs

    const tokenAddressReal = tokenAddress || process.env.TOKEN_ADDRESS

    try {
      // 检查是否已经有 Logger 初始化，batch-transfer-token 通常作为子任务调用，
      // 所以优先使用父任务的日志文件，只在独立执行时创建专用日志
      const existingLogFile = Logger.getLogFile()
      const shouldCreateTaskLog = !existingLogFile || existingLogFile.includes('hardhat-')

      if (shouldCreateTaskLog) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').split('.')[0]
        const logFilename = `batch-transfer-token-${hre.network.name}-${timestamp}.log`
        Logger.setLogFile(logFilename)
        Logger.info(`📝 创建任务专用日志文件: ${Logger.getLogFile()}`)
      }

      Logger.info('🔄 开始执行顺序转账Token任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`Token地址: ${tokenAddressReal}`)
      Logger.info(`发送地址: ${from}`)
      Logger.info(`发送地址保留比例: ${holdRatio} (${(parseFloat(holdRatio) * 100).toFixed(1)}%)`)
      if (precision) {
        Logger.info(`指定随机金额精度: ${precision} 位小数`)
      }
      const trailingZerosNum = parseInt(trailingZeros)
      if (trailingZerosNum > 0) {
        Logger.info(`末尾零的最小数量: ${trailingZerosNum}`)
      }

      // 验证holdRatio参数
      const holdRatioNum = parseFloat(holdRatio)
      if (isNaN(holdRatioNum) || holdRatioNum < 0 || holdRatioNum > 1) {
        Logger.error('holdRatio必须是0-1之间的数字')
        return
      }

      // 验证Token合约地址
      if (!ethers.isAddress(tokenAddressReal)) {
        Logger.error('无效的Token合约地址')
        return
      }

      // 解析接收地址列表
      const toAddresses = tos
        .split(',')
        .map((addr: string) => addr.trim())
        .filter((addr: string) => addr.length > 0)
      if (toAddresses.length === 0) {
        Logger.error('未提供有效的接收地址')
        return
      }

      Logger.info(`接收地址数量: ${toAddresses.length}`)

      // 验证所有接收地址格式
      const invalidAddresses = toAddresses.filter((addr: string) => !ethers.isAddress(addr))
      if (invalidAddresses.length > 0) {
        Logger.error(`无效的地址格式:`)
        invalidAddresses.forEach((addr: string) => Logger.error(`  ${addr}`))
        return
      }

      // 验证参数
      const precisionNum = precision ? parseInt(precision) : undefined

      const configPath = join(configDir, 'distribution-config.json')
      const seedPath = join(configDir, 'master-seed.json')

      // 检查配置文件
      if (!existsSync(configPath) || !existsSync(seedPath)) {
        Logger.error('配置文件不存在，请先运行 init-hd-tree 任务')
        return
      }

      const provider = hre.ethers.provider

      // 加载配置
      const seedConfig = JSON.parse(readFileSync(seedPath, 'utf8'))
      const masterSeed = seedConfig.masterSeed

      const config: DistributionSystemConfig = JSON.parse(readFileSync(configPath, 'utf8'))

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)

      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      // 查找发送钱包
      const fromWallet = allWallets.get(from.toLowerCase())
      if (!fromWallet) {
        Logger.error(`未找到发送地址对应的钱包: ${from}`)
        return
      }

      // 创建Token合约实例
      const tokenContract = new ethers.Contract(
        tokenAddressReal,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function transfer(address to, uint256 amount) returns (bool)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
          'function name() view returns (string)',
        ],
        fromWallet,
      )

      // 获取Token信息
      const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
      ])

      // 验证精度参数
      if (precisionNum !== undefined && (precisionNum < 0 || precisionNum > tokenDecimals)) {
        Logger.error(`随机金额精度必须在0-${tokenDecimals}之间`)
        return
      }

      // 获取发送钱包Token余额
      const fromTokenBalance = await tokenContract.balanceOf(fromWallet.address)
      Logger.info(`发送钱包Token余额: ${formatTokenAmount(fromTokenBalance, tokenDecimals)} ${await tokenContract.symbol()}`)

      // 计算可用于转账的总金额 (扣除保留部分)
      const availableAmount = fromTokenBalance - (fromTokenBalance * BigInt(Math.floor(holdRatioNum * 10000))) / 10000n
      Logger.info(`可转账金额: ${formatTokenAmount(availableAmount, tokenDecimals)} ${await tokenContract.symbol()}`)
      Logger.info(`保留金额: ${formatTokenAmount(fromTokenBalance - availableAmount, tokenDecimals)} ${await tokenContract.symbol()}`)

      if (availableAmount <= 0n) {
        Logger.error('没有可用于转账的Token余额')
        return
      }

      // 获取发送钱包ETH余额(用于gas费)
      const fromEthBalance = await provider.getBalance(fromWallet.address)
      Logger.info(`发送钱包ETH余额: ${ethers.formatEther(fromEthBalance)} ETH`)

      // 获取Gas价格
      const gasPriceWei = gasPrice ? ethers.parseUnits(gasPrice, 'gwei') : (await coordinator.getGasPriceRecommendation(provider)).standard

      Logger.info(`使用Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)

      // 生成随机转账计划
      const generateRandomDistribution = (
        totalAmount: bigint,
        addresses: string[],
        decimals: number,
        precision?: number,
        trailingZeros?: number,
      ) => {
        // 生成随机权重
        const weights = addresses.map(() => Math.random())
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)

        const plans: TokenTransferPlan[] = []

        // 对所有地址按比例分配金额
        for (let i = 0; i < addresses.length; i++) {
          const address = addresses[i]
          const ratio = weights[i] / totalWeight
          let amount = BigInt(Math.floor(Number(totalAmount) * ratio))

          // 将 amount 转换为小数进行处理
          let amountInEther = parseFloat(ethers.formatUnits(amount, decimals))

          // 应用精度设置
          if (precision !== undefined && precision >= 0) {
            const multiplier = Math.pow(10, precision)
            amountInEther = Math.round(amountInEther * multiplier) / multiplier
          }

          // 应用末尾零控制
          if (trailingZeros !== undefined && trailingZeros > 0) {
            const divisor = Math.pow(10, trailingZeros)
            amountInEther = Math.floor(amountInEther / divisor) * divisor
          }

          // 转换回 bigint
          amount = ethers.parseUnits(amountInEther.toString(), decimals)

          // 如果金额大于0，添加到计划中
          if (amount > 0n) {
            plans.push({
              from: fromWallet.address,
              to: address,
              amount: formatTokenAmount(amount, decimals),
              amountBigInt: amount,
            })
          }
        }

        return plans
      }

      const transferPlans = generateRandomDistribution(availableAmount, toAddresses, Number(tokenDecimals), precisionNum, trailingZerosNum)

      // 检查是否有有效的转账计划
      if (transferPlans.length === 0) {
        Logger.error('所有转账金额都为0，无法执行转账')
        return
      }

      if (transferPlans.length < toAddresses.length) {
        Logger.info(`已过滤掉 ${toAddresses.length - transferPlans.length} 个金额为0的转账计划`)
      }

      // 计算实际转账总额（可能由于 trailing zero 规则略少于可用金额）
      const actualTransferAmount = transferPlans.reduce((sum: bigint, plan: TokenTransferPlan) => sum + plan.amountBigInt, 0n)

      // 更新保留金额的计算（实际保留 = 原始保留 + 由于格式化规则未分配的金额）
      const actualReservedAmount = fromTokenBalance - actualTransferAmount
      const actualReservedRatio = Number((actualReservedAmount * 10000n) / fromTokenBalance) / 10000

      Logger.info(`实际分配结果:`)
      Logger.info(`  计划可转账金额: ${formatTokenAmount(availableAmount, tokenDecimals)} ${await tokenContract.symbol()}`)
      Logger.info(`  实际转账金额: ${formatTokenAmount(actualTransferAmount, tokenDecimals)} ${await tokenContract.symbol()}`)
      Logger.info(
        `  实际保留金额: ${formatTokenAmount(actualReservedAmount, tokenDecimals)} ${await tokenContract.symbol()} (${(actualReservedRatio * 100).toFixed(2)}%)`,
      )

      if (actualTransferAmount < availableAmount) {
        const unallocatedAmount = availableAmount - actualTransferAmount
        Logger.info(`  由于格式化规则未分配: ${formatTokenAmount(unallocatedAmount, tokenDecimals)} ${await tokenContract.symbol()}`)
      }

      const totalTransferAmount = transferPlans.reduce((sum: bigint, plan: TokenTransferPlan) => sum + plan.amountBigInt, 0n)
      const gasLimit = 70000n // ERC20 transfer通常需要更多gas
      const totalGasFee = gasLimit * gasPriceWei * BigInt(transferPlans.length)

      Logger.info(`转账计划:`)
      Logger.info(`  转账笔数: ${transferPlans.length}`)
      Logger.info(`  总转账金额: ${formatTokenAmount(totalTransferAmount, tokenDecimals)} ${await tokenContract.symbol()}`)
      Logger.info(`  预估总gas费: ${ethers.formatEther(totalGasFee)} ETH`)

      // 检查Token余额是否足够
      if (fromTokenBalance < totalTransferAmount) {
        Logger.error(`Token余额不足:`)
        Logger.error(`  当前余额: ${formatTokenAmount(fromTokenBalance, tokenDecimals)} ${tokenSymbol}`)
        Logger.error(`  总计需要: ${formatTokenAmount(totalTransferAmount, tokenDecimals)} ${tokenSymbol}`)
        Logger.error(`  缺少: ${ethers.formatUnits(totalTransferAmount - fromTokenBalance, tokenDecimals)} ${tokenSymbol}`)
        return
      }

      // 检查ETH余额是否足够支付gas费
      if (fromEthBalance < totalGasFee) {
        Logger.warn(`ETH余额不足支付gas费:`)
        Logger.warn(`  当前ETH余额: ${ethers.formatEther(fromEthBalance)} ETH`)
        Logger.warn(`  预估总gas费: ${ethers.formatEther(totalGasFee)} ETH`)
        Logger.warn(`  缺少: ${ethers.formatEther(totalGasFee - fromEthBalance)} ETH`)

        // 检查是否启用自动转账
        const autoFundEnabled = autoFundGas === 'true'
        if (!autoFundEnabled) {
          Logger.error('ETH余额不足，请手动转账或启用 --autoFundGas 参数')
          return
        }

        Logger.info('🔄 启动自动转账ETH功能...')

        // 计算需要转账的金额（预估gas费的指定倍数，确保有足够的余量）
        const needAmount = totalGasFee - fromEthBalance
        const multiplier = parseFloat(fundingMultiplier || '1.5')
        const baseTransferAmount = fundingAmount
          ? ethers.parseEther(fundingAmount)
          : needAmount + (needAmount * BigInt(Math.floor((multiplier - 1) * 100))) / 100n

        // 将转账金额格式化为2位有效数字
        const formatTo2SignificantDigits = (value: bigint): bigint => {
          const valueStr = ethers.formatEther(value)
          const numValue = parseFloat(valueStr)

          if (numValue === 0) return 0n

          // 找到第一个非零数字的位置
          const magnitude = Math.floor(Math.log10(Math.abs(numValue)))
          const scale = Math.pow(10, magnitude - 1) // 保留2位有效数字
          const roundedValue = Math.ceil(numValue / scale) * scale

          // 修正小数位数，确保不超过18位小数（ETH的最大精度）
          // 使用 toFixed 而不是 toString() 来避免科学计数法
          const decimalPlaces = Math.max(0, 18 - magnitude)
          const fixedValue = roundedValue.toFixed(Math.min(decimalPlaces, 18))

          // 移除末尾的零
          const trimmedValue = parseFloat(fixedValue)
            .toFixed(18)
            .replace(/\.?0+$/, '')

          return ethers.parseEther(trimmedValue || '0')
        }

        const transferAmount = formatTo2SignificantDigits(baseTransferAmount)

        Logger.info(`计划转账: ${ethers.formatEther(transferAmount)} ETH (${multiplier}倍系数，2位有效数字)`)

        // 获取资助钱包
        if (!fundingSource) {
          Logger.error('未提供资助钱包地址，请设置 --fundingSource 参数或环境变量 FUNDING_WALLET_ADDRESS')
          return
        }
        // 解析多个资助地址
        const fundingAddresses = fundingSource
          .split(',')
          .map((addr: string) => addr.trim())
          .filter((addr: string) => addr.length > 0)

        if (fundingAddresses.length === 0) {
          Logger.error('未提供有效的资助地址')
          return
        }

        // 随机选择一个资助地址
        const selectedFundingAddress = fundingAddresses[Math.floor(Math.random() * fundingAddresses.length)]
        Logger.info(`从 ${fundingAddresses.length} 个资助地址中随机选择: ${selectedFundingAddress}`)

        // 从已加载的钱包中查找选中的资助地址
        const fundingWallet = allWallets.get(selectedFundingAddress.toLowerCase())
        if (!fundingWallet) {
          Logger.error(`未在配置的钱包中找到资助地址: ${selectedFundingAddress}`)
          return
        }

        // 检查资助钱包余额
        const fundingBalance = await provider.getBalance(fundingWallet.address)
        if (fundingBalance < transferAmount) {
          Logger.error(`资助钱包余额不足:`)
          Logger.error(`  资助钱包余额: ${ethers.formatEther(fundingBalance)} ETH`)
          Logger.error(`  需要转账: ${ethers.formatEther(transferAmount)} ETH`)
          return
        }

        try {
          Logger.info(`开始从 ${fundingWallet.address} 转账 ${ethers.formatEther(transferAmount)} ETH 到 ${fromWallet.address}`)

          // 并发执行时添加随机延迟避免nonce冲突
          const ethTransferDelayMs = parseInt(ethTransferDelay || '0')
          if (ethTransferDelayMs > 0) {
            const randomDelay = Math.random() * ethTransferDelayMs
            Logger.info(`[并发控制] 等待 ${Math.round(randomDelay)}ms 后执行ETH转账，避免nonce冲突...`)
            await new Promise(resolve => setTimeout(resolve, randomDelay))
          }

          // 从协调器获取nonce避免并发冲突
          // 出问题，可以注释掉，让 provider 获取
          const fundingNonce = await coordinator.getNextNonce(fundingWallet.address, provider)
          Logger.info(`[并发控制] 使用协调器分配的nonce: ${fundingNonce}`)

          // 执行转账
          const fundingTx = await fundingWallet.sendTransaction({
            to: fromWallet.address,
            value: transferAmount,
            gasPrice: gasPriceWei,
            nonce: fundingNonce,
          })

          Logger.info(`资助转账已提交: ${fundingTx.hash}`)
          Logger.info('等待交易确认...')

          const fundingReceipt = await fundingTx.wait()
          if (fundingReceipt?.status === 1) {
            Logger.info(`✅ 资助转账成功: ${fundingTx.hash}`)
          } else {
            Logger.error(`❌ 资助转账失败: ${fundingTx.hash}`)
            return
          }

          // 等待一段时间确保余额更新
          const waitTime = parseInt(fundingDelay || '10000')
          Logger.info(`等待 ${waitTime}ms 确保余额更新...`)
          await new Promise(resolve => setTimeout(resolve, waitTime))

          // 重新检查余额
          const newFromEthBalance = await provider.getBalance(fromWallet.address)
          Logger.info(`资助后ETH余额: ${ethers.formatEther(newFromEthBalance)} ETH`)

          if (newFromEthBalance < totalGasFee) {
            Logger.error('资助后余额仍然不足，无法继续执行顺序转账')
            return
          }
          Logger.info('✅ ETH余额检查通过，继续执行顺序转账')
        } catch (error) {
          Logger.error('自动转账ETH失败:', error)
          return
        }
      }

      Logger.info(`转账计划预览:`)
      transferPlans.forEach((plan: TokenTransferPlan, index: number) => {
        Logger.info(`  ${index + 1}. 转账 ${plan.amount} ${tokenSymbol} 到 ${plan.to}`)
      })

      // 初始化结果统计
      const results: BatchTokenTransferResult = {
        success: 0,
        failed: 0,
        transactions: [],
      }

      // 执行实际转账
      Logger.info('开始执行顺序转账...')

      const delayMinNum = parseInt(delayMin)
      const delayMaxNum = parseInt(delayMax)

      // 顺序处理转账（避免nonce冲突）
      for (let i = 0; i < transferPlans.length; i++) {
        const plan = transferPlans[i]
        Logger.info(`\n=== 执行第 ${i + 1}/${transferPlans.length} 笔转账 ===`)

        try {
          // 获取当前nonce（每次都重新获取确保准确性）
          const nonce = await provider.getTransactionCount(fromWallet.address, 'pending')

          Logger.info(
            `[${i + 1}/${transferPlans.length}] 转账 ${plan.amount} ${await tokenContract.symbol()} 到 ${plan.to.slice(0, 10)}... (nonce: ${nonce})`,
          )

          const tx = await tokenContract.transfer(plan.to, plan.amountBigInt, {
            gasPrice: gasPriceWei,
            gasLimit: gasLimit,
            nonce: nonce,
          })

          Logger.info(`[${i + 1}] 交易已提交: ${tx.hash}`)

          // 等待确认
          const receipt = await tx.wait()

          const transaction = {
            from: plan.from,
            to: plan.to,
            amount: plan.amount,
            txHash: tx.hash,
            status: receipt?.status === 1 ? ('success' as const) : ('failed' as const),
            error: undefined as string | undefined,
          }

          if (receipt?.status === 1) {
            Logger.info(`[${i + 1}] ✅ 转账成功: ${tx.hash}`)
            results.success++
          } else {
            Logger.error(`[${i + 1}] ❌ 交易失败: ${tx.hash}`)
            transaction.error = '交易执行失败'
            results.failed++
          }

          results.transactions.push(transaction)

          // 交易间延迟
          if (i < transferPlans.length - 1) {
            const delay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
            Logger.info(`等待 ${Math.round(delay)}ms 后执行下一笔转账...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        } catch (error) {
          Logger.error(`[${i + 1}] ❌ 转账失败:`, error)

          const transaction = {
            from: plan.from,
            to: plan.to,
            amount: plan.amount,
            error: error instanceof Error ? error.message : String(error),
            status: 'failed' as const,
          }

          results.transactions.push(transaction)
          results.failed++

          // 即使失败也要延迟，避免快速重试
          if (i < transferPlans.length - 1) {
            const delay = Math.random() * (delayMaxNum - delayMinNum) + delayMinNum
            Logger.info(`失败后等待 ${Math.round(delay)}ms 再继续...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }

      Logger.info('\n=== 顺序转账完成 ===')
      Logger.info(`总计: ${results.success} 成功, ${results.failed} 失败`)

      // 显示最终余额
      const finalTokenBalance = await tokenContract.balanceOf(fromWallet.address)
      const finalEthBalance = await provider.getBalance(fromWallet.address)
      const finalTokenSymbol = await tokenContract.symbol()
      Logger.info(`发送钱包最终Token余额: ${formatTokenAmount(finalTokenBalance, tokenDecimals)} ${finalTokenSymbol}`)
      Logger.info(`发送钱包最终ETH余额: ${ethers.formatEther(finalEthBalance)} ETH`)
      Logger.info(`实际转账: ${ethers.formatUnits(fromTokenBalance - finalTokenBalance, tokenDecimals)} ${finalTokenSymbol}`)
      Logger.info(`实际gas费: ${ethers.formatEther(fromEthBalance - finalEthBalance)} ETH`)

      // 保存结果到文件
      const resultDir = join(configDir, 'transfer-results')
      const resultFileName = createTimestampFilename('batch-transfer-token')
      const resultPath = join(resultDir, resultFileName)

      if (!existsSync(resultDir)) {
        mkdirSync(resultDir, { recursive: true })
      }

      const resultData = {
        ...results,
        metadata: {
          timestamp: new Date().toISOString(),
          network: hre.network.name,
          tokenAddress: tokenAddressReal,
          tokenName,
          tokenSymbol,
          tokenDecimals: Number(tokenDecimals),
          fromAddress: from,
          totalAddresses: toAddresses.length,
          validAddresses: transferPlans.length,
          holdRatio: holdRatioNum,
          precision: precisionNum,
          gasPrice: ethers.formatUnits(gasPriceWei, 'gwei') + ' gwei',
        },
      }

      writeFileSync(resultPath, JSON.stringify(resultData, null, 2))
      Logger.info(`📄 结果已保存到: ${resultPath}`)

      Logger.info('✅ 顺序转账Token任务完成!')

      // 显示日志文件位置（仅在独立执行时显示，避免子任务重复显示）
      if (Logger.getLogFile() && Logger.getLogFile().includes('batch-transfer-token-')) {
        Logger.info(`📝 详细日志已保存到: ${Logger.getLogFile()}`)
      }
    } catch (error) {
      Logger.error('❌ 顺序转账Token任务失败:', error)
      if (Logger.getLogFile() && Logger.getLogFile().includes('batch-transfer-token-')) {
        Logger.info(`📝 错误日志已保存到: ${Logger.getLogFile()}`)
      }
      throw error
    }
  })
