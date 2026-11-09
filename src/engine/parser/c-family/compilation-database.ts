import { readFile } from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import type { CompileEntry, Language } from './build-context'

interface CommandWords {
  argv: string[]
  word: string
  started: boolean
  quote: "'" | '"' | null
}

/**
 * Consume a backslash escape without expanding shell expressions.
 * @param command Original command containing the backslash.
 * @param index Index of the backslash to consume.
 * @param words Current word and quoting state.
 * @returns {number} Index of the escaped character, including a continued newline.
 */
function consumeEscape(command: string, index: number, words: CommandWords): number {
  const nextIndex = index + 1
  const next = command[nextIndex]
  if (next === undefined) throw new Error('Unterminated shell escape')
  if (next === '\n') return nextIndex
  if (words.quote === '"' && !['$', '`', '"', '\\'].includes(next)) words.word += '\\'
  words.word += next
  words.started = true
  return nextIndex
}

/**
 * Handle unquoted syntax and delimiters while retaining explicitly empty words.
 * @param ch Unescaped command character outside quotes.
 * @param words Current word and completed argument list.
 */
function consumeUnquoted(ch: string, words: CommandWords): void {
  if (ch === "'" || ch === '"') {
    words.quote = ch
    words.started = true
  } else if (ch === ' ' || ch === '\t') {
    if (words.started) words.argv.push(words.word)
    words.word = ''
    words.started = false
  } else {
    if (/[;&|<>()\r\n*?[\]{}~#]/.test(ch)) throw new Error(`Unsupported shell syntax ${JSON.stringify(ch)}`)
    words.word += ch
    words.started = true
  }
}

/**
 * Consume literal content or the closing delimiter inside an active shell quote.
 * @param ch Command character after escape and substitution handling, if applicable.
 * @param words Current word with its active quote delimiter.
 */
function consumeQuoted(ch: string, words: CommandWords): void {
  if (ch === words.quote) words.quote = null
  else words.word += ch
}

/**
 * Lex POSIX quoting without invoking a shell or expanding any shell expressions.
 * @param command Shell command recorded in a compilation database.
 * @returns {string[]} Arguments preserving quoted words, escapes, and their original order.
 */
export function parsePosixCommand(command: string): string[] {
  if (typeof command !== 'string' || command.includes('\0')) throw new Error('Invalid shell command string')
  const words: CommandWords = { argv: [], word: '', started: false, quote: null }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (words.quote === "'") {
      consumeQuoted(ch, words)
    } else if (ch === '\\') {
      i = consumeEscape(command, i, words)
    } else if (ch === '$' || ch === '`') {
      throw new Error('Unsupported shell substitution or variable expansion')
    } else if (words.quote === '"') {
      consumeQuoted(ch, words)
    } else {
      consumeUnquoted(ch, words)
    }
  }
  if (words.quote) throw new Error('Unterminated shell quote')
  if (words.started) words.argv.push(words.word)
  if (!words.argv.length) throw new Error('Empty shell command')
  return words.argv
}

// Options whose next token is data, not a positional source or another driver option.
const operandOptions = new Set([
  '-x',
  '-o',
  '-D',
  '-U',
  '-I',
  '-F',
  '-B',
  '-isystem',
  '-iquote',
  '-idirafter',
  '-include',
  '-imacros',
  '-iprefix',
  '-iwithprefix',
  '-iwithprefixbefore',
  '-isysroot',
  '--sysroot',
  '-target',
  '--target',
  '-arch',
  '-std',
  '--std',
  '--driver-mode',
  '-MF',
  '-MT',
  '-MQ',
  '-MJ',
  '-Xclang',
  '-Xpreprocessor',
  '-Xassembler',
  '-Xlinker',
  '-resource-dir',
  '--gcc-toolchain',
  '-gcc-toolchain',
  '-fdebug-prefix-map',
  '-iframework',
  '-iframeworkwithsysroot',
  '-working-directory',
])

/**
 * Detect response files both directly and inside compiler forwarding flags.
 * @param arg Compiler argument or option operand to inspect.
 * @returns {boolean} Whether the argument requests unsupported response-file expansion.
 */
function isResponseArgument(arg: string): boolean {
  return (
    arg.startsWith('@') ||
    (/^-W[pal],/.test(arg) &&
      arg
        .split(',')
        .slice(1)
        .some((part) => part.startsWith('@'))) ||
    /^-X(?:clang|preprocessor|assembler|linker)=@/.test(arg)
  )
}

interface DriverState {
  cppDriver: boolean
  explicitLanguage: string | null
  sourceLanguage: string | null
  standard: string | null
  positionalOnly: boolean
  inputs: string[]
}

/**
 * Validate the argument vector and require a direct Clang or GCC executable.
 * @param argv Arguments whose first token names the compiler driver.
 * @returns {boolean} Whether the executable selects C++ by default.
 */
function validateDriver(argv: string[]): boolean {
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('arguments must be a nonempty array of strings without NUL')
  }
  const driver = path.basename(argv[0])
  if (!/^(?:[A-Za-z0-9_.]+-)*(?:clang\+\+|clang|gcc|g\+\+)(?:-\d+(?:\.\d+)*)?$/.test(driver)) {
    throw new Error(`Unsupported compiler/wrapper ${JSON.stringify(argv[0])}; use a direct Clang/GCC driver`)
  }
  return /(?:clang\+\+|g\+\+)(?:-\d+(?:\.\d+)*)?$/.test(driver)
}

/**
 * Reject response-file expansion and shell controls even after a positional marker.
 * @param arg Argument in the compiler command.
 */
function validateArgument(arg: string): void {
  if (isResponseArgument(arg)) throw new Error(`Unsupported response file ${arg}`)
  if (['&&', '||', ';', '|', '<', '>', '&'].includes(arg)) throw new Error(`Unsupported shell control ${arg}`)
}

/**
 * Read a separate option operand without interpreting it as another driver option.
 * @param arg Driver option requiring a following operand.
 * @param value Following argument, if present.
 * @returns {string} Validated operand for the driver option.
 */
function optionOperand(arg: string, value: string | undefined): string {
  if (!value || isResponseArgument(value) || (value.startsWith('-') && !arg.startsWith('-X'))) {
    throw new Error(`Missing or unsupported operand for ${arg}`)
  }
  if (arg === '-Xclang' && /^(?:-load|-plugin|-add-plugin|-fmodule|-include-pch)/.test(value)) {
    throw new Error(`Unsupported compiler option ${arg} ${value}`)
  }
  return value
}

/**
 * Apply language, standard, and driver-mode flags in their original command order.
 * @param state Accumulated compiler option state.
 * @param arg Driver option currently being inspected.
 * @param value Separate operand when this option takes one.
 */
function applyDriverOption(state: DriverState, arg: string, value: string | undefined): void {
  if (arg === '-x' || arg.startsWith('-x')) state.explicitLanguage = arg === '-x' ? value! : arg.slice(2)
  if (arg === '-std' || arg === '--std' || arg.startsWith('-std=') || arg.startsWith('--std=')) {
    state.standard = value ?? arg.slice(arg.indexOf('=') + 1)
    if (!state.standard) throw new Error(`Missing operand for ${arg}`)
  }
  if (arg === '--driver-mode' || arg.startsWith('--driver-mode=')) {
    const mode = value ?? arg.slice('--driver-mode='.length)
    if (mode !== 'g++' && mode !== 'gcc') throw new Error(`Unsupported driver mode ${mode}`)
    state.cppDriver = mode === 'g++'
  }
}

/**
 * Validate one driver option and consume its operand before applying its effects.
 * @param argv Original compiler arguments.
 * @param index Position of the driver option.
 * @param state Accumulated compiler option state.
 * @returns {number} Last argument index consumed by this option.
 */
function inspectOption(argv: string[], index: number, state: DriverState): number {
  const arg = argv[index]
  if (
    /^(?:-fmodule|-fprebuilt-module|-include-pch|-include-pth|-fplugin|-cc1|--cuda|-cuda|-load|--config|--options-file)/.test(
      arg
    )
  ) {
    throw new Error(`Unsupported compiler option ${arg}`)
  }
  let value: string | undefined
  let lastIndex = index
  if (operandOptions.has(arg)) value = optionOperand(arg, argv[++lastIndex])
  applyDriverOption(state, arg, value)
  return lastIndex
}

/**
 * Resolve the source language from the effective -x value, suffix, and driver mode.
 * @param sourceFile Resolved source path used for suffix inference and diagnostics.
 * @param state Compiler state including the language effective at the source position.
 * @returns {Language} Supported C or C++ source language.
 */
function sourceLanguage(sourceFile: string, state: DriverState): Language {
  if (state.sourceLanguage && state.sourceLanguage !== 'none') {
    if (state.sourceLanguage === 'c' || state.sourceLanguage === 'c-header') return 'c'
    if (state.sourceLanguage === 'c++' || state.sourceLanguage === 'c++-header') return 'cpp'
    throw new Error(`Unsupported language -x ${state.sourceLanguage}`)
  }
  const extension = path.extname(sourceFile)
  if (['.cu', '.cuh', '.m', '.mm', '.s', '.S'].includes(extension)) {
    throw new Error(`Unsupported source language for ${sourceFile}; explicit C/C++ -x is required`)
  }
  if (state.cppDriver) return 'cpp'
  if (extension === '.c' || extension === '.i') return 'c'
  if (['.C', '.cc', '.cp', '.cpp', '.CPP', '.cxx', '.c++', '.ii', '.hpp', '.hh', '.hxx', '.H'].includes(extension)) {
    return 'cpp'
  }
  throw new Error(
    `Cannot resolve language for ${sourceFile}; headers/unknown suffixes require explicit -x or a C++ driver`
  )
}

/**
 * Capture a positional source and the language effective at its command position.
 * @param arg Positional argument outside option-operand handling.
 * @param entry Compile entry defining the expected source and working directory.
 * @param state Accumulated command state receiving the resolved input path.
 */
function collectSourceInput(arg: string, entry: CompileEntry, state: DriverState): void {
  if (!arg || arg === '-') throw new Error('Missing source input; stdin is unsupported')
  state.inputs.push(path.resolve(entry.directory, arg))
  if (path.resolve(entry.directory, arg) === entry.sourceFile) state.sourceLanguage = state.explicitLanguage
}

/**
 * Inspect a compiler command while keeping option operands separate from source inputs.
 * @param entry Compile entry with resolved directory and source paths.
 * @returns {object} Resolved language and final compiler standard.
 */
function inspect(entry: CompileEntry): { language: Language; standard: string | null } {
  const { argv, sourceFile } = entry
  const state: DriverState = {
    cppDriver: validateDriver(argv),
    explicitLanguage: null,
    sourceLanguage: null,
    standard: null,
    positionalOnly: false,
    inputs: [],
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    validateArgument(arg)
    if (!state.positionalOnly && arg === '--') {
      state.positionalOnly = true
    } else if (!state.positionalOnly && arg.startsWith('-') && arg !== '-') {
      i = inspectOption(argv, i, state)
    } else {
      collectSourceInput(arg, entry, state)
    }
  }
  if (state.inputs.length !== 1 || state.inputs[0] !== sourceFile) {
    throw new Error(
      `Expected exactly one positional source matching file ${sourceFile}; found ${JSON.stringify(state.inputs)}`
    )
  }
  return { language: sourceLanguage(sourceFile, state), standard: state.standard }
}

/**
 * Validate a direct compiler invocation and resolve its source language.
 * @param entry Compile entry to inspect without executing its command.
 * @returns {Language} Supported C or C++ language selected for the source input.
 */
export function resolveLanguage(entry: CompileEntry): Language {
  return inspect(entry).language
}

/**
 * Check whether a database record is a non-array object.
 * @param value Parsed JSON value to inspect.
 * @returns {boolean} Whether the value supports named database fields.
 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/**
 * Require a nonempty database string without NUL bytes.
 * @param value Database field to inspect.
 * @returns {boolean} Whether the field is a usable command, path, or output name.
 */
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

interface DatabaseRecord extends Record<string, unknown> {
  directory: string
  file: string
}

/**
 * Validate record fields before choosing between arguments and command syntax.
 * @param record Parsed database record to validate.
 */
function validateRecord(record: unknown): asserts record is DatabaseRecord {
  if (!object(record)) throw new Error('expected an object')
  for (const key of Object.keys(record)) {
    if (!['directory', 'file', 'arguments', 'command', 'output'].includes(key)) throw new Error(`Unknown field ${key}`)
  }
  if (!nonempty(record.directory)) throw new Error('directory must be a nonempty string')
  if (!nonempty(record.file)) throw new Error('file must be a nonempty string')
  if ('command' in record && !nonempty(record.command)) throw new Error('command must be a nonempty string')
  if ('output' in record && !nonempty(record.output)) throw new Error('output must be a nonempty string')
}

/**
 * Prefer literal arguments when present; otherwise lex the recorded command.
 * @param record Validated record that may contain either command representation.
 * @returns {string[]} Independent argument vector preserving the recorded token order.
 */
function recordArguments(record: DatabaseRecord): string[] {
  if ('arguments' in record) {
    if (
      !Array.isArray(record.arguments) ||
      !record.arguments.length ||
      !record.arguments.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    ) {
      throw new Error('arguments must be a nonempty string array without NUL')
    }
    return [...record.arguments]
  }
  if (!nonempty(record.command)) throw new Error('arguments or command is required')
  return parsePosixCommand(record.command)
}

/**
 * Normalize one record and attach its database location to any validation failure.
 * @param record Parsed database record.
 * @param recordIndex Zero-based position used for provenance and diagnostics.
 * @param databaseFile Absolute database path used to resolve relative directories.
 * @returns {CompileEntry} Frozen entry with verified language and argv identity.
 */
function compileEntry(record: unknown, recordIndex: number, databaseFile: string): CompileEntry {
  try {
    validateRecord(record)
    const directory = path.resolve(path.dirname(databaseFile), record.directory)
    const sourceFile = path.resolve(directory, record.file)
    const argv = recordArguments(record)
    const entry: CompileEntry = {
      entryId: createHash('sha256')
        .update(JSON.stringify([directory, sourceFile, argv]))
        .digest('hex'),
      directory,
      sourceFile,
      argv,
      provenance: Object.freeze({
        databaseFile,
        recordIndex,
        commandFormat: 'arguments' in record ? 'arguments' : 'command',
      }),
    }
    resolveLanguage(entry)
    Object.freeze(argv)
    return Object.freeze(entry)
  } catch (error) {
    throw new Error(`Compilation database ${databaseFile} record[${recordIndex}]: ${(error as Error).message}`)
  }
}

/**
 * Read and normalize a compilation database without invoking compilers or shells.
 * @param file Database path, resolved relative to the current process directory.
 * @returns {Promise<CompileEntry[]>} Frozen entries retaining record order and command provenance.
 */
export async function readCompilationDatabase(file: string): Promise<CompileEntry[]> {
  const databaseFile = path.resolve(file)
  let records: unknown
  try {
    records = JSON.parse(await readFile(databaseFile, 'utf8'))
  } catch (error) {
    throw new Error(`Compilation database ${databaseFile}: unable to read JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(records)) throw new Error(`Compilation database ${databaseFile}: expected an array of records`)
  const entries = records.map((record: unknown, recordIndex: number) => compileEntry(record, recordIndex, databaseFile))
  Object.freeze(entries)
  return entries
}
