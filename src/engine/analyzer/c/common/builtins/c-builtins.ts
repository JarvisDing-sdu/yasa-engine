/**
 * C 标准库输出参数的污点模型
 *
 * 引擎对无函数体的库函数默认只做 arg→ret 传播。C 的字符串/内存函数却把结果
 * 写进调用方传入的缓冲区（strcpy(dst, src)、sprintf(buf, fmt, x)），因此需要
 * 按函数语义写回输出参数：
 * - 完整覆盖（strcpy、sprintf、长度覆盖整个缓冲区的 memcpy/memset）后，dst 只携带写入内容的污点；
 * - 部分写入（strcat、带偏移的目标、长度小于缓冲区的 memcpy/memset）保留 dst 原有内容；
 * - 长度为常量 0 时不写入；
 * - 格式化函数只有被格式串实际消耗的实参参与写入；数值转换（%d/%x/%f...）写入的只是数字文本，
 *   结果为数值污点：不构成命令/路径/SQL 注入，但对长度与格式串类 sink 仍然危险。
 */
import { getLegacyArgValues } from '../../../common/call-args'

const AstUtil = require('../../../../../util/ast-util')
const SourceLine = require('../../../common/source-line')
const { foldConstant } = require('../c-const-eval')
const { shallowCopyValue } = require('../../../../../util/clone-util')
const {
  valueUtil: {
    ValueUtil: { UnionValue },
  },
} = require('../../../common')

type Kind = 'copy' | 'append' | 'format' | 'fill' | 'scan'

interface OutParamModel {
  kind: Kind
  /** 输出参数下标 */
  dst: number
  /** 输入参数下标（copy/append/scan） */
  src?: number[]
  /** 长度参数下标：常量 0 不写入，覆盖整个 dst 时为完整写入 */
  len?: number
  /** 格式串下标（format/scan） */
  fmt?: number
  /** 字符串复制：内容由 src 完全决定（NUL 结尾） */
  terminated?: boolean
  /** v* 变体：可变参数在 va_list 中，无法按格式串对应 */
  vaList?: boolean
}

const copy = (dst: number, src: number, extra: Partial<OutParamModel> = {}): OutParamModel => ({
  kind: 'copy',
  dst,
  src: [src],
  ...extra,
})
const format = (fmt: number, extra: Partial<OutParamModel> = {}): OutParamModel => ({
  kind: 'format',
  dst: 0,
  fmt,
  ...extra,
})

const MODELS: Record<string, OutParamModel> = {
  strcpy: copy(0, 1, { terminated: true }),
  stpcpy: copy(0, 1, { terminated: true }),
  wcscpy: copy(0, 1, { terminated: true }),
  strlcpy: copy(0, 1, { terminated: true }),
  strncpy: copy(0, 1, { len: 2 }),
  stpncpy: copy(0, 1, { len: 2 }),
  wcsncpy: copy(0, 1, { len: 2 }),
  strcat: { kind: 'append', dst: 0, src: [1] },
  strncat: { kind: 'append', dst: 0, src: [1], len: 2 },
  strlcat: { kind: 'append', dst: 0, src: [1] },
  wcscat: { kind: 'append', dst: 0, src: [1] },
  wcsncat: { kind: 'append', dst: 0, src: [1], len: 2 },
  memcpy: copy(0, 1, { len: 2 }),
  memmove: copy(0, 1, { len: 2 }),
  mempcpy: copy(0, 1, { len: 2 }),
  memccpy: copy(0, 1, { len: 3 }),
  wmemcpy: copy(0, 1, { len: 2 }),
  wmemmove: copy(0, 1, { len: 2 }),
  bcopy: copy(1, 0, { len: 2 }),
  memset: { kind: 'fill', dst: 0, len: 2 },
  wmemset: { kind: 'fill', dst: 0, len: 2 },
  bzero: { kind: 'fill', dst: 0, len: 1 },
  explicit_bzero: { kind: 'fill', dst: 0, len: 1 },
  sprintf: format(1),
  vsprintf: format(1, { vaList: true }),
  snprintf: format(2, { len: 1 }),
  vsnprintf: format(2, { len: 1, vaList: true }),
  _snprintf: format(2, { len: 1 }),
  swprintf: format(2, { len: 1 }),
  vswprintf: format(2, { len: 1, vaList: true }),
  _snwprintf: format(2, { len: 1 }),
  sscanf: { kind: 'scan', dst: 2, src: [0], fmt: 1 },
  vsscanf: { kind: 'scan', dst: 2, src: [0], fmt: 1, vaList: true },
  realpath: copy(1, 0, { terminated: true }),
  strtok_r: copy(2, 0, { terminated: true }),
}

/** 只产生数字文本的转换：不携带命令/路径/格式串等注入内容 */
const NUMERIC_CONVERSIONS = new Set('diouxXeEfFgGaAp'.split(''))

/** 格式串中的一次转换 */
interface Conversion {
  /** 读取的实参个数（`*` 宽度/精度各占一个） */
  starArgs: number
  conversion: string
  /** 读取实参（`%%` 与 scanf 的 `%*d` 不读取） */
  consumes: boolean
}

/**
 * 解析 printf/scanf 格式串
 * @param fmt - 格式串
 * @param scanf - scanf 族（`*` 表示不赋值）
 * @returns 转换列表
 */
export function parseFormat(fmt: string, scanf = false): Conversion[] {
  const result: Conversion[] = []
  const re = /%([-+ #0'*]*)(\d+\$)?(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|j|z|t|q|I64|I32|I)?(\[[^\]]*\]|.)/g
  for (let m = re.exec(fmt); m; m = re.exec(fmt)) {
    const [, flags, , width, precision, , conversion] = m
    if (conversion === '%') continue
    if (scanf) {
      result.push({ starArgs: 0, conversion, consumes: !flags.includes('*') })
    } else {
      const starArgs = Number(width === '*' || flags.includes('*')) + Number(precision === '*')
      result.push({ starArgs, conversion, consumes: true })
    }
  }
  return result
}

/**
 * 字符串字面量的值
 * @param node - 表达式
 * @returns 字符串；不是字面量时为 undefined
 */
function stringLiteral(node: any): string | undefined {
  let current = node
  while (current?.type === 'CastExpression') current = current.expression
  return current?.type === 'Literal' && typeof current.value === 'string' ? current.value : undefined
}

/** 写入目标：存储位置与是否只写入其中一部分 */
interface WriteTarget {
  node: any
  partial: boolean
}

/**
 * `&x`、`(char *)x`、`buf + n`、`&buf[i]` 写入的都是 x/buf；`*p` 写入 p 指向的位置；带非零偏移的目标只写入一部分
 * @param node - 实参 AST
 * @returns 写入目标
 */
function writeTarget(node: any): WriteTarget | null {
  let current = node
  let partial = false
  while (current) {
    if (current.type === 'ReferenceExpression') current = current.argument
    else if (current.type === 'CastExpression') current = current.expression
    else if (current.type === 'BinaryExpression' && (current.operator === '+' || current.operator === '-')) {
      if (foldConstant(current.right) !== 0) partial = true
      current = current.left
    } else if (current.type === 'MemberAccess' && current.computed) {
      if (foldConstant(current.property) !== 0) partial = true
      current = current.object
    } else break
  }
  if (!current) return null
  if (['Identifier', 'MemberAccess', 'DereferenceExpression'].includes(current.type)) return { node: current, partial }
  return null
}

/**
 * 长度实参是否覆盖整个目标：`sizeof dst`、`sizeof(dst)`，或不小于 dst 声明的数组长度的常量
 * @param analyzer - CAnalyzer
 * @param lenNode - 长度实参
 * @param target - 写入目标
 * @returns 是否完整覆盖
 */
function coversTarget(analyzer: any, lenNode: any, target: WriteTarget): boolean {
  let len = lenNode
  while (len?.type === 'CastExpression') len = len.expression
  if (len?.type === 'CallExpression' && len.callee?.type === 'Identifier' && len.callee.name === 'sizeof') {
    const arg = writeTarget(len.arguments?.[0])
    return !!arg && !arg.partial && AstUtil.prettyPrintAST(arg.node) === AstUtil.prettyPrintAST(target.node)
  }
  const n = foldConstant(len)
  const size = foldConstant(analyzer.cTypeOf(target.node)?.size)
  return n !== undefined && size !== undefined && n >= size
}

/**
 * 由若干输入值派生写入 dst 的新值：没有污点输入时是干净的新值；
 * 否则是污点输入（多个时为其并集）的副本，保留其中的污点与 trace。
 * 污点输入全部是数值（atoi 的结果、按 %d 等格式化的实参）时，结果是数值污点。
 * @param analyzer - CAnalyzer
 * @param scope - scope
 * @param node - 调用
 * @param sources - 输入值
 * @param name - 目标名（trace 显示）
 * @param numericInputs - 只以数字文本写入的输入
 * @returns 新值
 */
function derive(analyzer: any, scope: any, node: any, sources: any[], name: string, numericInputs = new Set<any>()): any {
  const tainted = [...new Set(sources.filter((v) => v && typeof v === 'object' && v.taint?.isTaintedRec))]
  if (tainted.length === 0) return analyzer.newCValue(scope, `<${name}>`, node)
  let value
  if (tainted.length === 1) {
    value = shallowCopyValue(tainted[0])
  } else {
    value = new UnionValue(undefined, undefined, `${scope.qid}.<union@${name}:${node.loc?.start?.line}>`, node)
    for (const v of tainted) value.appendValue(v)
  }
  if (tainted.every((v) => numericInputs.has(v) || analyzer.isNumericTaint(v))) analyzer.markNumeric(value)
  return SourceLine.addSrcLineInfo(value, node, node.loc?.sourcefile, 'Var Pass:', name)
}

/**
 * 格式化函数实际读取的实参
 * @param model - 模型
 * @param args - 实参 AST
 * @param argValues - 实参值
 * @returns 参与写入内容的值（格式串本身与被转换读取的实参），以及其中只按数值转换（%d/%x/%f...）写入的值
 */
function formatSources(model: OutParamModel, args: any[], argValues: any[]): { sources: any[]; numeric: Set<any> } {
  const fmtIndex = model.fmt!
  const fmt = stringLiteral(args[fmtIndex])
  const rest = argValues.slice(fmtIndex + 1)
  if (fmt === undefined || model.vaList) return { sources: [argValues[fmtIndex], ...rest], numeric: new Set() }
  const textual = new Set<any>()
  const numeric = new Set<any>()
  let next = 0
  for (const conv of parseFormat(fmt)) {
    // `*` 宽度/精度读取 int 实参，只影响填充长度
    for (let i = 0; i < conv.starArgs; i++) numeric.add(rest[next++])
    if (!conv.consumes || conv.conversion === 'n') {
      if (conv.consumes) next++
      continue
    }
    const value = rest[next++]
    if (NUMERIC_CONVERSIONS.has(conv.conversion)) numeric.add(value)
    else textual.add(value)
  }
  for (const v of textual) numeric.delete(v)
  return { sources: [...textual, ...numeric], numeric }
}

/**
 * strncpy(dst, "lit", n)：n 大于字面量长度时写入完整字符串（含 NUL），等同完整覆盖
 * @param args - 实参
 * @param model - 模型
 * @returns 是否完整覆盖
 */
function stringCopyCovers(args: any[], model: OutParamModel): boolean {
  const src = stringLiteral(args[model.src![0]])
  const n = model.len === undefined ? undefined : foldConstant(args[model.len])
  return src !== undefined && n !== undefined && n > src.length
}

/**
 * sscanf(src, fmt, &a, &b)：按格式串把输入写入各输出参数；数值转换的结果只携带数值污点。
 * @param analyzer - CAnalyzer
 * @param model - 模型
 * @param node - 调用
 * @param scope - scope
 * @param state - 状态
 * @param args - 实参 AST
 * @param argValues - 实参值
 */
function applyScan(
  analyzer: any,
  model: OutParamModel,
  node: any,
  scope: any,
  state: any,
  args: any[],
  argValues: any[]
): void {
  const input = (model.src || []).map((i) => argValues[i])
  if (!input.some((v) => v?.taint?.isTaintedRec)) return
  const fmt = stringLiteral(args[model.fmt!])
  const conversions = fmt === undefined || model.vaList ? undefined : parseFormat(fmt, true).filter((c) => c.consumes)
  for (let i = model.dst; i < args.length; i++) {
    const conv = conversions?.[i - model.dst]
    if (conversions && !conv) break
    const target = writeTarget(args[i])
    if (!target) continue
    const value = derive(analyzer, scope, node, input, AstUtil.prettyPrintAST(target.node))
    if (conv && NUMERIC_CONVERSIONS.has(conv.conversion)) analyzer.markNumeric(value)
    analyzer.writeCLocation(scope, target.node, value, state)
  }
}

/**
 * 在库函数调用后应用输出参数模型。
 * @param analyzer - CAnalyzer
 * @param node - CallExpression
 * @param scope - 调用所在 scope
 * @param state - 状态
 * @param callInfo - 调用信息
 */
export function applyCLibraryModel(analyzer: any, node: any, scope: any, state: any, callInfo: any): void {
  const name = node?.callee?.type === 'Identifier' ? node.callee.name : undefined
  if (!name || !Object.prototype.hasOwnProperty.call(MODELS, name)) return
  const model = MODELS[name]
  const args: any[] = node.arguments || []
  const argValues = getLegacyArgValues(callInfo)
  if (model.len !== undefined && foldConstant(args[model.len]) === 0) return

  if (model.kind === 'scan') {
    applyScan(analyzer, model, node, scope, state, args, argValues)
    return
  }
  const target = writeTarget(args[model.dst])
  if (!target) return
  const targetName = AstUtil.prettyPrintAST(target.node)
  const full =
    !target.partial &&
    (model.kind === 'format' ||
      model.terminated ||
      (model.len !== undefined && coversTarget(analyzer, args[model.len], target)) ||
      (model.kind === 'copy' && stringCopyCovers(args, model)))

  let sources: any[]
  let numeric = new Set<any>()
  if (model.kind === 'fill') sources = []
  else if (model.kind === 'format') ({ sources, numeric } = formatSources(model, args, argValues))
  else sources = (model.src || []).map((i) => argValues[i])
  if (model.kind === 'append' || !full) {
    const old = analyzer.processInstruction(scope, target.node, state)
    // 部分写入且没有新的污点内容：dst 保持原值
    if (!sources.some((v) => v?.taint?.isTaintedRec)) return
    sources = [old, ...sources]
  }
  analyzer.writeCLocation(scope, target.node, derive(analyzer, scope, node, sources, targetName, numeric), state)
}

export const C_OUT_PARAM_FUNCTIONS = Object.keys(MODELS)
