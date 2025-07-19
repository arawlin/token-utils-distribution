import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { task } from 'hardhat/config'
import { join } from 'path'
import { gasDistributionConfig, obfuscationConfig, tokenDistributionConfig } from '../config/distribution'
import { institutionTreeConfig } from '../config/institutions'
import { DistributionSystemConfig, InstitutionNode } from '../types'
import { generateInstitutionAddresses, generateMasterSeed, Logger } from './utils'

task('init-hd-tree', '初始化HD钱包树结构')
  .addOptionalParam('outputDir', '输出目录', './.ws')
  .addFlag('force', '强制重新生成（覆盖已有文件）')
  .addFlag('dryRun', '干运行模式（不执行实际操作）')
  .setAction(async (taskArgs, hre) => {
    const { outputDir, force, dryRun } = taskArgs

    Logger.info('开始初始化HD钱包树结构')
    Logger.info(`网络: ${hre.network.name}`)
    Logger.info(`输出目录: ${outputDir}`)
    Logger.info(`干运行模式: ${dryRun}`)

    // 创建输出目录
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const configPath = join(outputDir, 'distribution-config.json')
    const seedPath = join(outputDir, 'master-seed.json')

    // 检查文件是否已存在
    if (!force && (existsSync(configPath) || existsSync(seedPath))) {
      Logger.warn('配置文件已存在，使用 --force 标志强制重新生成')
      return
    }

    try {
      // 生成主种子
      Logger.info('生成主HD钱包种子...')
      const masterSeed = generateMasterSeed()

      // 深拷贝机构树配置
      const institutionTree: InstitutionNode[] = JSON.parse(JSON.stringify(institutionTreeConfig))

      // 为每个机构节点生成地址
      Logger.info('为机构节点生成地址...')
      let totalAddresses = 0

      for (const rootNode of institutionTree) {
        await generateInstitutionAddresses(masterSeed, rootNode)
        totalAddresses += countAddressesInTree(rootNode)
      }

      Logger.info(`总共生成了 ${totalAddresses} 个地址`)

      // 创建完整配置
      const config: DistributionSystemConfig = {
        masterSeed: masterSeed,
        institutionTree: institutionTree,
        gasDistribution: gasDistributionConfig,
        tokenDistribution: tokenDistributionConfig,
        obfuscation: obfuscationConfig,
        dryRun: dryRun,
        networkName: hre.network.name,
      }

      if (!dryRun) {
        // 保存配置文件（不包含敏感信息）
        const publicConfig = {
          ...config,
          masterSeed: '[ENCRYPTED]',
          institutionTree: institutionTree.map(sanitizeNodeForPublic),
        }

        writeFileSync(configPath, JSON.stringify(publicConfig, null, 2))
        Logger.info(`公开配置已保存到: ${configPath}`)

        // 保存加密的种子文件
        const seedConfig = {
          masterSeed: masterSeed,
          createdAt: new Date().toISOString(),
          networkName: hre.network.name,
        }

        writeFileSync(seedPath, JSON.stringify(seedConfig, null, 2))
        Logger.info(`主种子已保存到: ${seedPath}`)
        Logger.warn('⚠️  请妥善保管种子文件，丢失后无法恢复！')
      }

      // 显示统计信息
      displayTreeStatistics(institutionTree)

      Logger.info('HD钱包树初始化完成!')
    } catch (error) {
      Logger.error('初始化失败:', error)
      throw error
    }
  })

// 统计树中的地址数量
function countAddressesInTree(node: InstitutionNode): number {
  let count = node.addressCount
  for (const child of node.childNodes) {
    count += countAddressesInTree(child)
  }
  return count
}

// 清理节点信息用于公开配置
function sanitizeNodeForPublic(node: InstitutionNode): InstitutionNode {
  return {
    hdPath: node.hdPath,
    depth: node.depth,
    addressCount: node.addressCount,
    childNodes: node.childNodes.map(sanitizeNodeForPublic),
    addresses: node.addresses,
    privateKeys: node.privateKeys, // 保留地址和私钥用于内部使用
    institutionName: node.institutionName,
    gasReceiveWindow: node.gasReceiveWindow,
    tokenReceiveWindow: node.tokenReceiveWindow,
  }
}

// 显示树形结构统计信息
function displayTreeStatistics(tree: InstitutionNode[]) {
  Logger.info('\n=== HD钱包树统计信息 ===')

  let totalNodes = 0
  let totalAddresses = 0
  const depthCounts: { [depth: number]: number } = {}

  function analyzeTree(nodes: InstitutionNode[]) {
    for (const node of nodes) {
      totalNodes++
      totalAddresses += node.addressCount

      depthCounts[node.depth] = (depthCounts[node.depth] || 0) + 1

      if (node.childNodes.length > 0) {
        analyzeTree(node.childNodes)
      }
    }
  }

  analyzeTree(tree)

  Logger.info(`总机构节点数: ${totalNodes}`)
  Logger.info(`总地址数: ${totalAddresses}`)
  Logger.info(`树的最大深度: ${Math.max(...Object.keys(depthCounts).map(Number))}`)

  Logger.info('\n各层级机构分布:')
  for (const [depth, count] of Object.entries(depthCounts)) {
    Logger.info(`  深度 ${depth}: ${count} 个机构`)
  }

  // 显示树形结构
  Logger.info('\n机构树结构:')
  displayTreeStructure(tree, 0)
}

// 显示树形结构
function displayTreeStructure(nodes: InstitutionNode[], indent: number) {
  const prefix = '  '.repeat(indent)

  for (const node of nodes) {
    const nodeInfo = `${node.hdPath} (${node.addressCount} addresses)`
    Logger.info(`${prefix}├─ ${nodeInfo}`)

    if (node.childNodes.length > 0) {
      displayTreeStructure(node.childNodes, indent + 1)
    }
  }
}
