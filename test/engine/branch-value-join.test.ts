import * as assert from 'assert'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { BVTValue } from '../../src/engine/analyzer/common/value/bvt'
import { PrimitiveValue } from '../../src/engine/analyzer/common/value/primitive'
import { Scoped } from '../../src/engine/analyzer/common/value/scoped'
import { ValueRef } from '../../src/engine/analyzer/common/value/value-ref'

const MemState = require('../../src/engine/analyzer/common/memState')
const Analyzer = require('../../src/engine/analyzer/common/analyzer')
const SymbolTable = require('../../src/engine/analyzer/common/symbol-table-manager')
const registry = require('../../src/util/global-registry')

function scope(name: string): Scoped {
  return new Scoped('', { sid: name, qid: name, parent: null })
}

function literal(value: number): PrimitiveValue {
  return new PrimitiveValue('', String(value), value)
}

function alternatives(value: any): number[] {
  if (value.vtype === 'primitive') return [value.value]
  const items = value.vtype === 'BVT' ? Object.values(value.children) : value.value
  if (!Array.isArray(items)) return []
  return items.flatMap(alternatives).sort((a: number, b: number) => a - b)
}

describe('member receiver lookup', () => {
  const MemSpace = require('../../src/engine/analyzer/common/memSpace')
  const { MemberExprValue } = require('../../src/engine/analyzer/common/value/member-expr')
  const { IdentifierRefValue } = require('../../src/engine/analyzer/common/value/identifier-ref')
  const mem = new MemSpace()
  const id = (name: string) => ({ type: 'Identifier', name })
  const member = (object: any, name: string) => ({ type: 'MemberAccess', object, property: id(name) })
  let previousTable: any
  beforeEach(() => {
    previousTable = registry.getGlobalSymbolTable()
    registry.setGlobalSymbolTable(new SymbolTable())
  })
  afterEach(() => registry.setGlobalSymbolTable(previousTable))

  it('uses an already evaluated symbolic receiver for both reads and writes', () => {
    const key = new IdentifierRefValue('', 'key', null, null)
    const receiver = new MemberExprValue('', null, key, false, null, null)
    receiver.object = receiver
    const address = member(receiver, 'answer')
    const expected = literal(41)
    receiver.value.answer = expected
    assert.strictEqual(mem.getMemberValue(receiver, address, {}), expected)
    const updated = literal(42)
    mem.saveVarInScopeRec(receiver, address, updated, {})
    assert.strictEqual(mem.getMemberValue(receiver, address, {}), updated)
  })

  it('skips a cyclic alternative and writes through the surviving union receiver', () => {
    const root = scope('root')
    const target = scope('target')
    root.value.good = target
    const cycle = member(null, 'loop')
    cycle.object = cycle
    assert.strictEqual(mem.getMemberValue(root, cycle, {}).vtype, 'undefine')
    const choices = { vtype: 'union', qid: 'choices', value: [cycle, id('good')] }
    const rhs = literal(7)
    mem.saveVarInScopeRec(root, member(choices, 'answer'), rhs, {})
    assert.strictEqual(target.value.answer, rhs)
    const result = mem.getMemberValue(root, member(choices, 'answer'), {})
    assert.strictEqual(result, rhs)
  })

  it('resolves every component of a receiver path deeper than the JavaScript stack', () => {
    const root = scope('root')
    const box = scope('box')
    root.value.start = box
    box.value.next = box
    box.value.end = literal(123)
    let path: any = id('start')
    for (let i = 0; i < 16000; i++) path = member(path, 'next')
    assert.strictEqual(mem.getMemberValueNoCreate(root, member(path, 'end'), {}), box.value.end)
  })
})

describe('branch termination and metadata', () => {
  const analyzer = Object.create(Analyzer.prototype)
  const condition = { type: 'Identifier', name: 'cond' }

  it('records a cloned, negated condition after a terminating single branch', () => {
    for (const type of ['ReturnStatement', 'ThrowStatement']) {
      const state = { pcond: [], binfo: {} }
      const node = { consequent: { type: 'BlockStatement', body: [{ type }] } }
      analyzer.postBranchProcessing(node, condition, state, { binfo: { left: 1 } })

      assert.deepStrictEqual(state.pcond, [{ ...condition, is_neg: true }])
      assert.deepStrictEqual(condition, { type: 'Identifier', name: 'cond' })
      assert.deepStrictEqual(state.binfo, {})
    }
  })

  it('preserves earlier keys and copies missing metadata in left-to-right order', () => {
    const state = { pcond: [], binfo: { existing: 0 } }
    analyzer.postBranchProcessing({ consequent: { type: 'Noop' } }, condition, state,
      { binfo: { existing: 1, shared: 'left' } }, { binfo: { shared: 'right', extra: 2 } })
    assert.deepStrictEqual(state, { pcond: [], binfo: { existing: 0, shared: 'left', extra: 2 } })
  })

  it('treats revert separately from return and throw when copying branch metadata', () => {
    const cases = [
      { statement: { type: 'ReturnStatement' }, expected: {} },
      { statement: { type: 'ThrowStatement' }, expected: {} },
      { statement: { type: 'FunctionCall', expression: { name: 'revert' } }, expected: { left: 1 } },
      { statement: { type: 'FunctionCall', expression: { name: 'other' } }, expected: { left: 1, right: 2 } },
    ]
    for (const { statement, expected } of cases) {
      const state = { pcond: [], binfo: {} }
      analyzer.postBranchProcessing({ consequent: { type: 'BlockStatement', body: [statement] } },
        condition, state, { binfo: { left: 1 } }, { binfo: { right: 2 } })
      assert.deepStrictEqual(state, { pcond: [], binfo: expected })
    }
  })

  it('skips the branch body when neither branch contributes a new key', () => {
    let bodyReads = 0
    const consequent = {
      get body() {
        bodyReads++
        return []
      },
    }
    const state = { pcond: [], binfo: { existing: 0 } }
    analyzer.postBranchProcessing({ consequent }, condition, state, { binfo: {} }, { binfo: { existing: 1 } })
    assert.strictEqual(bodyReads, 0)
    assert.deepStrictEqual(state, { pcond: [], binfo: { existing: 0 } })
  })

  it('follows branch-value children and symbol fields in cyclic branch snapshots', () => {
    const snapshot: any = { _field: { previous: 'symuuid_previous' } }
    snapshot.aliases = [snapshot, snapshot]
    const terminator = { type: 'ThrowStatement' }
    const previousTable = registry.getGlobalSymbolTable()
    registry.setGlobalSymbolTable(new Map([['symuuid_previous', { vtype: 'BVT', children: { nested: terminator } }]]))
    try {
      const state = { pcond: [], binfo: {} }
      const consequent = { type: 'CBranch', body: [], results: [snapshot] }
      analyzer.postBranchProcessing({ consequent }, condition, state, { binfo: { left: 1 } })
      assert.deepStrictEqual(state, { pcond: [{ ...condition, is_neg: true }], binfo: {} })
    } finally {
      registry.setGlobalSymbolTable(previousTable)
    }
  })

  it('indexes source exits in nested C branches before interpreter state is attached', () => {
    const { CTypeIndex } = require('../../src/engine/analyzer/c/common/c-types')
    const index = new CTypeIndex()
    const plain = { type: 'ScopedStatement', body: [] }
    const returns = { type: 'ReturnStatement' }
    const nested = { type: 'IfStatement', test: condition, consequent: plain, alternative: returns }
    index.annotate({ body: [{ type: 'IfStatement', test: condition, consequent: nested }] })
    assert.strictEqual(index.branchExits.get(nested), true)
    assert.strictEqual(index.branchExits.get(plain), false)
  })

  it('uses the C branch body to decide termination even when its scope snapshot contains a return', () => {
    const CAnalyzer = require('../../src/engine/analyzer/c/common/c-analyzer')
    const c = Object.create(CAnalyzer.prototype)
    const results = [{ before: { previous: { type: 'ReturnStatement' } } }]
    for (const returns of [false, true]) {
      const body = { type: 'ScopedStatement', body: returns ? [{ type: 'ReturnStatement' }] : [] }
      const state = { pcond: [], binfo: {} }
      c.postBranchProcessing({ consequent: { type: 'CBranch', body, results } },
        condition, state, { binfo: { left: 1 } })
      assert.strictEqual(state.pcond.length, returns ? 1 : 0)
      assert.deepStrictEqual(state.binfo, returns ? {} : { left: 1 })
    }
  })
})

describe('BVT branch joins', () => {
  let previousTable: any
  const initialState = { brs: '', br_index: 0, pcond: [] }

  beforeEach(() => {
    previousTable = registry.getGlobalSymbolTable()
    registry.setGlobalSymbolTable(new SymbolTable())
  })

  afterEach(() => registry.setGlobalSymbolTable(previousTable))

  it('retains the incoming value when only the right branch writes through an alias', () => {
    const root = scope('function')
    const target = scope('target')
    root.value.first = target
    root.value.second = target
    target.value.callback = literal(1)
    const branches = MemState.forkStates(initialState)
    const alias = root.value.second
    MemState.writeValue(alias.value, 'callback', literal(2), branches[1], alias)
    MemState.unionValues([root, root], branches, initialState.brs)

    assert.strictEqual(root.value.first, alias)
    assert.strictEqual(root.value.first.value.callback.vtype, 'union')
    assert.deepStrictEqual(alternatives(root.value.first.value.callback), [1, 2])
  })

  it('keeps inner alternatives through the enclosing join', () => {
    const root = scope('function')
    const outer = MemState.forkStates(initialState)
    const inner = MemState.forkStates(outer[0])
    MemState.writeValue(root.value, 'callback', literal(1), inner[0], root)
    MemState.writeValue(root.value, 'callback', literal(2), inner[1], root)
    assert.strictEqual(MemState.loadForkedValue(root.value.callback, inner[0]).value, 1)
    assert.strictEqual(MemState.loadForkedValue(root.value.callback, inner[1]).value, 2)
    MemState.unionValues([root, root], inner, outer[0].brs)
    MemState.writeValue(root.value, 'callback', literal(3), outer[1], root)
    MemState.unionValues([root, root], outer, initialState.brs)

    assert.deepStrictEqual(alternatives(root.value.callback), [1, 2, 3])
  })

  it('folds a branch tree installed directly in a reachable child', () => {
    const root = scope('function')
    const child = scope('nested')
    root.value.child = child
    const branches = MemState.forkStates(initialState)
    child.value.callback = new BVTValue('', 'callback', { L: literal(1), R: literal(2) })
    MemState.unionValues([root, root], branches, initialState.brs)

    assert.strictEqual(child.value.callback.vtype, 'union')
    assert.deepStrictEqual(alternatives(child.value.callback), [1, 2])
  })

  it('reads later slots live when an earlier symbol lookup changes a large scope', () => {
    const root = scope('large')
    const bindings = Array.from({ length: 72 }, (_, i) => literal(i))
    bindings.forEach((value, i) => { root.value['k' + i] = value })
    const branches = MemState.forkStates(initialState)
    const callback = new BVTValue('', 'branch', { L: bindings[1], R: bindings[2] })
    const symbols = registry.getGlobalSymbolTable()
    const get = symbols.get.bind(symbols)
    let changed = false
    symbols.get = (id: string) => {
      if (!changed && id === bindings[4].uuid) {
        changed = true
        root.value.k60 = callback
        delete root.value.k61
        root.value.appended = callback
      }
      return get(id)
    }

    MemState.unionValues([root, root], branches, initialState.brs)
    assert.ok(changed)
    assert.deepStrictEqual(alternatives(root.value.k60), [1, 2])
    assert.strictEqual(root.value.k61, undefined)
    assert.strictEqual(root.value.appended, callback)
  })

  it('preserves exposed references on the other side of a copy-on-write join', () => {
    const root = scope('large')
    const bindings = Array.from({ length: 72 }, (_, i) => literal(i))
    bindings.forEach((value, i) => { root.value['k' + i] = value })
    const branches = MemState.forkStates(initialState)
    MemState.unionValues([root, root], branches, initialState.brs)

    const copy = root.clone()
    const raw = { ...copy.members }._map
    assert.strictEqual(raw, copy.members._map)
    const ref = raw.get('k42')!
    MemState.unionValues([root, root], branches, initialState.brs)
    ref._direct = bindings[0]
    assert.strictEqual(copy.value.k42, bindings[0])
    assert.strictEqual(root.value.k42, bindings[42])
  })

  it('folds an outer branch tree when neither inner branch writes', () => {
    const root = scope('function')
    root.value.callback = literal(1)
    const outer = MemState.forkStates(initialState)
    MemState.writeValue(root.value, 'callback', literal(2), outer[0], root)
    assert.strictEqual(root.value.callback.vtype, 'BVT')

    const inner = MemState.forkStates(outer[0])
    MemState.unionValues([root, root], inner, outer[0].brs)
    assert.strictEqual(root.value.callback.vtype, 'union')
    assert.deepStrictEqual(alternatives(root.value.callback), [1, 2])
  })

  it('detaches the previous field reference when two consecutive joins rebind the same value', () => {
    const root = scope('function')
    const original = literal(1)
    root.value.callback = original
    MemState.unionValues([root, root], MemState.forkStates(initialState), initialState.brs)
    const previousRef = root.members._map.get('callback')!
    MemState.unionValues([root, root], MemState.forkStates(initialState), initialState.brs)
    previousRef._direct = literal(2)

    assert.strictEqual(root.value.callback, original)
  })

  it('visits replacement fields on later joins even when the field count stays the same', () => {
    const root = scope('function')
    root.value.removed = literal(10)
    MemState.unionValues([root, root], MemState.forkStates(initialState), initialState.brs)
    const copy = root.clone()
    delete root.value.removed
    const branches = MemState.forkStates(initialState)
    MemState.writeValue(root.value, 'added', literal(3), branches[0], root)
    MemState.writeValue(root.value, 'added', literal(4), branches[1], root)
    MemState.unionValues([root, root], branches, initialState.brs)

    assert.strictEqual(root.value.removed, undefined)
    assert.strictEqual(root.value.added.vtype, 'union')
    assert.deepStrictEqual(alternatives(root.value.added), [3, 4])
    MemState.unionValues([copy, copy], MemState.forkStates(initialState), initialState.brs)
    assert.strictEqual(copy.value.removed.value, 10)
    assert.strictEqual(copy.value.added, undefined)
  })

  it('includes inherited enumerable fields of a customized field map', () => {
    const root = scope('function')
    Object.setPrototypeOf(root.value, {
      inherited: new BVTValue('', 'inherited', { L: literal(1), R: literal(3) }),
    })
    const branches = MemState.forkStates(initialState)
    MemState.unionValues([root, root], branches, initialState.brs)

    assert.strictEqual(root.value.inherited.vtype, 'union')
    assert.deepStrictEqual(alternatives(root.value.inherited), [1, 3])
  })

  it('resolves a direct reference during enumeration and again when reading the field', () => {
    const root = scope('function')
    const first = literal(1)
    const second = literal(2)
    const ref = new ValueRef('', first)
    let reads = 0
    ref.resolve = () => ++reads === 1 ? first : second
    root.value.callback = ref
    MemState.unionValues([root, root], MemState.forkStates(initialState), initialState.brs)

    assert.strictEqual(reads, 2)
    assert.strictEqual(root.value.callback, second)
  })

  it('joins plain scopes without invoking an unrelated members getter', () => {
    const root = {
      vtype: 'scope',
      value: { callback: new BVTValue('', 'callback', { L: literal(1), R: literal(2) }) },
      get members() { throw new Error('unexpected read of members') },
    }
    MemState.unionValues([root, root], MemState.forkStates(initialState), initialState.brs)

    assert.strictEqual(root.value.callback.vtype, 'union')
  })

  it('refreshes a field binding when its value changes identity in place', () => {
    const root = scope('function')
    const value = literal(1)
    root.value.callback = value
    const branches = MemState.forkStates(initialState)
    value.qid = 'new-identity'
    MemState.unionValues([root, root], branches, initialState.brs)

    const stored = Object.getOwnPropertyDescriptor(root.value, 'callback')!.value
    assert.strictEqual(stored, registry.getGlobalSymbolTable().calculateUUID(value))
    assert.strictEqual(root.value.callback, value)
  })
})

describe('C call-graph namespace joins', () => {
  const { beginCNamespaceJoins, canSkipGlobalJoin, endCNamespaceJoins } =
    require('../../src/engine/analyzer/common/global-branch-watch')
  const Config = require('../../src/config')
  const state = { brs: '', br_index: 0, pcond: [] }
  let root: Scoped
  let local: Scoped
  let oldTable: any
  let previousMode: boolean

  function join(): void {
    MemState.unionValues([local, local], MemState.forkStates(state), '')
  }

  beforeEach(() => {
    oldTable = registry.getGlobalSymbolTable()
    previousMode = Config.makeAllCG
    registry.setGlobalSymbolTable(new SymbolTable())
    Config.makeAllCG = true
    root = scope('namespace')
    local = scope('local')
    local.parent = root
    root._hasBVTFields = true
    beginCNamespaceJoins(root)
  })

  afterEach(() => {
    endCNamespaceJoins(root)
    registry.setGlobalSymbolTable(oldTable)
    Config.makeAllCG = previousMode
  })

  it('folds an indirectly installed callback tree in an already observed global object', () => {
    const box = scope('box')
    root.value.box = box
    assert.ok(canSkipGlobalJoin(root, new Set()))
    const tree = new BVTValue('', 'restored', { L: literal(1), R: literal(2) })
    box.value.callback = tree.uuid
    join()
    assert.deepStrictEqual(alternatives(box.value.callback), [1, 2])
  })

  it('keeps observing aliased fields across file scopes and the global scope', () => {
    const left = scope('left.c')
    const right = scope('right.c')
    const box = scope('shared')
    for (const file of [left, right]) {
      ;(file as any).isCModule = true
      file.parent = root
      file._hasBVTFields = true
      file.value.box = box
    }
    root.value.box = box
    local.parent = left
    for (const namespace of [left, root, right]) assert.ok(canSkipGlobalJoin(namespace, new Set()))
    right.value.box.value.callback = new BVTValue('', 'aliased callback', { L: literal(1), R: literal(2) })
    right.value.private = new BVTValue('', 'private callback', { L: literal(3), R: literal(4) })
    join()
    assert.deepStrictEqual(alternatives(left.value.box.value.callback), [1, 2])
    assert.strictEqual(right.value.private.vtype, 'BVT')
    local.parent = right
    join()
    assert.deepStrictEqual(alternatives(right.value.private), [3, 4])
  })

  it('skips a pending slot behind a visited frame until a second path exposes it', () => {
    const frame = scope('frame')
    const inner = scope('inner')
    root.value.frame = frame
    frame.value.inner = inner
    assert.ok(canSkipGlobalJoin(root, new Set()))
    inner.value.work = new BVTValue('', 'work', { L: literal(1), R: literal(2) })
    assert.strictEqual(canSkipGlobalJoin(root, new Set([frame])), true)
    root.value.alsoInner = inner
    assert.strictEqual(canSkipGlobalJoin(root, new Set([frame])), false)
    join()
    assert.deepStrictEqual(alternatives(inner.value.work), [1, 2])
  })

  it('ignores writes to detached maps and inventories their fields when reattached', () => {
    const frame = scope('old frame')
    root.value.frame = frame
    assert.ok(canSkipGlobalJoin(root, new Set()))
    delete root.value.frame
    frame.parent = scope('other parent')
    join()
    assert.ok(canSkipGlobalJoin(root, new Set()))
    const box = scope('new box')
    frame.value.box = box
    box.value.callback = new BVTValue('', 'late callback', { L: literal(3), R: literal(4) })
    assert.ok(canSkipGlobalJoin(root, new Set()))
    root.value.frame = frame
    join()
    assert.deepStrictEqual(alternatives(box.value.callback), [3, 4])
  })

  it('uses the dense join when a reentrant pass takes over shared mutation hooks', () => {
    const other = scope('other global')
    const box = scope('shared box')
    root.value.box = other.value.box = box
    assert.ok(canSkipGlobalJoin(root, new Set()))
    beginCNamespaceJoins(other)
    try {
      assert.ok(canSkipGlobalJoin(other, new Set()))
      box.value.work = new BVTValue('', 'overlapping passes', { L: literal(1), R: literal(2) })
      assert.strictEqual(canSkipGlobalJoin(root, new Set()), false)
      join()
      assert.deepStrictEqual(alternatives(box.value.work), [1, 2])
    } finally {
      endCNamespaceJoins(other)
    }
  })

  it('starts following a lexical parent when its first branch write activates it', () => {
    const closure = scope('closure')
    const module = scope('module')
    closure.parent = module
    root.value.closure = closure
    module.value.callback = new BVTValue('', 'callback', { L: literal(1), R: literal(2) })
    assert.ok(canSkipGlobalJoin(root, new Set()))

    const branches = MemState.forkStates(state)
    MemState.writeValue(module.value, 'mode', literal(3), branches[0], module)
    MemState.unionValues([local, local], branches, '')
    assert.strictEqual(module.value.callback.vtype, 'union')
    assert.deepStrictEqual(alternatives(module.value.callback), [1, 2])
  })

  it('handles a newly attached parent and a canonical replacement under an existing UUID', () => {
    const box = scope('box')
    root.value.box = box
    assert.ok(canSkipGlobalJoin(root, new Set()))
    const holder = scope('holder')
    holder._hasBVTFields = true
    holder.value.callback = new BVTValue('', 'direct', { L: literal(3), R: literal(4) })
    box.parent = holder
    join()
    assert.deepStrictEqual(alternatives(holder.value.callback), [3, 4])

    const replacement = scope('box')
    replacement.value.callback = new BVTValue('', 'replacement', { L: literal(5), R: literal(6) })
    join()
    assert.strictEqual(root.value.box, replacement)
    assert.deepStrictEqual(alternatives(replacement.value.callback), [5, 6])
  })

  it('refreshes a value renamed before the namespace was first inspected', () => {
    const value = literal(7)
    root.value.stored = value
    value.qid = 'renamed-before-observation'
    join()
    assert.strictEqual(Object.getOwnPropertyDescriptor(root.value, 'stored')!.value,
      registry.getGlobalSymbolTable().calculateUUID(value))
  })

  it('rebinds changed identities and retains dense semantics after a raw map escapes', () => {
    const value = literal(1)
    root.value.callback = value
    assert.ok(canSkipGlobalJoin(root, new Set()))
    value.qid = 'changed'
    join()
    const table = registry.getGlobalSymbolTable()
    assert.strictEqual(Object.getOwnPropertyDescriptor(root.value, 'callback')!.value, table.calculateUUID(value))
    const previous = root.members._map.get('callback')!
    assert.strictEqual(canSkipGlobalJoin(root, new Set()), false)
    join()
    previous._direct = literal(2)
    assert.strictEqual(root.value.callback, value)
  })
})

describe('symbolic addresses', () => {
  const { toStringID } = require('../../src/engine/analyzer/common/sym-address')

  it('renders deep mutable branch keys without truncating the traversal', () => {
    const leaf = { type: 'Literal', value: 'left' }
    let current: any = leaf
    for (let i = 0; i < 16000; i++) current = { vtype: 'BVT', children: { L: current } }
    const root = { type: 'BinaryExpression', operator: '+', left: current, right: leaf }
    const branch = ',}'.repeat(50)
    assert.strictEqual(toStringID(root), (branch + '+left').slice(-100))
    leaf.value = 'right'
    assert.strictEqual(toStringID(root), (branch + '+right').slice(-100))
  })

  it('retains cycle markers and shared unresolved operands in visit order', () => {
    const missing = { vtype: 'uninitialized' }
    const branch: any = { vtype: 'BVT', children: { L: missing } }
    const union = { vtype: 'union', value: [branch, missing, branch] }
    branch.children.R = union
    assert.strictEqual(toStringID(union), '{bvt{undefined,__,}|__|bvt{undefined,__,}|}')
    branch.children.L = { type: 'Literal', value: 0 }
    assert.strictEqual(toStringID(union), '{bvt{0,__,}|undefined|bvt{0,__,}|}')
  })
})
