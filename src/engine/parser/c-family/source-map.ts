import * as path from 'path'

export interface SourceOrigin {
  file: string
  line: number
  system: boolean
  physicalFile?: string
}

export interface SourceSegment {
  generatedStartLine: number
  generatedEndLine: number
  origin: SourceOrigin
}

/**
 * Keep the compiler's presumed locations distinct from physical dependencies.
 * @param raw
 * @param cwd
 * @returns {{text: string, sourceMap: SourceSegment[]}} Decoded text and provenance segments.
 */
export function decodeLineMarkers(raw: string, cwd: string): { text: string; sourceMap: SourceSegment[] } {
  const lines = raw.split('\n')
  const sourceMap: SourceSegment[] = []
  let physicalFile: string | undefined
  const includeStack: Array<string | undefined> = []
  let current: SourceSegment | undefined
  for (let index = 0; index < lines.length; index++) {
    const marker = /^#\s+(\d+)\s+"((?:\\.|[^"\\])*)"(.*)$/.exec(lines[index])
    if (!marker) continue
    if (current) current.generatedEndLine = index
    const filename: string = JSON.parse(`"${marker[2]}"`)
    const flags = marker[3].trim().split(/\s+/)
    const virtual = filename.startsWith('<')
    const file = virtual ? filename : path.resolve(cwd, filename)
    // Enter/return markers describe the physical include stack even when the
    // return name is virtual (<command-line>) or changed by #line.
    if (flags.includes('1')) {
      includeStack.push(physicalFile)
      if (!virtual) physicalFile = file
    } else if (flags.includes('2')) {
      if (includeStack.length) physicalFile = includeStack.pop()
      else if (!virtual) physicalFile = file
    } else if (!virtual && !physicalFile) physicalFile = file
    current = {
      generatedStartLine: index + 2,
      generatedEndLine: lines.length,
      origin: { file, line: Number(marker[1]), system: virtual || flags.includes('3'), physicalFile },
    }
    sourceMap.push(current)
    lines[index] = lines[index].replace(/[^\r]/g, ' ')
  }
  return { text: lines.join('\n'), sourceMap }
}

/**
 * Compiler line markers do not establish original token columns.
 * @param map
 * @param line
 * @returns {SourceOrigin | null} Original line without an unproven token column.
 */
export function mapOrigin(map: SourceSegment[], line: number): SourceOrigin | null {
  let lo = 0
  let hi = map.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const segment = map[mid]
    if (line < segment.generatedStartLine) hi = mid - 1
    else if (line > segment.generatedEndLine) lo = mid + 1
    else return { ...segment.origin, line: segment.origin.line + line - segment.generatedStartLine }
  }
  return null
}

/** Use byte offsets from Clang against the original, unmodified UTF-8 text. */
export class RawCoordinates {
  private bytes: Buffer

  private starts = [0]

  /**
   * Index original UTF-8 newline byte positions.
   * @param raw
   */
  constructor(raw: string) {
    this.bytes = Buffer.from(raw)
    for (let i = 0; i < this.bytes.length; i++) if (this.bytes[i] === 10) this.starts.push(i + 1)
  }

  /**
   * Translate a raw byte offset into generated parser coordinates.
   * @param offset
   * @returns {{line: number, column: number}} Generated line and UTF-16 column.
   */
  location(offset: number): { line: number; column: number } {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (this.starts[mid] <= offset) lo = mid + 1
      else hi = mid - 1
    }
    const start = this.starts[Math.max(hi, 0)]
    return { line: hi + 1, column: this.bytes.subarray(start, offset).toString('utf8').length + 1 }
  }
}

/**
 * Keep project code while retaining generated line and column widths.
 * @param text
 * @param map
 * @param sourceFile
 * @returns {string} Project parser input with system declarations masked.
 */
export function projectText(text: string, map: SourceSegment[], sourceFile: string): string {
  const lines = text.split('\n')
  for (const segment of map) {
    if (!segment.origin.system || segment.origin.physicalFile === sourceFile) continue
    for (let i = segment.generatedStartLine - 1; i < segment.generatedEndLine; i++) {
      lines[i] = lines[i].replace(/[^\r]/g, ' ')
    }
  }
  return lines.join('\n')
}
