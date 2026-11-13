import type { ApiClient } from '../../../../lib/api/client'
import { reminderSchema, type ReminderSettings } from '../api'

export interface TimingBody {
  readonly companyId: string | null
  readonly confirmByHours: number | null
  readonly reminderCadenceDays: number | null
  readonly version?: number
}

/**
 * The confirm-by hours and the reminders' cadence of a company, or of every company (B-W2b-382 on B-W2b-377's
 * `PUT /purchasing/reminders/settings/timing`; purchasing.reminders.switch, the Owner's): null clears a value (the company then
 * follows every company's, else the default); the row's version as read, none for a row not made yet. The answer is the
 * reminder settings as read again.
 */
export const setReminderTiming = (api: ApiClient, body: TimingBody, idempotencyKey: string): Promise<ReminderSettings> =>
  api.request('PUT', '/purchasing/reminders/settings/timing', { body, schema: reminderSchema, idempotencyKey })
