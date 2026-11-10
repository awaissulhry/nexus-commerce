import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DISTRIBUTOR_CHANNELS, DISTRIBUTOR_STATUSES, NOTICE_DECISIONS, NOTICE_STATUSES, RECALL_KINDS, RECALL_STATUSES, REQUEST_STATUSES } from '../compliance/recall/rules'

/**
 * Recall, withdrawal and authority's events (B-W2b-260; the code is factory-domain compliance/recall). A module folder of its
 * own, as compliance-techfiles (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/compliance/recall
 * emits them in the command that makes the change (design compliance.register live: the Authority notices tab, the recall
 * progress and the distributor log in the Actions tab, the tiles "authority notices due or sent" and "recalls in progress").
 *
 *   authority_notice.changed    a notice to a market surveillance authority was drafted, edited, marked as sent by a
 *                               person, given the authority's reference or its copy, or cancelled
 *   recall.changed              a recall or a withdrawal was drafted, edited, widened, started, had holds placed on what is
 *                               still here, its public notice published or taken down, closed or cancelled
 *   recall.progress_changed     a customer's progress row was added or its counts recorded (returned, repaired, destroyed)
 *   distributor_notice.changed  a notice to a distributor was drafted, edited, sent, answered, failed or cancelled
 *   authority_request.changed   an authority request was logged, corrected, given its register entry or its evidence,
 *                               answered or cancelled
 *
 * Live for compliance.register.view (who reads the register these hang on). Ids, numbers, codes, kinds, states and garment
 * counts only: no words a person typed, no contact, no person.
 */
const live = { permission: 'compliance.register.view' } as const

export const events = [
  defineEvent({
    type: 'authority_notice.changed',
    context: 'compliance-recall',
    description: 'A notice to a market surveillance authority was drafted, edited, marked as sent, given its reference or copy, or cancelled.',
    payload: z.strictObject({
      noticeId: z.uuid(),
      entryId: z.uuid(),
      marketCode: z.string(),
      decision: z.enum(NOTICE_DECISIONS),
      status: z.enum(NOTICE_STATUSES),
      change: z.enum(['DRAFTED', 'EDITED', 'SENT', 'REFERENCE', 'CANCELLED']),
    }),
    live: { ...live, fields: ['noticeId', 'entryId', 'marketCode', 'decision', 'status', 'change'] },
  }),
  defineEvent({
    type: 'recall.changed',
    context: 'compliance-recall',
    description: 'A recall or withdrawal was drafted, edited, widened, started, had holds placed, its public notice published or taken down, closed or cancelled.',
    payload: z.strictObject({
      recallId: z.uuid(),
      number: z.string(),
      entryId: z.uuid(),
      kind: z.enum(RECALL_KINDS),
      styleId: z.uuid(),
      status: z.enum(RECALL_STATUSES),
      change: z.enum(['DRAFTED', 'EDITED', 'WIDENED', 'STARTED', 'HOLDS_PLACED', 'NOTICE_PUBLISHED', 'NOTICE_WITHDRAWN', 'CLOSED', 'CANCELLED']),
    }),
    live: { ...live, fields: ['recallId', 'number', 'entryId', 'kind', 'styleId', 'status', 'change'] },
  }),
  defineEvent({
    type: 'recall.progress_changed',
    context: 'compliance-recall',
    description: "A customer's progress row of a recall or withdrawal was added or its counts recorded.",
    payload: z.strictObject({
      recallId: z.uuid(),
      progressId: z.uuid(),
      partyId: z.uuid(),
      shipmentId: z.uuid().nullable(),
      unitsSent: z.number().int().min(0),
      unitsStillOut: z.number().int().min(0),
      change: z.enum(['ADDED', 'RECORDED']),
    }),
    live: { ...live, fields: ['recallId', 'progressId', 'partyId', 'shipmentId', 'unitsSent', 'unitsStillOut', 'change'] },
  }),
  defineEvent({
    type: 'distributor_notice.changed',
    context: 'compliance-recall',
    description: 'A notice to a distributor was drafted, edited, sent, answered, failed or cancelled.',
    payload: z.strictObject({
      noticeId: z.uuid(),
      entryId: z.uuid(),
      recallId: z.uuid().nullable(),
      partyId: z.uuid(),
      channel: z.enum(DISTRIBUTOR_CHANNELS),
      status: z.enum(DISTRIBUTOR_STATUSES),
      change: z.enum(['DRAFTED', 'EDITED', 'SENT', 'ANSWERED', 'FAILED', 'CANCELLED']),
    }),
    live: { ...live, fields: ['noticeId', 'entryId', 'recallId', 'partyId', 'channel', 'status', 'change'] },
  }),
  defineEvent({
    type: 'authority_request.changed',
    context: 'compliance-recall',
    description: 'An authority request was logged, corrected, given its register entry or its evidence, answered or cancelled.',
    payload: z.strictObject({
      requestId: z.uuid(),
      number: z.string(),
      status: z.enum(REQUEST_STATUSES),
      dueOn: z.iso.date(),
      entryId: z.uuid().nullable(),
      change: z.enum(['LOGGED', 'EDITED', 'ENTRY_LINKED', 'EVIDENCE', 'ANSWERED', 'CANCELLED']),
    }),
    live: { ...live, fields: ['requestId', 'number', 'status', 'dueOn', 'entryId', 'change'] },
  }),
] as const
