export type ConfigSpecValueType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export type ConfigSpecFormat = 'richtext' | 'pem';

export type OverridePrioritySource = 'arg' | 'env' | 'cnos';

export interface OverrideSpec {
  env: string[];
  arg: string[];
  priority: OverridePrioritySource[];
  type?: ConfigSpecValueType;
}

export interface ConfigSpecRule {
  type?: ConfigSpecValueType;
  format?: ConfigSpecFormat;
  /** Environment variable name(s) whose value overrides this key at runtime. */
  env?: string | string[];
  /** CLI flag name(s) (e.g. --port, -p) whose value overrides this key at runtime. */
  arg?: string | string[];
  /** Resolution priority order. Defaults to ["arg", "env", "cnos"]. */
  priority?: OverridePrioritySource[];
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
