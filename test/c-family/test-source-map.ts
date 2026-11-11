import * as assert from 'assert'
import { decodeLineMarkers, mapOrigin, projectText, RawCoordinates } from '../../src/engine/parser/c-family/source-map'

describe('compiler source provenance', () => {
  it('maps physical includes and logical line directives separately', () => {
    const raw = '# 1 "main.c"\nint a;\n# 1 "api.h" 1\nint b;\n# 50 "virtual.c"\nint c;\n# 3 "main.c" 2\nint d;\n'
    const { text, sourceMap } = decodeLineMarkers(raw, '/project')
    assert.strictEqual(text.split('\n').length, raw.split('\n').length)
    assert.deepStrictEqual(mapOrigin(sourceMap, 6), { file: '/project/virtual.c', line: 50, system: false, physicalFile: '/project/api.h' })
    assert.strictEqual(mapOrigin(sourceMap, 8)!.physicalFile, '/project/main.c')
    assert.strictEqual(mapOrigin(sourceMap, 2)!.line, 1)
    assert.strictEqual(mapOrigin(sourceMap, 8)!.line, 3)
    assert.strictEqual('column' in mapOrigin(sourceMap, 6)!, false)
  })

  it('restores physical files after virtual returns and #line include returns', () => {
    const raw = '# 0 "main.c"\n# 0 "<built-in>"\n# 0 "<command-line>"\n' +
      '# 1 "sys.h" 1 3\nint system_value;\n# 0 "<command-line>" 2\n' +
      '# 1 "main.c"\n# 77 "logical.c"\nint before;\n' +
      '# 1 "header.h" 1\nint header;\n# 79 "logical.c" 2\nint after;\n'
    const { sourceMap } = decodeLineMarkers(raw, '/project')
    assert.strictEqual(mapOrigin(sourceMap, 5)!.physicalFile, '/project/sys.h')
    assert.deepStrictEqual(mapOrigin(sourceMap, 9), { file: '/project/logical.c', line: 77, system: false, physicalFile: '/project/main.c' })
    assert.strictEqual(mapOrigin(sourceMap, 11)!.physicalFile, '/project/header.h')
    assert.deepStrictEqual(mapOrigin(sourceMap, 13), { file: '/project/logical.c', line: 79, system: false, physicalFile: '/project/main.c' })
  })

  it('retains project angled includes and records system declarations independently', () => {
    const raw = '# 1 "main.cpp"\nint a;\n# 1 "custom.h" 1\nint project_body() { return 1; }\n# 1 "stdlib.h" 1 3\nint system(const char *);\n'
    const decoded = decodeLineMarkers(raw, '/project')
    const masked = projectText(decoded.text, decoded.sourceMap, '/project/main.cpp')
    assert.ok(masked.includes('project_body'))
    assert.ok(!masked.includes('int system'))
    assert.strictEqual(mapOrigin(decoded.sourceMap, 6)!.system, true)
  })

  it('converts Clang byte offsets without shifting non-ASCII source columns', () => {
    const raw = '// 中文\n/* é */ target();\n'
    const coordinates = new RawCoordinates(raw)
    const offset = Buffer.byteLength(raw.slice(0, raw.indexOf('target')))
    assert.deepStrictEqual(coordinates.location(offset), { line: 2, column: 9 })
  })
})
