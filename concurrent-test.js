#!/usr/bin/env node

/**
 * 并发执行测试脚本
 *
 * 这个脚本演示如何并发执行三个任务：
 * 1. distribute-gas (Gas分发)
 * 2. distribute-tokens (Token分发)
 * 3. obfuscation (抗检测干扰交易)
 *
 * 使用TaskCoordinator进行资源协调和错误处理
 */

const { spawn } = require('child_process')
const path = require('path')

// 颜色输出函数
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function colorLog(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

// 任务配置
const tasks = [
  {
    name: 'distribute-gas',
    color: 'green',
    args: ['hardhat', 'distribute-gas', '--network', 'localhost', '--dry-run', '--max-retries', '2'],
  },
  {
    name: 'distribute-tokens',
    color: 'blue',
    args: [
      'hardhat',
      'distribute-tokens',
      '--network',
      'localhost',
      '--dry-run',
      '--batch-size',
      '3',
      '--max-retries',
      '2',
    ],
  },
  {
    name: 'obfuscation',
    color: 'magenta',
    args: [
      'hardhat',
      'obfuscation',
      '--network',
      'localhost',
      '--dry-run',
      '--duration',
      '2',
      '--intensity',
      '0.5',
      '--max-retries',
      '2',
    ],
  },
]

// 执行单个任务
function executeTask(task) {
  return new Promise((resolve, reject) => {
    colorLog(task.color, `🚀 启动任务: ${task.name}`)

    const process = spawn('npx', task.args, {
      cwd: __dirname,
      stdio: 'pipe',
      shell: true,
    })

    let output = ''
    let errorOutput = ''

    process.stdout.on('data', data => {
      const message = data.toString().trim()
      if (message) {
        output += message + '\n'
        colorLog(task.color, `[${task.name}] ${message}`)
      }
    })

    process.stderr.on('data', data => {
      const message = data.toString().trim()
      if (message) {
        errorOutput += message + '\n'
        colorLog('red', `[${task.name}] ERROR: ${message}`)
      }
    })

    process.on('close', code => {
      if (code === 0) {
        colorLog(task.color, `✅ 任务完成: ${task.name}`)
        resolve({ task: task.name, success: true, output })
      } else {
        colorLog('red', `❌ 任务失败: ${task.name} (退出码: ${code})`)
        reject({ task: task.name, success: false, code, error: errorOutput, output })
      }
    })

    process.on('error', error => {
      colorLog('red', `❌ 任务启动失败: ${task.name} - ${error.message}`)
      reject({ task: task.name, success: false, error: error.message })
    })
  })
}

// 主执行函数
async function runConcurrentTasks() {
  colorLog('cyan', '='.repeat(60))
  colorLog('cyan', '🔄 开始并发执行三个分发任务')
  colorLog('cyan', '='.repeat(60))

  console.log()
  colorLog('yellow', '📋 任务列表:')
  tasks.forEach(task => {
    colorLog(task.color, `  • ${task.name}: ${task.args.slice(1).join(' ')}`)
  })
  console.log()

  const startTime = Date.now()

  try {
    // 并发执行所有任务
    const results = await Promise.allSettled(tasks.map(task => executeTask(task)))

    const endTime = Date.now()
    const duration = ((endTime - startTime) / 1000).toFixed(2)

    console.log()
    colorLog('cyan', '='.repeat(60))
    colorLog('cyan', '📊 执行结果统计')
    colorLog('cyan', '='.repeat(60))

    let successCount = 0
    let failureCount = 0

    results.forEach((result, index) => {
      const taskName = tasks[index].name
      const taskColor = tasks[index].color

      if (result.status === 'fulfilled') {
        colorLog(taskColor, `✅ ${taskName}: 成功完成`)
        successCount++
      } else {
        colorLog('red', `❌ ${taskName}: 执行失败`)
        if (result.reason.error) {
          colorLog('red', `   错误信息: ${result.reason.error}`)
        }
        failureCount++
      }
    })

    console.log()
    colorLog('cyan', `⏱️  总执行时间: ${duration} 秒`)
    colorLog('green', `✅ 成功任务数: ${successCount}/${tasks.length}`)

    if (failureCount > 0) {
      colorLog('red', `❌ 失败任务数: ${failureCount}/${tasks.length}`)
    }

    colorLog('cyan', '='.repeat(60))

    if (successCount === tasks.length) {
      colorLog('green', '🎉 所有任务都成功完成！TaskCoordinator协调机制正常工作！')
    } else {
      colorLog('yellow', '⚠️  部分任务未成功完成，请检查错误信息。')
    }
  } catch (error) {
    colorLog('red', `❌ 并发执行失败: ${error.message}`)
    process.exit(1)
  }
}

// 程序入口
if (require.main === module) {
  colorLog('cyan', '🎯 Token Distribution 并发测试工具')
  console.log()

  // 检查是否有配置文件
  const fs = require('fs')
  const configPath = path.join(__dirname, 'generated', 'distribution-config.json')

  if (!fs.existsSync(configPath)) {
    colorLog('red', '❌ 未找到配置文件，请先运行 init-hd-tree 任务：')
    colorLog('yellow', '   npx hardhat init-hd-tree --network localhost')
    process.exit(1)
  }

  runConcurrentTasks()
    .then(() => {
      colorLog('cyan', '🏁 测试完成')
      process.exit(0)
    })
    .catch(error => {
      colorLog('red', `❌ 测试失败: ${error}`)
      process.exit(1)
    })
}

module.exports = { runConcurrentTasks, executeTask }
