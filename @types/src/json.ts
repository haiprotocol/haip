export function canonicalise(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('Invalid Unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']';
  if (
    typeof value === 'object' &&
    value &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => canonicalise(key) + ':' + canonicalise((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  }
  throw new Error('Unsupported JSON value');
}

/** Parse at the trust boundary, before a normal parser can erase duplicate keys. */
export function parseJson(text: string): unknown {
  if (!text.isWellFormed()) throw new Error('Invalid Unicode');
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) {
      if (!' \t\r\n'.includes(text[i]!)) throw new Error('Invalid whitespace');
      i++;
    }
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') {
        const s = JSON.parse(text.slice(start, i));
        if (!s.isWellFormed()) throw new Error('Invalid Unicode');
        return s;
      }
    }
    throw new Error('Unterminated string');
  };
  const decimal = (s: string): string => {
    const [mantissa, exponent = '0'] = s.toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa!.replace(/^-/, '').split('.');
    let digits = (whole! + fraction).replace(/^0+/, '');
    let exp = Number(exponent) - fraction.length;
    while (digits.endsWith('0')) {
      digits = digits.slice(0, -1);
      exp++;
    }
    return digits ? (s[0] === '-' ? '-' : '') + digits + 'e' + exp : '0';
  };
  const value = (depth: number): unknown => {
    if (depth > 64) throw new Error('JSON nesting limit');
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++;
      ws();
      const result = Object.create(null);
      const keys = new Set<string>();
      if (text[i] === '}') {
        i++;
        return result;
      }
      while (i < text.length) {
        ws();
        if (text[i] !== '"') throw new Error('Expected object key');
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate JSON key');
        keys.add(key);
        ws();
        if (text[i++] !== ':') throw new Error('Expected colon');
        result[key] = value(depth + 1);
        ws();
        const end = text[i++];
        if (end === '}') return result;
        if (end !== ',') throw new Error('Expected comma');
      }
    }
    if (text[i] === '[') {
      i++;
      ws();
      const result: unknown[] = [];
      if (text[i] === ']') {
        i++;
        return result;
      }
      while (i < text.length) {
        result.push(value(depth + 1));
        ws();
        const end = text[i++];
        if (end === ']') return result;
        if (end !== ',') throw new Error('Expected comma');
      }
    }
    for (const literal of ['true', 'false', 'null'])
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return JSON.parse(literal);
      }
    const number = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      const raw = number[0],
        n = Number(raw);
      i += raw.length;
      if (
        !Number.isFinite(n) ||
        (Number.isInteger(n) && !Number.isSafeInteger(n)) ||
        decimal(raw) !== decimal(JSON.stringify(n))
      )
        throw new Error('Unsupported number precision; use a schema-defined string');
      return n;
    }
    throw new Error('Invalid JSON');
  };
  const parsed = value(0);
  ws();
  if (i !== text.length) throw new Error('Trailing JSON');
  return parsed;
}
