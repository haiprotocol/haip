import { environment } from '../tests/environment.js';
const env = await environment();
console.log('Isolated development fixture. Temporary database, local OIDC, test-only anchoring and random credentials. Never expose these listeners publicly.');
console.log(JSON.stringify({ origin: env.origin, sign_in_as: 'reviewer',
  producer_token: env.credentials.producer, publisher_token: env.credentials.publisher,
  operator_token: env.credentials.operator }, null, 2));
let busy = false;
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  void env.flush().catch(() => console.error('Development outbox failed')).finally(() => { busy = false; });
}, 1000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(timer); void env.close().then(() => process.exit(0));
});
