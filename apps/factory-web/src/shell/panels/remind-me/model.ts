import { cleanNote, REMINDER_LIMITS, type ReminderKind } from '@nexus/factory-domain/reminders/rules'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { MORNING_TIME, plusDays, snoozeOptions, zonedInstant, type SnoozeChoice } from '../../../areas/home/today/snooze'
import type { Reminder } from './api'

/**
 * Remind me (B-W2b-388; COL-041; design shell.panels popup remind-me "Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a
 * date · When something changes. It comes back to Today then"), pure. The fixed choices are Today's "Snooze until" (today/snooze:
 * the SITE's time zone, never the browser's), with "When something changes" always offered: a reminder is always on a record.
 * Coming up's "Remind me the day before" is 08:00 the day before the item's day. The API checks the moment again (after now, at
 * most a year on).
 */

/** The choices of Remind me, in the design's order. */
export type RemindChoice = SnoozeChoice

export interface RemindOption {
  readonly choice: RemindChoice
  readonly kind: ReminderKind
  /** The moment (ISO, UTC); null for PICK (the person picks it) and ON_CHANGE. */
  readonly remindAt: string | null
}

/** Remind me's choices at this moment. */
export function remindOptions(now: number, timeZone: string = DEFAULT_TIME_ZONE): RemindOption[] {
  return snoozeOptions(now, { untilChange: true, timeZone }).map((option) => ({ choice: option.choice, kind: option.choice === 'UNTIL_CHANGE' ? 'ON_CHANGE' : 'AT_TIME', remindAt: option.until }))
}

/** What is wrong with a picked moment (a message key of `home-mywork`), or null. */
export function pickedProblem(picked: string, now: number): string | null {
  if (!picked) return 'remind.pickFirst'
  const at = Date.parse(picked)
  if (Number.isNaN(at)) return 'remind.pickFirst'
  if (at <= now) return 'remind.past'
  if (at - now > REMINDER_LIMITS.maxDays * 86_400_000) return 'remind.tooFar'
  return null
}

/** What is wrong with a note (a message key), or null. */
export function noteProblem(note: string): string | null {
  const text = cleanNote(note)
  return text !== null && text.length > REMINDER_LIMITS.note ? 'remind.noteLong' : null
}

/**
 * "Remind me the day before" a day (coming up's item): 08:00 the day before, in the site's zone. Null when that moment has
 * passed already (the item is today or tomorrow after 08:00): the control says why instead.
 */
export function dayBeforeAt(day: string, now: number, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  const at = zonedInstant(plusDays(day, -1), MORNING_TIME, timeZone)
  return at > now ? new Date(at).toISOString() : null
}

/** A reminder's "when", as a message key and its params: back since, comes back at, or when the record changes. */
export function whenWords(reminder: Pick<Reminder, 'state' | 'kind' | 'remindAt' | 'cameBackAt' | 'doneAt'>): { readonly key: string; readonly at: string | null } {
  if (reminder.state === 'DONE') return { key: 'remind.when.done', at: reminder.doneAt }
  if (reminder.state === 'CAME_BACK') return { key: 'remind.when.back', at: reminder.cameBackAt }
  if (reminder.kind === 'ON_CHANGE') return { key: 'remind.when.onChange', at: null }
  return { key: 'remind.when.at', at: reminder.remindAt }
}

/** The window event a message's "Remind me" sends to the record's Remind me control (the record panels' thread). */
export const REMIND_ME_EVENT = 'factory:remind-me'

export interface RemindMeRequest {
  readonly recordType: string
  readonly recordId: string
  readonly messageId: string | null
}

/** Ask the record's Remind me control to open, about a message of its thread (or the record itself). */
export function askRemindMe(request: RemindMeRequest): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<RemindMeRequest>(REMIND_ME_EVENT, { detail: request }))
}
