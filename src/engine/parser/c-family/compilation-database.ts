import { readFile } from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import type { CompileEntry, Language } from './build-context'

/** Lex POSIX quoting without invoking a shell or expanding any shell expressions. */
export function parsePosixCommand(command: string): string[] {
  if (typeof command !== 'string' || command.includes('\0')) throw new Error('Invalid shell command string')
  const argv: string[] = []
  let word = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (ch === '\\') {
      const next = command[++i]
      if (next === undefined) throw new Error('Unterminated shell escape')
      if (next === '\n') continue
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\'
      word += next
      started = true
      continue
    }
    if (ch === '$' || ch === '`') throw new Error('Unsupported shell substitution or variable expansion')
    if (quote === '"') {
      if (ch === '"') quote = null
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === ' ' || ch === '\t') {
      if (started) argv.push(word)
      word = ''
      started = false
    } else {
      if (/[;&|<>()\r\n*?\[\]{}~#]/.test(ch)) throw new Error(`Unsupported shell syntax ${JSON.stringify(ch)}`)
      word += ch
      started = true
    }
  }
  if (quote) throw new Error('Unterminated shell quote')
  if (started) argv.push(word)
  if (!argv.length) throw new Error('Empty shell command')
  return argv
}

// Options whose next token is data, not a positional source or another driver option.
const operandOptions = new Set([
  '-x', '-o', '-D', '-U', '-I', '-F', '-B', '-isystem', '-iquote', '-idirafter',
  '-include', '-imacros', '-iprefix', '-iwithprefix', '-iwithprefixbefore', '-isysroot',
  '--sysroot', '-target', '--target', '-arch', '-std', '--std', '--driver-mode',
  '-MF', '-MT', '-MQ', '-MJ', '-Xclang', '-Xpreprocessor', '-Xassembler', '-Xlinker',
  '-resource-dir', '--gcc-toolchain', '-gcc-toolchain', '-fdebug-prefix-map',
  '-iframework', '-iframeworkwithsysroot', '-working-directory',
])

function isResponseArgument(arg: string): boolean {
  return arg.startsWith('@') ||
    (/^-W[pal],/.test(arg) && arg.split(',').slice(1).some(part => part.startsWith('@'))) ||
    /^-X(?:clang|preprocessor|assembler|linker)=@/.test(arg)
}

function inspect(entry: CompileEntry): { language: Language; standard: string | null } {
  const { argv, sourceFile, directory } = entry
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('arguments must be a nonempty array of strings without NUL')
  }
  const driver = path.basename(argv[0])
  if (!/^(?:[A-Za-z0-9_.]+-)*(?:clang\+\+|clang|gcc|g\+\+)(?:-\d+(?:\.\d+)*)?$/.test(driver)) {
    throw new Error(`Unsupported compiler/wrapper ${JSON.stringify(argv[0])}; use a direct Clang/GCC driver`)
  }
  let cppDriver = /(?:clang\+\+|g\+\+)(?:-\d+(?:\.\d+)*)?$/.test(driver)
  let explicitLanguage: string | null = null
  let sourceLanguage: string | null = null
  let standard: string | null = null
  let positionalOnly = false
  const inputs: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (isResponseArgument(arg)) throw new Error(`Unsupported response file ${arg}`)
    if (['&&', '||', ';', '|', '<', '>', '&'].includes(arg)) throw new Error(`Unsupported shell control ${arg}`)
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue }
    if (!positionalOnly && arg.startsWith('-') && arg !== '-') {
      if (/^(?:-fmodule|-fprebuilt-module|-include-pch|-include-pth|-fplugin|-cc1|--cuda|-cuda|-load|--config|--options-file)/.test(arg)) {
        throw new Error(`Unsupported compiler option ${arg}`)
      }
      let value: string | undefined
      if (operandOptions.has(arg)) {
        value = argv[++i]
        if (!value || isResponseArgument(value) || (value.startsWith('-') && !arg.startsWith('-X'))) {
          throw new Error(`Missing or unsupported operand for ${arg}`)
        }
        if (arg === '-Xclang' && /^(?:-load|-plugin|-add-plugin|-fmodule|-include-pch)/.test(value)) {
          throw new Error(`Unsupported compiler option ${arg} ${value}`)
        }
      }
      if (arg === '-x' || arg.startsWith('-x')) explicitLanguage = arg === '-x' ? value! : arg.slice(2)
      if (arg === '-std' || arg === '--std' || arg.startsWith('-std=') || arg.startsWith('--std=')) {
        standard = value ?? arg.slice(arg.indexOf('=') + 1)
        if (!standard) throw new Error(`Missing operand for ${arg}`)
      }
      if (arg === '--driver-mode' || arg.startsWith('--driver-mode=')) {
        const mode = value ?? arg.slice('--driver-mode='.length)
        if (mode !== 'g++' && mode !== 'gcc') throw new Error(`Unsupported driver mode ${mode}`)
        cppDriver = mode === 'g++'
      }
      continue
    }
    if (!arg || arg === '-') throw new Error('Missing source input; stdin is unsupported')
    inputs.push(path.resolve(directory, arg))
    if (path.resolve(directory, arg) === sourceFile) sourceLanguage = explicitLanguage
  }
  if (inputs.length !== 1 || inputs[0] !== sourceFile) {
    throw new Error(`Expected exactly one positional source matching file ${sourceFile}; found ${JSON.stringify(inputs)}`)
  }
  if (sourceLanguage && sourceLanguage !== 'none') {
    if (sourceLanguage === 'c' || sourceLanguage === 'c-header') return { language: 'c', standard }
    if (sourceLanguage === 'c++' || sourceLanguage === 'c++-header') return { language: 'cpp', standard }
    throw new Error(`Unsupported language -x ${sourceLanguage}`)
  }
  const extension = path.extname(sourceFile)
  if (['.cu', '.cuh', '.m', '.mm', '.s', '.S'].includes(extension)) {
    throw new Error(`Unsupported source language for ${sourceFile}; explicit C/C++ -x is required`)
  }
  if (cppDriver) return { language: 'cpp', standard }
  if (extension === '.c' || extension === '.i') return { language: 'c', standard }
  if (['.C', '.cc', '.cp', '.cpp', '.CPP', '.cxx', '.c++', '.ii', '.hpp', '.hh', '.hxx', '.H'].includes(extension)) {
    return { language: 'cpp', standard }
  }
  throw new Error(`Cannot resolve language for ${sourceFile}; headers/unknown suffixes require explicit -x or a C++ driver`)
}

export function resolveLanguage(entry: CompileEntry): Language {
  return inspect(entry).language
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

export async function readCompilationDatabase(file: string): Promise<CompileEntry[]> {
  const databaseFile = path.resolve(file)
  let records: unknown
  try { records = JSON.parse(await readFile(databaseFile, 'utf8')) }
  catch (error) { throw new Error(`Compilation database ${databaseFile}: unable to read JSON: ${(error as Error).message}`) }
  if (!Array.isArray(records)) throw new Error(`Compilation database ${databaseFile}: expected an array of records`)
  const entries = records.map((record: unknown, recordIndex: number): CompileEntry => {
    try {
      if (!object(record)) throw new Error('expected an object')
      for (const key of Object.keys(record)) {
        if (!['directory', 'file', 'arguments', 'command', 'output'].includes(key)) throw new Error(`Unknown field ${key}`)
      }
      if (!nonempty(record.directory)) throw new Error('directory must be a nonempty string')
      if (!nonempty(record.file)) throw new Error('file must be a nonempty string')
      if ('command' in record && !nonempty(record.command)) throw new Error('command must be a nonempty string')
      if ('output' in record && !nonempty(record.output)) throw new Error('output must be a nonempty string')
      const directory = path.resolve(path.dirname(databaseFile), record.directory)
      const sourceFile = path.resolve(directory, record.file)
      let argv: string[]
      if ('arguments' in record) {
        if (!Array.isArray(record.arguments) || !record.arguments.length || !record.arguments.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
          throw new Error('arguments must be a nonempty string array without NUL')
        }
        argv = [...record.arguments]
      } else {
        if (!nonempty(record.command)) throw new Error('arguments or command is required')
        argv = parsePosixCommand(record.command)
      }
      const entry: CompileEntry = {
        entryId: createHash('sha256').update(JSON.stringify([directory, sourceFile, argv])).digest('hex'),
        directory, sourceFile, argv,
        provenance: Object.freeze({ databaseFile, recordIndex, commandFormat: 'arguments' in record ? 'arguments' : 'command' }),
      }
      resolveLanguage(entry)
      Object.freeze(argv)
      return Object.freeze(entry)
    } catch (error) {
      throw new Error(`Compilation database ${databaseFile} record[${recordIndex}]: ${(error as Error).message}`)
    }
  })
  Object.freeze(entries)
  return entries
}
