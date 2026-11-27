type Address = string | undefined

const arrayKind = Symbol('array address')
const sortedOperators = new Set(['+', '-', '*', '&&', '||', '&', '|', '^', '==', '!='])

/** Iteration state for one compound key. Each frame consumes child addresses in DFS order. */
class AddressFrame {
  index = 0
  text = ''
  left: Address
  list: any
  length = 0
  keys?: string[]
  parents?: Set<any>
  computed?: boolean

  constructor(readonly node: any, readonly kind: string | typeof arrayKind) {}
}

function suffix(id: Address): Address {
  return id && id.length > 100 ? id.slice(-100) : id
}

/**
 * A back edge reads "__". A completed shared operand reuses its 100-character
 * suffix. Each call starts fresh because references and branch alternatives can change.
 */
function toStringID(root: any): Address {
  const visited = new Map<any, string>()
  const pending: AddressFrame[] = []
  let node = root
  let result: Address
  visit: for (;;) {
    result = node ? visited.get(node) : undefined
    if (node && result === undefined) {
      let frame: AddressFrame | undefined
      const kind = Array.isArray(node) ? arrayKind : node.type
      switch (kind) {
        case 'ThisExpression':
          result = 'this'
          break
        case 'Noop':
          result = 'Noop'
          break
        case 'Literal':
          result = String(node.value)
          break
        case 'Identifier':
        case 'Parameter':
        case 'VariableDeclarator':
          result = node.id?.name || node.name
          break
        case 'MemberAccess': {
          const object = node.object
          frame = new AddressFrame(node, object && object.vtype !== 'scope' ? 'member' : 'property')
          if (frame.kind === 'member') {
            frame.list = object
            frame.computed = node.computed
          }
          break
        }
        case 'UnaryOperation':
          frame = new AddressFrame(node, kind)
          if (node.isPrefix) {
            frame.computed = true
            frame.left = node.operator
          }
          break
        case 'BinaryExpression':
        case 'CallExpression':
          frame = new AddressFrame(node, kind)
          break
        case arrayKind:
        case 'TupleExpression':
        case 'NewExpression':
          frame = new AddressFrame(node, kind)
          frame.list = kind === arrayKind ? node : kind === 'TupleExpression' ? node.elements : node.arguments
          frame.length = frame.list.length
          break
        default:
          switch (node.vtype) {
            case 'object':
              frame = new AddressFrame(node, 'object')
              frame.list = node.parent
              frame.left = node.sid
              break
            case 'union':
              frame = new AddressFrame(node, 'union')
              frame.list = node.value[Symbol.iterator]()
              frame.text = '{'
              break
            case 'BVT':
              frame = new AddressFrame(node, 'BVT')
              frame.keys = []
              frame.list = node.children
              for (const key in frame.list) frame.keys.push(key)
              frame.text = 'bvt{'
              break
          }
      }
      if (frame) {
        visited.set(node, '__')
        pending.push(frame)
      } else {
        result = suffix(result)
        visited.set(node, result || '__')
      }
    }

    while (pending.length) {
      const frame = pending[pending.length - 1]
      const expression = frame.node
      const step = frame.index++
      switch (frame.kind) {
        case 'property':
          if (!step) {
            node = expression.property
            continue visit
          }
          break
        case 'member':
          if (!step) {
            node = frame.list
            continue visit
          }
          if (step === 1) {
            frame.left = result
            node = expression.property
            continue visit
          }
          result = frame.computed ? `${frame.left}[${result}]` : `${frame.left}.${result}`
          break
        case 'BinaryExpression': {
          if (!step) {
            node = expression.left
            continue visit
          }
          if (step === 1) {
            frame.left = result || ''
            node = expression.right
            continue visit
          }
          const left = frame.left!
          const right = result || ''
          const operator = expression.operator
          result = sortedOperators.has(operator) && !(left < right) ? right + operator + left : left + operator + right
          break
        }
        case 'UnaryOperation':
          if (!step) {
            node = expression.subExpression
            continue visit
          }
          result = frame.computed ? frame.left! + result : result + expression.operator
          break
        case 'CallExpression':
          if (!step) {
            node = expression.callee
            continue visit
          }
          if (step === 1) {
            frame.left = result
            frame.list = expression.arguments
            frame.length = frame.list.length
          }
          // fall through to the argument list
        case arrayKind:
        case 'TupleExpression':
        case 'NewExpression': {
          const i = frame.kind === 'CallExpression' ? step - 1 : step
          if (i > 0) frame.text += (i > 1 ? ',' : '') + (result ?? '')
          if (i < frame.length) {
            node = frame.list[i]
            continue visit
          }
          result = frame.text
          if (frame.kind === 'CallExpression') result = `${frame.left}(${result})`
          if (frame.kind === 'NewExpression') result = `new ${expression.callee.name}(${result})`
          if (frame.kind === 'TupleExpression') result = `<${result}>`
          break
        }
        case 'object': {
          if (step) {
            frame.left = `${result}.${frame.left}`
            frame.list = frame.list.parent
          }
          const parent = frame.list
          if (parent && parent.vtype !== 'scope' && parent.vtype !== 'fclos' && !parent.type) {
            frame.parents ??= new Set()
            if (!frame.parents.has(parent)) {
              frame.parents.add(parent)
              node = parent
              continue visit
            }
          }
          result = parent?.vtype === 'fclos' ? `${parent.sid}.${frame.left}` : frame.left
          break
        }
        case 'union': {
          if (step) frame.text += `${result}|`
          const item = frame.list.next()
          if (!item.done) {
            node = item.value
            continue visit
          }
          result = frame.text + '}'
          break
        }
        case 'BVT':
          if (step) frame.text += `${result},`
          while (frame.index <= frame.keys!.length) {
            const key = frame.keys![frame.index - 1]
            if (key in frame.list) {
              node = expression.children[key]
              continue visit
            }
            frame.index++
          }
          result = frame.text + '}'
          break
      }
      result = suffix(result)
      visited.set(expression, result || '__')
      pending.pop()
    }
    return result
  }
}

export = { toStringID }
