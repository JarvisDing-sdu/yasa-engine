/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs')
const path = require('path')
const { Parser: CUastParser } = require('@ant-yasa/uast-parser-cpp')
const Config = require('../../../config')

let cParser: InstanceType<typeof CUastParser> | null = null
let initPromise: Promise<void> | null = null

/**
 * 确保 C parser 已异步初始化（加载 tree-sitter WASM）
 * 多次调用安全，只初始化一次
 */
async function ensureInitialized(): Promise<void> {
  if (!cParser) {
    cParser = new CUastParser({ language: 'c' })
    initPromise = cParser.init()
  }
  if (initPromise) {
    await initPromise
    initPromise = null
  }
}

type Header = { file: string; content: string }

const headerCache = new Map<string, Map<string, Header | null>>()

/** Resolve each directory/name pair once, including unsuccessful lookups. */
function readHeader(dir: string, name: string): Header | null {
  const directory = path.isAbsolute(dir) ? dir : path.resolve(dir)
  let entries = headerCache.get(directory)
  if (!entries) {
    entries = new Map()
    headerCache.set(directory, entries)
  }
  const cached = entries.get(name)
  if (cached !== undefined) return cached
  const file = path.resolve(directory, name)
  let header: Header | null = null
  try {
    if (fs.statSync(file).isFile()) header = { file, content: fs.readFileSync(file, 'utf8') }
  } catch {
    // A later search directory can still contain the header.
  }
  entries.set(name, header)
  return header
}

/**
 * 传给 parser-C 的预处理配置：-D/-U、目标平台、未知宏处理方式，以及 `#include "..."` 的解析
 * （`"x.h"` 依次查找包含者所在目录、--cIncludeDir、项目根目录；`<x.h>` 只查找 --cIncludeDir）。
 * @returns 预处理配置
 */
function preprocessorOptions(): Record<string, unknown> {
  const pp = Config.cPreprocessor || {}
  const includeDirs: string[] = pp.includeDirs || []
  const projectRoot = Config.maindir
  return {
    defines: pp.defines,
    undefines: pp.undefines,
    target: pp.target,
    unknownMacros: pp.unknownMacros,
    resolveInclude: (includePath: string, fromFile: string | undefined, angled: boolean) => {
      if (!angled && fromFile) {
        const local = readHeader(path.dirname(fromFile), includePath)
        if (local) return local
      }
      for (const dir of includeDirs) {
        const header = readHeader(dir, includePath)
        if (header) return header
      }
      return !angled && projectRoot ? readHeader(projectRoot, includePath) : null
    },
  }
}

/**
 * 项目解析接口（由 parser.ts 统一处理文件级解析）
 * @param _rootDir - 项目根目录（未使用）
 * @param _options - 解析选项（未使用）
 * @returns null，由 parser.ts 逐文件调用 parseSingleFile
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function parseProject(_rootDir: string, _options?: Record<string, unknown>): Promise<null> {
  return null
}

/**
 * 解析单个 C 文件（同步接口）
 * 调用前必须已完成 ensureInitialized()
 * @param code - C 源代码
 * @param options - 解析选项（包含 sourcefile）
 * @returns UAST 节点
 */
function parseSingleFile(code: string, options?: Record<string, unknown>): unknown {
  if (!cParser || initPromise) {
    throw new Error('C parser 未初始化，请先调用 ensureInitialized()')
  }
  return cParser.parse(code, { preprocessor: preprocessorOptions(), ...(options || {}) })
}

module.exports = {
  ensureInitialized,
  parseSingleFile,
  parseProject,
  preprocessorOptions,
}
