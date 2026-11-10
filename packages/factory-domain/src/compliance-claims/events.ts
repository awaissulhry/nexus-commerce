import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CLAIM_STATUSES, USE_KINDS } from '../compliance/claims/rules'

/**
 * Sourcing & claims' events (B-W2b-264; the code is factory-domain compliance/claims). A module folder of its own, as
 * compliance-recall (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/compliance/claims emits them
 * in the command that makes the change (design compliance.sourcing live: "claim.evidence_expired → Status column and tile").
 *
 *   claim.changed           a claim was drafted, its draft changed, approved, withdrawn, or replaced by an approved one
 *   claim.use_changed       a place where a claim is used was recorded or ended
 *   claim.evidence_expired  an approved claim's evidence stopped holding (its last valid day passed, an evidence file
 *                           expired or is gone): the claim and every place it is still used are flagged; said once per
 *                           cause by the daily job
 *
 * Live for compliance.certificates.view (who reads the register). Ids, codes, kinds, states and counts only: no words a
 * person typed, no person.
 */
const live = { permission: 'compliance.certificates.view' } as const

export const CLAIM_CHANGES = ['DRAFTED', 'EDITED', 'APPROVED', 'WITHDRAWN', 'REPLACED'] as const

export const events = [
  defineEvent({
    type: 'claim.changed',
    context: 'compliance-claims',
    description: 'A sustainability claim was drafted, its draft changed, approved, withdrawn, or replaced by an approved one.',
    payload: z.strictObject({ claimId: z.uuid(), code: z.string(), status: z.enum(CLAIM_STATUSES), change: z.enum(CLAIM_CHANGES) }),
    live: { ...live, fields: ['claimId', 'code', 'status', 'change'] },
  }),
  defineEvent({
    type: 'claim.use_changed',
    context: 'compliance-claims',
    description: 'A place where a sustainability claim is used (a label, a style, a catalogue, web shop texts) was recorded or ended.',
    payload: z.strictObject({ claimId: z.uuid(), useId: z.uuid(), kind: z.enum(USE_KINDS), recordType: z.string(), recordId: z.uuid(), change: z.enum(['ADDED', 'ENDED']) }),
    live: { ...live, fields: ['claimId', 'useId', 'kind', 'recordType', 'recordId', 'change'] },
  }),
  defineEvent({
    type: 'claim.evidence_expired',
    context: 'compliance-claims',
    description: "An approved sustainability claim's evidence stopped holding: the claim and every place it is still used are flagged.",
    payload: z.strictObject({ claimId: z.uuid(), code: z.string(), since: z.string(), causes: z.array(z.enum(['VALID_UNTIL', 'FILE_EXPIRED', 'FILE_GONE'])), liveUses: z.number().int().min(0) }),
    live: { ...live, fields: ['claimId', 'code', 'since', 'liveUses'] },
  }),
] as const
