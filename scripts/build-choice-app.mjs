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
    [['HAIP', 'LICENSE']].map(async ([name, path]) => [name, await readFile(path, 'utf8')]),
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
