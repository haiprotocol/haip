export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function requireThat(test: unknown, status: number, code: string): asserts test {
  if (!test) throw new ProtocolError(status, code);
}
export const missing = () => new ProtocolError(404, 'not_found');
