import { z } from 'zod'
import { defineEvent } from '../events/define'
import { AMENDED_RECORDS, AMENDED_ROWS } from '../quality/amendments/rules'

/**
 * Amendments of signed results (B-W2b-123; QHS-145; design quality.inspections "inspection.signed → record band pill and
 * lock banner", the Decision tab's Amendments and the list's "Amended results" view). apps/factory-api's
 * modules/quality/amendments emits them in the commands that write an InspectionAmendment row. Its own module folder (as
 * quality-capa, quality-incoming): the quality events file is other steps'.
 *
 *   inspection_amendment.requested   a correction of a signed record was asked: it waits for the second signature
 *   inspection_amendment.answered    a second person signed it (it stands) or refused it (the record stays as it was)
 *
 * Reach the office's quality screens of people who answer and ask for corrections (over the record's company and site):
 * ids, the record kind and the field only; never a value, a reason or a person. Never the floor.
 */

const record = { amendmentId: z.uuid(), recordType: z.enum(AMENDED_RECORDS), recordId: z.uuid() }

export const events = [
  defineEvent({
    type: 'inspection_amendment.requested',
    context: 'quality-amendments',
    description: 'A correction of a signed inspection or check was asked, with its reason: it waits for a second signature.',
    payload: z.strictObject({ ...record, field: z.string().min(1).max(80), rowType: z.enum(AMENDED_ROWS).nullable() }),
    live: { permission: 'quality.amendments.sign', fields: ['amendmentId', 'recordType', 'recordId', 'field', 'rowType'] },
  }),
  defineEvent({
    type: 'inspection_amendment.answered',
    context: 'quality-amendments',
    description: 'A second person signed a correction of a signed inspection or check (it stands now), or refused it with the reason.',
    payload: z.strictObject({ ...record, requestId: z.uuid(), answer: z.enum(['SIGNED', 'REFUSED']) }),
    live: { permission: 'quality.amendments.request', fields: ['amendmentId', 'recordType', 'recordId', 'requestId', 'answer'] },
  }),
] as const
