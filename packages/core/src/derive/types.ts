import type { DerivedValue, ExprNode, ParsedDerivation } from '../types/core.js';

export type { DerivedValue, ExprNode, ParsedDerivation };

export interface DerivationDependencyNode {
  key: string;
  refs: string[];
}
