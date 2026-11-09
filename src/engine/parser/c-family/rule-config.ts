import * as path from 'path'
import type { FamilySymbol } from './symbol-index'
import type { FamilyParsedUnit } from './c-family-ast-builder'

/**
 * Rule authors name APIs; the interpreter uses their compiler-resolved bindings.
 * @param config
 * @param index
 * @param units
 * @param sourcePath
 * @returns {any} Rules with compiler-bound function and entrypoint identities.
 */
export function resolveRuleConfig(
  config: any,
  index: Map<string, Map<string, FamilySymbol>>,
  units: FamilyParsedUnit[],
  sourcePath: string
): any {
  const names = new Map<string, Set<string>>()
  for (const symbols of index.values())
    for (const symbol of symbols.values()) {
      if (symbol.kind !== 'function') continue
      const keys = names.get(symbol.displayName) || new Set<string>()
      keys.add(symbol.key)
      names.set(symbol.displayName, keys)
    }
  const entrypoints: { key: string; display: string; original: string; generated: string }[] = []
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.type === 'FunctionDefinition' && node._meta?.cFamilySymbol) {
      entrypoints.push({
        key: node.id.name,
        display: node._meta.cFamilySymbol.displayName,
        original: node._meta.originalLocation?.sourcefile,
        generated: node.loc.sourcefile,
      })
    }
    for (const [key, value] of Object.entries(node)) if (!['parent', '_meta', 'loc'].includes(key)) walk(value)
  }
  units.forEach((unit) => walk(unit.ast))
  const FileUtil = require('../../../util/file-util')
  const rewrite = (value: any): any => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value))
      return value.flatMap((item) => {
        if (typeof item?.fsig === 'string') {
          const signature: string = item.fsig
          const matches = [...names].filter(([name]) =>
            signature.endsWith('*') ? name.startsWith(signature.slice(0, -1)) : name === signature
          )
          if (matches.length) {
            const keys = new Set(matches.flatMap(([, bindings]) => [...bindings]))
            return [...keys].map((fsig) => rewrite({ ...item, fsig }))
          }
        }
        if (item?.functionName && item?.filePath) {
          const filename = item.filePath.startsWith(sourcePath)
            ? item.filePath
            : path.join(sourcePath, item.filePath.replace(/^\/+/, ''))
          const matches = entrypoints.filter((e) => e.display === item.functionName && e.original === filename)
          if (!matches.length) throw new Error(`Configured entrypoint not found: ${item.filePath} ${item.functionName}`)
          return matches.map((e) => ({
            ...item,
            functionName: e.key,
            filePath: FileUtil.extractAfterSubstring(e.generated, sourcePath),
          }))
        }
        return rewrite(item)
      })
    const result: any = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'checkerIds' && Array.isArray(item)) {
        result[key] = [
          ...new Set(
            item.map((id) =>
              ['taint_flow_c_input', 'taint_flow_cpp_input'].includes(id) ? 'taint_flow_c_cpp_input' : id
            )
          ),
        ]
      } else result[key] = rewrite(item)
    }
    return result
  }
  return rewrite(config)
}

/**
 * Collect declared API models for system-body selection.
 * @param config
 * @returns {Set<string>} Modeled API signatures.
 */
export function modeledAPIs(config: any): Set<string> {
  const names = new Set<string>()
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return
    if (typeof value.fsig === 'string') names.add(value.fsig)
    Object.values(value).forEach(visit)
  }
  visit(config)
  return names
}
