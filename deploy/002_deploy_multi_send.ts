import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

const deployMultiSend: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  console.log(`\n🚀 部署 MultiSend 合约到 ${hre.network.name} 网络`)
  console.log(`部署账户: ${deployer}`)

  // 获取部署账户余额
  const balance = await ethers.provider.getBalance(deployer)
  console.log(`部署账户余额: ${ethers.formatEther(balance)} ETH`)

  // 部署 MultiSend 合约
  const deployResult = await deploy('MultiSend', {
    from: deployer,
    args: [], // MultiSend 构造函数不需要参数
    log: true,
    waitConfirmations: hre.network.name === 'localhost' ? 1 : 5,
  })

  // 保存部署信息到环境变量文件
  console.log(`\n💡 请将以下信息添加到您的 .env 文件:`)
  console.log(`MULTISEND_ADDRESS=${deployResult.address}`)
}

export default deployMultiSend
deployMultiSend.tags = ['MultiSend']
