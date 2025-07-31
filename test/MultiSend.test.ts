import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import { MultiSend, TestToken } from '../typechain'

describe('MultiSend', function () {
  let multiSend: MultiSend
  let testToken: TestToken
  let owner: HardhatEthersSigner
  let addr1: HardhatEthersSigner
  let addr2: HardhatEthersSigner
  let addr3: HardhatEthersSigner

  beforeEach(async function () {
    ;[owner, addr1, addr2, addr3] = await ethers.getSigners()

    // 部署 MultiSend 合约
    const MultiSend = await ethers.getContractFactory('MultiSend')
    multiSend = await MultiSend.deploy()

    // 部署测试 Token
    const TestToken = await ethers.getContractFactory('TestToken')
    testToken = await TestToken.deploy('Test Token', 'TEST', 1000000)
  })

  describe('批量发送 ETH', function () {
    it('应该能够批量发送不同金额的 ETH', async function () {
      const recipients = [addr1.address, addr2.address, addr3.address]
      const amounts = [ethers.parseEther('1.0'), ethers.parseEther('2.0'), ethers.parseEther('0.5')]
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n)

      const initialBalances = await Promise.all(recipients.map(addr => ethers.provider.getBalance(addr)))

      await multiSend.batchSendETH(recipients, amounts, {
        value: totalAmount,
      })

      const finalBalances = await Promise.all(recipients.map(addr => ethers.provider.getBalance(addr)))

      for (let i = 0; i < recipients.length; i++) {
        expect(finalBalances[i] - initialBalances[i]).to.equal(amounts[i])
      }
    })

    it('应该能够批量发送相同金额的 ETH', async function () {
      const recipients = [addr1.address, addr2.address, addr3.address]
      const amountPerRecipient = ethers.parseEther('1.0')
      const totalAmount = amountPerRecipient * BigInt(recipients.length)

      const initialBalances = await Promise.all(recipients.map(addr => ethers.provider.getBalance(addr)))

      await multiSend.batchSendETHSameAmount(recipients, amountPerRecipient, {
        value: totalAmount,
      })

      const finalBalances = await Promise.all(recipients.map(addr => ethers.provider.getBalance(addr)))

      for (let i = 0; i < recipients.length; i++) {
        expect(finalBalances[i] - initialBalances[i]).to.equal(amountPerRecipient)
      }
    })

    it('应该退还多余的 ETH', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('1.0')]
      const totalAmount = amounts[0]
      const excessAmount = ethers.parseEther('0.5')

      const initialOwnerBalance = await ethers.provider.getBalance(owner.address)

      const tx = await multiSend.batchSendETH(recipients, amounts, {
        value: totalAmount + excessAmount,
      })
      const receipt = await tx.wait()
      const gasCost = receipt!.gasUsed * receipt!.gasPrice

      const finalOwnerBalance = await ethers.provider.getBalance(owner.address)
      const actualCost = initialOwnerBalance - finalOwnerBalance

      expect(actualCost).to.equal(totalAmount + gasCost)
    })

    it('应该在 ETH 不足时失败', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('2.0')]
      const insufficientValue = ethers.parseEther('1.0')

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: insufficientValue,
        }),
      ).to.be.revertedWith('MultiSend: Insufficient ETH sent')
    })
  })

  describe('批量发送 Token', function () {
    beforeEach(async function () {
      // 给 owner 一些测试 token
      const mintAmount = ethers.parseEther('10000')
      await testToken.mint(owner.address, mintAmount)
    })

    it('应该能够批量发送不同金额的 Token', async function () {
      const recipients = [addr1.address, addr2.address, addr3.address]
      const amounts = [ethers.parseEther('100'), ethers.parseEther('200'), ethers.parseEther('50')]
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n)

      // 授权 MultiSend 合约
      await testToken.approve(multiSend.getAddress(), totalAmount)

      const initialBalances = await Promise.all(recipients.map(addr => testToken.balanceOf(addr)))

      await multiSend.batchSendToken(testToken.getAddress(), recipients, amounts)

      const finalBalances = await Promise.all(recipients.map(addr => testToken.balanceOf(addr)))

      for (let i = 0; i < recipients.length; i++) {
        expect(finalBalances[i] - initialBalances[i]).to.equal(amounts[i])
      }
    })

    it('应该能够批量发送相同金额的 Token', async function () {
      const recipients = [addr1.address, addr2.address, addr3.address]
      const amountPerRecipient = ethers.parseEther('100')
      const totalAmount = amountPerRecipient * BigInt(recipients.length)

      // 授权 MultiSend 合约
      await testToken.approve(multiSend.getAddress(), totalAmount)

      const initialBalances = await Promise.all(recipients.map(addr => testToken.balanceOf(addr)))

      await multiSend.batchSendTokenSameAmount(testToken.getAddress(), recipients, amountPerRecipient)

      const finalBalances = await Promise.all(recipients.map(addr => testToken.balanceOf(addr)))

      for (let i = 0; i < recipients.length; i++) {
        expect(finalBalances[i] - initialBalances[i]).to.equal(amountPerRecipient)
      }
    })

    it('应该在授权不足时失败', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('100')]

      // 不进行授权
      await expect(multiSend.batchSendToken(testToken.getAddress(), recipients, amounts)).to.be.revertedWith(
        'MultiSend: Insufficient allowance',
      )
    })

    it('应该在余额不足时失败', async function () {
      const recipients = [addr1.address]

      // 获取当前余额并设置超过余额的金额
      const ownerBalance = await testToken.balanceOf(owner.address)
      const amounts = [ownerBalance + ethers.parseEther('1')] // 超过余额1个token

      await testToken.approve(multiSend.getAddress(), amounts[0])

      await expect(multiSend.batchSendToken(testToken.getAddress(), recipients, amounts)).to.be.revertedWith(
        'MultiSend: Insufficient token balance',
      )
    })
  })

  describe('参数验证', function () {
    it('应该在数组长度不匹配时失败', async function () {
      const recipients = [addr1.address, addr2.address]
      const amounts = [ethers.parseEther('1.0')] // 长度不匹配

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: amounts[0],
        }),
      ).to.be.revertedWith('MultiSend: Arrays length mismatch')
    })

    it('应该在空数组时失败', async function () {
      const recipients: string[] = []
      const amounts: bigint[] = []

      await expect(multiSend.batchSendETH(recipients, amounts, { value: 0 })).to.be.revertedWith('MultiSend: Empty arrays')
    })

    it('应该在地址为零时失败', async function () {
      const recipients = [ethers.ZeroAddress]
      const amounts = [ethers.parseEther('1.0')]

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: amounts[0],
        }),
      ).to.be.revertedWith('MultiSend: Invalid recipient address')
    })

    it('应该在金额为零时失败', async function () {
      const recipients = [addr1.address]
      const amounts = [0n]

      await expect(multiSend.batchSendETH(recipients, amounts, { value: 0 })).to.be.revertedWith('MultiSend: Amount must be greater than 0')
    })
  })

  describe('紧急功能', function () {
    it('所有者应该能够提取 ETH', async function () {
      // 向合约发送一些 ETH
      const sendAmount = ethers.parseEther('1.0')
      await owner.sendTransaction({
        to: multiSend.getAddress(),
        value: sendAmount,
      })

      const initialBalance = await ethers.provider.getBalance(owner.address)
      const tx = await multiSend.emergencyWithdrawETH()
      const receipt = await tx.wait()
      const gasCost = receipt!.gasUsed * receipt!.gasPrice
      const finalBalance = await ethers.provider.getBalance(owner.address)

      expect(finalBalance - initialBalance + gasCost).to.equal(sendAmount)
    })

    it('非所有者不应该能够提取 ETH', async function () {
      await expect(multiSend.connect(addr1).emergencyWithdrawETH()).to.be.revertedWithCustomError(multiSend, 'OwnableUnauthorizedAccount')
    })
  })

  describe('事件', function () {
    it('应该发出 BatchEthSent 事件', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('1.0')]

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: amounts[0],
        }),
      )
        .to.emit(multiSend, 'BatchEthSent')
        .withArgs(owner.address, amounts[0], recipients.length)
    })

    it('应该发出 BatchTokenSent 事件', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('100')]

      await testToken.mint(owner.address, amounts[0])
      await testToken.approve(multiSend.getAddress(), amounts[0])

      await expect(multiSend.batchSendToken(testToken.getAddress(), recipients, amounts))
        .to.emit(multiSend, 'BatchTokenSent')
        .withArgs(owner.address, testToken.getAddress(), amounts[0], recipients.length)
    })
  })

  describe('参数验证', function () {
    it('应该在数组长度不匹配时失败', async function () {
      const recipients = [addr1.address, addr2.address]
      const amounts = [ethers.parseEther('1.0')] // 长度不匹配

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: amounts[0],
        }),
      ).to.be.revertedWith('MultiSend: Arrays length mismatch')
    })

    it('应该在空数组时失败', async function () {
      const recipients: string[] = []
      const amounts: bigint[] = []

      await expect(multiSend.batchSendETH(recipients, amounts, { value: 0 })).to.be.revertedWith('MultiSend: Empty arrays')
    })

    it('应该在地址为零时失败', async function () {
      const recipients = [ethers.ZeroAddress]
      const amounts = [ethers.parseEther('1.0')]

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: amounts[0],
        }),
      ).to.be.revertedWith('MultiSend: Invalid recipient address')
    })

    it('应该在金额为零时失败', async function () {
      const recipients = [addr1.address]
      const amounts = [0n]

      await expect(multiSend.batchSendETH(recipients, amounts, { value: 0 })).to.be.revertedWith('MultiSend: Amount must be greater than 0')
    })
  })

  describe('紧急功能', function () {
    it('所有者应该能够提取 ETH', async function () {
      // 向合约发送一些 ETH
      const sendAmount = ethers.parseEther('1.0')
      await owner.sendTransaction({
        to: multiSend.getAddress(),
        value: sendAmount,
      })

      const initialBalance = await ethers.provider.getBalance(owner.address)
      const tx = await multiSend.emergencyWithdrawETH()
      const receipt = await tx.wait()
      const gasCost = receipt!.gasUsed * receipt!.gasPrice
      const finalBalance = await ethers.provider.getBalance(owner.address)

      expect(finalBalance - initialBalance + gasCost).to.equal(sendAmount)
    })

    it('非所有者不应该能够提取 ETH', async function () {
      await expect(multiSend.connect(addr1).emergencyWithdrawETH()).to.be.revertedWithCustomError(multiSend, 'OwnableUnauthorizedAccount')
    })
  })

  describe('事件', function () {
    it('应该发出 BatchEthSent 事件', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('1.0')]

      await expect(
        multiSend.batchSendETH(recipients, amounts, {
          value: amounts[0],
        }),
      )
        .to.emit(multiSend, 'BatchEthSent')
        .withArgs(owner.address, amounts[0], recipients.length)
    })

    it('应该发出 BatchTokenSent 事件', async function () {
      const recipients = [addr1.address]
      const amounts = [ethers.parseEther('100')]

      await testToken.mint(owner.address, amounts[0])
      await testToken.approve(multiSend.getAddress(), amounts[0])

      await expect(multiSend.batchSendToken(testToken.getAddress(), recipients, amounts))
        .to.emit(multiSend, 'BatchTokenSent')
        .withArgs(owner.address, testToken.getAddress(), amounts[0], recipients.length)
    })
  })
})
