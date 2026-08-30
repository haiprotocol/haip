import type { ReviewService } from './service.js';
import type { Principal } from './config.js';
import { requireThat } from './errors.js';
export const HITL_REVISION = '655eba84932669af057e3cd9cacb1c94ae51ae65';
/** Browser review + authenticated polling only; inline submissions carry no authority. */
export async function hitlStatus(service: ReviewService, principal: Principal, id: string) {
  const s = await service.status(principal, id),
    r = s.request;
  requireThat(r.purpose === 'review', 409, 'hitl_review_only');
  const state =
    s.decision_state === 'confirmed'
      ? 'completed'
      : s.decision_state === 'superseded'
        ? 'cancelled'
        : s.decision_state;
  if (state === 'pending')
    return {
      httpStatus: 202,
      body: {
        status: 'human_input_required',
        hitl: {
          spec_version: '0.8',
          case_id: id,
          review_url: s.review_link,
          poll_url: `${service.config.origin}/v2/hitl/${id}/poll`,
          type: 'input',
          prompt: r.summary,
          timeout:
            Math.max(
              1,
              Math.ceil((Date.parse(r.review_deadline) - Date.parse(r.accepted_at)) / 1000),
            ) + 's',
          default_action: 'cancel',
          created_at: r.accepted_at,
          expires_at: r.review_deadline,
        },
      },
    };
  return { httpStatus: 200, body: await hitlPoll(service, principal, id) };
}
export async function hitlPoll(service: ReviewService, principal: Principal, id: string) {
  const s = await service.status(principal, id),
    r = s.request;
  requireThat(r.purpose === 'review', 409, 'hitl_review_only');
  if (s.decision_state !== 'confirmed')
    return {
      case_id: id,
      status: s.decision_state === 'superseded' ? 'cancelled' : s.decision_state,
      created_at: r.accepted_at,
      expires_at: r.review_deadline,
    };
  const audit = await service.export(principal, id);
  return {
    case_id: id,
    status: 'completed',
    completed_at: (s.receipt as any).payload.confirmed_at,
    result: {
      action: (s.receipt as any).payload.decision,
      data: {
        response: audit.material?.candidate?.response ?? null,
        haip_receipt: s.receipt,
        audit_state: s.audit_state,
        material_available: !!audit.material,
      },
    },
  };
}
