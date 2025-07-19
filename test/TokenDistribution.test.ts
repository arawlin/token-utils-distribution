import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { generateNormalDistributionAmount, generatePoissonInterval } from '../tasks/utils'

describe('Token Distribution System', function () {
  async function deployTestTokenFixture() {
    const [owner, addr1, addr2, addr3] = await ethers.getSigners()

    const TestTokenFactory = await ethers.getContractFactory('TestToken')
    const testToken = await TestTokenFactory.deploy(
      'Test Distribution Token',
      'TDT',
      1000000000, // 1 billion tokens
    )

    await testToken.waitForDeployment()

    const tokenAddress = await testToken.getAddress()

    return { testToken, tokenAddress, owner, addr1, addr2, addr3 }
  }

  describe('Token Contract', function () {
    it('Should deploy with correct initial supply', async function () {
      const { testToken, owner } = await loadFixture(deployTestTokenFixture)

      const totalSupply = await testToken.totalSupply()
      const expectedSupply = ethers.parseEther('1000000000') // 1 billion tokens with 18 decimals

      expect(totalSupply).to.equal(expectedSupply)
      expect(await testToken.balanceOf(owner.address)).to.equal(totalSupply)
    })

    it('Should have correct token properties', async function () {
      const { testToken } = await loadFixture(deployTestTokenFixture)

      expect(await testToken.name()).to.equal('Test Distribution Token')
      expect(await testToken.symbol()).to.equal('TDT')
      expect(await testToken.decimals()).to.equal(18)
    })
  })

  describe('Distribution Utilities', function () {
    it('Should generate normally distributed amounts', function () {
      const mean = '1000000'
      const stdDev = '200000'

      const amounts: bigint[] = []
      for (let i = 0; i < 100; i++) {
        const amount = generateNormalDistributionAmount(mean, stdDev)
        amounts.push(amount)
        expect(amount).to.be.greaterThan(0n)
      }

      // 检查生成的数量是否合理分布
      const meanValue = Number(mean)
      const validAmounts = amounts.filter(amount => Number(amount) > meanValue * 0.1 && Number(amount) < meanValue * 3)

      // 至少80%的值应该在合理范围内
      expect(validAmounts.length).to.be.greaterThanOrEqual(80)
    })

    it('Should generate Poisson intervals', function () {
      const lambda = 12 // 每小时12次交易

      const intervals: number[] = []
      for (let i = 0; i < 100; i++) {
        const interval = generatePoissonInterval(lambda)
        intervals.push(interval)
        expect(interval).to.be.greaterThan(0)
      }

      // 检查平均间隔时间是否合理
      const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length
      const expectedInterval = 3600000 / lambda // 期望间隔(毫秒)

      // 允许30%的误差
      expect(avgInterval).to.be.greaterThan(expectedInterval * 0.7)
      expect(avgInterval).to.be.lessThan(expectedInterval * 1.3)
    })
  })

  describe('Token Distribution', function () {
    it('Should distribute tokens to multiple addresses', async function () {
      const { testToken, owner, addr1, addr2, addr3 } = await loadFixture(deployTestTokenFixture)

      const distributionAmount = ethers.parseEther('1000') // 1000 tokens each
      const recipients = [addr1.address, addr2.address, addr3.address]

      // 执行分发
      for (const recipient of recipients) {
        const tx = await testToken.transfer(recipient, distributionAmount)
        await tx.wait()
      }

      // 验证分发结果
      for (const recipient of recipients) {
        const balance = await testToken.balanceOf(recipient)
        expect(balance).to.equal(distributionAmount)
      }

      // 验证源地址余额减少
      const ownerBalance = await testToken.balanceOf(owner.address)
      const totalSupply = await testToken.totalSupply()
      const expectedOwnerBalance = totalSupply - distributionAmount * BigInt(recipients.length)
      expect(ownerBalance).to.equal(expectedOwnerBalance)
    })

    it('Should handle insufficient balance gracefully', async function () {
      const { testToken, addr1 } = await loadFixture(deployTestTokenFixture)

      const totalSupply = await testToken.totalSupply()
      const excessiveAmount = totalSupply + ethers.parseEther('1') // 比总供应量多1个token

      // 尝试转账超过余额的数量，应该失败
      await expect(testToken.transfer(addr1.address, excessiveAmount)).to.be.reverted
    })
  })

  describe('Gas Estimation', function () {
    it('Should estimate gas costs for token transfers', async function () {
      const { testToken, owner, addr1 } = await loadFixture(deployTestTokenFixture)

      const transferAmount = ethers.parseEther('1000')

      // 估算gas消耗
      const estimatedGas = await testToken.transfer.estimateGas(addr1.address, transferAmount)

      // ERC20转账通常需要60,000-70,000 gas
      expect(estimatedGas).to.be.greaterThan(40000n)
      expect(estimatedGas).to.be.lessThan(100000n)

      console.log(`Estimated gas for token transfer: ${estimatedGas}`)
    })

    it('Should estimate gas costs for ETH transfers', async function () {
      const [owner, addr1] = await ethers.getSigners()

      const transferAmount = ethers.parseEther('0.001') // 0.001 ETH

      // 估算基础ETH转账的gas消耗
      const estimatedGas = await owner.estimateGas({
        to: addr1.address,
        value: transferAmount,
      })

      // 基础ETH转账需要21,000 gas（但可能会有微小差异）
      expect(estimatedGas).to.be.within(21000n, 21010n)

      console.log(`Estimated gas for ETH transfer: ${estimatedGas}`)
    })
  })
})

// 集成测试 - 需要在本地网络环境下运行
describe('Integration Tests', function () {
  // 这些测试需要实际的网络连接，跳过CI环境
  const skipInCI = process.env.CI === 'true'

  ;(skipInCI ? describe.skip : describe)('Full Distribution Flow', function () {
    it('Should complete full distribution workflow', async function () {
      // 这里可以添加完整的分发流程测试
      // 包括HD钱包生成、Gas分发、Token分发等
      console.log('Full integration test would run here')
      // 实际实现会很复杂，需要模拟整个分发过程
    })
  })
})
