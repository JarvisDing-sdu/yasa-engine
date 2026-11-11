import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const ENGINE = path.resolve(__dirname, '../..')
// Reduced from the split initializer in curl/lib/vtls/openssl.c:ossl_init.
// Both directive groups interrupt a single C expression.
const SOURCE = `int before(void) { return 1; }
int configure(void)
{
  unsigned long flags =
#if defined(FEATURE_A)
    FLAG_A |
#endif
#if defined(FEATURE_B)
    FLAG_B |
#else
    FLAG_C |
#endif
    0;
  consume(flags);
  return flags;
}
int after(void) { return 2; }
`

function identifiers(root: any): Record<string, number> {
  const found: Record<string, number> = {}
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === 'Identifier') found[node.name] = node.loc.start.line
    for (const [key, value] of Object.entries(node)) {
      if (key !== '_meta' && key !== 'loc' && key !== 'parent') pending.push(value)
    }
  }
  return found
}

describe('C dumpAST conditional expression from curl', function () {
  this.timeout(30_000)
  for (const a of [false, true]) {
    for (const b of [false, true]) {
      it(`exports the full function and selected initializer (A=${a}, B=${b})`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-curl-expression-'))
        try {
          const source = path.join(directory, 'fixture.c')
          const report = path.join(directory, 'ast.json')
          fs.writeFileSync(source, SOURCE)
          const defines = [a && 'FEATURE_A=1', b && 'FEATURE_B=1'].filter(Boolean).join(',')
          const undefines = [!a && 'FEATURE_A', !b && 'FEATURE_B'].filter(Boolean).join(',')
          const options = [
            ...(defines ? ['--cDefine', defines] : []),
            ...(undefines ? ['--cUndefine', undefines] : []),
          ]
          const result = spawnSync(process.execPath, [
            '--import', 'tsx', 'src/main.ts', '--sourcePath', source, '--language', 'c',
            ...options, '--dumpAST', '--report', report,
          ], { cwd: ENGINE, encoding: 'utf8', timeout: 20_000 })
          assert.ifError(result.error)
          assert.strictEqual(result.status, 0, result.stdout + result.stderr)
          const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
          assert.strictEqual(ast.type, 'CompileUnit')
          assert.deepStrictEqual(ast._meta.parseErrors, [])
          const functions = ast.body.filter((node: any) => node.type === 'FunctionDefinition')
          assert.deepStrictEqual(functions.map((node: any) => node.id.name), ['before', 'configure', 'after'])
          const fn = functions[1]
          assert.strictEqual(fn.loc.start.line, 2)
          assert.strictEqual(functions[2].loc.start.line, 17)
          assert.deepStrictEqual(fn.body.body.map((node: any) => node.type), [
            'VariableDeclaration', 'ExpressionStatement', 'ReturnStatement',
          ])
          const names = identifiers(fn.body.body[0].init)
          assert.strictEqual(names.FLAG_A, a ? 6 : undefined)
          assert.strictEqual(names.FLAG_B, b ? 9 : undefined)
          assert.strictEqual(names.FLAG_C, b ? undefined : 11)
          assert.strictEqual(fn.body.body[1].expression.callee.name, 'consume')
          assert.strictEqual(fn.body.body[2].argument.name, 'flags')
          assert.strictEqual(fn.body.body[2].loc.start.line, 15)
        } finally {
          fs.rmSync(directory, { recursive: true, force: true })
        }
      })
    }
  }
})
