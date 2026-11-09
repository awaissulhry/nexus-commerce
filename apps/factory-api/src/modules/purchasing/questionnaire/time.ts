import { BUSINESS_TIME_ZONE } from '@nexus/factory-domain/core/time'

/** An instant as the supplier reads it on its answer's PDF, in the company's zone: 09/11/2026 14:32 or 2026-11-09 14:32. */
export function formatInZone(instant: Date, locale: 'it' | 'en'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .map((part) => [part.type, part.value] as const),
  )
  const time = `${parts.hour}:${parts.minute}`
  return locale === 'it' ? `${parts.day}/${parts.month}/${parts.year} ${time}` : `${parts.year}-${parts.month}-${parts.day} ${time}`
}
