import { CERTIFICATES_MANAGE, CERTIFICATES_VIEW } from '../compliance/certificates/permissions'
import { can, holds, type Actor, type Permission, type ScopedRecord } from '../core/permissions'
import type { BusinessDate } from '../core/time'
import { PURCHASING_SEND, PURCHASING_VIEW } from '../purchasing/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '../sales/orders/permissions'
import { HOME_VIEW } from './permissions'
import type { AttentionRecord, AttentionScope } from './attention'
import type { Phrase } from './words'

/**
 * Coming up (B-W2a-20 API for B-W2a-40; design home.today `coming-up`: "What lands on me in the next five working days, so
 * tomorrow is not a surprise. Day rows (site calendar): promise dates of my orders, deliveries due from suppliers,
 * certificate expiries, tasks due"). Read at the moment it is asked, like Today:
 *
 *   TASK          my open tasks due on the day (assigned to me)
 *   ORDER         promise dates of open sales orders I act on (orders.manage over the order's company and customer)
 *   DELIVERY      requested dates of purchase orders sent and not yet received that I act on (purchasing.send)
 *   CERTIFICATE   certificates valid until the day that I keep (compliance.certificates.manage)
 *
 * The days are the next five WORKING days after today by the business calendar of the site (or company) the page is
 * filtered to (platform/calendars); with no filter, Monday to Friday. A non-working day inside the window shows only when
 * something lands on it. Items never name a person and carry no amount.
 */

export const COMING_KINDS = ['TASK', 'ORDER', 'DELIVERY', 'CERTIFICATE'] as const
export type ComingKind = (typeof COMING_KINDS)[number]

/** How many working days ahead. */
export const COMING_WORKING_DAYS = 5
/** The most items one kind lists in the window (the answer says when a kind stopped there). */
export const COMING_LIMIT = 200

interface ComingRule {
  readonly view: Permission
  readonly act: Permission
}

export const COMING_RULES: Readonly<Record<ComingKind, ComingRule>> = Object.freeze({
  TASK: { view: HOME_VIEW, act: HOME_VIEW },
  ORDER: { view: ORDERS_VIEW, act: ORDERS_MANAGE },
  DELIVERY: { view: PURCHASING_VIEW, act: PURCHASING_SEND },
  CERTIFICATE: { view: CERTIFICATES_VIEW, act: CERTIFICATES_MANAGE },
})

/** The kinds worth reading for this person (they act on them somewhere). */
export const comingKindsFor = (actor: Actor): ComingKind[] => COMING_KINDS.filter((kind) => holds(actor, COMING_RULES[kind].view) && holds(actor, COMING_RULES[kind].act))

/** Whether this row lands on the person: they see the record and act on it there (a task: it is theirs, read so). */
export const landsOn = (actor: Actor, kind: ComingKind, scope: ScopedRecord): boolean => can(actor, COMING_RULES[kind].view, scope) && can(actor, COMING_RULES[kind].act, scope)

export interface ComingItem {
  readonly kind: ComingKind
  readonly date: BusinessDate
  readonly record: AttentionRecord
  readonly scope: AttentionScope
  readonly words: Phrase
}

export interface ComingDay {
  readonly date: BusinessDate
  readonly working: boolean
  readonly items: readonly ComingItem[]
}

/**
 * The window's day rows: every working day of it, and a non-working day only when an item lands on it; items in kind
 * order (tasks first), then by record label.
 */
export function comingDays(calendar: readonly { readonly date: BusinessDate; readonly working: boolean }[], items: readonly ComingItem[]): ComingDay[] {
  const byDay = new Map<string, ComingItem[]>()
  for (const item of items) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item])
  return calendar
    .filter((day) => day.working || byDay.has(day.date))
    .map((day) => ({
      date: day.date,
      working: day.working,
      items: [...(byDay.get(day.date) ?? [])].sort((a, b) => COMING_KINDS.indexOf(a.kind) - COMING_KINDS.indexOf(b.kind) || a.record.label.localeCompare(b.record.label) || a.record.id.localeCompare(b.record.id)),
    }))
}

/**
 * The window: the days after `today` up to and including the `count`th working day (`isWorking` by the calendar). When the
 * calendar never says "working" in `maxDays`, the window stops there.
 */
export function comingWindow(today: BusinessDate, isWorking: (date: BusinessDate) => boolean, plusDays: (date: BusinessDate, days: number) => BusinessDate, count = COMING_WORKING_DAYS, maxDays = 31): { date: BusinessDate; working: boolean }[] {
  const days: { date: BusinessDate; working: boolean }[] = []
  let working = 0
  for (let offset = 1; offset <= maxDays && working < count; offset += 1) {
    const date = plusDays(today, offset)
    const open = isWorking(date)
    if (open) working += 1
    days.push({ date, working: open })
  }
  return days
}
