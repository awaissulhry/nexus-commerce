import type { Prisma } from '@nexus/factory-db'
import { businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'

/**
 * The days of the ledger as the books count them (B-W2b-314; SCM-196): a move counts on its posting date when it has one,
 * else on the day it happened (occurredAt, Europe/Rome) — the database's period lock reads the same day. As Prisma filters,
 * written so a move without a posting date is never lost to SQL's NULL (each side says what it holds, never NOT …).
 *
 *   ENTRY     the day it happened (occurredAt), whatever its posting date: the entry date of the Movements grid
 *   POSTING   the day it counts on in the books
 */

export type DayBasis = 'POSTING' | 'ENTRY'

const column = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The moves that count on a day before `day`. */
export function before(day: BusinessDate, basis: DayBasis = 'POSTING'): Prisma.StockMoveWhereInput {
  const start = businessDayStart(day)
  if (basis === 'ENTRY') return { occurredAt: { lt: start } }
  return { OR: [{ postingDate: { lt: column(day) } }, { postingDate: null, occurredAt: { lt: start } }] }
}

/** The moves that count on `day` or later. */
export function onOrAfter(day: BusinessDate, basis: DayBasis = 'POSTING'): Prisma.StockMoveWhereInput {
  const start = businessDayStart(day)
  if (basis === 'ENTRY') return { occurredAt: { gte: start } }
  return { OR: [{ postingDate: { gte: column(day) } }, { postingDate: null, occurredAt: { gte: start } }] }
}

/** The moves that count on a day from `from` to `to`, both included (either open). */
export function postingDayRange(from: BusinessDate | null, to: BusinessDate | null, basis: DayBasis = 'POSTING'): Prisma.StockMoveWhereInput {
  return { AND: [from ? onOrAfter(from, basis) : {}, to ? before(plusCalendarDays(to, 1), basis) : {}] }
}
