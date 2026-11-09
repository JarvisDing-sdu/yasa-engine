import * as assert from 'assert'
import CFamilyAnalyzer = require('../../src/engine/analyzer/c-family/c-family-analyzer')

describe('mixed branch syntax coverage', () => {
  const analyzer = Object.create(CFamilyAnalyzer.prototype)
  it('does not traverse runtime scope snapshots when checking branch termination', () => {
    const snapshot: any = {}
    Object.defineProperty(snapshot, 'runtimeGraph', { enumerable: true, get() { throw new Error('runtime graph traversed') } })
    const state = { pcond: [] }
    analyzer.postBranchProcessing({ consequent: { type: 'CBranch', body: { type: 'Noop' }, results: [{ before: snapshot }] } }, {}, state, {})
    assert.strictEqual(state.pcond.length, 0)
  })
  it('retains real return termination from the underlying branch body', () => {
    const state: any = { pcond: [] }
    analyzer.postBranchProcessing({ consequent: { type: 'CBranch', body: { type: 'ReturnStatement' }, results: [] } }, { type: 'Identifier', name: 'condition' }, state, {})
    assert.strictEqual(state.pcond.length, 1)
    assert.strictEqual(state.pcond[0].is_neg, true)
  })
})
