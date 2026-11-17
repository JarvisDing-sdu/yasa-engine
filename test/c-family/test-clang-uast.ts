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

  it('retains dependent operator assignment operands and their side effects', () => {
    const source = path.join(directory, 'dependent-assignment.cpp')
    fs.writeFileSync(source, `struct Number {}; Number operator*(Number, Number); int input();
      template<class It> void write(It it){*it++=input();}
      void concrete(int* it){*it++=input();}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const assignments = walk(ast, 'AssignmentExpression')
    assert.strictEqual(assignments.length, 2)
    const dependent = assignments.find(node => node._meta.clangDependentAssignment)
    assert.ok(dependent)
    assert.strictEqual(dependent.left.type, 'CallExpression')
    assert.strictEqual(dependent.right.callee.name, 'input')
    assert.strictEqual(walk(dependent.left, 'UnaryExpression').filter(node => node.operator === '++').length, 1)
    assert.strictEqual(ast._meta.clangBackend.unsupported.dependent_assignment_target, 1)
    assert.ok(!ast._meta.clangBackend.unsupported.BinaryOperator)
    assert.strictEqual(ast._meta.clangBackend.status, 'partial')
  })

  it('preserves calls inside dependent pack expansion patterns without claiming complete semantics', () => {
    const source = path.join(directory, 'pack-pattern.cpp')
    fs.writeFileSync(source, `int transform(int); template<class... T> int sink(T...);
      template<class... T> int apply(T... values){return sink(transform(values)...);}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const packs = walk(ast, 'SpreadElement')
    assert.strictEqual(packs.length, 1)
    assert.strictEqual(packs[0].argument.type, 'CallExpression')
    assert.strictEqual(packs[0].argument.callee.name, 'transform')
    assert.strictEqual(packs[0]._meta.clangPackExpansion.instantiated, false)
    assert.strictEqual(ast._meta.clangBackend.unsupported.PackExpansionExpr, 1)
    assert.strictEqual(ast._meta.clangBackend.status, 'partial')
  })

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
      ['capture', '[copy=value](int input){ return input + copy; }', 'lambda_capture_semantics'],
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

  it('preserves compound literals, variadic operand types and offsetof spelling', () => {
    const source = path.join(directory, 'c-values.c')
    fs.writeFileSync(source, `#include <stdarg.h>
      #include <stddef.h>
      struct Pair { int first; int second; };
      int target(int x) { return x; }
      int compound(int x) { return ((struct Pair){.second=target(x), .first=2}).second; }
      int variadic(int n, ...) { va_list args; va_start(args,n); int value=va_arg(args,int); va_end(args); return value; }
      unsigned long offset(void) { return offsetof(struct Pair, second); }
      enum Flags { first=1L<<0, second=1L<<1, negative=-2L, following };
      int enum_value(void) { return second; }
      int statement(int x) { return ({ int value=target(x); value+1; }); }
      int type_check(void) { return __builtin_types_compatible_p(int, long); }`)
    const database = path.join(directory, 'c-values.compile.json')
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang', '-c', source] }]))
    const report = path.join(directory, 'c-values.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.strictEqual(ast._meta.clangBackend.status, 'converted', JSON.stringify(ast._meta.clangBackend))
    const compound = walk(ast, 'CastExpression').find(node => node._meta.compoundLiteral)
    assert.ok(compound)
    assert.deepStrictEqual(walk(compound, 'ObjectProperty').map(node => node.key.name), ['first', 'second'])
    assert.deepStrictEqual(walk(compound, 'CallExpression').map(node => node.callee.name), ['target'])
    const calls = walk(ast, 'CallExpression')
    const variadic = calls.find(node => node.callee.name === '__builtin_va_arg')
    assert.strictEqual(variadic.arguments[0].name, 'args')
    assert.strictEqual(variadic._meta.typeArguments[0].id.name, 'int')
    assert.ok(calls.find(node => node.callee.name === 'offsetof')._meta.clangOffsetOf.includes('second'))
    const flags = walk(ast, 'ClassDefinition').find(node => node.id.name === 'Flags')
    assert.deepStrictEqual(flags.body.map((node: any) => node.init.value), [1, 2, -2, -1])
    const read = walk(ast, 'FunctionDefinition').find(node => node.id.name === 'enum_value')
    assert.strictEqual(walk(read, 'ReturnStatement')[0].argument.value, 2)
    const statement = walk(ast, 'FunctionDefinition').find(node => node.id.name === 'statement')
    const sequence = walk(statement, 'Sequence').find(node => node._meta.gnuStatementExpression)
    assert.ok(sequence)
    assert.strictEqual(sequence.expressions.at(-1).type, 'BinaryExpression')
    assert.deepStrictEqual(walk(sequence, 'CallExpression').map(node => node.callee.name), ['target'])
    const trait = calls.find(node => node.callee.name === '__builtin_types_compatible_p')
    assert.deepStrictEqual(trait._meta.typeArguments.map((type: any) => type.id.name), ['int', 'long'])
    assert.deepStrictEqual(trait.arguments, [])
  })

  for (const language of ['c', 'cpp']) it(`retains atomic builtin operands in source argument order for ${language}`, () => {
    const source = path.join(directory, 'atomic-operands.' + (language === 'c' ? 'c' : 'cpp'))
    fs.writeFileSync(source, `int *address(void); int delta(void); int order(void);
      #define UPDATE(p,d) __atomic_fetch_add(p,d,order())
      int old_value(void){return UPDATE(address(),delta());}
      int new_value(void){return __atomic_add_fetch(address(),delta(),5);}
      int load(void){return __atomic_load_n(address(),2);}
      void store(void){__atomic_store_n(address(),delta(),3);}
      int compare(int *expected){return __atomic_compare_exchange_n(address(),expected,delta(),0,5,2);}
      _Atomic(int) *atomic_address(void);
      int c11(void){return __c11_atomic_fetch_add(atomic_address(),delta(),4);}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: [language === 'c' ? 'clang' : 'clang++', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', language, '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const calls = walk(ast, 'CallExpression'), atomic = calls.filter(call => call._meta.clangAtomic)
    assert.strictEqual(atomic.length, 6)
    const fetch = atomic.find(call => call.callee.name === '__atomic_fetch_add')
    assert.deepStrictEqual(fetch.arguments.map((arg: any) => arg.callee.name), ['address', 'delta', 'order'])
    assert.strictEqual(fetch._meta.clangAtomic.result, 'previous_value')
    assert.strictEqual(fetch._meta.originalLocation.start.line, 3)
    const update = atomic.find(call => call.callee.name === '__atomic_add_fetch')
    assert.strictEqual(update._meta.clangAtomic.result, 'updated_value')
    assert.strictEqual(update.arguments[2].value, 5)
    const store = atomic.find(call => call.callee.name === '__atomic_store_n')
    assert.strictEqual(store.arguments[1].callee.name, 'delta')
    assert.strictEqual(store.arguments[2].value, 3)
    const compare = atomic.find(call => call.callee.name === '__atomic_compare_exchange_n')
    assert.strictEqual(compare.arguments[1].name, 'expected')
    assert.strictEqual(compare.arguments[2].callee.name, 'delta')
    assert.deepStrictEqual(compare.arguments.slice(4).map((arg: any) => arg.value), [5, 2])
    assert.strictEqual(calls.filter(call => call.callee.name === 'address').length, 5)
    assert.strictEqual(calls.filter(call => call.callee.name === 'delta').length, 5)
    const c11 = atomic.find(call => call.callee.name === '__c11_atomic_fetch_add')
    assert.strictEqual(c11.arguments[0].callee.name, 'atomic_address')
    assert.strictEqual(c11.arguments[1].callee.name, 'delta')
    assert.strictEqual(c11.arguments[2].value, 4)
    assert.strictEqual(ast._meta.clangBackend.unsupported.atomic_memory_semantics, 6)
    assert.ok(!ast._meta.clangBackend.unsupported.AtomicExpr)
  })

  it('keeps atomic operands with explicit diagnostics when source argument order is unavailable', () => {
    const converter = new ClangUastConverter({ sourcefile: 'missing.c', language: 'c', raw: '', sourceMap: [] })
    const call = converter.visit({ kind: 'AtomicExpr', name: '__atomic_fetch_add', inner: [
      { kind: 'IntegerLiteral', value: '11' }, { kind: 'IntegerLiteral', value: '22' }, { kind: 'IntegerLiteral', value: '33' },
    ] })
    assert.strictEqual(call.callee.name, '__clang_atomic_expr')
    assert.deepStrictEqual(call.arguments.map((arg: any) => arg.value), [11, 22, 33])
    assert.strictEqual(call._meta.clangAtomic.argumentOrder, 'clang_ast')
    assert.strictEqual(converter.finish()._meta.clangBackend.unsupported.atomic_operand_mapping, 1)
  })

  it('retains C++ GNU statement expression scopes, nested values and lifetime boundaries', () => {
    const source = path.join(directory, 'cpp-statement-expressions.cpp')
    fs.writeFileSync(source, `int input(); void consume(int);
      int run(){int value=9; return ({int value=input(); value+=({int value=input();value;}); value;})+value;}
      void no_result(){({consume(input()); int local=1;});}
      struct Guard {Guard(); ~Guard(); int value;};
      int cleanup(){return ({Guard guard; guard.value;});}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=gnu++17', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const run = walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'run')
    const scopes = walk(run, 'Sequence').filter(node => node._meta.gnuStatementExpression)
    assert.strictEqual(scopes.length, 2)
    assert.ok(scopes.every(node => node.expressions.at(-1).name === 'value'))
    assert.strictEqual(walk(run, 'CallExpression').filter(call => call.callee.name === 'input').length, 2)
    const sum = walk(run, 'ReturnStatement')[0].argument
    assert.strictEqual(sum.right.name, 'value')
    const noResult = walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'no_result')
    const block = walk(noResult, 'Sequence').find(node => node._meta.gnuStatementExpression)
    assert.strictEqual(block._meta.clangStatementExpression.resultType, 'void')
    assert.ok(walk(block, 'CallExpression').some(call => call.callee.name === 'consume'))
    const cleanup = walk(ast, 'FunctionDefinition').find(fn => fn.id.name === 'cleanup')
    assert.ok(walk(cleanup, 'Sequence').some(node => node._meta.gnuStatementExpression))
    assert.ok(walk(cleanup, 'NewExpression').length > 0)
    assert.strictEqual(ast._meta.clangBackend.unsupported.cpp_statement_expression_lifetime, 4)
    assert.ok(!ast._meta.clangBackend.unsupported.StmtExpr)
  })

  it('fills scalar and nested array tails without unbounded expansion', () => {
    const converter = new ClangUastConverter({ sourcefile: 'arrays.c', language: 'c', raw: '', sourceMap: [] })
    const zero = (type: string) => ({ kind: 'ImplicitValueInitExpr', type: { qualType: type } })
    const make = (type: string, filler: any, values: any[]) => converter.visit({ kind: 'InitListExpr', type: { qualType: type }, array_filler: [filler, ...values] })
    const a = make('int[4]', zero('int'), [{ kind: 'IntegerLiteral', value: '7' }])
    assert.deepStrictEqual(a.properties.map((p: any) => p.value.value), [7, 0, 0, 0])
    const pointer = make('int *[2]', zero('int *'), [])
    assert.ok(pointer.properties.every((p: any) => p.value.value === null))
    const arrayPointers = make('int (*[2])[3]', zero('int (*)[3]'), [])
    assert.ok(arrayPointers.properties.every((p: any) => p.value.value === null))
    const matrix = make('int[2][3]', zero('int[3]'), [])
    assert.strictEqual(matrix.properties.length, 2)
    assert.ok(matrix.properties.every((p: any) => p.value.properties.length === 3))
    assert.ok(!converter.finish()._meta.clangBackend.unsupported.implicit_array_tail)
    const large = make('int[1000000]', zero('int'), [])
    assert.strictEqual(large.properties.length, 0)
    assert.strictEqual(converter.finish()._meta.clangBackend.unsupported.implicit_array_tail, 1)
    const records = make('struct S[2]', zero('struct S'), [])
    assert.strictEqual(records.properties.length, 0)
    assert.strictEqual(converter.finish()._meta.clangBackend.unsupported.implicit_array_tail, 2)
  })

  it('lowers simple backward branches and preserves switch condition scope', () => {
    const source = path.join(directory, 'control-gaps.c')
    fs.writeFileSync(source, `int input(void); int step(int);
      int loop(int n){again: n=step(n); if(n>0) goto again; return n;}
      int selection(int x){switch(x){int x; case 1: x=input(); return x; default:return 0;}}
      int unsafe(int n){start: if(n--) goto start; return n;}
      int incoming(int n){if(n)goto again; again:n--;if(n>0)goto again;return n;}
      int unreachable(int n){switch(n){int x=input();case 1:return x;default:return 0;}}
      int arrays(void){int a[4]={1};int b[2][3]={{2}};return a[3]+b[1][2];}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const fn = (name: string) => walk(ast, 'FunctionDefinition').find(node => node.id.name === name)
    const loop = walk(fn('loop'), 'WhileStatement')[0]
    assert.ok(loop?.isPostTest)
    assert.strictEqual(walk(loop, 'CallExpression').filter(call => call.callee.name === 'step').length, 1)
    assert.strictEqual(walk(fn('incoming'), 'WhileStatement').length, 0)
    const selection = fn('selection'), sw = walk(selection, 'SwitchStatement')[0]
    assert.ok(sw._meta.clangSwitchDeclarations)
    const declarations = walk(selection, 'VariableDeclaration').filter(node => !node._meta?.isParameter)
    assert.strictEqual(declarations[0].init.name, 'x')
    assert.strictEqual(declarations[1].id.name, 'x')
    assert.strictEqual(declarations[1].init, null)
    assert.strictEqual(ast._meta.clangBackend.unsupported.goto_control_flow, 2)
    assert.strictEqual(ast._meta.clangBackend.unsupported.switch_pre_label_statement, 1)
    assert.ok(!ast._meta.clangBackend.unsupported.implicit_array_tail)
  })

  it('retains case clauses wrapped by ordinary labels and fills typedef array tails', () => {
    const source = path.join(directory, 'labelled-cases.c')
    fs.writeFileSync(source, `typedef long long Counter; typedef int *Pointer;
      int target(int); int inspect(int n){switch(n){outer:inner:case 0:case 2:target(n);break;case 1:goto outer;last:default:break;}return n;}
      struct Stats {Counter current[10];Counter peak[10];};
      struct Stats stats={{0},{0}};
      Pointer pointers[2]={0};`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const sw = walk(ast, 'SwitchStatement')[0]
    assert.strictEqual(sw.cases.length, 4)
    assert.deepStrictEqual(walk(sw, 'LabeledStatement').map(node => node.label.name), ['outer', 'inner', 'last'])
    assert.strictEqual(walk(sw, 'CallExpression').filter(node => node.callee.name === 'target').length, 1)
    assert.strictEqual(sw.cases[0].test.value, 0)
    assert.strictEqual(sw.cases[1].test.value, 2)
    const stats = walk(ast, 'VariableDeclaration').find(node => node.id.name === 'stats')
    for (const field of stats.init.properties) {
      assert.strictEqual(field.value.properties.length, 10)
      assert.ok(field.value.properties.every((item: any) => item.value.value === 0))
    }
    const pointers = walk(ast, 'VariableDeclaration').find(node => node.id.name === 'pointers')
    assert.strictEqual(pointers.init.properties.length, 2)
    assert.strictEqual(pointers.init.properties[1].value.value, null)
    assert.ok(!ast._meta.clangBackend.unsupported.implicit_array_tail)
    assert.ok(!ast._meta.clangBackend.unsupported.switch_pre_label_statement)
    assert.strictEqual(ast._meta.clangBackend.unsupported.goto_control_flow, 1)
  })

  it('expands bounded GNU case ranges and retains unsupported nested label bodies', () => {
    const source = path.join(directory, 'switch-ranges.c')
    fs.writeFileSync(source, `int target(int); int range(int n){switch(n){case -2 ... 2:return target(n);default:return 0;}}
      int large(int n){switch(n){case 0 ... 10000:return target(n);default:return 0;}}
      int nested(int n){switch(n){case 0:{int local=3;case 1:return target(local);}default:return 0;}}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const range = walk(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'range')
    assert.deepStrictEqual(walk(range, 'CaseClause').map(clause => clause.test?.value), [-2, -1, 0, 1, 2, undefined])
    assert.strictEqual(walk(ast, 'CallExpression').filter(call => call.callee.name === 'target').length, 3)
    assert.strictEqual(ast._meta.clangBackend.unsupported.case_range_control_flow, 1)
    assert.strictEqual(ast._meta.clangBackend.unsupported.nested_switch_label_control_flow, 1)
    assert.ok(!ast._meta.clangBackend.unsupported.CaseStmt)
  })

  it('retains compiler-validated wide enumerator values without inventing dependent constants', () => {
    const source = path.join(directory, 'wide-enumerators.cpp')
    fs.writeFileSync(source, `enum Pixels { RGB=1, BGR=2, MASK=0xffff0000U, RGB2BGR=RGB|(BGR<<16), NEXT };
      enum class Narrow : unsigned char { Wrapped=(unsigned char)300 };
      enum class Huge : unsigned long long { Value=18446744073709551615ULL };
      template<int N> struct Dependent { enum { value=N+1 }; };
      unsigned read(){return RGB2BGR;}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const variables = walk(ast, 'VariableDeclaration')
    for (const [name, value] of [['MASK', 4294901760], ['RGB2BGR', 131073], ['NEXT', 131074], ['Wrapped', 44], ['Value', '18446744073709551615']]) {
      assert.strictEqual(variables.find(node => node.id.name === name)?.init.value, value, String(name))
    }
    assert.strictEqual(ast._meta.clangBackend.unsupported.dependent_enum_value, 1)
  })

  it('models scalar value captures and simple inheritance while keeping complex cases partial', () => {
    const source = path.join(directory, 'capture-inheritance.cpp')
    fs.writeFileSync(source, `struct Base {int value;}; struct Derived:Base {}; struct Virtual:virtual Base {}; struct Hidden:Base {int value;}; struct Other {int other;}; struct Multiple:Base,Other {}; struct Chain:Virtual {};
      int f(int value){auto copy=[value](){return value;}; value=0;return copy();}`)
    const database = source + '.compile.json', report = source + '.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const derived = walk(ast, 'ClassDefinition').find(node => node.id.name === 'Derived')
    assert.strictEqual(derived.supers[0].name, 'Base')
    const lambda = walk(ast, 'FunctionDefinition').find(node => node._meta.cppLambda)
    assert.strictEqual(lambda._meta.cppLambda.captureSemantics, 'scalar_snapshot')
    assert.deepStrictEqual(lambda._meta.cppLambda.captures.map((capture: any) => capture.name), ['value'])
    assert.strictEqual(ast._meta.clangBackend.unsupported.cpp_baseclass_semantics, 4)
    assert.ok(!ast._meta.clangBackend.unsupported.lambda_capture_semantics)
  })

  it('exports member-pointer operands and records unresolved member-pointer semantics', () => {
    const source = path.join(directory, 'member-pointers.cpp')
    fs.writeFileSync(source, 'struct S { int value; int method(){return value;} }; int read(S *p, int S::*data, int(S::*method)()){return p->*data+(p->*method)();} int object(S s,int S::*data){return s.*data;}')
    const database = source + '.compile.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const report = source + '.json'
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.strictEqual(ast._meta.compilerDump.status, 'partial_conversion')
    assert.strictEqual(ast._meta.clangBackend.unsupported.member_pointer_resolution, 3)
    const accesses = walk(ast, 'MemberAccess').filter(node => node._meta.cppMemberPointer)
    assert.deepStrictEqual(accesses.map(node => node._meta.cppMemberPointer).sort(), ['->*', '->*', '.*'])
    assert.ok(accesses.every(node => node.computed))
    assert.ok(walk(ast, 'CallExpression').some(node => node.callee._meta?.cppMemberPointer === '->*'))
  })

  it('retains calls in standard initializer lists, alias defaults and dependent parenthesized initialization', () => {
    const source = path.join(directory, 'initializer-calls.cpp')
    fs.writeFileSync(source, `#include <initializer_list>
      int target(int x){return x;}
      struct Box { Box(int x=target(3)){} }; using Alias=Box;
      void consume(std::initializer_list<int>);
      void run(){Alias value; consume({target(1),target(2)});}
      template<class T> void dependent(){T value(target(4),target(5));}`)
    const database = source + '.compile.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const report = source + '.json'
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const run = walk(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'run')
    assert.deepStrictEqual(walk(run, 'CallExpression').filter(call => call.callee.name === 'target').map(call => call.arguments[0].value).sort(), [1, 2, 3])
    const list = walk(run, 'CastExpression').find(node => node._meta.clangStdInitializerList)
    assert.ok(list)
    assert.strictEqual(walk(list, 'ObjectProperty').length, 2)
    const dependent = walk(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'dependent')
    assert.deepStrictEqual(walk(dependent, 'CallExpression').map(call => call.arguments[0].value), [4, 5])
    assert.ok(ast._meta.clangBackend.unsupported.dependent_parenthesized_initialization)
    assert.ok(!ast._meta.clangBackend.unsupported.CXXDefaultArgExpr)
  })

  it('preserves calls on both sides of assignments to reference-returning expressions', () => {
    const source = path.join(directory, 'reference-assignment.cpp')
    fs.writeFileSync(source, 'int index(); int input(); struct Array {int &operator[](int);}; int &ref(); void run(Array &array){array[index()]=input();ref()+=input();}')
    const database = source + '.compile.json'
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang++', '-std=c++17', '-c', source] }]))
    const report = source + '.json'
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'cpp', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    const run = walk(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'run')
    const names = walk(run, 'CallExpression').map(call => call.callee.name)
    assert.strictEqual(names.filter(name => name === 'input').length, 2)
    for (const name of ['index', 'ref', 'operator[]']) assert.ok(names.includes(name), name)
    assert.strictEqual(ast._meta.clangBackend.unsupported.assignment_location_semantics, 2)
    assert.deepStrictEqual(walk(run, 'AssignmentExpression').map(node => node.operator), ['=', '+='])
    assert.ok(walk(run, 'AssignmentExpression').every(node => node.left.type === 'CallExpression'))
  })

  it('keeps offsetof index evaluation visibly partial', () => {
    const source = path.join(directory, 'indexed-offset.c')
    fs.writeFileSync(source, '#include <stddef.h>\nstruct Array { int values[8]; }; int index(void); unsigned long offset(void) { return offsetof(struct Array, values[index()]); }')
    const database = path.join(directory, 'indexed-offset.compile.json')
    fs.writeFileSync(database, JSON.stringify([{ directory, file: source, arguments: ['clang', '-c', source] }]))
    const report = path.join(directory, 'indexed-offset.json')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
      '--language', 'c', '--dumpAST', '--cCompileCommands', database, '--cAstBackend', 'clang', '--report', report], { cwd: engine, encoding: 'utf8' })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.strictEqual(ast._meta.compilerDump.status, 'partial_conversion')
    assert.strictEqual(ast._meta.clangBackend.unsupported.offsetof_index_evaluation, 1)
    assert.ok(walk(ast, 'CallExpression').some(call => call.callee.name === 'index'))
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
