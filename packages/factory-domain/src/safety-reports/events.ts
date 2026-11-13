import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Product-safety reports and the accident log (B-W2b-351; SAL-414, SAL-415, SAL-423). apps/factory-api's
 * modules/sales/safety-reports emits them in the command that makes the change. Their own module folder (as service-cases/
 * events.ts; check-event-contract wants src/<module>/events.ts): the rules are factory-domain sales/safety-reports. The SAFETY
 * case a report opens emits service_case.opened in the same command; a register entry it opens compliance.register_entry_opened.
 *
 *   safety_report.received        a report reached us (NEW): from the public DoC page, a customer's portal or the office
 *   safety_report.changed         its facts changed (the fields named; `injury`: whether someone was hurt was recorded later)
 *   safety_report.status_changed  it moved (seen, assessing, closed)
 *   safety_report.filed           it was filed in the PPE register (an entry named, or one opened for it)
 *   safety_report.erased          on request: the reporter's personal data, or the injury's words, blanked
 *   accident_log.revised          a revision of its accident log entry (1: the accident recorded; later: corrected, completed,
 *                                 the authority told)
 *
 * Reach the office's safety screens (sales.safety.view over the report's company): ids, numbers and codes only; never the
 * reporter's words, a name, whether someone was hurt, nor anything of an injury.
 */

const live = { permission: 'sales.safety.view' } as const
const status = z.enum(['NEW', 'ASSESSING', 'CLOSED'])

export const events = [
  defineEvent({
    type: 'safety_report.received',
    context: 'safety-reports',
    description: "A product-safety report reached us (NEW), from the public DoC page, a customer's portal or the office, with the SAFETY service case it opened.",
    payload: z.strictObject({
      reportId: z.uuid(),
      number: z.string(),
      source: z.enum(['PUBLIC_LINK', 'PORTAL', 'OFFICE', 'MAIL']),
      partyId: z.uuid().nullable(),
      serviceCaseId: z.uuid(),
      garmentSerial: z.string().nullable(),
      garmentBatch: z.string().nullable(),
      accidentLogged: z.boolean(),
    }),
    live: { ...live, fields: ['reportId', 'number', 'source', 'serviceCaseId'] },
  }),
  defineEvent({
    type: 'safety_report.changed',
    context: 'safety-reports',
    description: 'The facts of a product-safety report changed: the fields named (the garment, the day, the owner; injury: whether someone was hurt was recorded later).',
    payload: z.strictObject({ reportId: z.uuid(), number: z.string(), fields: z.array(z.string()) }),
    live: { ...live, fields: ['reportId', 'number', 'fields'] },
  }),
  defineEvent({
    type: 'safety_report.status_changed',
    context: 'safety-reports',
    description: 'A product-safety report moved: seen by quality, being assessed, closed.',
    payload: z.strictObject({ reportId: z.uuid(), number: z.string(), from: status, to: status, seen: z.boolean() }),
    live: { ...live, fields: ['reportId', 'number', 'from', 'to'] },
  }),
  defineEvent({
    type: 'safety_report.filed',
    context: 'safety-reports',
    description: 'A product-safety report was filed in the PPE register: an existing entry named, or one opened for it.',
    payload: z.strictObject({ reportId: z.uuid(), number: z.string(), registerEntryId: z.uuid(), opened: z.boolean() }),
    live: { ...live, fields: ['reportId', 'number', 'registerEntryId'] },
  }),
  defineEvent({
    type: 'safety_report.erased',
    context: 'safety-reports',
    description: "On request (GDPR art. 17): the reporter's personal data, or the injury's words, of a product-safety report were erased.",
    payload: z.strictObject({ reportId: z.uuid(), number: z.string(), what: z.enum(['REPORTER', 'INJURY_WORDS']) }),
    live: { ...live, fields: ['reportId', 'number', 'what'] },
  }),
  defineEvent({
    type: 'accident_log.revised',
    context: 'safety-reports',
    description: 'A revision of the accident log entry of a product-safety report (GPSR art. 20): the accident recorded, corrected or completed, the authority told.',
    payload: z.strictObject({
      reportId: z.uuid(),
      number: z.string(),
      entryId: z.uuid(),
      revision: z.number().int().min(1),
      outcome: z.enum(['NO_HARM', 'MINOR_HARM', 'SERIOUS_HARM', 'DEATH', 'NOT_KNOWN']),
      authorityTold: z.boolean(),
    }),
    live: { ...live, fields: ['reportId', 'number', 'revision', 'outcome', 'authorityTold'] },
  }),
] as const
