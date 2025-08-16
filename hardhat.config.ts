import '@nomicfoundation/hardhat-toolbox'
import 'dotenv/config'
import 'hardhat-deploy'
import { HardhatUserConfig } from 'hardhat/config'

import './tasks'
import { Logger } from './tasks/utils'

// 在 Hardhat 配置加载时立即初始化 Logger
const initializeLogger = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').split('.')[0]
  const logFilename = `hardhat-${timestamp}.log`
  Logger.setLogFile(logFilename)
  Logger.info('🚀 Hardhat 配置已加载，Logger 已初始化')
}

// 立即执行 Logger 初始化
initializeLogger()

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
  defaultNetwork: 'mainnet',
  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
      ...networkSettings,
    },
    hardhat: {
      chainId: 1337,
      mining: {
        auto: true,
        interval: 1000,
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
