import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { stringifyDeepJson } from '../../src/util/deep-json'

const ENGINE = path.resolve(__dirname, '../..')

describe('deep AST JSON export', function () {
  this.timeout(60_000)

  it('matches JSON.stringify for ordinary values, shared objects and toJSON', () => {
    const shared = { text: 'a\n"b', n: NaN, skip: undefined }
    const value = { shared, again: shared, items: [undefined, 4, null], custom: { toJSON: () => 'ok' } }
    assert.strictEqual(stringifyDeepJson(value), JSON.stringify(value))
    const skipParent = (key: string, v: any) => (key === 'parent' ? undefined : v)
    const cyclic: any = { child: {} }
    cyclic.child.parent = cyclic
    assert.strictEqual(stringifyDeepJson(cyclic, skipParent), JSON.stringify(cyclic, skipParent))
    assert.throws(() => { const cycle: any = {}; cycle.self = cycle; stringifyDeepJson(cycle) }, TypeError)
  })

  it('exports every node of a deeply nested C expression', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-deep-ast-'))
    try {
      const source = path.join(directory, 'long.c')
      const report = path.join(directory, 'ast.json')
      const terms = 5000
      fs.writeFileSync(source, `int f(void) { return ${Array(terms).fill('1').join('+')}; }\n`)
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'src/main.ts', '--sourcePath', source,
        '--language', 'c', '--dumpAST', '--report', report,
      ], { cwd: ENGINE, encoding: 'utf8', timeout: 30_000 })
      assert.ifError(result.error)
      assert.strictEqual(result.status, 0, result.stdout + result.stderr)
      const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
      assert.strictEqual(ast.type, 'CompileUnit')
      const stack = [ast]
      let expressions = 0
      while (stack.length) {
        const node: any = stack.pop()
        if (!node || typeof node !== 'object') continue
        if (node.type === 'BinaryExpression') {
          expressions++
          assert.ok(node._meta?.nodehash)
        }
        for (const child of Object.values(node)) {
          if (child && typeof child === 'object') stack.push(child)
        }
      }
      assert.strictEqual(expressions, terms - 1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it('exports a deep C AST through dumpAllAST without parent links in JSON', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-deep-all-'))
    try {
      const sourceDir = path.join(directory, 'source')
      const report = path.join(directory, 'report')
      fs.mkdirSync(sourceDir)
      const terms = 5000
      fs.writeFileSync(path.join(sourceDir, 'long.c'), `int f(void) { return ${Array(terms).fill('1').join('+')}; }\n`)
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'src/main.ts', '--sourcePath', sourceDir,
        '--language', 'c', '--dumpAllAST', '--report', report,
      ], { cwd: ENGINE, encoding: 'utf8', timeout: 30_000 })
      assert.ifError(result.error)
      assert.strictEqual(result.status, 0, result.stdout + result.stderr)
      const files = JSON.parse(fs.readFileSync(path.join(report, 'astList.json'), 'utf8'))
      assert.strictEqual(files.length, 1)
      const ast = JSON.parse(fs.readFileSync(path.join(report, files[0]), 'utf8'))
      const stack = [ast]
      let expressions = 0
      while (stack.length) {
        const node: any = stack.pop()
        if (!node || typeof node !== 'object') continue
        assert.ok(!Object.prototype.hasOwnProperty.call(node, 'parent'))
        if (node.type === 'BinaryExpression') expressions++
        for (const child of Object.values(node)) {
          if (child && typeof child === 'object') stack.push(child)
        }
      }
      assert.strictEqual(expressions, terms - 1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

})
