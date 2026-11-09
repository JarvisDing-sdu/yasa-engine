import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { CompilerDeclaration } from './compiler-declarations'
import type { CompilerPreparedUnit } from './compiler-preprocess'
import { RawCoordinates, mapOrigin } from './source-map'

export interface FamilySymbol {
  key: string
  displayName: string
  kind: 'function' | 'variable'
  global: boolean
  internal: boolean
  library: boolean
  staticLocal: boolean
  languageLinkage: string
  libraryName?: string
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)

interface SymbolDefinition {
  unit: string
  declaration: CompilerDeclaration
  body: string
}

/**
 * Identify declarations whose linkage is restricted to one translation unit.
 * @param declaration Compiler declaration being indexed.
 * @param staticLocal Whether the declaration is a function-local static variable.
 * @param owner Enclosing function, when present.
 * @returns {boolean} Whether the symbol identity includes the translation unit.
 */
function isInternalDeclaration(
  declaration: CompilerDeclaration,
  staticLocal: boolean,
  owner: CompilerDeclaration | undefined
): boolean {
  return (
    (declaration.storage === 'static' && !staticLocal) ||
    declaration.scopeNames.includes('') ||
    /^_+ZL|GLOBAL__N_/.test(declaration.mangledName || '') ||
    owner?.storage === 'static'
  )
}

/**
 * Preserve compiler linkage and source ownership in the runtime symbol key.
 * @param unit Prepared translation unit and link domain.
 * @param declaration Compiler declaration being indexed.
 * @param owner Enclosing function, when present.
 * @param coordinates Byte coordinates of the unmodified preprocessed input.
 * @param internal Whether linkage is restricted to the translation unit.
 * @param staticLocal Whether the declaration is a function-local static variable.
 * @returns {string} Runtime key shared by declarations with the same link identity.
 */
function declarationKey(
  unit: CompilerPreparedUnit,
  declaration: CompilerDeclaration,
  owner: CompilerDeclaration | undefined,
  coordinates: RawCoordinates,
  internal: boolean,
  staticLocal: boolean
): string {
  const linkageName = declaration.mangledName || declaration.name
  const point = coordinates.location(declaration.offset)
  const source = mapOrigin(unit.sourceMap, point.line)
  const ownerName = owner?.mangledName || owner?.name || ''
  const localIdentity = staticLocal
    ? `${ownerName}:${declaration.name}:${source?.file}:${source?.line}:${point.column}`
    : linkageName
  const unitPrefix = internal ? `${unit.context.unitId}:` : ''
  const identity = `${unit.context.domainId}:${unitPrefix}${localIdentity}`
  return declaration.name === 'main' && declaration.kind === 'FunctionDecl' ? 'main' : `__cf_${hash(identity)}`
}

/**
 * Record function bodies that participate in link-domain conflict checks.
 * @param definitions Function definitions grouped by runtime key.
 * @param key Runtime symbol key.
 * @param unit Prepared translation unit and included library body ranges.
 * @param declaration Compiler declaration being indexed.
 * @param coordinates Byte coordinates of the unmodified preprocessed input.
 * @param raw Original preprocessed bytes used to compare function bodies.
 */
function registerDefinition(
  definitions: Map<string, SymbolDefinition[]>,
  key: string,
  unit: CompilerPreparedUnit,
  declaration: CompilerDeclaration,
  coordinates: RawCoordinates,
  raw: Buffer
): void {
  const origin = mapOrigin(unit.sourceMap, coordinates.location(declaration.offset).line)
  const system = origin?.system && origin.physicalFile !== unit.context.sourceFile
  const included = unit.libraryBodies?.some(
    (range) => declaration.offset >= range.begin && declaration.offset < range.end
  )
  const defined = declaration.kind === 'FunctionDecl' && declaration.hasBody && (!system || included)
  if (defined) {
    const range = declaration.bodyRange || declaration.range
    const body = raw.subarray(range.begin, range.end).toString()
    const entries = definitions.get(key) || []
    entries.push({ unit: unit.context.unitId, declaration, body })
    definitions.set(key, entries)
  }
}

/**
 * Derive the runtime ABI name using the compiler target option precedence.
 * @param unit Prepared translation unit and original compiler invocation.
 * @param linkageName Compiler mangling or declaration name.
 * @returns {string} ABI name with the Darwin leading underscore removed when applicable.
 */
function runtimeAbiName(unit: CompilerPreparedUnit, linkageName: string): string {
  const targetOption = unit.context.argv.find((arg) => arg.startsWith('--target='))
  const targetIndex = unit.context.argv.indexOf('-target')
  const darwin = /apple|darwin/.test(
    targetOption || (targetIndex >= 0 ? unit.context.argv[targetIndex + 1] : unit.compilerId)
  )
  return darwin && linkageName.startsWith('_') ? linkageName.slice(1) : linkageName
}

/**
 * Recognize externally linked C ABI functions eligible for runtime library lookup.
 * @param declaration Compiler declaration being indexed.
 * @param abiName Runtime ABI name after target normalization.
 * @param internal Whether linkage is restricted to the translation unit.
 * @returns {boolean} Whether the declaration can resolve to a runtime library function.
 */
function isLibraryDeclaration(declaration: CompilerDeclaration, abiName: string, internal: boolean): boolean {
  return (
    declaration.kind === 'FunctionDecl' &&
    /^[A-Za-z_]\w*$/.test(abiName) &&
    !abiName.startsWith('_Z') &&
    declaration.name !== 'main' &&
    !internal
  )
}

/**
 * Index one translation unit while collecting function definitions for link checks.
 * @param unit Prepared translation unit with compiler declaration metadata.
 * @param definitions Function definitions grouped by runtime key.
 * @returns {Map<string, FamilySymbol>} Symbols indexed by compiler declaration ID.
 */
function indexUnitSymbols(
  unit: CompilerPreparedUnit,
  definitions: Map<string, SymbolDefinition[]>
): Map<string, FamilySymbol> {
  const raw = fs.readFileSync(path.join(unit.directory, unit.context.language === 'cpp' ? 'unit.ii' : 'unit.i'))
  const coordinates = new RawCoordinates(raw.toString())
  const symbols = new Map<string, FamilySymbol>()
  const { declarations } = unit.metadata!
  const byId = new Map(declarations.map((d) => [d.id, d]))
  for (const declaration of declarations) {
    const fn = declaration.kind === 'FunctionDecl'
    const staticLocal = !fn && !!declaration.functionId && declaration.storage === 'static'
    if (!fn && declaration.functionId && !staticLocal) continue
    const owner = declaration.functionId ? byId.get(declaration.functionId) : undefined
    const internal = isInternalDeclaration(declaration, staticLocal, owner)
    const linkageName = declaration.mangledName || declaration.name
    const key = declarationKey(unit, declaration, owner, coordinates, internal, staticLocal)
    const displayName = [...declaration.scopeNames.filter(Boolean), declaration.name].join('::')
    registerDefinition(definitions, key, unit, declaration, coordinates, raw)
    const abiName = runtimeAbiName(unit, linkageName)
    symbols.set(declaration.id, {
      key,
      displayName,
      kind: fn ? 'function' : 'variable',
      global: true,
      internal,
      staticLocal,
      library: isLibraryDeclaration(declaration, abiName, internal),
      libraryName: abiName,
      languageLinkage: unit.context.language === 'c' ? 'C' : declaration.languageLinkage,
    })
  }
  return symbols
}

/**
 * Compiler mangling, storage and target selection establish identities before registration.
 * @param units Prepared translation units belonging to the selected link domains.
 * @returns {Map<string, Map<string, FamilySymbol>>} Symbols grouped by translation unit and declaration ID.
 */
export function buildSymbolIndex(units: CompilerPreparedUnit[]): Map<string, Map<string, FamilySymbol>> {
  const result = new Map<string, Map<string, FamilySymbol>>()
  const definitions = new Map<string, SymbolDefinition[]>()
  for (const unit of units) {
    result.set(unit.context.unitId, indexUnitSymbols(unit, definitions))
  }
  for (const [key, entries] of definitions) {
    const unique = [...new Map(entries.map((e) => [`${e.unit}:${e.declaration.offset}`, e])).values()]
    if (unique.length > 1 && !unique.every((e) => e.declaration.inline && e.body === unique[0].body)) {
      throw new Error(`Conflicting definitions in one link domain: ${unique[0].declaration.name} (${key})`)
    }
  }
  for (const symbols of result.values()) {
    for (const symbol of symbols.values()) {
      if (symbol.library && !definitions.has(symbol.key)) symbol.key = symbol.libraryName!
      else symbol.library = false
    }
  }
  return result
}
