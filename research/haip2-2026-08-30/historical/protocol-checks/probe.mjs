import fs from 'node:fs';
import { canonicalize } from './canonical.ts';
import { privateKeyFromSeed, publicKeyBytes, publicKeyFromRaw, signEnvelope, verifyEnvelope } from './crypto.ts';
const raw=fs.readFileSync(0); const [op, first, second]=process.argv.slice(2);
if(op==='canonical') process.stdout.write(canonicalize(JSON.parse(raw.toString('utf8'))));
else if(op==='sign') process.stdout.write(Buffer.from(signEnvelope(raw,privateKeyFromSeed(Buffer.from(first,'hex')),'fixture').split(':')[2],'base64').toString('hex'));
else if(op==='public') process.stdout.write(publicKeyBytes(privateKeyFromSeed(Buffer.from(first,'hex'))).toString('hex'));
else if(op==='verify') process.stdout.write(String(verifyEnvelope(raw,'ed25519:fixture:'+Buffer.from(second,'hex').toString('base64'),publicKeyFromRaw(Buffer.from(first,'hex')))));
else throw new Error('unknown probe');
