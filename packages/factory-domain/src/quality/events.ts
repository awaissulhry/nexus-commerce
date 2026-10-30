import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CR_VI_EVIDENCE, EVIDENCE_RULES, LAB_TESTS, LOT_DOCUMENT_KINDS } from './lab/rules'
import { FOUR_EYES_RULES, REVERSAL_REASONS, SECOND_PERSON_REASONS, SERIALS_TO } from './release/rules'
// B-W2a-26: the defect library, the disposition codes and quality holds.
import { DEFECT_LIBRARY_CHANGES, DISPOSITION_CODE_CHANGES, HOLD_CHANGED_FIELDS } from './holds/changes'
import { HOLD_QUARANTINE, HOLD_SUBJECT_TYPES } from './holds/rules'

/**
 * The quality module's events (plan A1 §3.4). The lab step (B-W1-34, modules/quality/lab) emits them in the command that
 * decides: `lot.test_recorded` once per lab result of a lot (a later FAIL on a released lot also emits `lot.blocked`
 * with the work orders it went to), `lot.document_attached` once per supplier document, `lot.hold_cleared` when the
 * receiver's hold is cleared, `lot.released` when a lot leaves quarantine or a blocked lot is released again (its
 * stock is usable: planning nets it, the pick list offers it), `lot.rejected` (final) and `lot.blocked`;
 * `quality.settings_changed` when the Cr VI evidence rule changes. They reach the lot, receipt, stock and test screens of
 * the office (quality.lots.view). No cost, price or person's name in a payload.
 *
 * The final inspection and release (B-W1-45, modules/quality/final): `quality.inspection_opened`, `…_decided` (PASSED or
 * FAILED, the computed result, an override), `…_cancelled`; `quality.garments_released` once per release (why a second
 * person signed, if one did), `quality.release_reversed` once per reversal (the PPE register entry it opened), and
 * `quality.release_rule_changed` when the four-eyes rule or its list of customers changes (Q1). They reach the
 * inspection screens of the office (quality.inspections.view) and the site's floor devices (the bench).
 *
 * The defect library, the disposition codes and quality holds (B-W2a-26, modules/quality/{defects,holds}):
 * `quality.defects_changed` / `quality.dispositions_changed` when codes are added, changed, retired or deleted (the
 * pickers read the library again); `quality.hold_placed` once per hold (the work orders it put ON_HOLD),
 * `quality.hold_released` once per release (the work orders it lifted), `quality.hold_changed` when its owner, expected
 * release or notes change. Holds reach the office's hold screens (quality.holds.view) and the site's floor devices (an
 * open card of a held bundle, lot or work order holds its action with the reason). No cost, price or name in a payload.
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
  defineEvent({
    type: 'quality.inspection_opened',
    context: 'quality',
    description: "A final inspection of a work order's finished garments was opened (at the bench or in the office).",
    // number: the work order's; inspectionNumber: the inspection's own (its company's INSPECTION series).
    payload: z.strictObject({ inspectionId: z.uuid(), inspectionNumber: z.string(), workOrderId: z.uuid(), number: z.string(), lotSize: z.number().int(), postedBy: z.enum(['FLOOR', 'OFFICE']) }),
    live: { permission: 'quality.inspections.view', floor: true, fields: ['inspectionId', 'inspectionNumber', 'workOrderId', 'number'] },
  }),
  defineEvent({
    type: 'quality.inspection_decided',
    context: 'quality',
    description: 'A final inspection was signed: PASSED or FAILED, with the computed result and whether the inspector overrode it (QHS-013).',
    payload: z.strictObject({
      inspectionId: z.uuid(),
      workOrderId: z.uuid(),
      number: z.string(),
      status: z.enum(['PASSED', 'FAILED']),
      computedResult: z.enum(['PASS', 'FAIL']),
      overridden: z.boolean(),
      postedBy: z.enum(['FLOOR', 'OFFICE']),
    }),
    live: { permission: 'quality.inspections.view', floor: true, fields: ['inspectionId', 'workOrderId', 'number', 'status'] },
  }),
  defineEvent({
    type: 'quality.inspection_cancelled',
    context: 'quality',
    description: 'An open final inspection was abandoned (started by mistake), with the reason.',
    payload: z.strictObject({ inspectionId: z.uuid(), workOrderId: z.uuid(), number: z.string() }),
    live: { permission: 'quality.inspections.view', floor: true, fields: ['inspectionId', 'workOrderId', 'number'] },
  }),
  defineEvent({
    type: 'quality.garments_released',
    context: 'quality',
    description: "Garments of a work order's cell were released to be packed and shipped (QHS-058), by an inspector who made none of them; why a second person signed, if one had to.",
    payload: z.strictObject({
      releaseId: z.uuid(),
      /** The release's own number (its company's RELEASE series); `number` is the work order's. */
      releaseNumber: z.string(),
      inspectionId: z.uuid(),
      workOrderId: z.uuid(),
      number: z.string(),
      workOrderSizeId: z.uuid(),
      quantity: z.number().int(),
      serialIds: z.array(z.uuid()),
      secondPersonReasons: z.array(z.enum(SECOND_PERSON_REASONS)),
      postedBy: z.enum(['FLOOR', 'OFFICE']),
    }),
    live: { permission: 'quality.inspections.view', floor: true, fields: ['releaseId', 'releaseNumber', 'workOrderId', 'number', 'workOrderSizeId'] },
  }),
  defineEvent({
    type: 'quality.release_reversed',
    context: 'quality',
    description: 'Released garments were taken back before they shipped (corrective action, Reg. 2016/425 art. 8(8)); serials back to rework or scrapped; the PPE register entry it opened.',
    payload: z.strictObject({
      reversalId: z.uuid(),
      releaseId: z.uuid(),
      workOrderId: z.uuid(),
      number: z.string(),
      workOrderSizeId: z.uuid(),
      quantity: z.number().int(),
      reasonCode: z.enum(REVERSAL_REASONS),
      serialIds: z.array(z.uuid()),
      serialsTo: z.enum(SERIALS_TO).nullable(),
      registerEntryId: z.uuid().nullable(),
    }),
    live: { permission: 'quality.inspections.view', floor: true, fields: ['reversalId', 'releaseId', 'workOrderId', 'number', 'workOrderSizeId'] },
  }),
  defineEvent({
    type: 'quality.release_rule_changed',
    context: 'quality',
    description: 'Who releases finished garments changed (Owner answer Q1): the four-eyes rule or the customers that always need a second person, for a company or tenant-wide.',
    payload: z.strictObject({
      companyId: z.uuid().nullable(),
      releaseFourEyes: z.enum(FOUR_EYES_RULES).nullable(),
      previousRule: z.enum(FOUR_EYES_RULES).nullable(),
      customersAdded: z.array(z.uuid()),
      customersRemoved: z.array(z.uuid()),
      loosened: z.boolean(),
    }),
    live: { permission: 'quality.inspections.view', fields: ['companyId', 'releaseFourEyes'] },
  }),
  // ---- B-W2a-26: the defect library, the disposition codes, quality holds -------------------------------------------
  defineEvent({
    type: 'quality.defects_changed',
    context: 'quality',
    description: 'Codes of the defect library were added, changed, retired, made active again or deleted, or the starter set was added: pickers read the library again.',
    payload: z.strictObject({ change: z.enum(DEFECT_LIBRARY_CHANGES), codes: z.array(z.string().min(1).max(40)).min(1).max(500) }),
    live: { permission: 'quality.defects.view', fields: ['change', 'codes'] },
  }),
  defineEvent({
    type: 'quality.dispositions_changed',
    context: 'quality',
    description: 'Disposition codes were added, changed, set inactive or active again, or the standard ones were added.',
    payload: z.strictObject({ change: z.enum(DISPOSITION_CODE_CHANGES), codes: z.array(z.string().min(1).max(40)).min(1).max(100) }),
    live: { permission: 'quality.defects.view', fields: ['change', 'codes'] },
  }),
  defineEvent({
    type: 'quality.hold_placed',
    context: 'quality',
    description: 'Goods were put on hold (QHS-074, MES-008): lots, hides, work orders, bundles, garment serials, shipments or parcels of one site; the work orders it put ON_HOLD.',
    payload: z.strictObject({
      holdId: z.uuid(),
      subjectType: z.enum(HOLD_SUBJECT_TYPES),
      subjectIds: z.array(z.uuid()).min(1).max(100),
      reasonCode: z.string().min(1).max(40),
      sourceType: z.string().nullable(),
      sourceId: z.uuid().nullable(),
      placedBy: z.enum(['USER', 'WORKER', 'SYSTEM']),
      quarantine: z.enum(HOLD_QUARANTINE),
      workOrdersHeld: z.array(z.uuid()),
    }),
    live: { permission: 'quality.holds.view', floor: true, fields: ['holdId', 'subjectType', 'subjectIds', 'workOrdersHeld'] },
  }),
  defineEvent({
    type: 'quality.hold_released',
    context: 'quality',
    description: 'A hold was released with an e-signature by someone other than who placed it (and, for garments, who made them); the work orders it lifted back to where they were.',
    payload: z.strictObject({
      holdId: z.uuid(),
      subjectType: z.enum(HOLD_SUBJECT_TYPES),
      subjectIds: z.array(z.uuid()).min(1).max(100),
      workOrdersLifted: z.array(z.uuid()),
    }),
    live: { permission: 'quality.holds.view', floor: true, fields: ['holdId', 'subjectType', 'subjectIds', 'workOrdersLifted'] },
  }),
  defineEvent({
    type: 'quality.hold_changed',
    context: 'quality',
    description: "A hold's owner, expected release or notes changed.",
    payload: z.strictObject({ holdId: z.uuid(), fields: z.array(z.enum(HOLD_CHANGED_FIELDS)).min(1) }),
    live: { permission: 'quality.holds.view', fields: ['holdId', 'fields'] },
  }),
] as const
