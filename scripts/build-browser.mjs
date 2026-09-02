import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const notice = await readFile('haip-server/LICENSE', 'utf8');
await build({
  entryPoints: ['haip-server/src/browser/host.ts', 'haip-server/src/browser/sandbox.ts'],
  bundle: true,
  outdir: 'haip-server/public',
  format: 'iife',
  platform: 'browser',
  target: 'es2024',
  legalComments: 'linked',
  banner: { js: '/*!\n' + notice + '\n*/' },
  minify: true,
});
