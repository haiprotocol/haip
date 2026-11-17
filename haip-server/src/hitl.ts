import type { HitlHandoff, HitlPoll } from '@haip/protocol';
import type { ReviewService } from './service.js';
import type { Principal } from './config.js';
import { ProtocolError, requireThat } from './errors.js';

export const HITL_REVISION = '655eba84932669af057e3cd9cacb1c94ae51ae65';
const defaultAction = 'abort';

function pollBody(review: Awaited<ReturnType<ReviewService['hitlReview']>>): HitlPoll {
  const { request, receipt, candidate } = review;
  const identity = { case_id: request.id, created_at: request.accepted_at };
  const timing = { ...identity, expires_at: request.review_deadline };
  switch (review.decisionState) {
    case 'pending':
      return { ...timing, status: 'pending' };
    case 'expired':
      requireThat(review.expiredAt, 409, 'hitl_transition_unknown');
      return {
        ...timing,
        status: 'expired',
        expired_at: review.expiredAt,
        default_action: defaultAction,
      };
    case 'cancelled':
    case 'superseded':
      requireThat(review.cancelledAt, 409, 'hitl_transition_unknown');
      return { ...timing, status: 'cancelled', cancelled_at: review.cancelledAt };
    case 'confirmed':
      requireThat(receipt, 409, 'material_integrity_mismatch');
      return {
        ...identity,
        status: 'completed',
        completed_at: receipt.payload.confirmed_at,
        result: {
          action: 'submit',
          data: {
            response: candidate?.response ?? null,
            haip_receipt: receipt,
            audit_state: review.auditState,
            material_available: candidate !== undefined,
          },
        },
      };
    default:
      throw new ProtocolError(409, 'hitl_transition_unknown');
  }
}

export async function hitlStatus(service: ReviewService, principal: Principal, id: string) {
  const review = await service.hitlReview(principal, id);
  if (review.decisionState !== 'pending') return { httpStatus: 200, body: pollBody(review) };
  const r = review.request;
  const seconds = Math.max(
    1,
    Math.ceil((Date.parse(r.review_deadline) - Date.parse(r.accepted_at)) / 1000),
  );
  const body: HitlHandoff = {
    status: 'human_input_required',
    hitl: {
      spec_version: '0.8',
      case_id: r.id,
      review_url: `${service.config.origin}/review/${r.id}`,
      poll_url: `${service.config.origin}/v2/hitl/${r.id}/poll`,
      type: 'input',
      prompt: r.summary,
      timeout: `PT${seconds}S`,
      default_action: defaultAction,
      created_at: r.accepted_at,
      expires_at: r.review_deadline,
    },
  };
  return { httpStatus: 202, body };
}

export async function hitlPoll(service: ReviewService, principal: Principal, id: string) {
  return pollBody(await service.hitlReview(principal, id));
}
