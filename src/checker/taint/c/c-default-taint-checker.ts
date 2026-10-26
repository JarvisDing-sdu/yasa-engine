import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const Config = require('../../../config')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const AstUtil = require('../../../util/ast-util')
const FileUtil = require('../../../util/file-util')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint/entrypoint')
const Constant = require('../../../util/constant')
const IntroduceTaint = require('../common-kit/source-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../common-kit/sink-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const FullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const entryPointConfig = require('../../../engine/analyzer/common/entrypoint/current-entrypoint')

const TAINT_TAG_NAME = 'C_INPUT'
/** main(argc, argv, envp)：argv 与 envp 来自进程外部 */
const MAIN_TAINTED_PARAMS = [1, 2]

/**
 * 数值污点（atoi(input) 的结果、按 %d 写入的数字文本）也危险的 sink：长度/大小，
 * 以及格式串（数字可以选择位置参数 `%N$`、控制宽度）。命令/路径/SQL 等注入类 sink 不受数字影响。
 */
const NUMERIC_SENSITIVE_ATTRIBUTES = new Set(['CBufferOverflow', 'CFormatString'])

/**
 * @param rule - sink 规则
 * @returns 数值污点对该 sink 是否危险
 */
function isNumericSensitiveSink(rule: any): boolean {
  const attrs = Array.isArray(rule?.attribute) ? rule.attribute : [rule?.attribute]
  return attrs.some((a: any) => NUMERIC_SENSITIVE_ATTRIBUTES.has(a))
}

/**
 * main 先执行，其余按文件与行号稳定排序，保证结果可复现
 * @param ep - entrypoint
 * @returns 排序键
 */
function entryPointSortKey(ep: any): string {
  const line = String(ep.entryPointSymVal?.ast?.fdef?.loc?.start?.line ?? 0).padStart(8, '0')
  return `${ep.functionName === 'main' ? 0 : 1}:${ep.filePath}:${line}`
}

/**
 * 规则 args（`"1"`、`"*"`）对应的实参下标
 * @param specs - 规则中的 args
 * @param argc - 实参个数
 * @returns 下标列表
 */
function argIndexes(specs: any[] | undefined, argc: number): number[] {
  const result: number[] = []
  for (const spec of specs || []) {
    if (spec === '*') return Array.from({ length: argc }, (_v, i) => i)
    const index = Number.parseInt(String(spec), 10)
    if (!Number.isNaN(index) && index < argc) result.push(index)
  }
  return result
}

/**
 * 指针表达式实际写入的变量：去掉类型转换、取地址、解引用、指针偏移和下标。
 * @param node - 实参 AST
 * @returns 变量 AST（Identifier / 非计算 MemberAccess），无法确定时返回 null
 */
function writtenVariable(node: any): any {
  let current = node
  for (;;) {
    if (!current) return null
    if (current.type === 'CastExpression') current = current.expression
    else if (current.type === 'ReferenceExpression' || current.type === 'DereferenceExpression')
      current = current.argument
    else if (current.type === 'BinaryExpression' && (current.operator === '+' || current.operator === '-'))
      current = current.left
    else if (current.type === 'MemberAccess' && current.computed) current = current.object
    else break
  }
  return current.type === 'Identifier' || current.type === 'MemberAccess' ? current : null
}

/**
 * C 默认污点分析 checker
 *
 * Entrypoint：调用图中没有调用者的函数（含 main），这样库代码和未被 main 调到的
 * 函数也会被分析。Source：ruleconfig 中的库函数（getenv/fgets/recv...）与 main 的
 * argv/envp；ruleconfig 显式声明的 entrypoint 的全部参数。Sink：ruleconfig FuncCallTaintSink。
 */
class CDefaultTaintChecker extends TaintChecker {
  entryPoints: any[]

  /**
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_c_input')
    this.entryPoints = []
  }

  /**
   * @param analyzer
   */
  triggerAtStartOfAnalyze(analyzer: any): void {
    this.prepareEntryPoints(analyzer)
    analyzer.mainEntryPoints = this.entryPoints
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
  }

  /**
   * @param analyzer
   */
  prepareEntryPoints(analyzer: any): void {
    if (Config.entryPointMode !== 'SELF_COLLECT') {
      this.prepareRuleConfigEntryPoints(analyzer)
    }
    if (Config.entryPointMode === 'ONLY_CUSTOM') return

    FullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
    const roots = FullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(analyzer.ainfo?.callgraph, analyzer)
    roots.sort((a: any, b: any) => entryPointSortKey(a).localeCompare(entryPointSortKey(b)))
    for (const ep of roots) {
      ep.attribute = ep.functionName === 'main' ? 'CMain' : 'CCallGraphRoot'
      this.entryPoints.push(ep)
    }
  }

  /**
   * ruleconfig 中声明的 entrypoint：按文件路径 + 函数名匹配
   * @param analyzer
   */
  prepareRuleConfigEntryPoints(analyzer: any): void {
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    if (_.isEmpty(ruleConfigEntryPoints)) return

    const { topScope } = analyzer
    for (const entrypoint of ruleConfigEntryPoints) {
      const entryPointSymVal = AstUtil.satisfy(
        topScope.context.packages || topScope.context.funcs,
        (n: any) =>
          n.vtype === 'fclos' &&
          FileUtil.extractAfterSubstring(n?.ast?.node?.loc?.sourcefile, Config.maindirPrefix) === entrypoint.filePath &&
          n?.ast?.node?.id?.name === entrypoint.functionName,
        (node: any, prop: any) => prop === '_field',
        null,
        false
      )
      if (_.isEmpty(entryPointSymVal)) continue

      const symVals = Array.isArray(entryPointSymVal)
        ? _.uniqBy(entryPointSymVal, (value: any) => value.ast.fdef)
        : [entryPointSymVal]
      const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
      ep.scopeVal = symVals[0].parent
      ep.argValues = []
      ep.functionName = entrypoint.functionName
      ep.filePath = entrypoint.filePath
      ep.attribute = entrypoint.attribute || 'CRuleConfig'
      ep.packageName = undefined
      ep.entryPointSymVal = symVals[0]
      this.entryPoints.push(ep)
    }
  }

  /**
   * 函数调用前：匹配 sink，引入 FuncCallArgTaintSource（fgets/recv/read 等写入缓冲区的 source）
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, callInfo } = info
    this.checkByNameMatch(node, fclos, callInfo, scope, state)
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, callInfo, funcCallArgTaintSource)
    this.taintWrittenBuffers(analyzer, scope, node, state, funcCallArgTaintSource)
  }

  /**
   * C 的输入函数写入的是缓冲区：`recv(s, (char *)(data + len), ...)`、`fgets(&buf[1], ...)`。
   * 规则只标记了实参表达式的值，这里把污点也标到被写入的变量（data / buf）上。
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param rules
   */
  taintWrittenBuffers(analyzer: any, scope: any, node: any, state: any, rules: any[] | undefined): void {
    if (!Array.isArray(rules) || node?.callee?.type !== 'Identifier' || !BasicRuleHandler.getPreprocessReady()) return
    const args: any[] = node.arguments || []
    for (const rule of rules) {
      if (rule?.fsig !== node.callee.name) continue
      for (const i of argIndexes(rule.args, args.length)) {
        const base = writtenVariable(args[i])
        if (!base || base === args[i]) continue
        const value = analyzer.processInstruction(scope, base, state)
        IntroduceTaint.markTaintSource(value, { path: node, kind: rule.kind || TAINT_TAG_NAME })
      }
    }
  }

  /**
   * 函数调用后：返回值 source（getenv 等）
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource
    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * @param node
   * @param fclos
   * @param callInfo
   * @param scope
   * @param state
   */
  checkByNameMatch(
    node: any,
    fclos: any,
    callInfo: CallInfo | undefined,
    scope: any,
    state?: any
  ): boolean | undefined {
    if (fclos === undefined) return
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (!rules || !callInfo) return

    const matched = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope, callInfo)
    const rule: any = matched.length > 0 ? matched[0] : null
    if (!rule) return

    let args = BasicRuleHandler.prepareArgs(callInfo, fclos, rule)
    if (!isNumericSensitiveSink(rule)) {
      // 注入类 sink：数值污点不携带可注入的内容
      args = args.filter((arg: any) => arg?.cNumericTaint !== true)
    }
    const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
    const results = SanitizerChecker.findTagAndMatchedSanitizer(
      node,
      fclos,
      args,
      scope,
      TAINT_TAG_NAME,
      true,
      sanitizers
    )
    if (!results) return

    for (const { nd, matchedSanitizerTags } of results) {
      let ruleName = rule.fsig
      if (typeof rule.attribute !== 'undefined') {
        ruleName += `\nSINK Attribute: ${Array.isArray(rule.attribute) ? rule.attribute.join(',') : rule.attribute}`
      }
      const finding = this.buildTaintFinding(
        this.getCheckerId(),
        this.desc,
        node,
        nd,
        fclos,
        TAINT_TAG_NAME,
        ruleName,
        matchedSanitizerTags,
        state?.callstack,
        state?.callsites
      )
      if (!TaintOutputStrategy.isNewFinding(this.resultManager, finding)) continue
      this.resultManager.newFinding(finding, TaintOutputStrategy.outputStrategyId)
    }
    return true
  }

  /**
   * entrypoint 参数 source：main 的 argv/envp；ruleconfig entrypoint 的全部参数。
   * 调用图根函数的参数不标记，否则库代码中每个对外函数都会被当作攻击面。
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   */
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer: any, scope: any, node: any, state: any): void {
    const currentEntryPoint = entryPointConfig.getCurrentEntryPoint()
    if (!currentEntryPoint) return
    const epSym = currentEntryPoint.entryPointSymVal
    const parameters: any[] = epSym?.ast?.fdef?.parameters || []
    let tainted: number[] = []
    if (currentEntryPoint.attribute === 'CMain') {
      if (Config.entryPointMode === 'ONLY_CUSTOM') return
      tainted = MAIN_TAINTED_PARAMS
    } else if (currentEntryPoint.attribute !== 'CCallGraphRoot') {
      tainted = parameters.map((_p: any, i: number) => i)
    }
    for (const i of tainted) {
      const para = parameters[i]
      if (!para) continue
      const argv = analyzer.processInstruction(epSym, para.id || para, state)
      IntroduceTaint.markTaintSource(argv, { path: para, kind: TAINT_TAG_NAME })
    }
  }

  /**
   * Identifier：ruleconfig TaintSource（如 environ 全局变量）
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any): void {
    IntroduceTaint.introduceTaintAtIdentifierDirect(analyzer, scope, node, info.res, this.sourceScope.value)
  }
}

module.exports = CDefaultTaintChecker
