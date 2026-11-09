import { createReadStream } from 'fs'
import { TextDecoder } from 'util'
import { createRequire } from 'module'

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
  template?: boolean
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
  unsupported: { kind: string; offset: number; type?: string; globalInitializer?: boolean }[]
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
  type?: { qualType?: string; desugaredQualType?: string }
  isImplicit?: boolean
  definitionData?: { isTrivial?: boolean }
  mangledName?: string
  previousDecl?: string
  storageClass?: string
  inline?: boolean
  init?: string
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

// Load the untyped CommonJS parser through Node's module API.
const JsonParse = createRequire(__filename)('jsonparse') as {
  new (): JsonParser
  C: Record<string, number>
}

const unsupportedKinds = new Set([
  'CXXMethodDecl',
  'CXXConstructorDecl',
  'CXXMemberCallExpr',
  'CXXOperatorCallExpr',
  'CXXConstructExpr',
  'CXXTemporaryObjectExpr',
  'CXXDynamicCastExpr',
  'CXXThrowExpr',
  'LambdaExpr',
  'FunctionTemplateDecl',
  'ClassTemplateDecl',
  'CXXNewExpr',
  'CXXDeleteExpr',
  'CXXTryStmt',
])

/**
 * Accept raw byte offsets only; presumed lines and macro locations are not offsets.
 * @param value Raw offset or token length from the compiler AST.
 * @returns {boolean} Whether the value is a nonnegative safe integer.
 */
function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Convert Clang's inclusive final token to an exclusive byte end.
 * @param range Raw compiler range with inclusive final-token coordinates.
 * @returns {object|undefined} Validated byte range with an exclusive end, if available.
 */
function byteRange(range: AstNode['range']): CompilerDeclaration['range'] | undefined {
  const begin = range?.begin?.offset
  const end = range?.end?.offset
  const length = range?.end?.tokLen ?? 0
  if (!isOffset(begin) || !isOffset(end) || !isOffset(length) || end < begin || !isOffset(end + length))
    return undefined
  return { begin, end: end + length }
}

interface JsonLexemes {
  quoted: boolean
  escaped: boolean
  unicodeDigits: number
  number: string
}

interface AstReaderState {
  metadata: CompilerMetadata
  bodies: WeakMap<AstNode, { range?: CompilerDeclaration['range'] }>
  trivialTypes: Set<string>
  rootComplete: boolean
}

interface DeclarationScope {
  scopeNames: string[]
  languageLinkage: CompilerDeclaration['languageLinkage']
  functionId?: string
}

type LocatedDeclaration = AstNode & {
  id: string
  kind: CompilerDeclaration['kind']
  loc: Location & { offset: number }
}

const validNumber = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

/**
 * Recognize ASCII decimal digits without decoding the complete input stream.
 * @param byte Input byte to classify.
 * @returns {boolean} Whether the byte represents an ASCII decimal digit.
 */
function isDecimalByte(byte: number): boolean {
  return byte >= 48 && byte <= 57
}

/**
 * Recognize the exact hexadecimal alphabet accepted in JSON Unicode escapes.
 * @param byte Input byte to classify.
 * @returns {boolean} Whether the byte is an ASCII hexadecimal digit.
 */
function isHexByte(byte: number): boolean {
  return isDecimalByte(byte) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
}

/**
 * Track string escapes across chunks and reject jsonparse's extra Unicode digits.
 * @param lexemes Mutable lexical state carried across stream chunks.
 * @param byte Next byte inside a quoted JSON string.
 */
function validateStringByte(lexemes: JsonLexemes, byte: number): void {
  if (lexemes.unicodeDigits > 0) {
    if (!isHexByte(byte)) throw new Error('Invalid JSON Unicode escape')
    lexemes.unicodeDigits--
  } else if (lexemes.escaped) {
    if (byte === 117) lexemes.unicodeDigits = 4
    lexemes.escaped = false
  } else if (byte === 92) lexemes.escaped = true
  else if (byte === 34) lexemes.quoted = false
}

/**
 * Validate numeric lexemes before jsonparse can coerce invalid numbers to strings.
 * @param lexemes Mutable lexical state carried across stream chunks.
 * @param byte Next byte outside a quoted JSON string.
 */
function validateUnquotedByte(lexemes: JsonLexemes, byte: number): void {
  const numeric = isDecimalByte(byte) || byte === 45 || byte === 43 || byte === 46 || byte === 69 || byte === 101
  if (lexemes.number && !numeric) {
    if (!validNumber.test(lexemes.number)) throw new Error('Invalid JSON number')
    lexemes.number = ''
  }
  if (numeric && (lexemes.number || byte === 45 || isDecimalByte(byte))) lexemes.number += String.fromCharCode(byte)
  if (byte === 34) lexemes.quoted = true
}

/**
 * Validate lexemes without retaining chunks or changing the parser's byte input.
 * @param lexemes Mutable lexical state carried across stream chunks.
 * @param chunk Raw bytes that will subsequently be written to jsonparse.
 */
function validateChunk(lexemes: JsonLexemes, chunk: Buffer): void {
  for (const byte of chunk) {
    if (lexemes.quoted) validateStringByte(lexemes, byte)
    else validateUnquotedByte(lexemes, byte)
  }
}

/**
 * Check for a non-array AST object without treating scalar inner values as nodes.
 * @param value Completed JSON value supplied by jsonparse.
 * @returns {boolean} Whether the value can represent a compiler AST node.
 */
function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Require an explicit translation-unit kind on the completed root object.
 * @param value Completed root value supplied by jsonparse.
 */
function validateRoot(value: unknown): void {
  if (!isAstNode(value) || !Object.prototype.hasOwnProperty.call(value, 'kind') || value.kind !== 'TranslationUnitDecl')
    throw new Error('Expected TranslationUnitDecl JSON root')
}

/**
 * Preserve named and anonymous namespaces, lexical linkage, and the nearest function.
 * @param stack Active parser ancestry before the completed node is freed.
 * @returns {DeclarationScope} Lexical metadata inherited by the completed declaration.
 */
function declarationScope(stack: JsonParser['stack']): DeclarationScope {
  const scope: DeclarationScope = { scopeNames: [], languageLinkage: 'C++' }
  for (const frame of stack) {
    if (frame.key !== 'inner' || !frame.value) continue
    const ancestor = frame.value
    if (ancestor.kind === 'NamespaceDecl') scope.scopeNames.push(ancestor.name || '')
    if (ancestor.kind === 'LinkageSpecDecl' && (ancestor.language === 'C' || ancestor.language === 'C++'))
      scope.languageLinkage = ancestor.language
    if (ancestor.kind === 'FunctionDecl') scope.functionId = ancestor.id
  }
  return scope
}

/**
 * Record trivial record types so their construction expressions can be filtered later.
 * @param node Completed AST node, including implicit record declarations.
 * @param stack Active parser ancestry used to qualify the record name.
 * @param trivialTypes Set of qualified trivial record names collected so far.
 */
function collectTrivialType(node: AstNode, stack: JsonParser['stack'], trivialTypes: Set<string>): void {
  if (node.kind !== 'CXXRecordDecl' || !node.definitionData?.isTrivial || !node.name) return
  const namespace = stack
    .filter((frame) => frame.key === 'inner' && frame.value?.kind === 'NamespaceDecl')
    .map((frame) => frame.value!.name || '')
  trivialTypes.add([...namespace, node.name].join('::'))
}

/**
 * Identify runtime initializer expressions outside functions, methods, and constructors.
 * @param node Completed unsupported node, which must be an expression rather than a declaration.
 * @param stack Active ancestry carrying the enclosing variable's initializer metadata.
 * @returns {boolean} Whether the expression belongs to a file-scope variable initializer.
 */
function isGlobalInitializer(node: AstNode, stack: JsonParser['stack']): boolean {
  if (!node.kind?.endsWith('Expr')) return false
  let initializer = false
  for (const frame of stack) {
    if (frame.key !== 'inner' || !frame.value) continue
    const ancestor = frame.value
    if (
      ['FunctionDecl', 'CXXMethodDecl', 'CXXConstructorDecl', 'CXXDestructorDecl', 'CXXConversionDecl'].includes(
        ancestor.kind || ''
      )
    )
      return false
    if (ancestor.kind === 'VarDecl' && ancestor.init) initializer = true
  }
  return initializer
}

/**
 * Record unsupported explicit syntax with raw offsets and constructor type evidence.
 * @param node Completed AST node to classify.
 * @param stack Active ancestry used to distinguish global initializers from local code.
 * @param metadata Output metadata receiving unsupported syntax diagnostics.
 */
function collectUnsupported(node: AstNode, stack: JsonParser['stack'], metadata: CompilerMetadata): void {
  if (node.isImplicit || !node.kind || !unsupportedKinds.has(node.kind)) return
  const offset = node.loc?.offset ?? node.range?.begin?.offset
  if (!isOffset(offset)) return
  const unsupported: CompilerMetadata['unsupported'][number] = { kind: node.kind, offset }
  if (node.kind === 'CXXConstructExpr') unsupported.type = node.type?.desugaredQualType || node.type?.qualType
  if (isGlobalInitializer(node, stack)) unsupported.globalInitializer = true
  metadata.unsupported.push(unsupported)
}

/**
 * Record complete declaration references without traversing their embedded declarations.
 * @param node Completed AST node to inspect.
 * @param range Validated byte range of the node, if available.
 * @param metadata Output metadata receiving reference records.
 */
function collectReference(
  node: AstNode,
  range: CompilerDeclaration['range'] | undefined,
  metadata: CompilerMetadata
): void {
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
}

/**
 * Require an explicit supported declaration kind with a stable ID and raw location.
 * @param node Completed AST node to inspect.
 * @returns {boolean} Whether the node has the mandatory declaration fields.
 */
function isLocatedDeclaration(node: AstNode): node is LocatedDeclaration {
  return (
    !node.isImplicit &&
    (node.kind === 'FunctionDecl' || node.kind === 'VarDecl' || node.kind === 'ParmVarDecl') &&
    typeof node.id === 'string' &&
    isOffset(node.loc?.offset)
  )
}

/**
 * Copy optional declaration fields while preserving the distinction between absent and false.
 * @param declaration Metadata record receiving the optional fields.
 * @param node Original completed declaration node.
 * @param functionId Nearest owning function, if one was found in the ancestry.
 * @param body Direct function body evidence, including bodies without valid ranges.
 */
function copyDeclarationDetails(
  declaration: CompilerDeclaration,
  node: AstNode,
  functionId: string | undefined,
  body: { range?: CompilerDeclaration['range'] } | undefined
): void {
  if (node.mangledName !== undefined) declaration.mangledName = node.mangledName
  if (node.previousDecl !== undefined) declaration.previousDecl = node.previousDecl
  if (node.storageClass !== undefined) declaration.storage = node.storageClass
  if (node.inline !== undefined) declaration.inline = node.inline
  if (node.kind !== 'FunctionDecl' && functionId !== undefined) declaration.functionId = functionId
  if (body?.range) declaration.bodyRange = body.range
}

/**
 * Build declaration metadata after its children have supplied body and scope evidence.
 * @param node Completed AST node to classify.
 * @param range Validated byte range of the node, if available.
 * @param stack Active parser ancestry used for lexical ownership and template status.
 * @param state Accumulated metadata and weakly held direct-body evidence.
 */
function collectDeclaration(
  node: AstNode,
  range: CompilerDeclaration['range'] | undefined,
  stack: JsonParser['stack'],
  state: AstReaderState
): void {
  if (!isLocatedDeclaration(node) || !range) return
  const scope = declarationScope(stack)
  if (node.kind === 'ParmVarDecl' && scope.functionId === undefined) return
  const name = node.name ?? ''
  if (
    node.kind === 'FunctionDecl' &&
    node.mangledName !== undefined &&
    (node.mangledName === name || node.mangledName === `_${name}`)
  )
    scope.languageLinkage = 'C'
  const body = node.kind === 'FunctionDecl' ? state.bodies.get(node) : undefined
  const declaration: CompilerDeclaration = {
    id: node.id,
    kind: node.kind,
    name,
    offset: node.loc.offset,
    range,
    type: node.type?.qualType ?? '',
    scopeNames: scope.scopeNames,
    languageLinkage: scope.languageLinkage,
    hasBody: body !== undefined,
  }
  if (stack.some((frame) => frame.key === 'inner' && frame.value?.kind === 'FunctionTemplateDecl'))
    declaration.template = true
  copyDeclarationDetails(declaration, node, scope.functionId, body)
  state.metadata.declarations.push(declaration)
}

/**
 * Collect one completed inner node before its parent array releases it.
 * @param node Completed AST node with ordinary properties still intact.
 * @param parent Direct AST parent from the inner-array frame.
 * @param stack Active parser ancestry used for namespace and function ownership.
 * @param state Accumulated metadata and weakly held body evidence.
 */
function collectNode(
  node: AstNode,
  parent: AstNode | undefined,
  stack: JsonParser['stack'],
  state: AstReaderState
): void {
  const range = byteRange(node.range)
  if (node.kind === 'CompoundStmt' && parent?.kind === 'FunctionDecl') state.bodies.set(parent, { range })
  collectTrivialType(node, stack, state.trivialTypes)
  collectUnsupported(node, stack, state.metadata)
  collectReference(node, range, state.metadata)
  collectDeclaration(node, range, stack, state)
}

/**
 * Configure strict root/token handling and metadata extraction on the streaming parser.
 * @param state Accumulated reader state updated as nodes and the root complete.
 * @returns {JsonParser} Parser that frees every completed AST inner-array element.
 */
function createAstParser(state: AstReaderState): JsonParser {
  const parser = new JsonParse()
  const tokens = JsonParse.C
  const { onToken } = parser
  let previousToken: number | undefined
  // jsonparse accepts streams of roots and some non-JSON syntax; AST files do not.
  parser.onToken = function validateAstToken(token, value) {
    if (state.rootComplete) throw new Error('Unexpected JSON after AST root')
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
  parser.onValue = function collectAstValue(value) {
    if (this.stack.length === 0) {
      validateRoot(value)
      state.rootComplete = true
      return
    }
    // referencedDecl/type/range objects can contain kinds too. Only objects
    // completed as elements of an AST inner array are actual traversed nodes.
    const parent = this.stack[this.stack.length - 1]
    if (typeof this.key !== 'number' || parent.key !== 'inner') return
    if (isAstNode(value)) collectNode(value, parent.value, this.stack, state)
    // Never leave completed children reachable from an ancestor's inner array.
    // In particular, do not prune ordinary properties such as type and range.
    delete this.value[this.key]
  }
  return parser
}

/**
 * Read a Clang JSON AST, retaining metadata and the active ancestry only.
 * Offsets refer to the preprocessed input; origin and redeclaration resolution
 * belong to the caller. Results follow completion order, not declaration order.
 * @param file Path to the compiler's UTF-8 JSON AST output.
 * @returns {Promise<CompilerMetadata>} Declarations, references, and unsupported explicit syntax.
 */
export async function readCompilerDeclarations(file: string): Promise<CompilerMetadata> {
  const state: AstReaderState = {
    metadata: { declarations: [], references: [], unsupported: [] },
    bodies: new WeakMap(),
    trivialTypes: new Set(),
    rootComplete: false,
  }
  const parser = createAstParser(state)
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const lexemes: JsonLexemes = { quoted: false, escaped: false, unicodeDigits: 0, number: '' }
  const stream = createReadStream(file)
  try {
    for await (const chunk of stream) {
      utf8.decode(chunk as Buffer, { stream: true })
      validateChunk(lexemes, chunk as Buffer)
      parser.write(chunk as Buffer)
    }
    utf8.decode()
    if (!state.rootComplete || parser.stack.length !== 0 || parser.tState !== JsonParse.C.START)
      throw new Error('Truncated or incomplete AST JSON')
  } catch (error) {
    throw new Error(`Cannot read compiler AST JSON ${file}: ${(error as Error).message}`)
  } finally {
    stream.destroy()
  }
  state.metadata.unsupported = state.metadata.unsupported.filter(
    (item) => item.kind !== 'CXXConstructExpr' || !state.trivialTypes.has(item.type || '')
  )
  return state.metadata
}
