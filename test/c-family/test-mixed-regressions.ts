import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import * as assert from 'assert'

const engine = path.resolve(__dirname, '../..')
const examples = [
  { name: 'system-header wrapper keeps its semantics', code: '#include <stdlib.h>\n#include <input.h>\nint main(void) { return system(input()); }\n',
    header: '#include <stdlib.h>\nstatic inline char *input(void) { return getenv("X"); }\n', flags: ['-isystem', '.'], findings: 1 },
  { name: 'custom source rules use declared API names', code: '#include <stdlib.h>\nchar *read_input(void) { return "true"; }\nint main(void) { return system(read_input()); }\n', flags: [], findings: 1, custom: true },
  { name: 'different C functions own different local static variables', code: '#include <stdlib.h>\nvoid f(void) { static char *p; p = getenv("X"); }\nint g(void) { static char *p = "true"; return system(p); }\nint main(void) { f(); return g(); }\n', flags: [], findings: 0 },
  { name: 'assembly aliases use the actual C ABI symbol', code: '#include <stdlib.h>\n#ifdef __APPLE__\nint run(const char *) __asm__("_system");\n#else\nint run(const char *) __asm__("system");\n#endif\nint main(void) { return run(getenv("X")); }\n', flags: [], findings: 1 },
  { name: 'language switches after the source do not change that source', code: '#include <stdlib.h>\nint class = 1;\nint main(void) { return system(getenv("X")); }\n', flags: ['-x', 'c'], after: ['-x', 'c++'], findings: 1 },
  { name: 'unsupported semantics in a required system body prevent success', code: '#include <stdlib.h>\n#include <input.h>\nint main() { return system(input()); }\n', header: 'static inline char *input() { return new char[4]; }\n', flags: ['-isystem', '.'], findings: 0, cpp: true, partial: true },
  { name: 'system-header dynamic global initialization prevents silent success', code: '#include <input.h>\nint main() { return 0; }\n', header: '#include <stdlib.h>\nclass Global { public: Global() { system(getenv("X")); } };\nstatic Global initialize;\n', flags: ['-isystem', '.'], findings: 0, cpp: true, partial: true },
  { name: 'recursive main remains a program entrypoint', code: '#include <stdlib.h>\nvoid harmless(void) {}\nint main(int argc, char **argv) { if (argc < 0) return main(argc + 1, argv); return system(getenv("X")); }\n', flags: [], findings: 1 },
  { name: 'a mutually recursive root component is not silently omitted', code: '#include <stdlib.h>\nint b(int);\nint a(int n) { if (n) return b(n - 1); return system(getenv("X")); }\nint b(int n) { return a(n - 1); }\nint main(void) { return 0; }\n', flags: [], findings: 1 },
] as const

describe('mixed scanner review regressions', function () {
  this.timeout(120_000)
  for (const example of examples) {
    it(example.name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-mixed-review-'))
      const source = path.join(root, (example as any).cpp ? 'main.cpp' : 'main.c')
      const report = path.join(root, 'report')
      const input: any = example
      fs.writeFileSync(source, example.code)
      if (input.header) fs.writeFileSync(path.join(root, 'input.h'), input.header)
      const args = [input.cpp ? '/usr/bin/clang++' : '/usr/bin/clang', input.cpp ? '-std=c++17' : '-std=c17', ...example.flags, source, ...(input.after || []), '-c', '-o', path.join(root, 'main.o')]
      const compiled = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' })
      assert.strictEqual(compiled.status, 0, compiled.stderr)
      const linked = spawnSync(args[0], [path.join(root, 'main.o'), '-o', path.join(root, 'example')], { encoding: 'utf8' })
      assert.strictEqual(linked.status, 0, linked.stderr)
      const entryId = createHash('sha256').update(JSON.stringify([root, source, args])).digest('hex')
      const db = path.join(root, 'compile_commands.json')
      const profile = path.join(root, 'profile.json')
      fs.writeFileSync(db, JSON.stringify([{ directory: root, file: source, arguments: args }]))
      fs.writeFileSync(profile, JSON.stringify({ version: 1, profileId: 'review', units: [{ entryId, domainId: 'app' }] }))
      const cli = ['--import', 'tsx', 'src/main.ts', '--language', 'c-cpp', '--sourcePath', root,
        '--compileCommands', db, '--buildProfile', profile, '--report', report]
      if (input.custom) {
        const rules = JSON.parse(fs.readFileSync(path.join(engine, 'resource/example-rule-config/rule_config_c.json'), 'utf8'))
        rules[0].sources.FuncCallReturnValueTaintSource.push({ fsig: 'read_input', kind: 'C_INPUT' })
        const file = path.join(root, 'rules.json')
        fs.writeFileSync(file, JSON.stringify(rules))
        cli.push('--ruleConfigFile', file)
      }
      const result = spawnSync(process.execPath, cli, { cwd: engine, encoding: 'utf8', timeout: 90_000 })
      assert.ifError(result.error)
      if (input.partial) {
        assert.notStrictEqual(result.status, 0, result.stdout + result.stderr)
        const manifest = JSON.parse(fs.readFileSync(path.join(report, 'analysis-manifest.json'), 'utf8'))
        assert.notStrictEqual(manifest.status, 'complete')
        assert.ok(manifest.units.some((u: any) => u.diagnostics.some((d: any) => d.code === 'unsupported_cpp_semantics')))
        return
      }
      assert.strictEqual(result.status, 0, result.stdout + result.stderr)
      const summary = JSON.parse(fs.readFileSync(path.join(report, 'scan_summary.json'), 'utf8'))
      assert.strictEqual(summary.status, 'complete')
      assert.ok(summary.entryPointCount > 0)
      assert.strictEqual(summary.findingCount, example.findings)
    })
  }
})
