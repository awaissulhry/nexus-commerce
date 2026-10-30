import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CALENDAR_SCOPES } from './working-time'

/**
 * The business calendars' events (plan A1 §3.4, §3.5; B-W2a-08). apps/factory-api's platform/calendars emits them in
 * the command that makes the change; the screens that count working time (the planning board and capacity, People's
 * roster, Planning › Settings) refresh what the change reaches, and later handlers (capacity, B-W2a-16) recompute it.
 * Ids, dates and counts only.
 *
 *   calendar.changed                a calendar was made, edited (week, pattern, name) or archived, or days were set
 *                                   or removed between `from` and `to` (the dates a reader must count again)
 *   calendar.shift_pattern_changed  a shift pattern was made, edited, its shifts and breaks saved, or archived;
 *                                   `calendars` active calendars use it
 *
 * (The design calls the first `planning.calendar.changed` on the board and `calendar.changed` on the roster: one event.)
 */
const live = { permission: 'calendars.view', fields: ['calendarId', 'scope', 'change', 'from', 'to', 'siteId', 'lineId', 'workCentreId', 'partyId'] } as const
const day = z.iso.date()

export const CALENDAR_CHANGES = ['CREATED', 'EDITED', 'ARCHIVED', 'DAYS_SET', 'DAYS_REMOVED'] as const
export const PATTERN_CHANGES = ['CREATED', 'EDITED', 'SEGMENTS_SAVED', 'ARCHIVED'] as const

export const events = [
  defineEvent({
    type: 'calendar.changed',
    context: 'calendars',
    description: 'A business calendar was made, edited or archived, or its holidays, closures or extra working days changed: working time between the dates may differ.',
    payload: z.strictObject({
      calendarId: z.uuid(),
      scope: z.enum(CALENDAR_SCOPES),
      companyId: z.uuid().nullable(),
      siteId: z.uuid().nullable(),
      lineId: z.uuid().nullable(),
      workCentreId: z.uuid().nullable(),
      partyId: z.uuid().nullable(),
      change: z.enum(CALENDAR_CHANGES),
      /** The first and last date whose working time may differ; null: every date (the week or the pattern changed). */
      from: day.nullable(),
      to: day.nullable(),
      /** Days set or removed (0 for the other changes). */
      days: z.number().int().min(0),
    }),
    live,
  }),
  defineEvent({
    type: 'calendar.shift_pattern_changed',
    context: 'calendars',
    description: 'A shift pattern was made, renamed, its shifts and breaks saved, or archived: the working time of the calendars and days that use it may differ.',
    payload: z.strictObject({
      patternId: z.uuid(),
      companyId: z.uuid().nullable(),
      code: z.string().min(1).max(20),
      change: z.enum(PATTERN_CHANGES),
      /** ACTIVE calendars that use it as their pattern. */
      calendars: z.number().int().min(0),
    }),
    live: { permission: 'calendars.view', fields: ['patternId', 'code', 'change'] },
  }),
] as const
