import type { ReviewBinding, ReviewBundle } from '@haip/protocol';
import { digest, digestBytes } from '@haip/protocol/crypto';
import { requireThat } from './errors.js';
import { validate } from './validation.js';

/** Recheck persisted bytes and metadata before delivering a request's bound App. */
export function requireBoundBundle(
  found: { html?: unknown; manifest?: unknown } | undefined,
  tenant: string,
  binding: NonNullable<ReviewBinding['bundle']>,
): asserts found is { html: string; manifest: ReviewBundle } {
  requireThat(found?.html, 410, 'bundle_deleted');
  let valid = false;
  try {
    validate('ReviewBundle', found.manifest);
    const manifest = found.manifest as ReviewBundle;
    valid =
      typeof found.html === 'string' &&
      digestBytes(found.html) === binding.digest &&
      manifest.digest === binding.digest &&
      manifest.id === binding.id &&
      manifest.tenant === tenant &&
      manifest.publisher === binding.publisher &&
      digest(manifest.compatibility) === digest(binding.compatibility);
  } catch {
    // Malformed stored metadata must not escape through a successful export or App response.
  }
  requireThat(valid, 409, 'bundle_integrity_mismatch');
}
