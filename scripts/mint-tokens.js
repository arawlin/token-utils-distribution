const hre = require('hardhat')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

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

  // 读取配置文件获取机构地址
  const configDir = './.ws'
  const configPath = join(configDir, 'distribution-config.json')

  if (!existsSync(configPath)) {
    console.error('配置文件不存在，请先运行 init-hd-tree 任务')
    return
  }

  // 加载配置
  const config = JSON.parse(readFileSync(configPath, 'utf8'))

  // 获取所有 depth 0 (主要机构) 的地址
  const depth0Addresses = config.institutionTree.filter(institution => institution.depth === 0).map(institution => institution.addresses[0]) // 取每个机构的第一个地址

  console.log('\n找到的主要机构地址 (depth 0):')
  depth0Addresses.forEach((address, index) => {
    const institution = config.institutionTree.find(inst => inst.depth === 0 && inst.addresses[0] === address)
    console.log(`  ${index + 1}. ${institution.institutionName}: ${address}`)
  })

  if (depth0Addresses.length === 0) {
    console.error('未找到 depth 0 的机构地址')
    return
  }

  // 执行批量转账任务
  console.log('\n开始执行批量转账...')
  await hre.run('batch-transfer-token', {
    holdRatio: '0.1',
    trailingZeros: '2',
    delayMin: '1000',
    delayMax: '5000',
    from: sourceAddress,
    tos: depth0Addresses.join(','), // 动态获取的主要机构地址
  })
}

mintTokens().catch(console.error)
