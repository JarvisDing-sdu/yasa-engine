import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

const engine = path.resolve(__dirname, '../..')
const fixtures = path.join(__dirname, 'review-cases')
const expectations: Record<string, boolean> = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'))
// Each fixture is a separate program, so repeated names cannot violate the C++ ODR across tests.
describe('C++ M1 review regressions', function () {
  this.timeout(60000)
  for (const [name, expected] of Object.entries(expectations)) {
    it(`${expected ? 'reports' : 'does not report'} ${name}`, () => {
      const report = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-review-'))
      execFileSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--sourcePath', path.join(fixtures, name),
        '--language', 'cpp', '--ruleConfigFile', 'resource/example-rule-config/rule_config_cpp.json',
        '--checkerPackIds', 'taint-flow-cpp-default', '--report', report], { cwd: engine, stdio: 'pipe' })
      const file = path.join(report, 'report.sarif')
      const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).runs.flatMap((r: any) => r.results || []) : []
      assert.strictEqual(results.length > 0, expected, `${name}: expected ${expected ? 'a finding' : 'no findings'}`)
    })
  }
})
