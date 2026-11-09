import * as fs from 'fs'
import * as path from 'path'
import type { CompilerPreparedUnit } from './compiler-preprocess'
import type { CompilerDeclaration } from './compiler-declarations'
import { RawCoordinates, mapOrigin } from './source-map'

/**
 * Required unmodeled wrappers are code, even when the build marks their header as system.
 * @param unit
 * @param modeledNames
 */
export default function retainLibraryBodies(unit: CompilerPreparedUnit, modeledNames: Set<string>): void {
  const raw = fs.readFileSync(path.join(unit.directory, unit.context.language === 'cpp' ? 'unit.ii' : 'unit.i'), 'utf8')
  const coordinates = new RawCoordinates(raw)
  const metadata = unit.metadata!
  const byId = new Map(metadata.declarations.map((d) => [d.id, d]))
  const bodyByLink = new Map(
    metadata.declarations.filter((d) => d.kind === 'FunctionDecl' && d.hasBody).map((d) => [d.mangledName || d.name, d])
  )
  const queue: CompilerDeclaration[] = []
  const selected = new Set<string>()
  const projectReference = (offset: number) => {
    const origin = mapOrigin(unit.sourceMap, coordinates.location(offset).line)
    return !!origin && (!origin.system || origin.physicalFile === unit.context.sourceFile)
  }
  const add = (id: string) => {
    const declaration = byId.get(id)
    if (!declaration || declaration.kind !== 'FunctionDecl') return
    const body = bodyByLink.get(declaration.mangledName || declaration.name)
    if (!body || selected.has(body.id) || projectReference(body.offset)) return
    const name = [...body.scopeNames.filter(Boolean), body.name].join('::')
    if (modeledNames.has(name) || (body.languageLinkage === 'C' && modeledNames.has(body.name))) return
    selected.add(body.id)
    if (body.template) {
      unit.diagnostics.push({
        code: 'unmodeled_system_template',
        stage: 'parse',
        message: name,
        unitId: unit.context.unitId,
      })
      return
    }
    queue.push(body)
  }
  for (const reference of metadata.references) if (projectReference(reference.offset)) add(reference.declarationId)
  const bodies: { begin: number; end: number }[] = []
  for (let index = 0; index < queue.length; index++) {
    const declaration = queue[index]
    bodies.push(declaration.range)
    for (const reference of metadata.references) {
      if (reference.offset >= declaration.range.begin && reference.offset < declaration.range.end)
        add(reference.declarationId)
    }
  }
  unit.libraryBodies = bodies
}
