import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECLARATION_KINDS, SUBSTANCE_TESTS } from '../compliance/substances/rules'
import { ASK_CHANNELS, DECLARATION_CHANNELS } from '../compliance/declarations-asked/rules'
import { TEST_FREQUENCIES } from '../compliance/test-plans/rules'

/**
 * Material tests' events (B-W2b-256; the code is factory-domain compliance/{declarations-asked,material-profiles,test-plans}).
 * A module folder of its own, as compliance-substances (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/compliance/{declarations-asked,material-profiles,test-plans} emit them in the command that makes the change (a
 * route, the declarations' hourly job, the handler that takes a supplier's portal upload).
 *
 *   compliance_material_tests.declaration_asked          a declaration request went to a supplier (portal task or by the office)
 *   compliance_material_tests.declaration_extended       materials were added to a supplier's open request of that kind
 *   compliance_material_tests.declaration_reminded       a reminder went out (the portal task) or the office reminded by hand
 *   compliance_material_tests.declaration_answered       the answer came (the supplier's portal upload, or a file the office recorded)
 *   compliance_material_tests.declaration_lines_recorded what the answer says per material was written
 *   compliance_material_tests.declaration_decided        the answer was accepted or refused (the materials re-evaluated)
 *   compliance_material_tests.declaration_overdue        the due day passed without an answer
 *   compliance_material_tests.declaration_cancelled      a request was withdrawn (or asked again by a new one)
 *   compliance_material_tests.profile_changed            a person confirmed a material's composition or tannage, its origin or note
 *   compliance_material_tests.test_plan_changed          a test plan rule was added, edited, switched, archived or restored
 *   compliance_material_tests.result_recorded            a substance test's lab result was recorded on a lot
 *
 * Live for compliance.certificates.view (who reads the declarations, the profiles and the test plans). Ids, numbers, codes,
 * counts and states only: no words a person typed, no name, no price.
 */
const live = { permission: 'compliance.certificates.view' } as const
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const kind = z.enum(DECLARATION_KINDS)
const change = z.enum(['CREATED', 'EDITED', 'SWITCHED', 'ARCHIVED', 'RESTORED'])

export const events = [
  defineEvent({
    type: 'compliance_material_tests.declaration_asked',
    context: 'compliance-material-tests',
    description: 'A declaration request went to a supplier: in its portal (an upload task) or asked by the office.',
    payload: z.strictObject({
      requestId: z.uuid(),
      number: z.string(),
      partyId: z.uuid(),
      kind,
      channel: z.enum(ASK_CHANNELS),
      lines: z.number().int().min(1),
      dueOn: day,
      /** The earlier request of the same supplier and kind it asks again (null: a first ask). */
      supersedesId: z.uuid().nullable(),
    }),
    live: { ...live, fields: ['requestId', 'number', 'partyId', 'kind'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_extended',
    context: 'compliance-material-tests',
    description: "Materials were added to a supplier's open declaration request of that kind (one request per supplier and kind).",
    payload: z.strictObject({ requestId: z.uuid(), number: z.string(), partyId: z.uuid(), kind, added: z.number().int().min(1), lines: z.number().int().min(1) }),
    live: { ...live, fields: ['requestId', 'number', 'partyId', 'added'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_reminded',
    context: 'compliance-material-tests',
    description: 'A declaration request was reminded: its portal task (the supplier is told) or by the office by hand.',
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid(), remindersSent: z.number().int().min(1), by: z.enum(['PERSON', 'SCHEDULE']), channel: z.enum(DECLARATION_CHANNELS) }),
    live: { ...live, fields: ['requestId', 'partyId', 'remindersSent'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_answered',
    context: 'compliance-material-tests',
    description: "A declaration request's answer came: the supplier's upload in its portal, or a file the office recorded.",
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid(), channel: z.enum(DECLARATION_CHANNELS), by: z.enum(['PORTAL', 'OFFICE']) }),
    live: { ...live, fields: ['requestId', 'partyId', 'by'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_lines_recorded',
    context: 'compliance-material-tests',
    description: 'What a declaration says per material was written (contains, above the threshold, the substance).',
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid(), lines: z.number().int().min(0), answered: z.number().int().min(0) }),
    live: { ...live, fields: ['requestId', 'answered', 'lines'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_decided',
    context: 'compliance-material-tests',
    description: "A supplier's declaration was accepted or refused; the materials it covers were evaluated again.",
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid(), kind, outcome: z.enum(['ACCEPTED', 'REFUSED']), validTo: day.nullable(), materials: z.number().int().min(0) }),
    live: { ...live, fields: ['requestId', 'partyId', 'outcome'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_overdue',
    context: 'compliance-material-tests',
    description: "A declaration request's due day passed without an answer.",
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid(), dueOn: day }),
    live: { ...live, fields: ['requestId', 'partyId', 'dueOn'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.declaration_cancelled',
    context: 'compliance-material-tests',
    description: 'A declaration request was withdrawn, or asked again by a new request.',
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid(), supersededById: z.uuid().nullable() }),
    live: { ...live, fields: ['requestId', 'partyId'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.profile_changed',
    context: 'compliance-material-tests',
    description: "A person confirmed a material's composition or tannage, or changed its origin or note; the material was evaluated again.",
    payload: z.strictObject({ itemId: z.uuid(), changed: z.array(z.enum(['COMPOSITION', 'TANNAGE', 'ORIGIN', 'NOTE'])), state: z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED']) }),
    live: { ...live, fields: ['itemId', 'changed', 'state'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.test_plan_changed',
    context: 'compliance-material-tests',
    description: 'A test plan rule was added, edited, switched on or off, archived or restored.',
    payload: z.strictObject({ planId: z.uuid(), test: z.enum(SUBSTANCE_TESTS), frequency: z.enum(TEST_FREQUENCIES), switchedOn: z.boolean(), change }),
    live: { ...live, fields: ['planId', 'test', 'switchedOn', 'change'] },
  }),
  defineEvent({
    type: 'compliance_material_tests.result_recorded',
    context: 'compliance-material-tests',
    description: "A substance test's lab result was recorded on a lot, judged against its substance rule's limit; the material was evaluated again.",
    payload: z.strictObject({ resultId: z.uuid(), lotId: z.uuid(), itemId: z.uuid(), test: z.enum(SUBSTANCE_TESTS), verdict: z.enum(['PASS', 'FAIL']), ruleId: z.uuid() }),
    live: { ...live, fields: ['resultId', 'lotId', 'test', 'verdict'] },
  }),
]
