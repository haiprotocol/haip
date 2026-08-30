import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { canonicalise } from '@haip/protocol/crypto';
import { requireThat } from './errors.js';
export function publicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    // Conservative global-unicast subset. Exclude transition, documentation and special-use blocks.
    const parts = address.toLowerCase().split(':');
    const first = parseInt(parts[0]!, 16),
      second = parseInt(parts[1] || '0', 16);
    return (
      first >= 0x2000 &&
      first < 0x4000 &&
      first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
      !(first === 0x3fff && second < 0x1000) &&
      !address.includes('.')
    );
  }
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number) as [number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export async function deliverWebhook(
  destination: string,
  body: unknown,
  allowHosts: string[],
  transport = { resolve: lookup, request },
): Promise<void> {
  const url = new URL(destination);
  requireThat(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === '443') &&
      allowHosts.includes(url.hostname),
    400,
    'webhook_destination_rejected',
  );
  const addresses = await transport.resolve(url.hostname, { all: true });
  requireThat(
    addresses.length && addresses.every((a) => publicAddress(a.address)),
    400,
    'webhook_address_rejected',
  );
  const address = addresses[0]!;
  const bytes = Buffer.from(canonicalise(body));
  await new Promise<void>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length },
        lookup: ((_hostname: any, options: any, cb: any) =>
          options?.all ? cb(null, [address]) : cb(null, address.address, address.family)) as any,
      },
      (response) => {
        response.resume();
        response.once('error', reject);
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
          resolve();
        else reject(new Error('webhook_not_accepted'));
      },
    );
    req.once('timeout', () => req.destroy(new Error('webhook_timeout')));
    req.once('error', reject);
    req.end(bytes);
  });
}
