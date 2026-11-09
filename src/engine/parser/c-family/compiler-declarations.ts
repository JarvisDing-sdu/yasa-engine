import { createReadStream } from 'fs'
import { TextDecoder } from 'util'

export interface CompilerDeclaration {
  id: string
  kind: 'FunctionDecl' | 'VarDecl' | 'ParmVarDecl'
  name: string
  mangledName?: string
  previousDecl?: string
  offset: number
  range: { begin: number; end: number }
  bodyRange?: { begin: number; end: number }
  type: string
  storage?: string
  inline?: boolean
  functionId?: string
  scopeNames: string[]
  languageLinkage: 'C' | 'C++'
  hasBody: boolean
}

export interface CompilerReference {
  offset: number
  end: number
  declarationId: string
  name: string
}

export interface CompilerMetadata {
  declarations: CompilerDeclaration[]
  references: CompilerReference[]
  unsupported: { kind: string; offset: number }[]
}

interface Location {
  offset?: number
  tokLen?: number
}
interface AstNode {
  id?: string
  kind?: string
  name?: string
  loc?: Location
  range?: { begin?: Location; end?: Location }
  type?: { qualType?: string }
  mangledName?: string
  previousDecl?: string
  storageClass?: string
  inline?: boolean
  language?: string
  referencedDecl?: { id?: string; name?: string }
}

interface JsonParser {
  value: unknown[]
  key: string | number | undefined
  stack: { key?: string | number; value?: AstNode }[]
  tState: number
  onValue: (this: JsonParser, value: unknown) => void
  onToken: (this: JsonParser, token: number, value: unknown) => void
  write: (buffer: Buffer) => void
}

// jsonparse 1.3.1 has no bundled TypeScript declarations.
const JsonParse = require('jsonparse') as {
  new (): JsonParser
  C: Record<string, number>
}

const unsupportedKinds = new Set([
  'CXXMethodDecl',
  'CXXConstructorDecl',
  'CXXMemberCallExpr',
  'LambdaExpr',
  'FunctionTemplateDecl',
  'ClassTemplateDecl',
  'CXXNewExpr',
  'CXXDeleteExpr',
  'CXXTryStmt',
])

/** Accept raw byte offsets only; presumed lines and macro locations are not offsets. */
function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Convert Clang's inclusive final token to an exclusive byte end. */
function byteRange(range: AstNode['range']): CompilerDeclaration['range'] | undefined {
  const begin = range?.begin?.offset
  const end = range?.end?.offset
  const length = range?.end?.tokLen ?? 0
  if (!isOffset(begin) || !isOffset(end) || !isOffset(length) || end < begin || !isOffset(end + length))
    return undefined
  return { begin, end: end + length }
}

/**
 * Read a Clang JSON AST, retaining metadata and the active ancestry only.
 * Offsets refer to the preprocessed input; origin and redeclaration resolution
 * belong to the caller. Results follow completion order, not declaration order.
 */
export async function readCompilerDeclarations(file: string): Promise<CompilerMetadata> {
  const metadata: CompilerMetadata = { declarations: [], references: [], unsupported: [] }
  const bodies = new WeakMap<AstNode, { range?: CompilerDeclaration['range'] }>()
  const parser = new JsonParse()
  const tokens = JsonParse.C
  const onToken = parser.onToken
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  let previousToken: number | undefined
  let rootComplete = false
  let quoted = false
  let escaped = false
  let unicodeDigits = 0
  let number = ''
  const validNumber = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

  // The tokenizer also coerces leading-zero numbers into strings and accepts
  // punctuation as Unicode hex digits. Validate those lexemes across chunks.
  const validateChunk = (chunk: Buffer) => {
    for (const byte of chunk) {
      if (quoted) {
        if (unicodeDigits > 0) {
          if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)))
            throw new Error('Invalid JSON Unicode escape')
          unicodeDigits--
        } else if (escaped) {
          if (byte === 117) unicodeDigits = 4
          escaped = false
        } else if (byte === 92) escaped = true
        else if (byte === 34) quoted = false
      } else {
        const numeric =
          (byte >= 48 && byte <= 57) || byte === 45 || byte === 43 || byte === 46 || byte === 69 || byte === 101
        if (number && !numeric) {
          if (!validNumber.test(number)) throw new Error('Invalid JSON number')
          number = ''
        }
        if (numeric && (number || byte === 45 || (byte >= 48 && byte <= 57))) number += String.fromCharCode(byte)
        if (byte === 34) quoted = true
      }
    }
  }

  // jsonparse intentionally accepts streams of roots and some non-JSON syntax.
  // Keep its tokenizer/tree builder, but reject those extensions for AST files.
  parser.onToken = function (token, value) {
    if (rootComplete) throw new Error('Unexpected JSON after AST root')
    if (previousToken === undefined && token !== tokens.LEFT_BRACE)
      throw new Error('Expected TranslationUnitDecl JSON root')
    if (
      (token === tokens.RIGHT_BRACE || token === tokens.RIGHT_BRACKET) &&
      (previousToken === tokens.COMMA || previousToken === tokens.COLON)
    )
      throw new Error('Invalid JSON: missing value or trailing comma')
    previousToken = token
    onToken.call(this, token, value)
  }

  parser.onValue = function (value) {
    if (this.stack.length === 0) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.prototype.hasOwnProperty.call(value, 'kind') ||
        (value as AstNode).kind !== 'TranslationUnitDecl'
      )
        throw new Error('Expected TranslationUnitDecl JSON root')
      rootComplete = true
      return
    }
    // referencedDecl/type/range objects can contain kinds too. Only objects
    // completed as elements of an AST inner array are actual traversed nodes.
    const parent = this.stack[this.stack.length - 1]
    if (typeof this.key !== 'number' || parent.key !== 'inner') return
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const node = value as AstNode
      const range = byteRange(node.range)
      if (node.kind === 'CompoundStmt' && parent.value?.kind === 'FunctionDecl') bodies.set(parent.value, { range })

      if (node.kind && unsupportedKinds.has(node.kind)) {
        const offset = node.loc?.offset ?? node.range?.begin?.offset
        if (isOffset(offset)) metadata.unsupported.push({ kind: node.kind, offset })
      }
      if (
        node.kind === 'DeclRefExpr' &&
        range &&
        typeof node.referencedDecl?.id === 'string' &&
        typeof node.referencedDecl.name === 'string'
      ) {
        metadata.references.push({
          offset: range.begin,
          end: range.end,
          declarationId: node.referencedDecl.id,
          name: node.referencedDecl.name,
        })
      }
      if (
        (node.kind === 'FunctionDecl' || node.kind === 'VarDecl' || node.kind === 'ParmVarDecl') &&
        typeof node.id === 'string' &&
        isOffset(node.loc?.offset) &&
        range
      ) {
        const scopeNames: string[] = []
        let languageLinkage: CompilerDeclaration['languageLinkage'] = 'C++'
        let functionId: string | undefined
        for (const frame of this.stack) {
          if (frame.key !== 'inner' || !frame.value) continue
          const ancestor = frame.value
          if (ancestor.kind === 'NamespaceDecl' && ancestor.name) scopeNames.push(ancestor.name)
          if (ancestor.kind === 'LinkageSpecDecl' && (ancestor.language === 'C' || ancestor.language === 'C++'))
            languageLinkage = ancestor.language
          if (ancestor.kind === 'FunctionDecl') functionId = ancestor.id
        }
        const name = node.name ?? ''
        if (
          node.kind === 'FunctionDecl' &&
          node.mangledName !== undefined &&
          (node.mangledName === name || node.mangledName === `_${name}`)
        )
          languageLinkage = 'C'
        const body = node.kind === 'FunctionDecl' ? bodies.get(node) : undefined
        const declaration: CompilerDeclaration = {
          id: node.id,
          kind: node.kind,
          name,
          offset: node.loc.offset,
          range,
          type: node.type?.qualType ?? '',
          scopeNames,
          languageLinkage,
          hasBody: body !== undefined,
        }
        if (node.mangledName !== undefined) declaration.mangledName = node.mangledName
        if (node.previousDecl !== undefined) declaration.previousDecl = node.previousDecl
        if (node.storageClass !== undefined) declaration.storage = node.storageClass
        if (node.inline !== undefined) declaration.inline = node.inline
        if (node.kind !== 'FunctionDecl' && functionId !== undefined) declaration.functionId = functionId
        if (body?.range) declaration.bodyRange = body.range
        metadata.declarations.push(declaration)
      }
    }
    // Never leave completed children reachable from an ancestor's inner array.
    // In particular, do not prune ordinary properties such as type and range.
    delete this.value[this.key]
  }

  const stream = createReadStream(file)
  try {
    for await (const chunk of stream) {
      utf8.decode(chunk as Buffer, { stream: true })
      validateChunk(chunk as Buffer)
      parser.write(chunk as Buffer)
    }
    utf8.decode()
    if (!rootComplete || parser.stack.length !== 0 || parser.tState !== tokens.START)
      throw new Error('Truncated or incomplete AST JSON')
  } catch (error) {
    throw new Error(`Cannot read compiler AST JSON ${file}: ${(error as Error).message}`)
  } finally {
    stream.destroy()
  }
  return metadata
}
