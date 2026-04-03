export interface SchemaRule {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  enum?: unknown[];
  pattern?: string;
  default?: unknown;
}
