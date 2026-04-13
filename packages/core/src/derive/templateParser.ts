import { CnosDerivedExpressionError } from '../errors.js';
import type { ExprNode } from '../types/core.js';

function toLiteral(value: string): ExprNode {
  return {
    type: 'literal',
    value,
  };
}

function toRef(path: string): ExprNode {
  return {
    type: 'ref',
    path,
  };
}

export function parseTemplate(source: string): ExprNode {
  const parts: ExprNode[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf('${', cursor);

    if (start < 0) {
      if (cursor < source.length) {
        parts.push(toLiteral(source.slice(cursor)));
      }
      break;
    }

    if (start > cursor) {
      parts.push(toLiteral(source.slice(cursor, start)));
    }

    const end = source.indexOf('}', start + 2);

    if (end < 0) {
      throw new CnosDerivedExpressionError(`Invalid derivation template: unclosed \${...} at position ${start + 1}`, source);
    }

    const ref = source.slice(start + 2, end).trim();

    if (!ref) {
      throw new CnosDerivedExpressionError(`Invalid derivation template: empty reference at position ${start + 1}`, source);
    }

    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(ref)) {
      throw new CnosDerivedExpressionError(`Invalid derivation template reference "${ref}"`, source);
    }

    parts.push(toRef(ref));
    cursor = end + 1;
  }

  if (parts.length === 0) {
    return toLiteral('');
  }

  if (parts.length === 1) {
    return parts[0]!;
  }

  return {
    type: 'call',
    name: 'concat',
    args: parts,
  };
}
