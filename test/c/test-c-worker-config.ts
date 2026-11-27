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

describe('parallel parser recovery', function () {
  this.timeout(10000)

  it('keeps JSON worker and cached hash registration in depth-first order', function () {
    const { processParsedAst } = require('../../src/engine/parser/parser-core')
    const registry = require('../../src/util/global-registry')
    const previous = registry.getGlobalASTManager()
    const sourcefile = 'unit.c'
    const loc = { sourcefile, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
    const leaf = (name: string) => ({ type: 'Identifier', name, loc, _meta: { nodehash: 'collision' } })
    const tree = {
      type: 'CompilationUnit', name: 'root', loc,
      _meta: {
        nodehash: 'root', annotations: [leaf('annotation')], decorators: [leaf('decorator')], ignored: leaf('hidden'),
      },
      body: [{ ...leaf('first'), loc: { ...loc, extension: leaf('extended-location') } }, leaf('last')],
    }
    try {
      const parse = (ast: any, mode?: 'restore') => {
        const order: string[] = []
        const hashes = new Map<string, any>()
        registry.setGlobalASTManager({
          register(node: any) {
            order.push(node.name)
            hashes.set(node._meta.nodehash, node)
          },
        })
        processParsedAst(ast, null, { sourcefile }, { unit: 'file', needsSourcefile: true }, true, mode)
        assert.strictEqual(hashes.get('collision'), ast.body[ast.body.length - 1])
        return order
      }
      const expected = ['root', 'annotation', 'decorator', 'first', 'extended-location', 'last']
      assert.deepStrictEqual(parse(JSON.parse(JSON.stringify(tree)), 'restore'), expected)
      // The generic input can contain cycles and aliases that JSON IPC cannot.
      const cached: any = JSON.parse(JSON.stringify(tree))
      cached.body.push(cached.body[1])
      cached.extraReference = cached
      assert.deepStrictEqual(parse(cached), expected)
    } finally {
      registry.setGlobalASTManager(previous)
    }
  })

  it('registers files in input order and completes the queue when workers exit', async function () {
    const childProcess = require('child_process')
    const registry = require('../../src/util/global-registry')
    const cParser = require('../../src/engine/parser/c/c-ast-builder')
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-c-worker-recovery-'))
    const originalFork = childProcess.fork
    const originalParse = cParser.parseSingleFile
    const originalManager = registry.getGlobalASTManager()
    const previousCount = Config.workerCount
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(project, `unit_${i}.c`),
        `#define TWICE(x) ((x) + (x))\nint test_${i}(void) { return TWICE(${i}); }\n`)
    }

    try {
      let reference: string | undefined
      for (const failures of ['none', 'first', 'all']) {
        const registered = new Set<string>()
        const hashes = new Set<string>()
        let collisions = 0
        const retried: string[] = []
        registry.setGlobalASTManager({
          has: (hash: string) => hashes.has(hash),
          register(node: any) {
            if (hashes.has(node._meta.nodehash)) collisions++
            hashes.add(node._meta.nodehash)
            registered.add(node.loc.sourcefile)
          },
        })
        cParser.parseSingleFile = (code: string, opts: any) => {
          retried.push(opts.sourcefile)
          return originalParse(code, opts)
        }
        let firstWorker: any
        childProcess.fork = (...args: any[]) => {
          const child = originalFork(...args)
          if (failures === 'all') {
            child.once('spawn', () => child.kill())
          } else if (failures === 'first' && !firstWorker) {
            // Let another worker finish before failing the first file.
            firstWorker = child
            child.send = () => true
          } else if (failures === 'first' && firstWorker.connected) {
            child.once('message', () => firstWorker.kill())
          }
          return child
        }
        Config.workerCount = failures === 'first' ? 2 : 1
        const result = await Parser.parseProject(project, { language: 'c' })
        const files = Object.keys(result)
        assert.strictEqual(files.length, 12)
        assert.ok(collisions > 0, 'the macro expansion must exercise duplicate locations')
        assert.deepStrictEqual([...registered], files)
        const ast = JSON.stringify(result, (key, value) => key === 'parent' ? undefined : value)
        if (reference === undefined) reference = ast
        else assert.strictEqual(ast, reference)
        assert.deepStrictEqual(retried, failures === 'all' ? files : failures === 'first' ? [files[0]] : [])
      }
    } finally {
      childProcess.fork = originalFork
      cParser.parseSingleFile = originalParse
      registry.setGlobalASTManager(originalManager)
      Config.workerCount = previousCount
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
