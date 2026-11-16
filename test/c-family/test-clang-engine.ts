import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { describe, it, before, after } from 'mocha'

const engine = path.resolve(__dirname, '../..')

describe('Engine consumption of Clang-produced UAST', function () {
  this.timeout(60_000)
  let root: string
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-clang-engine-')) })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  const scan = (name: string, code: string, cpp: boolean): any => {
    const directory = path.join(root, name)
    const input = path.join(directory, 'input')
    fs.mkdirSync(input, { recursive: true })
    const file = path.join(input, cpp ? 'main.cpp' : 'main.c')
    fs.writeFileSync(file, code)
    const args = [cpp ? 'clang++' : 'clang', ...(cpp ? ['-std=c++17'] : []), '-c', file]
    const database = path.join(directory, 'compile_commands.json')
    fs.writeFileSync(database, JSON.stringify([{ directory: input, file, arguments: args }]))
    const entryId = createHash('sha256').update(JSON.stringify([input, file, args])).digest('hex')
    const profile = path.join(directory, 'profile.json')
    fs.writeFileSync(profile, JSON.stringify({ version: 1, profileId: name, units: [{ entryId, domainId: name }] }))
    const report = path.join(directory, 'report')
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', input,
      '--language', 'c-cpp', '--compileCommands', database, '--buildProfile', profile, '--astBackend', 'clang',
      '--dumpAllCG', '--report', report], { cwd: engine, encoding: 'utf8', timeout: 45_000 })
    assert.strictEqual(child.status, 0, child.stdout + child.stderr)
    const manifest = JSON.parse(fs.readFileSync(path.join(report, 'analysis-manifest.json'), 'utf8'))
    assert.strictEqual(manifest.status, 'complete')
    assert.strictEqual(manifest.astBackend, 'clang')
    assert.ok(manifest.domains[0].entryPointCount > 0)
    return { manifest, graph: JSON.parse(fs.readFileSync(path.join(report, 'callgraph.json'), 'utf8')).domains[0].graph,
      sarif: JSON.parse(fs.readFileSync(path.join(report, 'report.sarif'), 'utf8')) }
  }

  it('produces resolved call edges for direct, macro, callback, lambda and template-method calls', () => {
    const source = fs.readFileSync(path.join(__dirname, 'clang-fixtures/semantic.cpp'), 'utf8')
    const { graph } = scan('semantic', source, true)
    const pairs = new Set(Object.values<any>(graph.edges).map(edge => {
      const source = graph.nodes[edge.sourceNodeId].funcDef?.name
      const target = graph.nodes[edge.targetNodeId].funcDef?.name
      return `${source}->${target}`
    }))
    for (const expected of ['through_macro->target', 'through_pointer->target', 'run->through_pointer', 'run->lambda', 'lambda->target', 'run->get']) {
      assert.ok(pairs.has(expected), `Missing ${expected}; found ${[...pairs].join(', ')}`)
    }
  })

  it('distinguishes unmangled template declarations in separate namespaces', () => {
    const { graph } = scan('template-scopes', `
      namespace first { template<class T> int value(T input) { return input; } }
      namespace second { template<class T> int value(T input) { return input + 1; } }
      template<bool> int count() { return 1; }
      template<bool A, bool B> int count() { return 2; }
      int main() { return first::value(2) + second::value(3) + count<true>() + count<true, false>(); }
    `, true)
    const targets = Object.values<any>(graph.edges).map(edge => graph.nodes[edge.targetNodeId].funcDef?.name)
    assert.ok(targets.includes('first::value'), JSON.stringify(targets))
    assert.ok(targets.includes('second::value'), JSON.stringify(targets))
    assert.strictEqual(targets.filter(name => name === 'count').length, 2)
  })

  it('keeps out-of-line overloaded constructors inside their owning class', () => {
    const { graph } = scan('out-of-line-constructors', `
      int target(int input) { return input; }
      struct Owner { int member; Owner(); Owner(int value); int get(); };
      Owner::Owner(): member(target(1)) {}
      Owner::Owner(int value): member(target(value)) {}
      int Owner::get() { return member; }
      int main() { Owner value(2); return value.get(); }
    `, true)
    assert.ok(Object.values<any>(graph.nodes).some(node => node.funcDef?.name === 'get'))
  })

  it('tracks values through designated compound literals', () => {
    for (const [name, value, expected] of [
      ['compound-positive', 'getenv("USER")', true],
      ['compound-negative', '"safe"', false],
    ] as const) {
      const { sarif } = scan(name, `extern char *getenv(const char *); extern int system(const char *);
        struct Value { int tag; char *text; };
        int main(void) { return system(((struct Value){.text=${value}, .tag=2}).text); }`, false)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length > 0), expected)
    }
  })

  it('preserves statement-expression results, side effects and local shadowing', () => {
    for (const [name, body, expected] of [
      ['statement-result', 'return system(({ char *local=getenv("USER"); local; }));', true],
      ['statement-shadow', 'char *value="safe"; ({ char *value=getenv("USER"); value; }); return system(value);', false],
      ['statement-write', 'char *value="safe"; ({ value=getenv("USER"); 0; }); return system(value);', true],
    ] as const) {
      const { sarif } = scan(name, `extern char *getenv(const char *); extern int system(const char *);
        int main(void) { ${body} }`, false)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length > 0), expected, name)
    }
  })

  it('analyzes lowered backedges, zero-filled arrays and switch-local declarations', () => {
    for (const [name, body, expected] of [
      ['backedge', 'char *value="safe"; again: value=getenv("USER"); if(0)goto again; return system(value);', true],
      ['array-zero', 'char *values[2]={getenv("USER")}; return system(values[1]);', false],
      ['array-explicit', 'char *values[2]={getenv("USER")}; return system(values[0]);', true],
      ['switch-shadow', 'int value=1; switch(value){char *value;case 1:value=getenv("USER");return system(value);default:return 0;}', true],
    ] as const) {
      const { sarif } = scan(name, `#include <stdlib.h>
int main(void){${body}}`, false)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
  })

  it('executes expanded GNU case ranges with ordinary fallthrough', () => {
    for (const [value, expected] of [[-3, false], [-2, true], [0, true], [2, true], [3, false]] as const) {
      const { sarif } = scan('case-range-' + value, `#include <stdlib.h>
        int main(){char *value="safe";switch(${value}){case -2 ... 2:value=getenv("USER");break;default:break;}return system(value);}`, false)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, String(value))
    }
  })

  it('selects a literal switch case before default and preserves fallthrough', () => {
    for (const [name, body, expected] of [
      ['default-first', 'switch(1){default:value=getenv("USER");break;case 1:break;}', false],
      ['fallthrough', 'switch(1){case 1:;case 2:value=getenv("USER");break;default:break;}', true],
    ] as const) {
      const { sarif } = scan(name, `#include <stdlib.h>
        int main(){char *value="safe";${body}return system(value);}`, false)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
  })

  it('snapshots scalar captures at closure creation and isolates mutable captures', () => {
    const control = scan('snapshot-control', '#include <stdlib.h>\nint main(){int value=(int)(long)getenv("USER");return system((char*)(long)value);}', true)
    assert.ok(control.sarif.runs[0].results.length > 0, 'scalar control must retain taint')
    for (const [name, initial, later, expected] of [
      ['snapshot-positive', '(int)(long)getenv("USER")', '0', true],
      ['snapshot-negative', '0', '(int)(long)getenv("USER")', false],
    ] as const) {
      const { sarif } = scan(name, `#include <stdlib.h>
        int main(){int value=${initial};auto copy=[value](){return value;};value=${later};return system((char*)(long)copy());}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
    const { sarif } = scan('mutable-snapshot', `#include <stdlib.h>
      int main(){int value=(int)(long)getenv("USER");auto copy=[value]()mutable{value=0;return value;};copy();return system((char*)(long)value);}`, true)
    assert.ok(sarif.runs[0].results.length > 0)
  })

  it('keeps separate scalar snapshots from repeated closure creation', () => {
    for (const [name, first, second, expected] of [
      ['factory-positive', '(int)(long)getenv("USER")', '0', true],
      ['factory-negative', '0', '(int)(long)getenv("USER")', false],
    ] as const) {
      const { sarif } = scan(name, `#include <stdlib.h>
        auto make(int value){return [value](){return value;};}
        int main(){auto first=make(${first});auto second=make(${second});second();return system((char*)(long)first());}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
  })

  it('resolves namespace aliases by declaration identity across lexical scopes', () => {
    const { graph } = scan('namespace-aliases', `
      namespace one {int first(){return 1;}}
      namespace two {int second(){return 2;}}
      namespace alias=one; namespace chained=alias;
      int outer(){return chained::first();}
      namespace nested {namespace alias=two;int inner(){return alias::second();}}
      int main(){return outer()+nested::inner();}`, true)
    const pairs = new Set(Object.values<any>(graph.edges).map(edge =>
      `${graph.nodes[edge.sourceNodeId].funcDef?.name}->${graph.nodes[edge.targetNodeId].funcDef?.name}`))
    assert.ok(pairs.has('outer->one::first'), [...pairs].join(', '))
    assert.ok(pairs.has('nested::inner->two::second'), [...pairs].join(', '))
    assert.ok(!pairs.has('nested::inner->one::first'))
  })

  it('resolves a single base inside a namespace without confusing same-named records', () => {
    const { sarif } = scan('namespaced-base', `#include <stdlib.h>
      struct Base {int unrelated;};
      namespace model {struct Base {char *value;char *get(){return value;}};struct Derived:Base {};}
      int main(){model::Derived d;d.value=getenv("USER");return system(d.get());}`, true)
    assert.ok(sarif.runs[0].results.length > 0)
  })

  it('uses inherited instance fields through a nonvirtual single base', () => {
    const { sarif } = scan('single-base', `#include <stdlib.h>
      struct Base {char *value;char *get(){return value;}};
      struct Derived:Base {};
      int main(){Derived d;d.value=getenv("USER");return system(d.get());}`, true)
    assert.ok(sarif.runs[0].results.length > 0)
  })

  it('preserves forward goto state when it bypasses assignments', () => {
    for (const [name, initial, skipped, expected] of [
      ['goto-positive', 'getenv("USER")', '"safe"', true],
      ['goto-negative', '"safe"', 'getenv("USER")', false],
    ] as const) {
      const { sarif } = scan(name, `extern char *getenv(const char *); extern int system(const char *);
        int main(void) { char *value = ${initial}; goto end; value = ${skipped}; end: return system(value); }`, false)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length > 0), expected)
    }
  })

  it('evaluates project default arguments at the caller', () => {
    const { graph, sarif } = scan('default-arguments', `
      extern "C" char *getenv(const char *); extern "C" int system(const char *);
      char *input() { return getenv("USER"); }
      char *forward(char *value = input());
      char *forward(char *value) { return value; }
      int main() { return system(forward()); }
    `, true)
    assert.ok(sarif.runs.some((run: any) => run.results?.length > 0))
    const pairs = Object.values<any>(graph.edges).map(edge => graph.nodes[edge.sourceNodeId].funcDef?.name + '->' + graph.nodes[edge.targetNodeId].funcDef?.name)
    assert.ok(pairs.includes('main->input'), JSON.stringify(pairs))
  })

  it('evaluates alias constructor defaults at the caller', () => {
    const { graph } = scan('initializer-operands', `
      int target(int x){return x;}
      struct Box { Box(int x=target(3)){} }; using Alias=Box;
      int main(){ Alias value; return 0; }
    `, true)
    const pairs = Object.values<any>(graph.edges).map(edge => graph.nodes[edge.sourceNodeId].funcDef?.name + '->' + graph.nodes[edge.targetNodeId].funcDef?.name)
    assert.ok(pairs.includes('main->target'), JSON.stringify(pairs))
  })

  it('uses explicit arguments without evaluating the default source', () => {
    const { sarif } = scan('default-explicit-safe', `
      extern "C" char *getenv(const char *); extern "C" int system(const char *);
      char *input() { return getenv("USER"); }
      char *forward(char *value = input()) { return value; }
      int main() { return system(forward((char *)"safe")); }
    `, true)
    assert.strictEqual(sarif.runs.some((run: any) => run.results?.length > 0), false)
  })

  it('observes changes through simple lambda reference captures', () => {
    for (const [name, initial, updated, expected] of [
      ['capture-reference-positive', '"safe"', 'getenv("USER")', true],
      ['capture-reference-negative', 'getenv("USER")', '"safe"', false],
    ] as const) {
      const { sarif } = scan(name, `extern "C" char *getenv(const char *); extern "C" int system(const char *);
        int main() { char *value = ${initial}; auto invoke = [&value]() { return system(value); }; value = ${updated}; return invoke(); }`, true)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length > 0), expected)
    }
  })

  it('writes through simple lambda reference captures', () => {
    for (const [name, initial, assigned, expected] of [
      ['capture-write-positive', '"safe"', 'getenv("USER")', true],
      ['capture-write-negative', 'getenv("USER")', '"safe"', false],
    ] as const) {
      const { sarif } = scan(name, `extern "C" char *getenv(const char *); extern "C" int system(const char *);
        int main(){ char *value=${initial}; auto update=[&value](){ value=${assigned}; }; update(); return system(value); }`, true)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length > 0), expected)
    }
  })

  it('detects a getenv-to-system flow through native-produced C UAST', () => {
    const { sarif } = scan('taint-positive', 'extern char *getenv(const char *); extern int system(const char *); int main(void){ char *value=getenv("USER"); return system(value); }', false)
    assert.ok(sarif.runs.some((run: any) => run.results?.length > 0), JSON.stringify(sarif))
  })

  it('keeps the constant-input safe control free of findings', () => {
    const { sarif } = scan('taint-negative', 'extern int system(const char *); int main(void){ return system("fixed-command"); }', false)
    assert.strictEqual(sarif.runs.reduce((count: number, run: any) => count + (run.results?.length || 0), 0), 0)
  })
})
