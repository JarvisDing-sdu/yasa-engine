/** Explicit single-configuration, compiler-preprocessed AST export. */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Command } from 'commander'
import { readCompilationDatabase, resolveLanguage } from '../engine/parser/c-family/compilation-database'
import { selectBuildContexts } from '../engine/parser/c-family/build-selection'
import { compilerArguments } from '../engine/parser/c-family/compiler-preprocess'
import { decodeLineMarkers, mapOrigin, projectText } from '../engine/parser/c-family/source-map'

const execute = promisify(execFile)

// An AST export should not emit object files, dependency files or plugins.
// Reject semantic options outside this narrow preprocessing-only allowlist.
function safeArguments(args: string[]): string[] {
  const takesValue = new Set(['-I', '-isystem', '-iquote', '-idirafter', '-include', '-imacros', '-D', '-U', '-isysroot', '--sysroot', '-target', '--target', '-arch', '-std', '--std'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (takesValue.has(arg)) {
      const operand = args[++i]
      if (!operand || operand.startsWith('-') || operand.startsWith('@')) throw new Error(`Missing or unsupported operand for ${arg}`)
      continue
    }
    if (/^-(?:D|U|I).+/.test(arg) || /^-(?:isystem|iquote|idirafter|include|imacros).+/.test(arg) ||
        /^(?:--sysroot|--target|--std|-std)=.+/.test(arg) || /^-fvisibility=(?:default|hidden|protected|internal)$/.test(arg) ||
        /^-O(?:[0-3sgz]|fast)?$/.test(arg) || /^-g(?:[0-3])?$/.test(arg) ||
        /^(?:-W|-pipe|-pthread|-ansi|-pedantic|-pedantic-errors|-fPIC|-fpic|-fPIE|-fpie|-fno-omit-frame-pointer|-fomit-frame-pointer|-fno-common|-fcommon|-funsigned-char|-fsigned-char|-fshort-wchar|-funroll-loops|-fno-unroll-loops)$/.test(arg) ||
        /^-W(?![pale],)[a-zA-Z0-9_=,+-]+$/.test(arg)) continue
    throw new Error(`Unsupported compiler option in AST export: ${arg}`)
  }
  return args
}

/** Run only when --cCompileCommands was explicitly selected. */
export async function runCompilerDumpCLI(args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  program.requiredOption('--sourcePath <file>').requiredOption('--language <language>').option('--dumpAST').option('--dumpAllAST').option('--cAstBackend <backend>', 'tree-sitter or clang', 'tree-sitter')
    .requiredOption('--cCompileCommands <file>').option('--cCompileEntry <id>').option('--report <file>').option('--single')
  try {
    program.parse(args, { from: 'user' })
    const opts = program.opts()
    if (!['tree-sitter', 'clang'].includes(opts.cAstBackend)) throw new Error('Unknown --cAstBackend')
    if (!['c', 'cpp'].includes(opts.language)) throw new Error('--language must be c or cpp')
    const source = fs.realpathSync(path.resolve(opts.sourcePath))
    if (!!opts.dumpAST === !!opts.dumpAllAST) throw new Error('Choose exactly one of --dumpAST or --dumpAllAST')
    if (!opts.dumpAllAST && !fs.statSync(source).isFile()) throw new Error('--sourcePath must identify one source file')
    const database = fs.realpathSync(path.resolve(opts.cCompileCommands))
    const entries = await readCompilationDatabase(database)
    if (opts.dumpAllAST) {
      if (!opts.report) throw new Error('--dumpAllAST requires --report <new-directory>')
      if (opts.cCompileEntry) throw new Error('--cCompileEntry is only available with --dumpAST')
      const output = path.resolve(opts.report)
      const sourceIsDirectory = fs.statSync(source).isDirectory()
      const selected = [...new Map(entries.filter(entry => {
        if (!fs.existsSync(entry.sourceFile)) return false
        const file = fs.realpathSync(entry.sourceFile)
        const relative = path.relative(source, file)
        const inScope = sourceIsDirectory ? relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) : file === source
        return inScope && resolveLanguage(entry) === opts.language
      }).map(entry => [entry.entryId, entry])).values()]
      if (!selected.length) throw new Error('No matching compilation entries')
      fs.mkdirSync(output)
      const results: any[] = []
      const writeManifest = () => {
        const temporary = path.join(output, 'manifest.json.tmp')
        fs.writeFileSync(temporary, JSON.stringify({
        compilationDatabase: database, sourcePath: source, language: opts.language, astBackend: opts.cAstBackend,
        coverage: 'compilation_database_entries', total: selected.length, completed: results.length, results,
        }, null, 2))
        fs.renameSync(temporary, path.join(output, 'manifest.json'))
      }
      writeManifest()
      for (const entry of selected) {
        const filename = entry.entryId + '.json'
        const started = Date.now()
        await runCompilerDumpCLI(['--sourcePath', entry.sourceFile, '--language', opts.language,
          '--dumpAST', '--cCompileCommands', database, '--cCompileEntry', entry.entryId, '--cAstBackend', opts.cAstBackend,
          '--report', path.join(output, filename)])
        const exitCode = process.exitCode || 0
        let status = 'failed'
        let diagnostics: number | undefined
        let conversionDiagnostics: Record<string, number> | undefined
        if (exitCode === 0) {
          const ast = JSON.parse(fs.readFileSync(path.join(output, filename), 'utf8'))
          diagnostics = ast._meta?.parseErrors?.length || 0
          conversionDiagnostics = ast._meta?.clangBackend?.unsupported
          status = ast._meta.compilerDump.status
        }
        results.push({ entryId: entry.entryId, sourceFile: entry.sourceFile,
          output: exitCode === 0 ? filename : null, exitCode, status, diagnostics, conversionDiagnostics, milliseconds: Date.now() - started })
        writeManifest()
      }
      process.exitCode = results.some(result => result.exitCode !== 0) ? 2 : 0
      return
    }
    const matches = entries.filter((entry) => fs.existsSync(entry.sourceFile) && fs.realpathSync(entry.sourceFile) === source)
    const distinct = [...new Map(matches.map((entry) => [entry.entryId, entry])).values()]
    const chosen = opts.cCompileEntry ? distinct.filter((entry) => entry.entryId === opts.cCompileEntry) : distinct
    if (chosen.length !== 1) throw new Error(`Expected exactly one matching compile command; found ${chosen.length}. Use --cCompileEntry with an entry ID. Available IDs: ${distinct.map((e) => e.entryId).join(', ') || '(none)'}`)
    const entry = chosen[0]
    if (resolveLanguage(entry) !== opts.language) throw new Error(`Compile command language does not match --language ${opts.language}`)
    const [context] = selectBuildContexts(entries, { version: 1, profileId: 'single-ast-export', units: [{ entryId: entry.entryId, domainId: 'single-ast-export' }] })
    const flags = safeArguments(compilerArguments(context))
    const language = opts.language === 'cpp' ? 'c++' : 'c'
    const env = { ...process.env }
    delete env.DEPENDENCIES_OUTPUT
    delete env.SUNPRO_DEPENDENCIES
    const run = async (action: string) => execute(entry.argv[0], [...flags, '-x', language, action, entry.sourceFile], {
      cwd: entry.directory, env, timeout: 120_000, maxBuffer: 256 * 1024 * 1024,
    })
    const report = opts.report ? path.resolve(opts.report) : undefined
    // Never replace a source, included file, database or other existing file.
    // `wx` below enforces the same guarantee atomically, even for symlinks.
    if (report && fs.existsSync(report)) throw new Error(`Report path already exists: ${report}`)
    const generatedSource = `<preprocessed:${entry.sourceFile}>`
    let ast: any
    let sourceMap: import('../engine/parser/c-family/source-map').SourceSegment[]
    let compilerStderr: string
    if (opts.cAstBackend === 'clang') {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-clang-ast-'))
      try {
        const { preprocessUnit } = require('../engine/parser/c-family/compiler-preprocess')
        const { ClangUastConverter } = require('../engine/parser/c-family/clang-uast')
        let converter: InstanceType<typeof ClangUastConverter>
        const prepared = await preprocessUnit(context, temporary, (raw: string, map: typeof sourceMap) => {
          converter = new ClangUastConverter({ raw, sourceMap: map, sourcefile: generatedSource, originalSourcefile: source,
            language: opts.language, languageVersion: context.standard || undefined })
          return { shouldRetain: (node: any) => converter.includesDeclaration(node), consume: (node: any) => converter.add(node) }
        })
        if (prepared.status !== 'prepared') {
          const messages = prepared.diagnostics.map((diagnostic: any) => diagnostic.message)
          for (const file of ['preprocess.stderr', 'declarations.stderr']) {
            const stderr = path.join(prepared.directory, file)
            if (fs.existsSync(stderr)) messages.push(fs.readFileSync(stderr, 'utf8'))
          }
          throw new Error(messages.join('\n'))
        }
        sourceMap = prepared.sourceMap
        ast = converter!.finish()
        compilerStderr = ['preprocess.stderr', 'declarations.stderr'].map(file => fs.readFileSync(path.join(prepared.directory, file), 'utf8')).join('\n')
      } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
    } else {
      const preprocessed = await run('-E')
      const decoded = decodeLineMarkers(preprocessed.stdout, entry.directory)
      sourceMap = decoded.sourceMap
      const projected = projectText(decoded.text, sourceMap, entry.sourceFile)
      const { Parser } = require('@ant-yasa/uast-parser-cpp')
      const parser = new Parser({ language: opts.language })
      await parser.init()
      ast = parser.parsePreprocessed(projected, { sourcefile: generatedSource, languageVersion: context.standard || undefined })
      compilerStderr = preprocessed.stderr
    }
    const pending: any[] = [ast]
    const seen = new WeakSet<object>()
    while (pending.length) {
      const node = pending.pop()
      if (!node || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      if (node.type && node.loc?.start) {
        const start = mapOrigin(sourceMap, node.loc.start.line)
        node._meta = { ...node._meta, originalColumnKnown: false }
        if (start && !start.file.startsWith('<')) {
          // Line markers provide a presumed start line, not a reliable end
          // range or source column after expansion and header inclusions.
          node._meta.originalLocation = { sourcefile: start.file, physicalFile: start.physicalFile, start: { line: start.line } }
        }
      }
      // Some UAST fields (e.g. bitfield widths) are stored under _meta and
      // need the same provenance as nodes in the regular tree.
      for (const [key, child] of Object.entries(node)) if (!['parent', 'loc'].includes(key)) pending.push(child)
    }
    ast._meta.compilerDump = { compilationDatabase: database, entryId: entry.entryId, sourceFile: source,
      argv: entry.argv, directory: entry.directory, coverage: 'single_configuration', originalColumnKnown: false,
      environment: 'current_process', systemHeaders: opts.cAstBackend === 'clang' ? 'excluded_from_uast' : 'masked', backend: opts.cAstBackend, compilerStderr,
      status: ast._meta.parseErrors?.length ? 'syntax_errors' : ast._meta.clangBackend?.status === 'partial' ? 'partial_conversion' : 'no_syntax_errors' }
    for (const error of ast._meta.parseErrors || []) {
      const origin = mapOrigin(sourceMap, error.line)
      if (origin && !origin.file.startsWith('<')) error.originalLocation = { sourcefile: origin.file, line: origin.line }
    }
    const { addNodeHash } = require('../util/ast-util')
    addNodeHash(ast)
    const { stringifyJsonWithFallback } = require('../util/deep-json')
    const json = stringifyJsonWithFallback(ast)
    if (typeof json !== 'string') throw new Error('Unable to serialize AST')
    if (report) fs.writeFileSync(report, json, { flag: 'wx' })
    else process.stdout.write(json + '\n')
    process.exitCode = 0
  } catch (error: any) {
    if (error.code === 'commander.helpDisplayed') { process.exitCode = 0; return }
    console.error(`Compiler AST export failed: ${error.message}`)
    process.exitCode = 2
  }
}
