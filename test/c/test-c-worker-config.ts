import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it } from 'mocha'

const Config = require('../../src/config')
const Parser = require('../../src/engine/parser/parser')

describe('C worker preprocessor configuration', function () {
  this.timeout(30000)

  it('selects the same configured C branch in every worker-parsed file', async function () {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-c-worker-config-'))
    const project = path.join(temp, 'project')
    const sources = path.join(project, 'src')
    const includes = path.join(temp, 'includes')
    fs.mkdirSync(sources, { recursive: true })
    fs.mkdirSync(includes)
    fs.writeFileSync(path.join(project, 'root-flags.h'), '#define ROOT_MAGIC 1\n')
    fs.writeFileSync(path.join(includes, 'extra.h'), '#define HEADER_MAGIC 1\n')
    // Twelve C files exceed the real parser's ten-file worker threshold.
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(sources, `unit_${i}.c`), `
#include <extra.h>
#include "root-flags.h"
#if defined(CLI_FEATURE) && !defined(CLI_OFF) && defined(__APPLE__) && MODE == 2 && HEADER_MAGIC && ROOT_MAGIC
int selected_${i}(void) { return 1; }
#else
int wrong_${i}(void) { return 0; }
#endif
`)
    }
    const previous = {
      cPreprocessor: Config.cPreprocessor,
      maindir: Config.maindir,
      maindirPrefix: Config.maindirPrefix,
      workerCount: Config.workerCount,
    }
    Config.cPreprocessor = {
      defines: { CLI_FEATURE: '1', CLI_OFF: '1', MODE: '2' },
      undefines: ['CLI_OFF'],
      target: 'macos',
      unknownMacros: 'undefined',
      includeDirs: [includes],
    }
    Config.maindir = project
    Config.maindirPrefix = project
    Config.workerCount = 1
    try {
      const result = await Parser.parseProject(project, { language: 'c' })
      const names: string[] = []
      const seen = new WeakSet<object>()
      const visit = (value: any): void => {
        if (!value || typeof value !== 'object' || seen.has(value)) return
        seen.add(value)
        if (value.type === 'FunctionDefinition') names.push(value.name)
        for (const [key, child] of Object.entries(value)) {
          if (key !== 'parent') visit(child)
        }
      }
      visit(result)
      assert.deepStrictEqual(names.sort(), [
        'selected_0', 'selected_1', 'selected_10', 'selected_11',
        'selected_2', 'selected_3', 'selected_4', 'selected_5',
        'selected_6', 'selected_7', 'selected_8', 'selected_9',
      ])
    } finally {
      Object.assign(Config, previous)
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
