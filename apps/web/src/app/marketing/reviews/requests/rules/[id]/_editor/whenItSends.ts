/**
 * Reviews › Requests › the rule editor's "When it sends" column: the request body for
 * `POST /api/review-rules/preview-timing` (the unsaved rule, for an order delivered or shipped today) and its answer in
 * words — delivered Mon 26 Oct → first try Fri 30 Oct 10:00 → daily until day 30 (Amazon) or tried again after 4, 8 and
 * 16 hours (our email). Times are the buyer's local time (the answer's `tz`). Pure; tested in whenItSends.vitest.test.ts.
 */
import { productTypeWords } from '../../../../_lib/reviewWords'
import { isAmazon, type RuleForm } from './ruleForm'

export interface TimingPreview {
  scheduledFor: string | null
  anchorUsed: 'DELIVERY' | 'SHIP' | 'PURCHASE'
  anchorDate: string | null
  delayDays: number
  effectiveDelayDays: number | null
  source: 'rule-override' | 'timing-table' | 'default'
  sendHour: number | null
  sendHourSource: 'rule' | 'window' | 'none'
  tz: string
  /** The rule's first product type; null = an order of any product type. */
  productType: string | null
  channel: string
}

/** The editor's unsaved timing, as the preview asks for it. */
export function previewBody(form: RuleForm) {
  return {
    scope: form.scope,
    marketplace: form.scope === 'AMAZON_PER_MARKETPLACE' ? form.marketplace : null,
    productType: form.productTypes[0] ?? null,
    sendDelayDays: form.firstTryMode === 'custom' ? form.firstTryDays : null,
    anchor: isAmazon(form.scope) ? 'DELIVERY' : form.anchor,
    sendHourLocal: form.fixedHour ? form.sendHour : null,
    skipWeekends: form.skipWeekends,
    shiftToBestDay: form.shiftToBestDay,
    minDaysSinceDelivery: form.windowFrom,
    maxDaysSinceDelivery: form.windowTo,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const AMAZON_LAST_DAY = 30

const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })
const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })

const ANCHOR_LABEL: Record<TimingPreview['anchorUsed'], string> = { DELIVERY: 'Delivered', SHIP: 'Shipped', PURCHASE: 'Ordered' }
const ANCHOR_WORD: Record<TimingPreview['anchorUsed'], string> = { DELIVERY: 'delivery', SHIP: 'shipping', PURCHASE: 'the order' }

export interface WhenStep { label: string; when: string; detail: string }
export interface WhenItSends { line: string; steps: WhenStep[]; note: string }

function sourceWords(p: TimingPreview): string {
  if (p.source === 'rule-override') return 'this rule’s own day'
  if (p.source === 'timing-table') return `the product-type table (“${productTypeWords(p.productType) || p.productType}”)`
  if (!p.productType) return 'the built-in default — each order’s own product type can pick its day from the product-type table'
  return 'the built-in default (no row of the product-type table matched)'
}

function hourWords(p: TimingPreview): string {
  if (p.sendHourSource === 'rule') return ' · this rule’s fixed hour'
  if (p.sendHourSource === 'window') return ' · the best hour of that weekday (Timing)'
  return ''
}

/** The preview in words. */
export function whenItSends(p: TimingPreview): WhenItSends {
  const amazon = p.channel === 'AMAZON'
  const tz = p.tz || 'UTC'
  const note = `Buyer’s local time (${tz}).${amazon ? ' Delivery is our estimate when no carrier scan exists: shipped + 3 working days.' : ''}`
  if (!p.scheduledFor || !p.anchorDate) {
    return { line: 'No first try: the order has no date to count from.', steps: [], note }
  }
  const anchorLabel = ANCHOR_LABEL[p.anchorUsed]
  const first = `${day(p.scheduledFor, tz)} ${time(p.scheduledFor, tz)}`
  const steps: WhenStep[] = [
    { label: anchorLabel, when: day(p.anchorDate, tz), detail: p.productType ? `today, for this preview — a “${productTypeWords(p.productType)}” order` : 'today, for this preview — an order of any product type' },
    { label: 'First try', when: first, detail: `${ANCHOR_WORD[p.anchorUsed]} + ${p.effectiveDelayDays ?? p.delayDays} days · ${sourceWords(p)}${hourWords(p)}` },
  ]
  if (amazon) {
    const last = new Date(new Date(p.anchorDate).getTime() + AMAZON_LAST_DAY * DAY_MS).toISOString()
    steps.push({ label: 'If Amazon says too early', when: `daily until day ${AMAZON_LAST_DAY}`, detail: `the last day is ${day(last, tz)}` })
  } else {
    steps.push({ label: 'If our email fails', when: 'again after 4, 8 and 16 hours', detail: 'three tries in all, once per order' })
  }
  const after = amazon ? `daily until day ${AMAZON_LAST_DAY}` : 'one email, once per order'
  return { line: `${anchorLabel} ${day(p.anchorDate, tz)} → first try ${first} → ${after}`, steps, note }
}
