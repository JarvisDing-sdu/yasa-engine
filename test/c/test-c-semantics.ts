import * as path from 'path'
import * as fs from 'fs'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
const { execute } = require('../../src/interface/starter')
const Config = require('../../src/config')

/**
 * C 语义回归：struct 按值复制、多级指针、宏的顺序/#undef/条件/头文件、控制流（goto/return/
 * break/continue/短路/常量折叠）、编译单元链接、libc 覆盖/部分写入/格式串取参/数值污点。
 *
 * 用例名以 `_T` 结尾必须报告（用例内恰有一个 sink），以 `_F` 结尾不得报告；多文件用例是目录。
 * 标签由 clang 编译运行核对（workstreams/yasa-c-extension/scripts/c_semantics_oracle.py）。
 */
const CASES_DIR = path.resolve(__dirname, 'semantics-cases')
const RULE_CONFIG = path.resolve(__dirname, 'rule_config_c_semantics.json')

/** 重置 commander 回调修改的运行时字段，避免跨测试污染 */
function resetConfig(): void {
  Config.checkerIds = []
  Config.checkerPackIds = []
  Config.ruleConfigFile = ''
  Config.reportDir = ''
  Config.language = undefined
  Config.single = false
}

/**
 * @returns 用例相对路径（不含 .c）→ 是否应报告
 */
function collectCases(): Map<string, boolean> {
  const cases = new Map<string, boolean>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const stem = entry.name.replace(/\.c$/, '')
      const labelled = /_[TF]$/.test(stem) && (entry.isDirectory() || entry.name.endsWith('.c'))
      if (labelled) cases.set(path.relative(CASES_DIR, path.join(dir, stem)), stem.endsWith('_T'))
      else if (entry.isDirectory()) walk(full)
    }
  }
  walk(CASES_DIR)
  return cases
}

describe('C Semantics Regression Tests (taint-flow-c-default)', function () {
  this.timeout(0)
  const reportDir = path.resolve('/tmp', 'c-semantics-test')
  const cases = collectCases()
  const detected = new Set<string>()

  before(async function () {
    fs.rmSync(reportDir, { recursive: true, force: true })
    resetConfig()
    await execute(null, [
      CASES_DIR,
      '--ruleConfigFile',
      RULE_CONFIG,
      '--checkerPackIds',
      'taint-flow-c-default',
      '--language',
      'c',
      '--report',
      reportDir,
    ])
    const sarif = JSON.parse(fs.readFileSync(path.join(reportDir, 'report.sarif'), 'utf-8'))
    for (const run of sarif.runs || []) {
      for (const result of run.results || []) {
        const file = path.resolve(CASES_DIR, result.locations[0].physicalLocation.artifactLocation.uri.replace(/^file:\/\//, ''))
        const rel = path.relative(CASES_DIR, file).replace(/\.c$/, '')
        const parts = rel.split(path.sep)
        for (let i = parts.length; i > 0; i--) {
          const candidate = parts.slice(0, i).join(path.sep)
          if (cases.has(candidate)) {
            detected.add(candidate)
            break
          }
        }
      }
    }
  })

  it('has paired positive and negative cases', function () {
    const labels = [...cases.values()]
    assert.ok(labels.filter(Boolean).length >= 30 && labels.filter((l) => !l).length >= 30)
  })

  for (const [name, expected] of collectCases()) {
    it(`${expected ? 'reports' : 'does not report'} ${name}`, function () {
      assert.strictEqual(detected.has(name), expected)
    })
  }
})
