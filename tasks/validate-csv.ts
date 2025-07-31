import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'fs'
import { task } from 'hardhat/config'
import { Logger } from './utils'

interface ValidationResult {
  isValid: boolean
  totalRecords: number
  validRecords: number
  issues: Array<{
    line: number
    type: 'FORMAT_ERROR' | 'INVALID_ADDRESS' | 'INVALID_AMOUNT' | 'DUPLICATE_ADDRESS' | 'ZERO_AMOUNT'
    message: string
    data?: Record<string, unknown>
  }>
  duplicateAddresses: Array<{
    address: string
    lines: number[]
    totalAmount: string
  }>
  summary: {
    validAddresses: number
    invalidAddresses: number
    duplicateAddresses: number
    totalAmount: string
    averageAmount: string
    minAmount: string
    maxAmount: string
  }
}

function validateCSV(csvContent: string, decimals: number = 18): ValidationResult {
  const lines = csvContent.trim().split('\n')
  const result: ValidationResult = {
    isValid: true,
    totalRecords: 0,
    validRecords: 0,
    issues: [],
    duplicateAddresses: [],
    summary: {
      validAddresses: 0,
      invalidAddresses: 0,
      duplicateAddresses: 0,
      totalAmount: '0',
      averageAmount: '0',
      minAmount: '0',
      maxAmount: '0',
    },
  }

  if (lines.length === 0) {
    result.isValid = false
    result.issues.push({
      line: 0,
      type: 'FORMAT_ERROR',
      message: 'CSV 文件为空',
    })
    return result
  }

  // 解析表头
  const headers = lines[0]
    .toLowerCase()
    .split(',')
    .map(h => h.trim())

  const addressIndex = headers.findIndex(h => h.includes('address') || h.includes('addr') || h.includes('to'))
  const amountIndex = headers.findIndex(h => h.includes('amount') || h.includes('value') || h.includes('balance'))

  if (addressIndex === -1) {
    result.isValid = false
    result.issues.push({
      line: 1,
      type: 'FORMAT_ERROR',
      message: 'CSV 文件中未找到地址列 (应包含 "address", "addr" 或 "to")',
    })
  }

  if (amountIndex === -1) {
    result.isValid = false
    result.issues.push({
      line: 1,
      type: 'FORMAT_ERROR',
      message: 'CSV 文件中未找到金额列 (应包含 "amount", "value" 或 "balance")',
    })
  }

  if (addressIndex === -1 || amountIndex === -1) {
    return result
  }

  // 用于检测重复地址
  const addressMap = new Map<string, number[]>()
  const validAmounts: bigint[] = []
  let totalAmount = 0n

  // 解析数据行
  for (let i = 1; i < lines.length; i++) {
    result.totalRecords++
    const lineNumber = i + 1
    const values = lines[i].split(',').map(v => v.trim())

    // 检查列数是否足够
    if (values.length < Math.max(addressIndex, amountIndex) + 1) {
      result.issues.push({
        line: lineNumber,
        type: 'FORMAT_ERROR',
        message: `数据格式不正确，列数不足`,
        data: { expected: Math.max(addressIndex, amountIndex) + 1, actual: values.length },
      })
      continue
    }

    const address = values[addressIndex]
    const amountStr = values[amountIndex]

    // 验证地址格式
    if (!address || address.trim() === '') {
      result.issues.push({
        line: lineNumber,
        type: 'INVALID_ADDRESS',
        message: '地址为空',
        data: { address },
      })
      continue
    }

    if (!ethers.isAddress(address)) {
      result.issues.push({
        line: lineNumber,
        type: 'INVALID_ADDRESS',
        message: '地址格式不正确',
        data: { address },
      })
      continue
    }

    // 记录地址用于重复检测
    const normalizedAddress = address.toLowerCase()
    if (!addressMap.has(normalizedAddress)) {
      addressMap.set(normalizedAddress, [])
    }
    addressMap.get(normalizedAddress)!.push(lineNumber)

    // 验证金额
    if (!amountStr || amountStr.trim() === '') {
      result.issues.push({
        line: lineNumber,
        type: 'INVALID_AMOUNT',
        message: '金额为空',
        data: { amount: amountStr },
      })
      continue
    }

    try {
      const amountBigInt = ethers.parseUnits(amountStr, decimals)
      if (amountBigInt <= 0n) {
        result.issues.push({
          line: lineNumber,
          type: 'ZERO_AMOUNT',
          message: '金额必须大于0',
          data: { amount: amountStr },
        })
        continue
      }

      // 有效记录
      result.validRecords++
      validAmounts.push(amountBigInt)
      totalAmount += amountBigInt
    } catch (error) {
      result.issues.push({
        line: lineNumber,
        type: 'INVALID_AMOUNT',
        message: '金额格式不正确',
        data: { amount: amountStr, error: error instanceof Error ? error.message : String(error) },
      })
      continue
    }
  }

  // 检查重复地址
  addressMap.forEach((lines, address) => {
    if (lines.length > 1) {
      result.issues.push({
        line: 0, // 多行问题
        type: 'DUPLICATE_ADDRESS',
        message: `地址重复出现 ${lines.length} 次`,
        data: { address, lines },
      })

      // 计算重复地址的总金额
      let duplicateAmount = 0n
      lines.forEach(lineIndex => {
        const values = csvContent
          .trim()
          .split('\n')
          [lineIndex - 1].split(',')
          .map((v: string) => v.trim())
        const amountStr = values[amountIndex]
        try {
          duplicateAmount += ethers.parseUnits(amountStr, decimals)
        } catch {
          // 忽略无效金额
        }
      })

      result.duplicateAddresses.push({
        address,
        lines,
        totalAmount: ethers.formatUnits(duplicateAmount, decimals),
      })
    }
  })

  // 生成汇总统计
  result.summary.validAddresses = addressMap.size - result.duplicateAddresses.length
  result.summary.invalidAddresses = result.totalRecords - result.validRecords
  result.summary.duplicateAddresses = result.duplicateAddresses.length
  result.summary.totalAmount = ethers.formatUnits(totalAmount, decimals)

  if (validAmounts.length > 0) {
    const avgAmount = totalAmount / BigInt(validAmounts.length)
    result.summary.averageAmount = ethers.formatUnits(avgAmount, decimals)

    const sortedAmounts = validAmounts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    result.summary.minAmount = ethers.formatUnits(sortedAmounts[0], decimals)
    result.summary.maxAmount = ethers.formatUnits(sortedAmounts[sortedAmounts.length - 1], decimals)
  }

  // 确定整体有效性
  result.isValid =
    result.issues.filter(
      issue =>
        issue.type === 'FORMAT_ERROR' ||
        issue.type === 'INVALID_ADDRESS' ||
        issue.type === 'INVALID_AMOUNT' ||
        issue.type === 'ZERO_AMOUNT',
    ).length === 0

  return result
}

task('validate-csv', '验证批量发送 CSV 文件的格式和内容')
  .addParam('csv', 'CSV 文件路径')
  .addOptionalParam('decimals', '代币小数位数 (默认: 18)', '18')
  .addOptionalParam('allowDuplicates', '是否允许重复地址 (默认: false)', 'false')
  .addOptionalParam('output', '输出验证报告到文件', '')
  .setAction(async (taskArgs, _hre) => {
    const { csv, decimals, allowDuplicates, output } = taskArgs

    try {
      Logger.info('🔍 开始验证 CSV 文件')
      Logger.info(`文件路径: ${csv}`)
      Logger.info(`代币小数位: ${decimals}`)
      Logger.info(`允许重复地址: ${allowDuplicates === 'true' ? '是' : '否'}`)

      // 检查文件是否存在
      if (!existsSync(csv)) {
        throw new Error(`CSV 文件不存在: ${csv}`)
      }

      // 读取文件
      const csvContent = readFileSync(csv, 'utf8')
      Logger.info(`📄 文件大小: ${csvContent.length} 字符`)

      // 验证 decimals 参数
      const decimalsNum = parseInt(decimals)
      if (isNaN(decimalsNum) || decimalsNum < 0 || decimalsNum > 77) {
        throw new Error('decimals 必须是 0-77 之间的数字')
      }

      // 执行验证
      const result = validateCSV(csvContent, decimalsNum)

      // 显示验证结果
      Logger.info(`\n📊 验证结果概览:`)
      Logger.info(`   文件状态: ${result.isValid ? '✅ 有效' : '❌ 无效'}`)
      Logger.info(`   总记录数: ${result.totalRecords}`)
      Logger.info(`   有效记录: ${result.validRecords}`)
      Logger.info(`   问题数量: ${result.issues.length}`)

      Logger.info(`\n📈 统计信息:`)
      Logger.info(`   有效地址: ${result.summary.validAddresses}`)
      Logger.info(`   无效地址: ${result.summary.invalidAddresses}`)
      Logger.info(`   重复地址: ${result.summary.duplicateAddresses}`)
      Logger.info(`   总金额: ${result.summary.totalAmount}`)
      if (result.validRecords > 0) {
        Logger.info(`   平均金额: ${result.summary.averageAmount}`)
        Logger.info(`   最小金额: ${result.summary.minAmount}`)
        Logger.info(`   最大金额: ${result.summary.maxAmount}`)
      }

      // 显示具体问题
      if (result.issues.length > 0) {
        Logger.info(`\n⚠️  发现的问题:`)

        const groupedIssues = result.issues.reduce(
          (groups, issue) => {
            if (!groups[issue.type]) {
              groups[issue.type] = []
            }
            groups[issue.type].push(issue)
            return groups
          },
          {} as Record<string, typeof result.issues>,
        )

        Object.entries(groupedIssues).forEach(([type, issues]) => {
          const typeNames = {
            FORMAT_ERROR: '格式错误',
            INVALID_ADDRESS: '无效地址',
            INVALID_AMOUNT: '无效金额',
            DUPLICATE_ADDRESS: '重复地址',
            ZERO_AMOUNT: '零金额',
          }

          Logger.info(`\n   ${typeNames[type as keyof typeof typeNames] || type} (${issues.length} 个):`)
          issues.slice(0, 10).forEach(issue => {
            if (issue.line > 0) {
              Logger.info(`     第 ${issue.line} 行: ${issue.message}`)
              if (issue.data) {
                const dataStr = typeof issue.data === 'object' ? JSON.stringify(issue.data) : String(issue.data)
                Logger.info(`       数据: ${dataStr}`)
              }
            } else {
              Logger.info(`     ${issue.message}`)
              if (issue.data) {
                Logger.info(`       详情: ${JSON.stringify(issue.data)}`)
              }
            }
          })

          if (issues.length > 10) {
            Logger.info(`     ... 还有 ${issues.length - 10} 个类似问题`)
          }
        })
      }

      // 显示重复地址详情
      if (result.duplicateAddresses.length > 0) {
        Logger.info(`\n🔄 重复地址详情:`)
        result.duplicateAddresses.slice(0, 5).forEach((dup, index) => {
          Logger.info(`   ${index + 1}. ${dup.address}`)
          Logger.info(`      出现行数: ${dup.lines.join(', ')}`)
          Logger.info(`      总金额: ${dup.totalAmount}`)
        })

        if (result.duplicateAddresses.length > 5) {
          Logger.info(`   ... 还有 ${result.duplicateAddresses.length - 5} 个重复地址`)
        }

        if (allowDuplicates !== 'true') {
          Logger.info(`\n💡 建议: 合并重复地址或使用 --allowDuplicates true 参数`)
        }
      }

      // 最终结论
      const shouldReject = result.issues.some(issue => issue.type !== 'DUPLICATE_ADDRESS' || allowDuplicates !== 'true')

      if (shouldReject) {
        Logger.info(`\n❌ 验证失败: 发现 ${result.issues.length} 个问题需要修复`)
      } else {
        Logger.info(`\n✅ 验证通过: 文件可以用于批量发送`)
      }

      // 输出报告到文件
      if (output) {
        const { writeFileSync } = await import('fs')

        const reportData = {
          ...result,
          metadata: {
            filePath: csv,
            decimals: decimalsNum,
            allowDuplicates: allowDuplicates === 'true',
            validatedAt: new Date().toISOString(),
            validationVersion: '1.0.0',
          },
        }

        writeFileSync(
          output,
          JSON.stringify(
            reportData,
            (key, value) => {
              if (typeof value === 'bigint') {
                return value.toString()
              }
              return value
            },
            2,
          ),
        )

        Logger.info(`📄 验证报告已保存到: ${output}`)
      }

      Logger.info('\n✅ CSV 验证任务完成!')

      // 如果有问题且不允许继续，抛出错误
      if (shouldReject) {
        process.exit(1)
      }
    } catch (error) {
      Logger.error('❌ CSV 验证任务失败:', error)
      throw error
    }
  })
