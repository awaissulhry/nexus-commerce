/**
 * The switches of the automatic reminder mails to customers (B-W2b-F38; Owner 2026-11-13, option A: one switch per company
 * for each, OFF by default), kept on the sales settings rows (factory-db SalesSettings quoteRemindersEnabled,
 * fittingRemindersEnabled):
 *
 *   QUOTE    the one reminder 3 days before a sent quote's last day (apps/factory-api sales/quote-terms/validity.ts, daily)
 *   FITTING  the rider's reminder 24 hours before a BOOKED appointment (apps/factory-api sales/fittings/reminders.ts, hourly)
 *
 * In force for a company: its own row, else the tenant-wide row, else off (the same reading as the caparra switch). A switch
 * that is off sends nothing and marks nothing, so switching it on later still reminds what is due then. A quote's expiry and
 * the invites, updates and cancellations a person sends do not depend on them. Pure: no database.
 */

export const REMINDER_KINDS = ['QUOTE', 'FITTING'] as const
export type ReminderKind = (typeof REMINDER_KINDS)[number]

/** Where the switches in force come from: the company's own row, the tenant-wide row, or no row (off). */
export type ReminderSource = 'COMPANY' | 'TENANT' | 'DEFAULT'

export interface ReminderSwitchRow {
  readonly id: string
  readonly companyId: string | null
  readonly quoteRemindersEnabled: boolean
  readonly fittingRemindersEnabled: boolean
}

export interface ReminderSwitches {
  readonly quoteRemindersEnabled: boolean
  readonly fittingRemindersEnabled: boolean
  readonly source: ReminderSource
}

/** No row: both reminders off. */
export const REMINDERS_OFF: ReminderSwitches = Object.freeze({ quoteRemindersEnabled: false, fittingRemindersEnabled: false, source: 'DEFAULT' })

/** The switches in force for a company (null: the tenant-wide ones): its own row, else the tenant-wide row, else off. */
export function remindersInForce(rows: readonly ReminderSwitchRow[], companyId: string | null): ReminderSwitches {
  const own = companyId === null ? undefined : rows.find((row) => row.companyId === companyId)
  const tenant = rows.find((row) => row.companyId === null)
  const row = own ?? tenant
  if (!row) return REMINDERS_OFF
  return { quoteRemindersEnabled: row.quoteRemindersEnabled, fittingRemindersEnabled: row.fittingRemindersEnabled, source: own ? 'COMPANY' : 'TENANT' }
}

/** Whether one kind of reminder goes for a company. */
export function reminderOn(rows: readonly ReminderSwitchRow[], companyId: string, kind: ReminderKind): boolean {
  const switches = remindersInForce(rows, companyId)
  return kind === 'QUOTE' ? switches.quoteRemindersEnabled : switches.fittingRemindersEnabled
}
