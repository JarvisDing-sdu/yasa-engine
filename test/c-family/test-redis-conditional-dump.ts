import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const ENGINE = path.resolve(__dirname, '../..')

// Reduced from the REG_LITERAL conditional embedded in the expression in
// Redis deps/tre/lib/tre-parse.c. Both valid configurations must retain the
// surrounding function and its source locations.
const SOURCE = `int tre_parse(int flags, int end) {
  if (
#ifdef REG_LITERAL
      !(flags & REG_LITERAL) &&
#endif
      end) {
    return 1;
  }
  return 0;
}
int after(void) { return 42; }
`

describe('Redis conditional expression dumpAST', function () {
  this.timeout(30_000)

  for (const [name, args, enabled] of [
    ['enabled', ['--cDefine', 'REG_LITERAL=1'], true],
    ['disabled', ['--cUndefine', 'REG_LITERAL'], false],
  ] as [string, string[], boolean][]) {
    it(`preserves both functions and their source locations when ${name}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-redis-conditional-'))
      try {
        const source = path.join(dir, 'tre-conditional.c')
        const report = path.join(dir, 'ast.json')
        fs.writeFileSync(source, SOURCE)
        const result = spawnSync(process.execPath, [
          '--import', 'tsx', 'src/main.ts', '--sourcePath', source,
          '--language', 'c', ...args, '--dumpAST', '--report', report,
        ], { cwd: ENGINE, encoding: 'utf8', timeout: 25_000 })
        assert.ifError(result.error)
        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
        assert.strictEqual(ast.type, 'CompileUnit')
        assert.deepStrictEqual(ast._meta.parseErrors, [])
        const functions = ast.body.filter((node: any) => node.type === 'FunctionDefinition')
        assert.deepStrictEqual(functions.map((node: any) => node.id.name), ['tre_parse', 'after'])
        assert.deepStrictEqual(functions.map((node: any) => node.loc.start.line), [1, 11])
        const branch = functions[0].body.body[0]
        assert.strictEqual(branch.type, 'IfStatement')
        assert.strictEqual(branch.loc.start.line, 2)
        assert.strictEqual(branch.consequent.body[0].loc.start.line, 7)
        if (enabled) {
          assert.strictEqual(branch.test.operator, '&&')
          assert.strictEqual(branch.test.right.name, 'end')
          assert.strictEqual(branch.test.left.argument.left.name, 'flags')
          assert.strictEqual(branch.test.left.argument.right.value, 1)
          assert.strictEqual(branch.test.left.argument.loc.start.line, 4)
          assert.strictEqual(branch.test.right.loc.start.line, 6)
        } else {
          assert.strictEqual(branch.test.type, 'Identifier')
          assert.strictEqual(branch.test.name, 'end')
          assert.strictEqual(branch.test.loc.start.line, 6)
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
