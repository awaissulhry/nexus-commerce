import { z } from 'zod'
import { defineEvent } from '../events/define'
import { REMINDER_KINDS } from './rules'

/**
 * The reminders' events (B-W2b-388; COL-041; design home.today live "reminder.due → Needs me", home.tasks section reminders).
 * apps/factory-api platform/tasks/reminders emits them in the command that changes the reminder (the scheduler's run for
 * `reminder.came_back`). A reminder is one person's own: the live channel sends only the reminder and its record (no person,
 * no note), so the person's own screens (Today, My tasks, the record's "Reminders I set") read their list again.
 *
 *   reminder.set         a reminder was set on a record (or one of its messages)
 *   reminder.came_back   its time came, or its record changed: it is back on the person's Today
 *   reminder.changed     put off (a new time or kind), done, undone or removed
 */

const about = {
  reminderId: z.uuid(),
  recordType: z.string(),
  recordId: z.uuid(),
}
const person = { userId: z.uuid() }
const live = { permission: 'home.view', fields: ['reminderId', 'recordType', 'recordId'] } as const

export const REMINDER_CHANGES = ['PUT_OFF', 'DONE', 'UNDONE', 'REMOVED'] as const

export const events = [
  defineEvent({
    type: 'reminder.set',
    context: 'reminders',
    description: 'A person set a reminder on a record or one of its messages.',
    payload: z.strictObject({ ...about, ...person, kind: z.enum(REMINDER_KINDS) }),
    live,
  }),
  defineEvent({
    type: 'reminder.came_back',
    context: 'reminders',
    description: 'A reminder came back to its person’s Today: its time came, or its record changed.',
    payload: z.strictObject({ ...about, ...person, kind: z.enum(REMINDER_KINDS) }),
    live,
  }),
  defineEvent({
    type: 'reminder.changed',
    context: 'reminders',
    description: 'A reminder was put off, done, undone or removed by its person.',
    payload: z.strictObject({ ...about, ...person, change: z.enum(REMINDER_CHANGES) }),
    live,
  }),
] as const
