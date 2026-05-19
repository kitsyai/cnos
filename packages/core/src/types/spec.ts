export type ConfigSpecValueType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface ConfigSpecRule {
  type?: ConfigSpecValueType;
  required?: boolean;
  enum?: unknown[];
  pattern?: string;
  default?: unknown;
  summary?: string;
  description?: string;
  examples?: unknown[];
  usedBy?: string[];
  deprecated?: boolean;
  deprecationMessage?: string;
}

export type ConfigSpecMap = Record<string, ConfigSpecRule>;

export type SpecDoctorIssueStatus =
  | 'missing_required'
  | 'undeclared'
  | 'type_mismatch'
  | 'enum_mismatch'
  | 'pattern_mismatch'
  | 'default_applied'
  | 'deprecated_in_use';

export interface SpecDoctorIssue {
  key: string;
  status: SpecDoctorIssueStatus;
  expectedType?: ConfigSpecValueType;
  actualType?: string;
  value?: unknown;
  sourceFile?: string;
  summary?: string;
}

export interface SpecDoctorSummary {
  missingRequired: number;
  undeclared: number;
  typeMismatch: number;
  enumMismatch: number;
  patternMismatch: number;
  defaultApplied: number;
  deprecatedInUse: number;
}

export interface SpecDoctorReport {
  workspace: string;
  profile: string;
  summary: SpecDoctorSummary;
  issues: SpecDoctorIssue[];
}
