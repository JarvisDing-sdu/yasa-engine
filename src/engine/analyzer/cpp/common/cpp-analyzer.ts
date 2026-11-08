/* eslint-disable @typescript-eslint/no-require-imports */
const CAnalyzer: typeof import('../../c/common/c-analyzer') = require('../../c/common/c-analyzer')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../common')

const HEADER_FILE = /\.(h|hpp|hh|hxx|inl)$/
const SOURCE_FILE = /\.(cpp|cc|cxx|c\+\+)$/

/** 编译单元中的 `using namespace N;` / `using N::f;`，及其所在的命名空间 */
interface UsingEntry {
  usingNamespace?: string
  usingDeclaration?: string
  context: string
}

/**
 * @param context - 命名空间，如 `A::B`
 * @returns 由内到外的各层命名空间：`A::B`、`A`
 */
function enclosingNamespaces(context: string): string[] {
  const parts = context ? context.split('::') : []
  const result: string[] = []
  for (let i = parts.length; i > 0; i--) result.push(parts.slice(0, i).join('::'))
  return result
}

/**
 * @param context - 标识符所在的命名空间
 * @param scope - using 所在的命名空间
 * @returns using 是否对该标识符可见
 */
function inScope(context: string, scope: string): boolean {
  return !scope || context === scope || context.startsWith(`${scope}::`)
}

/**
 * C++ 分析器：在 C 分析的基础上加入命名空间。
 *
 * - 命名空间中的函数/全局变量放在该编译单元的命名空间 scope 中（同一文件内按词法查找），
 *   并按限定名（`A::B::f`）登记到全局 scope 供其它文件引用；匿名命名空间与 static 的只登记到本模块。
 *   不同命名空间中的同名函数因此互不覆盖。
 * - 标识符查找：词法 scope 中已有的名字 → `namespaceContext` 由内到外逐层加前缀 →
 *   本编译单元 `using` 引入的 → 原名（库函数、全局命名空间）。
 * - 限定名 `A::f` 按 `A::f` 查找，找不到时按原名 `f`（如 `std::system` 对应库函数 system）。
 */
class CppAnalyzer extends CAnalyzer {
  protected override readonly languageId: string = 'cpp'

  /** 模块 scope → 命名空间 → 命名空间 scope */
  private namespaceScopes = new WeakMap<object, Map<string, any>>()

  /** 文件名 → 该编译单元中的 using */
  private usings = new Map<string, UsingEntry[]>()

  protected override isHeaderFile(file: string): boolean {
    return HEADER_FILE.test(file)
  }

  protected override isSourceFile(file: string): boolean {
    return SOURCE_FILE.test(file)
  }

  /**
   * @param ast - CompileUnit
   * @param filename - 文件名
   * @returns 模块导出值
   */
  override processModule(ast: any, filename: any) {
    if (ast && !this.usings.has(filename)) this.usings.set(filename, collectUsings(ast))
    return super.processModule(ast, filename)
  }

  /**
   * @param modClos - 模块 scope
   * @param namespace - 命名空间，如 `A::B`
   * @returns 该模块中此命名空间的 scope（父 scope 为外层命名空间）
   */
  private namespaceScope(modClos: any, namespace: string): any {
    let scopes = this.namespaceScopes.get(modClos)
    if (!scopes) {
      scopes = new Map()
      this.namespaceScopes.set(modClos, scopes)
    }
    let parent = modClos
    let name = ''
    for (const part of namespace.split('::')) {
      name = name ? `${name}::${part}` : part
      let scope = scopes.get(name)
      if (!scope) {
        // sid 不能带 `<>`：qid 归一化会去掉 `<...>` 段，使命名空间与模块共用存储
        scope = new Scoped(parent.qid, { sid: part, parent, decls: {}, ast: modClos.ast })
        scope.isCppNamespace = true
        scopes.set(name, scope)
      }
      parent = scope
    }
    return parent
  }

  /**
   * @param modClos - 模块 scope
   * @param node - 命名空间中的定义
   * @param value - 定义的值
   */
  private registerQualified(modClos: any, node: any, value: any): void {
    const qualifiedName = node._meta?.qualifiedName
    if (!qualifiedName || !value) return
    const internal = node._meta.anonymousNamespace || (node.modifiers || []).includes('static') ||
      (node._meta.storage || []).includes('static')
    const target = internal ? modClos : this.topScope
    const existing = target.value[qualifiedName]
    if (!existing || (this.isHeaderDefinition(existing) && !this.isHeaderFile(String(node.loc?.sourcefile ?? '')))) {
      target.value[qualifiedName] = value
    }
  }

  /**
   * @param scope - 当前 scope
   * @param node - FunctionDefinition
   * @param state - 状态
   * @returns 函数值
   */
  override processFunctionDefinition(scope: any, node: any, state: any): any {
    const namespace = node?._meta?.namespace
    if (!namespace || !scope?.isCModule) return super.processFunctionDefinition(scope, node, state)
    const fclos = super.processFunctionDefinition(this.namespaceScope(scope, namespace), node, state)
    if (node.body) this.registerQualified(scope, node, fclos)
    return fclos
  }

  /**
   * 编译单元的函数提升（先于语句执行）同样放入命名空间 scope，不能落到模块 scope
   * @param scope - 当前 scope
   * @param node - FunctionDefinition
   * @param state - 状态
   * @returns 函数值
   */
  override preProcessFunctionDefinition(scope: any, node: any, state: any): any {
    const namespace = node?._meta?.namespace
    if (!namespace || !scope?.isCModule) return super.preProcessFunctionDefinition(scope, node, state)
    return super.preProcessFunctionDefinition(this.namespaceScope(scope, namespace), node, state)
  }

  /**
   * @param scope - 当前 scope
   * @param node - VariableDeclaration
   * @param state - 状态
   * @returns 变量值
   */
  override processVariableDeclaration(scope: any, node: any, state: any): any {
    const namespace = node?._meta?.namespace
    if (!namespace || !scope?.isCModule) return super.processVariableDeclaration(scope, node, state)
    const value = super.processVariableDeclaration(this.namespaceScope(scope, namespace), node, state)
    if (!(node._meta.storage || []).includes('extern')) this.registerQualified(scope, node, value)
    return value
  }

  /**
   * @param scope - 当前 scope
   * @param node - Identifier
   * @param state - 状态
   * @returns 标识符的值
   */
  override processIdentifier(scope: any, node: any, state: any): any {
    const key = this.resolveName(scope, node)
    return super.processIdentifier(scope, key && key !== node.name ? { ...node, name: key } : node, state)
  }

  /**
   * @param scope - 当前 scope
   * @param node - Identifier
   * @returns 应查找的名字；无需改写时为 undefined
   */
  private resolveName(scope: any, node: any): string | undefined {
    const meta = node?._meta
    const name = node?.name
    if (!meta || !name) return undefined
    if (meta.qualifier !== undefined) {
      if (meta.qualifier === '') return undefined
      const qualified = `${meta.qualifier}::${name}`
      return this.isDefined(scope, qualified) ? qualified : undefined
    }
    const context: string = meta.namespaceContext ?? ''
    const usings = this.usings.get(String(node.loc?.sourcefile ?? ''))
    if (!context && !usings?.length) return undefined
    if (this.isDefined(scope, name)) return undefined
    for (const namespace of enclosingNamespaces(context)) {
      if (this.isDefined(scope, `${namespace}::${name}`)) return `${namespace}::${name}`
    }
    for (const entry of usings || []) {
      if (!inScope(context, entry.context)) continue
      const candidate = entry.usingNamespace
        ? `${entry.usingNamespace}::${name}`
        : entry.usingDeclaration?.endsWith(`::${name}`) ? entry.usingDeclaration : undefined
      if (candidate && this.isDefined(scope, candidate)) return candidate
    }
    return undefined
  }

  /**
   * @param scope - 当前 scope
   * @param key - 名字
   * @returns scope 链上是否已有该名字
   */
  private isDefined(scope: any, key: string): boolean {
    for (let s = scope, depth = 0; s && depth < 256; s = s.parent, depth++) {
      if (s.value && typeof s.value === 'object' && s.value[key] !== undefined) return true
    }
    return false
  }
}

/**
 * @param ast - CompileUnit
 * @returns 其中的 using 指令与 using 声明
 */
function collectUsings(ast: any): UsingEntry[] {
  const result: UsingEntry[] = []
  const stack = [ast]
  const seen = new Set<any>()
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    const meta = node._meta
    if (node.type === 'Noop' && (meta?.usingNamespace || meta?.usingDeclaration)) {
      result.push({ usingNamespace: meta.usingNamespace, usingDeclaration: meta.usingDeclaration, context: meta.namespaceContext ?? '' })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'parent' && key !== 'loc' && key !== '_meta' && value && typeof value === 'object') stack.push(value)
    }
  }
  return result
}

export = CppAnalyzer
