import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  console.log(`Deploying TestToken on ${hre.network.name} with account: ${deployer}`)

  const deployment = await deploy('TestToken', {
    from: deployer,
    args: [
      'Test Distribution Token', // name
      'TDT', // symbol
      1000000000, // initialSupply (1 billion tokens)
    ],
    log: true,
    waitConfirmations: hre.network.name === 'hardhat' ? 1 : 2,
  })

  console.log(`TestToken deployed to: ${deployment.address}`)

  if (hre.network.name !== 'hardhat') {
    // 验证合约
    try {
      await hre.run('verify:verify', {
        address: deployment.address,
        constructorArguments: ['Test Distribution Token', 'TDT', 1000000000],
      })
      console.log('Contract verified on Etherscan')
    } catch (error) {
      console.log('Contract verification failed:', error)
    }
  }
}

func.tags = ['TestToken']
export default func
