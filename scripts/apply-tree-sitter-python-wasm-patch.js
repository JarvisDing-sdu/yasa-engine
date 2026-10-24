#!/usr/bin/env node

/**
 * Keep the packaged Python parser aligned with the local grammar repair.
 *
 * tree-sitter-python 0.25.0 rejects valid starred expressions in an
 * unparenthesized return tuple (for example: `return 1, *[None]`).  The
 * checked-in WASM asset was generated from that exact version with only the
 * grammar repair applied.  Run this after npm install, because npm recreates
 * node_modules and would otherwise discard the repaired binary.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXPECTED_PARSER_VERSION = '0.25.0';
const EXPECTED_WASM_SHA256 = 'e8a6af792c36f74dcd9630e93f487e740537bf14b98e62f775d89f5d37ff9e57';

const engineDir = path.resolve(__dirname, '..');
const parserDir = path.resolve(engineDir, '../uast/parser-Python');
const sourceWasm = path.join(
  parserDir,
  'vendor',
  'tree-sitter-python-0.25.0-starred-return.wasm',
);
const installedParserDir = path.join(engineDir, 'node_modules', 'tree-sitter-python');
const installedPackageJson = path.join(installedParserDir, 'package.json');
const targetWasm = path.join(installedParserDir, 'tree-sitter-python.wasm');

function fail(message) {
  throw new Error(`tree-sitter-python WASM repair: ${message}`);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(sourceWasm)) {
  fail(`missing checked-in repair asset: ${sourceWasm}`);
}
if (sha256(sourceWasm) !== EXPECTED_WASM_SHA256) {
  fail(`repair asset checksum does not match ${EXPECTED_WASM_SHA256}`);
}
if (!fs.existsSync(installedPackageJson)) {
  fail(`npm did not install tree-sitter-python at ${installedParserDir}`);
}

const installedVersion = JSON.parse(fs.readFileSync(installedPackageJson, 'utf8')).version;
if (installedVersion !== EXPECTED_PARSER_VERSION) {
  fail(`expected tree-sitter-python ${EXPECTED_PARSER_VERSION}, found ${installedVersion}`);
}

fs.copyFileSync(sourceWasm, targetWasm);
if (sha256(targetWasm) !== EXPECTED_WASM_SHA256) {
  fail('copied WASM checksum verification failed');
}

console.log(`Applied checked-in tree-sitter-python ${installedVersion} starred-return repair.`);
