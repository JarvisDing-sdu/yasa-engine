import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const ENGINE = path.resolve(__dirname, '../..')
const CURL_FIXTURE = path.resolve(ENGINE, '../uast/parser-C/tests/fixtures/conditional-boundary/split-else.c')

function exportAst(source: string, args: string[] = []): any {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-dump-recovery-'))
  try {
    const report = path.join(directory, 'ast.json')
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', ...args, '--dumpAST', '--report', report,
    ], { cwd: ENGINE, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(result.error)
    assert.strictEqual(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(fs.readFileSync(report, 'utf8'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function functionNames(ast: any): string[] {
  const names: string[] = []
  const stack = [ast]
  while (stack.length) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    if (value.type === 'FunctionDefinition') names.push(value.id?.name)
    for (const [key, child] of Object.entries(value)) {
      if (key !== '_meta' && key !== 'loc' && key !== 'parent') stack.push(child)
    }
  }
  return names.sort()
}

describe('C dumpAST recovery integration', function () {
  this.timeout(60_000)

  it('exports a compile unit and later valid function when the syntax tree root is ERROR', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-root-error-'))
    try {
      const source = path.join(directory, 'root-error.c')
      fs.writeFileSync(source, 'int broken( {\nint count;\nint valid(void) { return 42; }\n')
      const ast = exportAst(source)
      assert.strictEqual(ast.type, 'CompileUnit')
      assert.strictEqual(ast.language, 'c')
      assert.ok(ast._meta.parseErrors.some((error: any) => error.line === 1))
      assert.deepStrictEqual(functionNames(ast), ['valid'])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  for (const [label, defines] of [
    ['disabled', ['--cUndefine', 'USE_UNIX_SOCKETS']],
    ['enabled', ['--cDefine', 'USE_UNIX_SOCKETS=1']],
  ] as [string, string[]][]) {
    it(`exports both functions in the reduced curl conditional-brace fixture (${label})`, () => {
      const ast = exportAst(CURL_FIXTURE, defines)
      assert.strictEqual(ast.type, 'CompileUnit')
      assert.deepStrictEqual(ast._meta.parseErrors, [])
      assert.deepStrictEqual(functionNames(ast), ['Curl_cf_haproxy_insert_after', 'split_else'])
    })
  }
})
