import { CnosManifestError } from '../errors.js';
import type {
  DocumentFieldRule,
  DocumentSchemaDefinition,
  DocumentSchemaInput,
  NormalizedVarSourceDefinition,
  VarFetchMode,
  VarGroupDefinition,
  VarSourceDefinition,
  VarTransport,
} from '../types/var.js';

const VAR_TRANSPORTS: readonly VarTransport[] = ['rpc', 'http', 'ws', 'sse'];
const VAR_FETCH_MODES: readonly VarFetchMode[] = ['prefetch', 'ondemand'];
const DOCUMENT_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

function normalizeAuthMap(name: string, auth: unknown): Record<string, string> {
  if (auth === undefined || auth === null) {
    return {};
  }

  if (typeof auth !== 'object' || Array.isArray(auth)) {
    throw new CnosManifestError(`varSource "${name}" auth must be a map of secret references.`);
  }

  return Object.fromEntries(
    Object.entries(auth as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([slot, ref]) => [slot.trim(), ref.trim()] as const)
      .filter(([slot, ref]) => slot.length > 0 && ref.length > 0),
  );
}

export function normalizeVarSources(
  sources?: Record<string, VarSourceDefinition>,
): Record<string, NormalizedVarSourceDefinition> {
  return Object.fromEntries(
    Object.entries(sources ?? {}).map(([name, definition]) => {
      const transport = definition?.transport;

      if (!transport || !VAR_TRANSPORTS.includes(transport)) {
        throw new CnosManifestError(
          `varSource "${name}" requires transport to be one of ${VAR_TRANSPORTS.join(', ')}.`,
        );
      }

      const url = definition.url?.trim();

      if (!url) {
        throw new CnosManifestError(`varSource "${name}" requires a url.`);
      }

      const pollInterval = definition.pollInterval?.trim();
      const verify = definition.verify?.trim();

      return [
        name,
        {
          transport,
          url,
          auth: normalizeAuthMap(name, definition.auth),
          ...(pollInterval ? { pollInterval } : {}),
          ...(verify ? { verify } : {}),
        } satisfies NormalizedVarSourceDefinition,
      ];
    }),
  );
}

export function normalizeVars(
  vars?: Record<string, VarGroupDefinition>,
): Record<string, VarGroupDefinition> {
  return Object.fromEntries(
    Object.entries(vars ?? {}).map(([group, definition]) => {
      const source = definition?.source?.trim();

      if (!source) {
        throw new CnosManifestError(`var group "${group}" requires a source.`);
      }

      const mode = definition.mode ?? 'ondemand';

      if (!VAR_FETCH_MODES.includes(mode)) {
        throw new CnosManifestError(
          `var group "${group}" mode must be one of ${VAR_FETCH_MODES.join(', ')}.`,
        );
      }

      const ttl = definition.ttl?.trim();
      const lease = definition.lease?.trim();

      return [
        group,
        {
          source,
          mode,
          ...(ttl ? { ttl } : {}),
          ...(lease ? { lease } : {}),
        } satisfies VarGroupDefinition,
      ];
    }),
  );
}

function normalizeDocumentField(
  schemaId: string,
  field: string,
  rule: DocumentFieldRule,
): DocumentFieldRule {
  if (!rule || typeof rule !== 'object') {
    throw new CnosManifestError(`Document "${schemaId}" field "${field}" must be an object.`);
  }

  if (!rule.type || !DOCUMENT_FIELD_TYPES.has(rule.type)) {
    throw new CnosManifestError(
      `Document "${schemaId}" field "${field}" requires type to be one of ${Array.from(DOCUMENT_FIELD_TYPES).join(', ')}.`,
    );
  }

  return {
    type: rule.type,
    ...(rule.required !== undefined ? { required: rule.required } : {}),
    ...(rule.enum !== undefined ? { enum: rule.enum } : {}),
    ...(rule.pattern !== undefined ? { pattern: rule.pattern } : {}),
  };
}

export function normalizeDocuments(
  documents?: Record<string, DocumentSchemaInput>,
): Record<string, DocumentSchemaDefinition> {
  return Object.fromEntries(
    Object.entries(documents ?? {}).map(([schemaId, definition]) => {
      const fields = Object.fromEntries(
        Object.entries(definition?.fields ?? {}).map(([field, rule]) => [
          field,
          normalizeDocumentField(schemaId, field, rule),
        ]),
      );

      return [
        schemaId,
        {
          fields,
          additionalProperties: definition?.additionalProperties ?? false,
        } satisfies DocumentSchemaDefinition,
      ];
    }),
  );
}
