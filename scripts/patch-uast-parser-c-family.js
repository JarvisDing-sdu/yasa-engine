#!/usr/bin/env node
// Keep grammar WASM as binary assets: pkg treats a literal require.resolve of
// a WASM file as JavaScript and can corrupt its bytes when byte-compiling it.
const fs = require('fs')
const path = require('path')

for (const [parser, grammar] of [['C', 'tree-sitter-c'], ['CPP', 'tree-sitter-cpp']]) {
  const file = path.resolve(__dirname, `../../uast/parser-${parser}/dist/src/parser.js`)
  const original = parser === 'C'
    ? "require.resolve('../grammar/tree-sitter-c.wasm')"
    : `require.resolve('${grammar}/${grammar}.wasm')`
  const replacement = parser === 'C'
    ? "require('path').join(__dirname, '../grammar/tree-sitter-c.wasm')"
    : `require('path').join(require('path').dirname(require.resolve('${grammar}/package.json')), '${grammar}.wasm')`
  const content = fs.readFileSync(file, 'utf8')
  if (content.includes(replacement)) continue
  if (!content.includes(original)) throw new Error(`Cannot find ${original} in ${file}`)
  fs.writeFileSync(file, content.replace(original, replacement))
  console.log(`Patched ${parser} grammar resolution for pkg`)
}
