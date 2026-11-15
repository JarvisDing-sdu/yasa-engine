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

## Export a compiler-configured build target

The compile-database exporter also supports `--dumpAllAST`. Pass the source
root, a compilation database for the target, and a new report directory.

```sh
node --import tsx src/main.ts --language c --dumpAllAST \
  --sourcePath /path/to/project \
  --cCompileCommands /path/to/build/compile_commands.json \
  --report /path/to/new-report-directory
```

The exporter selects entries whose source files lie within the source path and
match the requested language. Repeated identical entries are deduplicated.
Different configurations of the same file are exported separately under their
entry IDs. Select the intended build target when generating or filtering the
compilation database.

`manifest.json` records each entry, output, duration, and failure or syntax
status. Entries run sequentially. A compiler failure is recorded and later
entries continue. The process exits with code 2 when any entry fails. ASTs with
syntax diagnostics retain their diagnostics and have `syntax_errors` status.
Use a new output directory for each experiment.

## Experimental Clang AST frontend

The compiler-configured exporter accepts `--cAstBackend clang`. This frontend
converts the compiler's AST JSON into YASA UAST. It requires a direct Clang
compilation command and the target's working headers, generated files and macros.

```sh
node --import tsx src/main.ts --language cpp --dumpAST \
  --sourcePath /path/to/project/src/file.cpp \
  --cCompileCommands /path/to/build/compile_commands.json \
  --cAstBackend clang --report /path/to/new-clang-uast.json
```

Use the same flag with `--dumpAllAST` to export the selected compilation database
entries. `manifest.json` identifies the frontend and records
`conversionDiagnostics` for each successful export. Each partial conversion has
`partial_conversion` status. Compiler failures remain failed entries with a
nonzero final exit code. `--cAstBackend tree-sitter` selects the default frontend.

The native input includes compiler line markers. Byte offsets are interpreted
against that exact preprocessed input, then mapped to presumed original start
lines. Project header definitions participate in the UAST. System definitions
are excluded from the standalone export. Original columns remain unknown.

The mixed-language analysis CLI accepts `--astBackend clang` with its existing
compilation database and build profile. It binds native declaration IDs to the
compiler symbol index, then passes UAST to the existing C-family analyzer.

```sh
node --import tsx src/main.ts --language c-cpp \
  --sourcePath /path/to/project \
  --compileCommands /path/to/build/compile_commands.json \
  --buildProfile /path/to/build/profile.json \
  --astBackend clang --dumpAllCG --report /path/to/new-analysis-directory
```

`analysis-manifest.json` records `astBackend`. Converter gaps make the unit
partial. Existing library-model, link-domain, uncovered-source and execution
checks still contribute their own diagnostics. The analysis consumes the
compiler-selected configuration. Additional macro configurations require
additional compile entries and an appropriate build profile.

The prototype covers common C declarations and expressions, direct and pointer
calls, compiler-expanded macros, aggregate initializers, selected `_Generic`
associations, common control flow, C++ records, template definitions and emitted
instantiations, captureless lambdas, range loops, exceptions and explicit member
initializers. Out-of-line methods are attached to their owning record.

Captured and generic lambdas, dependent template resolution, default arguments,
inline assembly, goto control flow and several allocation/lifetime constructs
have explicit partial-conversion markers. Inheritance and virtual dispatch also
remain partial. Unhandled nodes are retained as marked Noop nodes.
`_meta.clangBackend.unsupported` lists the categories encountered in the export.
A `converted` status measures this adapter's implemented syntax coverage. Engine
semantic coverage requires separate tests for the language feature in use.

Clang AST JSON includes system-library trees and template instantiations before
filtering. A template-heavy translation unit can therefore produce hundreds of
megabytes of intermediate JSON and require substantially more time than the
Tree-sitter route. Output node counts include those instantiations. Compare
call-site identities and independently adjudicated edges when evaluating graph
precision and recall.


### Native frontend hardening

Configured AST export now converts selected project declarations during the
strict declaration-reader pass. Compiler JSON formatting whitespace is collapsed
as the compiler writes it, with backpressure and preserved string contents and
token separators. Engine analysis retains its separate conversion pass because
required system wrappers are selected after declaration analysis.

Project default arguments are recovered from declaration IDs, including inherited
function defaults, method and constructor defaults, and in-class field
initializers. Call-site expansion records unresolved defaults as partial.
Explicit supplied arguments keep their own values. Simple reference captures
use the existing lexical closure binding. Value captures, init-captures and
`this` captures continue to carry partial diagnostics.

Forward goto statements use the existing label/state handling in the C-family
analyzer. Backward or unresolved jumps retain coverage diagnostics. Transparent
Clang wrappers preserve throw statements and their nested calls. String decoding
handles C escapes, UTF-8 and non-UTF-8 bytes, wide strings, and char32_t literals
used as numeric tables. Numeric tables become null-terminated UAST arrays.

Compiler metadata records implicit inline linkage for constexpr/consteval
functions and class-local friend definitions. Identical template definitions can
participate in multiple translation units. Conflicting bodies and ordinary
non-inline repeated definitions remain errors.
