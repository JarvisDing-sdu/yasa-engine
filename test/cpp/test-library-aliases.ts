import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

const ENGINE = path.resolve(__dirname, '../..')
const cases = [
  ['qualified library sink', 'namespace N { using ::system; } int main() { return N::system(getenv("X")); }', true],
  ['qualified library source', 'namespace N { using ::getenv; } int main() { return system(N::getenv("X")); }', true],
  ['transitive library import', 'namespace N { using ::system; } namespace M { using N::system; } int main() { return M::system(getenv("X")); }', true],
  ['using directive exports library import', 'namespace N { using ::system; } namespace M { using namespace N; } int main() { return M::system(getenv("X")); }', true],
  ['nested namespace library import', 'namespace N { namespace M { using ::system; } } int main() { return N::M::system(getenv("X")); }', true],
  ['fixed argument to imported sink', 'namespace N { using ::system; } int main() { return N::system("true"); }', false],
  ['imported custom sink stays custom', 'namespace N { int system(const char *) { return 0; } } namespace M { using N::system; } int main() { return M::system(getenv("X")); }', false],
  ['imported custom source stays custom', 'namespace N { char *getenv(const char *) { static char safe[] = "true"; return safe; } } namespace M { using N::getenv; } int main() { return system(M::getenv("X")); }', false],
  ['using directive cycle resolves an imported sink', 'namespace N {} namespace M { using namespace N; using ::system; } namespace N { using namespace M; } int main() { return N::system(getenv("X")); }', true],
  ['forwards taint through an imported function on the same source line', 'namespace N { char *forward(char *p) { return p; } } namespace M { using N::forward; } int main() { return system(M::forward(getenv("X"))); }', true],
  ['relative std namespace belongs to its enclosing user namespace', 'namespace X { namespace std { int system(const char *); } namespace Export { using std::system; } } int main() { return X::Export::system(getenv("X")); }', false],
] as const

describe('C++ library imports retain their resolved function identity', function () {
  this.timeout(60_000)
  for (const [name, code, expected] of cases) {
    it(name, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-library-alias-'))
      const source = path.join(directory, 'main.cpp')
      const report = path.join(directory, 'report')
      fs.writeFileSync(source, `#include <cstdlib>\n${code}\n`)
      execFileSync(process.execPath, ['--import', 'tsx', 'src/main.ts',
        '--sourcePath', source, '--language', 'cpp',
        '--ruleConfigFile', 'resource/example-rule-config/rule_config_cpp.json',
        '--checkerPackIds', 'taint-flow-cpp-default', '--report', report], { cwd: ENGINE, stdio: 'pipe' })
      const summary = JSON.parse(fs.readFileSync(path.join(report, 'scan_summary.json'), 'utf8'))
      assert.strictEqual(summary.fileCount, 1)
      assert.ok(summary.entryPointCount > 0, 'the program must have an analyzed entry point')
      const sarif = path.join(report, 'report.sarif')
      const results = fs.existsSync(sarif)
        ? JSON.parse(fs.readFileSync(sarif, 'utf8')).runs.flatMap((run: any) => run.results || []) : []
      assert.strictEqual(results.length > 0, expected)
    })
  }
})
