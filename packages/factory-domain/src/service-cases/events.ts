import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Warranty and service cases (B-W2b-345; SAL-368, SAL-436). apps/factory-api's modules/sales/service emits them in the
 * command that makes the change. Their own module folder (as repairs-depth/events.ts; check-event-contract wants
 * src/<module>/events.ts): the rules are factory-domain sales/service. A repair or a return a case opens also emits its own
 * module's `repair.created` / `return.authorised` (and `return.remake_asked` for a remake) in the same command; a status mail
 * to the customer is email out's `email.queued`.
 *
 *   service_case.opened          a case was opened (NEW), by the office from a call, a mail or a visit
 *   service_case.changed         its facts changed (the fields named: the garment, the customer, the warranty days, the
 *                                owner, whether the customer is told at each status change …)
 *   service_case.cover_decided   its cover was decided: under the legal guarantee or the factory's own, covered, partly or
 *                                not covered
 *   service_case.status_changed  it moved (open, waiting, resolved, reopened, closed); `notified` when a status mail to the
 *                                customer went with the move
 *   service_case.linked          a record was linked to it or unlinked (by hand, or the record a case's action opened)
 *
 * Reach the office's service screens (sales.service.view over the case's company): ids, numbers and codes only; never the
 * customer's words, a name, an address or an amount.
 */

const live = { permission: 'sales.service.view' } as const
const status = z.enum(['NEW', 'OPEN', 'WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED', 'CLOSED'])

export const events = [
  defineEvent({
    type: 'service_case.opened',
    context: 'service-cases',
    description: 'A warranty or service case about a garment or a batch was opened (NEW) by the office, from a call, a mail or a visit.',
    payload: z.strictObject({
      caseId: z.uuid(),
      number: z.string(),
      partyId: z.uuid().nullable(),
      kind: z.enum(['WARRANTY', 'COMPLAINT', 'REPAIR', 'QUESTION', 'SAFETY']),
      channel: z.enum(['OFFICE', 'MAIL', 'PHONE', 'PORTAL', 'LINK']),
      garmentSerial: z.string().nullable(),
      garmentBatch: z.string().nullable(),
    }),
    live: { ...live, fields: ['caseId', 'number', 'partyId', 'kind'] },
  }),
  defineEvent({
    type: 'service_case.changed',
    context: 'service-cases',
    description: 'The facts of a service case changed: the fields named (the garment, the customer, the warranty days, the owner, whether the customer is told at each status change).',
    payload: z.strictObject({ caseId: z.uuid(), number: z.string(), fields: z.array(z.string()) }),
    live: { ...live, fields: ['caseId', 'number', 'fields'] },
  }),
  defineEvent({
    type: 'service_case.cover_decided',
    context: 'service-cases',
    description: "The cover of a service case's claim was decided: under the legal guarantee (Directive (EU) 2019/771) or the factory's own, covered, partly or not covered.",
    payload: z.strictObject({ caseId: z.uuid(), number: z.string(), cover: z.enum(['LEGAL_GUARANTEE', 'FACTORY_GUARANTEE', 'NONE']), decision: z.enum(['COVERED', 'PARTLY', 'NOT_COVERED']) }),
    live: { ...live, fields: ['caseId', 'number', 'cover', 'decision'] },
  }),
  defineEvent({
    type: 'service_case.status_changed',
    context: 'service-cases',
    description: 'A service case moved (opened, waiting for the customer or a part, resolved, reopened, closed); notified: a status mail to the customer went with the move.',
    payload: z.strictObject({ caseId: z.uuid(), number: z.string(), from: status, to: status, notified: z.boolean() }),
    live: { ...live, fields: ['caseId', 'number', 'from', 'to'] },
  }),
  defineEvent({
    type: 'service_case.linked',
    context: 'service-cases',
    description: 'A record was linked to a service case or unlinked: by hand, or the repair, return, remake or credit the case opened.',
    payload: z.strictObject({
      caseId: z.uuid(),
      number: z.string(),
      linkId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      change: z.enum(['LINKED', 'UNLINKED']),
      via: z.enum(['LINK', 'REPAIR', 'RETURN', 'REMAKE', 'CREDIT']),
    }),
    live: { ...live, fields: ['caseId', 'number', 'recordType', 'recordId', 'change'] },
  }),
] as const
