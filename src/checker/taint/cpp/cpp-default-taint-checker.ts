/* eslint-disable @typescript-eslint/no-require-imports */
const CDefaultTaintChecker = require('../c/c-default-taint-checker')

/**
 * C++ 污点分析 checker：与 C 相同的 source/sink 模型与 entrypoint 选择，使用独立的 checkerId，
 * 规则见 rule_config_cpp.json。
 */
class CppDefaultTaintChecker extends CDefaultTaintChecker {
  /**
   * @param resultManager - 结果管理器
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_cpp_input')
  }
}

module.exports = CppDefaultTaintChecker
