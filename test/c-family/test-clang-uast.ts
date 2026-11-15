import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { describe, it, before, after } from 'mocha'
import { readCompilerDeclarations } from '../../src/engine/parser/c-family/compiler-declarations'
import { decodeLineMarkers } from '../../src/engine/parser/c-family/source-map'
import { ClangUastConverter, convertClangAstFile } from '../../src/engine/parser/c-family/clang-uast'

const engine = path.resolve(__dirname, '../..')
const fixtures = path.join(__dirname, 'clang-fixtures')
const walk = (root: any, type: string): any[] => {
  const pending = [root], found: any[] = []
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === type) found.push(node)
    for (const [key, value] of Object.entries(node)) if (!['_meta', 'loc', 'parent'].includes(key)) {
      if (Array.isArray(value)) pending.push(...[...value].reverse())
      else pending.push(value)
    }
  }
  return found
}

describe('experimental Clang AST to UAST', function () {
  this.timeout(30_000)
  let directory: string
  const asts = new Map<string, any>()
  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-native-uast-'))
    for (const [name, language, driver] of [['flow.c', 'c', 'clang'], ['semantic.cpp', 'cpp', 'clang++']]) {
      const source = path.join(directory, name)
      fs.copyFileSync(path.join(fixtures, name), source)
      const database = path.join(directory, name + '.compile.json')
      fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: [driver, '-c', source] }]))
      const report = path.join(directory, name + '.uast.json')
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
        '--language', language, '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
      assert.strictEqual(child.status, 0, child.stdout + child.stderr)
      asts.set(language, JSON.parse(fs.readFileSync(report, 'utf8')))
    }
  })
  after(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('preserves C functions, macro calls and original source lines', () => {
    const ast = asts.get('c')
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(walk(ast, 'FunctionDefinition').map(fn => fn.id.name), ['target', 'through_macro', 'through_pointer', 'flow', 'read_enum', 'read_switch', 'generic_selected'])
    const macro = walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'through_macro')
    const call = walk(macro, 'CallExpression')[0]
    assert.strictEqual(call.callee.name, 'target')
    assert.strictEqual(call._meta.originalLocation.start.line, 3)
    assert.strictEqual(call._meta.originalColumnKnown, false)
    assert.deepStrictEqual(ast._meta.parseErrors, [])
  })

  it('retains loop control, compound assignments and function pointer types', () => {
    const ast = asts.get('c')
    assert.strictEqual(walk(ast, 'ForStatement').length, 1)
    assert.strictEqual(walk(ast, 'WhileStatement').length, 2)
    assert.strictEqual(walk(ast, 'WhileStatement').filter(loop => loop.isPostTest).length, 1)
    assert.ok(walk(ast, 'AssignmentExpression').some(node => node.operator === '+='))
    const callback = walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'through_pointer')
    assert.strictEqual(callback.parameters[0].varType.type, 'PointerType')
    assert.strictEqual(callback.parameters[0].varType.element.type, 'FuncType')
  })

  it('preserves generic and instantiated template classes and their methods', () => {
    const classes = walk(asts.get('cpp'), 'ClassDefinition')
    assert.deepStrictEqual(classes.map(node => node.id.name), ['Box', 'Box<int>', 'Initialized'])
    assert.strictEqual(walk(classes[0], 'FunctionDefinition')[0]._meta.qualifiedName, 'Box::get')
    assert.strictEqual(walk(classes[1], 'FunctionDefinition')[0]._meta.qualifiedName, 'Box<int>::get')
  })

  it('preserves a captureless lambda body and its invocation through the closure variable', () => {
    const ast = asts.get('cpp')
    const [lambda] = walk(ast, 'FunctionDefinition').filter(fn => fn._meta.cppLambda)
    assert.strictEqual(lambda.parameters[0].id.name, 'offset')
    assert.strictEqual(walk(lambda, 'CallExpression')[0].callee.name, 'target')
    assert.ok(walk(ast, 'CallExpression').some(call => call.callee.name === 'lambda'))
    assert.strictEqual(ast._meta.clangBackend.status, 'converted')
  })

  it('preserves bitfield widths, designated initializer positions and enum values', () => {
    const ast = asts.get('c')
    const record = walk(ast, 'ClassDefinition').find(node => node.id.name === 'S')
    assert.strictEqual(record.body[0]._meta.bitfield.unnamed, true)
    assert.strictEqual(record.body[1].init, null)
    assert.strictEqual(record.body[1]._meta.bitfield.width.value, 2)
    const values = walk(ast, 'VariableDeclaration')
    assert.deepStrictEqual(values.find(node => node.id.name === 'record').init.properties.map((property: any) => [property.key.name, property.value.value]), [['value', 1], ['tail', 8]])
    assert.deepStrictEqual(values.find(node => node.id.name === 'array').init.properties.map((property: any) => property.value.value), [0, 0, 7, 0, 9])
    assert.strictEqual(walk(walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'read_enum'), 'ReturnStatement')[0].argument.value, 6)
    assert.strictEqual(walk(ast, 'SwitchStatement')[0].cases.length, 3)
  })

  it('retains C++ range and exception control flow', () => {
    const ast = asts.get('cpp')
    const [loop] = walk(ast, 'RangeStatement')
    assert.strictEqual(loop.value.id.name, 'value')
    assert.strictEqual(loop.right.name, 'values')
    assert.strictEqual(walk(loop, 'CallExpression')[0].callee.name, 'target')
    assert.strictEqual(walk(ast, 'TryStatement')[0].handlers.length, 2)
    assert.strictEqual(walk(ast, 'ThrowStatement').length, 1)
  })

  it('retains generic lambda bodies and records capture and instantiation limits', () => {
    for (const [name, expression, issue] of [
      ['capture', '[value](int input){ return input + value; }', 'lambda_capture_semantics'],
      ['generic', '[](auto input){ return input + 1; }', 'generic_lambda_instantiation'],
    ]) {
      const source = path.join(directory, name + '.cpp')
      fs.writeFileSync(source, `int f(int value) { auto lambda = ${expression}; return lambda(value); }`)
      const database = path.join(directory, name + '.compile.json')
      fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
      const report = path.join(directory, name + '.uast.json')
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
        '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
      assert.strictEqual(child.status, 0, child.stdout + child.stderr)
      const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
      assert.strictEqual(ast._meta.compilerDump.status, 'partial_conversion')
      assert.strictEqual(ast._meta.clangBackend.unsupported[issue], 1)
      assert.strictEqual(walk(ast, 'FunctionDefinition').filter(fn => fn._meta.cppLambda).length, 1)
      assert.ok(walk(ast, 'BinaryExpression').length)
    }
  })

  it('keeps the compiler-selected generic association and constructor field initialization', () => {
    const selected = walk(asts.get('c'), 'FunctionDefinition').find(fn => fn.id.name === 'generic_selected')
    assert.deepStrictEqual(walk(selected, 'CallExpression').map(call => call.callee.name), ['target'])
    const constructor = walk(asts.get('cpp'), 'FunctionDefinition').find(fn => fn.id?.name === 'Initialized' && !fn._meta.clangTemplate)
    const assignment = walk(constructor, 'AssignmentExpression')[0]
    assert.strictEqual(constructor._meta.isConstructor, true)
    const owner = walk(asts.get('cpp'), 'ClassDefinition').find(record => record.id.name === 'Initialized')
    assert.ok(owner.body.includes(constructor))
    const template = owner.body.find((member: any) => member._meta?.clangTemplate)
    assert.strictEqual(template._meta.isConstructor, true)
    assert.strictEqual(template.body.body[0].expression.right.callee.name, 'target')
    const trailing = walk(asts.get('cpp'), 'FunctionDefinition').find(fn => fn.id?.name === 'trailing_return')
    assert.strictEqual(trailing.returnType.id.name, 'int')
    for (const name of ['while_declaration', 'for_declaration']) {
      const fn = walk(asts.get('cpp'), 'FunctionDefinition').find(node => node.id?.name === name)
      assert.strictEqual(walk(fn, 'VariableDeclaration').filter(node => node.id.name === 'value').length, 1)
      assert.deepStrictEqual(walk(fn, 'CallExpression').map(call => call.callee.name), ['condition_input'])
    }
    assert.strictEqual(assignment.left.property.name, 'member')
    assert.strictEqual(assignment.right.callee.name, 'target')
    assert.strictEqual(assignment.right.arguments[0].name, 'value')
  })

  it('preserves evaluated allocation operands while recording lifetime-model gaps', () => {
    const source = path.join(directory, 'allocation.cpp')
    fs.writeFileSync(source, `
      int target(int); struct Owner { Owner(int); };
      Owner *release(Owner *); void f() { Owner *p = new Owner(target(2)); delete release(p); }
      void throws() { throw Owner(target(3)); }
    `)
    const database = path.join(directory, 'allocation.compile.json')
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-c', source] }]))
    const report = path.join(directory, 'allocation.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.strictEqual(ast._meta.clangBackend.unsupported.cpp_allocation_semantics, 1)
    assert.strictEqual(ast._meta.clangBackend.unsupported.cpp_delete_semantics, 1)
    assert.deepStrictEqual(walk(ast, 'CallExpression').map(call => call.callee.name), ['target', 'release', 'target'])
    assert.strictEqual(walk(ast, 'NewExpression')[0].callee.name, 'Owner')
    assert.strictEqual(walk(ast, 'ThrowStatement').length, 1)
    assert.strictEqual(walk(walk(ast, 'ThrowStatement')[0], 'CallExpression')[0].callee.name, 'target')
  })

  it('retains dependent enum expressions and extended floating values without invented constants', () => {
    const source = path.join(directory, 'dependent-values.cpp')
    fs.writeFileSync(source, 'template<int N> struct Values { enum { value = N + 1, next }; }; long double wide = 1.0e400L; const char32_t packed[] = U"\\x9999999A\\x8000002B"; int throwing(int value) { return value ? value : throw 1; }')
    const database = path.join(directory, 'dependent-values.compile.json')
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-c', source] }]))
    const report = path.join(directory, 'dependent-values.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.strictEqual(ast._meta.clangBackend.unsupported.dependent_enum_value, 2)
    assert.strictEqual(ast._meta.clangBackend.unsupported.expression_lowering_CXXThrowExpr, 1)
    const value = walk(ast, 'VariableDeclaration').find(node => node.id.name === 'value')
    assert.strictEqual(value.init.type, 'BinaryExpression')
    const wide = walk(ast, 'VariableDeclaration').find(node => node.id.name === 'wide')
    assert.strictEqual(typeof wide.init.value, 'string')
    assert.ok(wide.init.value.includes('E+400'))
    const packed = walk(ast, 'VariableDeclaration').find(node => node.id.name === 'packed')
    assert.deepStrictEqual(packed.init.properties.map((property: any) => property.value.value), [0x9999999a, 0x8000002b, 0])
  })

  it('restores inherited defaults, constructor defaults and in-class field initializers', () => {
    const source = path.join(directory, 'default-values.cpp')
    fs.writeFileSync(source, `int input(){return 5;} int forward(int value=input()); int forward(int value){return value;}
      struct Box { int field=input(); Box(){} int get(int value=input()){return value;} };
      struct WithDefault { int field; WithDefault(int value=input()): field(value){} };
      int main(){ Box box; WithDefault other; return forward()+box.get()+other.field; }`)
    const database = path.join(directory, 'default-values.compile.json')
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-c', source] }]))
    const report = path.join(directory, 'default-values.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.strictEqual(ast._meta.clangBackend.status, 'converted', JSON.stringify(ast._meta.clangBackend))
    const main = walk(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'main')
    const forward = walk(main, 'CallExpression').find(call => call.callee.name === 'forward')
    const member = walk(main, 'CallExpression').find(call => call.callee.type === 'MemberAccess')
    const constructor = walk(main, 'NewExpression').find(call => call.callee.name === 'WithDefault')
    for (const call of [forward, member, constructor]) assert.strictEqual(call.arguments[0].callee.name, 'input')
    const box = walk(ast, 'ClassDefinition').find(record => record.id.name === 'Box')
    const body = box.body.find((member: any) => member._meta?.isConstructor).body
    assert.strictEqual(walk(body, 'AssignmentExpression')[0].right.callee.name, 'input')
  })

  it('handles empty assembly while preserving instruction and clobber diagnostics', () => {
    const source = path.join(directory, 'assembly.c')
    fs.writeFileSync(source, 'void empty(void){ __asm__(""); } void active(void){ __asm__("nop"); __asm__ volatile("" ::: "memory"); }')
    const database = path.join(directory, 'assembly.compile.json')
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang', '-c', source] }]))
    const report = path.join(directory, 'assembly.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const empty = walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'empty')
    assert.strictEqual(walk(empty, 'Noop')[0]._meta.emptyInlineAssembly, true)
    assert.strictEqual(ast._meta.clangBackend.unsupported.GCCAsmStmt, 2)
  })

  it('records native batch failures, keeps later entries and exposes conversion gaps', () => {
    const input = path.join(directory, 'batch')
    fs.mkdirSync(input)
    const sources = [
      ['broken.c', '#include "missing.h"'],
      ['partial.c', 'int f(int n) { start: if(n--) goto start; return 0; }'],
      ['valid.c', 'int valid(void) { return 1; }'],
    ]
    const records = sources.map(([name, code]) => {
      const file = path.join(input, name)
      fs.writeFileSync(file, code)
      return { directory: input, file, arguments: ['clang', '-c', file] }
    })
    const database = path.join(input, 'compile_commands.json')
    fs.writeFileSync(database, JSON.stringify(records))
    const report = path.join(directory, 'batch-report')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', input,
      '--language', 'c', '--dumpAllAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 2, child.stdout + child.stderr)
    const manifest = JSON.parse(fs.readFileSync(path.join(report, 'manifest.json'), 'utf8'))
    assert.strictEqual(manifest.astBackend, 'clang')
    assert.strictEqual(manifest.completed, 3)
    assert.deepStrictEqual(manifest.results.map((row: any) => row.status), ['failed', 'partial_conversion', 'no_syntax_errors'])
    assert.strictEqual(manifest.results[1].conversionDiagnostics.goto_control_flow, 1)
    assert.strictEqual(manifest.results[0].output, null)
  })

  it('rejects incompatible compiler drivers and unknown backend names visibly', () => {
    const source = path.join(directory, 'invalid-backend.c')
    fs.writeFileSync(source, 'int f(void){return 0;}')
    const database = path.join(directory, 'invalid-backend.compile.json')
    for (const [driver, backend, message] of [['gcc', 'clang', /clang/i], ['clang', 'unknown', /Unknown --cAstBackend/]]) {
      fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: [driver, '-c', source] }]))
      const report = path.join(directory, driver + '-invalid.json')
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
        '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', backend, '--report', report], { cwd: engine, encoding: 'utf8' })
      assert.strictEqual(child.status, 2)
      assert.match(child.stderr, message)
      assert.ok(!fs.existsSync(report))
    }
  })

  it('produces identical metadata and UAST with one-pass and two-pass readers', async () => {
    const source = path.join(directory, 'equivalence.cpp')
    fs.writeFileSync(source, `namespace N { template<class T> struct Box { T value; T get(){ return value; } }; }
      int input(){return 2;} int f(int value=input()){return value;} int main(){ N::Box<int> box{1}; return f()+box.get(); }`)
    const rawFile = path.join(directory, 'equivalence.ii')
    const preprocessed = spawnSync('clang++', ['-std=c++17', '-E', source, '-o', rawFile], { encoding: 'utf8' })
    assert.strictEqual(preprocessed.status, 0, preprocessed.stderr)
    const dump = spawnSync('clang++', ['-x', 'c++-cpp-output', '-std=c++17', '-fsyntax-only', '-Xclang', '-ast-dump=json', rawFile], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    assert.strictEqual(dump.status, 0, dump.stderr)
    const file = path.join(directory, 'equivalence.ast.json')
    fs.writeFileSync(file, dump.stdout)
    const raw = fs.readFileSync(rawFile, 'utf8')
    const options = { raw, sourceMap: decodeLineMarkers(raw, directory).sourceMap, sourcefile: source, language: 'cpp' as const }
    const normal = await readCompilerDeclarations(file)
    const expected = await convertClangAstFile(file, options)
    const converter = new ClangUastConverter(options)
    const actual = await readCompilerDeclarations(file, { shouldRetain: node => converter.includesDeclaration(node), consume: node => converter.add(node) })
    assert.deepStrictEqual(actual, normal)
    assert.deepStrictEqual(converter.finish(), expected)
  })

  it('rejects malformed compiler AST input', async () => {
    const file = path.join(directory, 'bad-ast.json')
    fs.writeFileSync(file, '{"kind":"TranslationUnitDecl","inner":[')
    await assert.rejects(convertClangAstFile(file, { sourcefile: 'bad.c', language: 'c', raw: '', sourceMap: [] }))
  })
})
