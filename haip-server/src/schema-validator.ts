import { Worker } from 'node:worker_threads';
import { ProtocolError } from './errors.js';
import { RESPONSE_SCHEMA_PROFILE } from './schema-worker.js';

interface Job {
  input: string;
  resolve: () => void;
  reject: (error: ProtocolError) => void;
  timer?: ReturnType<typeof setTimeout>;
  worker?: Worker;
  settled: boolean;
}

const workerURL = new URL(
  import.meta.url.endsWith('.ts') ? './schema-worker.ts' : './schema-worker.js',
  import.meta.url,
);
const errors = new Set([
  'schema_complexity',
  'schema_reference_cycle',
  'unsupported_schema_reference',
  'remote_schema_reference',
  'unsupported_schema_keyword',
  'invalid_response_schema',
  'response_complexity',
  'response_schema_mismatch',
]);

class ResponseSchemaValidator {
  private active = 0;
  private readonly queue: Job[] = [];

  async validate(schema: unknown, response?: unknown, checkResponse = false): Promise<void> {
    if (
      this.active >= RESPONSE_SCHEMA_PROFILE.workers &&
      this.queue.length >= RESPONSE_SCHEMA_PROFILE.queued
    )
      throw new ProtocolError(503, 'schema_validation_busy');
    const input = JSON.stringify({ schema, response, checkResponse });
    if (Buffer.byteLength(input) > RESPONSE_SCHEMA_PROFILE.jobBytes)
      throw new ProtocolError(413, 'schema_validation_too_large');
    return new Promise<void>((resolve, reject) => {
      const job: Job = { input, resolve, reject, settled: false };
      job.timer = setTimeout(() => {
        if (job.worker) this.finish(job, new ProtocolError(400, 'schema_validation_timeout'));
        else {
          const index = this.queue.indexOf(job);
          if (index !== -1) this.queue.splice(index, 1);
          job.settled = true;
          job.reject(new ProtocolError(503, 'schema_validation_busy'));
        }
      }, RESPONSE_SCHEMA_PROFILE.timeoutMs);
      this.queue.push(job);
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < RESPONSE_SCHEMA_PROFILE.workers && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      try {
        job.worker = new Worker(workerURL, {
          workerData: { kind: 'haip_response_schema', input: job.input },
          execArgv: [],
          env: {},
          resourceLimits: {
            maxOldGenerationSizeMb: RESPONSE_SCHEMA_PROFILE.oldGenerationMb,
            maxYoungGenerationSizeMb: RESPONSE_SCHEMA_PROFILE.youngGenerationMb,
            stackSizeMb: RESPONSE_SCHEMA_PROFILE.stackMb,
            codeRangeSizeMb: RESPONSE_SCHEMA_PROFILE.codeRangeMb,
          },
        });
        job.worker.on('message', (result: unknown) => {
          if (job.settled) return;
          if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
            this.finish(job);
          else if (
            result &&
            typeof result === 'object' &&
            'code' in result &&
            result.code === 'schema_worker_configuration'
          )
            this.finish(job, new ProtocolError(503, 'schema_worker_configuration'));
          else if (
            result &&
            typeof result === 'object' &&
            'code' in result &&
            typeof result.code === 'string' &&
            errors.has(result.code)
          )
            this.finish(job, new ProtocolError(400, result.code));
          else this.finish(job, new ProtocolError(503, 'schema_validation_unavailable'));
        });
        job.worker.on('error', (error: Error & { code?: string }) =>
          this.finish(
            job,
            new ProtocolError(
              error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 400 : 503,
              error.code === 'ERR_WORKER_OUT_OF_MEMORY'
                ? 'schema_resource_limit'
                : 'schema_validation_unavailable',
            ),
          ),
        );
        job.worker.on('exit', () => {
          if (!job.settled)
            this.finish(job, new ProtocolError(503, 'schema_validation_unavailable'));
        });
      } catch {
        this.finish(job, new ProtocolError(503, 'schema_validation_unavailable'));
      }
    }
  }

  private finish(job: Job, error?: ProtocolError): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    // Keep the slot occupied until termination completes, including after a timeout or memory failure.
    void (job.worker?.terminate() ?? Promise.resolve()).then(
      () => this.complete(job, error),
      () => this.complete(job, error ?? new ProtocolError(503, 'schema_validation_unavailable')),
    );
  }

  private complete(job: Job, error?: ProtocolError): void {
    this.active--;
    if (error) job.reject(error);
    else job.resolve();
    this.dispatch();
  }
}

const validator = new ResponseSchemaValidator();
export const validateResponseSchema = (
  schema: unknown,
  response?: unknown,
  checkResponse = false,
): Promise<void> => validator.validate(schema, response, checkResponse);
