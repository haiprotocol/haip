import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AGENT_UI_LIFECYCLE,
  AGENT_UI_LIMITS,
  AGENT_UI_PROFILE,
  EXECUTION_PROFILE,
  EXECUTION_VERSION,
  PROTOCOL_REVISION,
  RENDERER,
} from '../../../@types/dist/index.js';

const root = new URL('../../../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const text = async (path) => readFile(new URL(path, root), 'utf8');
const schema = await json('protocol/draft-2.0.0-3/schema.json');
const definitions = schema.$defs;

assert.equal(PROTOCOL_REVISION, '2.0.0-draft.3');
assert.equal(definitions.DecisionRequest.properties.protocol_revision.const, PROTOCOL_REVISION);
assert.deepEqual(definitions.DecisionRequest.properties.purpose.enum, [
  'review',
  'authorise_execution',
]);
assert.equal(definitions.DecisionRequest.if.properties.purpose.const, 'authorise_execution');
assert.deepEqual(definitions.DecisionRequest.if.required, ['purpose']);
assert.deepEqual(definitions.DecisionRequest.then.required, ['execution', 'profiles']);
assert.equal(
  definitions.DecisionRequest.then.properties.profiles.properties[EXECUTION_PROFILE].const,
  EXECUTION_VERSION,
);
assert.deepEqual(definitions.DecisionRequest.then.properties.profiles.required, [
  EXECUTION_PROFILE,
]);
assert.equal(definitions.DecisionRequest.else.properties.execution, false);
for (const branch of ['then', 'else']) {
  const bundled = definitions.DecisionRequest[branch];
  assert.deepEqual(bundled.if.properties.review.required, ['bundle']);
  assert.equal(
    bundled.then.properties.profiles.properties['haip.agent-ui'].const,
    RENDERER.agent_ui,
  );
  assert.deepEqual(bundled.then.properties.profiles.required, ['haip.agent-ui']);
}

for (const name of ['AgentUiInitializeParams', 'AgentUiInitializeResult']) {
  const definition = definitions[name];
  assert.equal(definition.additionalProperties, false);
  assert.equal(definition.properties.protocolVersion.const, AGENT_UI_PROFILE);
  assert.equal(definition.properties.capabilities.additionalProperties, false);
  assert.equal(definition.properties.capabilities.properties.localProposal.const, true);
  assert.deepEqual(definition.properties.capabilities.required, ['localProposal']);
}

const constants = (name) =>
  Object.fromEntries(
    Object.entries(definitions[name].properties).map(([key, value]) => [key, value.const]),
  );
assert.deepEqual(constants('AgentUiLimits'), AGENT_UI_LIMITS);
assert.deepEqual(constants('AgentUiLifecycle'), AGENT_UI_LIFECYCLE);
assert.deepEqual(
  [...definitions.AgentUiLimits.required].sort(),
  Object.keys(AGENT_UI_LIMITS).sort(),
);
assert.deepEqual(
  [...definitions.AgentUiLifecycle.required].sort(),
  Object.keys(AGENT_UI_LIFECYCLE).sort(),
);

const references = (name, keyword = 'oneOf') =>
  definitions[name][keyword].map((entry) => entry.$ref.replace('#/$defs/', ''));
assert.deepEqual(references('AgentUiViewToHostMessage'), [
  'AgentUiInitializeRequest',
  'AgentUiInitializedNotification',
  'AgentUiProposeRequest',
  'AgentUiTeardownSuccess',
  'AgentUiError',
]);
assert.deepEqual(references('AgentUiHostToViewMessage'), [
  'AgentUiInitializeSuccess',
  'AgentUiInputNotification',
  'AgentUiResultNotification',
  'AgentUiProposeSuccess',
  'AgentUiTeardownRequest',
  'AgentUiError',
]);
assert.deepEqual(references('AgentUiMessage', 'anyOf'), [
  'AgentUiViewToHostMessage',
  'AgentUiHostToViewMessage',
]);

const methods = {
  AgentUiInitializeRequest: 'haip/ui.initialize',
  AgentUiInitializedNotification: 'haip/ui.initialized',
  AgentUiInputNotification: 'haip/ui.input',
  AgentUiResultNotification: 'haip/ui.result',
  AgentUiProposeRequest: 'haip/ui.propose',
  AgentUiTeardownRequest: 'haip/ui.teardown',
};
for (const [name, method] of Object.entries(methods)) {
  assert.equal(definitions[name].additionalProperties, false);
  assert.equal(definitions[name].properties.method.const, method);
}

const model = await text('verification/native-isolate/quint/composition.qnt');
for (const action of [
  'negotiateSupportedProfile',
  'rejectUnsupportedProfile',
  'bindValidEnvelope',
  'rejectDigestMismatch',
  'initializeUi',
  'notifyUiInitialized',
  'captureInputSnapshot',
  'captureResultSnapshot',
  'requestPropose',
  'returnCorrelatedProposal',
  'beginControlledTeardown',
  'finishControlledTeardown',
  'freezeCandidate',
  'confirmCandidate',
  'authorizeExecution',
  'issueGrant',
  'bindClaim',
  'admit',
  'dispatch',
  'recordOutcome',
])
  assert.match(model, new RegExp(`action ${action}\\b`), `missing model action: ${action}`);

const invariants = await text('verification/native-isolate/quint/haip_spec.qnt');
for (const state of [
  'PURPOSE_REVIEW',
  'PURPOSE_AUTHORISE_EXECUTION',
  'candidateMatchesDisplay',
  'validHumanConfirmation',
  'grantUsable',
  'canAuthorizeExecution',
  'canClaim',
  'canAdmit',
  'canDispatch',
])
  assert.match(invariants, new RegExp(`\\b${state}\\b`), `missing model invariant: ${state}`);

console.log('Draft 3 contract, runtime constants and model transition mapping passed');
