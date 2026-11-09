import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as assert from 'assert'
import { readCompilationDatabase } from '../../src/engine/parser/c-family/compilation-database'
import { selectBuildContexts } from '../../src/engine/parser/c-family/build-selection'
import { preprocessUnit } from '../../src/engine/parser/c-family/compiler-preprocess'
import { mapOrigin, projectText, RawCoordinates } from '../../src/engine/parser/c-family/source-map'

describe('real compiler preprocessing and library declarations', function () {
  this.timeout(120_000)
  it('keeps project header bodies and compiler-resolved libc aliases', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-compiler-'))
    fs.writeFileSync(path.join(root, 'api.h'), '#ifdef __cplusplus\nnamespace N { using ::system; }\n#else\nstatic inline int helper(void) { return 2; }\n#endif\n')
    fs.writeFileSync(path.join(root, 'main.cpp'), '#include <cstdlib>\n#include <api.h>\nint main() { return N::system(std::getenv("X")); }\n')
    fs.writeFileSync(path.join(root, 'main.c'), '#include <stdlib.h>\n#include <api.h>\nint main(void) { return helper(); }\n')
    const db = path.join(root, 'compile_commands.json')
    fs.writeFileSync(db, JSON.stringify(['main.cpp', 'main.c'].map(file => ({
      directory: root, file, arguments: ['/usr/bin/clang', '-I', root, '-c', file],
    }))))
    const entries = await readCompilationDatabase(db)
    const contexts = selectBuildContexts(entries, { version: 1, profileId: 'test', units: entries.map(e => ({ entryId: e.entryId, domainId: e.sourceFile })) })
    const cpp = await preprocessUnit(contexts[0], path.join(root, 'out'))
    assert.strictEqual(cpp.status, 'prepared', JSON.stringify(cpp.diagnostics))
    const text = projectText(cpp.text, cpp.sourceMap, contexts[0].sourceFile)
    assert.ok(text.includes('namespace N'))
    const api = cpp.metadata!.declarations.filter(d => ['system', 'getenv'].includes(d.name))
    assert.ok(api.some(d => d.name === 'system' && d.mangledName))
    assert.ok(api.some(d => d.name === 'getenv' && d.mangledName))
    assert.strictEqual(cpp.metadata!.references.filter(r => ['getenv', 'system'].includes(r.name)).length, 2)
    const positions = new RawCoordinates(fs.readFileSync(path.join(cpp.directory, 'unit.ii'), 'utf8'))
    const system = api.find(d => d.name === 'system')!
    assert.ok(mapOrigin(cpp.sourceMap, positions.location(system.offset).line)!.system)
    assert.ok(cpp.dependencies.some(d => path.basename(d.file) === 'api.h' && !d.system))
    const c = await preprocessUnit(contexts[1], path.join(root, 'out'))
    assert.strictEqual(c.status, 'prepared', JSON.stringify(c.diagnostics))
    assert.ok(projectText(c.text, c.sourceMap, contexts[1].sourceFile).includes('helper'))
  })

  it('fails a missing generated header instead of returning a zero-finding success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-missing-header-'))
    fs.writeFileSync(path.join(root, 'main.c'), '#include "generated.h"\nint main(void) { return 0; }\n')
    const db = path.join(root, 'compile_commands.json')
    fs.writeFileSync(db, JSON.stringify([{ directory: root, file: 'main.c', arguments: ['/usr/bin/clang', '-c', 'main.c'] }]))
    const entries = await readCompilationDatabase(db)
    const [context] = selectBuildContexts(entries, { version: 1, profileId: 'missing', units: [{ entryId: entries[0].entryId, domainId: 'app' }] })
    const unit = await preprocessUnit(context, path.join(root, 'out'))
    assert.strictEqual(unit.status, 'failed')
    assert.ok(unit.diagnostics.length)
  })
})
