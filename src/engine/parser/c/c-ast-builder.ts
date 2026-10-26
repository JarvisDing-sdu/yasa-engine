/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs')
const path = require('path')
const { Parser: CUastParser } = require('@ant-yasa/uast-parser-c')
const Config = require('../../../config')

let cParser: InstanceType<typeof CUastParser> | null = null
let initPromise: Promise<void> | null = null

/**
 * 确保 C parser 已异步初始化（加载 tree-sitter WASM）
 * 多次调用安全，只初始化一次
 */
async function ensureInitialized(): Promise<void> {
  if (!cParser) {
    cParser = new CUastParser()
    initPromise = cParser.init()
  }
  if (initPromise) {
    await initPromise
    initPromise = null
  }
}

const headerCache = new Map<string, string | null>()

/**
 * @param file - 头文件路径
 * @returns 文件内容；不存在时为 null
 */
function readHeader(file: string): string | null {
  if (!headerCache.has(file)) {
    let content: string | null = null
    try {
      if (fs.statSync(file).isFile()) content = fs.readFileSync(file, 'utf8')
    } catch {
      content = null
    }
    headerCache.set(file, content)
  }
  return headerCache.get(file) ?? null
}

/**
 * 传给 parser-C 的预处理配置：-D/-U、目标平台、未知宏处理方式，以及 `#include "..."` 的解析
 * （`"x.h"` 依次查找包含者所在目录、--cIncludeDir、项目根目录；`<x.h>` 只查找 --cIncludeDir）。
 * @returns 预处理配置
 */
function preprocessorOptions(): Record<string, unknown> {
  const pp = Config.cPreprocessor || {}
  const includeDirs: string[] = [...(pp.includeDirs || []), ...(Config.maindir ? [Config.maindir] : [])]
  return {
    defines: pp.defines,
    undefines: pp.undefines,
    target: pp.target,
    unknownMacros: pp.unknownMacros,
    resolveInclude: (includePath: string, fromFile: string | undefined, angled: boolean) => {
      const dirs = angled
        ? [...(pp.includeDirs || [])]
        : [...(fromFile ? [path.dirname(fromFile)] : []), ...includeDirs]
      for (const dir of dirs) {
        const file = path.resolve(dir, includePath)
        const content = readHeader(file)
        if (content !== null) return { file, content }
      }
      return null
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
}
