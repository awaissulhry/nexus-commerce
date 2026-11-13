import type { PromiseLine, RiskState } from '../depth/api'

/**
 * B-W2b-323 — By promise week (design sales.orders sec:orders.week "Backlog by promise week: what must finish and ship each
 * week"), pure: the open pieces of every open order line (B-W2b-317's promise lines: each size's promise now and its open
 * pieces) put in the ISO week of their promise — weeks already passed in one "Late" column first, then this week onwards, then
 * "No promise" — one card per order and week with its pieces, its priority and the worst risk. Within a week the cards keep the
 * backlog's own ranking (`backlogPosition`, B-W2b-317: never re-ranked here), then the number.
 */

export const WEEK_LIMIT = 16

export type WeekKey = string | 'EARLIER' | 'LATER' | 'NONE'

export interface WeekCard {
  orderId: string
  number: string
  customer: string
  units: number
  lines: number
  priorityLevel: string
  risk: RiskState | null
  position: number | null
}

export interface WeekColumn {
  key: WeekKey
  /** The Monday and Sunday of an ISO week (YYYY-MM-DD); null for Late, Later and No promise. */
  from: string | null
  to: string | null
  week: number | null
  current: boolean
  units: number
  cards: WeekCard[]
}

const DAY = 86_400_000
const at = (day: string) => Date.parse(`${day}T00:00:00Z`)
/** A UTC midnight back to its day (YYYY-MM-DD), with no zone in between (a business day is a date, not an instant). */
function dayOf(time: number): string {
  const date = new Date(time)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** The Monday of a business day's ISO week (a date without a time: no zone moves it). */
export function mondayOf(day: string): string {
  const time = at(day)
  const weekday = (new Date(time).getUTCDay() + 6) % 7
  return dayOf(time - weekday * DAY)
}

/** The ISO week number of a Monday. */
export function isoWeek(monday: string): number {
  const time = at(monday)
  const thursday = time + 3 * DAY
  const year = new Date(thursday).getUTCFullYear()
  const firstThursday = at(`${year}-01-04`)
  const firstMonday = firstThursday - ((new Date(firstThursday).getUTCDay() + 6) % 7) * DAY
  return Math.floor((time - firstMonday) / (7 * DAY)) + 1
}

const RISK_RANK: Readonly<Record<RiskState, number>> = Object.freeze({ LATE: 0, AT_RISK: 1, NOT_PROMISED: 2, ON_TIME: 3 })
const worst = (a: RiskState | null, b: RiskState | null): RiskState | null => (a === null ? b : b === null ? a : RISK_RANK[a] <= RISK_RANK[b] ? a : b)

export function weekColumns(lines: readonly PromiseLine[], today: string): WeekColumn[] {
  const thisMonday = mondayOf(today)
  const limit = dayOf(at(thisMonday) + (WEEK_LIMIT - 1) * 7 * DAY)
  const buckets = new Map<WeekKey, Map<string, WeekCard & { lineIds: Set<string> }>>()
  const put = (key: WeekKey, line: PromiseLine, units: number, risk: RiskState | null) => {
    const cards = buckets.get(key) ?? new Map<string, WeekCard & { lineIds: Set<string> }>()
    const card = cards.get(line.order.id) ?? { orderId: line.order.id, number: line.order.number, customer: line.customer.name, units: 0, lines: 0, priorityLevel: line.order.priorityLevel, risk: null, position: line.order.backlogPosition, lineIds: new Set<string>() }
    card.units += units
    card.lineIds.add(line.id)
    card.lines = card.lineIds.size
    card.risk = worst(card.risk, risk)
    cards.set(line.order.id, card)
    buckets.set(key, cards)
  }
  for (const line of lines) {
    for (const size of line.sizes) {
      if (size.open <= 0) continue
      const promise = size.current ?? line.current
      const key: WeekKey = promise === null ? 'NONE' : promise < thisMonday ? 'EARLIER' : mondayOf(promise) > limit ? 'LATER' : mondayOf(promise)
      put(key, line, size.open, size.risk ?? line.risk)
    }
  }
  const dated = [...buckets.keys()].filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)).sort()
  const last = dated.length > 0 ? dated[dated.length - 1]! : thisMonday
  const weeks: string[] = []
  for (let time = at(thisMonday); time <= at(last); time += 7 * DAY) weeks.push(dayOf(time))
  const order: WeekKey[] = [...(buckets.has('EARLIER') ? ['EARLIER'] : []), ...weeks, ...(buckets.has('LATER') ? ['LATER'] : []), ...(buckets.has('NONE') ? ['NONE'] : [])]
  return order.map((key) => {
    const cards = [...(buckets.get(key)?.values() ?? [])]
      .map(({ lineIds: _lineIds, ...card }) => card)
      .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(key)
    return {
      key,
      from: dated ? key : null,
      to: dated ? dayOf(at(key) + 6 * DAY) : null,
      week: dated ? isoWeek(key) : null,
      current: key === thisMonday,
      units: cards.reduce((sum, card) => sum + card.units, 0),
      cards,
    }
  })
}

/** The site whose promises the board reads: the address's, else the person's first (by code). */
export function siteOf(sites: ReadonlyArray<{ id: string; code?: string | null }>, asked: string | null): string | null {
  if (asked && sites.some((site) => site.id === asked)) return asked
  return [...sites].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''))[0]?.id ?? null
}
