/* eslint-disable @typescript-eslint/no-require-imports */
import CAnalyzer = require('../../c/common/c-analyzer')

const {
  valueUtil: {
    ValueUtil: { Scoped, UnionValue },
  },
} = require('../../common')

interface Binding {
  scope: any
  name: string
}
interface UsingEntry {
  usingNamespace?: string
  usingDeclaration?: string
  context: string
  position: number
  start?: number
  end?: number
  depth: number
}
const HEADER_FILE = /\.(h|hpp|hh|hxx|inl)$/
const SOURCE_FILE = /\.(cpp|cc|cxx|c\+\+)$/
const coordinate = (loc: any) => (loc?.line ?? 0) * 1000000 + (loc?.column ?? 0)
const owns = (scope: any, name: string) => !!scope?.value && Object.prototype.hasOwnProperty.call(scope.value, name)
const definitions = (v: any): any[] => {
  if (v?.vtype === 'union') return v.value.flatMap(definitions)
  return v?.ast?.fdef ? [v] : []
}
/**
 * List enclosing namespaces from inner to global.
 * @param context - Lexical namespace context
 * @returns {string[]} Resolved analysis value.
 */
function namespaces(context: string): string[] {
  const parts = context ? context.split('::') : []
  return [...parts.map((_, i) => parts.slice(0, parts.length - i).join('::')), '']
}

/**
 * Collect using declarations with their lexical extent and point of declaration.
 * @param ast - Compile-unit UAST
 * @returns {UsingEntry[]} Resolved analysis value.
 */
function collectUsings(ast: any): UsingEntry[] {
  const result: UsingEntry[] = []
  const seen = new Set<any>()
  const walk = (node: any, extent: any, depth: number): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, extent, depth)
      return
    }
    if (node.type === 'FunctionDefinition' || node.type === 'ScopedStatement') {
      extent = node.loc
      depth++
    }
    const m = node._meta
    if (node.type === 'Noop' && (m?.usingNamespace || m?.usingDeclaration)) {
      result.push({
        usingNamespace: m.usingNamespace,
        usingDeclaration: m.usingDeclaration,
        context: m.namespaceContext ?? '',
        position: coordinate(node.loc?.start),
        depth,
        ...(extent ? { start: coordinate(extent.start), end: coordinate(extent.end) } : {}),
      })
    }
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'parent', '_meta'].includes(key)) walk(value, extent, depth)
  }
  walk(ast, undefined, 0)
  return result
}

/** Namespace lookup is shared by reads and writes; qualified aliases never copy variable values. */
class CppAnalyzer extends CAnalyzer {
  protected override readonly languageId: string = 'cpp'

  private namespaceScopes = new WeakMap<object, Map<string, any>>()

  private usings = new Map<string, UsingEntry[]>()

  private lexicalBlocks: { parent: any; loc: any }[] = []

  /**
   * Recognize headers scanned in C++ mode.
   * @param file - Source path
   * @returns {boolean} Resolved analysis value.
   */
  protected override isHeaderFile(file: string): boolean {
    return HEADER_FILE.test(file)
  }

  /**
   * Recognize C++ implementation files.
   * @param file - Source path
   * @returns {boolean} Resolved analysis value.
   */
  protected override isSourceFile(file: string): boolean {
    return SOURCE_FILE.test(file)
  }

  /**
   * Collect compile-unit imports before module analysis.
   * @param ast - Compile-unit UAST
   * @param filename - Source filename
   * @returns {any} Resolved analysis value.
   */
  override processModule(ast: any, filename: any) {
    if (ast && !this.usings.has(filename)) this.usings.set(filename, collectUsings(ast))
    return super.processModule(ast, filename)
  }

  /**
   * Find the compile unit owning a runtime scope.
   * @param scope - Current runtime scope
   * @returns {any} Resolved analysis value.
   */
  private moduleScope(scope: any): any {
    for (let s = scope, i = 0; s && i < 256; s = s.parent, i++) if (s.isCModule) return s
    return undefined
  }

  /**
   * Create the module-local lexical scope for a namespace.
   * @param mod - Owning compile-unit scope
   * @param namespace - Namespace path
   * @returns {any} Resolved analysis value.
   */
  private namespaceScope(mod: any, namespace: string): any {
    let scopes = this.namespaceScopes.get(mod)
    if (!scopes) {
      scopes = new Map()
      this.namespaceScopes.set(mod, scopes)
    }
    let parent = mod
    let name = ''
    for (const part of namespace.split('::').filter(Boolean)) {
      name = name ? `${name}::${part}` : part
      let scope = scopes.get(name)
      if (!scope) {
        scope = new Scoped(parent.qid, { sid: part, parent, decls: {}, ast: mod.ast })
        scope.isCppNamespace = true
        scopes.set(name, scope)
      }
      parent = scope
    }
    return parent
  }

  /**
   * Check whether a definition has internal linkage.
   * @param node - UAST node
   * @returns {boolean} Resolved analysis value.
   */
  private internal(node: any): boolean {
    return (
      !!node._meta?.anonymousNamespace ||
      (node.modifiers || []).includes('static') ||
      (node._meta?.storage || []).includes('static')
    )
  }

  /**
   * Give anonymous namespace definitions module-local storage.
   * @param node - UAST node
   * @returns {any} Resolved analysis value.
   */
  private localizeAnonymous(node: any): any {
    if (!node._meta?.anonymousNamespace) return node
    return {
      ...node,
      modifiers: [...(node.modifiers || []), 'static'],
      _meta: { ...node._meta, storage: [...(node._meta.storage || []), 'static'] },
    }
  }

  /**
   * Register a function, merging conditional definitions conservatively.
   * @param scope - Current runtime scope
   * @param name - Unqualified or canonical symbol name
   * @param value - Value to register or assign
   * @returns {any} Resolved analysis value.
   */
  private registerFunction(scope: any, name: string, value: any): any {
    const existing = scope.value[name]
    if (!existing || existing === value) {
      scope.value[name] = value
      return value
    }
    const funcs = [...new Set([...definitions(existing), ...definitions(value)])]
    if (funcs.some((f) => f.ast.fdef._meta?.conditional)) {
      const union = new UnionValue(undefined, undefined, `${scope.qid}.<union@cpp:${name}>`, undefined)
      for (const f of funcs) union.appendValue(f)
      scope.value[name] = union
    } else if (this.isHeaderDefinition(existing) && !this.isHeaderDefinition(value)) scope.value[name] = value
    return scope.value[name]
  }

  /**
   * Hoist functions into their owning namespace.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @returns {any} Resolved analysis value.
   */
  override preProcessFunctionDefinition(scope: any, node: any, state: any): any {
    node = this.localizeAnonymous(node)
    const ns = node._meta?.namespace
    return super.preProcessFunctionDefinition(
      ns && scope?.isCModule ? this.namespaceScope(scope, ns) : scope,
      node,
      state
    )
  }

  /**
   * Register a definition under its lexical and canonical names.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @returns {any} Resolved analysis value.
   */
  override processFunctionDefinition(scope: any, node: any, state: any): any {
    node = this.localizeAnonymous(node)
    const ns = node._meta?.namespace
    if (!ns || !scope?.isCModule) return super.processFunctionDefinition(scope, node, state)
    const owner = this.namespaceScope(scope, ns)
    const previous = owner.value[node.id?.name]
    const value = super.processFunctionDefinition(owner, node, state)
    if (node.body && value) {
      // C's conditional-definition merge only runs on module scopes, so preserve the namespace candidates here.
      if (previous) owner.value[node.id.name] = previous
      this.registerFunction(owner, node.id.name, value)
      this.registerFunction(this.internal(node) ? scope : this.topScope, node._meta.qualifiedName, value)
    }
    return value
  }

  /**
   * Initialize namespace variables in their shared canonical binding.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @returns {any} Resolved analysis value.
   */
  override processVariableDeclaration(scope: any, node: any, state: any): any {
    node = this.localizeAnonymous(node)
    const ns = node._meta?.namespace
    if (!ns || !scope?.isCModule) return super.processVariableDeclaration(scope, node, state)
    const owner = this.internal(node) ? scope : this.topScope
    const key = node._meta.qualifiedName
    if (!node.init && (node._meta.storage || []).includes('extern') && owns(owner, key)) return owner.value[key]
    const value = super.processVariableDeclaration(this.namespaceScope(scope, ns), node, state)
    owner.setMemberValue(key, value)
    return value
  }

  /**
   * Find module-local storage before externally linked storage.
   * @param mod - Owning compile-unit scope
   * @param key - Analysis input
   * @returns {Binding|undefined} Resolved analysis value.
   */
  private qualifiedBinding(mod: any, key: string): Binding | undefined {
    if (mod && owns(mod, key)) return { scope: mod, name: key }
    if (owns(this.topScope, key)) return { scope: this.topScope, name: key }
    return undefined
  }

  /**
   * Select imports visible at this identifier position.
   * @param node - UAST node
   * @returns {UsingEntry[]} Resolved analysis value.
   */
  private visibleUsings(node: any): UsingEntry[] {
    const point = coordinate(node.loc?.start)
    const context = node._meta?.namespaceContext ?? ''
    return (this.usings.get(String(node.loc?.sourcefile ?? '')) || [])
      .filter(
        (entry) =>
          entry.position <= point &&
          (!entry.context || context === entry.context || context.startsWith(`${entry.context}::`)) &&
          (entry.start === undefined || (entry.start <= point && point <= entry.end!))
      )
      .sort((a, b) => b.depth - a.depth)
  }

  /**
   * Resolve imported names at the appropriate namespace level.
   * @param mod - Owning compile-unit scope
   * @param name - Unqualified or canonical symbol name
   * @param entries - Visible using declarations
   * @param namespaceAt - Namespace lookup level for directives
   * @returns {Binding|undefined} Resolved analysis value.
   */
  private usingBinding(mod: any, name: string, entries: UsingEntry[], namespaceAt?: string): Binding | undefined {
    for (const e of entries) {
      let target: string | undefined
      if (e.usingNamespace) target = `${e.usingNamespace}::${name}`
      else if (e.usingDeclaration?.endsWith(`::${name}`)) target = e.usingDeclaration
      if (!target) continue
      for (const ns of target.startsWith('::') ? [''] : namespaces(e.context)) {
        const key = (ns ? `${ns}::${target}` : target).replace(/^::/, '')
        const binding = this.qualifiedBinding(mod, key)
        if (binding) {
          if (e.usingNamespace && namespaceAt !== undefined) {
            // A using-directive contributes at the nearest common namespace ancestor,
            // unlike a using-declaration, which introduces the name in its lexical block.
            const nominated = key.slice(0, -(name.length + 2)).split('::')
            const context = e.context ? e.context.split('::') : []
            let count = 0
            while (count < context.length && context[count] === nominated[count]) count++
            if (context.slice(0, count).join('::') !== namespaceAt) continue
          }
          return binding
        }
      }
    }
    return undefined
  }

  /**
   * Track the lexical block while the base analyzer executes it.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @returns {any} Resolved analysis value.
   */
  override processScopedStatement(scope: any, node: any, state: any): any {
    this.lexicalBlocks.push({ parent: scope, loc: node.loc })
    try {
      return super.processScopedStatement(scope, node, state)
    } finally {
      this.lexicalBlocks.pop()
    }
  }

  /**
   * Resolve absolute or relative qualified identifiers.
   * @param mod - Owning compile-unit scope
   * @param node - UAST node
   * @returns {Binding|undefined} Resolved analysis value.
   */
  private resolveQualified(mod: any, node: any): Binding | undefined {
    const meta = node._meta || {}
    const key = meta.qualifier ? `${meta.qualifier}::${node.name}` : node.name
    for (const ns of meta.globalQualified || meta.qualifier === '' ? [''] : namespaces(meta.namespaceContext ?? '')) {
      const found = this.qualifiedBinding(mod, ns ? `${ns}::${key}` : key)
      if (found) return found
    }
    // std C wrappers and global libc names use C's existing library models. Other unresolved qualifiers stay qualified.
    return { scope: this.topScope, name: meta.qualifier === 'std' ? node.name : key }
  }

  /**
   * Resolve lexical locals and block using-declarations.
   * @param scope - Current runtime scope
   * @param mod - Owning compile-unit scope
   * @param node - UAST node
   * @param usings - Visible imports
   * @returns {Binding|undefined} Resolved analysis value.
   */
  private resolveLocal(scope: any, mod: any, node: any, usings: UsingEntry[]): Binding | undefined {
    for (
      let s = scope, depth = 0;
      s && depth < 256 && !s.isCModule && !s.isCppNamespace && s !== this.topScope;
      s = s.parent, depth++
    ) {
      if (owns(s, node.name)) return { scope: s, name: node.name }
      const block = [...this.lexicalBlocks].reverse().find((b) => b.parent === s.parent)
      const declared =
        block &&
        this.usingBinding(
          mod,
          node.name,
          usings.filter(
            (u) =>
              u.usingDeclaration && u.start === coordinate(block.loc?.start) && u.end === coordinate(block.loc?.end)
          )
        )
      if (declared) return declared
    }
    return undefined
  }

  /**
   * Resolve a name once for both reads and assignments.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @returns {Binding|undefined} Resolved analysis value.
   */
  private resolveBinding(scope: any, node: any): Binding | undefined {
    if (node?.type !== 'Identifier' || !node.name) return undefined
    const meta = node._meta || {}
    const mod = this.moduleScope(scope)
    if (meta.qualifier !== undefined) return this.resolveQualified(mod, node)
    const usings = this.visibleUsings(node)
    const local = this.resolveLocal(scope, mod, node, usings)
    if (local) return local
    const localUsing = this.usingBinding(
      mod,
      node.name,
      usings.filter((u) => u.start !== undefined && u.usingDeclaration)
    )
    if (localUsing) return localUsing
    for (const ns of namespaces(meta.namespaceContext ?? '')) {
      const found = this.qualifiedBinding(mod, ns ? `${ns}::${node.name}` : node.name)
      if (found) return found
      const imported = this.usingBinding(
        mod,
        node.name,
        usings.filter((u) => u.usingNamespace || (u.start === undefined && u.context === ns)),
        ns
      )
      if (imported) return imported
    }
    return undefined
  }

  /**
   * Preserve user namespace identity through inherited C library models.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @returns {any} Resolved analysis value.
   */
  override processCallExpression(scope: any, node: any, state: any): any {
    const binding = this.resolveBinding(scope, node.callee)
    if (binding?.name.includes('::') && !binding.name.startsWith('std::')) {
      // C's numeric/library models use the callee name. Preserve the resolved namespace
      // through that layer so a user's atoi/strcpy/etc keeps its own function semantics.
      node = {
        ...node,
        callee: {
          ...node.callee,
          name: binding.name,
          _meta: { ...node.callee._meta, qualifier: '', globalQualified: true },
        },
      }
    }
    return super.processCallExpression(scope, node, state)
  }

  /**
   * Read an identifier from its resolved binding.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @returns {any} Resolved analysis value.
   */
  override processIdentifier(scope: any, node: any, state: any): any {
    const binding = this.resolveBinding(scope, node)
    return super.processIdentifier(binding?.scope || scope, binding ? { ...node, name: binding.name } : node, state)
  }

  /**
   * Write an identifier through the same binding used by reads.
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param value - Value to register or assign
   * @param state - Analysis state
   * @param oldVal - Previous assigned value
   * @returns {any} Resolved analysis value.
   */
  saveVarInScope(scope: any, node: any, value: any, state: any, oldVal: any = null): any {
    const binding = this.resolveBinding(scope, node)
    return super.saveVarInScope(
      binding?.scope || scope,
      binding ? { ...node, name: binding.name } : node,
      value,
      state,
      oldVal
    )
  }
}

export = CppAnalyzer
