/**
 * Step 4 Send to FBA (Owner 2026-10-07) — the FBA plans drawer's pure model (Part E2). The drawer
 * (`FbaPlansDrawer.tsx`) only renders what these functions return; every word comes from `FBA_SEND_COPY` or `DRAWER_COPY`.
 *
 * Honest by construction: a status, a time, a fee or a carrier is shown only when the server sent it. A step the plan has
 * not reached is "not yet"; a step with no recorded time shows none; a plan the server did not list is not invented.
 * Nothing here calls a server: the URLs and the answer readers are pure so they are tested; the drawer does the fetches.
 */
import {
  FBA_JOB_STATUSES, FBA_PLAN_VIEWS, FBA_SEND_COPY,
  type FbaChoiceRequest, type FbaPlanListAnswer, type FbaPlanListView, type FbaDeliveryWindowOption, type FbaFee, type FbaMoney, type FbaPlacementOption, type FbaPlacementShipment,
  type FbaPlanLineView, type FbaPlanStatus, type FbaPlanStep, type FbaPlanView, type FbaShipmentView, type FbaShippedRequest, type FbaTransportOption,
} from '@nexus/shared/fba-send'
import { CASE_COPY } from '@nexus/shared/stock-cases'
import type { Tone } from '@/design-system/primitives'
import { commandConflictMessage, type CommandConflict } from '@/lib/command-key'
import type { InvalidationEvent } from '@/lib/sync/invalidation-channel'

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

/** The drawer's own words (everything about a plan's states and steps is `FBA_SEND_COPY`). */
export const DRAWER_COPY = {
  empty: 'No open FBA plans',
  emptyHint: 'Send to FBA… in the Matrix makes one.',
  allPlans: 'All plans',
  reading: 'Reading FBA plans',
  readFailed: 'FBA plans could not be read',
  notFound: 'This plan is not there any more.',
  stale: 'Showing the last read',
  to: (market: string) => `To ${market}`,
  from: (code: string) => `from ${code}`,
  units: (n: number) => plural(n, 'unit'),
  skus: (n: number) => plural(n, 'SKU'),
  boxes: (n: number) => plural(n, 'box', 'boxes'),
  linesTitle: (n: number) => plural(n, 'SKU'),
  lineColumns: ['SKU', 'Units', 'Packed', 'Shipped'] as const,
  choiceLegend: 'Where it goes',
  validUntil: (time: string) => `Options valid until ${time}`,
  carrier: (fc: string) => `${fc} carrier`,
  window: (fc: string) => `${fc} arrives`,
  partnered: 'Amazon-partnered',
  noWindow: (fc: string) => `${fc}: Amazon gave no delivery window for this carrier`,
  noCarrier: (fc: string) => `${fc}: choose a carrier`,
  noOptions: 'Amazon offered no placement option. Cancel the plan, or try again later.',
  discount: (text: string) => `discount ${text}`,
  confirmTitle: 'Confirm with Amazon?',
  back: 'Back',
  confirming: 'Confirming…',
  shippedTitle: 'Mark shipped?',
  trackingGoes: 'The tracking numbers go to Amazon.',
  shipping: 'Marking…',
  cancelTitle: 'Cancel this plan?',
  holdsBack: (from: string | null) => (from ? `Held units go back on sale at ${from}.` : 'Held units go back on sale.'),
  keepPlan: 'Keep plan',
  cancelling: 'Cancelling…',
  retrying: 'Trying again…',
  box: (i: number, n: number) => `Box ${i} of ${n}`,
  trackingMissing: (missing: number, total: number) => `Add a tracking number for every box (${missing} of ${total} missing)`,
  trackingWaiting: (time: string) => `Shipped ${time} · sending tracking`,
  amazonSays: (word: string) => `Amazon: ${word}`,
  shipmentsShipped: (shipped: number, total: number) => `${shipped} of ${plural(total, 'shipment')} shipped`,
  labelsOpening: 'Opening…',
  labelsBlocked: 'The browser kept the labels from opening in a new tab.',
  labelsLink: 'Open labels (PDF)',
  noAnswer: 'No answer from the server. Try again: the same click is never sent twice.',
  readNoAnswer: 'No answer from the server.',
  stepsLabel: 'Plan steps',
  shipmentsLabel: 'Shipments',
  plansLabel: 'Open FBA plans',
  noPlanInAnswer: 'The server answered without the plan. It is read again.',
  failedTitle: 'This did not work',
  request: 'FBA plan request',
} as const

/* ── status ───────────────────────────────────────────────────────────────────────────────────── */

const JOB = new Set<string>(FBA_JOB_STATUSES)

/** The status Pill's tone: the job's states info, a person's turn warning, a failure danger, shipped success, final neutral. */
export function statusTone(status: FbaPlanStatus): Tone {
  switch (status) {
    case 'FAILED': return 'danger'
    case 'WAITING_FOR_CHOICE': case 'READY_TO_SHIP': case 'HELD': return 'warning'
    case 'SHIPPED': case 'AT_AMAZON': return 'success'
    case 'CLOSED': case 'CANCELLED': case 'CANCELLING': case 'DRAFT': return 'neutral'
    default: return 'info'
  }
}

export const statusText = (status: FbaPlanStatus): string => FBA_SEND_COPY.status[status] ?? status

/** True while the job moves the plan by itself (the drawer re-reads more often then). */
export const isRunning = (status: string): boolean => JOB.has(status)

/** One line under a plan's name: `To IT · 120 units · 6 SKUs · from IT-MAIN` (only what the server sent). */
export function planFacts(plan: Pick<FbaPlanView, 'market' | 'units' | 'skus' | 'from'>): string {
  return [
    plan.market ? DRAWER_COPY.to(plan.market) : null,
    DRAWER_COPY.units(plan.units),
    DRAWER_COPY.skus(plan.skus),
    plan.from ? DRAWER_COPY.from(plan.from.code || plan.from.name) : null,
  ].filter(Boolean).join(' · ')
}

/** The plan's name as stored (Amazon's `Nexus IT 2026-10-08 #a1b2c3`); an older row without one shows its id's end. */
export const planName = (plan: Pick<FbaPlanView, 'name' | 'id'>): string => plan.name.trim() || `Plan #${plan.id.slice(-6)}`

/** Newest first (`createdAt`), ties by id so the order never flickers between reads. */
export function newestFirst(plans: readonly FbaPlanView[]): FbaPlanView[] {
  return [...plans].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Which plan the drawer shows: the one the person opened, else the one the host asked for, else the only plan; null =
 * the list.
 */
export function shownPlanId(plans: readonly Pick<FbaPlanView, 'id'>[], selected: string | null, requested: string | null | undefined): string | null {
  if (selected) return selected
  if (requested) return requested
  return plans.length === 1 ? plans[0].id : null
}

/* ── the timeline ─────────────────────────────────────────────────────────────────────────────── */

export type TimelineState = 'done' | 'running' | 'waiting' | 'failed' | 'held' | 'todo' | 'cancelled'

export interface TimelineItem {
  key: string
  label: string
  state: TimelineState
  /** ISO time the step finished; `null` = not yet; `undefined` = no time to show (done with none recorded, running, failed). */
  at: string | null | undefined
  /** One muted line: the server's sentence on a failure / hold, or what the person does next. */
  detail: string | null
}

/** Each step's place on the timeline (PLACE and QUOTE are one item, "Options ready"; TRACKING is "Shipped"). */
const STEP_INDEX: Readonly<Record<FbaPlanStep, number | null>> = {
  CREATE: 0, PACK: 1, BOXES: 2, PLACE: 3, QUOTE: 3, CONFIRM: 4, LABELS: 5, TRACKING: 6, CANCEL: null,
}
const SHIPPED_INDEX = 6
const AT_AMAZON_INDEX = 7
const ALL_DONE = FBA_SEND_COPY.timeline.length

/** Where a status stands on the timeline: the item it is at and how that item looks. FAILED / HELD use `plan.step`. */
const STATUS_AT: Readonly<Partial<Record<FbaPlanStatus, { index: number; state: TimelineState }>>> = {
  QUEUED: { index: 0, state: 'todo' },
  CREATING: { index: 0, state: 'running' },
  PACKING: { index: 1, state: 'running' },
  BOXES: { index: 2, state: 'running' },
  PLACING: { index: 3, state: 'running' },
  QUOTING: { index: 3, state: 'running' },
  WAITING_FOR_CHOICE: { index: 4, state: 'waiting' },
  CONFIRMING: { index: 4, state: 'running' },
  LABELS: { index: 5, state: 'running' },
  READY_TO_SHIP: { index: SHIPPED_INDEX, state: 'waiting' },
  SHIPPED: { index: AT_AMAZON_INDEX, state: 'todo' },
  AT_AMAZON: { index: ALL_DONE, state: 'done' },
  CLOSED: { index: ALL_DONE, state: 'done' },
}

const latest = (times: Array<string | null | undefined>): string | undefined => {
  let best: string | undefined
  for (const t of times) if (t && Number.isFinite(Date.parse(t)) && (!best || Date.parse(t) > Date.parse(best))) best = t
  return best
}

/** When a timeline item finished, from the step log (Amazon's answers) or the shipments; undefined = no time recorded. */
function finishedAt(plan: FbaPlanView, index: number): string | undefined {
  if (index === SHIPPED_INDEX) {
    const shipments = plan.shipments
    return shipments.length > 0 && shipments.every(s => s.shippedAt) ? latest(shipments.map(s => s.shippedAt)) : undefined
  }
  if (index === AT_AMAZON_INDEX) return undefined
  return latest(plan.steps.filter(e => STEP_INDEX[e.step] === index && e.result === 'SUCCESS').map(e => e.finishedAt))
}

const problemSentence = (plan: FbaPlanView): string | null => plan.message ?? plan.problems[0]?.message ?? null

function shippedProgress(plan: FbaPlanView): string {
  const total = plan.shipments.length
  const shipped = plan.shipments.filter(s => s.shippedAt).length
  return total > 0 && shipped > 0 ? DRAWER_COPY.shipmentsShipped(shipped, total) : statusText('READY_TO_SHIP')
}

/** The plan's steps for the DS `Timeline`, in order. */
export function timelineItems(plan: FbaPlanView): TimelineItem[] {
  const base = FBA_SEND_COPY.timeline
  const failing = plan.status === 'FAILED' || plan.status === 'HELD'
  const cancelPath = plan.status === 'CANCELLING' || plan.status === 'CANCELLED' || (failing && plan.step === 'CANCEL')

  if (cancelPath) {
    // Only what Amazon finished before the cancel; the steps that will never run are left out.
    const done = new Set(plan.steps.filter(e => e.result === 'SUCCESS').map(e => STEP_INDEX[e.step]).filter((i): i is number => i !== null))
    const items: TimelineItem[] = base.flatMap((step, index) =>
      done.has(index) ? [{ key: step.key, label: step.label, state: 'done' as const, at: finishedAt(plan, index), detail: null }] : [])
    const state: TimelineState = plan.status === 'CANCELLING' ? 'running' : plan.status === 'CANCELLED' ? 'cancelled' : plan.status === 'FAILED' ? 'failed' : 'held'
    items.push({
      key: 'CANCEL',
      label: statusText(plan.status === 'CANCELLING' ? 'CANCELLING' : 'CANCELLED'),
      state,
      at: state === 'cancelled' ? plan.cancelledAt ?? undefined : undefined,
      detail: state === 'failed' || state === 'held' ? problemSentence(plan) : null,
    })
    return items
  }

  let at: { index: number; state: TimelineState }
  if (failing) {
    const index = plan.step ? STEP_INDEX[plan.step] : null
    at = { index: index ?? 0, state: plan.status === 'FAILED' ? 'failed' : 'held' }
  } else {
    at = STATUS_AT[plan.status] ?? { index: 0, state: 'todo' }
  }

  return base.map((step, index): TimelineItem => {
    if (index < at.index) return { key: step.key, label: step.label, state: 'done', at: finishedAt(plan, index), detail: null }
    if (index > at.index) return { key: step.key, label: step.label, state: 'todo', at: null, detail: null }
    switch (at.state) {
      case 'running': return { key: step.key, label: step.label, state: 'running', at: undefined, detail: null }
      case 'waiting':
        return { key: step.key, label: step.label, state: 'waiting', at: null, detail: index === SHIPPED_INDEX ? shippedProgress(plan) : statusText(plan.status) }
      case 'failed': case 'held':
        return { key: step.key, label: step.label, state: at.state, at: undefined, detail: problemSentence(plan) }
      default:
        return { key: step.key, label: step.label, state: 'todo', at: null, detail: null }
    }
  })
}

export function timelineTone(state: TimelineState): Tone {
  switch (state) {
    case 'done': return 'success'
    case 'running': return 'info'
    case 'waiting': case 'held': return 'warning'
    case 'failed': return 'danger'
    default: return 'neutral'
  }
}

/* ── words for money, days and times ──────────────────────────────────────────────────────────── */

export function moneyText(money: FbaMoney): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: money.currency }).format(money.amount)
  } catch {
    return `${money.amount.toFixed(2)} ${money.currency}`
  }
}

/** Amazon's fees (or discounts), summed per currency: `€0.00`, `€12.50 + £3.00`. No valued entry → `0.00`. */
export function feesText(fees: readonly FbaFee[]): string {
  const sums = new Map<string, number>()
  for (const fee of fees) {
    if (!fee.value || !Number.isFinite(fee.value.amount)) continue
    sums.set(fee.value.currency, (sums.get(fee.value.currency) ?? 0) + fee.value.amount)
  }
  if (sums.size === 0) return '0.00'
  return [...sums].map(([currency, amount]) => moneyText({ amount: Math.round(amount * 100) / 100, currency })).join(' + ')
}

export interface TimeOptions {
  /** IANA zone; absent = the browser's. */
  timeZone?: string
  /** The read's clock (ms); absent = now. */
  now?: number
}

const dayKey = (ms: number, timeZone?: string) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(ms)

/** `10:42` today, `8 Oct 10:42` another day. An unreadable time → the text the server sent. */
export function clockText(iso: string, opts: TimeOptions = {}): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: opts.timeZone }).format(ms)
  if (dayKey(ms, opts.timeZone) === dayKey(opts.now ?? Date.now(), opts.timeZone)) return time
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: opts.timeZone }).format(ms)
  return `${day} ${time}`
}

/** A delivery window's two ends: `14`, `21 Oct` in one month; `28 Oct`, `3 Nov` across two. */
export function dayRange(startIso: string, endIso: string, timeZone?: string): { start: string; end: string } {
  const s = Date.parse(startIso)
  const e = Date.parse(endIso)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { start: startIso, end: endIso }
  const parts = (ms: number) => {
    const p = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).formatToParts(ms)
    const get = (type: string) => p.find(x => x.type === type)?.value ?? ''
    return { day: get('day'), month: get('month'), year: get('year') }
  }
  const a = parts(s)
  const b = parts(e)
  const end = `${b.day} ${b.month}`
  return { start: a.month === b.month && a.year === b.year ? a.day : `${a.day} ${a.month}`, end }
}

export const windowText = (w: Pick<FbaDeliveryWindowOption, 'start' | 'end'>, timeZone?: string): string => {
  const r = dayRange(w.start, w.end, timeZone)
  return `${r.start}–${r.end}`
}
export const arriveText = (w: Pick<FbaDeliveryWindowOption, 'start' | 'end'>, timeZone?: string): string => {
  const r = dayRange(w.start, w.end, timeZone)
  return FBA_SEND_COPY.arrive(r.start, r.end)
}

/** Amazon's own status word, readable: `IN_TRANSIT` → `in transit`. */
export const amazonWord = (status: string): string => status.trim().toLowerCase().replace(/_+/g, ' ')

/* ── the choice (WAITING_FOR_CHOICE) ──────────────────────────────────────────────────────────── */

/** What the person picked for one shipment of the chosen placement option. */
export interface ShipmentPick {
  transportationOptionId: string
  /** Own carrier: the delivery window; null for an Amazon-partnered carrier (or none picked yet). */
  deliveryWindowOptionId: string | null
}
/** shipmentId (sh…) → the pick. */
export type ChoicePicks = Readonly<Record<string, ShipmentPick>>

/** Amazon-partnered carriers take no delivery window; every other carrier needs one (the contract's rule). */
export const isPartnered = (t: Pick<FbaTransportOption, 'shippingSolution'>): boolean => t.shippingSolution === 'AMAZON_PARTNERED_CARRIER'
const needsWindow = (t: Pick<FbaTransportOption, 'shippingSolution'>): boolean => !isPartnered(t)

/** The options Amazon offers now, in Amazon's order. */
export function offeredPlacements(plan: Pick<FbaPlanView, 'options'>): FbaPlacementOption[] {
  return (plan.options?.placements ?? []).filter(p => p.status.toUpperCase() === 'OFFERED')
}

/** The shipment's fulfilment centre as Amazon named it (its code, else its town). */
export const fcOf = (s: Pick<FbaPlacementShipment, 'destinationFc' | 'destinationTown' | 'shipmentId'>): string =>
  s.destinationFc || s.destinationTown || s.shipmentId

/** Windows earliest first. */
export const windowsByStart = (s: Pick<FbaPlacementShipment, 'deliveryWindows'>): FbaDeliveryWindowOption[] =>
  [...s.deliveryWindows].sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0))

/** The pick for one shipment when it changes carrier: a carrier that needs a window gets the earliest unless one is picked. */
function pickFor(shipment: FbaPlacementShipment, transport: FbaTransportOption, windowId: string | null): ShipmentPick {
  if (!needsWindow(transport)) return { transportationOptionId: transport.transportationOptionId, deliveryWindowOptionId: null }
  const windows = windowsByStart(shipment)
  const keep = windowId && windows.some(w => w.deliveryWindowOptionId === windowId) ? windowId : null
  return { transportationOptionId: transport.transportationOptionId, deliveryWindowOptionId: keep ?? windows[0]?.deliveryWindowOptionId ?? null }
}

/** The defaults: per shipment the first own-carrier option Amazon lists (else its first), and the earliest window. */
export function defaultPicks(option: FbaPlacementOption): ChoicePicks {
  const out: Record<string, ShipmentPick> = {}
  for (const shipment of option.shipments) {
    const transport = shipment.transport.find(t => !isPartnered(t)) ?? shipment.transport[0]
    if (transport) out[shipment.shipmentId] = pickFor(shipment, transport, null)
  }
  return out
}

/** A new carrier for one shipment (the window follows the carrier's rule). Unknown ids leave the picks unchanged. */
export function withTransport(picks: ChoicePicks, option: FbaPlacementOption, shipmentId: string, transportationOptionId: string): ChoicePicks {
  const shipment = option.shipments.find(s => s.shipmentId === shipmentId)
  const transport = shipment?.transport.find(t => t.transportationOptionId === transportationOptionId)
  if (!shipment || !transport) return picks
  return { ...picks, [shipmentId]: pickFor(shipment, transport, picks[shipmentId]?.deliveryWindowOptionId ?? null) }
}

/** A new delivery window for one shipment (only one Amazon offers for it). */
export function withWindow(picks: ChoicePicks, option: FbaPlacementOption, shipmentId: string, deliveryWindowOptionId: string): ChoicePicks {
  const shipment = option.shipments.find(s => s.shipmentId === shipmentId)
  const pick = picks[shipmentId]
  if (!shipment || !pick || !shipment.deliveryWindows.some(w => w.deliveryWindowOptionId === deliveryWindowOptionId)) return picks
  return { ...picks, [shipmentId]: { ...pick, deliveryWindowOptionId } }
}

/** A carrier in a Select: `UPS`, `UPS · Amazon-partnered · €45.00`; a mode other than small parcel is named. */
export function transportText(t: FbaTransportOption): string {
  const name = t.carrierName || t.carrierCode || FBA_SEND_COPY.ownCarrier
  const mode = t.shippingMode && t.shippingMode !== 'GROUND_SMALL_PARCEL' ? amazonWord(t.shippingMode) : null
  const partnered = isPartnered(t) ? [DRAWER_COPY.partnered, t.quote ? moneyText(t.quote.cost) : null] : []
  return [name, mode, ...partnered].filter(Boolean).join(' · ')
}

/** The RadioCard's title: `2 shipments · MXP5, FCO1 · Amazon fees €0.00`. */
export function placementTitle(option: FbaPlacementOption): string {
  return FBA_SEND_COPY.option(option.shipments.length, option.shipments.map(fcOf), feesText(option.fees))
}

/** One shipment's chosen carrier and arrival: `Own carrier · UPS · arrive 14–21 Oct`, `UPS · Amazon-partnered · €45.00`. */
export function pickText(shipment: FbaPlacementShipment, pick: ShipmentPick | undefined, timeZone?: string): string | null {
  const transport = pick ? shipment.transport.find(t => t.transportationOptionId === pick.transportationOptionId) : undefined
  if (!pick || !transport) return null
  if (isPartnered(transport)) return transportText(transport)
  const window = pick.deliveryWindowOptionId ? shipment.deliveryWindows.find(w => w.deliveryWindowOptionId === pick.deliveryWindowOptionId) : undefined
  const name = transport.carrierName || transport.carrierCode
  return [FBA_SEND_COPY.ownCarrier, name, window ? arriveText(window, timeZone) : null].filter(Boolean).join(' · ')
}

/** The RadioCard's description lines: one per shipment (`MXP5: …` when there are several), plus Amazon's discount. */
export function placementLines(option: FbaPlacementOption, picks: ChoicePicks, timeZone?: string): string[] {
  const several = option.shipments.length > 1
  const lines = option.shipments.flatMap(s => {
    const text = pickText(s, picks[s.shipmentId], timeZone)
    return text ? [several ? `${fcOf(s)}: ${text}` : text] : []
  })
  if (option.discounts.some(d => d.value)) lines.push(DRAWER_COPY.discount(feesText(option.discounts)))
  return lines
}

/** Why "Confirm with Amazon" is held for these picks; null = ready. */
export function choiceHeld(option: FbaPlacementOption | null, picks: ChoicePicks): string | null {
  if (!option) return DRAWER_COPY.noOptions
  for (const shipment of option.shipments) {
    const pick = picks[shipment.shipmentId]
    const transport = pick ? shipment.transport.find(t => t.transportationOptionId === pick.transportationOptionId) : undefined
    if (!pick || !transport) return DRAWER_COPY.noCarrier(fcOf(shipment))
    if (needsWindow(transport) && !(pick.deliveryWindowOptionId && shipment.deliveryWindows.some(w => w.deliveryWindowOptionId === pick.deliveryWindowOptionId))) {
      return DRAWER_COPY.noWindow(fcOf(shipment))
    }
  }
  return null
}

/** POST /api/fba/inbound/plans/:id/choice — one entry per shipment of the chosen option, in Amazon's order. */
export function choicePayload(option: FbaPlacementOption, picks: ChoicePicks): FbaChoiceRequest {
  return {
    placementOptionId: option.placementOptionId,
    shipments: option.shipments.map(s => {
      const pick = picks[s.shipmentId]
      const transport = pick ? s.transport.find(t => t.transportationOptionId === pick.transportationOptionId) : undefined
      return {
        shipmentId: s.shipmentId,
        transportationOptionId: pick?.transportationOptionId ?? '',
        deliveryWindowOptionId: pick && transport && needsWindow(transport) ? pick.deliveryWindowOptionId : null,
      }
    }),
  }
}

/* ── the shipments (READY_TO_SHIP and after) ──────────────────────────────────────────────────── */

/** `FBA15ABC · MXP5 · 3 boxes`. */
export const shipmentTitle = (s: Pick<FbaShipmentView, 'shipmentConfirmationId' | 'destinationFc' | 'boxes'>): string =>
  [s.shipmentConfirmationId, s.destinationFc, DRAWER_COPY.boxes(s.boxes.length)].filter(Boolean).join(' · ')

/** The carrier and window Amazon confirmed: `Own carrier · UPS · arrive 14–21 Oct`; null = none recorded. */
export function shipmentTransportText(s: Pick<FbaShipmentView, 'transport'>, timeZone?: string): string | null {
  const t = s.transport
  if (!t) return null
  if (isPartnered(t)) return [t.carrierName || t.carrierCode, DRAWER_COPY.partnered, t.quote ? moneyText(t.quote) : null].filter(Boolean).join(' · ')
  return [FBA_SEND_COPY.ownCarrier, t.carrierName || t.carrierCode, t.deliveryWindow ? arriveText(t.deliveryWindow, timeZone) : null].filter(Boolean).join(' · ')
}

/** The person may pack and mark this shipment Shipped. */
export const canShip = (plan: Pick<FbaPlanView, 'status'>, s: Pick<FbaShipmentView, 'shippedAt' | 'boxes'>): boolean =>
  plan.status === 'READY_TO_SHIP' && !s.shippedAt && s.boxes.length > 0
/** Amazon prints labels for this shipment (fresh link each time; reprints after Shipped too). */
export const canPrintLabels = (plan: Pick<FbaPlanView, 'status'>, s: Pick<FbaShipmentView, 'boxes'>): boolean =>
  (plan.status === 'READY_TO_SHIP' || plan.status === 'SHIPPED' || plan.status === 'AT_AMAZON') && s.boxes.length > 0

/** boxId → the tracking number typed. */
export type TrackingDraft = Readonly<Record<string, string>>

export interface TrackingRow {
  boxId: string
  label: string
  /** The box's content: `GALE-M ×12 · GALE-L ×4`. */
  content: string
  value: string
}

const contentText = (items: ReadonlyArray<{ msku: string; quantity: number }>): string => {
  const shown = items.slice(0, 3).map(i => `${i.msku} ×${i.quantity}`)
  return items.length > 3 ? `${shown.join(' · ')} · +${items.length - 3}` : shown.join(' · ')
}

/** One row per box, in Amazon's order. */
export function trackingRows(s: Pick<FbaShipmentView, 'boxes'>, typed: TrackingDraft): TrackingRow[] {
  return s.boxes.map((box, i) => ({ boxId: box.boxId, label: DRAWER_COPY.box(i + 1, s.boxes.length), content: contentText(box.items), value: typed[box.boxId] ?? '' }))
}

/**
 * A paste of several numbers (one per line, or tab-separated from a sheet) fills this box and the ones below it.
 * One number → null (the field takes the paste as usual).
 */
export function fillDown(boxIds: readonly string[], fromBoxId: string, pasted: string, typed: TrackingDraft): Record<string, string> | null {
  const values = pasted.split(/[\r\n\t]+/).map(v => v.trim()).filter(Boolean)
  const from = boxIds.indexOf(fromBoxId)
  if (values.length < 2 || from < 0) return null
  const next: Record<string, string> = { ...typed }
  values.slice(0, boxIds.length - from).forEach((v, i) => { next[boxIds[from + i]] = v })
  return next
}

/** Why "Mark shipped" is held; null = every box has a number. */
export function trackingHeld(s: Pick<FbaShipmentView, 'boxes'>, typed: TrackingDraft): string | null {
  const missing = s.boxes.filter(b => !(typed[b.boxId] ?? '').trim()).length
  return missing > 0 ? DRAWER_COPY.trackingMissing(missing, s.boxes.length) : null
}

/** POST /api/fba/inbound/shipments/:id/shipped. */
export function shippedPayload(s: Pick<FbaShipmentView, 'boxes'>, typed: TrackingDraft): FbaShippedRequest {
  return { tracking: s.boxes.map(b => ({ boxId: b.boxId, trackingId: (typed[b.boxId] ?? '').trim() })) }
}

/** The confirm line: `24 units leave IT-MAIN`. */
export const shippedConfirmText = (plan: Pick<FbaPlanView, 'from'>, s: Pick<FbaShipmentView, 'units'>): string =>
  FBA_SEND_COPY.shippedConfirm(s.units, plan.from?.code || plan.from?.name || 'the warehouse')

/** After Shipped: `Shipped 10:42 · tracking sent · Amazon: in transit` (tracking "sent" only when Amazon took it). */
export function shippedText(s: Pick<FbaShipmentView, 'shippedAt' | 'tracking' | 'status'>, opts: TimeOptions = {}): string | null {
  if (!s.shippedAt) return null
  const time = clockText(s.shippedAt, opts)
  const head = s.tracking?.sentAt ? FBA_SEND_COPY.shippedLine(time) : DRAWER_COPY.trackingWaiting(time)
  return s.status ? `${head} · ${DRAWER_COPY.amazonSays(amazonWord(s.status))}` : head
}

/* ── the plan's SKUs ──────────────────────────────────────────────────────────────────────────── */

/**
 * How a line is packed: `8 loose`, `1 case of 12`, `2 cases of 12 + 3 loose`, `2×12 + 1×6 + 3 loose` (several case
 * sizes; a size with 0 cases left out), `—` when nothing.
 */
export function packedText(line: Pick<FbaPlanLineView, 'cases' | 'looseUnits'>): string {
  const sealed = (line.cases ?? []).filter(c => c.cases > 0)
  const parts: string[] = []
  if (sealed.length === 1) parts.push(`${plural(sealed[0].cases, 'case')} of ${sealed[0].unitsPerCase}`)
  else if (sealed.length > 1) parts.push(CASE_COPY.cases(sealed))
  if (line.looseUnits > 0) parts.push(`${line.looseUnits.toLocaleString('en-GB')} loose`)
  return parts.length ? parts.join(' + ') : '—'
}

export function lineRows(plan: Pick<FbaPlanView, 'lines'>): Array<{ id: string; cells: [string, string, string, string] }> {
  return plan.lines.map(l => ({ id: l.productId, cells: [l.sku, String(l.quantity), packedText(l), String(l.shippedQuantity)] }))
}

/* ── the routes (Part C, `routes/fba-send.routes.ts`) ─────────────────────────────────────────── */

const enc = encodeURIComponent
export const FBA_ROUTES = {
  plans: (productId: string) => `/api/fba/inbound/plans?productId=${enc(productId)}&open=1`,
  /** The FBA shipments page: one tab, newest first, a page at a time. */
  list: (view: FbaPlanListView, cursor?: string | null, limit = 50) =>
    `/api/fba/inbound/plans?view=${enc(view)}&limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ''}`,
  plan: (planId: string) => `/api/fba/inbound/plans/${enc(planId)}`,
  choice: (planId: string) => `/api/fba/inbound/plans/${enc(planId)}/choice`,
  cancel: (planId: string) => `/api/fba/inbound/plans/${enc(planId)}/cancel`,
  retry: (planId: string) => `/api/fba/inbound/plans/${enc(planId)}/retry`,
  labels: (shipmentId: string) => `/api/fba/inbound/shipments/${enc(shipmentId)}/labels`,
  shipped: (shipmentId: string) => `/api/fba/inbound/shipments/${enc(shipmentId)}/shipped`,
} as const

/** The key slot of one click (`commandKeyFor`): a retry of the same verb on the same plan / shipment reuses its key. */
export const commandSlot = (verb: 'choice' | 'cancel' | 'retry' | 'shipped', id: string): string => `fba-${verb}:${id}`

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const looksLikePlan = (v: unknown): v is FbaPlanView =>
  isRecord(v) && typeof v.id === 'string' && typeof v.status === 'string' && Array.isArray(v.steps) && Array.isArray(v.shipments) && isRecord(v.can)

/** The server's sentence of a refusal (`{ ok: false, code, error, problems }`), with its problems' sentences. */
export function refusalText(status: number, body: unknown): { message: string; problems: string[] } {
  const said = isRecord(body) ? (typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : null) : null
  const problems = isRecord(body) && Array.isArray(body.problems)
    ? body.problems.flatMap(p => (isRecord(p) && typeof p.message === 'string' ? [p.message] : []))
    : []
  return { message: said ?? `The server refused this (HTTP ${status}).`, problems }
}

export type PlanAnswer = { ok: true; plan: FbaPlanView } | { ok: false; message: string; problems: string[] }

/** A command's answer (choice, cancel, retry, shipped): the plan as the server holds it now, or its sentence. */
export function readPlanAnswer(status: number, body: unknown, conflict: CommandConflict | null): PlanAnswer {
  if (conflict) return { ok: false, message: commandConflictMessage(conflict, DRAWER_COPY.request), problems: [] }
  if (status >= 200 && status < 300) {
    return looksLikePlan(body) ? { ok: true, plan: body } : { ok: false, message: DRAWER_COPY.noPlanInAnswer, problems: [] }
  }
  return { ok: false, ...refusalText(status, body) }
}

/** GET /plans?productId=&open=1 → the plans newest first; anything else throws the server's sentence. */
export function readPlansAnswer(status: number, body: unknown): FbaPlanView[] {
  if (status >= 200 && status < 300 && isRecord(body) && Array.isArray(body.plans)) return newestFirst(body.plans.filter(looksLikePlan))
  throw new Error(refusalText(status, body).message)
}

const countOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

/** GET /plans?view=&cursor= → the page's tab: its plans (in the server's order), the next cursor and every tab's count. */
export function readPlanListAnswer(status: number, body: unknown): FbaPlanListAnswer {
  if (status >= 200 && status < 300 && isRecord(body) && Array.isArray(body.plans)) {
    const counts = isRecord(body.counts) ? body.counts : {}
    return {
      plans: body.plans.filter(looksLikePlan),
      next: typeof body.next === 'string' && body.next ? body.next : null,
      counts: Object.fromEntries(FBA_PLAN_VIEWS.map(v => [v, countOf(counts[v])])) as Record<FbaPlanListView, number>,
    }
  }
  throw new Error(refusalText(status, body).message)
}

/** GET /plans/:id → the plan; 404 → null; anything else throws the server's sentence. */
export function readOnePlanAnswer(status: number, body: unknown): FbaPlanView | null {
  if (status === 404) return null
  if (status >= 200 && status < 300 && looksLikePlan(body)) return body
  throw new Error(refusalText(status, body).message)
}

/** GET /shipments/:id/labels → the fresh link; anything else throws the server's sentence. */
export function readLabelsAnswer(status: number, body: unknown): string {
  if (status >= 200 && status < 300 && isRecord(body) && typeof body.downloadUrl === 'string' && /^https?:\/\//.test(body.downloadUrl)) return body.downloadUrl
  throw new Error(refusalText(status, body).message)
}

/* ── live ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The server's `fba.plan_changed`, as the web's event bridge (Part E1, `use-listing-events.ts`) passes it on:
 * `inventory.stock_changed` per product with `meta.subtype: 'fba-plan'` and `meta.planId`. Any of them re-reads the
 * drawer (a new plan of this family arrives the same way).
 */
export const isFbaPlanEvent = (event: Pick<InvalidationEvent, 'type' | 'meta'>): boolean =>
  event.type === 'inventory.stock_changed' && event.meta?.subtype === 'fba-plan'

/** The gentle re-read: every 8 s while the job moves a shown plan, else every 60 s (events are hints, not a promise). */
export const REREAD_RUNNING_MS = 8_000
export const REREAD_IDLE_MS = 60_000
export const rereadDelay = (plans: ReadonlyArray<Pick<FbaPlanView, 'status'>>): number =>
  plans.some(p => isRunning(p.status)) ? REREAD_RUNNING_MS : REREAD_IDLE_MS

/** When the plan last moved, from what the server sent: the newest of its creation, steps, confirm, cancel and shipments. */
export function planUpdatedAt(plan: Pick<FbaPlanView, 'createdAt' | 'steps' | 'confirmedAt' | 'cancelledAt' | 'shipments'>): string {
  return latest([plan.createdAt, plan.confirmedAt, plan.cancelledAt, ...plan.steps.map(e => e.finishedAt), ...plan.shipments.map(s => s.shippedAt)]) ?? plan.createdAt
}

/** The boxes of a plan Amazon has (its shipments'); `—` before that (a draft, or a plan before its boxes are sent). */
export function planBoxesText(plan: Pick<FbaPlanView, 'shipments'>): string {
  const n = plan.shipments.reduce((sum, s) => sum + s.boxes.length, 0)
  return n > 0 ? n.toLocaleString('en-GB') : '—'
}

/** The products of a plan, for the stock re-read hint after a click here (cancel releases holds; Shipped moves units). */
export const planProductIds = (plan: Pick<FbaPlanView, 'lines'>): string[] => [...new Set(plan.lines.map(l => l.productId))]
