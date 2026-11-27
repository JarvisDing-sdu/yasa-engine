const UastSpec = require('@ant-yasa/uast-spec')
import type { AstRef } from './value/ast-ref'

// Symbols keep transient lookup positions out of analyzer snapshots.
const managerState = Symbol('AST manager storage')
const refPosition = Symbol('AST binding position')
const refToken = Symbol('AST binding registry')
type PositionedRef = AstRef & { [refToken]?: object; [refPosition]?: number }

/**
 * AST 管理器：使用 nodehash 作为 key 管理 AST 对象，避免重复存储
 * 用于降低内存占用，Unit 对象中只存储 AST 的 nodehash，而不是完整的 AST 对象
 */
class ASTManager {
  private [managerState] = {
    nodes: new Map<string, any>(),
    slots: [] as any[],
    positions: new Map<string, number>(),
    token: {},
    exposed: false,
    observing: false,
    revision: 0,
    identityRevision: 0,
    mayHaveUnresolvedRefs: false,
  }

  /**
   *
   */
  constructor() {
    // Saved contexts read and restore this property directly. Once the mutable
    // map escapes, all reads must reflect edits that bypass register/delete.
    Object.defineProperty(this, 'astMap', {
      enumerable: true,
      configurable: true,
      get: this.getMap,
      set: this.restoreMap,
    })
  }

  private restoreMap(map: Map<string, any>): void {
    this.getMap()
    this[managerState].nodes = map
  }

  canObserveStableBindings(): boolean {
    return !this[managerState].exposed && this.get === defaultGet &&
      this.getBindingNode === defaultGetBindingNode && this.resolveUncachedBinding === defaultResolveBinding &&
      this.register === defaultRegister &&
      this.has === defaultHas && this.delete === defaultDelete &&
      this.clear === defaultClear && this.getMap === defaultGetMap
  }

  bindingRevision(): number {
    const state = this[managerState]
    state.observing = true
    return state.revision
  }

  bindingIdentityRevision(): number {
    const state = this[managerState]
    state.observing = true
    return state.identityRevision
  }

  /**
   * 注册 AST 节点并返回其 nodehash
   * 如果 AST 节点已有 nodehash，则直接返回；否则生成一个 Mock nodehash
   * @param ast AST 节点对象
   * @returns AST 节点的 nodehash
   */
  register(ast: any): string | null {
    if (!ast) {
      return null
    }
    if (typeof ast === 'string') {
      ast = UastSpec.identifier(ast)
    }
    // 确保 _meta 对象存在
    if (!ast._meta) {
      ast._meta = {}
    }

    // 获取 nodehash
    let { nodehash } = ast._meta
    if (!nodehash) {
      // 如果没有 nodehash，生成一个 Mock nodehash
      const random = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      nodehash = `<MockASTNodeHash_${random}>`
      ast._meta.nodehash = nodehash
    }

    // 注册到 Map（如果已存在则覆盖，确保使用最新的 AST 对象）
    const state = this[managerState]
    if (state.observing) {
      const previous = state.nodes.get(nodehash)
      if (previous !== ast && (previous !== undefined || state.mayHaveUnresolvedRefs)) {
        state.revision++
        if (previous === undefined || previous._meta?.nodehash !== nodehash) state.identityRevision++
      }
    }
    state.nodes.set(nodehash, ast)
    if (state.positions.size) {
      const index = state.positions.get(nodehash)
      if (index !== undefined) state.slots[index] = ast
    }

    return nodehash
  }

  /**
   * 根据 nodehash 获取 AST 节点
   * @param nodehash AST 节点的 nodehash
   * @returns AST 节点对象，如果不存在则返回 null
   */
  get(nodehash: string | null | undefined): any {
    if (!nodehash) {
      return null
    }
    return this[managerState].nodes.get(nodehash) || null
  }

  getBindingNode(ref: PositionedRef): any {
    const state = this[managerState]
    if (this.get !== defaultGet) return this.get(ref.hash)
    if (ref[refToken] === state.token) return state.slots[ref[refPosition]!]
    return this.resolveUncachedBinding(ref)
  }

  private resolveUncachedBinding(ref: PositionedRef): any {
    const state = this[managerState]
    if (state.exposed || !Object.isExtensible(ref)) {
      const node = this.get(ref.hash)
      if (!node) state.mayHaveUnresolvedRefs = true
      return node
    }
    let index = state.positions.get(ref.hash)
    if (index === undefined) {
      const node = state.nodes.get(ref.hash)
      if (!node) {
        state.mayHaveUnresolvedRefs = true
        return null
      }
      index = state.slots.length
      state.slots.push(node)
      state.positions.set(ref.hash, index)
    }
    ref[refToken] = state.token
    ref[refPosition] = index
    return state.slots[index]
  }

  /**
   * 检查 nodehash 是否存在
   * @param nodehash AST 节点的 nodehash
   * @returns 是否存在
   */
  has(nodehash: string | null | undefined): boolean {
    if (!nodehash) {
      return false
    }
    return this[managerState].nodes.has(nodehash)
  }

  /**
   * 删除 AST 节点（通常不需要，但提供清理功能）
   * @param nodehash AST 节点的 nodehash
   */
  delete(nodehash: string | null | undefined): void {
    if (nodehash) {
      const state = this[managerState]
      if (state.nodes.delete(nodehash)) {
        state.revision++
        state.identityRevision++
        // Restoring a deleted hash can make a previously unresolved AstRef live.
        state.mayHaveUnresolvedRefs = true
      }
      if (state.positions.has(nodehash)) this.clearBindingPositions()
    }
  }

  /**
   * 清空所有 AST 节点
   */
  clear(): void {
    const state = this[managerState]
    state.nodes.clear()
    state.revision++
    state.identityRevision++
    state.mayHaveUnresolvedRefs = true
    this.clearBindingPositions()
  }

  private clearBindingPositions(): void {
    const state = this[managerState]
    state.slots = []
    state.positions.clear()
    state.token = {}
  }

  /**
   * 获取已注册的 AST 节点数量
   * @returns 节点数量
   */
  size(): number {
    return this[managerState].nodes.size
  }

  /**
   * 获取 astMap
   */
  getMap(): Map<string, any> {
    const state = this[managerState]
    if (!state.exposed) {
      state.exposed = true
      state.revision++
      state.identityRevision++
      this.clearBindingPositions()
    }
    return state.nodes
  }
}

const defaultGet = ASTManager.prototype.get
const defaultGetBindingNode = ASTManager.prototype.getBindingNode
const defaultResolveBinding = ASTManager.prototype['resolveUncachedBinding']
const defaultRegister = ASTManager.prototype.register
const defaultHas = ASTManager.prototype.has
const defaultDelete = ASTManager.prototype.delete
const defaultClear = ASTManager.prototype.clear
const defaultGetMap = ASTManager.prototype.getMap

module.exports = ASTManager
