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
