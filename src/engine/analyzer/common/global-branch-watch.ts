import Unit = require('./value/unit')
import { EntityValue } from './value/entity-value'
import { ValueRefMap, type MergeBindingObserver } from './value/value-ref-map'
import { observeFirstBranchWrite, observeJoinIdentity } from './value/join-observer'
import { isAuditFastOff } from './value/unit-audit'

const Config = require('../../../config')
const { getGlobalSymbolTable, getGlobalASTManager } = require('../../../util/global-registry')

interface Watch {
  table: any
  ast: any
  astRevision?: number
  frontier: WeakSet<object>
  activatedParents: Set<object>
  seen: WeakSet<object>
  owners: WeakMap<ValueRefMap, Set<object>>
  incoming: Map<string, Set<object>>
  ids: WeakMap<object, Set<string>>
  bindingKinds: Map<string, string | undefined>
  changed: Set<string>
  pending: Map<ValueRefMap, Set<string>>
  stale: Map<ValueRefMap, Map<string, string>>
  observer: MergeBindingObserver
  dirtyIdentity: () => void
  rebuild: boolean
  inventories: number
  visits: number
  depth: number
  unsubscribe?: () => void
}

interface NamespaceSession {
  roots: Set<object>
  watch?: Watch
}

const sessions = new WeakMap<object, NamespaceSession>()
let activeObserver: MergeBindingObserver | undefined

function sessionFor(scope: any): NamespaceSession | undefined {
  return sessions.get(scope) ?? (scope?.isCModule ? sessions.get(scope.parent) : undefined)
}

// An inventory follows data, closures (including any active call frame), and
// lexical parents. If this costs more than the ordinary traversal can amortize,
// use the existing dense merge for the remainder of this pass.
const maxInventoryVisits = 32768
const maxInventories = 512
const unitSymbolTable = Unit.prototype.getSymbolTable
const unitASTManager = Unit.prototype.getASTManager

export function beginCNamespaceJoins(global: object): void {
  sessions.get(global)?.watch?.observer.invalidate()
  sessions.set(global, { roots: new Set() })
}

export function endCNamespaceJoins(global: object): void {
  sessions.get(global)?.watch?.observer.invalidate()
  sessions.delete(global)
}

function observe(watch: Watch, value: any): void {
  if (!watch.observer.active || !value || typeof value !== 'object' || watch.seen.has(value)) return
  if (watch.depth >= 128) {
    watch.observer.invalidate()
    return
  }
  watch.seen.add(value)
  watch.depth++
  try {
    observeValue(watch, value)
  } finally {
    watch.depth--
  }
}

// Keep old edges until the next inventory. Extra paths only force a dense
// join. Key by the UUID used by the reference; a Unit can still be resolved
// through an older UUID after a rename or a canonical-table replacement.
function recordIncoming(watch: Watch, uuid: string, value: object, owners: Iterable<object>): void {
  let parents = watch.incoming.get(uuid)
  if (!parents) watch.incoming.set(uuid, parents = new Set())
  for (const owner of owners) parents.add(owner)
  let ids = watch.ids.get(value)
  if (!ids) watch.ids.set(value, ids = new Set())
  ids.add(uuid)
}

function observeValue(watch: Watch, value: any): void {
  if (++watch.visits > maxInventoryVisits || !(value instanceof Unit) ||
      !Object.getOwnPropertyDescriptor(value, 'uuid')?.writable ||
      value.getSymbolTable !== unitSymbolTable || value.getASTManager !== unitASTManager ||
      Object.prototype.hasOwnProperty.call(value, 'qid') || Object.prototype.hasOwnProperty.call(value, 'ast') ||
      Object.prototype.hasOwnProperty.call(value, 'parent')) {
    watch.observer.invalidate()
    return
  }
  observeJoinIdentity(value, watch.dirtyIdentity)
  if (value.type || (value.vtype !== 'scope' && value.vtype !== 'object' && value.vtype !== 'fclos')) return
  if (!(value instanceof EntityValue) || Object.prototype.hasOwnProperty.call(value, 'members') ||
      Object.prototype.hasOwnProperty.call(value, 'value') || value.value !== value.members.getProxy()) {
    watch.observer.invalidate()
    return
  }
  let owners = watch.owners.get(value.members)
  if (!owners) watch.owners.set(value.members, owners = new Set())
  owners.add(value)
  if (!value.members.observeMergeBindings(watch.observer)) {
    watch.observer.invalidate()
    return
  }
  let child: any = value
  while (child._parentRef?.uuid) {
    const parent = child.parent
    if (parent) recordIncoming(watch, child._parentRef.uuid, parent, [child])
    watch.bindingKinds.set(child._parentRef.uuid, parent?.vtype)
    if (!parent || watch.seen.has(parent)) break
    if (parent._hasBVTFields) {
      observe(watch, parent)
      break
    }
    // The dense walk marks an unwritten parent as visited without inspecting
    // its fields. Watch its first branch write so the new edge becomes visible.
    if (watch.frontier.has(parent)) break
    watch.frontier.add(parent)
    observeFirstBranchWrite(parent, () => {
      if (watch.observer.active) watch.activatedParents.add(parent)
    })
    observeJoinIdentity(parent, watch.dirtyIdentity)
    child = parent
  }
}

function startWatch(table: any): Watch {
  // A reentrant pass can share Units with its caller. Their mutation hooks
  // accept one observer, so the older pass must use dense joins from here.
  activeObserver?.invalidate()
  const watch: Watch = {
    table,
    ast: getGlobalASTManager(),
    seen: new WeakSet(),
    frontier: new WeakSet(),
    activatedParents: new Set(),
    owners: new WeakMap(),
    incoming: new Map(),
    ids: new WeakMap(),
    bindingKinds: new Map(),
    changed: new Set(),
    pending: new Map(),
    stale: new Map(),
    inventories: 0,
    visits: 0,
    depth: 0,
    rebuild: false,
    dirtyIdentity() { watch.rebuild = true },
    observer: {
      active: true,
      bind(members, key, uuid, value, initial) {
        // Detached call frames may still hold this observer after a fresh
        // inventory. Reattaching a frame inventories all its bindings again.
        const owners = watch.owners.get(members)
        if (!owners) return
        const resolved = typeof value === 'string' ? watch.table.get(uuid) : value
        if (resolved instanceof EntityValue) recordIncoming(watch, uuid, resolved, owners)
        const stale = watch.stale.get(members)
        if (initial && resolved instanceof Unit && watch.table.calculateUUID(resolved) !== uuid) {
          const entries = stale ?? new Map()
          entries.set(key, uuid)
          if (!stale) watch.stale.set(members, entries)
        } else if (stale) {
          stale.delete(key)
          if (!stale.size) watch.stale.delete(members)
        }
        if (watch.bindingKinds.has(uuid) && watch.bindingKinds.get(uuid) !== resolved?.vtype) watch.rebuild = true
        watch.bindingKinds.set(uuid, resolved?.vtype)
        if (resolved?.vtype === 'BVT') {
          let keys = watch.pending.get(members)
          if (!keys) watch.pending.set(members, keys = new Set())
          keys.add(key)
        } else {
          observe(watch, resolved)
        }
      },
      invalidate() {
        this.active = false
        if (activeObserver === this) activeObserver = undefined
        watch.incoming.clear()
        watch.pending.clear()
        watch.stale.clear()
        watch.bindingKinds.clear()
        watch.changed.clear()
        watch.activatedParents.clear()
        watch.unsubscribe?.()
        watch.unsubscribe = undefined
        watch.table = undefined
        watch.ast = undefined
      },
    },
  }
  activeObserver = watch.observer
  watch.unsubscribe = table.observeBindingChanges((uuid: string | null) => {
    if (!uuid) watch.observer.invalidate()
    else if (watch.bindingKinds.has(uuid)) watch.changed.add(uuid)
  })
  watch.astRevision = watch.ast?.bindingIdentityRevision?.()
  return watch
}

// A file-scope join can encounter local frames already visited through the
// active call. Search backwards from the slot instead of rescanning thousands
// of unrelated definitions. An unknown or expensive path takes the dense join.
function outsideJoin(watch: Watch, members: ValueRefMap, visited: Set<any>, root: object): boolean {
  const owners = watch.owners.get(members)
  if (!owners) return false
  const seen = new Set(owners)
  for (const value of seen) {
    if (value === root) return false
    if (visited.has(value)) continue
    const ids = watch.ids.get(value)
    if (!ids) return false
    for (const uuid of ids) {
      for (const from of watch.incoming.get(uuid)!) {
        seen.add(from)
        if (seen.size > 256) return false
      }
    }
  }
  return true
}

function hasPending(watch: Watch, visited?: Set<any>, root?: object): boolean {
  for (const [members, keys] of watch.pending) {
    if (visited && root && outsideJoin(watch, members, visited, root)) continue
    for (const key of keys) {
      const value = members.get(key)
      if (value?.vtype !== 'BVT') keys.delete(key)
      else if (!visited?.has(value)) return true
    }
    if (!keys.size) watch.pending.delete(members)
  }
  return false
}

export function canSkipGlobalJoin(global: any, visited: Set<any>): boolean {
  const session = sessionFor(global)
  if (!session || !Config.makeAllCG || Config.loadContextEnvironment ||
      Config.incrementalRuntime?.cacheDir || !isAuditFastOff()) return false
  const table = getGlobalSymbolTable()
  if (!table?.canObserveStableBindings?.()) return false
  const ast = getGlobalASTManager()
  if (ast && (!ast.canObserveStableBindings?.() || typeof ast.bindingIdentityRevision !== 'function')) return false
  for (const _inherited in Object.prototype) return false
  const watch = session.watch ??= startWatch(table)
  if (!watch.observer.active || watch.table !== table || watch.ast !== ast) return false
  // File and global namespaces share objects and closures. Use one observer
  // for the pass so a second root cannot replace the first root's callbacks.
  if (!session.roots.has(global)) {
    session.roots.add(global)
    observe(watch, global)
  }
  if (ast?.bindingIdentityRevision?.() !== watch.astRevision) {
    watch.rebuild = true
  }
  if (!watch.observer.active || watch.rebuild) return false

  // Registration can occur midway through construction. Check the finished
  // canonical value here. BVT-to-BVT replacements preserve the set of BVT slots.
  for (const parent of watch.activatedParents) observe(watch, parent)
  watch.activatedParents.clear()
  for (const uuid of watch.changed) {
    const current = table.get(uuid)
    const previousKind = watch.bindingKinds.get(uuid)
    if (current?.vtype !== previousKind) {
      watch.rebuild = true
      return false
    }
    if (previousKind !== 'BVT') {
      const incoming = watch.incoming.get(uuid)
      if (current instanceof EntityValue && incoming) recordIncoming(watch, uuid, current, incoming)
      observe(watch, current)
    }
  }
  watch.changed.clear()
  for (const [members, entries] of watch.stale) {
    if (outsideJoin(watch, members, visited, global)) continue
    for (const [key, uuid] of entries) {
      const value = members.get(key)
      if (!(value instanceof Unit) || table.calculateUUID(value) === uuid) entries.delete(key)
      else if (!visited.has(value)) return false
    }
    if (!entries.size) watch.stale.delete(members)
  }
  const skip = watch.observer.active && !watch.rebuild && !hasPending(watch, visited, global)
  // The inventory budget limits unproductive retries, including late in a
  // long pass. Eight avoided dense traversals pay for one fresh inventory.
  if (skip && watch.inventories) watch.inventories = Math.max(0, watch.inventories - 1 / 8)
  return skip
}

export function afterGlobalJoin(global: object): void {
  const session = sessionFor(global)
  const watch = session?.watch
  if (!session || !watch?.observer.active || !session.roots.has(global)) return
  if (watch.table !== getGlobalSymbolTable() || !watch.table.canObserveStableBindings() ||
      watch.ast !== getGlobalASTManager() || (watch.ast && !watch.ast.canObserveStableBindings())) {
    watch.observer.invalidate()
    return
  }
  if (!watch.rebuild && !hasPending(watch)) return
  if (++watch.inventories > maxInventories) {
    watch.observer.invalidate()
    return
  }
  watch.rebuild = false
  watch.visits = 0
  watch.pending.clear()
  watch.stale.clear()
  watch.changed.clear()
  watch.bindingKinds.clear()
  watch.owners = new WeakMap()
  watch.ids = new WeakMap()
  watch.incoming.clear()
  watch.seen = new WeakSet()
  watch.frontier = new WeakSet()
  watch.activatedParents.clear()
  watch.astRevision = watch.ast?.bindingIdentityRevision?.()
  // The original join can leave BVTs in a second alias slot or detach the
  // only frame holding one. Rebuild from live roots before the next skip.
  for (const root of session.roots) observe(watch, root)
}
