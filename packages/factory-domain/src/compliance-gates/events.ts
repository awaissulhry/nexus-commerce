import { z } from 'zod'
import { defineEvent } from '../events/define'
import { COMPLIANCE_GATES } from '../compliance/requirements/rules'

/**
 * Requirements and gates' events (B-W2b-254; the code is factory-domain compliance/{requirements,gates,status}). A module
 * folder of its own, as compliance-rules (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/compliance/{requirements,gates} emit them in the command that makes the change (design compliance.status live:
 * "gate.refused / gate.overridden → Gate refusals feed"; compliance.settings: "settings.changed → gates re-read").
 *
 *   compliance_gates.requirement_changed  a requirement was added, edited (tightened or loosened), switched on or off,
 *                                         archived or restored
 *   compliance_gates.refused              a gate refused a work order or a shipment (the GateEvent REFUSED)
 *   compliance_gates.overridden           a person with a named role overrode a refusal for one subject (OVERRIDDEN)
 *
 * Live for compliance.certificates.view (who reads Rules & markets and the status board). Ids, codes, gates and states
 * only: no words a person typed.
 */
const live = { permission: 'compliance.certificates.view' } as const
const gate = z.enum(COMPLIANCE_GATES)

export const events = [
  defineEvent({
    type: 'compliance_gates.requirement_changed',
    context: 'compliance-gates',
    description: 'A compliance requirement was added, edited (tightened or loosened), switched on or off, archived or restored.',
    payload: z.strictObject({
      requirementId: z.uuid(),
      code: z.string(),
      change: z.enum(['CREATED', 'EDITED', 'SWITCHED', 'ARCHIVED', 'RESTORED']),
      switchedOn: z.boolean(),
      loosened: z.boolean(),
    }),
    live: { ...live, fields: ['requirementId', 'code', 'change', 'switchedOn', 'loosened'] },
  }),
  defineEvent({
    type: 'compliance_gates.refused',
    context: 'compliance-gates',
    description: 'A compliance gate refused a work order or a shipment: the first missing requirement, recorded as a gate event.',
    payload: z.strictObject({
      gateEventId: z.uuid(),
      gate,
      subjectType: z.string(),
      subjectId: z.uuid(),
      requirementId: z.uuid(),
      requirementCode: z.string(),
      styleId: z.uuid().nullable(),
      marketCode: z.string().nullable(),
    }),
    live: { ...live, fields: ['gateEventId', 'gate', 'subjectType', 'subjectId', 'requirementCode', 'styleId', 'marketCode'] },
  }),
  defineEvent({
    type: 'compliance_gates.overridden',
    context: 'compliance-gates',
    description: 'A person with a role the requirement names overrode a gate refusal for one work order or shipment, until a time.',
    payload: z.strictObject({
      gateEventId: z.uuid(),
      refusedEventId: z.uuid(),
      gate,
      subjectType: z.string(),
      subjectId: z.uuid(),
      requirementId: z.uuid(),
      requirementCode: z.string(),
      overrideUntil: z.string(),
    }),
    live: { ...live, fields: ['gateEventId', 'refusedEventId', 'gate', 'subjectType', 'subjectId', 'requirementCode', 'overrideUntil'] },
  }),
] as const
