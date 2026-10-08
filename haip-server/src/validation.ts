import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { requireThat } from './errors.js';
export { validateResponseSchema } from './schema-validator.js';
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
