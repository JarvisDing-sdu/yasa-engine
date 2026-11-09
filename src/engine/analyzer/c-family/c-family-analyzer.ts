import * as fs from 'fs'
import CAnalyzer = require('../c/common/c-analyzer')

const AstUtil = require('../../../util/ast-util')

/** One instance contains exactly one selected link domain. */
class CFamilyAnalyzer extends CAnalyzer {
  protected override readonly languageId: string = 'cpp'

  private staticKeys = new Set<string>()

  private compilerGraphPrepared = false

  private compilerFunctions = new Map<string, any>()

  private directCalls = new Map<string, Set<string>>()

  /**
   * Persist phase boundaries so timeout reports identify unfinished work.
   * @param stage
   * @param fields
   */
  private recordProgress(stage: string, fields: Record<string, unknown>): void {
    if (this.options.cFamilyProgressFile) {
      fs.appendFileSync(
        this.options.cFamilyProgressFile,
        `${JSON.stringify({ stage, ...fields, time: new Date().toISOString() })}\n`
      )
    }
  }

  /** Compiler-resolved direct calls establish roots without interpreting every body twice. */
  prepareCfamilyCallGraph(): void {
    if (this.compilerGraphPrepared) return
    this.compilerGraphPrepared = true
    const CallgraphChecker = require('../../../checker/callgraph/callgraph-checker')
    const { Graph } = require('../../../checker/common/checker-kit')
    const checker = new CallgraphChecker(null)
    this.ainfo.callgraph = this.ainfo.callgraph || new Graph()
    const functions = Object.values(this.topScope.context.funcs) as any[]
    const byName = new Map<string, any>()
    this.compilerFunctions = byName
    for (const closure of functions) {
      const ast = closure.ast?.fdef
      if (ast?.type !== 'FunctionDefinition') continue
      byName.set(ast.id.name, closure)
      this.ainfo.callgraph.addNode(checker.prettyPrint(closure, ast, ast), {
        funcDefNodehash: ast._meta?.nodehash,
        funcSymbolUuid: closure.uuid,
      })
    }
    for (const closure of functions) {
      const ast = closure.ast?.fdef
      if (ast?.type !== 'FunctionDefinition') continue
      const walk = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
          node.forEach(walk)
          return
        }
        if (node.type === 'CallExpression' && node.callee?._meta?.cFamilySymbol?.kind === 'function') {
          const { name } = node.callee
          const calls = this.directCalls.get(ast.id.name) || new Set<string>()
          calls.add(name)
          this.directCalls.set(ast.id.name, calls)
          const target = byName.get(name) || { name, qid: name, vtype: 'fclos' }
          checker.triggerAtFunctionCallBefore(
            this,
            closure.parent,
            node,
            { callstack: [closure] },
            { fclos: target, ainfo: this.ainfo }
          )
        }
        for (const [key, value] of Object.entries(node)) if (!['parent', 'loc', '_meta'].includes(key)) walk(value)
      }
      walk(ast.body)
    }
  }

  /**
   * Cover main and recursive components that have no zero-indegree function.
   * @param entries
   * @returns {any[]} Additional closures needed to cover the compiler call graph.
   */
  extraCompilerRoots(entries: any[]): any[] {
    const visited = new Set<string>()
    const selected: any[] = []
    const reach = (name: string): void => {
      const work = [name]
      while (work.length) {
        const current = work.pop()!
        if (visited.has(current)) continue
        visited.add(current)
        work.push(...(this.directCalls.get(current) || []))
      }
    }
    for (const entry of entries) reach(entry.functionName)
    const names = [...this.compilerFunctions.keys()].sort()
    if (this.compilerFunctions.has('main') && !entries.some((entry) => entry.functionName === 'main')) {
      selected.push(this.compilerFunctions.get('main'))
      reach('main')
    }
    for (const name of names) {
      if (visited.has(name)) continue
      selected.push(this.compilerFunctions.get(name))
      reach(name)
    }
    return selected
  }

  /**
   * Register each already-prepared translation unit in its own module.
   * @param directory
   */
  override async scanModules(directory: string): Promise<void> {
    this.recordProgress('scan-start', { directory })
    const units = this.options.cFamilyUnits
    if (!Array.isArray(units) || !units.length) throw new Error('Missing prepared C-family units')
    for (const unit of units) {
      for (const dependency of unit.dependencies) {
        if (!this.sourceCodeCache.has(dependency.file)) {
          this.sourceCodeCache.set(dependency.file, fs.readFileSync(dependency.file, 'utf8').split('\n'))
        }
      }
      this.sourceCodeCache.set(unit.moduleFile, fs.readFileSync(unit.projectTextFile, 'utf8').split('\n'))
      AstUtil.annotateAST(unit.ast, { skipSourcefile: true })
      this.recordProgress('unit-start', { file: unit.moduleFile })
      this.processModule(unit.ast, unit.moduleFile)
      this.recordProgress('unit-complete', { file: unit.moduleFile })
    }
  }

  /**
   * Resolve compiler-bound globals in the link-domain scope.
   * @param scope
   * @param node
   * @param state
   * @returns {any} The existing symbolic value.
   */
  override processIdentifier(scope: any, node: any, state: any): any {
    const symbol = node?._meta?.cFamilySymbol
    return super.processIdentifier(symbol?.kind === 'variable' && symbol.global ? this.topScope : scope, node, state)
  }

  /**
   * Store compiler-bound globals in the link-domain scope.
   * @param scope
   * @param node
   * @param value
   * @param state
   * @param oldValue
   * @returns {any} The saved symbolic value.
   */
  saveVarInScope(scope: any, node: any, value: any, state: any, oldValue: any = null): any {
    const symbol = node?._meta?.cFamilySymbol
    return super.saveVarInScope(
      symbol?.kind === 'variable' && symbol.global ? this.topScope : scope,
      node,
      value,
      state,
      oldValue
    )
  }

  /**
   * Initialize static local storage once within an entrypoint.
   * @param scope
   * @param node
   * @param state
   * @returns {any} The local static value.
   */
  override processVariableDeclaration(scope: any, node: any, state: any): any {
    const symbol = node?._meta?.cFamilySymbol
    if (!symbol?.staticLocal) return super.processVariableDeclaration(scope, node, state)
    const { name } = node.id
    if (Object.prototype.hasOwnProperty.call(this.topScope.value, name)) return this.topScope.value[name]
    this.staticKeys.add(name)
    const init = node.init ? this.processInstruction(scope, node.init, state) : node.init
    return super.processVariableDeclaration(this.topScope, { ...node, init }, state)
  }

  /**
   * Inspect branch syntax without walking CBranch runtime scope snapshots.
   * @param node
   * @param test
   * @param state
   * @param lstate
   * @param rstate
   * @returns {any} The existing branch merge result.
   */
  override postBranchProcessing(node: any, test: any, state: any, lstate: any, rstate?: any): any {
    const consequent = node.consequent?.type === 'CBranch' ? node.consequent.body : node.consequent
    const alternative = node.alternative?.type === 'CBranch' ? node.alternative.body : node.alternative
    return super.postBranchProcessing({ ...node, consequent, alternative }, test, state, lstate, rstate)
  }

  /**
   * Analyze entrypoints sequentially, isolating their static storage snapshots.
   * @returns {Promise<boolean>} Whether interpretation completed.
   */
  override async symbolInterpret(): Promise<boolean> {
    const entries = this.entryPoints
    try {
      for (const entry of entries || []) {
        for (const key of this.staticKeys) delete this.topScope.value[key]
        this.staticKeys.clear()
        this.entryPoints = [entry]
        this.recordProgress('entry-start', { name: entry.functionName })
        // One shared analyzer state requires sequential entrypoint interpretation.
        // eslint-disable-next-line no-await-in-loop
        await super.symbolInterpret()
        this.recordProgress('entry-complete', { name: entry.functionName })
      }
      this.options.cFamilyCompletion = { timedOutEntryPoints: this.getTimedOutCEntryPointCount() }
      return true
    } finally {
      this.entryPoints = entries
    }
  }
}

export = CFamilyAnalyzer
