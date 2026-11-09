import * as fs from 'fs'
import * as path from 'path'
import type { CompilerPreparedUnit } from './compiler-preprocess'
import type { FamilySymbol } from './symbol-index'
import { projectText, mapOrigin, RawCoordinates } from './source-map'

export interface FamilyParsedUnit {
  prepared: CompilerPreparedUnit
  ast: any
  status: 'parsed' | 'partial' | 'failed'
  diagnostics: { code: string; message: string }[]
  moduleFile: string
}

const position = (loc: { line: number; column: number }) => `${loc.line}:${loc.column}`

/**
 * Include diagnostics from every retained body, including required system wrappers.
 * @param prepared
 * @param coordinates
 * @param offset
 * @returns {boolean} Whether the offset participates in symbolic interpretation.
 */
function isAnalyzedOffset(prepared: CompilerPreparedUnit, coordinates: RawCoordinates, offset: number): boolean {
  const location = mapOrigin(prepared.sourceMap, coordinates.location(offset).line)
  if (!location) return false
  if (!location.system || location.physicalFile === prepared.context.sourceFile) return true
  return !!prepared.libraryBodies?.some((range) => offset >= range.begin && offset < range.end)
}

/**
 * Bind only identifiers whose declarations or references the compiler resolved.
 * @param ast
 * @param prepared
 * @param symbols
 * @param coordinates
 */
function bindCompilerSymbols(
  ast: any,
  prepared: CompilerPreparedUnit,
  symbols: Map<string, FamilySymbol>,
  coordinates: RawCoordinates
): void {
  const definitions = new Map<string, FamilySymbol>()
  for (const declaration of prepared.metadata!.declarations) {
    const symbol = symbols.get(declaration.id)
    if (symbol) definitions.set(position(coordinates.location(declaration.offset)), symbol)
  }
  const references = new Map<string, FamilySymbol>()
  for (const reference of prepared.metadata!.references) {
    const symbol = symbols.get(reference.declarationId)
    if (!symbol) continue
    references.set(position(coordinates.location(reference.offset)), symbol)
    // A qualified UAST identifier may retain just the terminal token's range.
    const terminal = reference.end - Buffer.byteLength(reference.name)
    references.set(position(coordinates.location(terminal)), symbol)
  }
  const visit = (node: any, parent?: any): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent)
      return
    }
    const { loc } = node
    if (node.type === 'Identifier' && loc?.start) {
      const isDeclaration =
        (parent?.type === 'FunctionDefinition' || parent?.type === 'VariableDeclaration') && parent.id === node
      const symbol = (isDeclaration ? definitions : references).get(position(loc.start))
      if (symbol) {
        node.name = symbol.key
        node._meta = {
          ...node._meta,
          qualifier: undefined,
          globalQualified: undefined,
          namespaceContext: undefined,
          cFamilySymbol: symbol,
        }
        if (isDeclaration) {
          parent._meta = {
            ...parent._meta,
            namespace: undefined,
            qualifiedName: undefined,
            cFamilySymbol: symbol,
            languageLinkage: symbol.languageLinkage,
            storageLinkage: symbol.internal ? 'internal' : 'external',
          }
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!['parent', 'loc', '_meta'].includes(key)) visit(value, node)
    }
  }
  visit(ast)
}

/**
 * Preserve parser and unsupported-semantics diagnostics for project code.
 * @param prepared
 * @param coordinates
 * @param ast
 * @returns {{code: string, message: string}[]} Coverage diagnostics.
 */
function collectDiagnostics(
  prepared: CompilerPreparedUnit,
  coordinates: RawCoordinates,
  ast: any
): { code: string; message: string }[] {
  const { context } = prepared
  const diagnostics: { code: string; message: string }[] = []
  for (const error of ast._meta.parseErrors || [])
    diagnostics.push({ code: 'parse_error', message: JSON.stringify(error) })
  for (const unsupported of prepared.metadata!.unsupported) {
    if (unsupported.globalInitializer || isAnalyzedOffset(prepared, coordinates, unsupported.offset)) {
      diagnostics.push({ code: 'unsupported_cpp_semantics', message: unsupported.kind })
    }
  }
  for (const declaration of prepared.metadata!.declarations) {
    if (context.language !== 'cpp' || !declaration.type.includes('&')) continue
    if (isAnalyzedOffset(prepared, coordinates, declaration.offset))
      diagnostics.push({ code: 'unsupported_cpp_reference', message: declaration.type })
  }
  return diagnostics
}

/**
 * Both parser implementations share generated coordinates; source display is mapped afterwards.
 * @param prepared
 * @param symbols
 * @returns {Promise<FamilyParsedUnit>} Parsed UAST and explicit coverage status.
 */
export async function parsePreparedUnit(
  prepared: CompilerPreparedUnit,
  symbols: Map<string, FamilySymbol>
): Promise<FamilyParsedUnit> {
  const { context } = prepared
  const moduleFile = path.join(prepared.directory, context.unitId + (context.language === 'cpp' ? '.cpp' : '.c'))
  const result: FamilyParsedUnit = { prepared, ast: null, status: 'failed', diagnostics: [], moduleFile }
  if (prepared.status !== 'prepared') return result
  try {
    const { Parser } =
      context.language === 'cpp' ? require('@ant-yasa/uast-parser-cpp') : require('@ant-yasa/uast-parser-c')
    const parser = new Parser()
    await parser.init()
    const raw = fs.readFileSync(
      path.join(prepared.directory, context.language === 'cpp' ? 'unit.ii' : 'unit.i'),
      'utf8'
    )
    const coordinates = new RawCoordinates(raw)
    let text = projectText(prepared.text, prepared.sourceMap, context.sourceFile)
    for (const range of prepared.libraryBodies || []) {
      const begin = Buffer.from(raw).subarray(0, range.begin).toString().length
      const end = Buffer.from(raw).subarray(0, range.end).toString().length
      text = text.slice(0, begin) + raw.slice(begin, end) + text.slice(end)
    }
    result.diagnostics.push(...prepared.diagnostics)
    const ast = parser.parsePreprocessed(text, {
      sourcefile: moduleFile,
      languageVersion: context.standard || undefined,
    })
    bindCompilerSymbols(ast, prepared, symbols, coordinates)
    const { processParsedAst } = require('../parser-core')
    result.ast = processParsedAst(
      ast,
      text,
      { sourcefile: moduleFile, language: context.language },
      { unit: 'file', needsSourcefile: true }
    )
    const mapped = new Set<any>()
    const map = (node: any): void => {
      if (!node || typeof node !== 'object' || mapped.has(node)) return
      mapped.add(node)
      if (Array.isArray(node)) {
        for (const item of node) map(item)
        return
      }
      const { loc } = node
      if (node.type && loc?.start) {
        const start = mapOrigin(prepared.sourceMap, loc.start.line)
        const end = mapOrigin(prepared.sourceMap, loc.end?.line ?? loc.start.line)
        node._meta = {
          ...node._meta,
          generatedRange: JSON.parse(JSON.stringify(loc)),
          originalColumnKnown: false,
          cFamily: {
            unitId: context.unitId,
            profileId: context.profileId,
            domainId: context.domainId,
            sourceFile: context.sourceFile,
          },
        }
        if (start && !start.file.startsWith('<')) {
          node._meta.originalLocation = {
            sourcefile: start.file,
            start: { line: start.line },
            end: { line: end?.file === start.file ? end.line : start.line },
            physicalFile: start.physicalFile,
          }
        }
      }
      for (const [key, value] of Object.entries(node)) if (!['parent', 'loc', '_meta'].includes(key)) map(value)
    }
    map(result.ast)
    result.diagnostics.push(...collectDiagnostics(prepared, coordinates, ast))
    result.status = result.diagnostics.length ? 'partial' : 'parsed'
    fs.writeFileSync(path.join(prepared.directory, 'project.txt'), text)
    fs.writeFileSync(
      path.join(prepared.directory, 'uast.json'),
      JSON.stringify(ast, (key, value) => (key === 'parent' ? undefined : value))
    )
  } catch (error: any) {
    result.diagnostics.push({ code: 'parse_failed', message: String(error.message) })
  }
  return result
}
