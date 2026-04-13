import { CnosDerivedCycleError } from '../errors.js';

export function detectDerivationCycles(
  dependencyMap: Map<string, string[]>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (key: string) => {
    if (visited.has(key)) {
      return;
    }

    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      const cycle = [...stack.slice(start), key].join(' -> ');
      throw new CnosDerivedCycleError(`Derivation cycle detected: ${cycle}`);
    }

    visiting.add(key);
    stack.push(key);

    for (const dependency of dependencyMap.get(key) ?? []) {
      visit(dependency);
    }

    stack.pop();
    visiting.delete(key);
    visited.add(key);
  };

  for (const key of dependencyMap.keys()) {
    visit(key);
  }
}
