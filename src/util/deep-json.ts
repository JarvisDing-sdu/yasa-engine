/**
 * Serialize an AST without recursing through deeply nested expressions.
 * @param root - The JSON-compatible value to serialize.
 * @param replacer - Optional JSON property transformation.
 * @returns The serialized value, or undefined for an unsupported root value.
 */
export function stringifyDeepJson(root: unknown, replacer?: (key: string, value: any) => any): string | undefined {
  type Frame = { value: any; keys: string[]; index: number; first: boolean; array: boolean }
  const active = new Set<object>()
  const frames: Frame[] = []
  const chunks: string[] = []

  // Prepare each property in visitation order, just as JSON.stringify does.
  const prepare = (holder: any, key: string): any => {
    let value = holder[key]
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'bigint') &&
      typeof value.toJSON === 'function'
    ) {
      value = value.toJSON(key)
    }
    return replacer ? replacer.call(holder, key, value) : value
  }
  const append = (value: any): void => {
    if (value === null || typeof value !== 'object') {
      chunks.push(JSON.stringify(value))
      return
    }
    if (active.has(value)) throw new TypeError('Converting circular structure to JSON')
    active.add(value)
    const array = Array.isArray(value)
    chunks.push(array ? '[' : '{')
    frames.push({ value, keys: array ? [] : Object.keys(value), index: 0, first: true, array })
  }

  const value = prepare({ '': root }, '')
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  append(value)
  while (frames.length) {
    const frame = frames[frames.length - 1]
    const length = frame.array ? frame.value.length : frame.keys.length
    if (frame.index >= length) {
      chunks.push(frame.array ? ']' : '}')
      active.delete(frame.value)
      frames.pop()
      continue
    }
    const key = frame.array ? String(frame.index++) : frame.keys[frame.index++]
    let child = prepare(frame.value, key)
    if (child === undefined || typeof child === 'function' || typeof child === 'symbol') {
      if (!frame.array) continue
      child = null
    }
    if (!frame.first) chunks.push(',')
    frame.first = false
    if (!frame.array) chunks.push(JSON.stringify(key), ':')
    append(child)
  }
  return chunks.join('')
}

/**
 * Use the native serializer for normal trees and an iterative fallback for deep ones.
 * @param value - The JSON-compatible value to serialize.
 * @param replacer - Optional JSON property transformation.
 * @returns The serialized value, or undefined for an unsupported root value.
 */
export function stringifyJsonWithFallback(value: unknown, replacer?: (key: string, value: any) => any): string | undefined {
  try {
    return JSON.stringify(value, replacer)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return stringifyDeepJson(value, replacer)
  }
}
