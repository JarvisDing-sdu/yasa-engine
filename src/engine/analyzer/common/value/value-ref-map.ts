import { ValueRef } from './value-ref'
import type Unit from './unit'
import { RAW_TARGET } from './symbols'
import { auditSlotBindEvent } from './unit-audit'

// Structural snapshots belong to the backing map, including while it is shared
// by COW clones. They are intentionally absent from serialized analyzer state.
const mergeKeySnapshots = new WeakMap<Map<string, ValueRef>, readonly string[]>()
const noMergeKeys: readonly string[] = Object.freeze([])

type MergeSnapshot = {
  readonly token: object
  readonly keys: readonly string[]
  readonly uuids: readonly (string | undefined)[]
  readonly positions: SymbolPosition[]
}

export interface MergeBindingObserver {
  active: boolean
  bind(members: ValueRefMap, key: string, uuid: string, value: any, initial?: boolean): void
  invalidate(): void
}

export interface SymbolPosition {
  table: object
  uuid: string
  index: number
}

const exposedMaps = new WeakSet<Map<string, ValueRef>>()

/**
 * ValueStore — 符号表只读接口
 */
export interface ValueStore {
  get(uuid: string): Unit | null | undefined
}

/**
 * ValueRegistry — 符号表读写接口
 */
export interface ValueRegistry extends ValueStore {
  register(value: Unit): string | null
  getAtPosition?(uuid: string, positions: SymbolPosition[], index: number): Unit | null | undefined
}

/**
 * ValueRefMap — 内部存 Map<string, ValueRef>，通过 Proxy 对外模拟 Record
 *
 * 设计原则：_members 是数据所有者，ValueRef 同时持有 uuid + _direct。
 * 有 UUID → 优先从符号表 resolve（匹配旧 createFieldProxy 行为），_direct 做 fallback。
 * 无 UUID → 直返 _direct（非 Unit 值或注册失败时）。
 *
 * _proxyTarget 永久为空 {}，仅作为 Proxy 构造所需的 target object。
 * 所有数据读写均通过 _map，不往 _proxyTarget 写 string key，
 * 避免 V8 NameDictionary::Add 扩容导致的 OOM（原 365k 实例 × bags = 3.73GiB）。
 *
 * COW：_clone 共享 _map 引用（避免 clone 时 new Map() 重复 Rehash 扩容的 Map backing OOM），
 * 首次写时拆分为独立副本。注册成功的 Unit 同时存 WeakRef _direct，
 * cloned ST 查不到 uuid 时 resolve 回退 _direct 而非退化为 UUID 字符串（避免子作用域被误当字符串）。
 *
 * proxy[key]       → resolve ValueRef → 返回 Value
 * proxy[key] = val → 转 ValueRef 存储（uuid + direct）
 * delete proxy[key] → 删除
 * Object.keys(proxy) → _map.keys()
 * for...in          → 遍历 keys
 */
export class ValueRefMap {
  /** 内部数据主体。COW 共享时写前须调 _ensureMapOwned，外部禁止直接写 */
  // Keep join state out of serialized models. The public _map retains the
  // enumerable, assignable property used by cache and COW readers.
  #bindings: Map<string, ValueRef> = new Map()
  #sharedRefs = false
  #observer?: MergeBindingObserver
  #mergeSnapshot?: MergeSnapshot

  get _map(): Map<string, ValueRef> {
    // Raw refs can be changed by callers even after their original slot was rebound.
    this.#sharedRefs = true
    this.#mergeSnapshot = undefined
    this.#observer?.invalidate()
    exposedMaps.add(this.#bindings)
    return this.#bindings
  }

  set _map(map: Map<string, ValueRef>) {
    this.#bindings = map
    this.#sharedRefs = true
    this.#mergeSnapshot = undefined
    this.#observer?.invalidate()
    exposedMaps.add(map)
  }
  /** COW 标记：true 表示 _map 与其他实例共享，写前须拷贝 */
  declare private _mapShared: boolean
  declare private _getSymbolTable: () => ValueRegistry | null
  declare private _getOwner: (() => Unit | null) | null
  declare private _proxy: any
  declare private _proxyTarget: Record<string, any>

  constructor(getSymbolTable: () => ValueRegistry | null, getOwner?: () => Unit | null) {
    Object.defineProperty(this, '_map', rawMapProperty)
    this._mapShared = false
    this._getSymbolTable = getSymbolTable
    this._getOwner = getOwner || null
    this._proxy = undefined
    this._proxyTarget = {}
    this._proxy = this._createProxy()
    Object.defineProperty(this._proxy, RAW_TARGET, {
      value: this._proxyTarget,
      writable: false,
      enumerable: false,
      configurable: false,
    })
  }

  observeMergeBindings(observer: MergeBindingObserver): boolean {
    if (this.#sharedRefs || exposedMaps.has(this.#bindings) || !this.hasStandardPrototype()) return false
    this.#observer = observer
    const st = this._getSymbolTable()
    for (const [key, ref] of this.#bindings) {
      if (!ref.uuid || key === '_map' || key === '_owner' || key === 'hasOwnProperty') return false
      if (!observer.active) return false
      observer.bind(this, key, ref.uuid, ref.resolve(st), true)
    }
    return true
  }

  get size(): number {
    return this.#bindings.size
  }

  getProxy(): any {
    return this._proxy
  }

  get(key: string): any {
    const ref = this.#bindings.get(key)
    if (!ref) return null
    const st = this._getSymbolTable()
    const resolved = ref.resolve(st)
    if (resolved) return resolved
    if (ref.uuid) return ref.uuid
    return null
  }

  has(key: string): boolean {
    return this.#bindings.has(key)
  }

  set(key: string, value: Unit | ValueRef | null | undefined, snapshot?: object, index?: number): void {
    this._ensureMapOwned()
    const size = this.#bindings.size
    this._setInternal(key, value, snapshot, index)
    if (this.#bindings.size !== size) mergeKeySnapshots.delete(this.#bindings)
    // v5 hook #5：slot_bind 事件。每次成功 set 记一条边（value → ownerUnit）
    // delete 语义（value==null）不记边
    if (value != null && this._getOwner) {
      const owner = this._getOwner()
      if (owner) {
        try {
          auditSlotBindEvent(value, owner, key)
        } catch (_e) {
          // 插桩失败不影响原逻辑
        }
      }
    }
  }

  private _setInternal(
    key: string, value: Unit | ValueRef | null | undefined, snapshot?: object, index?: number,
  ): void {
    if (value == null) {
      this.#mergeSnapshot = undefined
      this.#bindings.delete(key)
      return
    }
    if (value instanceof ValueRef) {
      this.#sharedRefs = true
      this.#mergeSnapshot = undefined
      this.#bindings.set(key, value)
      this.#observer?.invalidate()
      return
    }
    // UUID string → pure reference (no direct object available)
    if (typeof value === 'string' && (value as any).startsWith('symuuid')) {
      this.#mergeSnapshot = undefined
      this.#bindings.set(key, new ValueRef(value as any))
      this.notifyMergeBinding(key, value as any, value)
      return
    }
    // Register Unit values in ST, store UUID-only ref (no _direct)。
    // Matches旧 createFieldProxy: SET stores UUID string, GET resolves via ST。
    if (value && typeof value === 'object' && (value as any).vtype && (value as any).qid) {
      const st = this._getSymbolTable()
      if (st) {
        const uuid = st.register(value as Unit)
        if (uuid) {
          const prior = this.mergeUUID(key, snapshot, index) ?? this.#bindings.get(key)?.uuid
          if (this.#sharedRefs || prior !== uuid) {
            this.#mergeSnapshot = undefined
            this.#bindings.set(key, new ValueRef(uuid))
            this.notifyMergeBinding(key, uuid, value)
          }
          return
        }
      }
    }
    // Non-Unit values or ST unavailable: store with whatever UUID is available
    this.#mergeSnapshot = undefined
    const uuid = value?.uuid || ''
    if (uuid) {
      this.#bindings.set(key, new ValueRef(uuid))
    } else {
      this.#bindings.set(key, new ValueRef('', value))
    }
    this.notifyMergeBinding(key, uuid, value)
  }

  private notifyMergeBinding(key: string, uuid: string, value: any): void {
    if (!this.#observer?.active) return
    if (!uuid || this.#sharedRefs || key === '_map' || key === '_owner' || key === 'hasOwnProperty') this.#observer.invalidate()
    else this.#observer.bind(this, key, uuid, value)
  }

  delete(key: string): boolean {
    this._ensureMapOwned()
    this.#mergeSnapshot = undefined
    const removed = this.#bindings.delete(key)
    if (removed) mergeKeySnapshots.delete(this.#bindings)
    return removed
  }

  clear(): void {
    this._ensureMapOwned()
    this.#mergeSnapshot = undefined
    this.#bindings.clear()
    mergeKeySnapshots.delete(this.#bindings)
  }

  keys(): IterableIterator<string> {
    return this.#bindings.keys()
  }

  /** for-in snapshots keys before the join can rebind any symbols. */
  mergeKeys(): readonly string[] {
    if (this.#bindings.size === 0) return noMergeKeys
    if (this.#sharedRefs && exposedMaps.has(this.#bindings)) return Array.from(this.#bindings.keys())
    let keys = mergeKeySnapshots.get(this.#bindings)
    if (!keys) {
      keys = Array.from(this.#bindings.keys())
      mergeKeySnapshots.set(this.#bindings, keys)
    }
    return keys
  }

  prepareMergeSnapshot(keys: readonly string[]): object | undefined {
    // Large scopes repeatedly visit the same function bindings. Small maps
    // cost less to read directly. Only internally owned UUID refs are pure.
    if (this.#sharedRefs || keys.length < 64 || keys !== mergeKeySnapshots.get(this.#bindings)) return undefined
    if (!this.#mergeSnapshot) {
      const uuids = keys.map(key => {
        if (key === '_map' || key === '_owner' || key === 'hasOwnProperty') return undefined
        return this.#bindings.get(key)?.uuid || undefined
      })
      this.#mergeSnapshot = { token: {}, keys: keys.slice(), uuids, positions: [] }
    }
    return this.#mergeSnapshot.token
  }

  private mergeUUID(key: string, snapshot?: object, index?: number): string | undefined {
    const batch = this.#mergeSnapshot
    if (!batch || batch.token !== snapshot || index === undefined || batch.keys[index] !== key) return undefined
    return batch.uuids[index]
  }

  hasEnumerableMergeKey(key: string, snapshot?: object, index?: number): boolean {
    if (this.mergeUUID(key, snapshot, index)) return true
    const ref = this.#bindings.get(key)
    if (!ref) return false
    // for-in runs the proxy descriptor trap before reading the field. UUID-only
    // descriptors are pure; direct refs can invoke a custom resolver there.
    return !!ref.uuid || Object.prototype.propertyIsEnumerable.call(this._proxy, key)
  }

  readMergeField(key: string, snapshot?: object, index?: number): any {
    const uuid = this.mergeUUID(key, snapshot, index)
    if (!uuid) return this.readField(key)
    const positions = this.#mergeSnapshot!.positions
    const st = this._getSymbolTable()
    if (st?.getAtPosition) return st.getAtPosition(uuid, positions, index!) || uuid
    return (typeof st?.get === 'function' && st.get(uuid)) || uuid
  }

  readField(key: string): any {
    if (key === '_map') return this._map
    if (key === '_owner') return this
    if (key === 'hasOwnProperty') return (name: string) => this.#bindings.has(name)
    const ref = this.#bindings.get(key)
    if (!ref) return this._proxyTarget[key]
    return ref.resolve(this._getSymbolTable()) || ref.uuid || undefined
  }

  hasStandardPrototype(): boolean {
    if (Object.getPrototypeOf(this._proxyTarget) !== Object.prototype) return false
    for (const _key in Object.prototype) return false
    return true
  }

  forEach(fn: (value: any, key: string) => void): void {
    const st = this._getSymbolTable()
    for (const [key, ref] of this.#bindings) {
      const value = ref.resolve(st)
      if (value) fn(value, key)
    }
  }

  entries(): [string, any][] {
    const st = this._getSymbolTable()
    const result: [string, any][] = []
    for (const [key, ref] of this.#bindings) {
      const value = ref.resolve(st)
      if (value) result.push([key, value])
    }
    return result
  }

  /** COW 写时拷贝：共享 Map 在首次写前拆分为独立副本 */
  private _ensureMapOwned(): void {
    if (this._mapShared) {
      this.#bindings = new Map(this.#bindings)
      this._mapShared = false
    }
  }

  private _createProxy(): any {
    const self = this
    return new Proxy(this._proxyTarget, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return (_target as any)[prop]
        if (typeof prop === 'string') return self.readField(prop)
        return undefined
      },

      set(_target, prop, value) {
        if (typeof prop === 'string') {
          self.set(prop, value)
          return true
        }
        return true
      },

      deleteProperty(_target, prop) {
        if (typeof prop === 'string') {
          self.delete(prop)
          return true
        }
        return false
      },

      setPrototypeOf(target, proto) {
        self.#observer?.invalidate()
        return Reflect.setPrototypeOf(target, proto)
      },

      has(_target, prop) {
        if (typeof prop === 'string') {
          return self.#bindings.has(prop)
        }
        return false
      },

      ownKeys(_target) {
        const keys: (string | symbol)[] = Array.from(self.#bindings.keys())
        if (Object.prototype.hasOwnProperty.call(_target, RAW_TARGET)) {
          keys.push(RAW_TARGET)
        }
        return keys
      },

      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === 'string' && self.#bindings.has(prop)) {
          const ref = self.#bindings.get(prop)!
          // uuid 非空返回 UUID string（保持旧 _target[prop] 语义）；
          // uuid 为空时回退 resolve/direct，避免 desc.value 退化为 ''
          const value = ref.uuid
            ? ref.uuid
            : ref.resolve(self._getSymbolTable()) ?? ref._direct ?? undefined
          return {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          }
        }
        return Object.getOwnPropertyDescriptor(_target, prop)
      },
    })
  }

  static from(
    data: Record<string, string | ValueRef> | Map<string, string | ValueRef>,
    getSymbolTable: () => ValueRegistry | null,
  ): ValueRefMap {
    const map = new ValueRefMap(getSymbolTable)
    const entries = data instanceof Map ? data.entries() : Object.entries(data)
    for (const [key, value] of entries) {
      if (value instanceof ValueRef) {
        map.#sharedRefs = true
        map.#bindings.set(key, value)
      } else if (typeof value === 'string') {
        map.#bindings.set(key, new ValueRef(value))
      }
    }
    return map
  }

  _clone(getSymbolTable: () => ValueRegistry | null): ValueRefMap {
    const copy = new ValueRefMap(getSymbolTable)
    // COW：共享 _map 引用不拷贝，写时由 _ensureMapOwned 拆分为独立副本。
    // 不守 size>0：空 map 克隆时若不置 _mapShared，任一侧 set 直接写共享对象、
    // 两侧互相污染,_map 异常增长 → satisfy BFS 触达 2^32-1 抛 RangeError。
    this.#observer?.invalidate()
    this.#mergeSnapshot = undefined
    copy.#bindings = this.#bindings
    this.#sharedRefs = true
    copy.#sharedRefs = true
    this._mapShared = true
    copy._mapShared = true
    return copy
  }
}

const rawMapProperty = {
  ...Object.getOwnPropertyDescriptor(ValueRefMap.prototype, '_map')!,
  enumerable: true,
}
