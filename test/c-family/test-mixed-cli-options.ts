import * as assert from 'assert'
import * as path from 'path'
import { spawnSync } from 'child_process'

describe('mixed command dispatch and help', () => {
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args, '--help'], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10_000,
  })
  it('returns success for mixed-mode help', () => {
    const result = run(['--language', 'c-cpp'])
    assert.strictEqual(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes('--compileCommands'))
  })
  it('keeps the last language selection when returning to C', () => {
    const result = run(['--language', 'c-cpp', '--language', 'c'])
    assert.strictEqual(result.status, 0, result.stderr)
    assert.ok(!result.stdout.includes('--compileCommands'))
  })
  it('keeps the last equals-form language selection for mixed mode', () => {
    const result = run(['--language', 'c', '--language=c-cpp'])
    assert.strictEqual(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes('--compileCommands'))
  })
})
