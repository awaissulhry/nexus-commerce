import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { RECORD_TYPE } from '@nexus/factory-domain/threads/rules'
import { REMINDER_BULK_ACTIONS, REMINDER_KINDS, REMINDER_LIMITS, REMINDER_STATES, REMINDER_VIEWS } from '@nexus/factory-domain/reminders/rules'

/**
 * The reminders' contracts (B-W2b-388; COL-041; design shell.panels popup remind-me, home.tasks section reminders, home.today
 * needs-me "reminders that came back"). A reminder is the reader's own: its record (type, id, label when it was set), an
 * optional message of the record's thread, when it comes back (AT_TIME with its moment, or ON_CHANGE), the note, and where it
 * is (WAITING, CAME_BACK, DONE). Every change sends the version as read (409 when it moved). No amount, no other person.
 */

export const reminderView = output({
  id: id(),
  record: output({ type: z.string(), id: id(), label: z.string() }),
  companyId: id().nullable(),
  /** A message of the record's thread it is about (the record opens at it). */
  messageId: id().nullable(),
  kind: z.enum(REMINDER_KINDS),
  remindAt: instant().nullable(),
  /** When it was set, or last put off: an ON_CHANGE reminder watches the record from here. */
  since: instant(),
  note: z.string().nullable(),
  cameBackAt: instant().nullable(),
  doneAt: instant().nullable(),
  state: z.enum(REMINDER_STATES),
  version: z.number().int(),
  createdAt: instant(),
  /** B-TH-096: AT_TIME on a message I shared with the customer: it stops by itself when they answer ("if no answer"). */
  followUp: z.boolean(),
})

const one = output({ reminder: reminderView })
const params = input({ id: id() })
const version = z.number().int().min(1)
const when = {
  kind: z.enum(REMINDER_KINDS),
  /** AT_TIME: the moment it comes back (the screen works it out in the site's time zone). */
  remindAt: instant().nullable().optional(),
}

export const listRemindersContract = defineContract({
  querystring: input({
    /** OPEN (waiting or back; default), WAITING, CAME_BACK or DONE. */
    view: z.enum(REMINDER_VIEWS).default('OPEN'),
    /** One record's reminders (the record panels' "Reminders I set"): its type and id together. */
    recordType: z.string().regex(RECORD_TYPE).optional(),
    recordId: id().optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      view: z.enum(REMINDER_VIEWS),
      counts: output({ waiting: z.number().int(), cameBack: z.number().int(), done: z.number().int() }),
      items: z.array(reminderView),
      /** False: the list stopped at its limit. */
      complete: z.boolean(),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

export const setReminderContract = defineContract({
  body: input({
    record: input({ type: z.string().regex(RECORD_TYPE), id: id() }),
    messageId: id().nullable().optional(),
    ...when,
    note: z.string().max(REMINDER_LIMITS.note * 2).nullable().optional(),
  }),
  response: { 201: one },
})

export const putOffReminderContract = defineContract({ params, body: input({ version, ...when }), response: { 200: one } })
export const reminderDoneContract = defineContract({ params, body: input({ version }), response: { 200: one } })
export const reminderUndoContract = defineContract({ params, body: input({ version }), response: { 200: one } })
export const removeReminderContract = defineContract({ params, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ removed: id() }) } })

export const bulkRemindersContract = defineContract({
  body: input({ action: z.enum(REMINDER_BULK_ACTIONS), ids: z.array(id()).min(1).max(REMINDER_LIMITS.bulk) }),
  response: { 200: output({ action: z.enum(REMINDER_BULK_ACTIONS), changed: z.number().int(), items: z.array(reminderView) }) },
})
