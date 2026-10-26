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
const StateUtil = require('../../../util/state-util')
const { foldConstant } = require('./c-const-eval')
const { CTypeIndex } = require('./c-types')

const {
  valueUtil: {
    ValueUtil: { Scoped, ObjectValue, UndefinedValue, PrimitiveValue, UnionValue },
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

/**
 * @param node - 表达式
 * @returns 去掉类型转换后的表达式
 */
function stripCasts(node: any): any {
  let current = node
  while (current?.type === 'CastExpression') current = current.expression
  return current
}

/**
 * @param node - 表达式
 * @returns 是否为可写的存储位置（变量、字段、下标）
 */
function isLocation(node: any): boolean {
  return node?.type === 'Identifier' || node?.type === 'MemberAccess'
}

/**
 * @param value - 函数值或函数值的并集
 * @returns 其中的函数定义
 */
function definitionsOf(value: any): any[] {
  if (!value || typeof value !== 'object') return []
  if (value.vtype === 'union' && Array.isArray(value.value)) return value.value.filter((v: any) => v?.vtype === 'fclos')
  return value.vtype === 'fclos' ? [value] : []
}

/**
 * @param fclos - 函数值
 * @returns 是否定义在配置未决定的 #if 分支中
 */
function isConditional(fclos: any): boolean {
  return !!fclos?.ast?.fdef?._meta?.conditional
}

/**
 * @param fclos - 函数值
 * @returns 是否定义在头文件中
 */
function isHeaderDefinition(fclos: any): boolean {
  return String(fclos?.ast?.fdef?.loc?.sourcefile ?? '').endsWith('.h')
}

/** 不可达代码中仍需处理的定义（函数、struct） */
const HOISTED = new Set(['FunctionDefinition', 'ClassDefinition'])

/** 突然完成（abrupt completion）的种类 */
type Abrupt = 'return' | 'break' | 'continue' | 'goto'

/**
 * 当前执行路径的控制流状态。`dead` 表示当前路径已经因 return/break/continue/goto
 * 离开顺序执行；`pending` 是已执行到的 goto 的目标标签，执行到这些标签时路径恢复。
 */
interface ControlFlow {
  dead: boolean
  reasons: Set<Abrupt>
  pending: Set<string>
  /** 标签 → 各条 goto 跳转时的变量快照，在标签处与顺序到达的路径合并 */
  labelStates: Map<string, ScopeSnapshot[]>
}

/** 从当前块到函数作用域各层 scope 的变量值 */
type ScopeSnapshot = Array<{ scope: any; fields: Map<string, any> }>

/** 分支（if 的两臂、switch 的 case）执行结束时的控制流状态 */
interface BranchResult {
  dead: boolean
  reasons: Set<Abrupt>
  /** 进入分支时的变量快照（单分支 if 需要丢弃 return 分支的写入时记录） */
  before?: ScopeSnapshot
}

/**
 * @returns 顺序执行中的控制流状态
 */
function liveFlow(): ControlFlow {
  return { dead: false, reasons: new Set(), pending: new Set(), labelStates: new Map() }
}

/**
 * 语句（块）中是否含有给定集合中的标签：跳转目标可能在嵌套块里
 * @param node - 语句
 * @param labels - 标签名
 * @returns 是否包含
 */
function containsLabel(node: any, labels: Set<string>): boolean {
  if (!node || labels.size === 0) return false
  if (node.type === 'LabeledStatement') return labels.has(node.label?.name) || containsLabel(node.body, labels)
  if (node.type === 'ScopedStatement') return (node.body || []).some((s: any) => containsLabel(s, labels))
  return false
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
   * 地址值 → 它指向的存储位置（scope + Identifier/MemberAccess）。`*e = v` 与 `*e`
   * 通过 e 当前值查表，逐级定位多级指针指向的位置。
   */
  private pointees = new WeakMap<object, { scope: any; node: any }>()

  /** `&x` 为标量/指针变量创建的地址值 */
  private addresses = new WeakSet<object>()

  /** 声明类型索引 */
  private types = new CTypeIndex()

  /** 当前函数体的控制流状态；每次函数调用独立 */
  private flow: ControlFlow = liveFlow()

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

    this.types.annotate(ast)
    const modClos = this.initModuleScope(ast, filename)
    this.importHeaderStatics(ast, modClos)
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
   * 文件级函数的链接：
   * - 非 static 函数具有外部链接，注册到 topScope 供其它文件调用；
   * - 头文件中的 static（inline）函数属于包含它的每个编译单元，由 importHeaderStatics 放入
   *   各 .c 的模块 scope；topScope 中只保留一份，供无法解析 #include 的编译单元回退使用；
   * - 同名函数在配置未决定的 #if 分支中各有一份定义时（`_meta.conditional`），
   *   调用处可能调用其中任意一个：保存为各定义的并集，而不是取第一个。
   * @param scope - 当前 scope
   * @param node - FunctionDefinition
   * @param state - 状态
   * @returns 函数值
   */
  override processFunctionDefinition(scope: any, node: any, state: any): any {
    const name = node?.id?.name
    const previous = scope?.isCModule && name && node.body ? scope.getMemberValue?.(name) : undefined
    const fclos = super.processFunctionDefinition(scope, node, state)
    if (!scope?.isCModule || !name || !node.body || !fclos) return fclos
    const isStatic = (node.modifiers || []).includes('static')
    const inHeader = String(node.loc?.sourcefile ?? '').endsWith('.h')
    let value = fclos
    if (previous && previous !== fclos && (node._meta?.conditional || definitionsOf(previous).some(isConditional))) {
      value = this.unionDefinitions(scope, name, [previous, fclos])
      scope.setMemberValue(name, value)
    }
    if (isStatic && !inHeader) return fclos
    const existing = this.topScope.value[name]
    if (!existing) {
      this.topScope.value[name] = value
    } else if (value !== fclos || (node._meta?.conditional && definitionsOf(existing).some(isConditional))) {
      this.topScope.value[name] = this.unionDefinitions(this.topScope, name, [existing, value])
    } else if (definitionsOf(existing).every((f: any) => isHeaderDefinition(f)) && !inHeader) {
      // .c 中的定义优先于头文件中的同名定义
      this.topScope.value[name] = value
    }
    return fclos
  }

  /**
   * @param scope - scope
   * @param name - 函数名
   * @param values - 函数值（可含已有的并集）
   * @returns 各定义的并集
   */
  private unionDefinitions(scope: any, name: string, values: any[]): any {
    const union = new UnionValue(undefined, undefined, `${scope.qid}.<union@def:${name}>`, undefined)
    for (const f of [...new Set(values.flatMap(definitionsOf))]) union.appendValue(f)
    return union
  }

  /**
   * 编译单元包含（直接或间接）的头文件中的 static 函数在该编译单元内可见。
   * @param ast - .c 文件的 CompileUnit
   * @param modClos - 模块 scope
   */
  private importHeaderStatics(ast: any, modClos: any): void {
    for (const header of ast?._meta?.includes || []) {
      const headerScope = this.moduleScopes.get(header)
      if (!headerScope) continue
      for (const key of Object.keys(headerScope._field || {})) {
        const value = headerScope.getMemberValue(key)
        const defs = definitionsOf(value)
        if (defs.length && defs.every((f: any) => (f.ast?.fdef?.modifiers || []).includes('static'))) {
          modClos.setMemberValue(key, value)
        }
      }
    }
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
      // 整数无法携带命令/路径/SQL/格式串注入，但仍由输入决定：保留为数值污点，供长度类 sink 使用
      if (!result?.taint?.isTaintedRec || typeof result !== 'object') {
        return new PrimitiveValue(scope.qid, `<${callee.name}>`, null, 'number', 'Literal', node.loc)
      }
      this.markNumeric(result)
      return result
    }
    return result
  }

  /**
   * @param value - 值
   * @returns 是否只携带数值污点（atoi 等转换的结果及其算术运算）
   */
  isNumericTaint(value: any): boolean {
    return !!value && typeof value === 'object' && value.cNumericTaint === true
  }

  /**
   * @param value - 标记为数值污点的值
   */
  markNumeric(value: any): void {
    if (value && typeof value === 'object') value.cNumericTaint = true
  }

  /**
   * 算术结果：所有带污点的操作数都是数值污点时，结果仍是数值污点
   * @param result - 运算结果
   * @param operands - 操作数
   * @returns result
   */
  private propagateNumeric(result: any, operands: any[]): any {
    const tainted = operands.filter((v) => v?.taint?.isTaintedRec)
    if (tainted.length > 0 && tainted.every((v) => this.isNumericTaint(v))) this.markNumeric(result)
    return result
  }

  /**
   * @param node - 表达式
   * @returns 声明类型
   */
  cTypeOf(node: any): any {
    return this.types.typeOf(node)
  }

  /**
   * @param scope - scope
   * @param sid - 名称
   * @param node - 产生该值的节点
   * @returns 不带污点的新值
   */
  newCValue(scope: any, sid: string, node: any): any {
    return new ObjectValue(scope.qid, { sid, parent: scope, ast: node })
  }

  /**
   * 库函数写入输出参数：`*p` 形式的目标按指针模型写入被指向的位置
   * @param scope - scope
   * @param target - 位置（Identifier / MemberAccess / DereferenceExpression）
   * @param value - 值
   * @param state - 状态
   */
  writeCLocation(scope: any, target: any, value: any, state: any): void {
    if (target?.type === 'DereferenceExpression') {
      const pointerNode = stripCasts(target.argument)
      const pointerValue = this.processInstruction(scope, pointerNode, state)
      const pointee = pointerValue && typeof pointerValue === 'object' ? this.pointees.get(pointerValue) : undefined
      if (pointee) this.saveVarInScope(pointee.scope, pointee.node, value, state)
      else if (isLocation(pointerNode)) this.saveVarInScope(scope, pointerNode, value, state)
      return
    }
    this.saveVarInScope(scope, target, value, state)
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
    const value = super.processVariableDeclaration(target, node, state)
    // `struct S b = a;`：b 是 a 的副本，而不是同一个对象
    if (node.init && node.init.type !== 'ObjectExpression' && this.types.isStruct(node.varType)) {
      const copy = this.copyAggregate(value, node.varType, target)
      if (copy !== value) this.saveVarInCurrentScope(target, node.id, copy, state)
      return copy
    }
    return value
  }

  /**
   * struct 按值复制：每个字段是独立的存储，嵌套 struct 与数组成员递归复制，
   * 指针成员只复制指针值（仍指向同一被指对象）。
   * @param value - 源对象
   * @param type - 声明类型
   * @param scope - 新对象所在 scope
   * @param depth - 递归深度
   * @returns 副本；不是对象值时原样返回
   */
  private copyAggregate(value: any, type: any, scope: any, depth = 0): any {
    if (!value || typeof value !== 'object' || value.vtype !== 'object' || depth > 16 || this.addresses.has(value)) {
      return value
    }
    const fieldTypes = this.types.fieldsOf(type)
    const elementType = this.types.isArray(type) ? this.types.elementOf(type) : undefined
    const copy = new ObjectValue(scope.qid, { sid: value.sid, parent: scope })
    if (value.taint?.isTainted) copy.taint?.copyFrom(value.taint)
    const keys = new Set<string>([
      ...Object.keys(value._field || {}),
      ...(value.members ? [...value.members.keys()] : []),
    ])
    for (const key of keys) {
      const member = value.getMemberValue(key)
      const memberType = fieldTypes ? fieldTypes.get(key) : elementType
      const byValue = memberType && (this.types.isStruct(memberType) || this.types.isArray(memberType))
      copy.setMemberValue(key, byValue ? this.copyAggregate(member, memberType, scope, depth + 1) : member)
    }
    return copy
  }

  /**
   * 按值传递的 struct 形参是实参的副本：被调函数修改形参不影响调用方。
   * @param fscope - 被调函数 scope
   * @param params - 形参
   * @param state - 状态
   * @param node - 调用节点
   */
  protected override onParamsBound(fscope: any, params: any[], state: any, node: any): void {
    super.onParamsBound(fscope, params, state, node)
    for (const param of params || []) {
      if (!param?.id || !this.types.isStruct(param.varType)) continue
      const value = this._getMemberValueDirect(fscope, param.id, state, false, 0, new Set())
      const copy = this.copyAggregate(value, param.varType, fscope)
      if (copy !== value) this.saveVarInCurrentScope(fscope, param.id, copy, state)
    }
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
    const value = super.processAssignmentExpression(scope, node, state)
    // `b = a;`（struct 类型）：复制而不是让 b 与 a 共享对象
    const leftType = node?.operator === '=' ? this.types.typeOf(node.left) : undefined
    if (leftType && this.types.isStruct(leftType) && isLocation(node.left)) {
      const copy = this.copyAggregate(value, leftType, scope)
      if (copy !== value) this.saveVarInScope(scope, node.left, copy, state)
      return copy
    }
    return value
  }

  /**
   * `*p = v`：写入 p 所指向的存储位置。位置由 `&x` 产生的地址值确定，
   * 多级解引用（`**r = v`）逐级读取中间指针的当前值。
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
    const pointerNode = stripCasts(node.left.argument)
    const pointerValue = this.processInstruction(scope, pointerNode, state)
    const pointee = pointerValue && typeof pointerValue === 'object' ? this.pointees.get(pointerValue) : undefined
    value = SourceLine.addSrcLineInfo(value, node, node.loc?.sourcefile, 'Var Pass:', AstUtil.prettyPrintAST(node.left))
    const leftType = this.types.typeOf(node.left)
    if (
      leftType &&
      this.types.isStruct(leftType) &&
      !this.addresses.has(pointerValue) &&
      pointerValue?.vtype === 'object'
    ) {
      // `*ps = b`：struct 的存储就是被指对象，逐字段覆盖其内容
      const copy = this.copyAggregate(value, leftType, scope)
      if (copy !== pointerValue && copy?.vtype === 'object') {
        const keys = new Set<string>([
          ...Object.keys(copy._field || {}),
          ...(copy.members ? [...copy.members.keys()] : []),
        ])
        for (const key of keys) pointerValue.setMemberValue(key, copy.getMemberValue(key))
        return pointerValue
      }
    }
    if (pointee) {
      this.saveVarInScope(pointee.scope, pointee.node, value, state)
    } else if (!this.addresses.has(pointerValue) && isLocation(pointerNode)) {
      // 指向未知存储（参数、堆）：引擎中指针与被指内容是同一个值，写入指针变量本身
      this.saveVarInScope(scope, pointerNode, value, state)
    }
    return value
  }

  /**
   * `&x`：标量/指针变量的地址是独立于 x 当前值的地址值，记录它指向的位置；
   * struct/数组（以及类型未知时）的存储就是其对象本身，沿用对象引用。
   * @param scope - 当前 scope
   * @param node - ReferenceExpression
   * @param state - 状态
   * @returns 地址值
   */
  override processReferenceExpression(scope: any, node: any, state: any): any {
    const target = stripCasts(node?.argument)
    const targetType = this.types.typeOf(target)
    if (isLocation(target) && targetType && !this.types.isStruct(targetType) && !this.types.isArray(targetType)) {
      const address = new ObjectValue(scope.qid, { sid: `&${AstUtil.prettyPrintAST(target)}`, parent: scope })
      this.pointees.set(address, { scope, node: target })
      this.addresses.add(address)
      return address
    }
    const value = super.processReferenceExpression(scope, node, state)
    if (value && typeof value === 'object' && isLocation(target)) {
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
   * 当前路径不可达（return/break/continue/goto 之后）时跳过语句，直到 goto 的目标标签。
   * @param scope - 当前 scope
   * @param node - 指令
   * @param state - 状态
   * @param prePostFlag - 前/后处理标记
   * @returns 指令结果
   */
  override processInstruction(scope: any, node: any, state: any, prePostFlag?: any): any {
    const { flow } = this
    if (
      flow.dead &&
      node &&
      typeof node === 'object' &&
      !node.vtype &&
      !Array.isArray(node) &&
      !HOISTED.has(node.type) &&
      !containsLabel(node, flow.pending)
    ) {
      return new UndefinedValue()
    }
    return super.processInstruction(scope, node, state, prePostFlag)
  }

  /**
   * 当前路径以 return/break/continue/goto 结束
   * @param kind - 种类
   * @param label - goto 目标
   */
  private abrupt(kind: Abrupt, label?: string): void {
    this.flow.dead = true
    this.flow.reasons = new Set([kind])
    if (label) this.flow.pending.add(label)
  }

  /**
   * @param scope - 当前 scope
   * @param node - ReturnStatement
   * @param state - 状态
   * @returns 返回值
   */
  override processReturnStatement(scope: any, node: any, state: any): any {
    const ret = super.processReturnStatement(scope, node, state)
    this.abrupt('return')
    return ret
  }

  /**
   * @param scope - 当前 scope
   * @param node - BreakStatement
   * @param state - 状态
   * @returns UndefinedValue
   */
  override processBreakStatement(scope: any, node: any, state: any): any {
    this.abrupt('break')
    return super.processBreakStatement(scope, node, state)
  }

  /**
   * @param scope - 当前 scope
   * @param node - ContinueStatement
   * @param state - 状态
   * @returns UndefinedValue
   */
  override processContinueStatement(scope: any, node: any, state: any): any {
    this.abrupt('continue')
    return super.processContinueStatement(scope, node, state)
  }

  /**
   * parser 把 `goto L` 表示为带 `_meta.goto` 的 Noop：跳过后续语句直到标签 L
   * @param scope - 当前 scope
   * @param node - Noop
   * @param state - 状态
   * @returns 结果
   */
  override processNoop(scope: any, node: any, state: any): any {
    const label = node?._meta?.goto
    if (label) {
      const states = this.flow.labelStates.get(label) ?? []
      states.push(this.snapshotScopes(scope))
      this.flow.labelStates.set(label, states)
      this.abrupt('goto', label)
    }
    return super.processNoop(scope, node, state)
  }

  /**
   * 记录当前函数内各层 scope 的变量值（goto 跳转时的状态）
   * @param scope - 当前 scope
   * @returns 快照
   */
  private snapshotScopes(scope: any): ScopeSnapshot {
    const snapshot: ScopeSnapshot = []
    for (let s = scope, depth = 0; s && !s.isCModule && s !== this.topScope && depth < 64; s = s.parent, depth++) {
      const keys = new Set<string>([...Object.keys(s._field || {}), ...(s.members ? [...s.members.keys()] : [])])
      const fields = new Map<string, any>()
      for (const key of keys) fields.set(key, s.getMemberValue(key))
      snapshot.push({ scope: s, fields })
    }
    return snapshot
  }

  /**
   * 把快照中的变量恢复为快照时的值
   * @param snapshot - 快照
   */
  private restoreScopes(snapshot: ScopeSnapshot): void {
    for (const { scope, fields } of snapshot) {
      for (const [key, value] of fields) {
        if (value && scope.getMemberValue(key) !== value) scope.setMemberValue(key, value)
      }
    }
  }

  /**
   * 在标签处合并 goto 跳转来的状态：路径不可达时（只能经 goto 到达）取各次跳转状态的并，
   * 顺序可达时再与当前值合并。
   * @param label - 标签
   * @param resuming - 是否仅能经 goto 到达
   */
  private joinLabelStates(label: string, resuming: boolean): void {
    const snapshots = this.flow.labelStates.get(label)
    if (!snapshots) return
    this.flow.labelStates.delete(label)
    const byScope = new Map<any, Map<string, any[]>>()
    for (const snapshot of snapshots) {
      for (const { scope, fields } of snapshot) {
        const merged = byScope.get(scope) ?? new Map<string, any[]>()
        for (const [key, value] of fields) merged.set(key, [...(merged.get(key) ?? []), value])
        byScope.set(scope, merged)
      }
    }
    for (const [scope, fields] of byScope) {
      for (const [key, values] of fields) {
        const candidates = resuming ? values : [scope.getMemberValue(key), ...values]
        const distinct = [...new Set(candidates.filter((v) => v && typeof v === 'object'))]
        if (distinct.length === 0) continue
        let value = distinct[0]
        if (distinct.length > 1) {
          value = new UnionValue(undefined, undefined, `${scope.qid}.<union@label:${label}:${key}>`, undefined)
          for (const v of distinct) value.appendValue(v)
        }
        if (value !== scope.getMemberValue(key)) scope.setMemberValue(key, value)
      }
    }
  }

  /**
   * 标签语句：路径因 goto 不可达且标签是其目标时恢复执行。
   * @param scope - 当前 scope
   * @param node - LabeledStatement
   * @param state - 状态
   * @returns 语句结果
   */
  processLabeledStatement(scope: any, node: any, state: any): any {
    const { flow } = this
    const label = node?.label?.name
    const resuming = flow.dead && flow.pending.has(label)
    if (resuming) {
      flow.dead = false
      flow.reasons = new Set()
    }
    if (!flow.dead && label) this.joinLabelStates(label, resuming)
    return node?.body ? this.processInstruction(scope, node.body, state) : new UndefinedValue()
  }

  /**
   * if/switch 的一个分支：从可达状态开始执行，结束时记录分支的控制流状态。
   * @param scope - 当前 scope
   * @param node - 分支包装节点（type `CBranch`）
   * @param state - 状态
   * @returns UndefinedValue
   */
  processCBranch(scope: any, node: any, state: any): any {
    const { flow } = this
    flow.dead = false
    flow.reasons = new Set()
    const before = node.snapshot ? this.snapshotScopes(scope) : undefined
    this.processInstruction(scope, node.body, state)
    node.results.push({ dead: flow.dead, reasons: flow.reasons, before })
    flow.dead = false
    flow.reasons = new Set()
    return new UndefinedValue()
  }

  /**
   * 包装分支，使每个分支从可达状态开始并记录其结束状态
   * @param body - 分支语句
   * @param results - 结果收集
   * @returns 包装节点
   */
  private branch(body: any, results: BranchResult[]): any {
    if (!body || (body.type === 'Noop' && !body._meta?.goto)) return body
    return { type: 'CBranch', body, results, loc: body.loc, _meta: {} }
  }

  /**
   * 汇合分支：所有执行到的分支都突然完成时，if 之后不可达。
   * @param results - 分支结果
   * @param exhaustive - 分支是否覆盖所有路径（有 else / default）
   * @param exclude - 在此语句处被消耗的种类（switch 的 break）
   */
  private joinBranches(results: BranchResult[], exhaustive: boolean, exclude?: Abrupt): void {
    const { flow } = this
    const allDead =
      exhaustive && results.length > 0 && results.every((r) => r.dead && !(exclude && r.reasons.has(exclude)))
    flow.dead = allDead
    flow.reasons = new Set(allDead ? results.flatMap((r) => [...r.reasons]) : [])
  }

  /**
   * 常量条件（`if (0)`、`if (1 - 1)`）只执行可达分支；其余情况两个分支都执行，
   * 两者都 return/goto 时之后的语句不可达。
   * @param scope - 当前 scope
   * @param node - IfStatement
   * @param state - 状态
   * @returns 语句结果
   */
  override processIfStatement(scope: any, node: any, state: any): any {
    const constant = foldConstant(node?.test)
    if (constant !== undefined) {
      const taken = constant ? node.consequent : node.alternative
      return taken ? this.processInstruction(scope, taken, state) : new UndefinedValue()
    }
    const results: BranchResult[] = []
    const consequent = this.branch(node.consequent, results)
    const alternative = this.branch(node.alternative, results)
    // `if (c) { ...; return; }`：只有不进入分支的路径会继续执行，分支内的写入不应流到 if 之后
    // （条件本身的副作用保留：快照在进入分支时、条件求值之后记录）
    if (alternative === node.alternative && consequent?.type === 'CBranch') consequent.snapshot = true
    const ret = super.processIfStatement(scope, { ...node, consequent, alternative }, state)
    const result = results[0]
    if (results.length === 1 && result.dead && result.before && [...result.reasons].every((r) => r === 'return')) {
      this.restoreScopes(result.before)
    }
    this.joinBranches(results, alternative !== node.alternative)
    return ret
  }

  /**
   * switch：每个 case 独立执行；break 在 switch 处被消耗。
   * @param scope - 当前 scope
   * @param node - SwitchStatement
   * @param state - 状态
   * @returns 语句结果
   */
  override processSwitchStatement(scope: any, node: any, state: any): any {
    const results: BranchResult[] = []
    const cases = (node.cases || []).map((c: any) => ({ ...c, body: this.branch(c.body, results) }))
    const ret = super.processSwitchStatement(scope, { ...node, cases }, state)
    const hasDefault = cases.some((c: any) => !c.test || c.test.type === 'Noop')
    this.joinBranches(results, hasDefault, 'break')
    return ret
  }

  /**
   * 三目运算符：条件为常量时只求值被选中的分支
   * @param scope - 当前 scope
   * @param node - ConditionalExpression
   * @param state - 状态
   * @returns 值
   */
  override processConditionalExpression(scope: any, node: any, state: any): any {
    const constant = foldConstant(node?.test)
    if (constant === undefined) return super.processConditionalExpression(scope, node, state)
    return this.processInstruction(scope, constant ? node.consequent : node.alternative, state)
  }

  /**
   * `&&`/`||` 短路：左侧为常量且已决定结果时右侧不求值（`0 && (p = x)`）。
   * @param scope - 当前 scope
   * @param node - BinaryExpression
   * @param state - 状态
   * @returns 值
   */
  override processBinaryExpression(scope: any, node: any, state: any): any {
    if (node?.operator === '&&' || node?.operator === '||') {
      const left = foldConstant(node.left)
      if (left !== undefined && (node.operator === '&&') === (left === 0)) {
        const result = node.operator === '||' ? 1 : 0
        return new PrimitiveValue(scope.qid, `<literal_${result}>`, result, 'number', 'Literal', node.loc)
      }
    }
    const result = super.processBinaryExpression(scope, node, state)
    return this.propagateNumeric(result, [result?.left, result?.right])
  }

  /**
   * 执行一轮循环体
   * @param scope - 当前 scope
   * @param body - 循环体
   * @param state - 状态
   * @returns 循环体突然完成的种类；顺序执行到末尾时为 undefined
   */
  private runLoopBody(scope: any, body: any, state: any): Set<Abrupt> | undefined {
    const { flow } = this
    flow.dead = false
    this.processInstruction(scope, body, state)
    const reasons = flow.dead ? flow.reasons : undefined
    flow.dead = false
    flow.reasons = new Set()
    return reasons
  }

  /**
   * 循环按两轮展开（与引擎基类一致），并处理 break/continue/return：
   * 条件为常量 0 时不执行；循环体无条件 break/return 时只执行一轮；
   * 确定进入且以 return/goto 离开时，循环之后不可达。
   * @param scope - 当前 scope
   * @param node - ForStatement / WhileStatement
   * @param state - 状态
   * @param postTest - do-while
   */
  private runLoop(scope: any, node: any, state: any, postTest: boolean): void {
    let entered = postTest
    let exitReasons: Set<Abrupt> | undefined
    for (let round = 0; round < 2; round++) {
      if (!(postTest && round === 0)) {
        const test = node.test ? foldConstant(node.test) : 1
        if (node.test) this.processInstruction(scope, node.test, state)
        if (test === 0) break
        if (round === 0 && test !== undefined) entered = true
      }
      const reasons = this.runLoopBody(scope, node.body, state)
      if (reasons && !reasons.has('continue')) {
        exitReasons = reasons
        break
      }
      if (node.update) this.processInstruction(scope, node.update, state)
    }
    const leaves = !!exitReasons && [...exitReasons].every((r) => r === 'return' || r === 'goto')
    this.flow.dead = entered && leaves
    this.flow.reasons = this.flow.dead ? exitReasons! : new Set()
  }

  /**
   * @param scope - 当前 scope
   * @param node - WhileStatement（isPostTest 为 do-while）
   * @param state - 状态
   * @returns UndefinedValue
   */
  override processWhileStatement(scope: any, node: any, state: any): any {
    StateUtil.pushLoopInfo(state, node)
    this.runLoop(scope, node, state, !!node?.isPostTest)
    StateUtil.popLoopInfo(state)
    return new UndefinedValue()
  }

  /**
   * @param scope - 当前 scope
   * @param node - ForStatement
   * @param state - 状态
   * @returns UndefinedValue
   */
  override processForStatement(scope: any, node: any, state: any): any {
    StateUtil.pushLoopInfo(state, node)
    if (node.init) this.processInstruction(scope, node.init, state)
    this.runLoop(scope, node, state, false)
    StateUtil.popLoopInfo(state)
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
    // 被调函数的 return 只结束被调函数
    const callerFlow = this.flow
    this.flow = liveFlow()
    let ret
    try {
      ret = super.executeCall(node, fclos, state, scope, callInfo)
    } finally {
      this.flow = callerFlow
    }
    if (node?.type === 'CallExpression' && !fclos?.ast?.fdef) {
      applyCLibraryModel(this, node, scope, state, callInfo)
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
