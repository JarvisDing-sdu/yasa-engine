import { Transform } from 'stream'

/** Collapse formatting whitespace while preserving strings and token boundaries. */
export function compactCompilerJson(): Transform {
  let quoted = false
  let escaped = false
  let whitespace = false
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const output = Buffer.allocUnsafe(chunk.length + 1)
      let length = 0
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index]
        if (quoted) {
          output[length++] = byte
          if (escaped) escaped = false
          else if (byte === 92) escaped = true
          else if (byte === 34) quoted = false
        } else if (byte === 32 || byte === 9 || byte === 10 || byte === 13) whitespace = true
        else {
          if (whitespace) output[length++] = 32
          whitespace = false
          output[length++] = byte
          if (byte === 34) quoted = true
        }
      }
      callback(null, output.subarray(0, length))
    },
    flush(callback) {
      if (whitespace) this.push(Buffer.from(' '))
      callback()
    },
  })
}
