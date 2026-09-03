import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_REVISION,
  EXECUTION_PROFILE,
  EXECUTION_VERSION,
  type RequestInput,
  type RequestStatus,
  type ClaimInput,
  type ExecutionOutcome,
  type SignedRecord,
  type TrustManifest,
  type Signed,
  type DecisionReceipt,
  type ExecutionClaim,
  type AdmissionStatus,
  type DecisionCandidate,
  type DecisionRequest,
} from '@haip/protocol';
import { canonicalise, digest, digestBytes, parseJson, verifyRecord } from '@haip/protocol/crypto';
export * from '@haip/protocol';
export { verifyWebhook, PostgresWebhookInbox } from './webhooks.js';
export type { VerifiedWebhook, WebhookIdentity, InboxDatabase } from './webhooks.js';
export { canonicalise, digest, digestBytes, verifyRecord };
export class HAIPError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class HAIPClient {
  constructor(
    readonly origin: string,
    private readonly token: string,
    readonly allowLocalHttp = false,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' &&
      !(allowLocalHttp && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      throw new Error('HAIP requires HTTPS');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Expected an origin');
  }
  async request<T>(path: string, body?: unknown, key?: string): Promise<T> {
    if (!path.startsWith('/v2/') && !path.startsWith('/.well-known/'))
      throw new Error('Invalid HAIP path');
    const response = await fetch(this.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: 'Bearer ' + this.token,
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'Idempotency-Key': key ?? randomBytes(16).toString('hex'),
            }),
      },
      ...(body === undefined ? {} : { body: canonicalise(body) }),
    });
    const result = parseJson(await response.text()) as any;
    if (!response.ok) throw new HAIPError(response.status, result.error ?? 'request_failed');
    return result;
  }
  create(input: RequestInput, key: string) {
    return this.request<RequestStatus>('/v2/requests', input, key);
  }
  status(id: string) {
    return this.request<RequestStatus>('/v2/requests/' + encodeURIComponent(id));
  }
  claim(id: string, input: ClaimInput, key: string) {
    return this.request<Signed<ExecutionClaim>>(
      `/v2/requests/${encodeURIComponent(id)}/claims`,
      input,
      key,
    );
  }
  async admission(id: string, claim: Signed<ExecutionClaim>) {
    const nonce = randomBytes(24).toString('base64url'),
      startedMono = performance.now(),
      startedWall = Date.now();
    const record = await this.request<Signed<AdmissionStatus>>(
      `/v2/requests/${encodeURIComponent(id)}/admission`,
      { claim_id: claim.payload.id, execution_identity: claim.payload.execution_identity, nonce },
    );
    return {
      record,
      nonce,
      startedMono,
      startedWall,
      receivedMono: performance.now(),
      receivedWall: Date.now(),
    };
  }
  outcome(id: string, input: ExecutionOutcome, key: string) {
    return this.request<SignedRecord>(
      `/v2/requests/${encodeURIComponent(id)}/outcomes`,
      input,
      key,
    );
  }
  cancel(id: string, key: string) {
    return this.request<RequestStatus>(`/v2/requests/${encodeURIComponent(id)}/cancel`, {}, key);
  }
  events(after = 0) {
    return this.request<{ items: SignedRecord[]; next: number }>(`/v2/events?after=${after}`);
  }
  audit(id: string) {
    return this.request<any>(`/v2/requests/${encodeURIComponent(id)}/export`);
  }
}
export interface AuthorityInput {
  request: DecisionRequest;
  candidate: DecisionCandidate;
  receipt: Signed<DecisionReceipt>;
  claim: Signed<ExecutionClaim>;
  admission: Awaited<ReturnType<HAIPClient['admission']>>;
  material: {
    payload: unknown;
    response_schema: unknown;
    review_document: string;
    bundle?: { html: string };
  };
  trust: TrustManifest;
  issuer: string;
  tenant: string;
  producer: string;
  executionIdentity: string;
  executionBindingDigest: string;
  verifyAnchor: (checkpoint: SignedRecord, acceptance: unknown) => Promise<void>;
}
/** Verifies original objects. A caller still needs a durable, one-use local launch fence. */
export async function verifyExecutionAuthority(input: AuthorityInput) {
  const { request: r, receipt, candidate, claim, admission: a } = input;
  const refuse = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  refuse(
    r.protocol_revision === PROTOCOL_REVISION &&
      r.purpose === 'authorise_execution' &&
      r.profiles[EXECUTION_PROFILE] === EXECUTION_VERSION &&
      r.execution,
    'Execution purpose/profile required',
  );
  refuse(
    r.tenant === input.tenant &&
      r.producer === input.producer &&
      digest(r.execution) === input.executionBindingDigest,
    'Execution binding mismatch',
  );
  const supportedProfiles: Record<string, string> = {
    [EXECUTION_PROFILE]: EXECUTION_VERSION,
    'haip.agent-ui': '2',
  };
  for (const [name, version] of Object.entries(r.profiles))
    refuse(supportedProfiles[name] === version, 'Unsupported required profile');
  refuse(
    r.execution!.provenance.profile === EXECUTION_PROFILE &&
      r.execution!.provenance.version === EXECUTION_VERSION,
    'Unsupported execution provenance',
  );
  for (const [record, type] of [
    [receipt, 'DecisionReceipt'],
    [claim, 'ExecutionClaim'],
    [a.record, 'AdmissionStatus'],
  ] as const) {
    verifyRecord(
      record,
      input.trust,
      {
        issuer: input.issuer,
        audience: input.producer,
        type,
        tenant: input.tenant,
        purpose: 'authorise_execution',
      },
      new Date(a.receivedWall),
    );
    refuse(digest(record.protected.profiles) === digest(r.profiles), 'Profile selection mismatch');
  }
  refuse(
    receipt.payload.request_id === r.id &&
      receipt.payload.request_digest === digest(r) &&
      receipt.payload.purpose === r.purpose &&
      receipt.payload.decision === 'authorise',
    'Decision does not authorise this request',
  );
  refuse(
    receipt.payload.candidate_id === candidate.id &&
      receipt.payload.candidate_digest === digest(candidate) &&
      candidate.request_digest === digest(r) &&
      candidate.reviewer === receipt.payload.reviewer &&
      candidate.decision === 'authorise',
    'Candidate mismatch',
  );
  refuse(
    candidate.request_id === r.id &&
      receipt.payload.requester === r.requester.subject &&
      candidate.response_canonical === canonicalise(candidate.response) &&
      candidate.response_digest === digest(candidate.response) &&
      receipt.payload.response_digest === candidate.response_digest,
    'Response commitment mismatch',
  );
  refuse(
    digest(input.material.payload) === r.review.payload_digest &&
      digest(input.material.response_schema) === r.review.response_schema_digest &&
      digestBytes(input.material.review_document) === r.review.document_digest,
    'Review material mismatch',
  );
  if (r.review.bundle)
    refuse(
      input.material.bundle && digestBytes(input.material.bundle.html) === r.review.bundle.digest,
      'Stored review bundle mismatch',
    );
  refuse(
    claim.payload.request_id === r.id &&
      claim.payload.request_digest === digest(r) &&
      claim.payload.receipt_digest === digest(receipt) &&
      claim.payload.execution_identity === input.executionIdentity &&
      claim.payload.execution_binding_digest === input.executionBindingDigest &&
      claim.payload.action_occurrence_id === r.execution!.action_occurrence_id,
    'Claim mismatch',
  );
  const p = a.record.payload;
  refuse(
    p.nonce === a.nonce &&
      p.claim_id === claim.payload.id &&
      p.claim_digest === digest(claim) &&
      p.request_id === r.id &&
      p.execution_identity === input.executionIdentity &&
      p.execution_binding_digest === input.executionBindingDigest &&
      p.dispatch_before === claim.payload.dispatch_before &&
      p.dispatch_before === receipt.payload.grant_deadline &&
      p.execution_seconds === r.execution!.execution_seconds,
    'Admission mismatch',
  );
  const anchor = p.anchor as any;
  refuse(
    anchor?.checkpoint && anchor?.acceptance && Array.isArray(anchor.proof) && anchor.proof.length,
    'Missing checkpoint proof',
  );
  verifyRecord(anchor.checkpoint, input.trust, {
    issuer: input.issuer,
    audience: 'haip.audit',
    type: 'AuditCheckpoint',
    purpose: 'service',
  });
  refuse(
    anchor.proof[0].record_digest === digest(receipt),
    'Checkpoint does not include the receipt',
  );
  let previous: string | undefined, sequence: number | undefined;
  for (const node of anchor.proof) {
    refuse(
      Number.isSafeInteger(node.sequence) &&
        node.head ===
          digest({
            previous: node.previous_head,
            sequence: node.sequence,
            record_digest: node.record_digest,
          }) &&
        (previous === undefined || node.previous_head === previous) &&
        (sequence === undefined || node.sequence === sequence + 1),
      'Invalid checkpoint chain',
    );
    previous = node.head;
    sequence = node.sequence;
  }
  refuse(
    previous === anchor.checkpoint.payload.head && sequence === anchor.checkpoint.payload.sequence,
    'Checkpoint prefix mismatch',
  );
  await input.verifyAnchor(anchor.checkpoint, anchor.acceptance);
  const checked = Date.parse(p.checked_at),
    dispatch = Date.parse(p.dispatch_before);
  const elapsed = a.receivedMono - a.startedMono,
    wallElapsed = a.receivedWall - a.startedWall;
  refuse(elapsed >= 0 && Math.abs(elapsed - wallElapsed) < 1000, 'Local clock jump');
  // The complete possible server offset interval must fit the tolerance, including round-trip uncertainty.
  refuse(
    checked - a.receivedWall >= -30000 && checked - a.startedWall <= 30000,
    'Clock health outside tolerance',
  );
  refuse(
    receipt.protected.issued_at === receipt.payload.confirmed_at &&
      claim.protected.issued_at === claim.payload.claimed_at &&
      a.record.protected.issued_at === p.checked_at,
    'Protected timestamp mismatch',
  );
  refuse(
    Date.parse(r.accepted_at) <= Date.parse(candidate.created_at) &&
      Date.parse(candidate.created_at) <= Date.parse(receipt.payload.confirmed_at) &&
      Date.parse(receipt.payload.confirmed_at) < Date.parse(r.review_deadline) &&
      Date.parse(receipt.payload.confirmed_at) <= Date.parse(claim.payload.claimed_at) &&
      Date.parse(claim.payload.claimed_at) <= checked &&
      checked < dispatch &&
      dispatch <= Date.parse(r.execution!.valid_until) &&
      dispatch <= Date.parse(receipt.payload.confirmed_at) + r.limits.grant_seconds * 1000 &&
      p.execution_seconds > 0 &&
      p.execution_seconds <= r.limits.execution_seconds &&
      claim.payload.execution_seconds === p.execution_seconds,
    'Invalid authority timeline',
  );
  const deadlineMono = a.startedMono + (dispatch - checked);
  const check = () => {
    const current = performance.now();
    refuse(
      Math.abs(Date.now() - a.startedWall - (current - a.startedMono)) < 1000,
      'Local clock jump',
    );
    refuse(current < deadlineMono, 'Admission expired');
  };
  check();
  return Object.freeze({
    deadlineMono,
    executionSeconds: p.execution_seconds,
    checkBeforeDispatch: check,
  });
}
