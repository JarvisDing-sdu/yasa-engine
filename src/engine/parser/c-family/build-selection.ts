import { createHash } from 'crypto'
import * as path from 'path'
import type { BuildContext, BuildSelection, CompileEntry } from './build-context'
import { resolveLanguage } from './compilation-database'

function fail(message: string): never { throw new Error(`Build selection: ${message}`) }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${field} field ${key}`)
}

/** Select explicit link domains without deriving targets from filenames or database order. */
export function selectBuildContexts(entries: CompileEntry[], selection: BuildSelection): BuildContext[] {
  if (!object(selection)) fail('selection manifest is required')
  keys(selection, ['version', 'profileId', 'units', 'environment', 'timeoutMs'], 'selection')
  if (selection.version !== 1) fail('version must be 1')
  if (!nonempty(selection.profileId)) fail('profileId must be a nonempty string')
  if (!Array.isArray(selection.units) || !selection.units.length) fail('units must be a nonempty array')
  if ('timeoutMs' in selection && (typeof selection.timeoutMs !== 'number' || !Number.isFinite(selection.timeoutMs) || selection.timeoutMs <= 0)) {
    fail('timeoutMs must be a positive finite number')
  }
  const environment: Record<string, string> = {}
  const environmentProvenance: Record<string, 'profile'> = {}
  if ('environment' in selection) {
    if (!object(selection.environment)) fail('environment must be an object of string values')
    for (const [key, value] of Object.entries(selection.environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
        fail(`environment.${key} must be a valid environment name and string without NUL`)
      }
      // Define own properties even for names such as __proto__.
      Object.defineProperty(environment, key, { value, enumerable: true })
      Object.defineProperty(environmentProvenance, key, { value: 'profile', enumerable: true })
    }
  }
  Object.freeze(environment)
  Object.freeze(environmentProvenance)
  if (!Array.isArray(entries)) fail('entries must be an array')
  const byId = new Map<string, CompileEntry>()
  for (const entry of entries) {
    if (!object(entry) || !nonempty(entry.entryId) || !nonempty(entry.directory) || !nonempty(entry.sourceFile) || !Array.isArray(entry.argv)) {
      fail('invalid compile entry')
    }
    if (!path.isAbsolute(entry.directory) || !path.isAbsolute(entry.sourceFile)) fail(`entry ${entry.entryId} paths must be resolved`)
    const expected = createHash('sha256').update(JSON.stringify([entry.directory, entry.sourceFile, entry.argv])).digest('hex')
    if (entry.entryId !== expected) fail(`conflicting or invalid entryId ${entry.entryId}; argv/path identity differs`)
    byId.set(entry.entryId, entry)
  }
  const contexts: BuildContext[] = []
  const seen = new Set<string>()
  for (const [index, unit] of selection.units.entries()) {
    if (!object(unit)) fail(`units[${index}] must be an object`)
    keys(unit, ['entryId', 'domainId'], `units[${index}]`)
    if (!nonempty(unit.entryId) || !nonempty(unit.domainId)) fail(`units[${index}] requires nonempty entryId and domainId`)
    const entry = byId.get(unit.entryId)
    if (!entry) fail(`unknown entryId ${unit.entryId} in units[${index}]`)
    const unitId = createHash('sha256').update(JSON.stringify([selection.profileId, unit.domainId, unit.entryId])).digest('hex')
    if (seen.has(unitId)) continue
    seen.add(unitId)
    const language = resolveLanguage(entry)
    let standard: string | null = null
    for (let i = 1; i < entry.argv.length; i++) {
      if (entry.argv[i] === '--') break
      if (['-Xclang', '-Xpreprocessor', '-Xassembler', '-Xlinker'].includes(entry.argv[i])) { i++; continue }
      if (entry.argv[i].startsWith('-std=') || entry.argv[i].startsWith('--std=')) standard = entry.argv[i].split('=').slice(1).join('=')
      else if (entry.argv[i] === '-std' || entry.argv[i] === '--std') standard = entry.argv[++i]
    }
    const argv = [...entry.argv]
    Object.freeze(argv)
    const context: BuildContext = {
      entryId: entry.entryId, directory: entry.directory, sourceFile: entry.sourceFile, argv,
      ...(entry.provenance ? { provenance: Object.freeze({ ...entry.provenance }) } : {}),
      unitId, profileId: selection.profileId, domainId: unit.domainId,
      language, standard, environment, environmentProvenance,
      ...(selection.timeoutMs !== undefined ? { timeoutMs: selection.timeoutMs } : {}),
    }
    contexts.push(Object.freeze(context))
  }
  Object.freeze(contexts)
  return contexts
}
