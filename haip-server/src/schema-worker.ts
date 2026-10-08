import { Ajv2020 } from 'ajv/dist/2020.js';
import { parentPort, workerData } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';

export const RESPONSE_SCHEMA_PROFILE = Object.freeze({
  syntaxNodes: 9999,
  syntaxDepth: 31,
  referenceWork: 10000,
  responseDepth: 64,
  responseWork: 5000000,
  jobBytes: 2 * 256 * 1024 + 256,
  workers: 2,
  queued: 8,
  timeoutMs: 1500,
  oldGenerationMb: 64,
  youngGenerationMb: 16,
  stackMb: 4,
  codeRangeMb: 16,
  maximumHeapMb: 96,
});

type SchemaNode = { edges: { node: SchemaNode; consumes: boolean }[]; weight: number };
const dataKeywords = new Set(['const', 'enum', 'default', 'examples']);
const maps = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
const consuming = new Set([
  'properties',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'contains',
  'unevaluatedItems',
]);

function refuse(code: string): never {
  throw new Error(code);
}

function expandedWork(schema: unknown): number {
  let syntaxNodes = 0;
  const nodes = new Map<object, SchemaNode>();
  const references: { source: SchemaNode; pointer: string }[] = [];
  const walk = (value: unknown, depth: number): SchemaNode | undefined => {
    if (
      ++syntaxNodes > RESPONSE_SCHEMA_PROFILE.syntaxNodes ||
      depth > RESPONSE_SCHEMA_PROFILE.syntaxDepth
    )
      refuse('schema_complexity');
    if (!value || typeof value !== 'object') return;
    const node: SchemaNode = { edges: [], weight: 1 };
    nodes.set(value, node);
    for (const [keyword, child] of Object.entries(value)) {
      node.weight++;
      if (['$dynamicRef', '$recursiveRef', '$id', '$async'].includes(keyword))
        refuse('unsupported_schema_reference');
      if (keyword === '$ref') {
        if (typeof child !== 'string' || !child.startsWith('#/')) refuse('remote_schema_reference');
        references.push({ source: node, pointer: child });
      }
      if (['pattern', 'patternProperties', 'format'].includes(keyword))
        refuse('unsupported_schema_keyword');
      if (dataKeywords.has(keyword)) continue;
      if (maps.has(keyword) && child && typeof child === 'object') {
        for (const entry of Object.values(child)) {
          const target = walk(entry, depth + 1);
          if (target && !['$defs', 'definitions'].includes(keyword))
            node.edges.push({ node: target, consumes: consuming.has(keyword) });
        }
      } else if (Array.isArray(child)) {
        for (const entry of child) {
          const target = walk(entry, depth + 1);
          if (target) node.edges.push({ node: target, consumes: consuming.has(keyword) });
        }
      } else {
        const target = walk(child, depth + 1);
        if (target) node.edges.push({ node: target, consumes: consuming.has(keyword) });
      }
    }
    return node;
  };
  const root = walk(schema, 0);
  for (const reference of references) {
    let target = schema;
    let pointer: string;
    try {
      pointer = decodeURIComponent(reference.pointer.slice(1));
    } catch {
      refuse('invalid_response_schema');
    }
    for (const token of pointer!.slice(1).split('/')) {
      if (/~(?:[^01]|$)/.test(token)) refuse('invalid_response_schema');
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key))
        refuse('invalid_response_schema');
      target = (target as Record<string, unknown>)[key];
    }
    if (typeof target === 'boolean') continue;
    if (!target || typeof target !== 'object' || !nodes.has(target))
      refuse('invalid_response_schema');
    reference.source.edges.push({ node: nodes.get(target)!, consumes: false });
  }

  const maximum = RESPONSE_SCHEMA_PROFILE.referenceWork;
  const memo = new Map<SchemaNode, Map<number, number>>();
  const active = new Map<SchemaNode, Set<number>>();
  const cost = (node: SchemaNode, depth: number): number => {
    const known = memo.get(node)?.get(depth);
    if (known !== undefined) return known;
    if (active.get(node)?.has(depth)) refuse('schema_reference_cycle');
    const visiting = active.get(node) ?? new Set<number>();
    active.set(node, visiting);
    visiting.add(depth);
    let work = node.weight;
    // A property or item consumes response depth. Recursive data schemas remain bounded by the JSON nesting limit.
    for (const edge of node.edges) {
      if (edge.consumes && depth === 0) continue;
      work = Math.min(maximum + 1, work + cost(edge.node, depth - Number(edge.consumes)));
      if (work > maximum) break;
    }
    visiting.delete(depth);
    const depths = memo.get(node) ?? new Map<number, number>();
    memo.set(node, depths);
    depths.set(depth, work);
    return work;
  };
  let largest = 1;
  for (const node of nodes.values()) {
    largest = Math.max(largest, cost(node, RESPONSE_SCHEMA_PROFILE.responseDepth));
    if (largest > maximum) refuse('schema_complexity');
  }
  return root ? Math.max(largest, cost(root, RESPONSE_SCHEMA_PROFILE.responseDepth)) : 1;
}

function responseNodes(response: unknown): number {
  let count = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > RESPONSE_SCHEMA_PROFILE.responseDepth) refuse('response_complexity');
    count++;
    if (value && typeof value === 'object')
      for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(response, 0);
  return count;
}

export function checkResponseSchema(
  schema: unknown,
  response?: unknown,
  checkResponse = false,
): void {
  const work = expandedWork(schema);
  if (checkResponse) {
    const count = responseNodes(response);
    // Compare against the divided budget to avoid overflowing a multiplication.
    if (count > Math.floor(RESPONSE_SCHEMA_PROFILE.responseWork / work))
      refuse('response_complexity');
  }
  try {
    const check = new Ajv2020({ strict: true, allErrors: false, ownProperties: true }).compile(
      schema as object,
    );
    if (checkResponse && !check(response)) refuse('response_schema_mismatch');
  } catch (error) {
    if (error instanceof Error && error.message === 'response_schema_mismatch') throw error;
    refuse('invalid_response_schema');
  }
}

if (parentPort && workerData?.kind === 'haip_response_schema') {
  try {
    if (getHeapStatistics().heap_size_limit > RESPONSE_SCHEMA_PROFILE.maximumHeapMb * 1024 ** 2)
      refuse('schema_worker_configuration');
    const input = JSON.parse(workerData.input as string);
    checkResponseSchema(input.schema, input.response, input.checkResponse);
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: error instanceof Error ? error.message : 'invalid_response_schema',
    });
  }
}
