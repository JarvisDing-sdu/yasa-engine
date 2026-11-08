/* eslint-disable @typescript-eslint/no-require-imports */
const CDefaultTaintChecker = require('../c/c-default-taint-checker')

/**
 * C++ 污点分析 checker：与 C 相同的 source/sink 模型与 entrypoint 选择，使用独立的 checkerId，
 * 规则见 rule_config_cpp.json。
 */
class CppDefaultTaintChecker extends CDefaultTaintChecker {
  /**
   * Create the C++ checker with its independent checker identifier.
   * @param resultManager - Finding manager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_cpp_input')
  }

  /**
   * Exclude user namespace functions from standard-library taint rules.
   * @param node - UAST node
   * @param info - Resolved call information
   * @returns {boolean} Resolved analysis value.
   */
  private userFunction(node: any, info: any): boolean {
    const qualifier = node?.callee?._meta?.qualifier
    const ns = info?.fclos?.ast?.fdef?._meta?.namespace
    return !!(
      (ns && ns !== 'std' && !ns.startsWith('std::')) ||
      (qualifier && qualifier !== 'std' && !qualifier.startsWith('std::'))
    )
  }

  /**
   * Apply inherited sink rules only to library calls.
   * @param analyzer - Active analyzer
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @param info - Resolved call information
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (!this.userFunction(node, info)) super.triggerAtFunctionCallBefore(analyzer, scope, node, state, info)
  }

  /**
   * Apply inherited source rules only to library calls.
   * @param analyzer - Active analyzer
   * @param scope - Current runtime scope
   * @param node - UAST node
   * @param state - Analysis state
   * @param info - Resolved call information
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (!this.userFunction(node, info)) super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
  }
}

module.exports = CppDefaultTaintChecker
