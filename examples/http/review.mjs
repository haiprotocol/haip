// An ordinary HTTP producer with a separately provisioned credential.
import { readFile } from 'node:fs/promises';
const url = process.env.HAIP_URL,
  token = process.env.HAIP_TOKEN;
if (!url || !token) throw new Error('Set HAIP_URL and HAIP_TOKEN');
const origin = new URL(url);
if (
  origin.protocol !== 'https:' &&
  !(
    origin.protocol === 'http:' &&
    process.env.HAIP_LOCAL_HTTP === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  )
)
  throw new Error('Use HTTPS, or explicitly enable localhost HTTP for an isolated test');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
  throw new Error('Expected an origin');
if (!process.env.HAIP_IDEMPOTENCY_KEY)
  throw new Error('Set a stable HAIP_IDEMPOTENCY_KEY for retries');
const material = JSON.parse(await readFile(new URL('./review.json', import.meta.url), 'utf8'));
if (process.env.HAIP_BUNDLE_ID) {
  material.bundle_id = process.env.HAIP_BUNDLE_ID;
  material.profiles['haip.agent-ui'] = '2';
}
const response = await fetch(origin.origin + '/v2/requests', {
  method: 'POST',
  redirect: 'error',
  headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Idempotency-Key': process.env.HAIP_IDEMPOTENCY_KEY,
  },
  body: JSON.stringify(material),
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result));
console.log(
  JSON.stringify(
    {
      request_id: result.request.id,
      review_link: result.review_link,
      polling_link: result.polling_link,
    },
    null,
    2,
  ),
);
