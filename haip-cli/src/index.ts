#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import {
  HAIPClient,
  HAIPError,
  verifyRecord,
  type SignedRecord,
  type TrustManifest,
} from '@haip/sdk';
import { parseJson } from '@haip/protocol/crypto';
const [command, ...args] = process.argv.slice(2);
async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(
      'HAIP 2 draft\ncreate <request.json> <idempotency-key>\nstatus <request-id>\ncancel <request-id> <idempotency-key>\nevents [after-cursor]\nexport <request-id> <output.json>\nverify <signed-record.json> <trusted-manifest.json> <issuer> <audience> <type>\n\nSet HAIP_URL and HAIP_TOKEN. Decisions must be confirmed by an authenticated human in the browser.',
    );
    return;
  }
  if (command === 'verify') {
    const record = parseJson(await readFile(args[0]!, 'utf8')) as SignedRecord,
      trust = parseJson(await readFile(args[1]!, 'utf8')) as TrustManifest;
    verifyRecord(record, trust, { issuer: args[2]!, audience: args[3]!, type: args[4]! });
    console.log(
      'Signature and trusted signing identity verified. Historical time is indeterminate without independent evidence; this does not renew execution authority.',
    );
    return;
  }
  if (!process.env.HAIP_URL || !process.env.HAIP_TOKEN)
    throw new Error('HAIP_URL and HAIP_TOKEN are required');
  const client = new HAIPClient(
    process.env.HAIP_URL,
    process.env.HAIP_TOKEN,
    process.env.HAIP_LOCAL_HTTP === 'true',
  );
  let result: unknown;
  switch (command) {
    case 'create':
      if (!args[1]) throw new Error('An explicit idempotency key is required');
      result = await client.create(parseJson(await readFile(args[0]!, 'utf8')) as any, args[1]);
      break;
    case 'status':
      result = await client.status(args[0]!);
      break;
    case 'cancel':
      if (!args[1]) throw new Error('An explicit idempotency key is required');
      result = await client.cancel(args[0]!, args[1]);
      break;
    case 'events':
      result = await client.events(Number(args[0] ?? 0));
      break;
    case 'export':
      result = await client.audit(args[0]!);
      await writeFile(args[1]!, JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log('Audit export written.');
      return;
    default:
      throw new Error('Unknown command; run haip help');
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error instanceof HAIPError ? `${error.status}: ${error.code}` : error.message);
  process.exitCode = 1;
});
