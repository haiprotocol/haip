import { readFile } from 'node:fs/promises';
const origin = process.env.HAIP_URL,
  token = process.env.HAIP_PUBLISHER_TOKEN;
if (!origin || !token || !process.env.HAIP_IDEMPOTENCY_KEY)
  throw new Error('Set HAIP_URL, HAIP_PUBLISHER_TOKEN and HAIP_IDEMPOTENCY_KEY');
const url = new URL(origin);
if (
  url.origin !== origin ||
  (url.protocol !== 'https:' &&
    !(process.env.HAIP_LOCAL_HTTP === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)))
)
  throw new Error('An HTTPS origin or explicitly enabled localhost fixture is required');
const response = await fetch(origin + '/v2/bundles', {
  method: 'POST',
  redirect: 'error',
  headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Idempotency-Key': process.env.HAIP_IDEMPOTENCY_KEY,
  },
  body: JSON.stringify({
    html: await readFile('output/examples/choice-app.html', 'utf8'),
    compatibility: { agent_ui: '1' },
    author: 'Independent HTTP example',
    licence: 'MIT',
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
console.log(JSON.stringify(result, null, 2));
