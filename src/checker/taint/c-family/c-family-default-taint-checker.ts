const CDefaultTaintChecker = require('../c/c-default-taint-checker')
const Config = require('../../../config')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint/entrypoint')
const Constant = require('../../../util/constant')

/** Compiler-resolved canonical names distinguish project functions from library models. */
class CFamilyDefaultTaintChecker extends CDefaultTaintChecker {
  /**
   * Register the checker under the opt-in mixed-language identity.
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_c_cpp_input')
  }

  /**
   * Preserve automatic coverage for recursive roots, including recursive main.
   * @param analyzer
   */
  prepareEntryPoints(analyzer: any): void {
    super.prepareEntryPoints(analyzer)
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    for (const closure of analyzer.extraCompilerRoots(this.entryPoints)) {
      const definition = closure.ast.fdef
      const entry = new EntryPoint(Constant.ENGIN_START_FUNCALL)
      entry.scopeVal = closure.parent
      entry.argValues = []
      entry.functionName = definition.id.name
      entry.filePath = definition.loc.sourcefile
      entry.attribute = entry.functionName === 'main' ? 'CMain' : 'CFamilyRecursiveRoot'
      entry.entryPointSymVal = closure
      this.entryPoints.push(entry)
    }
  }
}

module.exports = CFamilyDefaultTaintChecker
