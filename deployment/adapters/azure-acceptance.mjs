import {
  AzureCliCredential,
  ClientSecretCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

export const managementOrigin = 'https://management.azure.com';
export const graphOrigin = 'https://graph.microsoft.com';
export const storageVersion = '2025-08-01';
export const uuidPattern = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
export const uuid = new RegExp(`^${uuidPattern}$`, 'i');
export const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
export const regionName = (value) =>
  typeof value === 'string' && value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function storageTarget(plan, settings) {
  const deployment = plan.deployment;
  const component = deployment.components.find((item) => item.kind === 'anchor');
  const { account, resource_group, subscription_id, tenant_id, runtime_client_id } = settings;
  const { anchor_prefix, runtime_credential, checkpoint, safety } = settings;
  if (
    component?.provider !== 'Azure Blob Storage' ||
    component.identity_label !== deployment.runtime_identity_label ||
    !regionName(component.region) ||
    !matches(/^[a-z0-9]{3,24}$/, account) ||
    !matches(/^[a-zA-Z0-9_.()-]{1,90}$/, resource_group) ||
    resource_group.endsWith('.') ||
    ![subscription_id, tenant_id, runtime_client_id].every((value) => matches(uuid, value)) ||
    !matches(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/, anchor_prefix) ||
    anchor_prefix.length > 200 ||
    !['managed_identity', 'client_secret'].includes(runtime_credential) ||
    checkpoint?.container === safety?.container ||
    ![checkpoint?.container, safety?.container].every(
      (value) => matches(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, value) && !value.includes('--'),
    )
  )
    throw new Error('Invalid Azure storage acceptance settings');
  const resourceGroupId = `/subscriptions/${subscription_id}/resourceGroups/${resource_group}`;
  const accountId = `${resourceGroupId}/providers/Microsoft.Storage/storageAccounts/${account}`;
  const serviceId = `${accountId}/blobServices/default`;
  return {
    resourceGroupId,
    accountId,
    serviceId,
    origin: `https://${account}.blob.core.windows.net`,
    checkpointId: `${serviceId}/containers/${checkpoint.container}`,
    safetyId: `${serviceId}/containers/${safety.container}`,
    component,
  };
}

export function runtimeIdentity(settings, env) {
  const { runtime_client_id, runtime_credential, tenant_id } = settings;
  if (runtime_credential === 'managed_identity')
    return new ManagedIdentityCredential(runtime_client_id);
  const secret = env.HAIP_ACCEPTANCE_AZURE_RUNTIME_CLIENT_SECRET;
  if (!secret) throw new Error('Runtime client secret is required');
  return new ClientSecretCredential(tenant_id, runtime_client_id, secret);
}

export function azureReader(settings) {
  return new AzureCliCredential({
    subscription: settings.subscription_id,
    processTimeoutInMs: 10_000,
  });
}

export async function azureToken(credential, audience) {
  const token = await credential.getToken(`${audience}/.default`, {
    abortSignal: AbortSignal.timeout(15_000),
  });
  if (!token?.token) throw new Error('Scoped Azure authentication failed');
  return token.token;
}

export function armUrl(id, version = storageVersion) {
  return new URL(`${managementOrigin}${id}?api-version=${version}`);
}

export function azureRequest(url, token, request, { method = 'GET', headers, body } = {}) {
  if (
    url.username ||
    url.password ||
    url.hash ||
    ![managementOrigin, graphOrigin].includes(url.origin)
  )
    throw new Error('Unexpected Azure control endpoint');
  return request(url.href, {
    method,
    headers: {
      ...headers,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

export async function boundedJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Azure response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function getAzureJson(url, token, request) {
  const response = await azureRequest(url, token, request);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error('Azure read failed');
  }
  return boundedJson(response);
}

export function sameId(actual, expected) {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
}
