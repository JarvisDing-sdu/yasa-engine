import * as assert from 'assert'
import { decodeClangString } from '../../src/engine/parser/c-family/clang-string'

describe('Clang string literal decoding', () => {
  it('decodes octal UTF-8, control characters and embedded null bytes', () => {
    assert.strictEqual(decodeClangString('"\\357\\273\\277A"').value, '\uFEFFA')
    assert.strictEqual(decodeClangString('"\\344\\270\\255\\000\\033"').value, '中\0\x1b')
    assert.strictEqual(decodeClangString('"a\\n\\t\\\\\\\""').value, 'a\n\t\\"')
  })
  it('preserves non-UTF-8 narrow bytes', () => {
    assert.deepStrictEqual(decodeClangString('"\\377"'), { value: 'ÿ', encoding: 'bytes', bytes: [255] })
  })
  it('decodes wide and Unicode-prefixed strings', () => {
    assert.strictEqual(decodeClangString('L"\\x4E2D"').value, '中')
    assert.strictEqual(decodeClangString('u"\\xD83D\\xDE00"').value, '😀')
    assert.strictEqual(decodeClangString('U"\\x1F600"').value, '😀')
    assert.deepStrictEqual(decodeClangString('U"\\x9999999A\\x8000002B"').codeUnits, [0x9999999a, 0x8000002b])
    assert.strictEqual(decodeClangString('u8"\\u4E2D"').value, '中')
  })
  it('rejects malformed encodings and handles long literals without argument spreading', () => {
    assert.throws(() => decodeClangString('"\\x"'))
    assert.throws(() => decodeClangString('"\\q"'))
    assert.strictEqual(decodeClangString('L"' + 'a'.repeat(150_000) + '"').value.length, 150_000)
  })
})
