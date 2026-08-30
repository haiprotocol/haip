import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { requireThat } from './errors.js';
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  validateFormats: true,
  ownProperties: true,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const schema = JSON.parse(readFileSync(new URL('../schema/schema.json', import.meta.url), 'utf8'));
ajv.addSchema(schema);
export function validate(name: string, input: unknown): void {
  const check = ajv.getSchema(schema.$id + '#/$defs/' + name)!;
  requireThat(check(input), 400, 'invalid_' + name);
}
export function validateResponseSchema(
  schema: unknown,
  response?: unknown,
  checkResponse = false,
): void {
  let nodes = 0;
  const walk = (v: unknown, depth: number): void => {
    requireThat(++nodes < 10000 && depth < 32, 400, 'schema_complexity');
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      requireThat(
        !['$dynamicRef', '$recursiveRef', '$id', '$async'].includes(k),
        400,
        'unsupported_schema_reference',
      );
      if (k === '$ref')
        requireThat(typeof x === 'string' && x.startsWith('#/'), 400, 'remote_schema_reference');
      // Patterns are excluded from the initial profile to avoid untrusted regular-expression execution.
      requireThat(
        !['pattern', 'patternProperties', 'format'].includes(k),
        400,
        'unsupported_schema_keyword',
      );
      // Schema maps contain user field names, which are not themselves schema keywords.
      if (
        ['properties', '$defs', 'definitions', 'dependentSchemas'].includes(k) &&
        x &&
        typeof x === 'object'
      ) {
        for (const child of Object.values(x)) walk(child, depth + 1);
      } else if (!['const', 'enum', 'default', 'examples'].includes(k)) walk(x, depth + 1);
    }
  };
  walk(schema, 0);
  try {
    const check = new Ajv2020({ strict: true, allErrors: false, ownProperties: true }).compile(
      schema as object,
    );
    if (checkResponse) requireThat(check(response), 400, 'response_schema_mismatch');
  } catch (e) {
    if (e instanceof Error && e.message === 'response_schema_mismatch') throw e;
    requireThat(false, 400, 'invalid_response_schema');
  }
}
