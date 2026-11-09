import * as fs from 'fs'

const Config = require('../config')
const ExceptionHandler = require('../engine/analyzer/common/exception-handler')
const { execute } = require('./starter')

/**
 * Analyze one link domain in an isolated configuration process.
 */
async function run(): Promise<void> {
  const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  Config.cFamilyUnits = request.units
  Config.cFamilyProgressFile = require('path').join(require('path').dirname(process.argv[2]), 'analysis-progress.jsonl')
  await execute(null, [
    '--sourcePath',
    request.sourcePath,
    '--language',
    'cpp',
    '--analyzer',
    'CFamilyAnalyzer',
    '--checkerPackIds',
    'taint-flow-c-family-default',
    '--ruleConfigFile',
    request.ruleConfigFile,
    '--taintTraceOutputStrategy',
    'full',
    '--report',
    request.reportDir,
    ...(request.dumpAllCG ? ['--dumpAllCG', '--checkerIds', 'callgraph,taint_flow_c_cpp_input'] : []),
  ])
  fs.writeFileSync(
    require('path').join(request.reportDir, 'worker-state.json'),
    JSON.stringify({
      exceptionCount: Math.max(
        ExceptionHandler.getTotalErrorCount(),
        Object.values(ExceptionHandler.getErrorStats()).reduce((sum: number, count) => sum + Number(count), 0)
      ),
      ...Config.cFamilyCompletion,
    })
  )
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
