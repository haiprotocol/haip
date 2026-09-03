import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { format } from 'prettier';
const draft = JSON.parse(readFileSync('protocol/draft-2.0.0-3/schema.json'));
const schema = Object.fromEntries(
  Object.entries(draft.$defs).map(([name, value]) => [
    name,
    JSON.parse(JSON.stringify(value).replaceAll('#/$defs/', '#/components/schemas/')),
  ]),
);
const operations = [
  ['get', '/.well-known/haip', null, null, 'Supported immutable revisions and profiles'],
  [
    'get',
    '/.well-known/haip-trust',
    null,
    'TrustManifest',
    'Discovery only; never trust included keys automatically',
  ],
  [
    'post',
    '/v2/bundles',
    'BundleRegistration',
    'ReviewBundle',
    'Register a publisher-owned immutable app',
  ],
  ['post', '/v2/requests', 'RequestInput', 'RequestStatus', 'Create one immutable review request'],
  ['get', '/v2/requests', null, null, 'List owned or assigned route requests'],
  [
    'get',
    '/v2/requests/{id}',
    null,
    'RequestStatus',
    'Authoritative state; links are not credentials',
  ],
  [
    'get',
    '/v2/requests/{id}/material',
    null,
    null,
    'Retained payload, schema and canonical review document',
  ],
  [
    'get',
    '/v2/requests/{id}/app',
    null,
    'StoredApp',
    'Stored View bundle with its verified Agent UI envelope and snapshots; authenticated human only',
  ],
  [
    'post',
    '/v2/requests/{id}/assignment',
    null,
    'ReviewClaim',
    'Renew reviewer assignment without authority',
  ],
  [
    'post',
    '/v2/requests/{id}/candidates',
    'DecisionProposal',
    'DecisionCandidate',
    'Freeze a schema-validated response',
  ],
  [
    'post',
    '/v2/requests/{id}/confirm',
    'Confirmation',
    'SignedRecord',
    'Confirm the exact frozen candidate as an authenticated human',
  ],
  [
    'post',
    '/v2/requests/{id}/cancel',
    null,
    'RequestStatus',
    'Cancel unused authority without retracting issued permits',
  ],
  ['post', '/v2/requests/{id}/revoke', null, 'RequestStatus', 'Revoke unused authority'],
  [
    'post',
    '/v2/requests/{id}/remind',
    null,
    null,
    'Queue a reminder at most once per day; supersession preserves the limit',
  ],
  [
    'post',
    '/v2/requests/{id}/discard',
    null,
    'RequestStatus',
    'Delete private material early and block new admission',
  ],
  [
    'post',
    '/v2/requests/{id}/supersede',
    'RequestInput',
    'RequestStatus',
    'Atomically replace unconsumed work',
  ],
  [
    'post',
    '/v2/requests/{id}/claims',
    'ClaimInput',
    'SignedRecord',
    'Consume an exclusive execution occurrence',
  ],
  [
    'post',
    '/v2/requests/{id}/admission',
    'AdmissionInput',
    'SignedRecord',
    'Issue fresh bounded admission; nonces cannot be replayed',
  ],
  [
    'post',
    '/v2/requests/{id}/outcomes',
    'ExecutionOutcome',
    'SignedRecord',
    'Record completion, partial effects or uncertainty',
  ],
  [
    'post',
    '/v2/requests/{id}/reconcile',
    'ExecutionOutcome',
    'SignedRecord',
    'Operator reconciliation with reasons and evidence',
  ],
  [
    'get',
    '/v2/requests/{id}/export',
    null,
    'AuditExport',
    'Export original signed records and retained material',
  ],
  ['get', '/v2/events', null, null, 'Poll producer-owned signed status events'],
  ['get', '/v2/hitl/{id}', null, null, 'HITL v0.8 browser review handoff; pending uses HTTP 202'],
  ['get', '/v2/hitl/{id}/poll', null, null, 'HITL v0.8 authenticated polling'],
  [
    'put',
    '/v2/admin/principals/{id}',
    null,
    null,
    'Operator directory, producer, publisher and credential configuration',
  ],
  [
    'put',
    '/v2/admin/routes/{id}',
    null,
    null,
    'Operator-controlled route configuration and targeted invalidation',
  ],
  ['get', '/v2/admin/ledger', null, null, 'Operator-only paginated complete audit chain'],
];
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const paths = {};
const contracts = {
  '/.well-known/haip': [null, 'Discovery'],
  '/v2/requests': [null, 'RequestList'],
  '/v2/requests/{id}/material': [null, 'Material'],
  '/v2/requests/{id}/app': [null, 'StoredApp'],
  '/v2/requests/{id}/assignment': ['EmptyInput', 'Assignment'],
  '/v2/requests/{id}/remind': ['EmptyInput', 'ReminderResult'],
  '/v2/events': [null, 'EventPage'],
  '/v2/hitl/{id}': [null, 'HitlStatus'],
  '/v2/hitl/{id}/poll': [null, 'HitlPoll'],
  '/v2/admin/principals/{id}': ['PrincipalInput', 'PrincipalResult'],
  '/v2/admin/routes/{id}': ['RouteInput', 'RouteResult'],
  '/v2/admin/ledger': [null, 'LedgerPage'],
  '/v2/admin/metrics': [null, 'MetricsSnapshot'],
};
operations.push([
  'get',
  '/v2/admin/metrics',
  null,
  null,
  'Tenant-scoped operational metrics and incidents',
]);
for (const [method, path, sourceInput, sourceOutput, summary] of operations) {
  const input = sourceInput ?? contracts[path]?.[0] ?? 'EmptyInput';
  const output = path.endsWith('/assignment')
    ? 'Assignment'
    : (sourceOutput ?? contracts[path]?.[1]);
  if (!output) throw new Error('Missing response contract: ' + path);
  const human = /assignment|candidates|confirm|\/app$/.test(path),
    parameters = [];
  if (path.includes('{id}'))
    parameters.push({ in: 'path', name: 'id', required: true, schema: { type: 'string' } });
  if (method === 'get' && ['/v2/events', '/v2/admin/ledger', '/v2/requests'].includes(path))
    parameters.push({
      in: 'query',
      name: path === '/v2/requests' ? 'offset' : 'after',
      schema: { type: 'integer', minimum: 0, maximum: path === '/v2/requests' ? 100000 : 99999999 },
    });
  if (method === 'get' && path === '/v2/requests')
    parameters.push({
      in: 'query',
      name: 'state',
      schema: {
        type: 'string',
        enum: ['', 'pending', 'confirmed', 'cancelled', 'expired', 'superseded'],
      },
    });
  if (method === 'post' && !path.endsWith('admission'))
    parameters.push({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', minLength: 1, maxLength: 160 },
    });
  if (human && method === 'post')
    parameters.push(
      { in: 'header', name: 'X-CSRF-Token', required: true, schema: { type: 'string' } },
      { in: 'header', name: 'Origin', required: true, schema: { type: 'string', format: 'uri' } },
    );
  const status =
    method === 'post' && /\/requests$|\/bundles$|\/candidates$|\/claims$|\/supersede$/.test(path)
      ? '201'
      : '200';
  const op = {
    operationId: method + '_' + path.replace(/[^a-zA-Z0-9]/g, '_'),
    summary,
    security: path.startsWith('/.well-known')
      ? []
      : human
        ? [{ humanSession: [] }]
        : [{ producerBearer: [] }, { humanSession: [] }],
    parameters,
    responses: {
      [status]: {
        description: 'Success',
        content: { 'application/json': { schema: ref(output) } },
      },
      400: { description: 'Invalid or ambiguous input' },
      401: { description: 'Authentication required' },
      403: { description: 'Operation not permitted' },
      404: { description: 'Resource not found or inaccessible' },
      409: { description: 'State, ownership or idempotency conflict' },
      410: { description: 'Private material deleted' },
      413: { description: 'Uncompressed size limit' },
      422: { description: 'Unsupported purpose/profile/renderer' },
      429: { description: 'Captured quota exceeded' },
      503: { description: 'Required authority, storage or identity unavailable' },
    },
  };
  if (method === 'post' || method === 'put')
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: ref(input) } },
    };
  if (path === '/v2/hitl/{id}') op.responses['202'] = { description: 'Human review pending' };
  (paths[path] ??= {})[method] = op;
}
paths['/v2/admin/metrics.prom'] = {
  get: {
    operationId: 'get_v2_admin_metrics_prom',
    summary: 'Operator-scoped Prometheus metrics',
    security: [{ producerBearer: [] }],
    responses: {
      200: { description: 'Metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
      401: { description: 'Authentication required' },
      403: { description: 'Operator required' },
    },
  },
};
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'HAIP — Human-Agent Interaction Protocol',
    version: '2.0.0-draft.3',
    description:
      'Draft portable review contract and execution extension. No HAIP 1 compatibility. Implementation ledger lists incomplete release gates.',
    license: { name: 'MIT', identifier: 'MIT' },
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  paths,
  components: {
    schemas: schema,
    securitySchemes: {
      producerBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Separately provisioned machine credential; no human confirmation authority',
      },
      humanSession: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-haip',
        description: 'OIDC server-side session; mutations also require CSRF and exact Origin',
      },
    },
  },
};
const output = await format(JSON.stringify(spec), {
  parser: 'json',
  singleQuote: true,
  printWidth: 100,
});
writeFileSync('protocol/draft-2.0.0-3/openapi.json', output);
writeFileSync('docs/protocol/openapi.json', output);
cpSync('protocol/draft-2.0.0-3', '@types/contracts', { recursive: true });
