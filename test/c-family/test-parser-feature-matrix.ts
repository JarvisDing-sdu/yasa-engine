import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const engine = path.resolve(__dirname, '../..')

function nodes(root: any, type: string): any[] {
  const pending = [root]
  const found: any[] = []
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === type) found.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (['_meta', 'loc', 'parent'].includes(key)) continue
      if (Array.isArray(value)) pending.push(...value)
      else pending.push(value)
    }
  }
  return found
}

const cases = [
  {
    name: 'c-declarators', language: 'c',
    code: 'typedef int (*Callback)(int); int target(int x){return x;} int dispatch(Callback cb,int x){return cb(x);} int grid[2][3];',
    check(ast: any, backend: string) {
      assert.deepStrictEqual(nodes(ast, 'FunctionDefinition').map(fn => fn.id.name).sort(), ['dispatch', 'target'])
      const grid = nodes(ast, 'VariableDeclaration').find(decl => decl.id.name === 'grid')
      assert.strictEqual(grid.varType.type, 'ArrayType')
      assert.strictEqual(grid.varType.element.type, 'ArrayType')
      assert.ok(nodes(ast, 'CallExpression').some(call => call.callee.name === 'cb'))
    },
  },
  {
    name: 'c-control-scope', language: 'c',
    code: 'int target(int); int f(int x){ int value=x; {int value=2; target(value);} for(int i=0;i<2;i++){if(x) continue; else break;} do{x--;}while(x>2); switch(x){case 1:return target(x);default:return value;} }',
    check(ast: any, backend: string) {
      for (const type of ['ForStatement', 'WhileStatement', 'IfStatement', 'SwitchStatement', 'BreakStatement', 'ContinueStatement']) assert.strictEqual(nodes(ast, type).length, 1, type)
      assert.strictEqual(nodes(ast, 'VariableDeclaration').filter(decl => decl.id.name === 'value').length, 2)
      assert.strictEqual(nodes(ast, 'SwitchStatement')[0].cases.length, 2)
    },
  },
  {
    name: 'c-initializers', language: 'c',
    code: 'struct Pair{int first;int second;}; struct Pair value={.second=7,.first=2}; int sparse[4]={[1]=5,[3]=9}; int read(void){return ((struct Pair){.second=3,.first=1}).second;}',
    check(ast: any, backend: string) {
      const value = nodes(ast, 'VariableDeclaration').find(decl => decl.id.name === 'value')
      assert.deepStrictEqual(value.init.properties.map((prop: any) => [prop.key.name, prop.value.value]).sort((a: any, b: any) => a[0].localeCompare(b[0])), [['first', 2], ['second', 7]])
      assert.ok(nodes(ast, 'CastExpression').some(cast => cast._meta.compoundLiteral))
      assert.strictEqual(nodes(ast, 'MemberAccess').filter(member => member.property.name === 'second').length, 1)
    },
  },
  {
    name: 'cpp-overload-construction', language: 'cpp',
    code: 'namespace N {int pick(int x){return x;} double pick(double x){return x;}} struct Box{int value;Box(int x):value(N::pick(x)){} int get(){return value;}}; int run(){Box b(2);return b.get();}',
    check(ast: any, backend: string) {
      assert.strictEqual(nodes(ast, 'FunctionDefinition').filter(fn => fn.id?.name === 'pick').length, 2)
      assert.ok(nodes(ast, 'ClassDefinition').some(cls => cls.id.name === 'Box'))
      assert.strictEqual(nodes(ast, 'FunctionDefinition').some(fn => fn._meta.isConstructor), true)
      assert.ok(nodes(ast, 'CallExpression').some(call => call.callee.type === 'MemberAccess' && call.callee.property.name === 'get'))
    },
  },
  {
    name: 'cpp-template-lambda', language: 'cpp',
    code: 'template<class T> T identity(T x){return x;} int target(int x){return x;} int run(){auto fn=[](int x){return target(x);}; return fn(identity<int>(2));}',
    check(ast: any, backend: string) {
      assert.ok(nodes(ast, 'FunctionDefinition').some(fn => fn.id?.name === 'identity'))
      assert.ok(nodes(ast, 'CallExpression').some(call => call.callee?.name === 'target'))
      assert.ok(nodes(ast, 'CallExpression').some(call => call.callee.name === 'fn'))
    },
  },
]

for (const language of ['c', 'cpp']) {
  for (const enabled of [0, 1]) {
    cases.push({
      name: `${language}-conditional-${enabled}`, language,
      code: `#include "api.h"\n#define APPLY(fn,x) fn(x)\nint run(int x){\n#if FEATURE\nreturn APPLY(fast,x);\n#else\nreturn APPLY(slow,x);\n#endif\n}`,
      check(ast: any) {
        const run = nodes(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'run')
        assert.deepStrictEqual(nodes(run, 'CallExpression').map(call => call.callee.name), [enabled ? 'fast' : 'slow'])
        const header = nodes(ast, 'FunctionDefinition').find(fn => fn.id?.name === 'from_header')
        assert.ok(header)
        assert.ok(header._meta.originalLocation.sourcefile.endsWith('api.h'))
        assert.strictEqual(header._meta.originalLocation.start.line, 2)
      },
    })
  }
}

describe('project-independent parser feature matrix', function () {
  this.timeout(30_000)
  let directory: string
  before(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-feature-matrix-')) })
  after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const item of cases) {
    for (const backend of ['tree-sitter', 'clang']) {
      it(`contract / ${item.name} / ${backend}`, () => {
        const source = path.join(directory, `${item.name}.${item.language === 'c' ? 'c' : 'cpp'}`)
        fs.writeFileSync(source, item.code)
        fs.writeFileSync(path.join(directory, "api.h"), "int fast(int); int slow(int);\nstatic int from_header(void){return 1;}\n")
        const database = source + '.compile.json'
        fs.writeFileSync(database, JSON.stringify([{ directory, file: source,
          arguments: [item.language === 'c' ? 'clang' : 'clang++', item.language === 'c' ? '-std=c11' : '-std=c++17', `-DFEATURE=${item.name.endsWith('-1') ? 1 : 0}`, '-c', source] }]))
        const report = source + `.${backend}.json`
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', source,
          '--language', item.language, '--dumpAST', '--cCompileCommands', database, '--cAstBackend', backend,
          '--report', report], { cwd: engine, encoding: 'utf8', timeout: 25_000 })
        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        const ast = JSON.parse(fs.readFileSync(report, 'utf8'))
        assert.strictEqual(ast.type, 'CompileUnit')
        assert.deepStrictEqual(ast._meta.parseErrors || [], [])
        item.check(ast, backend)
      })
    }
  }
})
