import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
const source = JSON.parse(await readFile('protocol/draft-2.0.0-2/schema.json', 'utf8'));
await mkdir('haip-server/schema', { recursive: true });
await copyFile('protocol/draft-2.0.0-2/schema.json', 'haip-server/schema/schema.json');
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
await writeFile(
  '@types/src/generated.ts',
  await compile(schema, 'ProtocolTypes', {
    bannerComment: '/* Generated from protocol/draft-2.0.0-2/schema.json. Run npm run generate. */',
    style: { singleQuote: true, printWidth: 100 },
  }),
);
