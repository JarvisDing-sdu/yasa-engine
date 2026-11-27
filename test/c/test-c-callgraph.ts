import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, it, before } from 'mocha'
import * as assert from 'assert'
import { Graph, graphHasFunctionDefinition } from '../../src/util/graph'
const { execute } = require('../../src/interface/starter')
const Config = require('../../src/config')

/**
 * C 调用图回归（--dumpAllCG）：通过函数指针字段调用的回调。
 *
 * 每个用例是 callgraph-cases/ 下的一个目录（单独作为一个项目扫描）。expected.json 记录
 * `文件:调用方函数` 处必须解析到的目标函数（must）与不得出现的目标函数（mustNot）。
 * 只计入解析到函数定义的目标；未解析的占位节点不算命中。
 */
const CASES_DIR = path.resolve(__dirname, 'callgraph-cases')
const RULE_CONFIG = path.resolve(__dirname, '../../resource/example-rule-config/rule_config_c.json')

type Site = { must: string[]; mustNot: string[] }

describe('callgraph function definition lookup', () => {
  const definition = (hash: string, line: number, column = 1) => ({
    _meta: { nodehash: hash }, loc: { sourcefile: 'a.c', start: { line, column }, end: { line, column } },
  })

  it('finds definitions by line when hashes and columns differ, including restored nodes', () => {
    const source = definition('source', 7)
    const query = definition('alias', 7, 16)
    const graph = new Graph()
    graph.addNode('f', { funcDefNodehash: 'source' })
    const ast = new Map([['source', source]])
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, query, ast), true)
    assert.strictEqual(graphHasFunctionDefinition(new Map(graph.nodes), query, ast), true)
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, definition('source', 0), ast), false)
  })

  it('rechecks the representative after graph overwrites, deletions and AST replacement', () => {
    const source = definition('source', 7)
    const other = definition('other', 8)
    const graph = new Graph()
    const ast = new Map([['source', source], ['other', other]])
    graph.addNode('first', { funcDef: source })
    graph.addNode('second', { funcDefNodehash: 'source' })
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, source, ast), true)
    graph.addNode('second', { funcDefNodehash: 'other' })
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, source, ast), true)
    graph.nodes.delete('first')
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, source, ast), false)
    ast.set('other', source)
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, source, ast), true)
    ast.delete('other')
    assert.strictEqual(graphHasFunctionDefinition(graph.nodes, source, ast), false)
  })
})

/** 重置 commander 回调修改的运行时字段，避免跨测试污染 */
function resetConfig(): void {
  Config.checkerIds = []
  Config.checkerPackIds = []
  Config.ruleConfigFile = ''
  Config.reportDir = ''
  Config.language = undefined
  Config.single = false
  Config.dumpCG = false
  Config.dumpAllCG = false
}

/**
 * callgraph.json 由写入流异步落盘，execute 返回时可能尚未写完。
 * @param file - callgraph.json 路径
 * @returns 解析后的内容
 */
async function readCallgraph(file: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`callgraph not written: ${file}`)
}

/**
 * @param callgraph - callgraph.json 内容
 * @param site - `文件:函数`
 * @returns 该调用方解析到函数定义的目标函数名
 */
function resolvedTargets(callgraph: any, site: string): Set<string> {
  const [file, func] = site.split(':')
  const targets = new Set<string>()
  for (const edge of Object.values<any>(callgraph.edges)) {
    const source: string = edge.sourceNodeId
    if (!source.startsWith(`${func} `) || !source.includes(`[${file} :`)) continue
    if (callgraph.nodes[edge.targetNodeId]?.funcDef) targets.add(edge.targetNodeId.split(' ')[0])
  }
  return targets
}

describe('C Callgraph Regression Tests (--dumpAllCG callbacks)', function () {
  this.timeout(0)
  const expected: Record<string, Record<string, Site>> = JSON.parse(
    fs.readFileSync(path.join(CASES_DIR, 'expected.json'), 'utf-8')
  )
  const graphs = new Map<string, any>()

  before(async function () {
    for (const name of Object.keys(expected)) {
      const caseDir = path.join(CASES_DIR, name)
      const reportDir = path.resolve('/tmp', 'c-callgraph-test', name)
      fs.rmSync(reportDir, { recursive: true, force: true })
      resetConfig()
      await execute(null, [
        caseDir,
        '--language',
        'c',
        '--cIncludeDir',
        caseDir,
        '--checkerIds',
        'callgraph',
        '--dumpAllCG',
        '--ruleConfigFile',
        RULE_CONFIG,
        '--report',
        reportDir,
      ])
      graphs.set(name, await readCallgraph(path.join(reportDir, 'callgraph.json')))
    }
  })

  for (const [name, sites] of Object.entries(expected)) {
    for (const [site, { must, mustNot }] of Object.entries(sites)) {
      it(`${name} ${site}`, function () {
        const targets = resolvedTargets(graphs.get(name), site)
        assert.deepStrictEqual(
          must.filter((t) => !targets.has(t)),
          [],
          `missing targets; resolved: ${[...targets].join(', ')}`
        )
        assert.deepStrictEqual(
          mustNot.filter((t) => targets.has(t)),
          [],
          'targets that must not be resolved'
        )
      })
    }
  }
})

describe('C global branch joins', function () {
  this.timeout(30000)

  it('preserves the entire graph for cross-file aliases and conditional callback updates', function () {
    const source = path.join(CASES_DIR, 'F_global_branch_alias')
    const reports = fs.mkdtempSync(path.join(tmpdir(), 'yasa-global-join-'))
    function run(mode: string): any {
      const output = path.join(reports, mode)
      execFileSync(process.execPath, [
        '--require', 'tsx/cjs', path.join(__dirname, 'run-global-join-case.cjs'),
        mode, source, output, RULE_CONFIG,
      ], { cwd: path.resolve(__dirname, '../..') })
      return JSON.parse(fs.readFileSync(path.join(output, 'callgraph.json'), 'utf8'))
    }
    try {
      const graph = run('fast')
      assert.deepStrictEqual(graph, run('dense'))
      assert.deepStrictEqual(resolvedTargets(graph, 'invoke.c:invoke'), new Set(['borrow', 'change', 'fallback', 'primary']))
      assert.deepStrictEqual(resolvedTargets(graph, 'invoke.c:signal'), new Set(['observed']))
    } finally {
      fs.rmSync(reports, { recursive: true, force: true })
    }
  })
})
