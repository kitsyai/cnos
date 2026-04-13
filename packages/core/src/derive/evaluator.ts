import { CnosDerivedExpressionError, CnosDerivedResolutionError } from '../errors.js';
import type {
  DerivedValue,
  ExprNode,
  ParsedDerivation,
} from '../types/core.js';
import { DERIVE_BUILTINS } from './builtins.js';
import { parseExpression } from './parser.js';
import { parseTemplate } from './templateParser.js';

export function isDerivedValue(value: unknown): value is DerivedValue {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      '$derive' in (value as Record<string, unknown>),
  );
}

function extractRefs(node: ExprNode, refs = new Set<string>()): Set<string> {
  if (node.type === 'ref') {
    refs.add(node.path);
    return refs;
  }

  if (node.type === 'call') {
    for (const arg of node.args) {
      extractRefs(arg, refs);
    }
  }

  return refs;
}

export function parseDerivation(value: DerivedValue): ParsedDerivation {
  const source = typeof value.$derive === 'string' ? value.$derive : value.$derive?.expr;

  if (typeof source !== 'string') {
    throw new CnosDerivedExpressionError('Derived value requires either a template string or { expr } object');
  }

  const type = typeof value.$derive === 'string' ? 'template' : 'expression';
  const ast = type === 'template' ? parseTemplate(source) : parseExpression(source);
  const refs = Array.from(extractRefs(ast)).sort((left, right) => left.localeCompare(right));

  return {
    type,
    raw: source,
    ast,
    refs,
    runtimeRefs: [],
    isRuntimeDependent: false,
  };
}

function normalizeConcatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
}

function evaluateNode(
  node: ExprNode,
  resolveRef: (path: string) => unknown,
): unknown {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'ref':
      return resolveRef(node.path);
    case 'call': {
      const args = node.args.map((arg) => evaluateNode(arg, resolveRef));

      switch (node.name) {
        case 'concat':
          return args.map((value) => normalizeConcatValue(value)).join('');
        case 'coalesce':
          return DERIVE_BUILTINS.coalesce(...args);
        case 'when':
          return DERIVE_BUILTINS.when(args[0], args[1], args[2]);
        case 'exists':
          return DERIVE_BUILTINS.exists(args[0]);
        case 'eq':
          return DERIVE_BUILTINS.eq(args[0], args[1]);
        case 'ne':
          return DERIVE_BUILTINS.ne(args[0], args[1]);
        default:
          throw new CnosDerivedExpressionError(`Unknown derive function: ${String(node.name)}`);
      }
    }
    default:
      throw new CnosDerivedExpressionError(`Unsupported derive AST node ${(node as { type?: string }).type ?? 'unknown'}`);
  }
}

export interface EvaluateDerivationOptions {
  key: string;
  parsed: ParsedDerivation;
  resolveRef: (ref: string) => unknown;
  onMissing?: (ref: string) => void;
}

export function evaluateDerivation(options: EvaluateDerivationOptions): unknown {
  const missingRefs = new Set<string>();

  const value = evaluateNode(options.parsed.ast, (ref) => {
    const resolved = options.resolveRef(ref);

    if (resolved === undefined) {
      missingRefs.add(ref);
      options.onMissing?.(ref);
    }

    return resolved;
  });

  if (missingRefs.size > 0 && options.parsed.ast.type === 'ref') {
    throw new CnosDerivedResolutionError(
      options.key,
      `Unable to resolve derived config key ${options.key} because ${Array.from(missingRefs).join(', ')} is missing.`,
    );
  }

  return value;
}
