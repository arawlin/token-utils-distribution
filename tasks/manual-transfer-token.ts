import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { DistributionSystemConfig } from '../types'
import { coordinator } from './coordinator'
import { formatEther, formatTokenAmount, loadAllWallets, Logger } from './utils'

task('manual-transfer-token', '手动转账ERC20 Token')
  .addOptionalParam('configDir', '配置目录', './.ws')
  .addParam('from', '发送地址')
  .addParam('to', '接收地址')
  .addParam('amount', '转账金额 (Token数量，例: 100, -1表示转移所有余额)')
  .addOptionalParam('tokenAddress', 'Token合约地址 (如不指定则使用配置中的token地址)')
  .addOptionalParam('decimals', 'Token精度 (默认18)', '18')
  .addOptionalParam('gasPrice', 'Gas价格 (gwei)', '')
  .addFlag('dryRun', '干运行模式（不执行实际交易）')
  .addFlag('force', '强制执行（跳过锁检查）')
  .setAction(async (taskArgs, hre) => {
    const { configDir, from, to, amount, tokenAddress, decimals, gasPrice, dryRun, force } = taskArgs
    let taskId = ''

    try {
      // 获取任务锁
      if (!force) {
        taskId = await coordinator.acquireTaskLock('manual-transfer-token')
      }

      Logger.info('开始执行手动Token转账任务')
      Logger.info(`网络: ${hre.network.name}`)
      Logger.info(`发送地址: ${from}`)
      Logger.info(`接收地址: ${to}`)
      Logger.info(`转账金额: ${amount} Token`)
      Logger.info(`Token精度: ${decimals}`)
      Logger.info(`干运行模式: ${dryRun}`)

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

      // 确定Token合约地址
      const finalTokenAddress = tokenAddress || config.tokenDistribution?.tokenAddress
      if (!finalTokenAddress) {
        Logger.error('未指定Token合约地址，请通过 --token-address 参数指定或在配置中设置')
        return
      }

      if (!ethers.isAddress(finalTokenAddress)) {
        Logger.error(`无效的Token合约地址: ${finalTokenAddress}`)
        return
      }

      Logger.info(`Token合约地址: ${finalTokenAddress}`)

      // 加载所有钱包
      Logger.info('加载所有钱包地址...')
      const allWallets = await loadAllWallets(masterSeed, config, provider)

      Logger.info(`总共加载了 ${allWallets.size} 个钱包地址`)

      // 查找发送钱包
      const fromWallet = allWallets.get(from.toLowerCase())
      if (!fromWallet) {
        Logger.error(`未找到发送地址对应的钱包: ${from}`)
        Logger.info('可用的钱包地址:')
        Array.from(allWallets.keys()).forEach(address => {
          Logger.info(`  ${address}`)
        })
        return
      }

      // 验证接收地址格式
      if (!ethers.isAddress(to)) {
        Logger.error(`无效的接收地址: ${to}`)
        return
      }

      // 创建Token合约实例
      const tokenContract = new ethers.Contract(
        finalTokenAddress,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function transfer(address to, uint256 amount) returns (bool)',
          'function decimals() view returns (uint8)',
          'function symbol() view returns (string)',
          'function name() view returns (string)',
        ],
        fromWallet,
      )

      try {
        // 获取Token信息
        const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
          tokenContract.name().catch(() => 'Unknown'),
          tokenContract.symbol().catch(() => 'UNKNOWN'),
          tokenContract.decimals().catch(() => parseInt(decimals)),
        ])

        Logger.info(`Token信息: ${tokenName} (${tokenSymbol}), 精度: ${tokenDecimals}`)

        // 获取余额
        const fromTokenBalance = await tokenContract.balanceOf(fromWallet.address)
        const toTokenBalance = await tokenContract.balanceOf(to)
        const fromEthBalance = await provider.getBalance(fromWallet.address)

        Logger.info(`发送钱包Token余额: ${formatTokenAmount(fromTokenBalance, tokenDecimals)} ${tokenSymbol}`)
        Logger.info(`发送钱包ETH余额: ${formatEther(fromEthBalance)} ETH`)
        Logger.info(`接收钱包Token余额: ${formatTokenAmount(toTokenBalance, tokenDecimals)} ${tokenSymbol}`)

        // 处理转账金额
        let transferAmount: bigint
        if (amount === '-1') {
          // 转移所有Token余额
          transferAmount = fromTokenBalance
          Logger.info(`转移所有Token余额: ${formatTokenAmount(transferAmount, tokenDecimals)} ${tokenSymbol}`)
        } else {
          try {
            transferAmount = ethers.parseUnits(amount, tokenDecimals)
          } catch {
            Logger.error(`无效的金额格式: ${amount}`)
            return
          }
        }

        // 检查Token余额是否足够
        if (fromTokenBalance < transferAmount) {
          Logger.error(`Token余额不足:`)
          Logger.error(`  当前余额: ${formatTokenAmount(fromTokenBalance, tokenDecimals)} ${tokenSymbol}`)
          Logger.error(`  转账金额: ${formatTokenAmount(transferAmount, tokenDecimals)} ${tokenSymbol}`)
          return
        }

        // 检查ETH余额是否足够支付gas费
        const gasPriceWei = gasPrice
          ? ethers.parseUnits(gasPrice, 'gwei')
          : (await coordinator.getGasPriceRecommendation(provider)).standard

        // 估算gas费用 (ERC20 transfer通常需要约60,000 gas)
        const estimatedGasLimit = 80000n
        const estimatedGasFee = estimatedGasLimit * gasPriceWei

        if (fromEthBalance < estimatedGasFee) {
          Logger.error(`ETH余额不足支付gas费:`)
          Logger.error(`  当前ETH余额: ${formatEther(fromEthBalance)} ETH`)
          Logger.error(`  预估gas费: ${formatEther(estimatedGasFee)} ETH`)
          return
        }

        Logger.info(`转账详情:`)
        Logger.info(`  从: ${fromWallet.address}`)
        Logger.info(`  到: ${to}`)
        Logger.info(`  金额: ${formatTokenAmount(transferAmount, tokenDecimals)} ${tokenSymbol}`)
        Logger.info(`  Token合约: ${finalTokenAddress}`)
        Logger.info(`  Gas价格: ${ethers.formatUnits(gasPriceWei, 'gwei')} gwei`)
        Logger.info(`  预估gas费: ${formatEther(estimatedGasFee)} ETH`)

        if (dryRun) {
          Logger.info('[DRY-RUN] Token转账模拟完成，未执行实际交易')
        } else {
          // 执行Token转账
          Logger.info('执行Token转账...')

          try {
            const nonce = await coordinator.getNextNonce(fromWallet.address, provider)

            const tx = await tokenContract.transfer(to, transferAmount, {
              gasPrice: gasPriceWei,
              gasLimit: estimatedGasLimit,
              nonce: nonce,
            })

            Logger.info(`交易已提交: ${tx.hash}`)
            Logger.info('等待交易确认...')

            const receipt = await tx.wait()

            if (receipt?.status === 1) {
              Logger.info(`✅ Token转账成功!`)
              Logger.info(`  交易哈希: ${tx.hash}`)
              Logger.info(`  区块号: ${receipt.blockNumber}`)
              Logger.info(`  实际gas费: ${formatEther(receipt.gasUsed * gasPriceWei)} ETH`)

              // 显示转账后余额
              const newFromTokenBalance = await tokenContract.balanceOf(fromWallet.address)
              const newToTokenBalance = await tokenContract.balanceOf(to)
              const newFromEthBalance = await provider.getBalance(fromWallet.address)

              Logger.info(
                `  发送钱包Token余额: ${formatTokenAmount(newFromTokenBalance, tokenDecimals)} ${tokenSymbol}`,
              )
              Logger.info(`  接收钱包Token余额: ${formatTokenAmount(newToTokenBalance, tokenDecimals)} ${tokenSymbol}`)
              Logger.info(`  发送钱包ETH余额: ${formatEther(newFromEthBalance)} ETH`)
            } else {
              Logger.error('❌ 交易失败')
            }
          } catch (error) {
            Logger.error('Token转账失败:', error)
            throw error
          }
        }
      } catch (error) {
        Logger.error('获取Token信息失败，请检查Token合约地址是否正确:', error)
        return
      }

      Logger.info('手动Token转账任务完成!')

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'completed')
      }
    } catch (error) {
      Logger.error('手动Token转账任务失败:', error)

      // 释放任务锁
      if (!force && taskId) {
        await coordinator.releaseTaskLock(taskId, 'failed')
      }

      throw error
    }
  })
