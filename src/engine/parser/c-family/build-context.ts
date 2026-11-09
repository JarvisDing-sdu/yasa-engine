/** Shared contracts for the opt-in mixed C/C++ pipeline. */
export type Language = 'c' | 'cpp'

export interface Diagnostic {
  code: string
  stage: string
  message: string
  unitId?: string
}

export interface CompileEntry {
  entryId: string
  directory: string
  sourceFile: string
  argv: string[]
  /** The database is evidence of argv, not of the historical process environment. */
  provenance?: { databaseFile: string; recordIndex: number; commandFormat: 'arguments' | 'command' }
}

export interface BuildSelection {
  version: 1
  profileId: string
  units: { entryId: string; domainId: string }[]
  environment?: Record<string, string>
  timeoutMs?: number
}

export interface BuildContext extends CompileEntry {
  unitId: string
  profileId: string
  domainId: string
  language: Language
  standard: string | null
  environment: Record<string, string>
  /** Only declared profile values are captured here; preprocessing records its actual environment. */
  environmentProvenance?: Record<string, 'profile'>
  timeoutMs?: number
}

export interface Dependency {
  file: string
  sha256: string
  system: boolean
}
export interface Origin {
  file: string
  line: number
  column?: number
  system: boolean
}
export interface MapSegment {
  generatedStartLine: number
  generatedEndLine: number
  origin: Origin
}
export interface PreparedUnit {
  context: BuildContext
  text: string
  sourceMap: MapSegment[]
  dependencies: Dependency[]
  artifactHash: string
  compilerId: string
  diagnostics: Diagnostic[]
  status: 'prepared' | 'failed'
}
export interface ParsedUnit {
  prepared: PreparedUnit
  ast: unknown | null
  diagnostics: Diagnostic[]
  status: 'parsed' | 'partial' | 'failed'
}
