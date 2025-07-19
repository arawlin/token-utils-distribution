import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import 'hardhat-deploy'
import 'dotenv/config'

import './tasks'

const networkSettings = {
  gas: 'auto' as const,
  gasPrice: 'auto' as const,
  gasMultiplier: 1,
  timeout: 100000,
  throwOnTransactionFailures: true,
  throwOnCallFailures: true,
  saveDeployments: true,
}

const config: HardhatUserConfig = {
  solidity: {
    overrides: {},
    compilers: [
      {
        version: '0.8.28',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
  },
  // defaultNetwork: 'localhost',
  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
      ...networkSettings,
    },
    hardhat: {
      chainId: 1337,
      mining: {
        auto: true,
        interval: 5000,
      },
      ...networkSettings,
    },
    sepolia: {
      url: process.env.RPC ?? '',
      ...networkSettings,
    },
    mainnet: {
      url: process.env.RPC ?? '',
      ...networkSettings,
    },
  },
  etherscan: {
    apiKey: process.env.APIKEY ?? '',
  },
  gasReporter: {
    currency: 'USD',
    enabled: true,
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v6',
  },
  mocha: {
    timeout: 20000,
  },
}

export default config
