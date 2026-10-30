import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Today's actions (B-W1-52 actions; apps/factory-api modules/insights actions.ts; design home.today "alert →
 * Acknowledge · Assign · Resolve"). Each says what a person did about one row of Today, in the condition the row was in;
 * every person who sees Today in the row's company reads it again (the web's GET /live filter lists them beside the
 * kinds' own events). A notification centre (W2a) may tell the assignee.
 *
 *   attention.assigned       a row was assigned to a person who may act on it, or taken back (assigneeId null)
 *   attention.resolved       a row was resolved with a note: it leaves Today for everyone until its condition changes
 *   attention.acknowledged   a row was acknowledged: it stays, marked, while its condition holds
 *   attention.snoozed        (W2a) a row was snoozed until a time, or until its condition changes: it leaves Today
 *   attention.nudged         (W2a) a person reminded the people they wait on (Waiting on others › Nudge): the
 *                            notification centre tells those who may decide; once a day at most
 */

const row = {
  actionId: z.uuid(),
  /** `<kind>:<record id>[:<sub key>]`. */
  key: z.string(),
  kind: z.string(),
  recordType: z.string(),
  recordId: z.uuid(),
  /** The row's condition when it was done (insights/attention conditionOf). */
  condition: z.string(),
}

const live = { permission: 'home.view', fields: ['key', 'kind'] } as const

export const events = [
  defineEvent({
    type: 'attention.assigned',
    context: 'insights',
    description: 'A row of Today was assigned to a person who may act on it, or taken back.',
    payload: z.strictObject({ ...row, assigneeId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'attention.resolved',
    context: 'insights',
    description: 'A row of Today was resolved with a note: it leaves Today until its condition changes.',
    payload: z.strictObject(row),
    live,
  }),
  defineEvent({
    type: 'attention.acknowledged',
    context: 'insights',
    description: 'A row of Today was acknowledged: it stays, marked, while its condition holds.',
    payload: z.strictObject(row),
    live,
  }),
  defineEvent({
    type: 'attention.snoozed',
    context: 'insights',
    description: 'A row of Today was snoozed until a time, or until its condition changes: it leaves Today meanwhile.',
    payload: z.strictObject({ ...row, until: z.string().nullable() }),
    live,
  }),
  defineEvent({
    type: 'attention.nudged',
    context: 'insights',
    description: 'A person reminded the people they wait on (an approval they asked for): those who may decide are told.',
    payload: z.strictObject({
      /** The waiting row's key (`<kind>:<record id>`). */
      key: z.string(),
      kind: z.string(),
      recordType: z.string(),
      recordId: z.uuid(),
      /** The note the reminder wrote on the record's thread. */
      messageId: z.uuid(),
      /** Who nudged (the asker). */
      byId: z.uuid(),
    }),
    live,
  }),
] as const
