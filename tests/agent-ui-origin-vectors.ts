export const validAgentUiOrigins = [
  'https://sandbox.example',
  'https://xn--bcher-kva.example',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'https://255.255.255.255:65535',
] as const;

export const invalidAgentUiOrigins = [
  'ftp://sandbox.example',
  'https://SANDBOX.example',
  'https://example.com:443',
  'http://example.com:80',
  'https://example.com:0',
  'https://example.com:65536',
  'https://127.1',
  'https://127.00.0.1',
  'https://256.0.0.1',
  'https://[0:0:0:0:0:0:0:1]',
  'https://example.com.',
  'https://foo_bar.example',
  'https://-a.example',
  'https://user@example.com',
  'https://example.com/path',
  'https://example.com?query',
] as const;
