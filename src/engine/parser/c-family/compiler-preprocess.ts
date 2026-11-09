import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { BuildContext, Diagnostic } from './build-context'
import type { SourceSegment } from './source-map'
import { decodeLineMarkers } from './source-map'
import type { CompilerMetadata } from './compiler-declarations'
import { readCompilerDeclarations } from './compiler-declarations'

const execute = promisify(execFile)
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const takesValue = new Set(['-o', '-MF', '-MT', '-MQ', '-MJ'])
const preprocessValues = new Set(['-I', '-isystem', '-iquote', '-idirafter', '-include', '-imacros', '-D', '-U'])
const actions = new Set(['-c', '-S', '-E', '-M', '-MM', '-MD', '-MMD', '-MP', '-MG', '--'])

export interface CompilerPreparedUnit {
  context: BuildContext
  text: string
  sourceMap: SourceSegment[]
  dependencies: { file: string; sha256: string; system: boolean }[]
  artifactHash: string
  compilerId: string
  diagnostics: Diagnostic[]
  status: 'prepared' | 'failed'
  metadata?: CompilerMetadata
  directory: string
  libraryBodies?: { begin: number; end: number }[]
}

/**
 * Count driver arguments to remove before validating semantic options.
 * @param context Compilation directory and source file.
 * @param arg Current compiler argument.
 * @returns {number} Arguments consumed, or zero to retain the option for validation.
 */
function driverArgumentWidth(context: BuildContext, arg: string): number {
  if (takesValue.has(arg)) return 2
  if (actions.has(arg) || /^-(o|MF|MT|MQ|MJ).+/.test(arg)) return 1
  if (!arg.startsWith('-') && path.resolve(context.directory, arg) === context.sourceFile) return 1
  return 0
}

/**
 * Count language and preprocessing arguments replaced by the current compiler stage.
 * @param arg Current compiler argument.
 * @param preprocessed Whether the input has already been preprocessed.
 * @returns {number} Arguments consumed, or zero to retain the option.
 */
function preprocessingArgumentWidth(arg: string, preprocessed: boolean): number {
  if (arg === '-x') return 2
  if (/^-x.+/.test(arg)) return 1
  if (preprocessed && preprocessValues.has(arg)) return 2
  if (preprocessed && /^-[DIU].+/.test(arg)) return 1
  return 0
}

/**
 * Remove driver actions while retaining semantic flags and their order.
 * @param context Original compiler invocation and source selection.
 * @param preprocessed Whether the input has already been preprocessed.
 * @returns {string[]} Semantic compiler arguments in their original order.
 */
export function compilerArguments(context: BuildContext, preprocessed = false): string[] {
  const args: string[] = []
  const argv = context.argv.slice(1)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const driverWidth = driverArgumentWidth(context, arg)
    if (driverWidth) {
      i += driverWidth - 1
      continue
    }
    if (/^(@|-fplugin|-fpass-plugin|-specs|-wrapper|-B|-cc1|-fmodules|-fmodule-|--cuda|--hip|--config)/.test(arg)) {
      throw new Error(`Unsupported compiler option: ${arg}`)
    }
    if (arg === '-Xclang') {
      const option = argv[++i]
      if (!option || !/^-clang-vendor-feature=|^-fno-odr-hash-protocols$|^-W/.test(option)) {
        throw new Error(`Unsupported frontend option: ${option}`)
      }
      args.push(arg, option)
      continue
    }
    const preprocessingWidth = preprocessingArgumentWidth(arg, preprocessed)
    if (preprocessingWidth) {
      i += preprocessingWidth - 1
      continue
    }
    args.push(arg)
  }
  return args
}

/**
 * Make dependency escaping is independent of shell quoting.
 * @param text Compiler dependency output in Make syntax.
 * @param directory Base directory for relative dependency paths.
 * @returns {string[]} Unique absolute paths in dependency order.
 */
export function dependencyFiles(text: string, directory: string): string[] {
  const body = text.replace(/\\\r?\n/g, '').replace(/^[^:]*:/, '')
  const names = body.match(/(?:\\.|[^\s])+/g) || []
  return [...new Set(names.map((name) => path.resolve(directory, name.replace(/\\(.)/g, '$1'))))]
}

/**
 * Stream the compiler AST to disk and read its declaration metadata.
 * @param context Original compiler invocation and language selection.
 * @param directory Directory containing the preprocessed unit and compiler products.
 * @param env Compiler environment.
 * @param timeout Compiler execution timeout in milliseconds.
 * @returns {Promise<CompilerMetadata>} Declarations from the preprocessed input.
 */
async function readDeclarationMetadata(
  context: BuildContext,
  directory: string,
  env: NodeJS.ProcessEnv,
  timeout: number
): Promise<CompilerMetadata> {
  const compiler = context.argv[0]
  const astFile = path.join(directory, 'compiler-ast.json')
  const rawFile = path.join(directory, context.language === 'cpp' ? 'unit.ii' : 'unit.i')
  const args = [
    ...compilerArguments(context, true),
    '-x',
    context.language === 'cpp' ? 'c++-cpp-output' : 'cpp-output',
    '-fsyntax-only',
    '-Xclang',
    '-ast-dump=json',
    rawFile,
  ]
  fs.writeFileSync(path.join(directory, 'declarations.argv.json'), JSON.stringify([compiler, ...args], null, 2))
  // Stream the large compiler AST to disk instead of buffering libc++ in memory.
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    const stdout = fs.openSync(astFile, 'w')
    const stderr = fs.openSync(path.join(directory, 'declarations.stderr'), 'w')
    const child = spawn(compiler, args, { cwd: context.directory, env, timeout, stdio: ['ignore', stdout, stderr] })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      fs.closeSync(stdout)
      fs.closeSync(stderr)
      if (code === 0) resolve()
      else reject(new Error(`Compiler declaration analysis failed (${code}, ${signal})`))
    })
  })
  return readCompilerDeclarations(astFile)
}

/**
 * Preserve original compiler products even if a later stage fails.
 * @param context Original compiler invocation and build identity.
 * @param outDir Parent directory for compiler products.
 * @returns {Promise<CompilerPreparedUnit>} Prepared unit or diagnostics from a failed compiler stage.
 */
export async function preprocessUnit(context: BuildContext, outDir: string): Promise<CompilerPreparedUnit> {
  const directory = path.join(outDir, context.unitId)
  fs.mkdirSync(directory, { recursive: true })
  const result: CompilerPreparedUnit = {
    context,
    directory,
    text: '',
    sourceMap: [],
    dependencies: [],
    artifactHash: '',
    compilerId: '',
    diagnostics: [],
    status: 'failed',
  }
  fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify(context, null, 2))
  const compiler = context.argv[0]
  const timeout = context.timeoutMs || 120_000
  const env = { ...process.env, ...context.environment }
  const run = async (args: string[], name: string): Promise<string> => {
    fs.writeFileSync(path.join(directory, `${name}.argv.json`), JSON.stringify([compiler, ...args], null, 2))
    try {
      const output = await execute(compiler, args, {
        cwd: context.directory,
        env,
        timeout,
        maxBuffer: 256 * 1024 * 1024,
      })
      fs.writeFileSync(path.join(directory, `${name}.stderr`), output.stderr)
      return output.stdout
    } catch (error: any) {
      fs.writeFileSync(path.join(directory, `${name}.stderr`), String(error.stderr || error.message))
      throw error
    }
  }
  try {
    result.compilerId = await run(['--version'], 'compiler-version')
    if (!/clang version|Apple clang/i.test(result.compilerId))
      throw new Error('Clang is required for authoritative declaration metadata')
    const rawFile = path.join(directory, context.language === 'cpp' ? 'unit.ii' : 'unit.i')
    const depFile = path.join(directory, 'dependencies.d')
    const beforeFile = path.join(directory, 'dependencies-before.d')
    await run(
      [
        ...compilerArguments(context),
        '-x',
        context.language === 'cpp' ? 'c++' : 'c',
        '-M',
        '-MF',
        beforeFile,
        '-MT',
        'yasa',
        context.sourceFile,
      ],
      'dependency-snapshot'
    )
    const before = new Map(
      dependencyFiles(fs.readFileSync(beforeFile, 'utf8'), context.directory).map((file) => [
        file,
        sha(fs.readFileSync(file)),
      ])
    )
    await run(
      [
        ...compilerArguments(context),
        '-x',
        context.language === 'cpp' ? 'c++' : 'c',
        '-E',
        '-MD',
        '-MF',
        depFile,
        '-MT',
        'yasa',
        context.sourceFile,
        '-o',
        rawFile,
      ],
      'preprocess'
    )
    const raw = fs.readFileSync(rawFile, 'utf8')
    const decoded = decodeLineMarkers(raw, context.directory)
    result.text = decoded.text
    result.sourceMap = decoded.sourceMap
    const systemFiles = new Set(decoded.sourceMap.filter((s) => s.origin.system).map((s) => s.origin.physicalFile))
    result.dependencies = dependencyFiles(fs.readFileSync(depFile, 'utf8'), context.directory).map((file) => ({
      file,
      sha256: sha(fs.readFileSync(file)),
      system: systemFiles.has(file),
    }))
    if (
      before.size !== result.dependencies.length ||
      result.dependencies.some((d) => before.get(d.file) !== d.sha256)
    ) {
      throw new Error('Input dependencies changed during compiler preprocessing')
    }
    result.metadata = await readDeclarationMetadata(context, directory, env, timeout)
    if (result.dependencies.some((d) => sha(fs.readFileSync(d.file)) !== d.sha256))
      throw new Error('Input dependencies changed during declaration analysis')
    const environmentNames = [
      'PATH',
      'CPATH',
      'C_INCLUDE_PATH',
      'CPLUS_INCLUDE_PATH',
      'SDKROOT',
      'MACOSX_DEPLOYMENT_TARGET',
    ]
    const actualEnvironment = Object.fromEntries(
      environmentNames.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])
    )
    fs.writeFileSync(path.join(directory, 'compiler-environment.json'), JSON.stringify(actualEnvironment, null, 2))
    result.artifactHash = sha(JSON.stringify([raw, context, actualEnvironment, result.compilerId, result.dependencies]))
    result.status = 'prepared'
    fs.writeFileSync(path.join(directory, 'source-map.json'), JSON.stringify(result.sourceMap))
    fs.writeFileSync(path.join(directory, 'declarations.json'), JSON.stringify(result.metadata))
  } catch (error: any) {
    result.diagnostics.push({
      code: error.killed ? 'timed_out' : 'preprocess_failed',
      stage: 'compiler',
      message: String(error.message),
      unitId: context.unitId,
    })
  }
  fs.writeFileSync(
    path.join(directory, 'prepared.json'),
    JSON.stringify({ ...result, text: undefined, metadata: undefined }, null, 2)
  )
  return result
}
