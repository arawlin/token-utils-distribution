const hre = require('hardhat')

async function mintTokens() {
  const TestToken = await hre.ethers.getContractFactory('TestToken')
  const token = TestToken.attach(process.env.TOKEN_ADDRESS)

  // 源钱包地址
  const sourceAddress = process.env.SOURCE_ADDRESS

  // 铸造 1亿个代币 (100000000 * 10^18)
  const amount = hre.ethers.parseEther('100000000')

  const [owner] = await hre.ethers.getSigners()
  console.log('Owner:', owner.address)
  console.log('Minting tokens to:', sourceAddress)
  console.log('Amount:', hre.ethers.formatEther(amount), 'TDT')

  const tx = await token.connect(owner).mint(sourceAddress, amount)
  console.log('Transaction hash:', tx.hash)
  await tx.wait()

  const balance = await token.balanceOf(sourceAddress)
  console.log('New balance:', hre.ethers.formatEther(balance), 'TDT')
}

mintTokens().catch(console.error)
