import type { InspectorPlugin } from '../types/plugin.js';
import { inspectValue } from '../runtime/inspect.js';

export function createProvenanceInspector(): InspectorPlugin {
  return {
    id: 'provenance',
    kind: 'inspector',
    async inspect(key, graph) {
      return inspectValue(graph, key);
    },
  };
}
