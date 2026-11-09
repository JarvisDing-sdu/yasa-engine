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
 * Expand a using entry in its declaring namespace's lookup order.
 * @param entry - Namespace import
 * @param name - Referenced member name
 * @returns {string[]} Canonical candidate names
 */
function usingCandidates(entry: UsingEntry, name: string): string[] {
  const target = entry.usingNamespace ? `${entry.usingNamespace}::${name}` : entry.usingDeclaration
  if (!target?.endsWith(`::${name}`)) return []
  const contexts = target.startsWith('::') ? [''] : namespaces(entry.context)
  return contexts.map((ns) => (ns ? `${ns}::${target}` : target).replace(/^::/, ''))
}

/**
 * Preserve the import's declaration position and optional block extent.
 * @param node - Using-declaration UAST node
 * @param extent - Enclosing function or block location
 * @param depth - Lexical block depth
 * @returns {UsingEntry} Import lookup information
 */
function usingEntry(node: any, extent: any, depth: number): UsingEntry {
  const meta = node._meta
  return {
    usingNamespace: meta.usingNamespace,
    usingDeclaration: meta.usingDeclaration,
    context: meta.namespaceContext ?? '',
    position: coordinate(node.loc?.start),
    depth,
    ...(extent ? { start: coordinate(extent.start), end: coordinate(extent.end) } : {}),
  }
}

/**
 * Collect using declarations with their lexical extent and point of declaration.
 * @param ast - Compile-unit UAST
 * @returns {{usings: UsingEntry[], prototypes: Set<string>}} Namespace lookup information
 */
function collectNamespaceEntries(ast: any): { usings: UsingEntry[]; prototypes: Set<string> } {
  const result: UsingEntry[] = []
  const prototypes = new Set<string>()
  const seen = new Set<any>()
  const walk = (node: any, extent: any, depth: number): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, extent, depth)
      return
    }
    if (['FunctionDefinition', 'ScopedStatement'].includes(node.type)) {
      extent = node.loc
      depth++
    }
    const m = node._meta || {}
    if (m.prototype) prototypes.add(m.qualifiedName || m.prototype)
    if (node.type === 'Noop' && (m.usingNamespace || m.usingDeclaration)) {
      result.push(usingEntry(node, extent, depth))
    }
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'parent', '_meta'].includes(key)) walk(value, extent, depth)
  }
  walk(ast, undefined, 0)
  return { usings: result, prototypes }
}

/** Namespace lookup is shared by reads and writes; qualified aliases never copy variable values. */
class CppAnalyzer extends CAnalyzer {
  protected override readonly languageId: string = 'cpp'

  private namespaceScopes = new WeakMap<object, Map<string, any>>()

  private usings = new Map<string, UsingEntry[]>()

  private prototypes = new Map<string, Set<string>>()

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
    if (ast && !this.usings.has(filename)) {
      const entries = collectNamespaceEntries(ast)
      this.usings.set(filename, entries.usings)
      this.prototypes.set(filename, entries.prototypes)
    }
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
      for (const key of usingCandidates(e, name)) {
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
   * Resolve namespace members introduced by namespace-scope using declarations
   * and directives. Qualified lookup also follows those imports outside the
   * importing namespace. Block-local imports never become namespace members.
   * @param mod - Owning compile-unit scope
   * @param key - Qualified member name
   * @param entries - Namespace imports declared before the reference
   * @param prototypes - Qualified declarations in this compile unit
   * @param seen - Names already visited in this lookup
   * @returns {Binding|undefined} The canonical binding, when found
   */
  private namespaceMemberBinding(
    mod: any,
    key: string,
    entries: UsingEntry[],
    prototypes: Set<string>,
    seen = new Set<string>()
  ): Binding | undefined {
    const direct = this.qualifiedBinding(mod, key)
    if (direct || seen.has(key)) return direct
    seen.add(key)
    if (prototypes.has(key)) {
      return { scope: this.topScope, name: key.startsWith('std::') ? key.slice(5) : key }
    }
    const separator = key.lastIndexOf('::')
    if (separator < 0) return undefined
    const context = key.slice(0, separator)
    const name = key.slice(separator + 2)
    const imports = entries.filter((entry) => entry.context === context)
    const candidates = imports.flatMap((entry) => usingCandidates(entry, name))
    for (const candidate of candidates) {
      const found = this.namespaceMemberBinding(mod, candidate, entries, prototypes, seen)
      if (found) return found
    }
    // External declarations can refer to functions represented by library models.
    const imported = imports.find((entry) => entry.usingDeclaration?.endsWith(`::${name}`))
    if (!imported) return undefined
    const canonical = imported.usingDeclaration!.replace(/^::/, '')
    return { scope: this.topScope, name: canonical.startsWith('std::') ? name : canonical }
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
    const entries = (this.usings.get(String(node.loc?.sourcefile ?? '')) || []).filter(
      (entry) => entry.start === undefined && entry.position <= coordinate(node.loc?.start)
    )
    const prototypes = this.prototypes.get(String(node.loc?.sourcefile ?? '')) || new Set<string>()
    for (const ns of meta.globalQualified || meta.qualifier === '' ? [''] : namespaces(meta.namespaceContext ?? '')) {
      const found = this.namespaceMemberBinding(mod, ns ? `${ns}::${key}` : key, entries, prototypes)
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
    if (binding && (node.callee._meta?.qualifier !== undefined || binding.name.includes('::'))) {
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
