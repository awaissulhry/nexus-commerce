import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CR_VI_EVIDENCE, EVIDENCE_RULES, LAB_TESTS, LOT_DOCUMENT_KINDS } from './lab/rules'

/**
 * The quality module's events (plan A1 §3.4). The lab step (B-W1-34, modules/quality/lab) emits them in the command that
 * decides: `lot.test_recorded` once per lab result of a lot (a later FAIL on a released lot also emits `lot.blocked`
 * with the work orders it went to), `lot.document_attached` once per supplier document, `lot.hold_cleared` when the
 * receiver's hold is cleared, `lot.released` when a lot leaves quarantine or a blocked lot is released again (its
 * stock is usable: planning nets it, the pick list offers it), `lot.rejected` (final) and `lot.blocked`;
 * `quality.settings_changed` when the Cr VI evidence rule changes. They reach the lot, receipt, stock and test screens of
 * the office (quality.lots.view). No cost, price or person's name in a payload.
 */
const lotStatus = z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'])

export const events = [
  defineEvent({
    type: 'lot.test_recorded',
    context: 'quality',
    description: "A lab result of a lot was recorded with its report: the verdict against the lot's limit and what it did to the lot.",
    payload: z.strictObject({
      lotId: z.uuid(),
      code: z.string(),
      resultId: z.uuid(),
      test: z.enum(LAB_TESTS),
      verdict: z.enum(['PASS', 'FAIL']),
      evidence: z.enum(CR_VI_EVIDENCE),
      fileId: z.uuid(),
      /** The lot's Cr VI status and quality status after the result. */
      crViStatus: z.enum(['PASS', 'FAIL']),
      qualityStatus: lotStatus,
      /** A FAIL on new evidence after a PASS (it supersedes the earlier result). */
      laterFail: z.boolean(),
    }),
    live: { permission: 'quality.lots.view', fields: ['lotId', 'code', 'verdict', 'crViStatus', 'qualityStatus'] },
  }),
  defineEvent({
    type: 'lot.document_attached',
    context: 'quality',
    description: "A supplier document was attached to a lot (a PPE component's certificate, an LWG certificate, a test report).",
    payload: z.strictObject({ lotId: z.uuid(), code: z.string(), documentId: z.uuid(), kind: z.enum(LOT_DOCUMENT_KINDS), fileId: z.uuid() }),
    live: { permission: 'quality.lots.view', fields: ['lotId', 'code', 'kind'] },
  }),
  defineEvent({
    type: 'lot.hold_cleared',
    context: 'quality',
    description: 'The hold the receiver placed on a lot at receipt was checked and cleared by the quality role.',
    payload: z.strictObject({ lotId: z.uuid(), code: z.string() }),
    live: { permission: 'quality.lots.view', fields: ['lotId', 'code'] },
  }),
  defineEvent({
    type: 'lot.released',
    context: 'quality',
    description: 'A lot was released by the quality role, every check passed: its stock is usable (planning nets it, it may be issued).',
    payload: z.strictObject({ lotId: z.uuid(), code: z.string(), itemId: z.uuid(), from: z.enum(['QUARANTINE', 'BLOCKED']) }),
    live: { permission: 'quality.lots.view', fields: ['lotId', 'code', 'from'] },
  }),
  defineEvent({
    type: 'lot.rejected',
    context: 'quality',
    description: 'A lot was rejected (final): it goes back to the supplier or is scrapped, and is never used.',
    payload: z.strictObject({ lotId: z.uuid(), code: z.string(), itemId: z.uuid(), from: z.enum(['QUARANTINE', 'BLOCKED']) }),
    live: { permission: 'quality.lots.view', fields: ['lotId', 'code', 'from'] },
  }),
  defineEvent({
    type: 'lot.blocked',
    context: 'quality',
    description: 'A released lot was blocked (a later chromium VI FAIL, or a finding with its reason): not usable; the work orders it went to are named.',
    payload: z.strictObject({
      lotId: z.uuid(),
      code: z.string(),
      itemId: z.uuid(),
      cause: z.enum(['CR_VI_FAIL', 'FINDING']),
      /** Every work order that took stock of the lot (the issue ledger). */
      workOrderIds: z.array(z.uuid()),
    }),
    live: { permission: 'quality.lots.view', fields: ['lotId', 'code', 'cause'] },
  }),
  defineEvent({
    type: 'quality.settings_changed',
    context: 'quality',
    description: 'What counts as chromium VI evidence (Q14) changed, for a company or tenant-wide.',
    payload: z.strictObject({ companyId: z.uuid().nullable(), crViEvidenceRule: z.enum(EVIDENCE_RULES), previousRule: z.enum(EVIDENCE_RULES), loosened: z.boolean() }),
    live: { permission: 'quality.lots.view', fields: ['companyId', 'crViEvidenceRule'] },
  }),
] as const
