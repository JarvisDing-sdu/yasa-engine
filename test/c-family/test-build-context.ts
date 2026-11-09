import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { readCompilationDatabase, parsePosixCommand, resolveLanguage } from '../../src/engine/parser/c-family/compilation-database'
import { selectBuildContexts } from '../../src/engine/parser/c-family/build-selection'
import type { BuildSelection, CompileEntry } from '../../src/engine/parser/c-family/build-context'

const root = path.resolve(__dirname, '../../../verification/mixed/build-context')
fs.mkdirSync(root, { recursive: true })
const run = fs.mkdtempSync(path.join(root, 'regressions-'))
let serial = 0
async function database(records: unknown): Promise<CompileEntry[]> {
  const file = path.join(run, `compile-${serial++}.json`)
  fs.writeFileSync(file, JSON.stringify(records))
  return readCompilationDatabase(file)
}
const record = (argv = ['clang', '-c', 'main.c']) => ({ directory: 'build dir', file: 'main.c', arguments: argv })
const hash = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const selection = (entryId: string): BuildSelection => ({ version: 1, profileId: 'debug', units: [{ entryId, domainId: 'app' }] })

describe('C-family compilation contexts', () => {
  it('arguments_preserve_D_U_order', async () => {
    const argv = ['clang', '-DVALUE=1', '-UVALUE', '-DVALUE=two words', '-Iinclude dir', '-c', 'main.c']
    const [entry] = await database([{ ...record(argv), command: 'unsupported && shell' }])
    assert.deepStrictEqual(entry.argv, argv)
    assert.strictEqual(entry.entryId, hash([path.join(run, 'build dir'), path.join(run, 'build dir/main.c'), argv]))
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.argv))
  })

  it('quoted_command_and_spaces', async () => {
    const [entry] = await database([{ directory: '.', file: 'source file.c', command: 'clang -DNAME="a b" -I\'inc dir\' -c "source file.c"' }])
    assert.deepStrictEqual(entry.argv, ['clang', '-DNAME=a b', '-Iinc dir', '-c', 'source file.c'])
    assert.deepStrictEqual(parsePosixCommand('clang "" a\\ b \'$HOME;literal\' "a\\qb"'), ['clang', '', 'a b', '$HOME;literal', 'a\\qb'])
    assert.deepStrictEqual(parsePosixCommand('clang a\\\nb.c'), ['clang', 'ab.c'])
  })

  it('relative_directory_uses_database_parent', async () => {
    const [entry] = await database([record()])
    assert.strictEqual(entry.directory, path.join(run, 'build dir'))
    assert.strictEqual(entry.sourceFile, path.join(run, 'build dir/main.c'))
  })

  it('does_not_realpath_symlink_directories', async () => {
    fs.mkdirSync(path.join(run, 'physical'))
    fs.symlinkSync('physical', path.join(run, 'logical'))
    const [entry] = await database([{ ...record(), directory: 'logical' }])
    assert.strictEqual(entry.directory, path.join(run, 'logical'))
  })

  it('same_source_multiple_entries_remain_distinct', async () => {
    const entries = await database([record(), record(['clang', '-DX=2', '-c', 'main.c'])])
    assert.strictEqual(entries[0].sourceFile, entries[1].sourceFile)
    assert.notStrictEqual(entries[0].entryId, entries[1].entryId)
  })

  it('x_cpp_overrides_dot_c', async () => {
    const [entry] = await database([record(['gcc', '-xc++', '-c', 'main.c'])])
    assert.strictEqual(resolveLanguage(entry), 'cpp')
  })

  it('x_is_effective_at_the_actual_source_position_and_none_resets', async () => {
    for (const [argv, language] of [
      [['clang', '-x', 'c++', '-x', 'none', 'main.c'], 'c'],
      [['clang', 'main.c', '-x', 'c++'], 'c'],
      [['clang++', '-xc', 'main.c'], 'c'],
      [['clang', '-D', 'main.c', '-xc++', 'main.c'], 'cpp'],
      [['clang', '-include', 'main.c', '-x', 'c++', 'main.c'], 'cpp'],
      [['clang', '--', 'main.c'], 'c'],
      [['clang', '--driver-mode=g++', 'main.c'], 'cpp'],
      [['/usr/bin/g++-13', 'main.c'], 'cpp'],
    ] as [string[], string][]) {
      const [entry] = await database([record(argv)])
      assert.strictEqual(resolveLanguage(entry), language, argv.join(' '))
    }
  })

  it('ambiguous_header_requires_language_evidence', async () => {
    await assert.rejects(database([{ ...record(['clang', 'shared.h']), file: 'shared.h' }]), /language|header/i)
    const [entry] = await database([{ ...record(['clang', '-xc++', 'shared.h']), file: 'shared.h' }])
    assert.strictEqual(resolveLanguage(entry), 'cpp')
  })

  it('shell_syntax_is_rejected_without_execution', () => {
    for (const command of ['clang main.c && touch marker', 'clang main.c; echo no', 'clang $(touch marker) main.c', 'clang `id` main.c', 'clang "$HOME" main.c', 'clang main.c > out', 'clang main.c\necho no', 'clang "unterminated', 'clang trailing\\']) {
      assert.throws(() => parsePosixCommand(command), /shell|quote|escape|substitution/i, command)
    }
    assert.ok(!fs.existsSync(path.join(run, 'marker')))
  })

  it('wrappers_response_files_multiple_inputs_and_missing_operands_reject', async () => {
    for (const argv of [
      ['ccache', 'clang', 'main.c'], ['env', 'CC=clang', 'clang', 'main.c'], ['sh', '-c', 'clang main.c'],
      ['clang', '@flags', 'main.c'], ['clang', '-Wp,@flags', 'main.c'],
      ['clang', 'main.c', 'other.c'], ['clang', '-c'], ['clang', '-x'], ['clang', 'main.c', '-I'],
      ['clang', '-x', 'objective-c', 'main.c'], ['clang', 'other.c'], ['clang', '--driver-mode=cl', 'main.c'],
    ]) await assert.rejects(database([record(argv)]), /record\s*\[?0|entry\s*\[?0/i, argv.join(' '))
  })

  it('schema_errors_name_the_database_record_and_field', async () => {
    for (const records of [{}, [null], [{ ...record(), arguments: [] }], [{ ...record(), arguments: ['clang', 1] }], [{ ...record(), directory: '' }], [{ ...record(), file: 3 }], [{ directory: '.', file: 'main.c' }], [{ ...record(), unexpected: true }], [{ ...record(), output: 3 }]]) {
      await assert.rejects(database(records), /database|record|arguments|directory|file|output/i)
    }
    const invalid = path.join(run, 'invalid.json')
    fs.writeFileSync(invalid, '[')
    await assert.rejects(readCompilationDatabase(invalid), /invalid.json.*JSON|JSON.*invalid.json/i)
  })

  it('two_domains_do_not_merge_and_same_domain_deduplicates', async () => {
    const entries = await database([record()])
    const entryId = entries[0].entryId
    const profile = selection(entryId)
    profile.units.push({ entryId, domainId: 'other' }, { entryId, domainId: 'app' })
    const contexts = selectBuildContexts(entries, profile)
    assert.deepStrictEqual(contexts.map(context => context.domainId), ['app', 'other'])
    assert.strictEqual(contexts[0].unitId, hash(['debug', 'app', entryId]))
    assert.notStrictEqual(contexts[0].unitId, contexts[1].unitId)
    assert.ok(Object.isFrozen(contexts[0]) && Object.isFrozen(contexts[0].argv))
    assert.strictEqual(selectBuildContexts(entries, { ...profile, profileId: 'release' })[0].unitId, hash(['release', 'app', entryId]))
  })

  it('unknown_entry_is_rejected', async () => {
    const entries = await database([record()])
    assert.throws(() => selectBuildContexts(entries, selection('missing')), /unknown.*missing/i)
  })

  it('environment_standard_timeout_and_provenance_are_explicit_and_copied', async () => {
    const entries = await database([record(['clang', '-std=c99', '-std=gnu11', 'main.c'])])
    const profile = { ...selection(entries[0].entryId), environment: { CPATH: 'include dir' }, timeoutMs: 2500 }
    const [context] = selectBuildContexts(entries, profile)
    profile.environment.CPATH = 'changed'
    assert.deepStrictEqual(context.environment, { CPATH: 'include dir' })
    assert.deepStrictEqual(context.environmentProvenance, { CPATH: 'profile' })
    assert.strictEqual(context.standard, 'gnu11')
    assert.strictEqual(context.timeoutMs, 2500)
    assert.ok(Object.isFrozen(context.environment) && Object.isFrozen(context.environmentProvenance))
    assert.deepStrictEqual(selectBuildContexts(entries, selection(entries[0].entryId))[0].environment, {})
  })

  it('standard_ignores_forwarded_option_operands', async () => {
    const entries = await database([record(['clang', '-std=c11', '-Xpreprocessor', '-std=c99', 'main.c'])])
    assert.strictEqual(selectBuildContexts(entries, selection(entries[0].entryId))[0].standard, 'c11')
  })

  it('literal_at_signs_and_quotes_in_macro_arguments_are_preserved', async () => {
    const argv = ['clang', '-DMAIL=@literal', '-DNOTE=x,@value', '-DSTR="a b"', 'main.c']
    const [entry] = await database([record(argv)])
    assert.deepStrictEqual(entry.argv, argv)
  })

  it('response_files_cannot_hide_in_joined_forwarding_flags', async () => {
    await assert.rejects(database([record(['clang', '-Xclang=@flags', 'main.c'])]), /response|unsupported/i)
  })

  it('unsupported_cuda_modules_and_pch_do_not_become_cpp', async () => {
    await assert.rejects(database([{ ...record(['clang++', 'main.cu']), file: 'main.cu' }]), /language|CUDA|unsupported/i)
    for (const option of ['-fmodules', '-include-pch=cache.pch', '--config=flags']) {
      await assert.rejects(database([record(['clang', option, 'main.c'])]), /unsupported/i)
    }
  })

  it('selection_schema_and_conflicting_ids_are_rejected', async () => {
    const entries = await database([record()])
    const profile = selection(entries[0].entryId)
    for (const invalid of [null, {}, { ...profile, version: 2 }, { ...profile, profileId: '' }, { ...profile, units: [] }, { ...profile, units: [{ entryId: entries[0].entryId, domainId: '' }] }, { ...profile, environment: { CPATH: 1 } }, { ...profile, environment: [] }, { ...profile, timeoutMs: 0 }, { ...profile, timeoutMs: Infinity }, { ...profile, unexpected: true }]) {
      assert.throws(() => selectBuildContexts(entries, invalid as BuildSelection), /selection|profile|units|environment|timeout|version/i)
    }
    assert.throws(() => selectBuildContexts([entries[0], { ...entries[0], argv: ['clang', '-DOTHER', 'main.c'] }], profile), /conflict|entryId/i)
  })
})
