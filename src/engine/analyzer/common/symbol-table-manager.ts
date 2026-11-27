import { yasaError } from "../../../util/format-util"
import type { SymbolPosition } from './value/value-ref-map'

const { md5 } = require('../../../util/hash-util')
const { yasaWarning } = require('../../../util/format-util')

// Registration tokens are table-specific and carry no references back to the table or its Units.
type UUIDEntry = { uuid: string; nodeHash?: string; typeName?: string; qid?: string; registered?: object }
const cachedUUIDs = new WeakMap<object, UUIDEntry>()
// Short identities recur across freshly allocated Units, especially undefined and void values.
const shortUUIDs = new Map<string, string>()

function uuidForIdentity(identity: string): string {
  if (identity.length > 128) return `symuuid_${md5(identity)}`
  const existing = shortUUIDs.get(identity)
  if (existing !== undefined) return existing
  const uuid = `symuuid_${md5(identity)}`
  if (shortUUIDs.size === 64) shortUUIDs.clear()
  shortUUIDs.set(identity, uuid)
  return uuid
}

const registrationState = Symbol('registrationState')
const readIndex = Symbol('symbol read index')
const bindings = Symbol('symbol table bindings')
const bindingListeners = Symbol('binding listeners')
type BindingListener = (uuid: string | null) => void

/**
 * 符号表管理器：管理符号表，负责计算 UUID、注册 Unit 对象等操作
 * 用于降低内存占用，parent 和 field 中只存储 UUID，而不是完整的 Unit 对象
 * 实现 ISymbolTableManager 接口
 */
class SymbolTableManager {
  private [bindings]: Map<string, any> // 符号表：使用 UUID 作为 key 存储 Unit 对象

  private [bindingListeners]?: Set<BindingListener>
  private [registrationState]?: { map: Map<string, any>; token: object }
  private [readIndex]?: { token: object; positions: Map<string, number>; values: any[] }

  /**
   * 构造函数
   */
  constructor() {
    this[bindings] = new Map()
    this[registrationState] = { map: this[bindings], token: {} }
    // Context caches and the temporary registry access symbolMap directly.
    Object.defineProperty(this, 'symbolMap', {
      enumerable: true,
      configurable: true,
      get: this.getMap,
      set: this.restoreMap,
    })
  }

  private restoreMap(map: Map<string, any>): void {
    this.getMap()
    this[bindings] = map
  }

  canObserveStableBindings(): boolean {
    return this[registrationState]?.map === this[bindings] &&
      this.get === defaultGet && this.register === defaultRegister &&
      this.calculateUUID === defaultCalculateUUID && this.uuidEntry === defaultUUIDEntry &&
      this.getAtPosition === defaultGetAtPosition &&
      this.delete === defaultDelete && this.clear === defaultClear && this.getMap === defaultGetMap
  }

  observeBindingChanges(listener: BindingListener): () => void {
    const listeners = this[bindingListeners] ??= new Set()
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  private notifyBindingChange(uuid: string | null): void {
    const listeners = this[bindingListeners]
    if (listeners) for (const listener of listeners) listener(uuid)
  }

  /**
   * 计算 Unit 的 UUID
   * UUID = md5(astNodehash + valueType + qid)
   * valueType 使用 constructor.name（如 FunctionValue/SymbolValue），比 vtype 更精确
   * @param unit Unit 对象
   * @param qidSuffix
   * @returns UUID，如果无法计算则返回 null
   */
  calculateUUID(unit: any, qidSuffix?: string): string | null {
    return this.uuidEntry(unit, qidSuffix)?.uuid ?? null
  }

  private uuidEntry(unit: any, qidSuffix?: string): UUIDEntry | null {
    if (!unit) {
      return null
    }

    const nodeHash = unit.ast?.node?._meta?.nodehash || ''
    const typeName = unit.constructor?.name || ''
    let qid = unit.qid || ''
    if (qidSuffix) qid += qidSuffix

    if (qidSuffix || typeof unit !== 'object' || typeof nodeHash !== 'string' ||
        typeof typeName !== 'string' || typeof qid !== 'string') {
      return { uuid: uuidForIdentity([nodeHash, typeName, qid].join('_')) }
    }
    const cached = cachedUUIDs.get(unit)
    if (cached && cached.nodeHash === nodeHash && cached.typeName === typeName && cached.qid === qid) return cached
    const uuid = uuidForIdentity([nodeHash, typeName, qid].join('_'))
    const entry = { nodeHash, typeName, qid, uuid }
    cachedUUIDs.set(unit, entry)
    return entry
  }

  /**
   * 注册 Unit 对象并返回其 UUID
   * @param unit Unit 对象
   * @returns Unit 对象的 UUID
   */
  register(unit: any): string | null {
    if (!unit || typeof unit !== 'object') {
      return null
    }

    // 计算 UUID
    const calculateUUID = this.calculateUUID
    const intrinsic = calculateUUID === defaultCalculateUUID
    const entry = intrinsic ? this.uuidEntry(unit) : undefined
    const uuid = intrinsic ? entry?.uuid : calculateUUID.call(this, unit)
    if (!uuid) {
      return null
    }

    // 碰撞检测：同 uuid 不同对象且不同类型 → 警告
    const state = this[registrationState]
    const token = state?.map === this[bindings] ? state?.token : undefined
    const known = token !== undefined && entry?.registered === token
    const existing = known ? unit : this[bindings].get(uuid)
    if (existing && existing !== unit) {
      if (existing.vtype !== unit.vtype || existing.constructor?.name !== unit.constructor?.name) {
        yasaError(`UUID cross-type collision: ${uuid} (qid=${unit.qid}, vtype=${unit.vtype}, ctor=${unit.constructor?.name}) overwrites (vtype=${existing.vtype}, ctor=${existing.constructor?.name})`)
      }
    }

    // 设置 UUID
    unit.uuid = uuid

    // 注册到符号表
    // The setter can re-enter the table, reset it, or expose its mutable backing Map.
    if (known && entry?.registered === token && this[registrationState]?.token === token && state?.map === this[bindings]) return uuid
    const overwritten = this[bindings].get(uuid)
    if (existing !== unit || overwritten !== unit) {
      if (overwritten && typeof overwritten === 'object') {
        const old = cachedUUIDs.get(overwritten)
        if (old?.uuid === uuid) old.registered = undefined
      }
      this[bindings].set(uuid, unit)
      const reads = this[readIndex]
      const index = reads?.positions.get(uuid)
      if (index !== undefined) reads!.values[index] = unit
    }
    const current = this[registrationState]
    if (entry && current && current.map === this[bindings]) entry.registered = current.token
    if (overwritten !== unit && this[bindingListeners]) this.notifyBindingChange(uuid)

    return uuid
  }

  /**
   * 根据 UUID 获取 Unit 对象
   * @param uuid Unit 对象的 UUID
   * @returns Unit 对象，如果不存在则返回 null
   */
  get(uuid: string | null | undefined): any {
    if (!uuid) {
      return null
    }
    return this[bindings].get(uuid) || null
  }

  // Large member maps repeatedly read the same UUIDs in the same order. Only
  // this table retains the values; member snapshots keep a token and an index.
  getAtPosition(uuid: string, hints: SymbolPosition[], offset: number): any {
    if (this[registrationState]?.map !== this[bindings] || this.get !== defaultGet) return this.get(uuid)
    const reads = this[readIndex] ??= { token: {}, positions: new Map<string, number>(), values: [] as any[] }
    const hint = hints[offset]
    if (hint?.table === reads.token && hint.uuid === uuid) return reads.values[hint.index]
    let index = reads.positions.get(uuid)
    if (index === undefined) {
      const value = this.get(uuid)
      if (!value) return value
      index = reads.values.length
      reads.positions.set(uuid, index)
      reads.values.push(value)
    }
    hints[offset] = { table: reads.token, uuid, index }
    return reads.values[index]
  }

  /**
   * 检查 UUID 是否存在
   * @param uuid Unit 对象的 UUID
   * @returns 是否存在
   */
  has(uuid: string | null | undefined): boolean {
    if (!uuid) {
      return false
    }
    return this[bindings].has(uuid)
  }

  /**
   * 删除 Unit 对象（通常不需要，但提供清理功能）
   * @param uuid Unit 对象的 UUID
   */
  delete(uuid: string | null | undefined): void {
    if (uuid) {
      const old = this[bindings].get(uuid)
      if (old && typeof old === 'object') {
        const previous = cachedUUIDs.get(old)
        if (previous?.uuid === uuid) previous.registered = undefined
      }
      const removed = this[bindings].delete(uuid)
      if (this[readIndex]?.positions.has(uuid)) this[readIndex] = undefined
      if (removed && this[bindingListeners]) this.notifyBindingChange(uuid)
    }
  }

  /**
   * 清空所有 Unit 对象
   */
  clear(): void {
    this[bindings].clear()
    this[readIndex] = undefined
    if (this[registrationState]) this[registrationState]!.token = {}
    if (this[bindingListeners]) this.notifyBindingChange(null)
  }

  /**
   * 获取已注册的 Unit 对象数量
   * @returns 对象数量
   */
  size(): number {
    return this[bindings].size
  }

  /**
   * 获取symbolmap
   */
  getMap(): Map<string, any> {
    // External writers may now replace bindings without calling register or delete.
    const wasObservable = this[registrationState] !== undefined
    this[registrationState] = undefined
    this[readIndex] = undefined
    if (wasObservable && this[bindingListeners]) this.notifyBindingChange(null)
    return this[bindings]
  }
}

const defaultCalculateUUID = SymbolTableManager.prototype.calculateUUID
const defaultUUIDEntry = SymbolTableManager.prototype['uuidEntry']
const defaultGet = SymbolTableManager.prototype.get
const defaultRegister = SymbolTableManager.prototype.register
const defaultGetAtPosition = SymbolTableManager.prototype.getAtPosition
const defaultDelete = SymbolTableManager.prototype.delete
const defaultClear = SymbolTableManager.prototype.clear
const defaultGetMap = SymbolTableManager.prototype.getMap

module.exports = SymbolTableManager
