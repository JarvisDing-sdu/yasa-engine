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

  it('resolves a nonvirtual destructor for an external pointer and skips a known null', () => {
    for (const [name, operand, expected] of [['external', 'acquire()', true], ['null', 'nullptr', false]] as const) {
      const { graph } = scan('delete-' + name, `
        int observed() { return 1; }
        struct Leaf { ~Leaf() noexcept { observed(); } }; Leaf* acquire();
        int main() { Leaf* p = ${operand}; delete p; }`, true)
      const targets = Object.values<any>(graph.edges)
        .filter(edge => graph.nodes[edge.sourceNodeId]?.funcDef?.name === 'main')
        .map(edge => graph.nodes[edge.targetNodeId]?.funcDef?.name)
      assert.strictEqual(targets.includes('~Leaf'), expected, JSON.stringify(targets))
    }
  })

  it('calls only the proven leaf and base destructors, skipping both on null', () => {
    // Out-of-line definitions also exercise declaration-to-definition symbol binding.
    const { graph } = scan('exact-virtual-destruction', `
      struct B { virtual ~B() noexcept; }; B::~B() noexcept {}
      struct Left final:B { ~Left() noexcept; }; Left::~Left() noexcept {}
      struct Right final:B { ~Right() noexcept; }; Right::~Right() noexcept {}
      Left* left(); Right* right();
      void dropLeft(){delete static_cast<B*>(left());}
      void dropRight(){B* const p=right();delete p;}
      void dropNull(){delete static_cast<Left*>(nullptr);}
      int main(){dropLeft();dropRight();dropNull();}`, true)
    const targets = (caller: string) => Object.values<any>(graph.edges)
      .filter(e => graph.nodes[e.sourceNodeId]?.funcDef?.name === caller)
      .map(e => graph.nodes[e.targetNodeId]?.funcDef?.name).filter(n => n?.startsWith('~')).sort()
    assert.deepStrictEqual(targets('dropLeft'), ['~B','~Left'])
    assert.deepStrictEqual(targets('dropRight'), ['~B','~Right'])
    assert.deepStrictEqual(targets('dropNull'), [])
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

  it('executes scalar C++ statement expressions with lexical scope and observable writes', () => {
    for (const [name, body, tainted] of [
      ['result', 'long result = ({long local = input(); local;}); return system((char*)result);', true],
      ['shadow', 'long clean = 0; ({long clean = input(); clean;}); return system((char*)clean);', false],
      ['void', 'long bits = 0; ({bits |= input(); int last = 0;}); return system((char*)bits);', true],
      ['rhs-first', 'global |= seed(); return system((char*)global);', true],
    ] as const) {
      const { sarif } = scan('cpp-statement-' + name, `#include <stdlib.h>
        long input(){return (long)getenv("USER");} long global=0; long seed(){global=input();return 0;} int main(){${body}}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, tainted, name)
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

  it('preserves the placement address for a default-initialized scalar', () => {
    const { sarif } = scan('placement-address', `
      void* operator new(decltype(sizeof(0)), void*) noexcept;
      extern char* getenv(const char*); extern int system(const char*);
      int main(){char* text; char** place = new(&text) char*; *place = getenv("USER"); return system(text);}`, true)
    assert.ok(sarif.runs.some((run: any) => run.results?.length))
  })

  it('writes and reads the selected standard vector element', () => {
    for (const [name, index, expected] of [['same', 1, true], ['other', 0, false]] as const) {
      const { sarif } = scan('vector-element-' + name, `
        #include <vector>
        extern char* getenv(const char*); extern int system(const char*);
        int main(){std::vector<char*> v(2); v[0]=(char*)"safe"; v[1]=getenv("USER"); return system(v[${index}]);}`, true)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length), expected, name)
    }
  })

  it('writes and reads individual string characters', () => {
    for (const [name, index, expected] of [['same', 1, true], ['other', 0, false]] as const) {
      const { sarif } = scan('string-element-' + name, `
        #include <string>
        extern char* getenv(const char*); extern int system(const char*);
        int main(){std::string text(2,'a'); text[0]='a'; text[1]=getenv("USER")[0];
          char command[2]={text[${index}],0}; return system(command);}`, true)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length), expected, name)
    }
  })

  it('delegates initialization to the selected constructor on the same instance', () => {
    for (const [name, value, expected] of [['tainted', 'getenv("USER")', true], ['clean', '"safe"', false]] as const) {
      const { sarif } = scan('delegated-' + name, `
        extern char *getenv(const char*); extern int system(const char*);
        struct Owner { const char* text; Owner():Owner(${value}){} Owner(const char* s):text(s){} };
        int main(){Owner obj; return system(obj.text);}`, true)
      assert.strictEqual(sarif.runs.some((run: any) => run.results?.length), expected)
    }
  })

  it('runs the base constructor on the derived receiver', () => {
    for (const [name, init, expected] of [['tainted', 'getenv("USER")', true], ['safe', '"ok"', false]] as const) {
      const { sarif } = scan('base-init-' + name, `#include <stdlib.h>
        struct B {const char *v; B(const char *p):v(p){}};
        struct D:B {D(const char *p):B(p){}};
        int main(){D d(${init});return system(d.v);}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
  })

  it('calls the compiler-selected direct base constructor on the derived object', () => {
    for (const [label, tag, expected] of [['int', '0', true], ['long', '0L', false]] as const) {
      const { sarif } = scan('base-overload-' + label, `#include <stdlib.h>
        struct Base { const char *field; Base(int, const char*); Base(long, const char*); };
        struct Derived : Base { Derived(const char *arg): Base(${tag}, arg) {} };
        Base::Base(int, const char *arg):field(arg) {}
        Base::Base(long, const char *arg):field("safe") {}
        int main(){Derived d(getenv("USER"));return system(d.field);}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, label)
    }
  })

  it('does not execute a different base overload when the selected body is external', () => {
    const { sarif } = scan('external-base-overload', `#include <stdlib.h>
      const char *seen = "safe";
      struct Base {Base(long); Base(int){seen=getenv("USER");}};
      struct Derived:Base {Derived():Base(0L){}};
      int main(){Derived d;return system(seen);}`, true)
    assert.strictEqual(sarif.runs[0].results.length, 0)
  })

  it('runs base initialization before the derived constructor body', () => {
    for (const [name, body, expected] of [['inherit', '', true], ['replace', 'v="safe";', false]] as const) {
      const { sarif } = scan('base-order-' + name, `#include <stdlib.h>
        struct B {const char *v; B(){v=getenv("USER");}};
        struct D:B {D(){${body}}};
        int main(){D d;return system(d.v);}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
  })

  it('keeps constructor writes tied to the selected object and argument', () => {
    const { sarif } = scan('base-receiver', `#include <stdlib.h>
      struct B {const char *v; B(const char *p):v(p){}};
      struct D:B {D(const char *unused,const char *p):B(p){}};
      int main(){D safe(getenv("USER"),"safe"); D other("safe",getenv("USER"));return system(safe.v);}`, true)
    assert.strictEqual(sarif.runs[0].results.length, 0)
  })

  it('writes through an indexed reference to the selected receiver and element', () => {
    for (const [name, read, expected] of [
      ['same', 'a[1]', true], ['other-index', 'a[0]', false], ['other-object', 'b[1]', false],
      ['direct', 'a.items[1]', true], ['index-once', 'seen', true],
    ] as const) {
      const { sarif, graph } = scan('indexed-ref-' + name, `#include <stdlib.h>
        struct Box {char *items[2]; char *&operator[](int i);};
        char *&Box::operator[](int i){return items[i];}
        char *flag, *seen; int next(){seen=flag;flag=(char*)"safe";return 1;}
        int main(){Box a,b; a.items[0]=(char*)"safe"; b.items[1]=(char*)"safe";
          flag=getenv("USER"); a[next()]=getenv("USER");return system(${read});}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
      const pairs = Object.values<any>(graph.edges).map(edge =>
        [graph.nodes[edge.sourceNodeId].funcDef?.name, graph.nodes[edge.targetNodeId].funcDef?.name])
      assert.ok(pairs.some(([from, to]) => from === 'main' && to === 'operator[]'), JSON.stringify(pairs))
    }
  })

  it('uses the backing field of the overload selected by Clang', () => {
    for (const [name, expression, expected] of [
      ['direct-control', 'b.b[0]', false], ['direct-b', 'b.b[0]', false], ['int', 'b[0]', true], ['long', 'b[0L]', false],
    ] as const) {
      const { sarif } = scan('indexed-overload-' + name, `#include <stdlib.h>
        struct Box {char *a[1], *b[1]; char *&operator[](int i){return a[i];}
          char *&operator[](long i){return b[i];}};
        int main(){Box b; b.a[0]=(char*)"safe"; b.b[0]=(char*)"safe";
          ${name === 'direct-control' ? 'b.a[0]' : 'b[0]'}=getenv("USER"); return system(${expression});}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, expected, name)
    }
  })

  it('writes a compound result back after evaluating its right operand', () => {
    for (const [op, index] of [['+=', 0], ['+=', 1], ['|=', 0], ['|=', 1]] as const) {
      const { sarif } = scan('indexed-compound-' + op + index, `#include <stdlib.h>
        struct Box {long items[2]; long &operator[](int i){return items[i];}};
        int target=0; long input(){target=1;return (long)getenv("USER");}
        int main(){Box a; a.items[0]=0; a.items[1]=0;
          a[target]${op}input();return system((char*)a.items[${index}]);}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, index === 1)
    }
  })

  it('keeps the outer receiver when another subscript computes the index', () => {
    for (const name of ['a', 'b']) {
      const { sarif } = scan('indexed-nested-' + name, `#include <stdlib.h>
        struct Box {char *items[2]; char *&operator[](int i){return items[i];}};
        int main(){Box a,b; a.items[1]=(char*)"safe"; b.items[1]=(char*)"safe"; b.items[0]=nullptr;
          a[b[0] ? 0 : 1]=getenv("USER"); return system(${name}.items[1]);}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, name === 'a', name)
    }
  })

  it('writes through a void pointer view to its original backing array', () => {
    for (const index of [0, 1]) {
      const { sarif } = scan('indexed-view-' + index, `#include <stdlib.h>
        struct View {void *data; char *&operator[](unsigned i){return ((char**)data)[i];}};
        int main(){char *slots[2]={(char*)"safe",(char*)"safe"}; View view; view.data=slots;
          view[1]=getenv("USER");return system(slots[${index}]);}`, true)
      assert.strictEqual(sarif.runs[0].results.length > 0, index === 1)
    }
  })

  it('uses the override when calling through a base pointer', () => {
    const { sarif, graph } = scan('override', `#include <stdlib.h>
      struct B {virtual char *read()=0;}; struct D:B {char *read() override {return getenv("USER");}};
      int main(){D d;B *p=&d;return system(p->read());}`, true)
    assert.ok(sarif.runs[0].results.length)
    const pairs = Object.values<any>(graph.edges).map(edge =>
      [graph.nodes[edge.sourceNodeId].funcDef?.name, graph.nodes[edge.targetNodeId].funcDef?.name])
    assert.ok(pairs.some(([caller, target]) => caller === 'main' && target === 'read'))
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
