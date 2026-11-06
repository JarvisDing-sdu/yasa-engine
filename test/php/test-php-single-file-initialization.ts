import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it } from 'mocha'

const Parser = require('../../src/engine/parser/parser')

describe('PHP single-file initialization', function () {
  it('initializes the grammar before synchronous single-file parsing', async function () {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-php-single-'))
    const file = path.join(temp, 'example.php')
    fs.writeFileSync(file, '<?php function hello() { return 1; }')
    try {
      await Parser.ensureInitialized('php')
      const ast = Parser.parseSingleFile(file, { language: 'php' })
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
      visit(ast)
      assert.deepStrictEqual(names, ['hello'])
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
