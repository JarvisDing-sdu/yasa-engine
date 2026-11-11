/** Explicit single-configuration, compiler-preprocessed AST export. */
import * as fs from 'fs'
import * as path from 'path'
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
        /^(?:-pipe|-pthread|-ansi|-pedantic|-pedantic-errors|-fPIC|-fpic|-fPIE|-fpie|-fno-omit-frame-pointer|-fomit-frame-pointer|-fno-common|-fcommon|-funsigned-char|-fsigned-char|-fshort-wchar|-funroll-loops|-fno-unroll-loops)$/.test(arg) ||
        /^-W(?![pale],)[a-zA-Z0-9_=,+-]+$/.test(arg)) continue
    throw new Error(`Unsupported compiler option in AST export: ${arg}`)
  }
  return args
}

/** Run only when --cCompileCommands was explicitly selected. */
export async function runCompilerDumpCLI(args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  program.requiredOption('--sourcePath <file>').requiredOption('--language <language>').requiredOption('--dumpAST')
    .requiredOption('--cCompileCommands <file>').option('--cCompileEntry <id>').option('--report <file>').option('--single')
  try {
    program.parse(args, { from: 'user' })
    const opts = program.opts()
    if (!['c', 'cpp'].includes(opts.language)) throw new Error('--language must be c or cpp')
    const source = fs.realpathSync(path.resolve(opts.sourcePath))
    if (!fs.statSync(source).isFile()) throw new Error('--sourcePath must identify one source file')
    const database = fs.realpathSync(path.resolve(opts.cCompileCommands))
    const entries = await readCompilationDatabase(database)
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
    const preprocessed = await run('-E')
    const raw = preprocessed.stdout
    const { text, sourceMap } = decodeLineMarkers(raw, entry.directory)
    const projected = projectText(text, sourceMap, entry.sourceFile)
    const { Parser } = opts.language === 'cpp' ? require('@ant-yasa/uast-parser-cpp') : require('@ant-yasa/uast-parser-c')
    const parser = new Parser()
    await parser.init()
    const generatedSource = `<preprocessed:${entry.sourceFile}>`
    const ast = parser.parsePreprocessed(projected, { sourcefile: generatedSource, languageVersion: context.standard || undefined })
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
      environment: 'current_process', systemHeaders: 'masked', compilerStderr: preprocessed.stderr,
      status: ast._meta.parseErrors?.length ? 'syntax_errors' : 'no_syntax_errors' }
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
