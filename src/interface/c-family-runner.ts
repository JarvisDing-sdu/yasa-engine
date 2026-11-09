import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Command } from 'commander'
import globby from 'fast-glob'
import { readCompilationDatabase } from '../engine/parser/c-family/compilation-database'
import { selectBuildContexts } from '../engine/parser/c-family/build-selection'
import type { CompilerPreparedUnit } from '../engine/parser/c-family/compiler-preprocess'
import type { CompileEntry } from '../engine/parser/c-family/build-context'
import { preprocessUnit } from '../engine/parser/c-family/compiler-preprocess'
import type { FamilyParsedUnit } from '../engine/parser/c-family/c-family-ast-builder'
import { parsePreparedUnit } from '../engine/parser/c-family/c-family-ast-builder'
import { buildSymbolIndex } from '../engine/parser/c-family/symbol-index'
import { mapOrigin } from '../engine/parser/c-family/source-map'
import retainLibraryBodies from '../engine/parser/c-family/library-bodies'
import { resolveRuleConfig, modeledAPIs } from '../engine/parser/c-family/rule-config'

const execute = promisify(execFile)
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export interface CFamilyRequest {
  sourcePath: string
  compileCommands: string
  buildProfile: string
  reportDir: string
  workers: number
  ruleConfigFile?: string
  dumpAllCG?: boolean
}

interface CFamilyRunState {
  report: string
  manifest: any
  save: () => void
  results: any[]
  graphs: any[]
  entryPointCount: number
}

type DomainSymbolIndex = ReturnType<typeof buildSymbolIndex>

/**
 * Isolated compiler tasks never change the old global preprocessor configuration.
 * @param items Selected compilation contexts.
 * @param workers Maximum number of concurrent compiler tasks.
 * @param fn Isolated compiler task.
 * @returns {Promise<U[]>} Results in the original selection order.
 */
async function parallelMap<T, U>(items: T[], workers: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        // eslint-disable-next-line no-await-in-loop -- Each pool slot must finish its task before claiming another to enforce the worker limit.
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

/**
 * Map generated node locations before recursively visiting their properties.
 * @param value Report object containing a generated location.
 * @param units Parsed units with compiler provenance.
 */
function mapGeneratedLocation(value: any, units: FamilyParsedUnit[]): void {
  if (!value.loc?.sourcefile || !value.loc.start?.line) return
  const unit = units.find((u) => value.loc.sourcefile === u.moduleFile)
  if (!unit) return
  const start = mapOrigin(unit.prepared.sourceMap, value.loc.start.line)
  const end = mapOrigin(unit.prepared.sourceMap, value.loc.end?.line || value.loc.start.line)
  if (start && !start.file.startsWith('<')) {
    value.generatedLoc = value.loc
    value.loc = {
      sourcefile: start.file,
      start: { line: start.line },
      end: { line: end?.file === start.file ? end.line : start.line },
    }
  }
}

/**
 * Map SARIF coordinates and remove columns in the generated source.
 * @param physical SARIF physical location, when present.
 * @param units Parsed units with compiler provenance.
 */
function mapPhysicalLocation(physical: any, units: FamilyParsedUnit[]): void {
  if (!physical?.artifactLocation?.uri || !physical.region?.startLine) return
  const { uri } = physical.artifactLocation
  const unit = units.find((u) => uri.includes(path.basename(u.moduleFile)))
  if (unit) {
    const start = mapOrigin(unit.prepared.sourceMap, physical.region.startLine)
    const end = mapOrigin(unit.prepared.sourceMap, physical.region.endLine || physical.region.startLine)
    if (start && !start.file.startsWith('<')) {
      physical.artifactLocation.uri = start.file
      physical.region.startLine = start.line
      physical.region.endLine = end?.file === start.file ? end.line : start.line
      if (fs.existsSync(start.file))
        physical.region.snippet = { text: fs.readFileSync(start.file, 'utf8').split('\n')[start.line - 1] || '' }
    }
  }
  delete physical.region.startColumn
  delete physical.region.endColumn
}

/**
 * All new-mode presentation coordinates come from compiler provenance.
 * @param value Report value to map in place.
 * @param units Parsed units with compiler provenance.
 * @param names Runtime symbol keys and their display names.
 * @returns {any} Mapped report value.
 */
function mapReport(value: any, units: FamilyParsedUnit[], names: Map<string, string>): any {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => mapReport(item, units, names))
  mapGeneratedLocation(value, units)
  mapPhysicalLocation(value.physicalLocation, units)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && !['id', 'sourceNodeId', 'targetNodeId', 'nodeHash', 'nodehash'].includes(key)) {
      value[key] = item.replace(/__cf_[a-f0-9]{24}/g, (match) => names.get(match) || match)
    } else mapReport(item, units, names)
  }
  return value
}

/**
 * Disclose source files missing compilation commands without selecting them.
 * @param sourcePath Project source directory.
 * @param report Absolute report directory to exclude.
 * @param entries All compilation database entries, including unselected entries.
 * @returns {object[]} Unselected translation-unit sources absent from the database.
 */
function findUncoveredSources(sourcePath: string, report: string, entries: CompileEntry[]): object[] {
  const known = new Set(entries.map((entry) => entry.sourceFile))
  return globby
    .sync('**/*.{c,C,cc,cp,cpp,CPP,cxx,c++,i,ii}', {
      cwd: path.resolve(sourcePath),
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ['**/.git/**', '**/build/**', '**/build-*/**', '**/cmake-build-*/**', '**/report/**', '**/reports/**'],
    })
    .filter((file) => !known.has(file) && file !== report && !file.startsWith(report + path.sep))
    .sort()
    .map((sourceFile) => ({ sourceFile, status: 'unselected', reason: 'missing compile commands' }))
}

/**
 * Parse one domain in selection order and save each unit's terminal parser state.
 * @param valid Prepared units in this domain.
 * @param index Symbol identities scoped to this domain.
 * @param state Scan artifacts and atomic manifest checkpoint.
 * @returns {Promise<FamilyParsedUnit[]>} Units with an AST, including partial parses.
 */
async function parseDomainUnits(
  valid: CompilerPreparedUnit[],
  index: DomainSymbolIndex,
  state: CFamilyRunState
): Promise<FamilyParsedUnit[]> {
  const { manifest, save } = state
  const parsed: FamilyParsedUnit[] = []
  for (const unit of valid) {
    // eslint-disable-next-line no-await-in-loop -- Preserve shared parser initialization and per-unit manifest checkpoints in selection order.
    const parsedUnit = await parsePreparedUnit(unit, index.get(unit.context.unitId)!)
    parsed.push(parsedUnit)
    const row = manifest.units.find((r: any) => r.unitId === unit.context.unitId)
    if (parsedUnit.status === 'parsed') row.status = 'parsed'
    else row.status = parsedUnit.status === 'partial' ? 'partial' : 'parse_failed'
    row.diagnostics.push(...parsedUnit.diagnostics)
    row.functionDeclarations = unit.metadata!.declarations.filter((d) => d.kind === 'FunctionDecl').length
    save()
  }
  return parsed.filter((u) => u.ast)
}

/**
 * Run an isolated domain worker and retain its original job, logs, and raw reports.
 * @param request Scan options.
 * @param directory Domain artifact directory.
 * @param originalRules Unresolved rule configuration.
 * @param index Symbol identities scoped to this domain.
 * @param ready Parsed units selected for the worker.
 * @returns {Promise<string>} Directory containing the worker's raw reports.
 */
async function executeDomainWorker(
  request: CFamilyRequest,
  directory: string,
  originalRules: any,
  index: DomainSymbolIndex,
  ready: FamilyParsedUnit[]
): Promise<string> {
  const workerReport = path.join(directory, 'report')
  const job = path.join(directory, 'request.json')
  const resolvedRules = path.join(directory, 'resolved-rules.json')
  fs.writeFileSync(
    resolvedRules,
    JSON.stringify(resolveRuleConfig(originalRules, index, ready, path.resolve(request.sourcePath)), null, 2)
  )
  fs.writeFileSync(
    job,
    JSON.stringify(
      {
        sourcePath: path.resolve(request.sourcePath),
        ruleConfigFile: resolvedRules,
        reportDir: workerReport,
        dumpAllCG: request.dumpAllCG,
        units: ready.map((u) => ({
          ast: u.ast,
          moduleFile: u.moduleFile,
          projectTextFile: path.join(u.prepared.directory, 'project.txt'),
          dependencies: u.prepared.dependencies,
        })),
      },
      (key, value) => (key === 'parent' ? undefined : value)
    )
  )
  const javascriptWorker = path.join(__dirname, 'c-family-analysis-worker.js')
  const worker = fs.existsSync(javascriptWorker)
    ? javascriptWorker
    : path.join(__dirname, 'c-family-analysis-worker.ts')
  const args = worker.endsWith('.ts') ? ['--import', 'tsx', worker, job] : [worker, job]
  fs.writeFileSync(path.join(directory, 'argv.json'), JSON.stringify([process.execPath, ...args], null, 2))
  try {
    const output = await execute(process.execPath, args, {
      cwd: path.resolve(__dirname, '../..'),
      timeout: 600_000,
      maxBuffer: 128 * 1024 * 1024,
    })
    fs.writeFileSync(path.join(directory, 'engine.log'), output.stdout + output.stderr)
  } catch (error: any) {
    fs.writeFileSync(
      path.join(directory, 'engine.log'),
      String(error.stdout || '') + String(error.stderr || error.message)
    )
    throw error
  }
  return workerReport
}

/**
 * Validate worker completion before mapping findings into the aggregate reports.
 * @param state Scan artifacts and counters, including counts retained after later failures.
 * @param profileId Selected build profile identity.
 * @param domain Domain manifest row.
 * @param ready Parsed units belonging to this domain.
 * @param index Symbol identities scoped to this domain.
 * @param workerReport Directory containing untouched worker output.
 */
function collectDomainResults(
  state: CFamilyRunState,
  profileId: string,
  domain: any,
  ready: FamilyParsedUnit[],
  index: DomainSymbolIndex,
  workerReport: string
): void {
  const { domainId } = domain
  const summary = read(path.join(workerReport, 'scan_summary.json'))
  const completion = read(path.join(workerReport, 'worker-state.json'))
  if (completion.exceptionCount || completion.timedOutEntryPoints)
    throw new Error(`Incomplete engine execution: ${JSON.stringify(completion)}`)
  if (!Number.isInteger(summary.entryPointCount) || summary.entryPointCount < 1)
    throw new Error('No analyzed entrypoints in selected link domain')
  domain.entryPointCount = summary.entryPointCount
  state.entryPointCount += summary.entryPointCount || 0
  const sarif = path.join(workerReport, 'report.sarif')
  const rawResults = fs.existsSync(sarif) ? read(sarif).runs.flatMap((run: any) => run.results || []) : []
  if ((summary.findingCount || 0) !== rawResults.length) throw new Error('Worker SARIF and scan summary disagree')
  const names = new Map<string, string>()
  for (const symbols of index.values()) for (const symbol of symbols.values()) names.set(symbol.key, symbol.displayName)
  for (const finding of rawResults) {
    const root = ready.find((unit) =>
      String(finding.entrypoint?.filePath || '').includes(path.basename(unit.moduleFile))
    )
    finding.properties = {
      ...finding.properties,
      cFamily: {
        profileId,
        domainId,
        rootUnitId: root?.prepared.context.unitId,
        unitIds: ready.map((u) => u.prepared.context.unitId),
      },
    }
    state.results.push(mapReport(finding, ready, names))
  }
  const cg = path.join(workerReport, 'callgraph.json')
  if (fs.existsSync(cg)) state.graphs.push({ profileId, domainId, graph: mapReport(read(cg), ready, names) })
}

/**
 * Record domain failure while preserving earlier preprocessing and parsing failures.
 * @param domain Domain manifest row.
 * @param valid Prepared units belonging to this domain.
 * @param state Scan manifest and artifacts.
 * @param error Worker, parser, or report failure.
 */
function recordDomainFailure(domain: any, valid: CompilerPreparedUnit[], state: CFamilyRunState, error: any): void {
  domain.status = 'failed'
  domain.diagnostic = String(error.message)
  for (const unit of valid) {
    const row = state.manifest.units.find((r: any) => r.unitId === unit.context.unitId)
    if (!['preprocess_failed', 'parse_failed'].includes(row.status)) row.status = 'analysis_failed'
    row.diagnostics.push({ code: 'analysis_failed', message: String(error.message) })
  }
}

/**
 * Finish one domain before another can initialize a worker or update its manifest state.
 * @param request Scan options.
 * @param state Scan artifacts and atomic manifest checkpoint.
 * @param profileId Selected build profile identity.
 * @param domainId Selected link-domain identity.
 * @param prepared All selected compiler products.
 * @param originalRules Unresolved rule configuration.
 * @returns {Promise<void>} Completion of this domain's success or failure checkpoint.
 */
async function analyzeDomain(
  request: CFamilyRequest,
  state: CFamilyRunState,
  profileId: string,
  domainId: string,
  prepared: CompilerPreparedUnit[],
  originalRules: any
): Promise<void> {
  const { report, manifest, save } = state
  const selected = prepared.filter((u) => u.context.domainId === domainId)
  const valid = selected.filter((u) => u.status === 'prepared')
  const domain: any = { domainId, status: 'running', units: selected.map((u) => u.context.unitId) }
  manifest.domains.push(domain)
  try {
    if (!valid.length) throw new Error('No prepared translation units in this domain')
    for (const unit of valid) retainLibraryBodies(unit, modeledAPIs(originalRules))
    const index = buildSymbolIndex(valid)
    const ready = await parseDomainUnits(valid, index, state)
    if (!ready.length) throw new Error('No parsed translation units in this domain')
    const directory = path.join(report, 'domains', createHash('sha256').update(domainId).digest('hex'))
    fs.mkdirSync(directory, { recursive: true })
    const workerReport = await executeDomainWorker(request, directory, originalRules, index, ready)
    collectDomainResults(state, profileId, domain, ready, index, workerReport)
    for (const unit of ready) {
      const row = manifest.units.find((r: any) => r.unitId === unit.prepared.context.unitId)
      if (row.status === 'parsed') row.status = selected.length === valid.length ? 'analyzed' : 'partial'
    }
    domain.status = selected.every(
      (u) => manifest.units.find((r: any) => r.unitId === u.context.unitId).status === 'analyzed'
    )
      ? 'complete'
      : 'partial'
  } catch (error: any) {
    recordDomainFailure(domain, valid, state, error)
  }
  save()
}

/**
 * Finalize aggregate status and reject changes to selected source or configuration inputs.
 * @param prepared Compiler products with dependency hashes.
 * @param inputPaths Configuration files hashed when the scan started.
 * @param state Scan artifacts and manifest; configuration changes retain all unit states.
 */
function finalizeManifest(
  prepared: CompilerPreparedUnit[],
  inputPaths: Record<string, string>,
  state: CFamilyRunState
): void {
  const { manifest, results } = state
  if (manifest.units.every((u: any) => u.status === 'analyzed')) manifest.status = 'complete'
  else manifest.status = results.length ? 'partial' : 'failed'
  for (const unit of prepared) {
    if (
      unit.dependencies.some(
        (dependency) => !fs.existsSync(dependency.file) || sha(dependency.file) !== dependency.sha256
      )
    ) {
      const row = manifest.units.find((u: any) => u.unitId === unit.context.unitId)
      row.status = 'partial'
      row.diagnostics.push({ code: 'input_changed', message: 'A selected input changed before scan completion' })
      manifest.status = 'partial'
    }
  }
  for (const [name, file] of Object.entries(inputPaths)) {
    if (!fs.existsSync(file) || sha(file) !== manifest.inputs[name]) {
      manifest.status = 'partial'
      manifest.diagnostics.push({
        code: 'input_changed',
        message: `The selected ${name} input changed before scan completion`,
      })
    }
  }
}

/**
 * Run one build profile, preserving a terminal record for every selected TU.
 * @param request Build profile, compiler inputs, and report options.
 * @returns {Promise<object>} Terminal scan status and manifest path.
 */
export async function runCfamily(request: CFamilyRequest): Promise<{ status: string; manifestPath: string }> {
  const report = path.resolve(request.reportDir)
  if (fs.existsSync(report) && fs.readdirSync(report).length) throw new Error('Mixed report directory must be empty')
  fs.mkdirSync(report, { recursive: true })
  const lock = path.join(report, '.analysis.lock')
  const fd = fs.openSync(lock, 'wx')
  fs.closeSync(fd)
  const manifestPath = path.join(report, 'analysis-manifest.json')
  const manifest: any = {
    version: 1,
    language: 'c-cpp',
    status: 'running',
    sourcePath: path.resolve(request.sourcePath),
    units: [],
    domains: [],
    diagnostics: [],
    started: new Date().toISOString(),
  }
  const save = () => {
    const temporary = `${manifestPath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2))
    fs.renameSync(temporary, manifestPath)
  }
  const state: CFamilyRunState = { report, manifest, save, results: [], graphs: [], entryPointCount: 0 }
  try {
    if (!Number.isSafeInteger(request.workers) || request.workers < 1)
      throw new Error('workerCount must be a positive integer')
    const entries = await readCompilationDatabase(path.resolve(request.compileCommands))
    const profile = read(path.resolve(request.buildProfile))
    const contexts = selectBuildContexts(entries, profile)
    const ruleConfigFile = path.resolve(
      request.ruleConfigFile || path.join(__dirname, '../../resource/example-rule-config/rule_config_c_family.json')
    )
    const originalRules = read(ruleConfigFile)
    manifest.profileId = profile.profileId
    manifest.inputs = {
      compileCommands: sha(request.compileCommands),
      buildProfile: sha(request.buildProfile),
      ruleConfig: sha(ruleConfigFile),
    }
    manifest.units = contexts.map((context) => ({
      unitId: context.unitId,
      domainId: context.domainId,
      sourceFile: context.sourceFile,
      language: context.language,
      status: 'pending',
      diagnostics: [],
    }))
    manifest.unselected = entries
      .filter((e) => !contexts.some((c) => c.entryId === e.entryId))
      .map((e) => ({ entryId: e.entryId, sourceFile: e.sourceFile, reason: 'not selected in build profile' }))
    manifest.uncoveredSources = findUncoveredSources(request.sourcePath, report, entries)
    save()
    const products = path.join(report, 'units')
    fs.mkdirSync(products)
    const prepared = await parallelMap(contexts, request.workers, async (context) => {
      const unit = await preprocessUnit(context, products)
      const row = manifest.units.find((r: any) => r.unitId === context.unitId)
      row.status = unit.status === 'prepared' ? 'prepared' : 'preprocess_failed'
      row.diagnostics = unit.diagnostics
      row.artifactHash = unit.artifactHash
      save()
      return unit
    })
    for (const domainId of [...new Set(contexts.map((c) => c.domainId))]) {
      // eslint-disable-next-line no-await-in-loop -- Finish each isolated domain and its manifest checkpoint before starting the next worker.
      await analyzeDomain(request, state, profile.profileId, domainId, prepared, originalRules)
    }
    finalizeManifest(
      prepared,
      { compileCommands: request.compileCommands, buildProfile: request.buildProfile, ruleConfig: ruleConfigFile },
      state
    )
  } catch (error: any) {
    manifest.status = 'failed'
    manifest.diagnostics.push({ code: 'configuration_failed', message: String(error.message) })
    for (const unit of manifest.units)
      if (['pending', 'prepared', 'parsed'].includes(unit.status)) unit.status = 'analysis_failed'
  } finally {
    const { results, graphs, entryPointCount } = state
    manifest.finished = new Date().toISOString()
    save()
    fs.writeFileSync(
      path.join(report, 'report.sarif'),
      JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'yasa', version: 'c-family' } }, results }] })
    )
    fs.writeFileSync(path.join(report, 'callgraph.json'), JSON.stringify({ domains: graphs }))
    fs.writeFileSync(
      path.join(report, 'scan_summary.json'),
      JSON.stringify(
        {
          language: 'c-cpp',
          status: manifest.status,
          findingCount: results.length,
          fileCount: manifest.units.length,
          entryPointCount,
          analyzedUnits: manifest.units.filter((u: any) => u.status === 'analyzed').length,
        },
        null,
        2
      )
    )
    fs.unlinkSync(lock)
  }
  return { status: manifest.status, manifestPath }
}

/**
 * Parse mixed-language CLI options and return the scan's terminal status.
 * @param directory Default project source directory, when supplied by the caller.
 * @param args Command-line arguments without the executable name.
 * @returns {Promise<any>} Scan status or a CLI failure result.
 */
export async function runCfamilyCLI(directory: string | null, args: string[]): Promise<any> {
  const program = new Command().exitOverride()
  program
    .option('--sourcePath <path>', 'Project source directory', directory || undefined)
    .option('--language <language>')
    .requiredOption('--compileCommands <file>')
    .requiredOption('--buildProfile <file>')
    .requiredOption('--report <directory>')
    .option('--workerCount <number>', 'Parallel compilation contexts', '1')
    .option('--ruleConfigFile <file>')
    .option('--checkerPackIds <ids>')
    .option('--checkerIds <ids>')
    .option('--dumpAllCG')
  try {
    program.parse(args, { from: 'user' })
    const options = program.opts()
    if (!options.sourcePath || !fs.statSync(options.sourcePath).isDirectory())
      throw new Error('Mixed scanning requires a source directory')
    if (options.checkerPackIds && options.checkerPackIds !== 'taint-flow-c-family-default')
      throw new Error('Use the C-family checker pack')
    if (
      options.checkerIds &&
      options.checkerIds !== 'taint_flow_c_cpp_input' &&
      options.checkerIds !== 'callgraph,taint_flow_c_cpp_input' &&
      options.checkerIds !== 'taint_flow_c_cpp_input,callgraph'
    ) {
      throw new Error('Mixed scanning supports taint_flow_c_cpp_input with optional callgraph')
    }
    const result = await runCfamily({
      sourcePath: options.sourcePath,
      compileCommands: options.compileCommands,
      buildProfile: options.buildProfile,
      workers: Number(options.workerCount),
      reportDir: options.report,
      ruleConfigFile: options.ruleConfigFile,
      dumpAllCG: options.dumpAllCG || options.checkerIds?.split(',').includes('callgraph'),
    })
    process.exitCode = result.status === 'complete' ? 0 : 2
    console.log(JSON.stringify(result))
    return result
  } catch (error: any) {
    if (error.code === 'commander.helpDisplayed') {
      process.exitCode = 0
      return { status: 'help' }
    }
    console.error(String(error.message))
    process.exitCode = 2
    return { status: 'failed' }
  }
}
