const assert = require('node:assert/strict')

// Install the test seam before the CLI loads the branch merger and captures its exports.
const [mode, source, report, rules] = process.argv.slice(2)
const watchPath = require.resolve('../../src/engine/analyzer/common/global-branch-watch')
const watch = require(watchPath)
let fastJoins = 0
let fullJoins = 0
require.cache[watchPath].exports = {
  ...watch,
  canSkipGlobalJoin(global, visited) {
    if (mode === 'dense') return false
    const skip = watch.canSkipGlobalJoin(global, visited)
    if (skip) fastJoins++
    else fullJoins++
    return skip
  },
}

async function run() {
  const { execute } = require('../../src/interface/starter')
  await execute(null, [
    source, '--language', 'c', '--cIncludeDir', source, '--dumpAllCG',
    '--checkerIds', 'callgraph', '--ruleConfigFile', rules, '--report', report,
  ])
  if (mode === 'fast') {
    assert.ok(fastJoins > 0, 'the fixture must exercise a global join skip')
    assert.ok(fullJoins > 0, 'the fixture must also exercise the full join')
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
