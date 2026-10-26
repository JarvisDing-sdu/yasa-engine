/**
 * C 声明类型索引
 *
 * 引擎的值模型不区分“变量存储”与“值”：结构体对象按引用共享，`&x` 与 x 是同一个值。
 * 结构体按值复制、指针多级写回都需要知道表达式的声明类型，这里在解析后的 UAST 上
 * 做一次按词法作用域的类型标注：每个引用变量的 Identifier 记录其声明类型（`_meta.cType`）。
 */

/** struct/union 字段类型 */
type FieldTypes = Map<string, any>

const SKIP_KEYS = new Set(['loc', '_meta', 'parent', 'varType', 'returnType', 'as'])

/**
 *
 */
/** 编译单元中 struct/union、typedef 与变量的声明类型 */
export class CTypeIndex {
  /** struct/union 名 → 字段类型（同名定义取第一个） */
  private structs = new Map<string, FieldTypes>()

  /** typedef 名 → 类型 */
  private typedefs = new Map<string, any>()

  /**
   * 标注一个编译单元
   * @param unit - CompileUnit
   */
  annotate(unit: any): void {
    const scopes: Array<Map<string, any>> = [new Map()]
    const define = (name: string | undefined, type: any) => {
      if (name && type) scopes[scopes.length - 1].set(name, type)
    }
    const lookup = (name: string) => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const t = scopes[i].get(name)
        if (t) return t
      }
      return undefined
    }
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      switch (node.type) {
        case 'ClassDefinition':
          this.registerStruct(node)
          return
        case 'Noop':
          if (node._meta?.typedef?.name && !this.typedefs.has(node._meta.typedef.name)) {
            this.typedefs.set(node._meta.typedef.name, node._meta.typedef.type)
          }
          return
        case 'FunctionDefinition':
          scopes.push(new Map())
          for (const p of node.parameters || []) define(p?.id?.name, p?.varType)
          walk(node.body)
          scopes.pop()
          return
        case 'ScopedStatement':
        case 'ForStatement':
          scopes.push(new Map())
          for (const [key, child] of Object.entries(node)) if (!SKIP_KEYS.has(key)) walk(child)
          scopes.pop()
          return
        case 'VariableDeclaration':
          walk(node.init)
          define(node.id?.name, node.varType)
          return
        case 'Identifier': {
          const t = lookup(node.name)
          if (t) {
            node._meta = node._meta || {}
            node._meta.cType = t
          }
          return
        }
        case 'MemberAccess':
          walk(node.object)
          if (node.computed) walk(node.property)
          return
        default:
          for (const [key, child] of Object.entries(node)) if (!SKIP_KEYS.has(key)) walk(child)
      }
    }
    walk(unit?.body)
  }

  /**
   * @param node - ClassDefinition（struct/union）
   */
  private registerStruct(node: any): void {
    const name = node.id?.name
    if (!name || this.structs.has(name)) return
    const fields: FieldTypes = new Map()
    for (const f of node.body || []) {
      if (f?.type === 'VariableDeclaration' && f.id?.name) fields.set(f.id.name, f.varType)
    }
    this.structs.set(name, fields)
  }

  /**
   * 展开 typedef
   * @param type - 类型
   * @returns 底层类型
   */
  resolve(type: any): any {
    for (let i = 0; type && i < 16; i++) {
      if (type.type !== 'Identifier') return type
      const target = this.typedefs.get(type.name)
      if (!target) return type
      // `typedef struct { ... } S;`：匿名 struct 以 typedef 名登记
      if (target.type === 'ScopedType' && target.id?.name === 'struct' && this.structs.has(type.name)) {
        return { type: 'ScopedType', id: { type: 'Identifier', name: type.name }, _meta: { kind: 'struct' } }
      }
      type = target
    }
    return type
  }

  /**
   * @param type - 类型
   * @returns struct/union 的字段表
   */
  fieldsOf(type: any): FieldTypes | undefined {
    const t = this.resolve(type)
    if (t?.type === 'ScopedType') return this.structs.get(t.id?.name)
    return undefined
  }

  /**
   * @param type - 类型
   * @returns 是否为按值存储的 struct/union
   */
  isStruct(type: any): boolean {
    const t = this.resolve(type)
    return (t?.type === 'ScopedType' && ['struct', 'union'].includes(t._meta?.kind)) || !!this.fieldsOf(t)
  }

  /**
   * @param type - 类型
   * @returns 是否为数组
   */
  isArray(type: any): boolean {
    return this.resolve(type)?.type === 'ArrayType'
  }

  /**
   * @param type - 类型
   * @returns 是否为指针（包括函数指针）
   */
  isPointer(type: any): boolean {
    const t = this.resolve(type)
    return t?.type === 'PointerType' || t?.type === 'FuncType'
  }

  /**
   * @param type - 指针或数组类型
   * @returns 元素类型
   */
  elementOf(type: any): any {
    const t = this.resolve(type)
    return t?.type === 'PointerType' || t?.type === 'ArrayType' ? t.element : undefined
  }

  /**
   * 表达式的声明类型
   * @param node - 表达式
   * @returns 类型；未知时为 undefined
   */
  typeOf(node: any): any {
    if (!node) return undefined
    switch (node.type) {
      case 'Identifier':
        return node._meta?.cType
      case 'CastExpression':
        return node.as
      case 'DereferenceExpression':
        return this.elementOf(this.typeOf(node.argument))
      case 'ReferenceExpression': {
        const t = this.typeOf(node.argument)
        return t ? { type: 'PointerType', element: t, kind: 'pointer' } : undefined
      }
      case 'MemberAccess': {
        const objectType = this.typeOf(node.object)
        if (node.computed) return this.elementOf(objectType)
        const structType = this.isPointer(objectType) ? this.elementOf(objectType) : objectType
        return this.fieldsOf(structType)?.get(node.property?.name)
      }
      case 'AssignmentExpression':
        return this.typeOf(node.left)
      default:
        return undefined
    }
  }
}
