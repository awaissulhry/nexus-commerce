import type { TaskSource } from '../portal/tasks/sources'

/**
 * B-W2b-184 (COL-064, SAL-222): the partner's request to answer an approval — APPROVE (a sample, colour, leather, artwork,
 * design proof, concession, outside signature) or RECONFIRM_ORDER (a revised order) — one per request (`ApprovalRequest:<id>`),
 * opened with the request, done by the answer (link or portal), cancelled when the office withdraws it or it expires. Each
 * has its own answer, so the partner never marks it done by hand.
 */
export const APPROVALS_SOURCE: TaskSource = Object.freeze<TaskSource>({ name: 'approvalsOut', prefix: 'ApprovalRequest', kinds: ['APPROVE', 'RECONFIRM_ORDER'], partnerDone: false })
