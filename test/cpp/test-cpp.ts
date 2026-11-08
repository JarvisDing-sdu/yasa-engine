import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
const { execute } = require('../../src/interface/starter')
const Config = require('../../src/config')

/**
 * C++ 回归：`--language cpp` 的污点分析与调用图。
 *
 * cases/ 下用例名以 `_T` 结尾必须报告，以 `_F` 结尾不得报告；多文件用例是目录。
 */
const CASES_DIR = path.resolve(__dirname, 'cases')
const MIXED_DIR = path.resolve(__dirname, 'mixed-project')
const RULE_CONFIG = path.resolve(__dirname, '../../resource/example-rule-config/rule_config_cpp.json')

/** 重置 commander 回调修改的运行时字段，避免跨测试污染 */
function resetConfig(): void {
  Config.checkerIds = []
  Config.checkerPackIds = []
  Config.ruleConfigFile = ''
  Config.reportDir = ''
  Config.language = undefined
  Config.analyzer = undefined
  Config.single = false
  Config.dumpCG = false
  Config.dumpAllCG = false
}

/**
 * @param file - JSON 文件
 * @returns 解析后的内容（报告由写入流异步落盘，execute 返回时可能尚未写完）
 */
async function readJson(file: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`not written: ${file}`)
}

/**
 * @param sourceDir - 扫描目录
 * @param reportDir - 报告目录
 * @returns 报告中各结果的 sink 文件（相对 sourceDir）
 */
async function scanFindings(sourceDir: string, reportDir: string): Promise<string[]> {
  resetConfig()
  await execute(null, [
    sourceDir, '--language', 'cpp', '--ruleConfigFile', RULE_CONFIG,
    '--checkerPackIds', 'taint-flow-cpp-default', '--report', reportDir,
  ])
  const sarifFile = path.join(reportDir, 'report.sarif')
  if (!fs.existsSync(sarifFile)) return []
  const sarif = await readJson(sarifFile)
  const files: string[] = []
  for (const run of sarif.runs || []) {
    for (const result of run.results || []) {
      const uri = result.locations[0].physicalLocation.artifactLocation.uri.replace(/^file:\/\//, '')
      files.push(path.relative(sourceDir, path.resolve(sourceDir, uri)))
    }
  }
  return files
}

/**
 * @returns 用例名（不含扩展名）→ 是否应报告
 */
function collectCases(): Map<string, boolean> {
  const cases = new Map<string, boolean>()
  for (const entry of fs.readdirSync(CASES_DIR, { withFileTypes: true })) {
    const stem = entry.name.replace(/\.cpp$/, '')
    if (/_[TF]$/.test(stem)) cases.set(stem, stem.endsWith('_T'))
  }
  return cases
}

describe('C++ Regression Tests (taint-flow-cpp-default)', function () {
  this.timeout(0)
  const cases = collectCases()
  const detected = new Set<string>()

  before(async function () {
    for (const file of await scanFindings(CASES_DIR, fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-cases-')))) {
      detected.add(file.split(path.sep)[0].replace(/\.cpp$/, ''))
    }
  })

  for (const [name, expected] of cases) {
    it(`${expected ? 'reports' : 'does not report'} ${name}`, function () {
      assert.strictEqual(detected.has(name), expected)
    })
  }

  it('cpp mode ignores .c files and parses .h as C++', async function () {
    const files = await scanFindings(MIXED_DIR, fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-mixed-')))
    assert.deepStrictEqual([...new Set(files)], ['main.cpp'])
    const Parser = require('../../src/engine/parser/parser')
    const units = await Parser.parseProject(MIXED_DIR, { language: 'cpp' })
    assert.ok(Object.keys(units).some((f) => f.endsWith('/api.h')))
    assert.ok(!Object.keys(units).some((f) => f.endsWith('/helper.c')))
    for (const ast of Object.values<any>(units)) {
      assert.strictEqual(ast.language, 'cpp')
      assert.deepStrictEqual(ast._meta.parseErrors, [])
    }
  })

  it('dumps a call graph in cpp mode', async function () {
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-callgraph-'))
    const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-callgraph-src-'))
    fs.copyFileSync(path.join(CASES_DIR, 'namespace_call_T.cpp'), path.join(caseDir, 'namespace_call_T.cpp'))
    resetConfig()
    await execute(null, [
      caseDir, '--language', 'cpp', '--checkerIds', 'callgraph', '--dumpAllCG',
      '--ruleConfigFile', RULE_CONFIG, '--report', reportDir,
    ])
    const callgraph = await readJson(path.join(reportDir, 'callgraph.json'))
    const edges = Object.values<any>(callgraph.edges).map((e) => [e.sourceNodeId.split(' ')[0], e.targetNodeId])
    assert.ok(edges.some(([from, to]) => from === 'bad' && /system/.test(to)), JSON.stringify(edges))
  })
})
