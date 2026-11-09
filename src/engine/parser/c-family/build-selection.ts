import { createHash } from 'crypto'
import * as path from 'path'
import type { BuildContext, BuildSelection, CompileEntry } from './build-context'
import { resolveLanguage } from './compilation-database'

/**
 * Reject an invalid profile with the build-selection diagnostic prefix.
 * @param message Explanation of the invalid field or identity.
 */
function fail(message: string): never {
  throw new Error(`Build selection: ${message}`)
}
/**
 * Check whether a manifest value is an object rather than null or an array.
 * @param value Manifest value to inspect.
 * @returns {boolean} Whether the value can contain named manifest fields.
 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/**
 * Validate a nonempty manifest string without embedded NUL bytes.
 * @param value Manifest field to inspect.
 * @returns {boolean} Whether the value is a usable identifier or path.
 */
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}
/**
 * Reject fields outside the schema for a manifest object.
 * @param value Object whose own fields are checked.
 * @param allowed Field names accepted by this schema.
 * @param field Manifest location used in diagnostics.
 */
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${field} field ${key}`)
}

/**
 * Validate the profile schema before processing environments or compile entries.
 * @param selection Profile supplied by the caller.
 */
function validateSelection(selection: BuildSelection): void {
  if (!object(selection)) fail('selection manifest is required')
  keys(selection, ['version', 'profileId', 'units', 'environment', 'timeoutMs'], 'selection')
  if (selection.version !== 1) fail('version must be 1')
  if (!nonempty(selection.profileId)) fail('profileId must be a nonempty string')
  if (!Array.isArray(selection.units) || !selection.units.length) fail('units must be a nonempty array')
  if (
    'timeoutMs' in selection &&
    (typeof selection.timeoutMs !== 'number' || !Number.isFinite(selection.timeoutMs) || selection.timeoutMs <= 0)
  ) {
    fail('timeoutMs must be a positive finite number')
  }
}

/**
 * Copy and freeze the explicitly declared process environment and its provenance.
 * @param selection Validated build profile containing optional environment values.
 * @returns {object} Frozen environment maps shared by all selected contexts.
 */
function profileEnvironment(selection: BuildSelection): Pick<BuildContext, 'environment' | 'environmentProvenance'> {
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
  return { environment, environmentProvenance }
}

/**
 * Index compile entries after checking their resolved paths and argv identities.
 * @param entries Compile entries supplied by the database reader.
 * @returns {Map} Entries keyed by their verified content identities.
 */
function indexEntries(entries: CompileEntry[]): Map<string, CompileEntry> {
  if (!Array.isArray(entries)) fail('entries must be an array')
  const byId = new Map<string, CompileEntry>()
  for (const entry of entries) {
    if (
      !object(entry) ||
      !nonempty(entry.entryId) ||
      !nonempty(entry.directory) ||
      !nonempty(entry.sourceFile) ||
      !Array.isArray(entry.argv)
    ) {
      fail('invalid compile entry')
    }
    if (!path.isAbsolute(entry.directory) || !path.isAbsolute(entry.sourceFile))
      fail(`entry ${entry.entryId} paths must be resolved`)
    const expected = createHash('sha256')
      .update(JSON.stringify([entry.directory, entry.sourceFile, entry.argv]))
      .digest('hex')
    if (entry.entryId !== expected) fail(`conflicting or invalid entryId ${entry.entryId}; argv/path identity differs`)
    byId.set(entry.entryId, entry)
  }
  return byId
}

/**
 * Resolve a selected unit after validating its schema and entry reference.
 * @param unit Selection record whose entry and domain identifiers are required.
 * @param index Position of the unit in the profile for diagnostics.
 * @param byId Verified compile entries indexed by identity.
 * @returns {CompileEntry} Compile entry referenced by the selected unit.
 */
function selectedEntry(
  unit: BuildSelection['units'][number],
  index: number,
  byId: Map<string, CompileEntry>
): CompileEntry {
  if (!object(unit)) fail(`units[${index}] must be an object`)
  keys(unit, ['entryId', 'domainId'], `units[${index}]`)
  if (!nonempty(unit.entryId) || !nonempty(unit.domainId))
    fail(`units[${index}] requires nonempty entryId and domainId`)
  const entry = byId.get(unit.entryId)
  if (!entry) fail(`unknown entryId ${unit.entryId} in units[${index}]`)
  return entry
}

/**
 * Read the last driver standard while skipping forwarded option operands.
 * @param entry Compile entry with a validated compiler command.
 * @returns {string|null} Last standard before the positional-only marker, if any.
 */
function selectedStandard(entry: CompileEntry): string | null {
  let standard: string | null = null
  for (let i = 1; i < entry.argv.length; i++) {
    if (entry.argv[i] === '--') break
    if (['-Xclang', '-Xpreprocessor', '-Xassembler', '-Xlinker'].includes(entry.argv[i])) {
      i++
      continue
    }
    if (entry.argv[i].startsWith('-std=') || entry.argv[i].startsWith('--std='))
      standard = entry.argv[i].split('=').slice(1).join('=')
    else if (entry.argv[i] === '-std' || entry.argv[i] === '--std') standard = entry.argv[++i]
  }
  return standard
}

/**
 * Build an immutable context from a selected entry and the shared profile values.
 * @param entry Compile entry selected for this unit.
 * @param selection Build profile contributing its identifier and timeout.
 * @param unit Unit and domain identities computed by the selector.
 * @param unit.unitId Content identity of the profile, domain, and entry combination.
 * @param unit.domainId Explicit link domain assigned by the profile.
 * @param environment Profile environment maps already copied and frozen.
 * @returns {BuildContext} Immutable context with its own argv and provenance copies.
 */
function createContext(
  entry: CompileEntry,
  selection: BuildSelection,
  unit: { unitId: string; domainId: string },
  environment: Pick<BuildContext, 'environment' | 'environmentProvenance'>
): BuildContext {
  const language = resolveLanguage(entry)
  const standard = selectedStandard(entry)
  const argv = [...entry.argv]
  Object.freeze(argv)
  const context: BuildContext = {
    entryId: entry.entryId,
    directory: entry.directory,
    sourceFile: entry.sourceFile,
    argv,
    ...(entry.provenance ? { provenance: Object.freeze({ ...entry.provenance }) } : {}),
    unitId: unit.unitId,
    profileId: selection.profileId,
    domainId: unit.domainId,
    language,
    standard,
    ...environment,
    ...(selection.timeoutMs !== undefined ? { timeoutMs: selection.timeoutMs } : {}),
  }
  return Object.freeze(context)
}

/**
 * Select explicit link domains without deriving targets from filenames or database order.
 * @param entries Compile entries whose paths and argv define their identities.
 * @param selection Profile explicitly assigning entries to link domains.
 * @returns {BuildContext[]} Frozen contexts in first-selection order, deduplicated per domain.
 */
export function selectBuildContexts(entries: CompileEntry[], selection: BuildSelection): BuildContext[] {
  validateSelection(selection)
  const environment = profileEnvironment(selection)
  const byId = indexEntries(entries)
  const contexts: BuildContext[] = []
  const seen = new Set<string>()
  for (const [index, unit] of selection.units.entries()) {
    const entry = selectedEntry(unit, index, byId)
    const unitId = createHash('sha256')
      .update(JSON.stringify([selection.profileId, unit.domainId, unit.entryId]))
      .digest('hex')
    if (seen.has(unitId)) continue
    seen.add(unitId)
    contexts.push(createContext(entry, selection, { unitId, domainId: unit.domainId }, environment))
  }
  Object.freeze(contexts)
  return contexts
}

export default selectBuildContexts
