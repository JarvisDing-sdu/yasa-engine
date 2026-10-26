/* eslint-disable no-bitwise -- C 整数常量表达式的位运算 */
/**
 * C 整数常量表达式求值（C11 6.6）：只看语法，不读变量。
 * 用于折叠 `if (1 - 1)`、`0 && x`、`while (0)` 这类编译期可确定的条件。
 */

/**
 * @param node - 表达式 AST
 * @returns 常量值；无法在编译期确定时返回 undefined
 */
export function foldConstant(node: any): number | undefined {
  if (!node) return undefined
  switch (node.type) {
    case 'Literal': {
      const { value } = node
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
      if (typeof value === 'boolean') return value ? 1 : 0
      // 字符串字面量是非空指针
      if (typeof value === 'string' && node.literalType === 'string') return 1
      return undefined
    }
    case 'CastExpression':
      return foldConstant(node.expression)
    case 'Sequence': {
      const exprs = node.expressions || []
      return exprs.length ? foldConstant(exprs[exprs.length - 1]) : undefined
    }
    case 'UnaryExpression': {
      const v = foldConstant(node.argument)
      if (v === undefined) return undefined
      switch (node.operator) {
        case '!':
          return v ? 0 : 1
        case '-':
          return -v
        case '+':
          return v
        case '~':
          return ~v
        default:
          return undefined
      }
    }
    case 'ConditionalExpression': {
      const t = foldConstant(node.test)
      if (t === undefined) return undefined
      return foldConstant(t ? node.consequent : node.alternative)
    }
    case 'BinaryExpression':
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- 与 foldBinary 互相递归
      return foldBinary(node)
    default:
      return undefined
  }
}

/**
 * @param node - BinaryExpression
 * @returns 常量值或 undefined
 */
function foldBinary(node: any): number | undefined {
  const l = foldConstant(node.left)
  // 短路：右侧不求值，未知也不影响结果
  if (node.operator === '&&' && l === 0) return 0
  if (node.operator === '||' && l !== undefined && l !== 0) return 1
  const r = foldConstant(node.right)
  if (l === undefined || r === undefined) return undefined
  switch (node.operator) {
    case '&&':
      return r ? 1 : 0
    case '||':
      return r ? 1 : 0
    case '+':
      return l + r
    case '-':
      return l - r
    case '*':
      return l * r
    case '/':
      return r === 0 ? undefined : Math.trunc(l / r)
    case '%':
      return r === 0 ? undefined : l % r
    case '<<':
      return l << r
    case '>>':
      return l >> r
    case '&':
      return l & r
    case '|':
      return l | r
    case '^':
      return l ^ r
    case '==':
      return Number(l === r)
    case '!=':
      return Number(l !== r)
    case '<':
      return Number(l < r)
    case '>':
      return Number(l > r)
    case '<=':
      return Number(l <= r)
    case '>=':
      return Number(l >= r)
    default:
      return undefined
  }
}
