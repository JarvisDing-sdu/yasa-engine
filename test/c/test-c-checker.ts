import * as path from 'path'
import * as fs from 'fs'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
const { execute } = require('../../src/interface/starter')
const Config = require('../../src/config')

const WORKSPACE_ROOT = path.resolve(__dirname, '../..')
const RULE_CONFIG = path.resolve(WORKSPACE_ROOT, 'resource', 'example-rule-config', 'rule_config_c.json')
const TEST_CASES_DIR = path.resolve(__dirname, 'checker-cases')

/** 重置 commander 回调修改的运行时字段，避免跨测试污染 */
function resetConfig(): void {
  Config.dumpCG = false
  Config.dumpAllCG = false
  Config.dumpAST = false
  Config.dumpAllAST = false
  Config.single = false
  Config.checkerIds = []
  Config.checkerPackIds = []
  Config.ruleConfigFile = ''
  Config.reportDir = ''
  Config.language = undefined
  Config.uastSDKPath = undefined
}

/** SARIF 中每条 finding 的 `文件名:sink 行号` */
function findingLocations(reportDir: string): string[] {
  const sarif = JSON.parse(fs.readFileSync(path.join(reportDir, 'report.sarif'), 'utf-8'))
  const locations: string[] = []
  for (const run of sarif.runs || []) {
    for (const result of run.results || []) {
      const loc = result.locations[0].physicalLocation
      locations.push(`${path.basename(loc.artifactLocation.uri)}:${loc.region.startLine}`)
    }
  }
  return [...new Set(locations)].sort()
}

describe('C Checker Regression Tests (taint-flow-c-default)', function () {
  this.timeout(0)
  const reportDir = path.resolve('/tmp', 'c-checker-test-taint')
  let findings: string[] = []
  let summary: any

  before(async function () {
    fs.rmSync(reportDir, { recursive: true, force: true })
    resetConfig()
    await execute(null, [
      TEST_CASES_DIR,
      '--ruleConfigFile',
      RULE_CONFIG,
      '--checkerPackIds',
      'taint-flow-c-default',
      '--language',
      'c',
      '--report',
      reportDir,
    ])
    summary = JSON.parse(fs.readFileSync(path.join(reportDir, 'scan_summary.json'), 'utf-8'))
    findings = findingLocations(reportDir)
  })

  it('parses every C file', function () {
    assert.strictEqual(summary.fileCount, fs.readdirSync(TEST_CASES_DIR).length)
  })

  it('reports exactly the vulnerable sinks', function () {
    assert.deepStrictEqual(findings, [
      'fgets_printf_002_T.c:13',
      'getenv_system_001_T.c:12',
      'pointer_out_param.c:13',
      'pointer_out_param.c:14',
      'recv_strcpy_005_T.c:15',
      'scanf_sprintf_system_007_T.c:16',
      'vulnerable.c:15',
      'vulnerable.c:28',
      'vulnerable.c:8',
    ])
  })

  it('does not report safe uses', function () {
    assert.ok(!findings.some((f) => f.includes('_F.c')), findings.join(', '))
  })
})
