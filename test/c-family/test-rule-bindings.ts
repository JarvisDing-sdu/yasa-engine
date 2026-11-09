import * as assert from 'assert'
import { resolveRuleConfig } from '../../src/engine/parser/c-family/rule-config'

describe('compiler-bound custom rules', () => {
  const index: any = new Map([['unit', new Map([
    ['a', { kind: 'function', displayName: 'read_input', key: '__cf_a' }],
    ['b', { kind: 'function', displayName: 'read_file', key: '__cf_b' }],
    ['c', { kind: 'function', displayName: 'thread_read', key: '__cf_c' }],
  ])]])
  it('expands trailing prefix wildcards against declared names', () => {
    const original = [{ checkerIds: ['taint_flow_c_input'], sources: [{ fsig: 'read_*', kind: 'C_INPUT' }] }]
    const resolved = resolveRuleConfig(original, index, [], '/project')
    assert.deepStrictEqual(resolved[0].sources.map((item: any) => item.fsig).sort(), ['__cf_a', '__cf_b'])
    assert.deepStrictEqual(resolved[0].checkerIds, ['taint_flow_c_cpp_input'])
    assert.strictEqual(original[0].sources[0].fsig, 'read_*')
  })
  it('leaves unmatched external API names available for library models', () => {
    assert.deepStrictEqual(resolveRuleConfig([{ fsig: 'getenv' }], index, [], '/project'), [{ fsig: 'getenv' }])
  })
})
