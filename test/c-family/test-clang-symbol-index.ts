import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { CompilerPreparedUnit } from '../../src/engine/parser/c-family/compiler-preprocess'
import { buildSymbolIndex } from '../../src/engine/parser/c-family/symbol-index'

describe('C++ template definition identities', () => {
  let root: string
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-template-index-')) })
  after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unit = (id: string, template: boolean, result = 1): CompilerPreparedUnit => {
    const directory = path.join(root, id)
    fs.mkdirSync(directory, { recursive: true })
    const text = `int value(){return ${result};}`
    fs.writeFileSync(path.join(directory, 'unit.ii'), text)
    return {
      context: { unitId: id, domainId: 'library', language: 'cpp', sourceFile: directory + '.cpp', argv: ['clang++'] } as CompilerPreparedUnit['context'],
      directory, text, dependencies: [], artifactHash: id, compilerId: 'clang version 21', diagnostics: [], status: 'prepared',
      sourceMap: [{ generatedStartLine: 1, generatedEndLine: 1, origin: { file: '/project/shared.h', physicalFile: '/project/shared.h', line: 1, system: false } }],
      metadata: { references: [], unsupported: [], declarations: [{ id: id + '-value', kind: 'FunctionDecl', name: 'value',
        mangledName: '_Z5valueIiEiv', offset: 4, range: { begin: 0, end: text.length }, bodyRange: { begin: text.indexOf('{'), end: text.length },
        type: 'int ()', scopeNames: [], languageLinkage: 'C++', hasBody: true, template }] },
    }
  }

  it('shares identical template definitions across translation units', () => {
    const result = buildSymbolIndex([unit('same-a', true), unit('same-b', true)])
    assert.strictEqual(result.get('same-a')!.get('same-a-value')!.key, result.get('same-b')!.get('same-b-value')!.key)
  })
  it('rejects conflicting template bodies', () => {
    assert.throws(() => buildSymbolIndex([unit('different-a', true, 1), unit('different-b', true, 2)]), /Conflicting definitions/)
  })
  it('rejects repeated non-inline non-template definitions', () => {
    assert.throws(() => buildSymbolIndex([unit('ordinary-a', false), unit('ordinary-b', false)]), /Conflicting definitions/)
  })
})
