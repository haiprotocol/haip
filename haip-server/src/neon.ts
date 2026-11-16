import { databaseConnection } from './startup.js';
import { Store } from './store.js';

export function neonConnection(raw: string, access: 'runtime' | 'administrative') {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid Neon connection URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(url.hostname) ||
    !['', '5432'].includes(url.port) ||
    !url.username ||
    !url.password ||
    !/^\/[^/]+$/.test(url.pathname) ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode')
  )
    throw new Error('Expected a Neon PostgreSQL URL with explicit database, role and verified TLS');
  const pooled = url.hostname.split('.')[0]!.endsWith('-pooler');
  if (pooled !== (access === 'runtime'))
    throw new Error(
      access === 'runtime'
        ? 'Neon runtime requires a pooled endpoint'
        : 'Neon administration requires a direct endpoint',
    );
  const connection = databaseConnection('production', raw);
  return {
    url: connection.url,
    options: {
      ...connection.options,
      allowExitOnIdle: true,
      max: access === 'runtime' ? 3 : 1,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 5000,
    },
  };
}

export function createNeonStore(raw: string, access: 'runtime' | 'administrative') {
  const connection = neonConnection(raw, access);
  return new Store(connection.url, connection.options);
}
