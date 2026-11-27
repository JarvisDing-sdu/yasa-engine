import { strict as assert } from 'assert'
import { createHash } from 'crypto'
import { describe, it } from 'mocha'

const SymbolTableManager = require('../src/engine/analyzer/common/symbol-table-manager')
const ASTManager = require('../src/engine/analyzer/common/ast-manager')
const { AstBinding } = require('../src/engine/analyzer/common/value/ast-binding')

class TestUnit {
  qid = 'fn'
  ast = { node: { _meta: { nodehash: 'node1' } } }
}

function expectedUUID(input: string): string {
  return 'symuuid_' + createHash('md5').update(input).digest('hex')
}

describe('SymbolTableManager UUID cache', () => {
  it('keeps indexed member reads live across collisions, table switches and raw map edits', () => {
    const first = new SymbolTableManager()
    const second = new SymbolTableManager()
    const original = new TestUnit()
    const replacement = new TestUnit()
    const uuid = first.register(original)
    const positions: any[] = []
    const read = (table: any) => table.getAtPosition(uuid, positions, 0)
    assert.equal(read(first), original)
    first.register(replacement)
    assert.equal(read(first), replacement)
    second.register(original)
    assert.equal(read(second), original)
    assert.equal(read(first), replacement)
    first.delete(uuid)
    assert.equal(read(first), null)
    first.register(original)
    assert.equal(read(first), original)
    first.clear()
    assert.equal(read(first), null)
    first.register(original)
    assert.equal(read(first), original)
    const map = first.getMap()
    map.set(uuid, replacement)
    assert.equal(read(first), replacement)
    map.delete(uuid)
    assert.equal(read(first), null)
  })

  it('uses the current node, constructor and qid and keeps clone suffixes independent', () => {
    const symbols = new SymbolTableManager()
    const unit = new TestUnit()
    const original = symbols.register(unit)
    assert.equal(original, expectedUUID('node1_TestUnit_fn'))
    assert.equal(symbols.calculateUUID(unit, '_clone'), expectedUUID('node1_TestUnit_fn_clone'))
    assert.equal(symbols.calculateUUID(unit), original)

    unit.qid = 'callback'
    assert.equal(symbols.register(unit), expectedUUID('node1_TestUnit_callback'))
    unit.ast.node._meta.nodehash = 'node2'
    assert.equal(symbols.register(unit), expectedUUID('node2_TestUnit_callback'))
    class OtherUnit extends TestUnit {}
    Object.setPrototypeOf(unit, OtherUnit.prototype)
    assert.equal(symbols.register(unit), expectedUUID('node2_OtherUnit_callback'))
  })

  it('uses the current string representation of non-string fields on every call', () => {
    const symbols = new SymbolTableManager()
    let label = 'first'
    const unit = { qid: { toString: () => label } }
    assert.equal(symbols.calculateUUID(unit), expectedUUID('_Object_first'))
    label = 'second'
    assert.equal(symbols.calculateUUID(unit), expectedUUID('_Object_second'))
    assert.equal(symbols.calculateUUID(unit, '_clone'), expectedUUID('_Object_second_clone'))
  })

  it('registers again on a cache hit after a collision, reset, or switch to a different table', () => {
    const first = new SymbolTableManager()
    const second = new SymbolTableManager()
    const unit = new TestUnit()
    const replacement = new TestUnit()
    const id = first.register(unit)

    assert.equal(first.register(replacement), id)
    assert.equal(first.get(id), replacement)
    assert.equal(first.register(unit), id)
    assert.equal(first.get(id), unit)
    first.clear()
    second.register(unit)
    assert.equal(first.get(id), null)
    assert.equal(second.get(id), unit)
    first.register(replacement)
    assert.equal(first.get(id), replacement)
    assert.equal(second.get(id), unit)
  })

  it('restores a cached binding after direct edits through an exposed Map', () => {
    const symbols = new SymbolTableManager()
    const unit = new TestUnit()
    const replacement = new TestUnit()
    const id = symbols.register(unit)
    const map = symbols.getMap()
    map.set(id, replacement)
    assert.equal(symbols.register(unit), id)
    assert.equal(map.get(id), unit)
    map.delete(id)
    symbols.register(unit)
    assert.equal(map.get(id), unit)
  })

  it('restores a registration overwritten inside the uuid setter', () => {
    const symbols = new SymbolTableManager()
    const unit = new TestUnit()
    const replacement = new TestUnit()
    let reenter = false
    Object.defineProperty(unit, 'uuid', {
      set() {
        if (reenter) {
          symbols.clear()
          symbols.register(replacement)
        }
      },
    })
    const id = symbols.register(unit)
    reenter = true
    symbols.register(unit)
    assert.equal(symbols.get(id), unit)
    symbols.register(replacement)
    assert.equal(symbols.get(id), replacement)
  })

  it('signals actual binding changes and exposes raw map edits to indexed readers', () => {
    const symbols = new SymbolTableManager()
    const original = new TestUnit()
    const replacement = new TestUnit()
    const changes: (string | null)[] = []
    const unsubscribe = symbols.observeBindingChanges((id: string | null) => changes.push(id))
    assert.equal(symbols.canObserveStableBindings(), true)
    const id = symbols.register(original)
    symbols.register(original)
    symbols.register(replacement)
    symbols.delete(id)
    symbols.delete(id)
    symbols.clear()
    assert.deepEqual(changes, [id, id, id, null])
    symbols.register(original)
    const positions: any[] = []
    assert.equal(symbols.getAtPosition(id, positions, 0), original)
    const raw = symbols.symbolMap
    assert.equal(symbols.canObserveStableBindings(), false)
    raw.set(id, replacement)
    assert.equal(symbols.getAtPosition(id, positions, 0), replacement)
    assert.deepEqual(changes, [id, id, id, null, id, null])
    unsubscribe()
    symbols.register(original)
    assert.equal(changes.length, 6)
  })

  it('disables binding observation for restored backing maps and customized registry operations', () => {
    const symbols = new SymbolTableManager()
    for (const key of ['get', 'getAtPosition', 'register', 'calculateUUID', 'uuidEntry', 'delete', 'clear', 'getMap']) {
      symbols[key] = () => null
      assert.equal(symbols.canObserveStableBindings(), false)
      delete symbols[key]
      assert.equal(symbols.canObserveStableBindings(), true)
    }
    const changes: (string | null)[] = []
    symbols.observeBindingChanges((id: string | null) => changes.push(id))
    const restored = new Map()
    Object.assign(symbols, { symbolMap: restored })
    assert.deepEqual(changes, [null])
    assert.equal(symbols.canObserveStableBindings(), false)
    const unit = new TestUnit()
    const id = symbols.register(unit)
    assert.equal(restored.get(id), unit)
  })
})

describe('AST bindings used for symbol identity', () => {
  it('keeps the identity revision across same-hash replacements and advances it on effective identity changes', () => {
    const manager = new ASTManager()
    const original = { _meta: { nodehash: 'fn' } }
    const replacement = { _meta: { nodehash: 'fn' } }
    manager.register(original)
    const initial = manager.bindingIdentityRevision()
    const initialBinding = manager.bindingRevision()
    manager.register(replacement)
    assert.equal(manager.bindingIdentityRevision(), initial)
    assert.ok(manager.bindingRevision() > initialBinding)

    replacement._meta.nodehash = 'moved'
    manager.register(original)
    let revision = manager.bindingIdentityRevision()
    assert.ok(revision > initial)
    manager.delete('fn')
    assert.ok(manager.bindingIdentityRevision() > revision)
    revision = manager.bindingIdentityRevision()
    manager.register(original)
    assert.ok(manager.bindingIdentityRevision() > revision)
    revision = manager.bindingIdentityRevision()
    manager.clear()
    assert.ok(manager.bindingIdentityRevision() > revision)
    revision = manager.bindingIdentityRevision()
    manager.getMap()
    assert.ok(manager.bindingIdentityRevision() > revision)
  })

  it('invalidates observed AST bindings on replacement, deletion, restoration, clear and map exposure', () => {
    const manager = new ASTManager()
    const original = { _meta: { nodehash: 'fn' } }
    const replacement = { _meta: { nodehash: 'fn' } }
    let revision = manager.bindingRevision()
    manager.register(original)
    manager.register(original)
    assert.equal(manager.bindingRevision(), revision)
    manager.register(replacement)
    assert.ok(manager.bindingRevision() > revision)
    revision = manager.bindingRevision()
    manager.delete('missing')
    assert.equal(manager.bindingRevision(), revision)
    manager.delete('fn')
    assert.ok(manager.bindingRevision() > revision)
    revision = manager.bindingRevision()
    manager.register(original)
    assert.ok(manager.bindingRevision() > revision)
    revision = manager.bindingRevision()
    manager.clear()
    assert.ok(manager.bindingRevision() > revision)
    assert.equal(manager.canObserveStableBindings(), true)
    for (const key of ['get', 'getBindingNode', 'register', 'has', 'delete', 'clear', 'getMap']) {
      manager[key] = () => null
      assert.equal(manager.canObserveStableBindings(), false)
      delete manager[key]
    }
    assert.equal(manager.canObserveStableBindings(), true)
    const raw = manager.astMap
    assert.equal(manager.canObserveStableBindings(), false)
    raw.set('fn', replacement)
    assert.equal(manager.get('fn'), replacement)
  })

  it('reflects replacements, removals, manager switches and mutations of an exposed map', () => {
    const first = new ASTManager()
    const second = new ASTManager()
    let manager = first
    const binding = new AstBinding({ getASTManager: () => manager })
    const original = { _meta: { nodehash: 'definition' } }
    const replacement = { _meta: { nodehash: 'definition' } }
    binding.node = original
    assert.equal(binding.node, original)
    first.register(replacement)
    assert.equal(binding.node, replacement)
    first.delete('definition')
    assert.equal(binding.node, null)
    first.register(original)
    assert.equal(binding.node, original)
    first.clear()
    assert.equal(binding.node, null)

    manager = second
    second.register(replacement)
    assert.equal(binding.node, replacement)
    const raw = second.getMap()
    raw.set('definition', original)
    assert.equal(binding.node, original)
    raw.clear()
    assert.equal(binding.node, null)
    second.register(replacement)
    assert.equal(raw.get('definition'), replacement)
    assert.equal(binding.node, replacement)

    const restored = new Map([['definition', original]])
    Object.assign(second, { astMap: restored })
    assert.equal(binding.node, original)
    restored.delete('definition')
    assert.equal(binding.node, null)
  })
})
