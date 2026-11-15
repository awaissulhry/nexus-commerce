import { REMINDER_VIEWS, type ReminderView } from '@nexus/factory-domain/reminders/rules'
import { recordAddress } from '../../../../lib/records/record-links'
import type { Reminder, RemindersAnswer } from '../../../../shell/panels/remind-me/api'

/**
 * Home › My tasks › Reminders (B-W2b-388; COL-041; design home.tasks section reminders "Records and messages I asked to see again":
 * "'Remind me: PO-2026-0031 — supplier promised a date · tomorrow 08:00'", verbs "Done · Snooze · Open"), on the shared list frame
 * (select several: Done N · Remove N). The lists: Open (back or waiting) · Back · Waiting · Done, each with its count.
 */

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: T }

export interface ReminderRow extends Reminder {
  /** Its record (own page, else its panels), with the company prefix: a real link. */
  readonly href: string
}

export interface RemindersModel {
  readonly view: ReminderView
  readonly list: Loaded<{ readonly rows: readonly ReminderRow[]; readonly counts: RemindersAnswer['counts']; readonly asOf: string; readonly complete: boolean }>
  readonly selected: readonly string[]
  readonly now: number
  /** Why changing is held (offline, a change in flight): a message key of `home-mywork`, or null. */
  readonly held: string | null
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string | number>>; readonly undo?: boolean } | null
  /** The reminder being put off (Snooze), or null. */
  readonly putOff: string | null
}

export const VIEWS: readonly ReminderView[] = REMINDER_VIEWS

export const rowOf = (reminder: Reminder, prefix: string, built: ReadonlySet<string>): ReminderRow => ({
  ...reminder,
  href: `${prefix}${recordAddress({ type: reminder.record.type, id: reminder.record.id, label: reminder.record.label, companyId: reminder.companyId }, built)}`,
})

/** A list's count from the answer's counts (Open = waiting + back). */
export function viewCount(view: ReminderView, counts: RemindersAnswer['counts']): number {
  if (view === 'OPEN') return counts.waiting + counts.cameBack
  if (view === 'WAITING') return counts.waiting
  if (view === 'CAME_BACK') return counts.cameBack
  return counts.done
}

/** The picked rows that Done N would finish (not done yet). */
export const doneable = (rows: readonly ReminderRow[], picked: readonly string[]): ReminderRow[] => rows.filter((row) => picked.includes(row.id) && row.state !== 'DONE')
