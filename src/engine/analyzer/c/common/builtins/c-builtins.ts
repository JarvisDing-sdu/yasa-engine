/**
 * C 标准库输出参数的污点模型
 *
 * 引擎对无函数体的库函数默认只做 arg→ret 传播。C 的字符串/内存函数却把结果
 * 写进调用方传入的缓冲区（strcpy(dst, src)、sprintf(buf, fmt, x)），因此需要
 * 额外把污点写回输出参数，否则 `strcpy(buf, tainted); system(buf)` 会断链。
 */
import { getLegacyArgValues } from '../../../common/call-args'

const SourceLine = require('../../../common/source-line')

/** dst: 输出参数下标；src: 输入参数下标，`from` 表示从该下标起的全部可变参数 */
interface OutParamModel {
  dst: number[] | { from: number }
  src: number[] | { from: number }
}

const MODELS: Record<string, OutParamModel> = {
  strcpy: { dst: [0], src: [1] },
  strncpy: { dst: [0], src: [1] },
  stpcpy: { dst: [0], src: [1] },
  stpncpy: { dst: [0], src: [1] },
  strlcpy: { dst: [0], src: [1] },
  strcat: { dst: [0], src: [0, 1] },
  strncat: { dst: [0], src: [0, 1] },
  strlcat: { dst: [0], src: [0, 1] },
  wcscpy: { dst: [0], src: [1] },
  wcsncpy: { dst: [0], src: [1] },
  wcscat: { dst: [0], src: [0, 1] },
  wcsncat: { dst: [0], src: [0, 1] },
  wmemcpy: { dst: [0], src: [1] },
  wmemmove: { dst: [0], src: [1] },
  memcpy: { dst: [0], src: [1] },
  memmove: { dst: [0], src: [1] },
  mempcpy: { dst: [0], src: [1] },
  memccpy: { dst: [0], src: [1] },
  bcopy: { dst: [1], src: [0] },
  sprintf: { dst: [0], src: { from: 1 } },
  vsprintf: { dst: [0], src: { from: 1 } },
  snprintf: { dst: [0], src: { from: 2 } },
  vsnprintf: { dst: [0], src: { from: 2 } },
  swprintf: { dst: [0], src: { from: 2 } },
  vswprintf: { dst: [0], src: { from: 2 } },
  _snwprintf: { dst: [0], src: { from: 2 } },
  _snprintf: { dst: [0], src: { from: 2 } },
  sscanf: { dst: { from: 2 }, src: [0] },
  vsscanf: { dst: { from: 2 }, src: [0] },
  realpath: { dst: [1], src: [0] },
  strtok_r: { dst: [2], src: [0] },
}

function indexes(spec: number[] | { from: number }, argc: number): number[] {
  if (Array.isArray(spec)) return spec.filter((i) => i < argc)
  const result: number[] = []
  for (let i = spec.from; i < argc; i++) result.push(i)
  return result
}

/** `&x`、`(char *)x`、`*p`、`buf + n`、`&buf[i]` 写入的都是 x/p/buf 这个变量 */
function writeTarget(node: any): any {
  let current = node
  while (current) {
    if (current.type === 'ReferenceExpression' || current.type === 'DereferenceExpression') current = current.argument
    else if (current.type === 'CastExpression') current = current.expression
    else if (current.type === 'BinaryExpression' && (current.operator === '+' || current.operator === '-'))
      current = current.left
    else if (current.type === 'MemberAccess' && current.computed) current = current.object
    else break
  }
  if (!current) return null
  if (current.type === 'Identifier' || current.type === 'MemberAccess') return current
  return null
}

function calleeName(node: any): string | undefined {
  const callee = node?.callee
  if (callee?.type === 'Identifier') return callee.name
  return undefined
}

/**
 * 在库函数调用后应用输出参数模型。返回值 `ret` 已由引擎的 arg→ret 默认路径
 * 携带输入参数的污点，直接写入输出参数即可保留完整 trace。
 * @param analyzer - CAnalyzer
 * @param node - CallExpression
 * @param scope - 调用所在 scope
 * @param state - 状态
 * @param callInfo - 调用信息
 * @param ret - 调用返回值
 */
export function applyCLibraryModel(analyzer: any, node: any, scope: any, state: any, callInfo: any, ret: any): void {
  const name = calleeName(node)
  if (!name || !Object.prototype.hasOwnProperty.call(MODELS, name)) return
  const model = MODELS[name]
  const args = node.arguments || []
  const argValues = getLegacyArgValues(callInfo)
  const tainted = indexes(model.src, args.length).some((i) => argValues[i]?.taint?.isTaintedRec)
  if (!tainted || !ret || typeof ret !== 'object') return

  for (const i of indexes(model.dst, args.length)) {
    const target = writeTarget(args[i])
    if (!target) continue
    const value = SourceLine.addSrcLineInfo(ret, node, node.loc?.sourcefile, 'Var Pass:', target.name ?? name)
    analyzer.saveVarInScope(scope, target, value, state)
  }
}

export const C_OUT_PARAM_FUNCTIONS = Object.keys(MODELS)
