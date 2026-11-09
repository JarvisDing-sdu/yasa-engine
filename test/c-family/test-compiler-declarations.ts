import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { readCompilerDeclarations } from '../../src/engine/parser/c-family/compiler-declarations'

const range = (begin: number, end: number, tokLen = 1) => ({
  begin: { offset: begin, tokLen: 1 },
  end: { offset: end, tokLen },
})
const variable = (id: string, offset: number, extra = {}) => ({
  id,
  kind: 'VarDecl',
  name: id,
  loc: { offset, tokLen: id.length },
  range: range(offset, offset + 3),
  type: { qualType: 'const int', desugaredQualType: 'int' },
  ...extra,
})
const translationUnit = (inner: unknown[]) => ({
  id: 'tu',
  kind: 'TranslationUnitDecl',
  loc: {},
  range: { begin: {}, end: {} },
  inner,
})

describe('streaming compiler declarations', () => {
  let directory: string
  let serial = 0
  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-compiler-declarations-'))
  })
  after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const read = async (ast: unknown) => {
    const file = path.join(directory, `${serial++}.json`)
    fs.writeFileSync(file, JSON.stringify(ast))
    return readCompilerDeclarations(file)
  }

  it('preserves declaration types and byte ranges, zero offsets, and system declarations', async () => {
    const metadata = await read(
      translationUnit([
        variable('zero', 0, {
          storageClass: 'static',
          loc: { offset: 0, line: 300, presumedLine: 9, file: '/system/header.h' },
          range: range(0, 12, 4),
        }),
        variable('implicit', 15, { isImplicit: true, loc: {} }),
        variable('macro', 20, { loc: { spellingLoc: { offset: 20 }, expansionLoc: { offset: 30 } } }),
      ])
    )
    assert.deepStrictEqual(metadata, {
      declarations: [
        {
          id: 'zero',
          kind: 'VarDecl',
          name: 'zero',
          offset: 0,
          range: { begin: 0, end: 16 },
          type: 'const int',
          storage: 'static',
          scopeNames: [],
          languageLinkage: 'C++',
          hasBody: false,
        },
      ],
      references: [],
      unsupported: [],
    })
  })

  it('keeps forward declarations and stashes direct function bodies before freeing children', async () => {
    const metadata = await read(
      translationUnit([
        {
          id: 'ns',
          kind: 'NamespaceDecl',
          name: 'api',
          inner: [
            {
              id: 'link',
              kind: 'LinkageSpecDecl',
              language: 'C',
              inner: [
                {
                  id: 'forward',
                  kind: 'FunctionDecl',
                  name: 'work',
                  mangledName: 'work',
                  loc: { offset: 10 },
                  range: range(6, 24),
                  type: { qualType: 'int (int)' },
                  inner: [],
                },
              ],
            },
            {
              id: 'definition',
              kind: 'FunctionDecl',
              name: 'work',
              mangledName: '_ZN3api4workEi',
              previousDecl: 'forward',
              loc: { offset: 40 },
              range: range(35, 99),
              type: { qualType: 'int (int)', typeAliasDeclId: 'alias' },
              inline: true,
              inner: [
                {
                  id: 'param',
                  kind: 'ParmVarDecl',
                  name: 'input',
                  loc: { offset: 49 },
                  range: range(45, 49, 5),
                  type: { qualType: 'int' },
                },
                {
                  id: 'body',
                  kind: 'CompoundStmt',
                  range: range(55, 99),
                  inner: [
                    {
                      id: 'block',
                      kind: 'CompoundStmt',
                      range: range(60, 90),
                      inner: [
                        variable('local', 66),
                        {
                          id: 'ref',
                          kind: 'DeclRefExpr',
                          range: range(76, 76, 5),
                          referencedDecl: {
                            id: 'param',
                            kind: 'ParmVarDecl',
                            name: 'input',
                            type: { qualType: 'int' },
                            loc: { offset: 49 },
                            range: range(45, 49, 5),
                          },
                        },
                        {
                          id: 'fn-ref',
                          kind: 'DeclRefExpr',
                          range: range(82, 82, 4),
                          referencedDecl: {
                            id: 'forward',
                            kind: 'FunctionDecl',
                            name: 'work',
                            type: { qualType: 'int (int)' },
                            loc: { offset: 10 },
                            range: range(6, 24),
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])
    )
    assert.strictEqual(metadata.declarations.length, 4)
    const byId = new Map(metadata.declarations.map((declaration) => [declaration.id, declaration]))
    assert.deepStrictEqual(byId.get('forward'), {
      id: 'forward',
      kind: 'FunctionDecl',
      name: 'work',
      mangledName: 'work',
      offset: 10,
      range: { begin: 6, end: 25 },
      type: 'int (int)',
      scopeNames: ['api'],
      languageLinkage: 'C',
      hasBody: false,
    })
    assert.deepStrictEqual(byId.get('definition'), {
      id: 'definition',
      kind: 'FunctionDecl',
      name: 'work',
      mangledName: '_ZN3api4workEi',
      previousDecl: 'forward',
      offset: 40,
      range: { begin: 35, end: 100 },
      bodyRange: { begin: 55, end: 100 },
      type: 'int (int)',
      inline: true,
      scopeNames: ['api'],
      languageLinkage: 'C++',
      hasBody: true,
    })
    for (const id of ['param', 'local']) {
      assert.strictEqual(byId.get(id)?.functionId, 'definition')
      assert.deepStrictEqual(byId.get(id)?.scopeNames, ['api'])
      assert.strictEqual(byId.get(id)?.hasBody, false)
    }
    assert.deepStrictEqual(metadata.references, [
      { offset: 76, end: 81, declarationId: 'param', name: 'input' },
      { offset: 82, end: 86, declarationId: 'forward', name: 'work' },
    ])
  })

  it('uses the nearest function owner and does not mistake nested statement bodies for function bodies', async () => {
    const metadata = await read(
      translationUnit([
        {
          id: 'outer',
          kind: 'FunctionDecl',
          name: 'outer',
          loc: { offset: 1 },
          range: range(0, 100),
          type: { qualType: 'void ()' },
          inner: [
            {
              kind: 'IfStmt',
              inner: [
                {
                  kind: 'CompoundStmt',
                  range: range(8, 99),
                  inner: [
                    {
                      id: 'nested',
                      kind: 'FunctionDecl',
                      name: 'nested',
                      loc: { offset: 20 },
                      range: range(15, 40),
                      type: { qualType: 'void (int)' },
                      inner: [
                        variable('nearest', 30, { kind: 'ParmVarDecl' }),
                        { kind: 'CompoundStmt', range: range(35, 40), inner: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])
    )
    assert.strictEqual(metadata.declarations.find((declaration) => declaration.id === 'nearest')?.functionId, 'nested')
    assert.strictEqual(metadata.declarations.find((declaration) => declaration.id === 'nested')?.hasBody, true)
    assert.strictEqual(metadata.declarations.find((declaration) => declaration.id === 'outer')?.hasBody, false)
  })

  it('derives lexical namespace and linkage with unmangled function overrides', async () => {
    const fn = (id: string, mangledName?: string) => ({
      id,
      kind: 'FunctionDecl',
      name: id,
      ...(mangledName ? { mangledName } : {}),
      loc: { offset: 0 },
      range: range(0, 2),
      type: { qualType: 'void ()' },
    })
    const metadata = await read(
      translationUnit([
        {
          kind: 'NamespaceDecl',
          name: 'outer',
          inner: [
            {
              kind: 'NamespaceDecl',
              name: 'inner',
              inner: [
                fn('plain', 'plain'),
                fn('platform', '_platform'),
                fn('cpp', '_ZN5outer5inner3cppEv'),
                {
                  kind: 'LinkageSpecDecl',
                  language: 'C',
                  inner: [fn('lexical'), { kind: 'LinkageSpecDecl', language: 'C++', inner: [fn('reset')] }],
                },
              ],
            },
          ],
        },
      ])
    )
    assert.deepStrictEqual(
      metadata.declarations.map((declaration) => [
        declaration.name,
        declaration.languageLinkage,
        declaration.scopeNames,
      ]),
      [
        ['plain', 'C', ['outer', 'inner']],
        ['platform', 'C', ['outer', 'inner']],
        ['cpp', 'C++', ['outer', 'inner']],
        ['lexical', 'C', ['outer', 'inner']],
        ['reset', 'C++', ['outer', 'inner']],
      ]
    )
  })

  it('reports unsupported AST kinds at raw offsets and ignores incomplete references', async () => {
    const kinds = [
      'CXXMethodDecl',
      'CXXConstructorDecl',
      'CXXMemberCallExpr',
      'LambdaExpr',
      'FunctionTemplateDecl',
      'ClassTemplateDecl',
      'CXXNewExpr',
      'CXXDeleteExpr',
      'CXXTryStmt',
    ]
    const metadata = await read(
      translationUnit([
        ...kinds.map((kind, index) => ({
          id: String(index),
          kind,
          loc: { offset: index * 10 + 2 },
          range: range(index * 10, index * 10 + 5),
        })),
        { kind: 'CXXMethodDecl', isImplicit: true, loc: {}, range: { begin: {}, end: {} } },
        {
          kind: 'DeclRefExpr',
          range: range(0, 0, 3),
          referencedDecl: { id: 'global', kind: 'VarDecl', name: 'global', type: { qualType: 'int' } },
        },
        {
          kind: 'DeclRefExpr',
          range: { begin: { offset: '3' }, end: { offset: 3, tokLen: 1 } },
          referencedDecl: { id: 'bad', name: 'bad' },
        },
        { kind: 'DeclRefExpr', range: range(4, 4), referencedDecl: { name: 'missing-id' } },
      ])
    )
    assert.deepStrictEqual(
      metadata.unsupported,
      kinds.map((kind, index) => ({ kind, offset: index * 10 + 2 }))
    )
    assert.deepStrictEqual(metadata.declarations, [])
    assert.deepStrictEqual(metadata.references, [{ offset: 0, end: 3, declarationId: 'global', name: 'global' }])
  })

  it('rejects malformed, truncated, multiple-root and unexpected-root JSON', async () => {
    const valid = JSON.stringify(translationUnit([variable('present', 0)]))
    for (const content of [
      '',
      '{',
      valid.slice(0, -1),
      '{"kind":"TranslationUnitDecl","inner":[{"name":"unterminated',
      valid + '{}',
      valid + ' 1',
      valid + ' false',
      '{"kind":"TranslationUnitDecl",}',
      '{"kind":"TranslationUnitDecl","inner":[{},]}',
      '{"kind":"TranslationUnitDecl","inner":}',
      '{"kind":"TranslationUnitDecl","offset":01}',
      '{"kind":"TranslationUnitDecl","offset":1.}',
      '{"kind":"TranslationUnitDecl","offset":-.1}',
      '{"kind":"TranslationUnitDecl","x":"\\u00:0"}',
      '{"kind":"TranslationUnitDecl","inner":[wat]}',
      '[]',
      'null',
      '42',
      '{}',
      '{"kind":"FunctionDecl"}',
      '{"__proto__":{"kind":"TranslationUnitDecl"}}',
    ]) {
      const file = path.join(directory, `${serial++}.json`)
      fs.writeFileSync(file, content)
      await assert.rejects(readCompilerDeclarations(file), /JSON|root|TranslationUnit|truncat/i, content)
    }
    await assert.rejects(readCompilerDeclarations(path.join(directory, 'missing.json')), /ENOENT/)
    const trailingWhitespace = path.join(directory, 'whitespace.json')
    fs.writeFileSync(trailingWhitespace, `${valid}\n\t `)
    assert.strictEqual((await readCompilerDeclarations(trailingWhitespace)).declarations.length, 1)
  })

  it('preserves split UTF-8 and escaped tokens and rejects invalid UTF-8', async () => {
    const prefix = '{"kind":"TranslationUnitDecl","padding":"'
    const padding = 'x'.repeat(65535 - Buffer.byteLength(prefix))
    const file = path.join(directory, 'utf8.json')
    fs.writeFileSync(
      file,
      prefix + padding + '中\\u0041\\\\u00:0","inner":' + JSON.stringify([variable('café', 10)]) + '}'
    )
    assert.strictEqual((await readCompilerDeclarations(file)).declarations[0].name, 'café')
    for (const invalid of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82])]) {
      fs.writeFileSync(file, Buffer.concat([Buffer.from(prefix), invalid, Buffer.from('"}')]))
      await assert.rejects(readCompilerDeclarations(file), /JSON/)
    }
  })

  it('streams a wide function body larger than the child heap without retaining inner nodes', function () {
    this.timeout(30000)
    const file = path.join(directory, 'wide.json')
    const descriptor = fs.openSync(file, 'w')
    try {
      fs.writeSync(
        descriptor,
        '{"kind":"TranslationUnitDecl","inner":[{"kind":"FunctionDecl","id":"wide","name":"wide","loc":{"offset":0},"range":{"begin":{"offset":0},"end":{"offset":8,"tokLen":1}},"type":{"qualType":"void ()"},"inner":[{"kind":"CompoundStmt","range":{"begin":{"offset":6},"end":{"offset":8,"tokLen":1}},"inner":['
      )
      const statement = JSON.stringify({ kind: 'StringLiteral', value: 'x'.repeat(32768) })
      for (let index = 0; index < 3072; index++) fs.writeSync(descriptor, (index ? ',' : '') + statement)
      fs.writeSync(descriptor, ']}]}]}')
    } finally {
      fs.closeSync(descriptor)
    }
    const moduleFile = path.resolve(__dirname, '../../src/engine/parser/c-family/compiler-declarations.ts')
    const script = `require(${JSON.stringify(moduleFile)}).readCompilerDeclarations(${JSON.stringify(file)}).then(m => { require('assert').deepStrictEqual(m.declarations, [{id:'wide',kind:'FunctionDecl',name:'wide',offset:0,range:{begin:0,end:9},bodyRange:{begin:6,end:9},type:'void ()',scopeNames:[],languageLinkage:'C++',hasBody:true}]); }).catch(e => { console.error(e); process.exitCode = 1; })`
    const result = spawnSync(process.execPath, ['--max-old-space-size=48', '--require', 'tsx/cjs', '-e', script], {
      encoding: 'utf8',
      timeout: 25000,
    })
    assert.ifError(result.error)
    assert.strictEqual(result.status, 0, result.stderr)
  })
})
