import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
import { format } from 'prettier';
const source = JSON.parse(await readFile('protocol/draft-2.0.0-3/schema.json', 'utf8'));
await mkdir('haip-server/schema', { recursive: true });
await copyFile('protocol/draft-2.0.0-3/schema.json', 'haip-server/schema/schema.json');
const definitions = JSON.parse(
  JSON.stringify(source.$defs).replaceAll('#/$defs/', '#/definitions/'),
);
for (const [name, def] of Object.entries(definitions)) def.title = name;
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    Object.keys(definitions).map((name) => [name, { $ref: '#/definitions/' + name }]),
  ),
  definitions,
};
let declarations = await compile(schema, 'ProtocolTypes', {
  bannerComment: '/* Generated from protocol/draft-2.0.0-3/schema.json. Run npm run generate. */',
  style: { singleQuote: true, printWidth: 100 },
});
for (const name of [
  'AgentUiInitializedParams',
  'AgentUiTeardownParams',
  'AgentUiProxyReadyParams',
]) {
  const permissive = `export interface ${name} {}`;
  if (!declarations.includes(permissive)) throw new Error(`Missing generated ${name}`);
  declarations = declarations.replace(permissive, `export type ${name} = Record<string, never>;`);
}
await writeFile(
  '@types/src/generated.ts',
  await format(declarations, { parser: 'typescript', singleQuote: true, printWidth: 100 }),
);
