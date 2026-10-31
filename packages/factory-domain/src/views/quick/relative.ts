/**
 * Quick filters with "me" and relative dates (B-W2b-13; PLT-167; design shell.lists sec:toolbar "Rows ▾ (… quick filters
 * 'Assigned to me', 'Due this week', 'My site')"). A quick filter is one of the list's own address terms whose value
 * is a WORD, never a fixed value: `due=this-week`, `owner=me`. A saved view keeps the word, so "Due this week" opened
 * next month still means that week, and "Assigned to me" opened by a colleague from a shared link means them.
 *
 * The list's read resolves the word when it runs: a relative day against the site's today (the API's `todayOfCommand`,
 * the web's site time zone), "me" against the person asking. The export of a view sends the same terms, so the file
 * holds the same rows the screen shows. Pure.
 */

/** The relative days a date term may hold. */
export const RELATIVE_DAYS = ['today', 'tomorrow', 'this-week', 'next-week', 'last-week', 'next-7-days', 'last-7-days', 'this-month', 'last-30-days', 'overdue'] as const
export type RelativeDay = (typeof RELATIVE_DAYS)[number]

/** An inclusive range of days (YYYY-MM-DD); an open end is null. */
export interface DayRange {
  readonly from: string | null
  readonly to: string | null
}

/** The word that stands for the person asking. */
export const ME = 'me'

export const isRelativeDay = (value: string | null | undefined): value is RelativeDay => typeof value === 'string' && (RELATIVE_DAYS as readonly string[]).includes(value)

/** A term's value as a person: "me" → the asker, any other value as it is, nothing → null. */
export const meOf = (value: string | null | undefined, actorId: string): string | null => (value === ME ? actorId : (value ?? null))

const parse = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d))
}
const text = (date: Date): string => date.toISOString().slice(0, 10)
const plus = (day: string, days: number): string => {
  const date = parse(day)
  date.setUTCDate(date.getUTCDate() + days)
  return text(date)
}

/**
 * The days a relative word covers from `today` (YYYY-MM-DD, the site's day). Weeks start on `weekStartsOn` (0 Sunday …
 * 6 Saturday; Monday by default, as in Italy). "Overdue" is every day before today; "next 7 days" is today and the six
 * after it; "last 7 days" is today and the six before it.
 */
export function relativeRange(word: RelativeDay, today: string, weekStartsOn = 1): DayRange {
  const weekday = parse(today).getUTCDay()
  const back = (weekday - weekStartsOn + 7) % 7
  const weekStart = plus(today, -back)
  switch (word) {
    case 'today':
      return { from: today, to: today }
    case 'tomorrow': {
      const day = plus(today, 1)
      return { from: day, to: day }
    }
    case 'this-week':
      return { from: weekStart, to: plus(weekStart, 6) }
    case 'next-week':
      return { from: plus(weekStart, 7), to: plus(weekStart, 13) }
    case 'last-week':
      return { from: plus(weekStart, -7), to: plus(weekStart, -1) }
    case 'next-7-days':
      return { from: today, to: plus(today, 6) }
    case 'last-7-days':
      return { from: plus(today, -6), to: today }
    case 'this-month': {
      const date = parse(today)
      const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
      return { from: text(first), to: text(last) }
    }
    case 'last-30-days':
      return { from: plus(today, -29), to: today }
    case 'overdue':
      return { from: null, to: plus(today, -1) }
  }
}

/** A day inside a range (both ends included); no day is never inside one. */
export function inRange(day: string | null | undefined, range: DayRange): boolean {
  if (!day) return false
  return (range.from === null || day >= range.from) && (range.to === null || day <= range.to)
}
