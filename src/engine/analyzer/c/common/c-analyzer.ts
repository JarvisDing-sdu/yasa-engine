/* eslint-disable @typescript-eslint/no-require-imports */
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const CheckerManager = require('../../common/checker-manager')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const Parser = require('../../../parser/parser')
const AstUtil = require('../../../../util/ast-util')
const SourceLine = require('../../common/source-line')
const CAstBuilder = require('../../../parser/c/c-ast-builder')
const logger: import('../../../../util/logger').Logger = require('../../../../util/logger')(__filename)
const { ErrorCode } = require('../../../../util/error-code')
const Statistics = require('../../../../util/statistics')
const config = require('../../../../config')
const constValue = require('../../../../util/constant')
const EntryPointConfig = require('../../common/entrypoint/current-entrypoint')
const { executeViaEntryPointExecutor } =
  require('../../common/entrypoint/entrypoint-executor') as typeof import('../../common/entrypoint/entrypoint-executor')
const { handleException } = require('../../common/exception-handler')
const { applyCLibraryModel } = require('./builtins/c-builtins')

const {
  valueUtil: {
    ValueUtil: { Scoped, ObjectValue, UndefinedValue, PrimitiveValue },
  },
} = require('../../common')

/** 字符串→数值转换：返回值不再携带注入类污点 */
const NUMERIC_CONVERSIONS = new Set([
  'atoi',
  'atol',
  'atoll',
  'atof',
  'strtol',
  'strtoll',
  'strtoul',
  'strtoull',
  'strtoimax',
  'strtoumax',
  'strtod',
  'strtof',
  'strtold',
])

/** parser-C 把这些运算符表示为同名 CallExpression */
const COMPILE_TIME_OPERATORS = new Set(['sizeof', 'alignof', '_Alignof', '__alignof__', 'offsetof'])

/**
 * 数组、struct/union 以及 typedef 名（无法区分时按聚合处理）
 * @param varType - 变量类型节点
 * @returns 是否聚合类型
 */
function isAggregateType(varType: any): boolean {
  if (!varType) return false
  if (varType.type === 'ArrayType') return true
  if (varType.type === 'ScopedType') return ['struct', 'union'].includes(varType._meta?.kind)
  return false
}

/** 之后到下一个标签之前的同级语句不可达 */
const TERMINATORS = new Set(['ReturnStatement', 'BreakStatement', 'ContinueStatement'])

/**
 * 循环体在顶层以无条件 break/return 结束（Juliet 与很多 C 代码的 `while (1) { ...; break; }`）
 * @param body - 循环体
 * @returns 是否只执行一次
 */
function endsUnconditionally(body: any): boolean {
  const statements: any[] = body?.type === 'ScopedStatement' ? body.body || [] : body ? [body] : []
  return statements.some((s) => s?.type === 'BreakStatement' || s?.type === 'ReturnStatement')
}

/**
 * C 语言分析器
 *
 * C 没有模块系统：非 static 的函数在链接时全局可见。每个 .c/.h 文件有自己的
 * 模块 scope（承载 static 函数与文件级变量），非 static 函数额外注册到 topScope，
 * 以便跨文件调用无需解析 #include。
 */
class CAnalyzer extends Analyzer {
  /** 文件名 → 模块 scope */
  private moduleScopes = new Map<string, any>()

  /** 当前 entrypoint 的截止时间（ms）；超过后在函数调用边界停止执行 */
  private entryPointDeadline: number | undefined

  /** 已超时的 entrypoint 数 */
  private timedOutEntryPoints = 0

  /**
   * `&x` 产生的值 → x 的位置。引擎中指针与被指对象共享同一个值，
   * 通过该表把 `*p = v` 写回到 p 指向的变量。
   */
  private pointees = new WeakMap<object, { scope: any; node: any }>()

  /**
   * @param options - 分析选项
   */
  constructor(options: any) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      BasicRuleHandler
    )
    super(checkerManager, options)
    this.enableNestedSourceLineIsolation = true
    this.options = options
    this.mainEntryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
  }

  /**
   * 单文件预处理
   * @param source - 源代码
   * @param fileName - 文件名
   */
  async preProcess4SingleFile(source: any, fileName: any) {
    this.initTopScope()
    this.state = this.initState(this.topScope)
    await CAstBuilder.ensureInitialized()

    this.performanceTracker.start('preProcess.parseCode')
    const { options } = this
    options.sourcefile = fileName
    this.sourceCodeCache.set(fileName, source.split(/\n/))
    this.uast = Parser.parseSingleFile(fileName, options, this.sourceCodeCache)
    this.performanceTracker.end('preProcess.parseCode')

    if (this.uast) {
      this.performanceTracker.start('preProcess.processModule')
      this.processModule(this.uast, fileName)
      this.performanceTracker.end('preProcess.processModule')
    }
  }

  /**
   * 预处理阶段：解析所有 C 源文件与头文件
   * @param dir - 项目目录
   */
  async preProcess(dir: any) {
    await this.scanModules(dir)
  }

  /**
   * @param dir - 项目目录
   */
  async scanModules(dir: any) {
    await CAstBuilder.ensureInitialized()

    this.performanceTracker.start('preProcess.parseCode')
    const astMap = await Parser.parseProject(dir, this.options, this.sourceCodeCache)
    this.performanceTracker.end('preProcess.parseCode')

    if (!astMap || Object.keys(astMap).length === 0) {
      handleException(
        null,
        '未找到 C 源文件',
        'find no target compileUnit of the project: no c file found in source path'
      )
      process.exitCode = ErrorCode.no_valid_source_file
      return
    }

    this.performanceTracker.start('preProcess.processModule')
    // Headers first so that a definition in a .c file wins over a header's
    // static inline or macro-generated duplicate.
    const filenames = Object.keys(astMap).sort((a, b) => Number(a.endsWith('.c')) - Number(b.endsWith('.c')))
    for (const filename of filenames) {
      const ast = astMap[filename]
      if (ast) this.processModule(ast, filename)
    }
    this.performanceTracker.end('preProcess.processModule')
  }

  /**
   * @param ast - CompileUnit
   * @param filename - 文件名
   * @returns 模块导出值
   */
  processModule(ast: any, filename: any) {
    if (!ast) {
      Statistics.fileIssues[filename] = 'Parsing Error'
      handleException(
        null,
        `CAnalyzer.processModule: ${filename} 解析失败`,
        `Error occurred in CAnalyzer.processModule: ${filename} parse error`
      )
      return
    }
    let m = this.topScope.context.modules.members.get(filename)
    if (m && typeof m === 'object') return m

    const modClos = this.initModuleScope(ast, filename)
    this.topScope.context.modules.members.set(filename, modClos.getFieldValue('module.exports'))
    m = this.processModuleDirect(ast, filename, modClos)
    this.moduleScopes.set(filename, modClos)
    if (m && typeof m === 'object') {
      m.ast = ast
      this.topScope.context.modules.members.set(filename, m)
      this.fileManager[filename] = { uuid: m.uuid, astNode: m.ast.node }
    }
    return m
  }

  /**
   * @param node - CompileUnit
   * @param file - 文件路径
   * @returns 模块 scope
   */
  override initModuleScope(node: any, file: any) {
    if (!file) return
    const prefix = file.substring(config.maindirPrefix?.length)
    const lastDotIndex = prefix.lastIndexOf('.')
    const sid = lastDotIndex >= 0 ? prefix.substring(0, lastDotIndex) : prefix
    const modClos = new Scoped('<global>', {
      sid,
      parent: this.topScope,
      decls: {},
      ast: node,
    })
    modClos.ast.fdef = node
    ;(modClos as any)._this = modClos
    ;(modClos as any).isCModule = true

    const mod = new ObjectValue(modClos.qid, { sid: 'module', parent: modClos })
    modClos.value.module = mod
    const exp = new ObjectValue(modClos.qid, { sid: 'module.exports', parent: modClos })
    mod.value.exports = exp
    modClos.value.exports = exp
    return modClos
  }

  /**
   * @param node - CompileUnit
   * @param filename - 文件名
   * @param modClos - 模块 scope
   * @returns 模块导出值
   */
  processModuleDirect(node: any, filename: any, modClos: any) {
    if (!node || node.type !== 'CompileUnit') {
      handleException(
        null,
        `节点类型应为 CompileUnit，但实际为 ${node?.type}`,
        `node type should be CompileUnit, but ${node?.type}`
      )
      return undefined
    }
    modClos = modClos || this.initModuleScope(node, filename)
    this.entry_fclos = modClos
    this.thisFClos = modClos

    const state = this.initState(modClos)
    this.processInstruction(modClos, node, state)

    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    return modClos.getFieldValue('module.exports')
  }

  /**
   * 非 static 的文件级函数具有外部链接，注册到 topScope 供其它文件调用。
   * @param scope - 当前 scope
   * @param node - FunctionDefinition
   * @param state - 状态
   * @returns 函数值
   */
  override processFunctionDefinition(scope: any, node: any, state: any): any {
    const fclos = super.processFunctionDefinition(scope, node, state)
    const name = node?.id?.name
    const isStatic = (node.modifiers || []).includes('static')
    // 头文件里的 static inline 函数会被 #include 到每个使用它的文件中，同样全局可见
    const inHeader = String(node.loc?.sourcefile ?? '').endsWith('.h')
    if (scope?.isCModule && name && node.body && fclos && (!isStatic || inHeader)) {
      const existing = this.topScope.value[name]
      // Keep the first non-header definition when the same symbol is defined twice (e.g. #if branches).
      if (!existing || !existing.ast?.fdef || String(existing.ast.fdef.loc?.sourcefile ?? '').endsWith('.h')) {
        this.topScope.value[name] = fclos
      }
    }
    return fclos
  }

  /**
   * sizeof/alignof/offsetof 是编译期常量：大小不受缓冲区内容影响，不能沿 arg→ret 传播污点。
   * @param scope - 当前 scope
   * @param node - CallExpression
   * @param state - 状态
   * @returns 调用结果
   */
  override processCallExpression(scope: any, node: any, state: any): any {
    const callee = node?.callee
    if (callee?.type === 'Identifier' && COMPILE_TIME_OPERATORS.has(callee.name)) {
      return new PrimitiveValue(scope.qid, `<${callee.name}>`, null, 'number', 'Literal', node.loc)
    }
    const result = super.processCallExpression(scope, node, state)
    if (callee?.type === 'Identifier' && NUMERIC_CONVERSIONS.has(callee.name)) {
      // 数值转换是注入类 sink 的屏障：整数无法携带命令/路径/SQL/格式串注入
      return new PrimitiveValue(scope.qid, `<${callee.name}>`, null, 'number', 'Literal', node.loc)
    }
    return result
  }

  /**
   * 未初始化的结构体/数组局部变量按空聚合对象初始化，使 `p.inner.v = x`、`g[1][0] = x`
   * 这类多级写入能落到同一对象上（引擎对 uninit 值不会逐级创建子对象）。
   * @param scope - 当前 scope
   * @param node - VariableDeclaration
   * @param state - 状态
   * @returns 变量值
   */
  override processVariableDeclaration(scope: any, node: any, state: any): any {
    const storage: string[] = node._meta?.storage || []
    if (scope?.isCModule && storage.includes('extern') && !node.init) {
      // `extern T x;` 只是声明：读写都应落到定义处（topScope 中的全局变量）
      return new UndefinedValue()
    }
    // 非 static 的文件级变量具有外部链接，存放在 topScope 供所有文件共享
    const target = scope?.isCModule && !storage.includes('static') ? this.topScope : scope
    if (target !== scope && this.topScope.value[node.id?.name] && !node.init) {
      return this.topScope.value[node.id.name]
    }
    if (!node.init && !node._meta?.isParameter && isAggregateType(node.varType)) {
      const init = { type: 'ObjectExpression', properties: [], loc: node.loc, _meta: { aggregate: true } }
      return super.processVariableDeclaration(target, { ...node, init }, state)
    }
    return super.processVariableDeclaration(target, node, state)
  }

  /**
   * 多级下标写入（`g[1][0] = x`）前先物化中间层对象，否则写入落在临时值上丢失。
   * @param scope - 当前 scope
   * @param node - AssignmentExpression
   * @param state - 状态
   * @returns 赋值结果
   */
  override processAssignmentExpression(scope: any, node: any, state: any): any {
    if (node?.left?.type === 'DereferenceExpression' && node.operator === '=') {
      return this.assignThroughPointer(scope, node, state)
    }
    if (node?.left?.type === 'MemberAccess' && node.left.object?.type === 'MemberAccess') {
      this.materializeMember(scope, node.left.object, state)
    }
    return super.processAssignmentExpression(scope, node, state)
  }

  /**
   * `*p = v`：写回 p 所指向的变量，并让 p 继续指向新值。
   * @param scope - 当前 scope
   * @param node - AssignmentExpression，left 为 DereferenceExpression
   * @param state - 状态
   * @returns 写入的值
   */
  private assignThroughPointer(scope: any, node: any, state: any): any {
    let value = this.processInstruction(scope, node.right, state)
    if (!value || typeof value !== 'object') {
      value = new PrimitiveValue(scope.qid, `<literal_${value}>`, value, null, 'Literal', node.right?.loc)
    }
    let pointerNode = node.left.argument
    while (pointerNode?.type === 'CastExpression') pointerNode = pointerNode.expression
    const pointerValue = this.processInstruction(scope, pointerNode, state)
    const pointee = pointerValue && typeof pointerValue === 'object' ? this.pointees.get(pointerValue) : undefined
    value = SourceLine.addSrcLineInfo(value, node, node.loc?.sourcefile, 'Var Pass:', AstUtil.prettyPrintAST(node.left))
    if (pointee) {
      this.saveVarInScope(pointee.scope, pointee.node, value, state)
      this.pointees.set(value, pointee)
    }
    if (pointerNode?.type === 'Identifier' || pointerNode?.type === 'MemberAccess') {
      this.saveVarInScope(scope, pointerNode, value, state)
    }
    return value
  }

  /**
   * `&x`：记录被指向的位置，供后续 `*p = v` 写回。
   * @param scope - 当前 scope
   * @param node - ReferenceExpression
   * @param state - 状态
   * @returns x 的值
   */
  override processReferenceExpression(scope: any, node: any, state: any): any {
    const value = super.processReferenceExpression(scope, node, state)
    const target = node?.argument
    if (value && typeof value === 'object' && (target?.type === 'Identifier' || target?.type === 'MemberAccess')) {
      this.pointees.set(value, { scope, node: target })
    }
    return value
  }

  /**
   * @param scope - 当前 scope
   * @param member - MemberAccess 节点
   * @param state - 状态
   */
  private materializeMember(scope: any, member: any, state: any): void {
    if (member.object?.type === 'MemberAccess') this.materializeMember(scope, member.object, state)
    const existing = this.getMemberValueNoCreate(scope, member, state)
    if (existing && !['undefine', 'uninitialized', 'symbol'].includes(existing.vtype)) return
    const obj = new ObjectValue(scope.qid, { sid: AstUtil.prettyPrintAST(member), parent: scope })
    this.saveVarInScope(scope, member, obj, state)
  }

  /**
   * 块内 return / goto 之后到下一个标签之前的语句不可达，执行前剪掉。
   * @param scope - 当前 scope
   * @param node - ScopedStatement
   * @param state - 状态
   * @returns 块结果
   */
  override processScopedStatement(scope: any, node: any, state: any): any {
    const body: any[] = node?.body || []
    const reachable: any[] = []
    let dead = false
    for (const stmt of body) {
      if (stmt?.type === 'LabeledStatement') dead = false
      if (!dead) reachable.push(stmt)
      if (TERMINATORS.has(stmt?.type) || (stmt?.type === 'Noop' && stmt._meta?.goto)) dead = true
    }
    if (reachable.length === body.length) return super.processScopedStatement(scope, node, state)
    return super.processScopedStatement(scope, { ...node, body: reachable }, state)
  }

  /**
   * 常量条件（`if (0)`、`if (1)`）只执行可达分支。
   * @param scope - 当前 scope
   * @param node - IfStatement
   * @param state - 状态
   * @returns 语句结果
   */
  override processIfStatement(scope: any, node: any, state: any): any {
    const test = node?.test
    if (test?.type === 'Literal' && (typeof test.value === 'number' || typeof test.value === 'boolean')) {
      const branch = test.value ? node.consequent : node.alternative
      return branch ? this.processInstruction(scope, branch, state) : new UndefinedValue()
    }
    return super.processIfStatement(scope, node, state)
  }

  /**
   * do-while 至少执行一次循环体（引擎基类先判条件，`do { ... } while (0)` 会整体跳过）。
   * @param scope - 当前 scope
   * @param node - WhileStatement
   * @param state - 状态
   * @returns 语句结果
   */
  override processWhileStatement(scope: any, node: any, state: any): any {
    // 循环体顶层无条件 break/return：只会执行一次（`while (1) { ...; break; }`），不能按两轮展开
    if (node?.isPostTest || endsUnconditionally(node?.body)) {
      this.processInstruction(scope, node.body, state)
      if (endsUnconditionally(node?.body)) return new UndefinedValue()
    }
    return super.processWhileStatement(scope, node, state)
  }

  /**
   * for 循环体顶层无条件 break/return 时只执行一次。
   * @param scope - 当前 scope
   * @param node - ForStatement
   * @param state - 状态
   * @returns 语句结果
   */
  override processForStatement(scope: any, node: any, state: any): any {
    if (!endsUnconditionally(node?.body)) return super.processForStatement(scope, node, state)
    if (node.init) this.processInstruction(scope, node.init, state)
    if (node.test) this.processInstruction(scope, node.test, state)
    this.processInstruction(scope, node.body, state)
    return new UndefinedValue()
  }

  /**
   * `*p` 读取 p 当前指向的变量（而不是取地址时的旧值）：`p = &x; x = v; use(*p)`。
   * @param scope - 当前 scope
   * @param node - DereferenceExpression
   * @param state - 状态
   * @returns 被指向变量的当前值
   */
  override processDereferenceExpression(scope: any, node: any, state: any): any {
    const value = super.processDereferenceExpression(scope, node, state)
    const pointee = value && typeof value === 'object' ? this.pointees.get(value) : undefined
    if (!pointee) return value
    const current = this.processInstruction(pointee.scope, pointee.node, state)
    return current ?? value
  }

  /**
   * 标签语句：执行被标记的语句。goto 在 parser 中保留为 Noop，控制流按顺序近似。
   * @param scope - 当前 scope
   * @param node - LabeledStatement
   * @param state - 状态
   * @returns 语句结果
   */
  processLabeledStatement(scope: any, node: any, state: any): any {
    return node?.body ? this.processInstruction(scope, node.body, state) : new UndefinedValue()
  }

  /**
   * #include 不需要按模块导入：函数通过 topScope 全局可见，宏在解析阶段已保留在元数据中。
   * @returns UndefinedValue
   */
  override processImportExpression(): any {
    return new UndefinedValue()
  }

  /**
   * 库函数调用后，按 C 标准库语义把污点写回输出参数（strcpy/sprintf/memcpy 等）。
   * @param node - CallExpression
   * @param fclos - 被调函数
   * @param state - 状态
   * @param scope - 当前 scope
   * @param callInfo - 调用信息
   * @returns 调用返回值
   */
  override executeCall(node: any, fclos: any, state: any, scope: any, callInfo: any): any {
    const ret = super.executeCall(node, fclos, state, scope, callInfo)
    if (node?.type === 'CallExpression' && !fclos?.ast?.fdef) {
      applyCLibraryModel(this, node, scope, state, callInfo, ret)
    }
    return ret
  }

  /**
   * 分析开始：checker 收集 entrypoint（main 与调用图根函数）
   */
  override startAnalyze() {
    if (this.checkerManager && this.checkerManager.checkAtStartOfAnalyze) {
      this.checkerManager.checkAtStartOfAnalyze(this, null, null, null, null)
    }
    if (Array.isArray(this.mainEntryPoints) && this.mainEntryPoints.length > 0) {
      this.entryPoints = [...this.mainEntryPoints, ...this.entryPoints]
    }
  }

  /**
   * 符号解释：逐个执行函数级 entrypoint
   * @returns 是否完成
   */
  async symbolInterpret(): Promise<boolean> {
    const { entryPoints } = this
    const state = this.initState(this.topScope)
    if (!entryPoints || entryPoints.length === 0) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised = new Set<string>()
    let epIdx = 0
    for (const entryPoint of entryPoints) {
      epIdx++
      const metricStartTime = Date.now()
      const findingsBefore = this.countFindings()
      let skipped = false
      let skipReason: string | undefined
      try {
        this.symbolTable.clear()
        if (entryPoint.type !== constValue.ENGIN_START_FUNCALL) {
          skipped = true
          skipReason = 'unsupported'
          continue
        }
        const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
        if (entryPointMark.skipped) {
          skipped = true
          skipReason = entryPointMark.skipReason
          continue
        }
        EntryPointConfig.setCurrentEntryPoint(entryPoint)

        const fdef = entryPoint.entryPointSymVal?.ast?.node
        const budget = Number(config.entryPointTimeoutQuickMs)
        this.entryPointDeadline = budget > 0 ? Date.now() + budget : undefined
        const argValues: any[] = []
        for (const param of fdef?.parameters || []) {
          argValues.push(this.processInstruction(entryPoint.entryPointSymVal, param, state))
        }

        executeViaEntryPointExecutor(
          {
            analyzer: this,
            entryPoint,
            metricStartTime,
            findingsBefore,
            executionState: state,
            overloadCount: 1,
            epIndex: epIdx,
            epTotal: entryPoints.length,
          },
          {
            language: 'c',
            classify: () => 'function',
            execute: () => {
              // 参数值创建后再触发 Before hook，避免 argv 的 taint 被覆盖
              this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
              try {
                this.executeCall(fdef, entryPoint.entryPointSymVal, state, entryPoint.scopeVal, {
                  callArgs: this.buildCallArgs(fdef, argValues, entryPoint.entryPointSymVal),
                })
              } catch (e) {
                handleException(
                  e,
                  `[${fdef?.id?.name} symbolInterpret 失败`,
                  `[${fdef?.id?.name} symbolInterpret failed`
                )
              }
              this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
            },
          },
          this.checkerManager?.resultManagerProxy
        )
      } finally {
        if (this.entryPointDeadline !== undefined && Date.now() >= this.entryPointDeadline) {
          this.timedOutEntryPoints++
          logger.info(`[symbolInterpret] entrypoint ${entryPoint.functionName} stopped after its time budget`)
        }
        this.entryPointDeadline = undefined
        this.recordEntryPointLoopMetric(entryPoint, metricStartTime, findingsBefore, skipped, skipReason, 1)
      }
    }
    if (this.timedOutEntryPoints > 0) {
      logger.info(`[symbolInterpret] ${this.timedOutEntryPoints} entrypoint(s) reached the time budget`)
    }
    return true
  }

  /**
   * entrypoint 时间预算：超过 `entryPointTimeoutQuickMs` 后在函数调用边界停止执行，已产生的告警保留。
   * @returns 是否应停止
   */
  protected override shouldAbortExecutionForTimeout(): boolean {
    return this.entryPointDeadline !== undefined && Date.now() >= this.entryPointDeadline
  }
}

export = CAnalyzer
