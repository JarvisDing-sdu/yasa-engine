/**
 * C 函数指针字段的回调汇总（供调用图使用）
 *
 * --dumpAllCG 逐个函数单独分析：`p->cb(...)` 中的 p 来自参数，或回调由另一个函数写入字段时，
 * 调用处的值未知。这里按“struct 名.字段名”汇总全项目写入该字段的函数：
 * - 赋值 `x->f = fn` / `x.f = &fn`（含宏展开出的赋值）；
 * - 初始化列表（全局/局部、按位置或按字段名、struct 数组与嵌套 struct）。
 * 调用处按接收者的声明类型取候选，字段同名但 struct 不同的不会混在一起；
 * 同一 struct 类型的不同对象会合并（按类型的上近似）。
 */
import type { CTypeIndex } from './c-types'

/** 写入回调字段的函数：名字及所在文件（static 函数按文件解析） */
export interface CallbackCandidate {
  name: string
  file: string
}

const SKIP_KEYS = new Set(['loc', '_meta', 'parent', 'varType', 'returnType', 'as'])

/**
 * 去掉不改变被调函数的包装：类型转换、取地址
 * @param node - 表达式
 * @returns 内层表达式
 */
function unwrap(node: any): any {
  let current = node
  while (current?.type === 'CastExpression' || current?.type === 'ReferenceExpression') {
    current = current.type === 'CastExpression' ? current.expression : current.argument
  }
  return current
}

/** 全项目的“struct.字段 → 写入的函数”汇总 */
export class CCallbackIndex {
  private targets = new Map<string, CallbackCandidate[]>()

  /**
   * @param types - 已标注各编译单元的类型索引
   */
  constructor(private readonly types: CTypeIndex) {}

  /**
   * 汇总一个编译单元（须先由 CTypeIndex.annotate 标注）
   * @param unit - CompileUnit
   * @param file - 文件名
   */
  collect(unit: any, file: string): void {
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node.type === 'AssignmentExpression' && node.operator === '=') {
        const key = this.fieldKey(node.left)
        const name = this.functionName(node.right)
        if (key && name) this.add(key, name, file)
      } else if (node.type === 'VariableDeclaration' && node.init) {
        this.fromInitializer(this.types.keyInitializer(node.init, node.varType), node.varType, file, 0)
      }
      for (const [key, child] of Object.entries(node)) if (!SKIP_KEYS.has(key)) walk(child)
    }
    walk(unit?.body)
  }

  /**
   * @param callee - 调用表达式的 callee（`x->f`、`(*x->f)`）
   * @returns 写入该字段的函数；接收者类型未知时为空
   */
  candidatesFor(callee: any): CallbackCandidate[] {
    let current = unwrap(callee)
    while (current?.type === 'DereferenceExpression') current = unwrap(current.argument)
    const key = this.fieldKey(current)
    return (key && this.targets.get(key)) || []
  }

  /**
   * @param node - 表达式
   * @returns `struct名.字段名`；不是已知 struct 的字段访问时为 undefined
   */
  private fieldKey(node: any): string | undefined {
    if (node?.type !== 'MemberAccess' || node.computed || !node.property?.name) return undefined
    const objectType = this.types.typeOf(node.object)
    const structType = this.types.isPointer(objectType) ? this.types.elementOf(objectType) : objectType
    const name = this.structName(structType)
    return name ? `${name}.${node.property.name}` : undefined
  }

  /**
   * @param type - 类型
   * @returns struct/union 名（typedef 展开后）
   */
  private structName(type: any): string | undefined {
    const t = this.types.resolve(type)
    return t?.type === 'ScopedType' && this.types.fieldsOf(t) ? t.id?.name : undefined
  }

  /**
   * @param node - 赋值右侧或初始化值
   * @returns 函数名；变量（带声明类型的标识符）不算
   */
  private functionName(node: any): string | undefined {
    const inner = unwrap(node)
    return inner?.type === 'Identifier' && !inner._meta?.cType ? inner.name : undefined
  }

  /**
   * @param init - 已按字段名键化的初始化列表
   * @param type - 声明类型
   * @param file - 文件名
   * @param depth - 递归深度
   */
  private fromInitializer(init: any, type: any, file: string, depth: number): void {
    if (init?.type !== 'ObjectExpression' || depth > 16) return
    const element = this.types.isArray(type) ? this.types.elementOf(type) : undefined
    const fields = element ? undefined : this.types.fieldsOf(type)
    const struct = element ? undefined : this.structName(type)
    for (const property of init.properties || []) {
      if (element) {
        this.fromInitializer(property?.value, element, file, depth + 1)
        continue
      }
      const field = property?.key?.name
      if (!fields || !struct || !field || !fields.has(field)) continue
      const name = this.functionName(property.value)
      if (name) this.add(`${struct}.${field}`, name, file)
      else this.fromInitializer(property.value, fields.get(field), file, depth + 1)
    }
  }

  /**
   * @param key - `struct名.字段名`
   * @param name - 函数名
   * @param file - 文件名
   */
  private add(key: string, name: string, file: string): void {
    const list = this.targets.get(key) || []
    if (!list.some((c) => c.name === name && c.file === file)) list.push({ name, file })
    this.targets.set(key, list)
  }
}
