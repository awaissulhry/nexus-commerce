import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Remakes, exchanges and closing a return (B-W2b-346; SAL-298, SAL-350, SAL-351, SAL-355, SAL-360). apps/factory-api's
 * modules/sales/returns-outcomes emits them in the command that makes the change. Their own module folder (as
 * returns-depth/events.ts; check-event-contract wants src/<module>/events.ts): the rules are factory-domain
 * sales/returns-outcomes. A size exchange is decided with W2a's `return.decided` (its replacement line with W2a's
 * `return.replacement_ordered`); a close also emits W2a's `return.status_changed` (to CLOSED).
 *
 *   return.remake_asked  a remake was asked with photos for lines of a return (made-to-measure fit): by the office on an
 *                        RMA it made, or by the customer in the portal or through a claim link (a REQUESTED RMA)
 *   return.line_split    a line of which only part arrived was split: it keeps what arrived, a new line takes the rest,
 *                        still expected
 *   return.sent_back     lines go back to the customer as they came, after the inspection, with the return DDT that
 *                        carries them (issued in the same command, or none yet)
 *   return.finished      a return was closed with its finish reason
 *
 * Reach the office's returns screens (sales.returns.view over the RMA's company and site; the split also the dock's):
 * ids, numbers and codes only; never an amount, a name or the customer's words.
 */

const live = { permission: 'sales.returns.view' } as const

export const events = [
  defineEvent({
    type: 'return.remake_asked',
    context: 'returns-outcomes',
    description: 'A remake was asked with photos for lines of a customer return (made-to-measure fit): by the office, or by the customer in the portal or through a claim link.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), lineIds: z.array(z.uuid()), via: z.enum(['OFFICE', 'PORTAL', 'LINK']) }),
    live: { ...live, fields: ['returnId', 'number', 'lineIds', 'via'] },
  }),
  defineEvent({
    type: 'return.line_split',
    context: 'returns-outcomes',
    description: 'A line of a customer return of which only part arrived was split: it keeps the pieces that arrived, and a new line split from it takes the rest, still expected.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), lineId: z.uuid(), newLineId: z.uuid(), kept: z.number().int(), rest: z.number().int() }),
    live: { ...live, floor: 'sales.returns.receive', fields: ['returnId', 'number', 'lineId', 'newLineId', 'kept', 'rest'] },
  }),
  defineEvent({
    type: 'return.sent_back',
    context: 'returns-outcomes',
    description: 'Lines of a customer return go back to the customer as they came, after the inspection, with the return DDT that carries them (or none issued yet).',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), lineIds: z.array(z.uuid()), decidedLineIds: z.array(z.uuid()), ddtId: z.uuid().nullable(), ddtNumber: z.string().nullable() }),
    live: { ...live, fields: ['returnId', 'number', 'lineIds', 'ddtId', 'ddtNumber'] },
  }),
  defineEvent({
    type: 'return.finished',
    context: 'returns-outcomes',
    description: 'A customer return was closed with its finish reason (completed, credited without a return, sent back unchanged, the goods never came, the customer withdrew, or other).',
    payload: z.strictObject({
      returnId: z.uuid(),
      number: z.string(),
      finishReason: z.enum(['COMPLETED', 'CREDITED_WITHOUT_RETURN', 'RETURNED_UNCHANGED', 'GOODS_NOT_RECEIVED', 'CUSTOMER_WITHDREW', 'OTHER']),
      from: z.enum(['AUTHORISED', 'RECEIVED', 'INSPECTED']),
    }),
    live: { ...live, fields: ['returnId', 'number', 'finishReason'] },
  }),
] as const
