import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CHANGE_KINDS, CHANGE_STATUSES, IMPACTS, REGULATION_STATUSES } from '../compliance/register-of-rules/rules'
import { OPERATOR_ROLES } from '../compliance/operators/rules'
import { TRANSLATION_STATUSES } from '../compliance/phrases/rules'

/**
 * Rules & markets' events (B-W2b-249; the code is factory-domain compliance/{register-of-rules,markets,operators,phrases}).
 * A module folder of its own, as textile-rules and plant-dies (the event guard wants `src/<module>/events.ts`).
 * apps/factory-api's modules/compliance/{register-of-rules,markets,operators,phrases} emit them in the command that makes
 * the change (design compliance.settings live: "settings.changed → 'Changed by … · 10:42' under each card; gates re-read").
 *
 *   compliance_rules.standard_changed     an entry of the register of laws and standards was added, edited, moved to
 *                                         another status or removed (a row typed by mistake)
 *   compliance_rules.change_raised        a change to a standard was recorded, by a person or raised by the register when
 *                                         an entry was superseded or withdrawn; it names the certificates it touches
 *   compliance_rules.change_moved         a change was assessed (with the type-change reviews it opened), got its impact
 *                                         task, or was closed
 *   compliance_rules.market_changed       a market was added, edited, switched on or off, archived or restored
 *   compliance_rules.operator_changed     an economic operator row was added or edited (ended by its last day)
 *   compliance_rules.phrase_changed       a phrase was added, got new source words (a new revision), archived or restored
 *   compliance_rules.translation_changed  a translation was proposed, approved (superseding the one before) or withdrawn
 *
 * Live for compliance.certificates.view (who reads Rules & markets, the labels and the DoCs). Ids, codes, keys, kinds and
 * states only: no words a person typed.
 */
const live = { permission: 'compliance.certificates.view' } as const

export const events = [
  defineEvent({
    type: 'compliance_rules.standard_changed',
    context: 'compliance-rules',
    description: 'An entry of the register of laws and standards was added, edited, moved to another status or removed.',
    payload: z.strictObject({
      standardId: z.uuid(),
      code: z.string(),
      edition: z.string().nullable(),
      status: z.enum(REGULATION_STATUSES),
      change: z.enum(['CREATED', 'EDITED', 'STATUS', 'DELETED']),
    }),
    live: { ...live, fields: ['standardId', 'code', 'edition', 'status', 'change'] },
  }),
  defineEvent({
    type: 'compliance_rules.change_raised',
    context: 'compliance-rules',
    description: 'A change to a standard in the register was recorded (or raised when the entry was superseded or withdrawn), naming the certificates it touches.',
    payload: z.strictObject({
      changeId: z.uuid(),
      standardId: z.uuid(),
      kind: z.enum(CHANGE_KINDS),
      raisedBy: z.enum(['PERSON', 'REGISTER']),
      certificates: z.number().int().min(0),
    }),
    live: { ...live, fields: ['changeId', 'standardId', 'kind', 'raisedBy', 'certificates'] },
  }),
  defineEvent({
    type: 'compliance_rules.change_moved',
    context: 'compliance-rules',
    description: 'A change to a standard was assessed (opening the type-change reviews it needs), given its impact task, or closed.',
    payload: z.strictObject({
      changeId: z.uuid(),
      standardId: z.uuid(),
      status: z.enum(CHANGE_STATUSES),
      impact: z.enum(IMPACTS).nullable(),
      move: z.enum(['ASSESSED', 'TASK', 'CERTIFICATES', 'CLOSED']),
      taskId: z.uuid().nullable(),
      reviews: z.number().int().min(0),
    }),
    live: { ...live, fields: ['changeId', 'standardId', 'status', 'impact', 'move'] },
  }),
  defineEvent({
    type: 'compliance_rules.market_changed',
    context: 'compliance-rules',
    description: 'A market profile was added, edited, switched on or off (with the reason), archived or restored.',
    payload: z.strictObject({
      marketId: z.uuid(),
      code: z.string(),
      change: z.enum(['CREATED', 'EDITED', 'SWITCHED', 'ARCHIVED', 'RESTORED']),
      switchedOn: z.boolean(),
    }),
    live: { ...live, fields: ['code', 'change', 'switchedOn'] },
  }),
  defineEvent({
    type: 'compliance_rules.operator_changed',
    context: 'compliance-rules',
    description: 'An economic operator (manufacturer, authorised representative, importer, distributor, fulfilment) was named or edited for a style, brand or default and market.',
    payload: z.strictObject({
      operatorId: z.uuid(),
      role: z.enum(OPERATOR_ROLES),
      styleId: z.uuid().nullable(),
      brandPartyId: z.uuid().nullable(),
      marketCode: z.string().nullable(),
      change: z.enum(['CREATED', 'EDITED']),
    }),
    live: { ...live, fields: ['operatorId', 'role', 'styleId', 'marketCode', 'change'] },
  }),
  defineEvent({
    type: 'compliance_rules.phrase_changed',
    context: 'compliance-rules',
    description: 'A phrase of the library was added, got new source words (a new revision), was archived or restored.',
    payload: z.strictObject({
      phraseId: z.uuid(),
      key: z.string(),
      revision: z.number().int().min(1),
      change: z.enum(['CREATED', 'EDITED', 'REVISED', 'ARCHIVED', 'RESTORED']),
    }),
    live: { ...live, fields: ['phraseId', 'key', 'revision', 'change'] },
  }),
  defineEvent({
    type: 'compliance_rules.translation_changed',
    context: 'compliance-rules',
    description: 'A translation of a phrase was proposed, approved by a second person (superseding the one before) or withdrawn.',
    payload: z.strictObject({
      phraseId: z.uuid(),
      key: z.string(),
      translationId: z.uuid(),
      language: z.string(),
      revision: z.number().int().min(1),
      status: z.enum(TRANSLATION_STATUSES),
      change: z.enum(['PROPOSED', 'APPROVED', 'WITHDRAWN']),
    }),
    live: { ...live, fields: ['phraseId', 'key', 'language', 'status', 'change'] },
  }),
] as const
