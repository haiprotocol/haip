import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_REVISION } from '@haip/protocol';
import { digest } from '@haip/protocol/crypto';
import { CommitWitness } from '../haip-server/src/commit-witness.js';
import { Store } from '../haip-server/src/store.js';
import { postgres } from './fixtures/postgres.js';
import { TestSafetyStore } from './fixtures/safety.js';

test('managed witnesses admit replacement, reject forked commits and fence ambiguous or stale database state', async () => {
  const pg = await postgres();
  const directory = await mkdtemp(join(tmpdir(), 'haip-managed-witness-'));
  const control = new Store(pg.url);
  const databases = new Set<Store>([control]);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const issuer = 'https://review.example.test';
  const signer = {
    issuer,
    keyId: 'fixture-signing',
    signingKey: privateKey,
    trust: {
      issuer,
      protocol_revision: PROTOCOL_REVISION,
      keys: [
        {
          key_id: 'fixture-signing',
          algorithm: 'Ed25519' as const,
          public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          not_before: '2020-01-01T00:00:00Z',
          not_after: '2099-01-01T00:00:00Z',
        },
      ],
    },
  };
  const storage = new TestSafetyStore(directory);
  const incarnation = {
    epoch: randomUUID(),
    deployment: 'fixture-release',
    database: digest('fixture-database'),
  };
  const first = new CommitWitness(storage, signer, incarnation);
  const connect = (database: string) => {
    const url = new URL(pg.url);
    url.pathname = '/' + database;
    const store = new Store(url.href);
    databases.add(store);
    return store;
  };
  const close = async (store: Store) => {
    await store.close();
    databases.delete(store);
  };
  const readFixture = (store: Store, witness: CommitWitness, beforeRead = () => {}) =>
    store.read((tx) =>
      witness.read(tx, async () => {
        beforeRead();
        return (await tx.query('SELECT enabled,material FROM witness_fixture')).rows[0];
      }),
    );
  let release!: () => void;
  const bothChecked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const competing: Promise<unknown>[] = [];
  try {
    await control.pool.query('CREATE DATABASE haip_primary');
    let primary = connect('haip_primary');
    await primary.migrate();
    await primary.pool.query('CREATE TABLE witness_fixture (enabled boolean, material text)');
    await primary.pool.query("INSERT INTO witness_fixture VALUES (true,'private fixture')");
    await primary.transaction('witness', (tx) => first.provision(tx));
    await close(primary);
    await control.pool.query('CREATE DATABASE haip_restored TEMPLATE haip_primary');
    primary = connect('haip_primary');
    const restored = connect('haip_restored');
    const replacement = new CommitWitness(storage, signer, incarnation);
    assert.deepEqual(await readFixture(primary, replacement), {
      enabled: true,
      material: 'private fixture',
    });

    await primary.transaction('witness', (tx) =>
      replacement.write(tx, () =>
        tx.query('UPDATE witness_fixture SET enabled=false,material=NULL'),
      ),
    );
    let disclosure = false;
    await assert.rejects(
      readFixture(restored, replacement, () => {
        disclosure = true;
      }),
      /managed_state_diverged/,
    );
    assert.equal(disclosure, false);
    assert.deepEqual(await readFixture(primary, replacement), { enabled: false, material: null });

    for (const changed of [
      { deployment: 'old-deployment' },
      { database: digest('other-endpoint') },
      { epoch: randomUUID() },
    ]) {
      const other = new CommitWitness(storage, signer, { ...incarnation, ...changed });
      await assert.rejects(readFixture(primary, other), /managed_binding_changed/);
    }

    await close(primary);
    await control.pool.query('CREATE DATABASE haip_fork TEMPLATE haip_primary');
    primary = connect('haip_primary');
    const fork = connect('haip_fork');
    let entered = 0;
    for (const [name, store] of [
      ['primary', primary],
      ['fork', fork],
    ] as const) {
      competing.push(
        store
          .transaction('witness', (tx) =>
            replacement.write(tx, async () => {
              if (++entered === 2) release();
              await bothChecked;
              await tx.query('UPDATE witness_fixture SET material=$1', [name]);
              return store;
            }),
          )
          .catch((error) => {
            release();
            throw error;
          }),
      );
    }
    const results = (await Promise.allSettled(competing)) as PromiseSettledResult<Store>[];
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const winner = results.find((result) => result.status === 'fulfilled')!.value;
    const loser = winner === primary ? fork : primary;
    assert.equal(
      (await loser.pool.query('SELECT material FROM witness_fixture')).rows[0].material,
      null,
    );
    await assert.rejects(readFixture(loser, replacement), /managed_state_diverged/);
    const live = await readFixture(winner, replacement);
    assert(live.material === 'primary' || live.material === 'fork');

    storage.unavailable = true;
    await assert.rejects(readFixture(winner, replacement), /fixture_storage_outage/);
    storage.unavailable = false;
    storage.loseNextWrite = true;
    await assert.rejects(
      winner.transaction('witness', (tx) =>
        replacement.write(tx, () => tx.query("UPDATE witness_fixture SET material='ambiguous'")),
      ),
      /fixture_lost_acknowledgement/,
    );
    assert.equal(
      (await winner.pool.query('SELECT material FROM witness_fixture')).rows[0].material,
      live.material,
    );
    await assert.rejects(
      readFixture(winner, new CommitWitness(storage, signer, incarnation)),
      /managed_state_diverged/,
    );

    await replacement.retire();
    await assert.rejects(readFixture(winner, replacement), /managed_incarnation_retired/);
  } finally {
    release();
    await Promise.allSettled(competing);
    await Promise.all([...databases].map((store) => close(store)));
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});
