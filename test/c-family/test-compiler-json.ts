import * as assert from 'assert'
import { Readable } from 'stream'
import { compactCompilerJson } from '../../src/engine/parser/c-family/compiler-json'

async function compact(chunks: Buffer[]): Promise<string> {
  const output = Readable.from(chunks).pipe(compactCompilerJson())
  const collected: Buffer[] = []
  for await (const chunk of output) collected.push(chunk as Buffer)
  return Buffer.concat(collected).toString('utf8')
}

describe('compiler JSON whitespace compaction', () => {
  it('preserves strings, escapes and UTF-8 across every byte boundary', async () => {
    const source = JSON.stringify({ kind: 'TranslationUnitDecl', inner: [{ value: 'a  b\n"\\中文\t', number: -1.25e20 }] }, null, 8)
    const bytes = Buffer.from(source)
    const result = await compact([...bytes].map(byte => Buffer.from([byte])))
    assert.deepStrictEqual(JSON.parse(result), JSON.parse(source))
    assert.ok(result.length < source.length)
  })

  it('preserves token separators in malformed input', async () => {
    const result = await compact([Buffer.from('[1\n  '), Buffer.from('2]')])
    assert.strictEqual(result, '[1 2]')
    assert.throws(() => JSON.parse(result))
  })

  it('flushes trailing whitespace and supports empty input', async () => {
    assert.strictEqual(await compact([Buffer.from(' \n{ }\n\t')]), ' { } ')
    assert.strictEqual(await compact([]), '')
  })
})
