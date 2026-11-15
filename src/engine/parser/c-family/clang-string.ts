import { TextDecoder } from 'util'

/** Decode Clang's C-escaped literal spelling, preserving non-UTF-8 byte strings. */
export function decodeClangString(spelling: string): { value: string; encoding: string; bytes?: number[]; codeUnits?: number[] } {
  const match = /^(u8|u|U|L)?"([\s\S]*)"$/.exec(spelling)
  if (!match) throw new Error('Unsupported Clang string spelling')
  const prefix = match[1] || ''
  const narrow = !prefix || prefix === 'u8'
  const text = match[2]
  const units: number[] = []
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39, '?': 63 }
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\\') {
      const value = text.codePointAt(index)!
      if (narrow) units.push(...Buffer.from(String.fromCodePoint(value), 'utf8'))
      else units.push(value)
      if (value > 0xffff) index++
      continue
    }
    const escape = text[++index]
    if (Object.prototype.hasOwnProperty.call(simple, escape)) units.push(simple[escape])
    else if (/[0-7]/.test(escape || '')) {
      const digits = /^[0-7]{1,3}/.exec(text.slice(index))![0]
      units.push(parseInt(digits, 8))
      index += digits.length - 1
    } else if (escape === 'x') {
      const digits = /^[0-9a-fA-F]+/.exec(text.slice(index + 1))?.[0]
      if (!digits) throw new Error('Invalid hexadecimal escape')
      units.push(parseInt(digits, 16))
      index += digits.length
    } else if (escape === 'u' || escape === 'U') {
      const length = escape === 'u' ? 4 : 8
      const digits = text.slice(index + 1, index + 1 + length)
      if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) throw new Error('Invalid Unicode escape')
      const value = parseInt(digits, 16)
      if (narrow) units.push(...Buffer.from(String.fromCodePoint(value), 'utf8'))
      else units.push(value)
      index += length
    } else throw new Error('Unsupported string escape')
  }
  // char32_t literals can encode packed numeric tables outside Unicode's range.
  // The caller represents those units as a null-terminated UAST array.
  if (prefix === 'U' && units.some(unit => unit > 0x10ffff)) {
    if (units.some(unit => !Number.isSafeInteger(unit) || unit > 0xffffffff)) throw new Error('Invalid char32_t code unit')
    return { value: '', encoding: prefix, codeUnits: units }
  }
  if (!narrow) return { value: units.map(unit => String.fromCodePoint(unit)).join(''), encoding: prefix }
  if (units.some(unit => unit > 255)) throw new Error('Invalid narrow string code unit')
  const bytes = Buffer.from(units)
  try { return { value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: prefix || 'utf8' } }
  catch { return { value: bytes.toString('latin1'), encoding: 'bytes', bytes: units } }
}
