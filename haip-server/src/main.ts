import { createApp } from './server.js';
import { createViewBootstrap } from './sandbox-app.js';
import { OutboxWorker } from './worker.js';
import { recoverTenant } from './recovery.js';
import { bootstrapTenant } from './admin.js';
import { createRuntime, createRuntimeStore, requiredEnv } from './runtime.js';

const args = process.argv.slice(2);
const command = args[0];
if (args.length > 1 || (command && !['--migrate', '--bootstrap', '--recover'].includes(command)))
  throw new Error('Expected one of --migrate, --bootstrap or --recover, or no command');

if (command === '--migrate') {
  const store = createRuntimeStore(process.env, 'administrative');
  try {
    await store.migrate();
  } finally {
    await store.close();
  }
} else {
  const listenHost = process.env.HAIP_LISTEN_HOST ?? '127.0.0.1';
  if (!command && !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(listenHost))
    throw new Error('HAIP_LISTEN_HOST must be an explicit loopback or wildcard IP address');
  const { service, anchor } = createRuntime(process.env, {
    databaseAccess: command ? 'administrative' : 'runtime',
  });
  const { store } = service;
  const required = (name: string) => requiredEnv(process.env, name);
  let serving = false;
  try {
    if (service.config.mode === 'development' && command !== '--recover') await store.migrate();
    else await store.requireSchema();
    if (command === '--bootstrap') {
      await bootstrapTenant(
        service,
        required('HAIP_BOOTSTRAP_TENANT'),
        required('HAIP_BOOTSTRAP_OPERATOR'),
        required('HAIP_BOOTSTRAP_TOKEN'),
      );
    } else if (command === '--recover') {
      if (!anchor || !service.recovery)
        throw new Error('Independent storage required for recovery');
      console.log(
        JSON.stringify(
          await recoverTenant(
            service,
            anchor,
            service.recovery,
            required('HAIP_RECOVERY_TENANT'),
            required('HAIP_RECOVERY_OPERATOR'),
            required('HAIP_RECOVERY_TOKEN'),
          ),
        ),
      );
    } else {
      await serve(service, anchor, listenHost);
      serving = true;
    }
  } finally {
    if (!serving) await store.close();
  }
}

async function serve(
  service: ReturnType<typeof createRuntime>['service'],
  anchor: ReturnType<typeof createRuntime>['anchor'],
  listenHost: string,
) {
  const { store } = service;
  const app = createApp(service);
  const bootstrap = createViewBootstrap(service.config);
  const worker = new OutboxWorker(service, anchor);
  await worker.reconcile();
  if (
    service.config.mode === 'production' &&
    (await store.pool.query('SELECT 1 FROM haip_tenants WHERE fenced LIMIT 1')).rowCount
  ) {
    throw new Error('Offline namespace recovery is required before opening production listeners');
  }
  const initialCleanup = await worker.cleanup();
  const server = app.listen(Number(process.env.PORT ?? 8080), listenHost);
  const sandbox = bootstrap.listen(Number(process.env.HAIP_SANDBOX_PORT ?? 8081), listenHost);
  let busy = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    void worker
      .tick()
      .catch(() => console.error('HAIP outbox failure'))
      .finally(() => {
        busy = false;
      });
  }, 1000);
  let closing = false;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  function scheduleCleanup(more: boolean) {
    // Continue bounded passes after listeners open; never overlap retention runs.
    cleanup = setTimeout(
      async () => {
        cleanup = undefined;
        let continuation = false;
        try {
          continuation = (await worker.cleanup()).more;
        } catch {
          console.error('HAIP retention failure');
        }
        if (!closing) scheduleCleanup(continuation);
      },
      more ? 1000 : 15 * 60000,
    );
  }
  scheduleCleanup(initialCleanup.more);
  console.log(
    `HAIP draft service: ${service.config.origin}; ${service.discovery().notifications}; ${anchor ? 'independent namespace checks enabled' : 'unanchored; execution admission fenced'}`,
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      closing = true;
      clearInterval(tick);
      clearTimeout(cleanup);
      server.close();
      sandbox.close();
      void store.close();
    });
}
