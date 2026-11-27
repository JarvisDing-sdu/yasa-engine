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

  it('keeps separate exports for a C source file and a header with the same stem', function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
    const source = { type: 'CompileUnit', _meta: { nodehash: 'test-source-c' } }
    const header = { type: 'CompileUnit', _meta: { nodehash: 'test-source-h' } }
    const sourceScope = analyzer.initModuleScope(source, 'lib/unit.c')
    const headerScope = analyzer.initModuleScope(header, 'lib/unit.h')
    for (const [scope, ast] of [[sourceScope, source], [headerScope, header]]) {
      assert.strictEqual(scope.value.exports, scope.value.module.value.exports)
      assert.strictEqual(scope.value.exports.ast.node, ast)
    }
    assert.notStrictEqual(sourceScope.value.exports.uuid, headerScope.value.exports.uuid)
  })

  for (const [name, expected] of collectCases()) {
    it(`${expected ? 'reports' : 'does not report'} ${name}`, function () {
      assert.strictEqual(detected.has(name), expected)
    })
  }
})

describe('C translation-unit recovery', function () {
  it('initializes declarations in a grouped UAST while preserving its diagnostic nodes', async function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const { Parser } = require('@ant-yasa/uast-parser-cpp')
    const { annotateAST } = require('../../src/util/ast-util')
    const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
    const parser = new Parser({ language: 'c' })
    await parser.init()
    const file = 'grouped.c'
    const unit = parser.parse('int before = 1; int after = 2;', { sourcefile: file })
    const [before, after] = unit.body
    const stray = { type: 'Noop', _meta: { goto: 'lost' }, loc: unit.loc }
    const group = { type: 'Sequence', expressions: [before, stray, after], loc: unit.loc, _meta: { nodehash: 'test-group' } }
    unit.body = [group]
    unit._meta.nodehash = 'test-grouped-unit'
    annotateAST(unit, { sourcefile: file })
    analyzer.astManager.register(group)
    analyzer.processModule(unit, file)
    assert.strictEqual(analyzer.topScope.value.before.value, 1)
    assert.strictEqual(analyzer.topScope.value.after.value, 2)
    assert.strictEqual(analyzer.astManager.get(unit._meta.nodehash), unit)
    assert.strictEqual(analyzer.astManager.get(group._meta.nodehash), group)
    assert.strictEqual(group.expressions[1], stray)
  })
})

describe('C pointer location resolution', function () {
  it('evaluates an address subscript once and keeps the original storage after rebinding', function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const { ObjectValue, PrimitiveValue, Scoped } = require('../../src/engine/util/value-util').ValueUtil
    const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
    const scope = new Scoped('', { sid: 'address', qid: 'address' })
    const state = analyzer.initState(scope)
    const original = new ObjectValue('address', { sid: 'original' })
    const other = new ObjectValue('address', { sid: 'other' })
    scope.value.buffer = original
    const buffer = { type: 'Identifier', name: 'buffer', _meta: { cType: { type: 'PointerType', element: { type: 'PrimitiveType' } } } }
    const index = { type: 'CallExpression', callee: { type: 'Identifier', name: 'offset' }, arguments: [] }
    const element = { type: 'MemberAccess', object: buffer, property: index, computed: true }
    let calls = 0
    analyzer.processCallExpression = () => new PrimitiveValue('address', 'offset', ++calls)
    scope.value.ptr = analyzer.processReferenceExpression(scope, { type: 'ReferenceExpression', argument: element }, state)
    assert.strictEqual(calls, 1)
    scope.value.buffer = other
    const current = new PrimitiveValue('address', 'current', 42)
    original.value[1] = current
    const deref = { type: 'DereferenceExpression', argument: { type: 'Identifier', name: 'ptr' } }
    assert.strictEqual(analyzer.processDereferenceExpression(scope, deref, state), current)
    const updated = new PrimitiveValue('address', 'updated', 57)
    analyzer.writeCLocation(scope, deref, updated, state)
    assert.strictEqual(original.value[1], updated)
    assert.strictEqual(other.value[1], undefined)
    assert.strictEqual(calls, 1)
  })

  it('keeps valid subscript alternatives when another is a read through a null pointer', function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const { ObjectValue, PrimitiveValue, Scoped, UnionValue } = require('../../src/engine/util/value-util').ValueUtil
    const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
    const scope = new Scoped('', { sid: 'test', qid: 'test' })
    const state = analyzer.initState(scope)
    const buffer = new ObjectValue('test', { sid: 'buffer' })
    const nullKey = new ObjectValue('test.buffer', { sid: 'null' })
    buffer.value.null = nullKey
    scope.value.buffer = buffer
    const nullPointer = new PrimitiveValue('test', 'null', null, 'null')
    const zero = new PrimitiveValue('test', 'zero', 0)
    const throughNull = { type: 'MemberAccess', object: nullPointer, property: zero, computed: true }
    const unresolved = analyzer.getMemberValue(scope, throughNull, state)
    assert.strictEqual(nullPointer.value, null)
    scope.value.index = new UnionValue([unresolved, new PrimitiveValue('test', 'three', 3)], undefined, 'test.index')
    const element = {
      type: 'MemberAccess', object: { type: 'Identifier', name: 'buffer' },
      property: { type: 'Identifier', name: 'index' }, computed: true,
    }
    const value = new PrimitiveValue('test', 'written', 12)
    analyzer.saveVarInScope(scope, element, value, state)
    assert.strictEqual(buffer.value[3], value)
    assert.strictEqual(nullKey.value[0], undefined)
  })

  it('writes an indexed member of every distinct aliased pointer target', function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const { ObjectValue, PrimitiveValue, Scoped, UnionValue } = require('../../src/engine/util/value-util').ValueUtil
    const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
    const scope = new Scoped('', { sid: 'test', qid: 'test' })
    const first = new ObjectValue('test', { sid: 'first' })
    const last = new ObjectValue('test', { sid: 'last' })
    first.value.slots = new ObjectValue('test.first', { sid: 'slots' })
    last.value.slots = new ObjectValue('test.last', { sid: 'slots' })
    scope.value.chunk = new UnionValue([first, first, last], undefined, 'test.chunk')

    const slots = {
      type: 'MemberAccess', object: { type: 'Identifier', name: 'chunk' },
      property: { type: 'Identifier', name: 'slots' }, computed: false,
    }
    const element = { type: 'MemberAccess', object: slots, property: { type: 'Literal', value: 3 }, computed: true }
    const value = new PrimitiveValue('test', 'written', 12)
    analyzer.saveVarInScope(scope, element, value, analyzer.initState(scope))
    assert.strictEqual(first.value.slots.value[3], value)
    assert.strictEqual(last.value.slots.value[3], value)
  })

  it('terminates a circular location read and still observes the next write', function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
    const scope = { qid: 'function' }
    const state = {}
    const pointer = { type: 'Identifier', name: 'p' }
    const target = { type: 'Identifier', name: 'cell' }
    const dereference = { type: 'DereferenceExpression', argument: pointer }
    const cell = {}
    const replacement = {}
    let readCell = () => cell
    analyzer.processInstruction = (_scope: any, node: any) => {
      if (node === pointer) return cell
      assert.strictEqual(node, target)
      return readCell()
    }
    analyzer.processReferenceExpression(scope, { type: 'ReferenceExpression', argument: target }, state)

    let reads = 0
    readCell = () => {
      assert.strictEqual(++reads, 1)
      return analyzer.processDereferenceExpression(scope, dereference, state)
    }
    assert.strictEqual(analyzer.processDereferenceExpression(scope, dereference, state), cell)
    readCell = () => { throw new Error('interrupted read') }
    assert.throws(() => analyzer.processDereferenceExpression(scope, dereference, state), /interrupted read/)
    readCell = () => replacement
    assert.strictEqual(analyzer.processDereferenceExpression(scope, dereference, state), replacement)
  })
})

describe('C nested case entry', function () {
  it('preserves initializers and fallthrough while executing each statement once', async function () {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const { Parser } = require('@ant-yasa/uast-parser-cpp')
    const { annotateAST } = require('../../src/util/ast-util')
    const { Scoped, PrimitiveValue } = require('../../src/engine/util/value-util').ValueUtil
    const parser = new Parser({ language: 'c' })
    await parser.init()
    for (const [selected, expected] of [
      [1, ['init', 'first', 'next', 'observe:7', 'last']],
      [2, ['next', 'observe:unknown', 'last']],
      [3, ['last']],
    ] as const) {
      const analyzer = new CAnalyzer({ checkerIds: ['callgraph'] })
      const scope = new Scoped('', { sid: 'select', qid: 'select' })
      const unit = parser.parse(`void run(void) { switch (${selected}) {
        case 1: { int x = init(); first(); case 2: next(); observe(x); }
        case 3: last(); break;
      } }`, { sourcefile: 'select.c' })
      annotateAST(unit, { sourcefile: 'select.c' })
      const seen: string[] = []
      analyzer.processCallExpression = (current: any, node: any, state: any) => {
        const name = node.callee.name
        const arg = node.arguments[0] && analyzer.processInstruction(current, node.arguments[0], state)
        seen.push(name === 'observe' ? `observe:${arg.type === 'Literal' ? arg.value : 'unknown'}` : name)
        return new PrimitiveValue('select', name, 7)
      }
      analyzer.processInstruction(scope, unit.body[0].body, analyzer.initState(scope))
      assert.deepStrictEqual(seen, expected)
    }
  })
})
