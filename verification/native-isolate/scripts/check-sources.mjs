import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const lock = JSON.parse(
  readFileSync(new URL('../sources/sources.lock.json', import.meta.url), 'utf8'),
);

assert.ok(Array.isArray(lock.sources) && lock.sources.length > 0, 'sources must be non-empty');
assert.match(lock.reviewTarget.implementationCommit, /^[0-9a-f]{40}$/u);
assert.match(lock.reviewTarget.implementationTree, /^[0-9a-f]{40}$/u);
assert.match(lock.reviewTarget.baseCommit, /^[0-9a-f]{40}$/u);

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const implementation = lock.reviewTarget.implementationCommit;
const expectedTree = git('rev-parse', `${implementation}^{tree}`);
assert.equal(
  expectedTree,
  lock.reviewTarget.implementationTree,
  'implementation tree does not match commit',
);
git('cat-file', '-e', `${lock.reviewTarget.baseCommit}^{commit}`);
git('merge-base', '--is-ancestor', lock.reviewTarget.baseCommit, implementation);

const ids = new Set();
for (const source of lock.sources) {
  assert.equal(typeof source.id, 'string', 'each source needs an ID');
  assert.ok(!ids.has(source.id), `duplicate source ID: ${source.id}`);
  ids.add(source.id);
  assert.ok(source.normativeRole, `missing normativeRole: ${source.id}`);
  assert.equal(
    source.revision,
    lock.reviewTarget.implementationCommit,
    `source is not pinned to the reviewed implementation: ${source.id}`,
  );
  const prefix = `https://github.com/haiprotocol/haip/blob/${source.revision}/`;
  assert.ok(source.url.startsWith(prefix), `source URL is not commit-pinned: ${source.id}`);
  const path = decodeURIComponent(source.url.slice(prefix.length));
  assert.ok(
    path && !path.startsWith('/') && !path.split('/').includes('..'),
    `invalid source path: ${source.id}`,
  );
  assert.equal(
    git('cat-file', '-t', `${source.revision}:${path}`),
    'blob',
    `source blob is missing: ${source.id}`,
  );
}

console.log(`${ids.size} unique, commit-pinned source blobs passed`);
