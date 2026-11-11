import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'

const engine = path.resolve(__dirname, '../..')

describe('compiler-configured dumpAST', function () {
  this.timeout(30_000)
  let dir: string
  let source: string
  let header: string
  let database: string
  let report: string
  let argv: string[][]
  const cli = (extra: string[] = []) => spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
    '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--report', report, ...extra], { cwd: engine, encoding: 'utf8' })
  const id = (args: string[]) => createHash('sha256').update(JSON.stringify([dir, source, args])).digest('hex')
  const writeDb = (commands: string[][]) => fs.writeFileSync(database, JSON.stringify(commands.map(args => ({ directory: dir, file: source, arguments: args }))))
  const functions = (ast: any) => {
    const found: Record<string, any> = {}
    const pending = [ast]
    while (pending.length) {
      const value = pending.pop()
      if (!value || typeof value !== 'object') continue
      if (value.type === 'FunctionDefinition') found[value.id.name] = value
      for (const [key, child] of Object.entries(value)) if (!['_meta', 'loc', 'parent'].includes(key)) pending.push(child)
    }
    return found
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-compiler-dump-'))
    source = path.join(dir, 'main.c')
    header = path.join(dir, 'include.h')
    database = path.join(dir, 'compile_commands.json')
    report = path.join(dir, 'ast.json')
    fs.writeFileSync(header, 'static int in_header(void) { return 3; }\n')
    fs.writeFileSync(source, '#include "include.h"\nint f(int x) {\n#if FEATURE\n if (x) {\n#else\n if (x + 1) {\n#endif\n  return x;\n }\n return 0;\n}\n')
    argv = [0, 1].map(flag => ['clang', `-DFEATURE=${flag}`, '-c', source, '-o', path.join(dir, `object-${flag}.o`)])
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('uses the selected command and maps project headers and shared-brace branches to original lines', () => {
    writeDb(argv)
    const ambiguous = cli()
    assert.notStrictEqual(ambiguous.status, 0)
    assert.match(ambiguous.stderr, /exactly one matching compile command/)
    assert.ok(!fs.existsSync(report))
    for (let flag = 0; flag <= 1; flag++) {
      const result = cli(['--cCompileEntry', id(argv[flag])])
      assert.strictEqual(result.status, 0, result.stderr)
      const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
      assert.strictEqual(ast.type, 'CompileUnit')
      assert.deepStrictEqual(ast._meta.parseErrors, [])
      assert.strictEqual(ast._meta.compilerDump.entryId, id(argv[flag]))
      assert.strictEqual(ast._meta.compilerDump.coverage, 'single_configuration')
      const fns = functions(ast)
      assert.strictEqual(fns.in_header._meta.originalLocation.sourcefile, header)
      assert.strictEqual(fns.in_header._meta.originalLocation.start.line, 1)
      const branch = fns.f.body.body[0]
      assert.strictEqual(branch._meta.originalLocation.sourcefile, source)
      assert.strictEqual(branch._meta.originalLocation.start.line, flag ? 4 : 6)
      assert.strictEqual(branch._meta.originalColumnKnown, false)
      assert.strictEqual(branch._meta.originalLocation.end, undefined)
      assert.ok(!fs.existsSync(path.join(dir, `object-${flag}.o`)))
      fs.unlinkSync(report)
    }
  })

  it('accepts repeated identical command records and rejects conflicting output or unsupported options', () => {
    writeDb([argv[0], argv[0]])
    assert.strictEqual(cli().status, 0)
    const before = fs.readFileSync(header, 'utf8')
    const toHeader = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--report', header], { cwd: engine, encoding: 'utf8' })
    assert.notStrictEqual(toHeader.status, 0)
    assert.match(toHeader.stderr, /Report path already exists/)
    assert.strictEqual(fs.readFileSync(header, 'utf8'), before)
    writeDb([[...argv[0], '-save-temps']])
    const unsupported = cli()
    assert.notStrictEqual(unsupported.status, 0)
    assert.match(unsupported.stderr, /Unsupported compiler option/)
    const dependencyOutput = path.join(dir, 'forbidden.d')
    writeDb([[...argv[0], `-Wp,-MD,${dependencyOutput}`]])
    assert.notStrictEqual(cli().status, 0)
    assert.ok(!fs.existsSync(dependencyOutput))
  })

  it('fails visibly for missing databases, wrong language and compiler failures', () => {
    let result = cli()
    assert.notStrictEqual(result.status, 0)
    assert.ok(!fs.existsSync(report))
    writeDb([argv[0]])
    result = cli(['--language', 'cpp'])
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /language does not match/)
    fs.writeFileSync(source, '#include "missing-required-header.h"\n')
    result = cli()
    assert.notStrictEqual(result.status, 0)
    assert.ok(!fs.existsSync(report))
  })

  it('records diagnostics, #line presumed source and direct cc flags', () => {
    fs.writeFileSync(source, '#warning test-warning\n#line 77 "logical.c"\nint mapped(void) { return 1; }\n')
    writeDb([['cc', '-fvisibility=hidden', '-funroll-loops', '-fno-unroll-loops', '-c', source, '-o', path.join(dir, 'would-be-output.o')]])
    const result = cli()
    assert.strictEqual(result.status, 0, result.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const fn = functions(ast).mapped
    assert.strictEqual(fn._meta.originalLocation.sourcefile, path.join(dir, 'logical.c'))
    assert.strictEqual(fn._meta.originalLocation.physicalFile, source)
    assert.strictEqual(fn._meta.originalLocation.start.line, 77)
    assert.match(ast._meta.compilerDump.compilerStderr, /test-warning/)
    assert.strictEqual(ast._meta.compilerDump.environment, 'current_process')
    assert.strictEqual(ast._meta.compilerDump.systemHeaders, 'masked')
    assert.ok(ast._meta.compilerDump.argv.includes('-funroll-loops'))
    assert.ok(ast._meta.compilerDump.argv.includes('-fno-unroll-loops'))
    assert.ok(!fs.existsSync(path.join(dir, 'would-be-output.o')))
  })

  it('supports direct c++ commands and identifies the configured language', () => {
    source = path.join(dir, 'main.cpp')
    fs.writeFileSync(source, 'int f(int x) { return x + 1; }\n')
    writeDb([['c++', '-std=c++17', '-c', source]])
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(result.status, 0, result.stderr)
    const ast = JSON.parse(result.stdout)
    assert.strictEqual(ast.language, 'cpp')
    assert.strictEqual(functions(ast).f._meta.originalLocation.sourcefile, source)
  })

  it('refuses existing source, unusual header names and dangling output symlinks', () => {
    const dollarHeader = path.join(dir, 'dollar$.h')
    fs.writeFileSync(dollarHeader, 'int sentinel;\n')
    fs.writeFileSync(source, '#include "dollar$.h"\nint f(void) { return 1; }\n')
    writeDb([argv[0]])
    for (const target of [source, dollarHeader, database]) {
      const before = fs.readFileSync(target, 'utf8')
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
        '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--report', target], { cwd: engine, encoding: 'utf8' })
      assert.notStrictEqual(result.status, 0)
      assert.strictEqual(fs.readFileSync(target, 'utf8'), before)
    }
    fs.symlinkSync(path.join(dir, 'missing'), report)
    assert.notStrictEqual(cli().status, 0)
    assert.ok(!fs.existsSync(path.join(dir, 'missing')))
    assert.ok(fs.lstatSync(report).isSymbolicLink())
  })

  it('preserves parser diagnostics and marks a syntax-error AST as partial', () => {
    fs.writeFileSync(source, 'int f(void) { return ; + ; }\n')
    writeDb([argv[0]])
    const result = cli()
    assert.strictEqual(result.status, 0, result.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.ok(ast._meta.parseErrors.length > 0)
    assert.strictEqual(ast._meta.compilerDump.status, 'syntax_errors')
    assert.ok(ast._meta.parseErrors.some((error: any) => error.originalLocation?.sourcefile === source))
  })
})
