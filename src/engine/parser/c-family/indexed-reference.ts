/** Operators whose read/modify/write is implemented by the shared assignment evaluator. */
export function supportsIndexedAssignment(operator: string): boolean {
  return ['=', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '<<=', '>>='].includes(operator)
}
