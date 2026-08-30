import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const result = await build({
  entryPoints: ['examples/http/choice-app.js'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
await mkdir('output/examples', { recursive: true });
const licences = Object.fromEntries(
  await Promise.all(
    [
      ['HAIP', 'LICENSE'],
      ['MCP Apps 1.7.4', 'third-party/ext-apps-1.7.4-LICENSE'],
      ['MCP SDK 1.29.0', 'third-party/mcp-sdk-1.29.0-LICENSE'],
      ['Zod 4.5.4', 'third-party/zod-4.5.4-LICENSE'],
      ['zod-to-json-schema 3.25.2', 'third-party/zod-to-json-schema-3.25.2-LICENSE'],
    ].map(async ([name, path]) => [name, await readFile(path, 'utf8')]),
  ),
);
await writeFile(
  'output/examples/choice-app.html',
  '<!doctype html><body><script type="application/json" id="haip-licences">' +
    JSON.stringify(licences).replaceAll('<', '\\u003c') +
    '</script><script type="module">' +
    result.outputFiles[0].text.replaceAll('</script', '<\\/script') +
    '</script></body>',
);
console.log('Built output/examples/choice-app.html');
