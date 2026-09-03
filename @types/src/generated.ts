/* Generated from protocol/draft-2.0.0-2/schema.json. Run npm run generate. */

export type LedgerPage = LedgerEntry[];
export type HitlPoll =
  | {
      case_id: string;
      status: 'pending' | 'cancelled' | 'expired';
      created_at: string;
      expires_at: string;
    }
  | {
      case_id: string;
      status: 'completed';
      completed_at: string;
      result: {
        action: string;
        data: {
          response: unknown;
          haip_receipt: SignedRecord;
          audit_state: string;
          material_available: boolean;
        };
      };
    };
export type HitlStatus =
  | HitlPoll
  | {
      status: 'human_input_required';
      hitl: {
        spec_version: '0.8';
        case_id: string;
        review_url: string;
        poll_url: string;
        type: 'input';
        prompt: string;
        timeout: string;
        default_action: 'cancel';
        created_at: string;
        expires_at: string;
      };
    };
export type AgentUiErrorCode = -32600 | -32601 | -32602 | -32000;
export type AgentUiMessage = AgentUiRequest | AgentUiNotification | AgentUiSuccess | AgentUiError;

export interface ProtocolTypes {
  Profiles?: Profiles;
  Metadata?: Metadata;
  AgentUiCompatibility?: AgentUiCompatibility;
  Limits?: Limits;
  ExecutionBinding?: ExecutionBinding;
  ReviewBinding?: ReviewBinding;
  ReviewBundle?: ReviewBundle;
  BundleRegistration?: BundleRegistration;
  RequestInput?: RequestInput;
  DecisionRequest?: DecisionRequest;
  DecisionProposal?: DecisionProposal;
  DecisionCandidate?: DecisionCandidate;
  DecisionReceipt?: DecisionReceipt;
  ReviewClaim?: ReviewClaim;
  ExecutionClaim?: ExecutionClaim;
  ClaimInput?: ClaimInput;
  AdmissionStatus?: AdmissionStatus;
  ExecutionOutcome?: ExecutionOutcome;
  RequestChangedEvent?: RequestChangedEvent;
  RequestStatus?: RequestStatus;
  TrustManifest?: TrustManifest;
  SignedRecord?: SignedRecord;
  AuditExport?: AuditExport;
  ReviewRoute?: ReviewRoute;
  EmptyInput?: EmptyInput;
  Confirmation?: Confirmation;
  AdmissionInput?: AdmissionInput;
  Discovery?: Discovery;
  Assignment?: Assignment;
  RequestList?: RequestList;
  Material?: Material;
  StoredApp?: StoredApp;
  ReminderResult?: ReminderResult;
  EventPage?: EventPage;
  DeliveryStatus?: DeliveryStatus;
  AnchorAcceptance?: AnchorAcceptance;
  AnchorProof?: AnchorProof;
  WebhookDelivery?: WebhookDelivery;
  PrincipalInput?: PrincipalInput;
  PrincipalResult?: PrincipalResult;
  RouteInput?: RouteInput;
  RouteResult?: RouteResult;
  LedgerEntry?: LedgerEntry;
  LedgerPage?: LedgerPage;
  HitlPoll?: HitlPoll;
  HitlStatus?: HitlStatus;
  MetricsSnapshot?: MetricsSnapshot;
  AgentUiRequestIdentity?: AgentUiRequestIdentity;
  AgentUiBundleIdentity?: AgentUiBundleIdentity;
  AgentUiSource?: AgentUiSource;
  AgentUiSnapshotDigests?: AgentUiSnapshotDigests;
  AgentUiEnvelope?: AgentUiEnvelope;
  AgentUiInput?: AgentUiInput;
  AgentUiResult?: AgentUiResult;
  AgentUiInitializeParams?: AgentUiInitializeParams;
  AgentUiInitializeResult?: AgentUiInitializeResult;
  AgentUiTeardownResult?: AgentUiTeardownResult;
  AgentUiViewFailedParams?: AgentUiViewFailedParams;
  AgentUiErrorCode?: AgentUiErrorCode;
  AgentUiRequest?: AgentUiRequest;
  AgentUiNotification?: AgentUiNotification;
  AgentUiSuccess?: AgentUiSuccess;
  AgentUiError?: AgentUiError;
  AgentUiMessage?: AgentUiMessage;
  AgentUiProposeParams?: AgentUiProposeParams;
  AgentUiProposeResult?: AgentUiProposeResult;
}
export interface Profiles {
  [k: string]: string;
}
export interface Metadata {
  [k: string]: unknown;
}
export interface AgentUiCompatibility {
  agent_ui: '1';
  [k: string]: unknown;
}
export interface Limits {
  bundle_bytes: number;
  payload_bytes: number;
  response_bytes: number;
  inline_result_bytes: number;
  retained_bytes: number;
  review_seconds: number;
  grant_seconds: number;
  execution_seconds: number;
  reconciliation_seconds: number;
  audit_seconds: number;
}
export interface ExecutionBinding {
  action_occurrence_id: string;
  proposal_digest: string;
  proposal_format: string;
  context_digest: string;
  context_format: string;
  policy: {
    source: string;
    revision: string;
    digest: string;
  };
  mode: 'live_window' | 'durable' | 'fixed_mock';
  valid_until: string;
  execution_seconds: number;
  provenance: {
    profile: string;
    version: string;
    references: Metadata;
  };
  recovery_of?: string;
}
export interface ReviewBinding {
  artefact_digest: string;
  representation: string;
  digest_rules: string;
  payload_digest: string;
  response_schema_digest: string;
  document_digest: string;
  bundle?: {
    id: string;
    publisher: string;
    digest: string;
    compatibility: AgentUiCompatibility;
  };
}
export interface ReviewBundle {
  id: string;
  tenant: string;
  publisher: string;
  digest: string;
  compatibility: AgentUiCompatibility;
  author: string;
  licence: string;
  created_at: string;
}
export interface BundleRegistration {
  html: string;
  compatibility: AgentUiCompatibility;
  author: string;
  licence: string;
}
export interface RequestInput {
  protocol_revision: '2.0.0-draft.2';
  purpose: 'review' | 'authorise_execution';
  profiles: Profiles;
  route: string;
  summary: string;
  artefact: {
    digest: string;
    representation: string;
    digest_rules: string;
  };
  payload: unknown;
  response_schema: {
    [k: string]: unknown;
  };
  review_document: string;
  bundle_id?: string;
  execution?: ExecutionBinding;
  review_seconds?: number;
  metadata?: Metadata;
}
export interface DecisionRequest {
  id: string;
  protocol_revision: '2.0.0-draft.2';
  purpose: 'review' | 'authorise_execution';
  profiles: Profiles;
  tenant: string;
  producer: string;
  requester: {
    subject: string;
    source: string;
  };
  route: string;
  authorisation_revision: number;
  summary: string;
  review: ReviewBinding;
  execution?: ExecutionBinding;
  limits: Limits;
  accepted_at: string;
  review_deadline: string;
  private_delete_at: string;
  audit_delete_at: string;
  metadata: Metadata;
  supersedes?: string;
  /**
   * Immutable service execution namespace. Retired namespaces cannot admit execution.
   */
  authority_namespace?: string;
}
export interface DecisionProposal {
  response: unknown;
  decision: 'answer' | 'approve' | 'reject' | 'authorise' | 'refuse';
}
export interface DecisionCandidate {
  id: string;
  request_id: string;
  request_digest: string;
  reviewer: string;
  revision: number;
  response: unknown;
  response_canonical: string;
  response_digest: string;
  decision: 'answer' | 'approve' | 'reject' | 'authorise' | 'refuse';
  created_at: string;
}
export interface DecisionReceipt {
  purpose: 'review' | 'authorise_execution';
  request_id: string;
  request_digest: string;
  candidate_id: string;
  candidate_digest: string;
  reviewer: string;
  requester: string;
  response_digest: string;
  decision: 'answer' | 'approve' | 'reject' | 'authorise' | 'refuse';
  confirmed_at: string;
  grant_deadline?: string;
}
export interface ReviewClaim {
  id: string;
  request_id: string;
  reviewer: string;
  expires_at: string;
}
export interface ExecutionClaim {
  id: string;
  request_id: string;
  request_digest: string;
  receipt_digest: string;
  execution_identity: string;
  action_occurrence_id: string;
  execution_binding_digest: string;
  claimed_at: string;
  dispatch_before: string;
  execution_seconds: number;
}
export interface ClaimInput {
  execution_identity: string;
  execution_binding_digest: string;
}
export interface AdmissionStatus {
  claim_id: string;
  claim_digest: string;
  request_id: string;
  execution_identity: string;
  execution_binding_digest: string;
  checked_at: string;
  dispatch_before: string;
  execution_seconds: number;
  nonce: string;
  anchor: Metadata;
}
export interface ExecutionOutcome {
  execution_identity: string;
  status:
    | 'completed'
    | 'failed'
    | 'failed_partial'
    | 'uncertain'
    | 'cancelled_before_dispatch'
    | 'abandoned';
  details: Metadata;
}
export interface RequestChangedEvent {
  event_id: string;
  type: 'haip.request.changed';
  request_id: string;
  revision: number;
  reason: string;
  state: Metadata;
  deadline: string;
  status_ref: string;
}
export interface RequestStatus {
  request: DecisionRequest;
  request_digest: string;
  decision_state: 'pending' | 'confirmed' | 'cancelled' | 'superseded' | 'expired';
  audit_state: 'unanchored' | 'pending' | 'anchored' | 'conflict';
  grant_state:
    'not_applicable' | 'none' | 'pending_anchor' | 'available' | 'expired' | 'revoked' | 'consumed';
  execution_state:
    | 'not_applicable'
    | 'unclaimed'
    | 'claimed'
    | 'admitted'
    | 'completed'
    | 'failed'
    | 'failed_partial'
    | 'uncertain'
    | 'cancelled_before_dispatch'
    | 'abandoned';
  revision: number;
  receipt: SignedRecord | null;
  claim: SignedRecord | null;
  outcome: SignedRecord | null;
  anchor: AnchorProof | null;
  delivery: DeliveryStatus[];
  review_link: string;
  polling_link: string;
}
export interface SignedRecord {
  protected: {
    type: string;
    protocol_revision: string;
    purpose: 'review' | 'authorise_execution' | 'service';
    profiles: Profiles;
    issuer: string;
    audience: string;
    tenant: string;
    key_id: string;
    issued_at: string;
  };
  payload: unknown;
  signature: string;
}
export interface AnchorProof {
  checkpoint: SignedRecord;
  acceptance: AnchorAcceptance;
  proof: {
    sequence: number;
    previous_head: string;
    record_digest: string;
    head: string;
  }[];
}
export interface AnchorAcceptance {
  backend: string;
  key: string;
  version_id: string;
  digest: string;
  retained_until: string;
}
export interface DeliveryStatus {
  id: string;
  kind: 'smtp' | 'webhook' | 'checkpoint';
  state: 'pending' | 'accepted' | 'failed' | 'expired';
  attempts: number;
  error: string | null;
}
export interface TrustManifest {
  issuer: string;
  protocol_revision: '2.0.0-draft.2';
  /**
   * @minItems 1
   * @maxItems 128
   */
  keys: [
    {
      key_id: string;
      algorithm: 'Ed25519';
      public_key: string;
      not_before: string;
      not_after: string;
      revoked_at?: string;
    },
    ...{
      key_id: string;
      algorithm: 'Ed25519';
      public_key: string;
      not_before: string;
      not_after: string;
      revoked_at?: string;
    }[]
  ];
}
export interface AuditExport {
  request: DecisionRequest;
  request_digest: string;
  records: SignedRecord[];
  audit: unknown[];
  anchor: unknown;
  material: unknown;
  verification: string;
}
export interface ReviewRoute {
  id: string;
  revision: number;
  separation_of_duties: boolean;
  reviewers: string[];
  limits: Limits;
  required_profiles: Profiles;
}
export interface EmptyInput {}
export interface Confirmation {
  candidate_id: string;
  candidate_digest: string;
}
export interface AdmissionInput {
  claim_id: string;
  nonce: string;
  execution_identity: string;
}
export interface Discovery {
  name: string;
  revisions: string[];
  profiles: Profiles;
  renderer: {
    agent_ui: string;
  };
  mode: 'development' | 'production';
  release_ready: boolean;
  execution_admission: string;
  notifications: 'smtp' | 'polling-only';
}
export interface Assignment {
  id: string;
  reviewer: string;
  expires_at: string;
}
/**
 * A page of visible request summaries, without an exact total count.
 */
export interface RequestList {
  /**
   * @maxItems 50
   */
  items: {
    id: string;
    summary: string;
    deadline: string;
    decision: 'pending' | 'confirmed' | 'cancelled' | 'superseded' | 'expired';
    audit: 'unanchored' | 'pending' | 'anchored' | 'conflict';
    grant:
      | 'not_applicable'
      | 'none'
      | 'pending_anchor'
      | 'available'
      | 'expired'
      | 'revoked'
      | 'consumed';
    execution:
      | 'not_applicable'
      | 'unclaimed'
      | 'claimed'
      | 'admitted'
      | 'completed'
      | 'failed'
      | 'failed_partial'
      | 'uncertain'
      | 'cancelled_before_dispatch'
      | 'abandoned';
    assignment: Assignment | null;
  }[];
  /**
   * Next page offset, or null when no further page is available within the offset limit.
   */
  next_offset: number | null;
}
export interface Material {
  request: DecisionRequest;
  request_digest: string;
  payload: unknown;
  response_schema: unknown;
  review_document: string;
  candidate: DecisionCandidate | null;
}
export interface StoredApp {
  profile: 'org.haiprotocol.agent-ui/1';
  protocol_revision: '2.0.0-draft.2';
  request: AgentUiRequestIdentity;
  bundle: AgentUiBundleIdentity;
  source: AgentUiSource;
  snapshots: AgentUiSnapshotDigests;
  binding_digest: string;
  html: string;
  origin: string;
  scope: string;
  input: AgentUiInput;
  result: AgentUiResult;
}
export interface AgentUiRequestIdentity {
  id: string;
  digest: string;
  purpose: 'review' | 'authorise_execution';
  authorisation_revision: number;
  supersedes: string | null;
}
export interface AgentUiBundleIdentity {
  id: string;
  publisher: string;
  digest: string;
  created_at: string;
}
export interface AgentUiSource {
  tenant: string;
  producer: string;
  requester: {
    subject: string;
    source: string;
  };
  origin: string;
}
export interface AgentUiSnapshotDigests {
  input_digest: string;
  result_digest: string;
}
export interface AgentUiInput {
  request_id: string;
  purpose: 'review' | 'authorise_execution';
}
export interface AgentUiResult {
  content: {
    type: 'text';
    text: string;
  }[];
  structuredContent?: {
    payload: unknown;
  };
}
export interface ReminderResult {
  request_id: string;
  notification: 'queued' | 'polling-only';
}
export interface EventPage {
  items: SignedRecord[];
  next: number;
}
export interface WebhookDelivery {
  delivery_id: string;
  event_id: string;
  timestamp: string;
  event: SignedRecord;
}
export interface PrincipalInput {
  id: string;
  kind: 'producer' | 'publisher' | 'human';
  token?: string;
  config: {
    enabled: boolean;
    identity_certain?: boolean;
    publisher?: string;
    routes?: string[];
    owner?: string;
    oidc_issuer?: string;
    oidc_subject?: string;
    email?: string;
    email_verified?: boolean;
    webhook?: string;
    [k: string]: unknown;
  };
}
export interface PrincipalResult {
  id: string;
  kind: 'producer' | 'publisher' | 'human';
}
export interface RouteInput {
  reviewers: string[];
  separation_of_duties: boolean;
  limits: Limits;
  required_profiles: Profiles;
  allowed_producers: string[];
  modes: string[];
}
export interface RouteResult {
  id: string;
  revision: number;
  config: RouteInput;
}
export interface LedgerEntry {
  tenant: string;
  sequence: string;
  request_id: string | null;
  previous_head: string;
  head: string;
  record_digest: string;
  record: string | null;
  created_at: string;
}
export interface MetricsSnapshot {
  admission_fenced: boolean;
  requests: {
    [k: string]: number;
  };
  enabled_reviewers: number;
  pending_per_reviewer: number | null;
  delivery: {
    kind: string;
    state: string;
    count: number;
    oldest_seconds: number;
  }[];
  incidents: {
    id: string;
    code: string;
    created_at: string;
  }[];
  operations: {
    name: string;
    succeeded_at: string | null;
    failed_at: string | null;
  }[];
  http_since_process_start: {
    total: number;
    failures: number;
    conflicts: number;
  };
  policy_and_executor_evidence: string;
}
export interface AgentUiEnvelope {
  profile: 'org.haiprotocol.agent-ui/1';
  protocol_revision: '2.0.0-draft.2';
  request: AgentUiRequestIdentity;
  bundle: AgentUiBundleIdentity;
  source: AgentUiSource;
  snapshots: AgentUiSnapshotDigests;
  binding_digest: string;
}
export interface AgentUiInitializeParams {
  protocolVersion: 'org.haiprotocol.agent-ui/1';
  capabilities: {
    localProposal: true;
  };
  viewInfo?: {
    name: string;
    version: string;
  };
}
export interface AgentUiInitializeResult {
  protocolVersion: 'org.haiprotocol.agent-ui/1';
  capabilities: {
    localProposal: true;
  };
  hostInfo: {
    name: string;
    version: string;
  };
  envelope: AgentUiEnvelope;
}
export interface AgentUiTeardownResult {
  closed: true;
}
export interface AgentUiViewFailedParams {
  reason: string;
}
export interface AgentUiRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: 'haip/ui.initialize' | 'haip/ui.propose' | 'haip/ui.teardown';
  params?: unknown;
}
export interface AgentUiNotification {
  jsonrpc: '2.0';
  method:
    | 'haip/ui.initialized'
    | 'haip/ui.input'
    | 'haip/ui.result'
    | 'haip/ui.proxyReady'
    | 'haip/ui.resourceReady'
    | 'haip/ui.viewFailed';
  params?: unknown;
}
export interface AgentUiSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: {
    [k: string]: unknown;
  };
}
export interface AgentUiError {
  jsonrpc: '2.0';
  id: string | number;
  error: {
    code: AgentUiErrorCode;
    message: string;
  };
}
export interface AgentUiProposeParams {
  response: unknown;
  decision: 'answer' | 'approve' | 'reject' | 'authorise' | 'refuse';
}
export interface AgentUiProposeResult {
  candidate_id: string;
  status: 'awaiting_human_confirmation';
}
