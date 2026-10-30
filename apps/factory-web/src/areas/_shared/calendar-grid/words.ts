import { useMemo } from 'react'
import { CALENDAR_GRID_WORDS, type CalendarGridWords } from '@nexus/ui/components/CalendarGrid/index'
import { useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'

/**
 * The words of the DS calendar grid in the page's language, from `messages/<locale>/calendar-kit.json` (`calendar.*`).
 * Every calendar of the Office uses them: Planning settings › Calendars & shifts (SCR-124, B-W2a-59), a supplier's
 * closures, a purchase order's dates. The texts keep the DS's `{placeholders}`: they go to the calendar as templates
 * (`t(key)` with no params returns the text as written) and the calendar fills them.
 */

export const CALENDAR_KIT_NAMESPACE = 'calendar-kit'
export const CALENDAR_WORD_KEYS = Object.keys(CALENDAR_GRID_WORDS) as (keyof CalendarGridWords)[]

export function calendarWordsOf(t: Translate): CalendarGridWords {
  return Object.fromEntries(CALENDAR_WORD_KEYS.map((key) => [key, t(`calendar.${key}`)])) as unknown as CalendarGridWords
}

/** Inside `WithMessages namespaces={[CALENDAR_KIT_NAMESPACE]}`. */
export function useCalendarWords(): CalendarGridWords {
  const t = useT(CALENDAR_KIT_NAMESPACE)
  return useMemo(() => calendarWordsOf(t), [t])
}
