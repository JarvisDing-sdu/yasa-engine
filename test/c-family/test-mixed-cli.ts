import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

// Black-box acceptance: no imports from the mixed runner, parser or ID helpers.
// Run from engine: node --import tsx node_modules/mocha/bin/mocha test/c-family/test-mixed-cli.ts
const ENGINE = path.resolve(__dirname, '../..')
const FIXTURES = path.resolve(ENGINE, '../workstreams/yasa-cpp-extension/fixtures/mixed')
const GOLD_BYTES = fs.readFileSync(path.join(FIXTURES, 'gold.json'))
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const identity = (value: unknown[]): string => sha256(JSON.stringify(value))

interface Program { domainId: string; sources: string[] }
interface GoldCase {
  goldName: string
  directory: string
  outcome: 'finding' | 'clean' | 'failure'
  programs: Program[]
  sourceFile: string
  sourceLine: number | null
  sinkFile: string
  sinkLine: number | null
  sinkRule: string
  traceFiles: string[]
  expectedEdges: string[][]
  findingDomainId: string
  sha256: Record<string, string>
}
const GOLD: { version: number; profileId: string; frozenBeforeNewMode: boolean; cases: GoldCase[] } =
  JSON.parse(GOLD_BYTES.toString('utf8'))

interface SelectedUnit { unitId: string; entryId: string; domainId: string; sourceFile: string }
interface PreparedCase {
  gold: GoldCase
  source: string
  database: string
  profile: string
  report: string
  selected: SelectedUnit[]
}
interface ManifestUnit { unitId: string; domainId: string; sourceFile: string; status: string; diagnostics: unknown[] }
interface AnalysisManifest { units: ManifestUnit[]; diagnostics: unknown[] }
const prepared = new Map<string, PreparedCase>()
let runRoot: string

function json(file: string): any {
  assert.ok(fs.existsSync(file), `Required report missing: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function checkedProcess(executable: string, argv: string[], cwd: string): void {
  const result = spawnSync(executable, argv, {
    cwd, encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.strictEqual(result.signal, null, `${executable}: ${result.signal}`)
  assert.strictEqual(result.status, 0, `${executable} ${JSON.stringify(argv)}\n${result.stdout}\n${result.stderr}`)
}

function fixtureFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name)
    return entry.isDirectory() ? fixtureFiles(full) : [full]
  })
}

function prepareAll(): void {
  assert.strictEqual(GOLD.version, 1)
  assert.strictEqual(GOLD.frozenBeforeNewMode, true)
  assert.strictEqual(new Set(GOLD.cases.map(item => item.goldName)).size, GOLD.cases.length)
  assert.strictEqual(GOLD.cases.filter(item => item.outcome === 'finding').length, 13)
  assert.strictEqual(GOLD.cases.filter(item => item.outcome === 'clean').length, 13)
  assert.strictEqual(GOLD.cases.filter(item => item.outcome === 'failure').length, 1)
  runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa mixed acceptance-'))
  const proof: unknown[] = []
  // Validate ALL frozen input bytes before compiling or invoking the new mode.
  for (const gold of GOLD.cases) {
    const original = path.join(FIXTURES, gold.directory)
    assert.deepStrictEqual(fixtureFiles(original).map(file => path.relative(original, file)).sort(), Object.keys(gold.sha256).sort())
    for (const [file, digest] of Object.entries(gold.sha256)) {
      assert.strictEqual(sha256(fs.readFileSync(path.join(original, file))), digest, `${gold.goldName}/${file}: frozen input changed`)
    }
  }
  fs.writeFileSync(path.join(runRoot, 'gold-frozen.json'), GOLD_BYTES, { flag: 'wx' })
  for (const gold of GOLD.cases) {
    const caseRoot = path.join(runRoot, gold.goldName)
    const source = path.join(caseRoot, 'source')
    fs.mkdirSync(caseRoot)
    fs.cpSync(path.join(FIXTURES, gold.directory), source, { recursive: true })
    const records: { directory: string; file: string; arguments: string[] }[] = []
    const selected: SelectedUnit[] = []
    for (const program of gold.programs) {
      const build = path.join(caseRoot, 'build', program.domainId)
      fs.mkdirSync(build, { recursive: true })
      const objects: string[] = []
      for (const [index, file] of program.sources.entries()) {
        const sourceFile = path.resolve(source, file)
        const directory = path.resolve(source)
        const cpp = file.endsWith('.cpp')
        const object = path.join(build, `${index}.o`)
        const argv = [cpp ? '/usr/bin/clang++' : '/usr/bin/clang', cpp ? '-std=c++17' : '-std=c17', '-c', sourceFile, '-o', object]
        // This ID is independently calculated from the public database contract.
        const entryId = identity([directory, sourceFile, argv])
        selected.push({ entryId, unitId: identity([GOLD.profileId, program.domainId, entryId]), domainId: program.domainId, sourceFile })
        records.push({ directory, file: sourceFile, arguments: argv })
        checkedProcess(argv[0], argv.slice(1), directory)
        assert.ok(fs.statSync(object).size > 0, `${gold.goldName}: missing object ${object}`)
        proof.push({ goldName: gold.goldName, domainId: program.domainId, stage: 'compile', argv, exitCode: 0 })
        objects.push(object)
      }
      const executable = path.join(build, 'fixture-program')
      const link = ['/usr/bin/clang++', ...objects, '-o', executable]
      checkedProcess(link[0], link.slice(1), source)
      assert.ok(fs.statSync(executable).size > 0)
      proof.push({ goldName: gold.goldName, domainId: program.domainId, stage: 'link', argv: link, exitCode: 0 })
      // Never execute this binary: the positive fixtures deliberately reach system().
    }
    const database = path.join(caseRoot, 'compile_commands.json')
    const profile = path.join(caseRoot, 'build-profile.json')
    fs.writeFileSync(database, JSON.stringify(records, null, 2), { flag: 'wx' })
    fs.writeFileSync(profile, JSON.stringify({ version: 1, profileId: GOLD.profileId, units: selected.map(({ entryId, domainId }) => ({ entryId, domainId })) }, null, 2), { flag: 'wx' })
    prepared.set(gold.goldName, { gold, source, database, profile, report: path.join(caseRoot, 'report'), selected })
    console.log(`[mixed-build] ${gold.goldName}: compiled ${records.length} units; linked ${gold.programs.length} program(s); NOT executed`)
  }
  // The failure fixture is genuinely buildable; invalidate only its staged copy
  // after the compiler/linker proof, without touching frozen fixture inputs.
  fs.unlinkSync(path.join(prepared.get('missing_generated_header')!.source, 'generated.h'))
  fs.writeFileSync(path.join(runRoot, 'build-proof.json'), JSON.stringify({ goldSha256: sha256(GOLD_BYTES), commands: proof }, null, 2), { flag: 'wx' })
  console.log(`[mixed-build] all ${GOLD.cases.length} frozen fixtures compiled/linked before first new-mode scan; evidence: ${runRoot}`)
}

function scan(item: PreparedCase) {
  assert.ok(!fs.existsSync(item.report), 'Every invocation must use a fresh report directory')
  const argv = ['--import', 'tsx', 'src/main.ts', '--sourcePath', item.source,
    '--language', 'c-cpp', '--compileCommands', item.database,
    '--buildProfile', item.profile, '--report', item.report,
    ...(item.gold.goldName.startsWith('cpp_to_c_') ? ['--dumpAllCG'] : []),
  ]
  const result = spawnSync(process.execPath, argv, {
    cwd: ENGINE, encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  })
  fs.writeFileSync(path.join(path.dirname(item.report), 'cli.log'), `${JSON.stringify([process.execPath, ...argv])}\nexit=${result.status}; signal=${result.signal}\n${result.stdout || ''}\n${result.stderr || ''}`)
  assert.ifError(result.error)
  assert.strictEqual(result.signal, null, `CLI terminated by ${result.signal}`)
  return result
}

function assertSelectedManifest(item: PreparedCase): AnalysisManifest {
  const manifest = json(path.join(item.report, 'analysis-manifest.json')) as AnalysisManifest
  assert.ok(Array.isArray(manifest.units), 'Manifest must enumerate every selected unit')
  assert.ok(Array.isArray(manifest.diagnostics), 'Manifest diagnostics must be explicit')
  assert.strictEqual(manifest.units.length, item.selected.length, 'Missing or duplicated selected units')
  assert.strictEqual(new Set(manifest.units.map(unit => unit.unitId)).size, item.selected.length)
  assert.deepStrictEqual(manifest.units.map(unit => unit.unitId).sort(), item.selected.map(unit => unit.unitId).sort())
  const terminal = new Set(['analyzed', 'partial', 'preprocess_failed', 'parse_failed', 'analysis_failed', 'timed_out', 'unsupported'])
  for (const expected of item.selected) {
    const unit = manifest.units.find(value => value.unitId === expected.unitId)!
    assert.strictEqual(unit.domainId, expected.domainId)
    assert.strictEqual(unit.sourceFile, expected.sourceFile)
    assert.ok(terminal.has(unit.status), `Unit ${unit.unitId} lacks a terminal status: ${unit.status}`)
    assert.ok(Array.isArray(unit.diagnostics), `Unit ${unit.unitId} diagnostics missing`)
  }
  return manifest
}

function relativeURI(uri: string, source: string): string {
  const file = uri.startsWith('file:') ? fileURLToPath(uri) : decodeURIComponent(uri)
  return path.relative(source, path.resolve(source, file)).split(path.sep).join('/')
}

function readResults(item: PreparedCase): any[] {
  const sarif = json(path.join(item.report, 'report.sarif'))
  assert.strictEqual(sarif.version, '2.1.0')
  assert.ok(Array.isArray(sarif.runs) && sarif.runs.length > 0, 'Missing SARIF run is not zero findings')
  for (const run of sarif.runs) assert.ok(Array.isArray(run.results), 'Missing SARIF results is not zero findings')
  return sarif.runs.flatMap((run: any) => run.results)
}

describe('mixed C/C++ public CLI acceptance (frozen gold)', function () {
  this.timeout(300_000)
  before(function () { prepareAll() })

  for (const gold of GOLD.cases.filter(item => item.outcome !== 'failure')) {
    it(`${gold.goldName}: ${gold.outcome}, complete selected-unit coverage`, function () {
      const item = prepared.get(gold.goldName)!
      const result = scan(item)
      assert.strictEqual(result.status, 0, `Mixed CLI must support the public command and analyze every selected unit.\n${result.stdout}\n${result.stderr}`)
      const manifest = assertSelectedManifest(item)
      assert.ok(manifest.units.every(unit => unit.status === 'analyzed'), `Exit 0 cannot hide incomplete coverage: ${JSON.stringify(manifest)}`)
      // Entry-point evidence is required even for negatives: reading files alone
      // or parsing a graph without symbol interpretation cannot earn a clean pass.
      const summary = json(path.join(item.report, 'scan_summary.json'))
      assert.ok(Number.isInteger(summary.entryPointCount) && summary.entryPointCount > 0, 'No analyzed entrypoints')
      const findings = readResults(item)
      if (gold.outcome === 'clean') {
        assert.strictEqual(findings.length, 0, `${gold.goldName}: false positive / ABI, domain, header or TU-state contamination\n${JSON.stringify(findings)}`)
        return
      }
      assert.ok(findings.length > 0, `${gold.goldName}: false negative against frozen gold`)
      const matched = findings.some(finding => {
        if (finding.sinkInfo?.sinkRule !== gold.sinkRule) return false
        const sink = finding.locations?.[0]?.physicalLocation
        if (!sink?.artifactLocation?.uri || relativeURI(sink.artifactLocation.uri, item.source) !== gold.sinkFile) return false
        if (sink.region?.startLine !== gold.sinkLine) return false
        // The two endpoints must occur in ONE real SARIF thread flow, not in
        // unrelated findings or concatenated C-only and C++-only scans.
        return (finding.codeFlows || []).some((flow: any) => (flow.threadFlows || []).some((thread: any) => {
          const files = new Set<string>((thread.locations || []).flatMap((step: any) => {
            const uri = step.location?.physicalLocation?.artifactLocation?.uri
            return uri ? [relativeURI(uri, item.source)] : []
          }))
          return gold.traceFiles.every(file => files.has(file))
        }))
      })
      assert.ok(matched, `${gold.goldName}: no system finding with original sink line and cross-language trace ${JSON.stringify(gold.traceFiles)}\n${JSON.stringify(findings)}`)
    })
  }

  it('missing_generated_header: nonzero exit and failure manifest for EVERY selected unit', function () {
    const item = prepared.get('missing_generated_header')!
    const result = scan(item)
    assert.notStrictEqual(result.status, 0, 'Missing generated header cannot be successful zero findings')
    const manifest = assertSelectedManifest(item)
    const failed = manifest.units.find(unit => unit.sourceFile === path.join(item.source, 'sink.cpp'))!
    assert.ok(['preprocess_failed', 'parse_failed', 'analysis_failed', 'partial', 'unsupported'].includes(failed.status), `Actual failed unit must not be analyzed: ${failed.status}`)
    assert.ok(!manifest.units.every(unit => unit.status === 'analyzed'))
    assert.ok(failed.diagnostics.length > 0, 'Failed unit requires a diagnostic')
    assert.match(JSON.stringify([manifest.diagnostics, failed.diagnostics]), /generated\.h/i, 'Missing-header diagnostic must identify the missing input')
  })
})
