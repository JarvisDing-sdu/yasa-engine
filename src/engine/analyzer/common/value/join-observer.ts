// Only the built-in C call-graph pass installs observers. Keep transient analysis
// state outside Units, so aliases, cloning and serialized values keep their layout.
const identityObservers = new WeakMap<object, () => void>()

export function observeJoinIdentity(unit: object, invalidate: () => void): void {
  identityObservers.set(unit, invalidate)
}

export function invalidateJoinIdentity(unit: object): void {
  identityObservers.get(unit)?.()
}

const parentObservers = new WeakMap<object, () => void>()

export function observeFirstBranchWrite(scope: object, invalidate: () => void): void {
  parentObservers.set(scope, invalidate)
}

export function noteFirstBranchWrite(scope: object): void {
  parentObservers.get(scope)?.()
  parentObservers.delete(scope)
}
