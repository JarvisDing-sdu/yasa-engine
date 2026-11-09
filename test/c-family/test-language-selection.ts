import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const ENGINE = path.resolve(__dirname, '../..')
const SOURCE = `#ifdef __cplusplus
namespace command { inline int cpp_branch() { return 1; } }
#else
static inline int c_branch(void) { return 0; }
#endif
`

function dumpAst(args: string[]): any {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa language-'))
  const source = path.join(directory, 'shared.h')
  const report = path.join(directory, 'ast.json')
  fs.writeFileSync(source, SOURCE)
  const config = path.join(directory, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ language: 'cpp' }))
  const options = args.map(arg => arg === '<config>' ? config : arg)
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', 'src/main.ts', '--sourcePath', source,
    ...options, '--dumpAST', '--report', report,
  ], { cwd: ENGINE, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(fs.readFileSync(report, 'utf8'))
}

function functionNames(ast: any): string[] {
  const names: string[] = []
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDefinition') names.push(node._meta?.qualifiedName || node.id.name)
    for (const [key, value] of Object.entries(node)) {
      if (key !== '_meta' && key !== 'loc' && key !== 'parent') visit(value)
    }
  }
  visit(ast)
  return names
}

function dumpTwice(extension: string, configuredLanguage?: string, failInitialization = false): any {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-header-batch-'))
  fs.writeFileSync(path.join(directory, 'first.cpp'), SOURCE)
  fs.writeFileSync(path.join(directory, `second${extension}`), SOURCE)
  const script = path.join(directory, 'run.cjs')
  fs.writeFileSync(script, `
const { execute } = require(${JSON.stringify(path.join(ENGINE, 'src/interface/starter.ts'))});
const Config = require(${JSON.stringify(path.join(ENGINE, 'src/config.ts'))});
const parser = require(${JSON.stringify(path.join(ENGINE, 'src/engine/parser/parser.ts'))});
(async () => {
  const initialize = parser.ensureInitialized;
  const fail = ${JSON.stringify(failInitialization)};
  if (fail) parser.ensureInitialized = async () => { throw new Error('test initialization failure'); };
  let failed = false;
  try {
    await execute(null, ['--sourcePath', ${JSON.stringify(path.join(directory, 'first.cpp'))}, '--dumpAST', '--report', ${JSON.stringify(path.join(directory, 'first.json'))}]);
  } catch (error) {
    if (!fail) throw error;
    failed = true;
  } finally {
    parser.ensureInitialized = initialize;
  }
  if (fail && !failed) throw new Error('expected initialization failure');
  ${configuredLanguage ? `Config.language = ${JSON.stringify(configuredLanguage)};` : ''}
  await execute(null, ['--sourcePath', ${JSON.stringify(path.join(directory, `second${extension}`))}, '--dumpAST', '--report', ${JSON.stringify(path.join(directory, 'second.json'))}]);
})().catch(error => { console.error(error); process.exitCode = 1; });
`)
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: ENGINE, encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stdout + result.stderr)
  if (!failInitialization) {
    const first = JSON.parse(fs.readFileSync(path.join(directory, 'first.json'), 'utf8'))
    assert.strictEqual(first.language, 'cpp')
  }
  return JSON.parse(fs.readFileSync(path.join(directory, 'second.json'), 'utf8'))
}

describe('single-file language selection', function () {
  this.timeout(60_000)

  it('explicit_cpp_header_wins_over_suffix', () => {
    const ast = dumpAst(['--language', 'cpp'])
    assert.strictEqual(ast.language, 'cpp')
    assert.deepStrictEqual(functionNames(ast), ['command::cpp_branch'])
    assert.deepStrictEqual(ast._meta.parseErrors, [])
  })

  it('explicit_c_header_stays_c', () => {
    const ast = dumpAst(['--language', 'c'])
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(functionNames(ast), ['c_branch'])
  })

  it('analyzer_language_is_preserved_before_ast_export', () => {
    const ast = dumpAst(['--language', 'c', '--analyzer', 'CppAnalyzer'])
    assert.strictEqual(ast.language, 'cpp')
    assert.deepStrictEqual(functionNames(ast), ['command::cpp_branch'])
  })

  it('explicit_c_analyzer_has_existing_precedence_over_cpp', () => {
    const ast = dumpAst(['--language', 'cpp', '--analyzer', 'CAnalyzer'])
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(functionNames(ast), ['c_branch'])
  })

  it('config_language_is_preserved', () => {
    const ast = dumpAst(['--configFilePath', '<config>'])
    assert.strictEqual(ast.language, 'cpp')
    assert.deepStrictEqual(functionNames(ast), ['command::cpp_branch'])
  })

  it('header_without_language_keeps_legacy_c_default', () => {
    const ast = dumpAst([])
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(functionNames(ast), ['c_branch'])
  })

  it('sequential_ast_exports_infer_each_header_independently', () => {
    const ast = dumpTwice('.h')
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(functionNames(ast), ['c_branch'])
  })

  it('sequential_ast_exports_infer_a_c_source_after_cpp', () => {
    const ast = dumpTwice('.c')
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(functionNames(ast), ['c_branch'])
  })

  it('preserves_programmatic_language_configuration_between_exports', () => {
    const ast = dumpTwice('.h', 'cpp')
    assert.strictEqual(ast.language, 'cpp')
    assert.deepStrictEqual(functionNames(ast), ['command::cpp_branch'])
  })

  it('restores_inferred_language_after_parser_initialization_failure', () => {
    const ast = dumpTwice('.h', undefined, true)
    assert.strictEqual(ast.language, 'c')
    assert.deepStrictEqual(functionNames(ast), ['c_branch'])
  })

  it('scans_a_cpp_header_through_the_normal_analysis_entry', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-header-scan-'))
    const source = path.join(directory, 'shared.h')
    const report = path.join(directory, 'report')
    fs.writeFileSync(source, `#include <cstdlib>
#ifdef __cplusplus
namespace command { int run() { return system(getenv("X")); } }
#else
int run(void) { return 0; }
#endif
`)
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts',
      '--sourcePath', source, '--language', 'cpp',
      '--checkerPackIds', 'taint-flow-cpp-default',
      '--ruleConfigFile', 'resource/example-rule-config/rule_config_cpp.json',
      '--report', report,
    ], { cwd: ENGINE, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(result.error)
    assert.strictEqual(result.status, 0, result.stdout + result.stderr)
    const summary = JSON.parse(fs.readFileSync(path.join(report, 'scan_summary.json'), 'utf8'))
    assert.strictEqual(summary.language, 'cpp')
    const sarif = JSON.parse(fs.readFileSync(path.join(report, 'report.sarif'), 'utf8'))
    assert.strictEqual(sarif.runs[0].results.length, 1)
    assert.strictEqual(sarif.runs[0].results[0].sinkInfo.sinkRule, 'system')
  })

})
