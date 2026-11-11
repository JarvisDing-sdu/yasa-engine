# Experimental C/C++ build-profile scanning

The explicit `c-cpp` mode selects C or C++ for each translation unit from its actual compiler command. Existing `--language c` and `--language cpp` retain their separate paths. This mode is under local acceptance work and is not release-ready: a full zlib target still exhausts the analysis heap. Do not treat small-fixture scores as real-project vulnerability accuracy.

## Inputs

Use a real Clang compilation database and select the translation units of each linked program explicitly. GCC metadata, response files, shell wrappers, C++ modules, and unsupported object/template semantics do not silently fall back to another parser.

List normalized compilation entry IDs from the source checkout:

```sh
node --import tsx -e 'require("./src/engine/parser/c-family/compilation-database").readCompilationDatabase(process.argv[1]).then(entries => console.log(JSON.stringify(entries, null, 2)))' /path/to/compile_commands.json
```

A build profile selects those IDs, each with the link domain to which the object actually belongs:

```json
{
  "version": 1,
  "profileId": "my-build-debug",
  "units": [
    { "entryId": "<normalized compilation entry ID>", "domainId": "my-linked-program" }
  ]
}
```

Repeat a compilation entry in separate domains when the same object belongs to independent programs. Never combine unrelated executables into one domain just because they live in one repository. All selected commands, dependencies, and raw compiler output are preserved.

```sh
node --import tsx src/main.ts --language c-cpp \
  --sourcePath /path/to/project \
  --compileCommands /path/to/compile_commands.json \
  --buildProfile /path/to/build-profile.json \
  --report /path/to/new-empty-report-directory \
  --workerCount 2 --dumpAllCG
```

The compiled JavaScript entry also supports this mode. Clang and the appropriate SDK/system headers must be available to the compiler invocation. Compiler-provided contexts, including the language at the source argument's original position, determine header interpretation.

## Interpreting results

`analysis-manifest.json` records every selected translation unit, its domain, diagnostics, and terminal state. It also discloses compilation entries outside the selected profile and source files without compilation commands; it does not claim those files were analyzed. `complete` means the selected profile completed under the implemented semantics. Partial, failed, compiler-failed, conflicting-definition, changed-input, and timed-out analyses return a nonzero process status. An empty vulnerability report alone is never proof of completion.

Raw preprocessed files include full system headers. Compiler declaration metadata resolves real ABI identities; explicitly modeled APIs use those identities. Required ordinary wrappers without models retain their bodies transitively. Required unsupported system bodies and unsupported global initialization produce coverage diagnostics. Original file/line provenance appears in SARIF and callgraph output; unproven original columns are omitted.

Custom rules use declared API names and the existing trailing prefix wildcard syntax. Canonical symbol IDs remain internal. Default taint rules, exact compiler binding, link-domain isolation, and explicit incomplete states are part of this opt-in mode; general C++ class/virtual/STL semantics are not claimed.

## Acceptance evidence

The integration repository preserves the frozen 27 buildable fixtures, independent scorer, complete old C/CPP regression scores, source snapshots, and all failed real-project attempts. It has 13 dangerous cases, 13 safe controls, and one intentional preprocessing failure. The original C and C++ baselines are not rewritten.

## Export one compiler-configured AST

To inspect one C or C++ translation unit under a compile database command, use
`--cCompileCommands` with the single-file `--dumpAST` mode:

```sh
node --import tsx src/main.ts --language c --dumpAST \
  --sourcePath /path/to/project/src/file.c \
  --cCompileCommands /path/to/build/compile_commands.json \
  --report /path/to/new-ast.json
```

Use `--language cpp` for a C++ command. The report path must not already exist;
without `--report`, the JSON is written to stdout. This differs from the legacy
single-file exporter, which can overwrite an existing report. A source file with
multiple distinct compilation entries is rejected and the error lists their IDs;
pass `--cCompileEntry <ID>` to choose one explicitly. Identical entries are
considered one command. Other C preprocessor CLI flags do not combine with this
mode; use the build's compilation command instead.

This mode runs the recorded direct `clang`, `gcc`, `cc` or C++ driver with a
conservative allowlist of preprocessing options. Unsupported options, including
compiler forwarding flags, are reported as errors rather than silently ignored.
Only use a compilation database whose compiler commands you trust. The command
uses the current process environment; a compilation database does not record the
original build environment. No object file is produced.

The AST contains the selected configuration only. System-header contents are
masked, while project headers are retained. `loc` refers to preprocessed input;
`_meta.originalLocation` records the presumed original file and **start line**
from compiler line markers. Original columns and end ranges are not inferred.
The root's `_meta.compilerDump` records the selected command, the masking policy,
compiler stderr, and whether tree-sitter recorded syntax errors. A successful
export with zero syntax errors does not establish full semantic coverage.
