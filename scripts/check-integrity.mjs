import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const lock = await json('package-lock.json');
for (const [path, item] of Object.entries(lock.packages)) {
  assert(
    !path.includes('node_modules/@aws-sdk/') || item.dev === true,
    'Amazon SDKs are excluded from production dependencies',
  );
  if (path.endsWith('node_modules/@modelcontextprotocol/sdk'))
    assert.equal(item.version, '1.29.0', path);
  if (path.endsWith('node_modules/@modelcontextprotocol/ext-apps'))
    assert.equal(item.version, '1.7.4', path);
}
const server = await json('haip-server/package.json');
assert.equal(server.dependencies['@modelcontextprotocol/ext-apps'], '1.7.4');
assert.equal(server.dependencies['@modelcontextprotocol/sdk'], '1.29.0');
const index = await json('docs/versions.json');
assert.equal(index.current.release_ready, false);
const rules = await json('evaluation/integrity-v1.json');
assert.equal(rules.version, 1);
assert.equal(rules.held_out_answers_in_development, false);
assert.equal(rules.fixture_classification, 'development');
assert.equal(rules.production_catalogues_in_invariant_tests, false);
assert.equal(rules.symbol_generation, 'deterministic_only');
for (const file of await readdir('tests', { recursive: true }))
  if (file.endsWith('.ts')) {
    const source = await readFile('tests/' + file, 'utf8');
    assert(!/plasm-oss\/apis\/|held[_-]out[_-]answers/.test(source), 'Fixture boundary: ' + file);
  }
const schema = await json('protocol/draft-2.0.0-1/schema.json');
const api = await json('protocol/draft-2.0.0-1/openapi.json');
assert.equal(api.openapi, '3.1.0');
assert.equal(api.info.version, '2.0.0-draft.1');
assert(schema.$defs.DecisionRequest && schema.$defs.ExecutionBinding);
assert.deepEqual(await json('docs/protocol/openapi.json'), api);
assert.deepEqual(await json('@types/contracts/openapi.json'), api);
assert.deepEqual(await json('@types/contracts/schema.json'), schema);
console.log('Draft identity, dependency pins and evaluation-integrity checks passed');
