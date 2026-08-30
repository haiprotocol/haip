import { build } from 'esbuild';
import { cp, readFile } from 'node:fs/promises';
const notices = await Promise.all(
  [
    'third-party/ext-apps-1.7.4-LICENSE',
    'third-party/mcp-sdk-1.29.0-LICENSE',
    'third-party/zod-4.5.4-LICENSE',
    'third-party/zod-to-json-schema-3.25.2-LICENSE',
  ].map((path) => readFile(path, 'utf8')),
);
await build({
  entryPoints: ['haip-server/src/browser/host.ts', 'haip-server/src/browser/sandbox.ts'],
  bundle: true,
  outdir: 'haip-server/public',
  format: 'iife',
  platform: 'browser',
  target: 'es2024',
  legalComments: 'linked',
  banner: { js: '/*!\n' + notices.join('\n\n') + '\n*/' },
  minify: false,
});
await cp('third-party', 'haip-server/third-party', { recursive: true });
