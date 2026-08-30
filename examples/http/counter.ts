import { open, readFile, rename, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HAIPClient,
  digest,
  verifyExecutionAuthority,
  type TrustManifest,
  type SignedRecord,
} from '@haip/sdk';
/** Bounded demonstration: one fixed local counter effect. Not a general execution runtime. */
export async function runCounter(options: {
  client: HAIPClient;
  requestId: string;
  directory: string;
  trust: TrustManifest;
  tenant: string;
  producer: string;
  verifyAnchor: (checkpoint: SignedRecord, acceptance: unknown) => Promise<void>;
}) {
  const { client, requestId, directory } = options;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))
    throw new Error('Invalid request identifier');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = 'counter:' + requestId;
  const directoryBinding = join(directory, 'request-id');
  try {
    const binding = await open(directoryBinding, 'wx', 0o600);
    try {
      await binding.writeFile(requestId);
      await binding.sync();
    } finally {
      await binding.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(directoryBinding, 'utf8')) !== requestId)
      throw new Error('Counter directory belongs to another occurrence');
  }
  const fence = join(directory, requestId + '.fence'),
    resultPath = join(directory, requestId + '.result.json');
  const report = async (result: { execution_identity: string; count: number }) =>
    client.outcome(
      requestId,
      {
        execution_identity: result.execution_identity,
        status: 'completed',
        details: { counter: result.count },
      },
      result.execution_identity + ':outcome',
    );
  try {
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    await report(result);
    return result;
  } catch (e) {
    if ((e as any).code !== 'ENOENT') throw e;
  }
  try {
    await stat(fence);
    await client.outcome(
      requestId,
      {
        execution_identity: identity,
        status: 'uncertain',
        details: { reason: 'A launch fence exists without a completed local result' },
      },
      identity + ':uncertain',
    );
    throw new Error('Previous launch is uncertain; reconcile without replay');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const status = await client.status(requestId),
    r = status.request;
  if (
    r.purpose !== 'authorise_execution' ||
    r.execution?.proposal_digest !== digest({ action: 'counter.increment', amount: 1 }) ||
    r.execution.proposal_format !== 'mock-counter-v1' ||
    r.execution.context_digest !== digest({ counter: 'test' }) ||
    r.execution.context_format !== 'mock-context-v1' ||
    r.execution.policy.source !== 'operator' ||
    r.execution.policy.revision !== '1' ||
    r.execution.policy.digest !== digest({ allow: 'counter.increment' }) ||
    r.execution.mode !== 'fixed_mock'
  )
    throw new Error('Only the fixed mock counter action, context and policy are supported');
  const audit = await client.audit(requestId);
  if (!audit.material?.candidate) throw new Error('Retained confirmed response is required');
  const claim = await client.claim(
    requestId,
    { execution_identity: identity, execution_binding_digest: digest(r.execution) },
    identity,
  );
  const admission = await client.admission(requestId, claim);
  const authority = await verifyExecutionAuthority({
    request: r,
    candidate: audit.material.candidate,
    receipt: status.receipt as any,
    claim,
    admission,
    material: audit.material,
    trust: options.trust,
    issuer: client.origin,
    tenant: options.tenant,
    producer: options.producer,
    executionIdentity: identity,
    executionBindingDigest: digest(r.execution),
    verifyAnchor: options.verifyAnchor,
  });
  authority.checkBeforeDispatch();
  // Exclusive durable creation precedes the effect. A crash thereafter is uncertain; never replay.
  const started = performance.now();
  const checkWindow = () => {
    if (performance.now() - started >= authority.executionSeconds * 1000)
      throw new Error('Execution window expired; reconcile without replay');
  };
  const fd = await open(fence, 'wx', 0o600);
  try {
    await fd.writeFile(
      JSON.stringify({ request: r, receipt: status.receipt, claim, admission: admission.record }),
    );
    await fd.sync();
  } finally {
    await fd.close();
  }
  const dir = await open(directory, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  authority.checkBeforeDispatch();
  const counterPath = join(directory, 'counter.json');
  let count = 0;
  try {
    count = JSON.parse(await readFile(counterPath, 'utf8')).count;
  } catch (e) {
    if ((e as any).code !== 'ENOENT') throw e;
  }
  if (!Number.isSafeInteger(count) || count < 0 || count === Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid local counter state; reconcile without replay');
  // Reading state may exhaust admission validity. Check again at the first protected mutation.
  authority.checkBeforeDispatch();
  checkWindow();
  const next = { count: count + 1 };
  const tmp = join(directory, requestId + '.counter.tmp');
  const out = await open(tmp, 'wx', 0o600);
  try {
    await out.writeFile(JSON.stringify(next));
    await out.sync();
  } finally {
    await out.close();
  }
  checkWindow();
  authority.checkBeforeDispatch();
  await rename(tmp, counterPath);
  const effectDir = await open(directory, 'r');
  try {
    await effectDir.sync();
  } finally {
    await effectDir.close();
  }
  const result = { request_id: requestId, execution_identity: identity, count: next.count };
  const saved = await open(resultPath, 'wx', 0o600);
  try {
    await saved.writeFile(JSON.stringify(result));
    await saved.sync();
  } finally {
    await saved.close();
  }
  const resultDir = await open(directory, 'r');
  try {
    await resultDir.sync();
  } finally {
    await resultDir.close();
  }
  await report(result);
  return result;
}
