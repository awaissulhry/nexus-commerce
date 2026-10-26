/**
 * Reviews › Requests › the request pop-up (`GET /api/review-queue/:id`): its header words, the actions in their order
 * with the reason each is held, Amazon's window as a bar, and the timeline with a tone per step. The server words every
 * status, answer and held reason; this file orders them and adds only what the page itself knows (the person's
 * permission). Pure; tested in requestDetailModel.vitest.test.ts.
 */
import type { Tone } from '@/design-system/primitives'
import { channelMarketWords } from '../../_lib/reviewWords'
import type { RequestDetail, TimelineKind } from './queueDatasource'

export const MANAGE_HELD = "You need 'Manage reviews' to change review requests."

const DAY_MS = 24 * 60 * 60 * 1000
export const AMAZON_FIRST_DAY = 5
export const AMAZON_LAST_DAY = 30

export type RequestActionId = 'snooze' | 'skip' | 'send-now' | 'allow-again'

export interface RequestAction {
  id: RequestActionId
  label: string
  /** Why it cannot run now; null = it runs. */
  held: string | null
}

/**
 * The pop-up's actions, in order: Snooze, Skip, Send now, then Allow again for a request that was not asked. Without
 * the permission every one is held with that reason first; otherwise the server's reason for this request.
 */
export function requestActions(detail: RequestDetail, canManage: boolean): RequestAction[] {
  const notAsked = detail.request.status === 'SKIPPED' || detail.request.status === 'SUPPRESSED'
  const held = (own: string | null) => (canManage ? own : MANAGE_HELD)
  const actions: RequestAction[] = [
    { id: 'snooze', label: 'Snooze', held: held(detail.held.snooze) },
    { id: 'skip', label: 'Skip', held: held(detail.held.skip) },
    { id: 'send-now', label: 'Send now', held: held(detail.held.sendNow) },
  ]
  if (notAsked) actions.push({ id: 'allow-again', label: 'Allow again', held: held(detail.held.allowAgain) })
  return actions
}

const dayDate = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone })

export interface HeaderView {
  title: string
  subtitle: string
  triesWords: string
}

export function headerView(detail: RequestDetail): HeaderView {
  const r = detail.request
  const where = channelMarketWords(r.channel, r.market)
  return {
    title: `Request for order ${r.orderLabel}`,
    subtitle: [r.buyer, where, r.product].filter(Boolean).join(' · '),
    triesWords: `${r.tries} ${r.tries === 1 ? 'try' : 'tries'}`,
  }
}

/** The snooze choices with the date each moves the next try to, held ones with their reason. */
export function snoozeChoices(detail: RequestDetail, canManage: boolean, timeZone?: string): { days: number; label: string; to: string | null; held: string | null }[] {
  const names: Record<number, string> = { 1: '1 day', 3: '3 days', 7: '1 week' }
  return detail.snoozeOptions.map((o) => ({
    days: o.days,
    label: names[o.days] ?? `${o.days} days`,
    to: o.to ? dayDate(o.to, timeZone) : null,
    held: canManage ? o.held : MANAGE_HELD,
  }))
}

export interface WindowView {
  /** "Mon 26 Oct", or "Not delivered yet". */
  delivered: string
  /** "our estimate: shipped + 3 working days" when the date is Nexus's estimate. */
  deliveredHint: string | null
  /** Amazon's window as a bar (Amazon only). */
  amazon: { day: number | null; value: number | null; words: string; lastDay: string | null } | null
}

/** Nexus's delivery date against Amazon's day 5–30 window. */
export function windowView(detail: RequestDetail, now: Date, timeZone?: string): WindowView {
  const w = detail.window
  const delivered = w.deliveredAt ? dayDate(w.deliveredAt, timeZone) : 'Not delivered yet'
  const deliveredHint = w.deliveredAt && w.estimate ? 'our estimate: shipped + 3 working days' : null
  if (detail.request.channel !== 'AMAZON') return { delivered, deliveredHint, amazon: null }
  if (!w.deliveredAt) {
    return { delivered, deliveredHint, amazon: { day: null, value: null, words: 'Amazon’s window opens 5 days after delivery', lastDay: null } }
  }
  const day = Math.floor((now.getTime() - new Date(w.deliveredAt).getTime()) / DAY_MS)
  const value = Math.max(0, Math.min(100, Math.round((day / AMAZON_LAST_DAY) * 100)))
  const lastDay = w.lastDay ? dayDate(w.lastDay, timeZone) : null
  const words = day < AMAZON_FIRST_DAY
    ? `Day ${Math.max(0, day)} — Amazon’s window opens on day ${AMAZON_FIRST_DAY}`
    : day > AMAZON_LAST_DAY
      ? `Day ${day} — Amazon’s window closed on day ${AMAZON_LAST_DAY}`
      : `Day ${day} of Amazon’s day ${AMAZON_FIRST_DAY}–${AMAZON_LAST_DAY} window`
  return { delivered, deliveredHint, amazon: { day, value, words, lastDay } }
}

const KIND_TONE: Record<TimelineKind, Tone> = {
  added: 'neutral',
  check: 'info',
  return: 'warning',
  refund: 'warning',
  try: 'warning',
  sent: 'success',
  failed: 'danger',
  not_asked: 'neutral',
  next: 'info',
  note: 'neutral',
}

export interface TimelineView {
  key: string
  label: string
  tone: Tone
  at?: string | null
}

/**
 * The timeline as the DS Timeline draws it. A step with a time keeps it; the next try without a time is "not yet"
 * (`at: null`); a closing note has no time of its own.
 */
export function timelineView(detail: RequestDetail): TimelineView[] {
  return detail.timeline.map((step, i) => ({
    key: `${i}:${step.kind}`,
    label: step.words,
    tone: KIND_TONE[step.kind] ?? 'neutral',
    ...(step.at ? { at: step.at } : step.kind === 'next' ? { at: null } : {}),
  }))
}

/** "€89.90" — a money amount in its currency (EUR when unknown). */
export function moneyWords(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim()
  }
}

/** A date in the order tab ("Mon 26 Oct"), or "—". */
export function orderDate(iso: string | null | undefined, timeZone?: string): string {
  return iso ? dayDate(iso, timeZone) : '—'
}

/** Words for a return's status (the order tab). */
export function returnWords(ret: RequestDetail['order']['return']): string {
  if (!ret) return 'None'
  const status = ret.status.toLowerCase().replace(/_/g, ' ')
  return `${ret.open ? 'Open' : 'Closed'} (${status})${ret.rma ? ` · ${ret.rma}` : ''}`
}
