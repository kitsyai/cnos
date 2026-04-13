import { CnosDerivedExpressionError } from '../errors.js';
import type { ExprNode } from '../types/core.js';
import { DERIVE_BUILTINS, type DeriveBuiltinName } from './builtins.js';

interface ParserState {
  source: string;
  index: number;
}

function isWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t';
}

function skipWhitespace(state: ParserState): void {
  while (isWhitespace(state.source[state.index])) {
    state.index += 1;
  }
}

function isIdentifierStart(value: string | undefined): boolean {
  return typeof value === 'string' && /[A-Za-z_]/.test(value);
}

function isIdentifierPart(value: string | undefined): boolean {
  return typeof value === 'string' && /[A-Za-z0-9_.-]/.test(value);
}

function errorAt(state: ParserState, message: string): never {
  throw new CnosDerivedExpressionError(`${message} at position ${state.index + 1}`, state.source);
}

function parseStringLiteral(state: ParserState): ExprNode {
  const quote = state.source[state.index];

  if (quote !== '\'') {
    errorAt(state, 'Expected string literal');
  }

  state.index += 1;
  let value = '';

  while (state.index < state.source.length) {
    const current = state.source[state.index];

    if (current === '\\') {
      const next = state.source[state.index + 1];

      if (next === undefined) {
        errorAt(state, 'Unterminated escape sequence');
      }

      value += next;
      state.index += 2;
      continue;
    }

    if (current === '\'') {
      state.index += 1;
      return {
        type: 'literal',
        value,
      };
    }

    value += current;
    state.index += 1;
  }

  errorAt(state, 'Unterminated string literal');
}

function parseNumberLiteral(state: ParserState): ExprNode {
  const start = state.index;

  while (/[0-9]/.test(state.source[state.index] ?? '')) {
    state.index += 1;
  }

  if (state.source[state.index] === '.') {
    state.index += 1;

    while (/[0-9]/.test(state.source[state.index] ?? '')) {
      state.index += 1;
    }
  }

  return {
    type: 'literal',
    value: Number(state.source.slice(start, state.index)),
  };
}

function parseIdentifier(state: ParserState): string {
  if (!isIdentifierStart(state.source[state.index])) {
    errorAt(state, 'Expected identifier');
  }

  const start = state.index;
  state.index += 1;

  while (isIdentifierPart(state.source[state.index])) {
    state.index += 1;
  }

  return state.source.slice(start, state.index);
}

function parseArguments(state: ParserState): ExprNode[] {
  const args: ExprNode[] = [];
  skipWhitespace(state);

  if (state.source[state.index] === ')') {
    state.index += 1;
    return args;
  }

  while (state.index < state.source.length) {
    args.push(parseExpressionNode(state));
    skipWhitespace(state);

    const current = state.source[state.index];

    if (current === ',') {
      state.index += 1;
      skipWhitespace(state);
      continue;
    }

    if (current === ')') {
      state.index += 1;
      return args;
    }

    errorAt(state, 'Expected "," or ")"');
  }

  errorAt(state, 'Unterminated function call');
}

function parseIdentifierOrCall(state: ParserState): ExprNode {
  const identifier = parseIdentifier(state);
  skipWhitespace(state);

  if (state.source[state.index] === '(') {
    if (!(identifier in DERIVE_BUILTINS)) {
      throw new CnosDerivedExpressionError(`Unknown derive function: ${identifier}`, state.source);
    }

    state.index += 1;
    return {
      type: 'call',
      name: identifier as DeriveBuiltinName,
      args: parseArguments(state),
    };
  }

  if (identifier === 'true' || identifier === 'false') {
    return {
      type: 'literal',
      value: identifier === 'true',
    };
  }

  if (identifier === 'null') {
    return {
      type: 'literal',
      value: null,
    };
  }

  return {
    type: 'ref',
    path: identifier,
  };
}

export function parseExpressionNode(state: ParserState): ExprNode {
  skipWhitespace(state);
  const current = state.source[state.index];

  if (current === '\'') {
    return parseStringLiteral(state);
  }

  if (/[0-9]/.test(current ?? '')) {
    return parseNumberLiteral(state);
  }

  if (isIdentifierStart(current)) {
    return parseIdentifierOrCall(state);
  }

  errorAt(state, 'Unexpected token');
}

export function parseExpression(source: string): ExprNode {
  const state: ParserState = {
    source,
    index: 0,
  };
  const ast = parseExpressionNode(state);
  skipWhitespace(state);

  if (state.index !== source.length) {
    errorAt(state, 'Unexpected trailing input');
  }

  return ast;
}
