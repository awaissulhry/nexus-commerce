import { PLAIN_STAGES, type PlainStage, type StageStripInput } from '../../../../../lib/production/model'
import { officeStripStateOf, type OfficeStripState } from '@nexus/factory-domain/production-brand/stages' // F-OO-101: the ONE strip state
import type { Order } from '../../api'
import type { Phrase } from '../../model'
import type { BrandStage, Dates, Headline } from './api'
// ---- F-OO-104: the strips read the ONE waiting list's HOLD rows (the order read's own yes and deposit when the production read is not in)
import { isAfterProduction } from '@nexus/factory-domain/production-brand/stages'
import type { OpenApproval } from '../../api'
import type { Approval } from '../../depth/api'
import { openRequest } from '../../depth/model'
import { depositGate } from '../../model'
import type { OrderProduction, Words } from './api'
import { waitingOf, type WaitingRow, type WaitingState } from './model'
// ---- end F-OO-104
// ---- F-OO-105: each strip's real door — the band's yes, the depth's ask / take back, the payment, the row's Lift, Quality, the review
import { holdsAddress } from '../../../../quality/holds/model'
import { recordHref as profileHref } from '../../../mtm/model'
import { askHeld, withdrawHeld, yesDoorOf, type DepthCan, type YesDoor } from '../../depth/model'
import { rowActsOf, type ActsCan } from '../../../../../lib/production/work-order-acts/model'
import type { OrderAbilities } from '../../model'
import type { WorkOrderOwn } from './api'
// ---- end F-OO-105
// ---- F-OO-107: the order's own moves, from the band's own rules (none of them changes here)
import { CANCEL_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { cancelHeld, closeHeld, isShippedInFull, readyHeld } from '../../model'
import { ELSEWHERE_FROM } from '../shipments/elsewhere/model'
// ---- end F-OO-107
// ---- F-OO-106: the order's own credit hold — its read, Check credit again, Ask for a yes…, the answers in words ----
import { isApiError } from '../../../../../lib/api/errors'
import { writeProblem } from '../../model'
import type { CreditCheckAnswer, CreditCustomer } from '../credit/api'
// ---- end F-OO-106

/**
 * F-OO-100 (order overview lane: one file per section) — "Where it is now", its rules moved out of model.ts (F-SA-232). The health
 * stays in model.ts: the band reads it too.
 *
 * F-OO-101 / F-OO-102 / F-OO-103: the headline is the status and the stage, the five stages read the same office state, and the
 * section keeps only that (the facts that left live on in one other place each: WhereCard.tsx says where).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The production read's stage is the parts' plain stage (the same five codes). */
export const plainStageOf = (stage: BrandStage): PlainStage => stage

// ---- F-OO-101 (order overview §1.2; review F8, F11): the headline is the status AND the stage, in one sentence the dots agree with ----
/**
 * The band's own status word (`status.*`), then " · ", then the production stage word (`parts.stage.*`): "In production · Quality
 * check", "Confirmed · Preparing", "Partly shipped · Ready to ship". One word per thing: the status "Ready" with every piece ready
 * is the stage alone, "Ready to ship" (never "Ready · Ready to ship"). Waiting for a yes: the status alone and a quiet line (production
 * starts once the order is confirmed). Shipped: "Shipped 12/11", "· delivered 14/11" once the order is delivered; closed: "Closed ·
 * shipped 12/11". Cancelled: "Cancelled" and, when work had begun, where it had reached. No "· 1 line ahead" (F8: not in the sketch,
 * never explained). The state is the domain's `officeStripStateOf` — the dots read the same one (`stageStripOf`), so the two never
 * disagree. Derived: the stage is the floor's and quality's, never set here.
 */
export interface HeadlineWords {
  /** The office strip state (the domain's): the headline and the dots read the same one. */
  readonly state: OfficeStripState
  /** The status words — `status.*`, or after shipping the dated words; null when the stage word says it alone ("Ready to ship"). */
  readonly status: Phrase | null
  /** The stage word after it: a plain stage, 'unknown' ("Stage not known yet", never step 1), or null (waiting, after production). */
  readonly stage: PlainStage | 'unknown' | null
  /** The quiet line under the headline: waiting — production starts once confirmed; cancelled — where the work had reached. */
  readonly note: { readonly key: string; readonly stage?: PlainStage } | null
}

/** The latest of some instants (null: none). */
const latestOf = (instants: readonly (string | null)[]): string | null => instants.filter((at): at is string => !!at).sort().at(-1) ?? null

export function headlineOf(order: Pick<Order, 'status' | 'chain'>, headline: Headline | null | undefined): HeadlineWords {
  const state = officeStripStateOf(order.status)
  const stage = headline?.stage ? plainStageOf(headline.stage.code) : null
  const status = phrase(`status.${order.status}`)
  switch (state) {
    case 'WAITING':
      return { state, status, stage: null, note: { key: 'where.note.waiting' } }
    case 'STOPPED':
      // Where the work had reached, from the kept stage — only once it was beyond Preparing (nothing begun: nothing to say).
      return { state, status, stage: null, note: stage && PLAIN_STAGES.indexOf(stage) > 0 ? { key: 'where.note.reached', stage } : null }
    case 'ALL_DONE': {
      const shipped = latestOf(order.chain.shipments.map((shipment) => shipment.shippedAt))
      // "Delivered" only once the order is (its last shipment arrived): an older shipment's arrival never reads as the order's.
      const delivered = order.status === 'DELIVERED' ? latestOf(order.chain.shipments.map((shipment) => shipment.deliveredAt)) : null
      if (order.status === 'CLOSED') return { state, status: shipped ? phrase('where.headline.closedShipped', { shipped }) : status, stage: null, note: null }
      if (shipped && delivered) return { state, status: phrase('overview.headline.delivered', { shipped, delivered }), stage: null, note: null }
      return { state, status: shipped ? phrase('overview.headline.shipped', { shipped }) : status, stage: null, note: null }
    }
    case 'CURRENT':
      if (order.status === 'READY' && stage === 'READY') return { state, status: null, stage: 'READY', note: null }
      // Confirmed with no stage read yet: the order is preparing (before any work order); in production: "Stage not known yet".
      return { state, status, stage: stage ?? (order.status === 'CONFIRMED' ? 'PREPARING' : 'unknown'), note: null }
  }
}
// ---- end F-OO-101

/**
 * The five plain stages for the StageStrip (office face): the stage now, its day, the working plan's days, the blocked mark.
 * F-OO-102 (order overview §1.2; review F11): with the office's strip state — the domain's `officeStripStateOf`, the headline's own —
 * so the dots never disagree with the words: waiting for a yes, every stage to come; production over, every stage done (the kept
 * stage keeps its day); cancelled, no strip. The blocked mark stays while the work is current, but its why leaves the current dot's
 * note: the strips say it (one place per fact). Derived: the floor and quality set the stages, never a hand.
 */
export function stageStripOf(order: Pick<Order, 'status'>, headline: Headline | null | undefined, dates: Dates | null | undefined): StageStripInput {
  const state = officeStripStateOf(order.status)
  const stage = headline?.stage ?? null
  if (state === 'WAITING' || state === 'STOPPED') return { state, stage: null }
  if (state === 'ALL_DONE') return { state, stage: stage ? plainStageOf(stage.code) : null, reached: stage?.since ? { [stage.code]: stage.since } : {} }
  const planned = dates?.planned ?? null
  const expected: Partial<Record<PlainStage, string | null>> = { CUTTING: planned?.cutStart ?? null, SEWING: planned?.sewStart ?? null, QUALITY: planned?.finish ?? null }
  const blocked = headline?.held ? { why: null } : null
  if (!stage) {
    // Before any work order the order is preparing (never "step 1" by default once it is in work).
    if (order.status === 'CONFIRMED') return { state, stage: 'PREPARING', expected, blocked }
    return { state, stage: null }
  }
  return { state, stage: plainStageOf(stage.code), reached: stage.since ? { [stage.code]: stage.since } : {}, expected, sewingCounted: !stage.sewingNotCounted, blocked }
}

/**
 * F-OO-102: the dots are drawn — with their quiet line ("Stages are set by the floor and quality, never by hand") — only where they say
 * something true: while the work is current and once production is over; never while the order waits for a yes (no stage is now)
 * or once it is cancelled (the headline's line says where the work had reached).
 */
export const stagesShown = (state: OfficeStripState): boolean => state === 'CURRENT' || state === 'ALL_DONE'

// ---- F-OO-104 (order overview §1.3; review F1, F13; Owner D6): the strips — one per hold or wait, most blocking first ----
/**
 * What stops the order now, one strip each, most blocking first: the order's own yes, its credit hold, the factory review of its
 * made-to-measure units, the deposit, then ONE strip per hold kind — quality, our production hold, the customer's pause — "on N work
 * orders" with the reasons' words (`headline.holds`) and the earliest since (any other kind the list places with the holds keeps its
 * own strip, never hidden). They read the ONE waiting list's HOLD rows (`waiting.holds`, F-OO-202), so the header, the cards and the
 * Changes tab cannot disagree with them; while the production read is out (reading, failed) the same call over the order read alone
 * gives the order's own yes, and the deposit is the order read's gate — a failed read keeps the yes, the credit and the deposit.
 *
 * Two cases a work order can be in (F13), two sets of words: one this reader reaches that also makes other customers' work (named,
 * `shared`: lifted on its own page), and one this reader does not reach (never named, only counted: `notReached`).
 * After production (shipped, delivered, closed, cancelled) nothing stops the work: no strip at all, though the office read still
 * sends the live holds in `headline.held` / `holds` (B-OO-007 emptied only the blockers, F11; plan §5). No account-hold strip (D6).
 */
export const STRIP_KINDS = ['yes', 'credit', 'review', 'deposit', 'quality', 'production', 'pause', 'other'] as const
export type StripKind = (typeof STRIP_KINDS)[number]

/** A work order a hold strip names: this reader reaches it; `shared`: it also makes other customers' work. */
export interface StripWorkOrder {
  readonly id: string
  /** Its number; null when neither read names it. */
  readonly number: string | null
  readonly shared: boolean
}

/** The work orders a hold strip stops: those reached, by number, and those this reader does not reach (counted, never named). */
export interface StripWorkOrders {
  readonly reached: readonly StripWorkOrder[]
  readonly notReached: number
}

type StripBase = {
  readonly key: string
  /** When it started (an instant, or a day for a hold the read dates only by day); null: not known. */
  readonly since: string | null
}

export type WhereStrip =
  /** The order's yes (SALES_ORDER) or its credit hold's (CREDIT_OVERRIDE): its open task when one is asked; who decides. */
  | (StripBase & { readonly kind: 'yes' | 'credit'; readonly task: OpenApproval | null; readonly asked: boolean; readonly who: string | null })
  /** The factory review of the made-to-measure units (MEASUREMENTS): how many wait (null: not said). */
  | (StripBase & { readonly kind: 'review'; readonly count: number | null })
  /** The deposit production waits for: an open request (its id, due day) or one never asked. */
  | (StripBase & { readonly kind: 'deposit'; readonly state: 'WAITING' | 'MISSING'; readonly requestId: string | null; readonly due: string | null })
  /** One hold kind: the reasons' words, the work orders it stops; `blocker` is the list's kind (another kind: its own words). */
  | (StripBase & { readonly kind: 'quality' | 'production' | 'pause' | 'other'; readonly blocker: string; readonly reasons: readonly Words[]; readonly workOrders: StripWorkOrders })

export interface WhereStrips {
  readonly strips: readonly WhereStrip[]
  /** The production read's own part of them (the holds): reading (one quiet row), failed (said, with Try again) or read. */
  readonly holds: 'reading' | 'failed' | 'read'
}

/** At most this many strips show; the rest fold behind "Show {n} more". */
export const STRIPS_SHOWN = 4

/** Each hold kind of the waiting list that has a strip of its own, in its blocking order; any other HOLD kind is `other`. */
const HOLD_STRIPS: Readonly<Record<string, 'quality' | 'production' | 'pause'>> = Object.freeze({ QUALITY_HOLD: 'quality', NO_MOVE: 'production', BRAND_PAUSE: 'pause' })
/** The headline's hold words (`headline.holds[].kind`) each strip reads its reasons from. */
const REASON_KIND = Object.freeze({ quality: 'QUALITY', production: 'PRODUCTION', pause: 'BRAND' } as const)
const ORDER_OF: readonly StripKind[] = STRIP_KINDS

/** Oldest first; a start not known last. */
const byStart = (a: string | null, b: string | null): number => (a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : Date.parse(a) - Date.parse(b))
/** The earliest of some instants or days (null: none known). */
const earliestOf = (values: readonly (string | null | undefined)[]): string | null => values.filter((value): value is string => !!value).sort(byStart)[0] ?? null

// F-OO-106: the order read (orderSchema) sends no `waits` or `madeToMeasure` — the list rows do — so they are optional here: read when
// a caller has them (a list row, a design case), else the yes's own read says why the order waits.
type StripOrder = Pick<Order, 'status' | 'openApprovals' | 'depositRequired' | 'chain'> & { readonly waits?: readonly string[] | null; readonly madeToMeasure?: { readonly waitingReview: number } | null }

export function whereStripsOf(order: StripOrder, read: Pick<OrderProduction, 'headline' | 'work'> | null | undefined, approval: Pick<Approval, 'reasons' | 'creditHold' | 'requests'> | null | undefined, waiting: WaitingState): WhereStrips {
  const holds = waiting.status === 'loading' ? 'reading' : waiting.status === 'failed' ? 'failed' : 'read'
  if (isAfterProduction(officeStripStateOf(order.status))) return { strips: [], holds: 'read' }
  // The ONE list's HOLD rows; without the production read the same call over the order read alone (its own open yes, no blocker).
  const rows: readonly WaitingRow[] = waiting.status === 'ready' ? waiting.holds : waitingOf(null, { requests: null, approvals: order.openApprovals, recordPayment: false, locale: 'en' }).filter((row) => row.place === 'HOLD')
  const tasks = rows.flatMap((row) => (row.door.kind === 'yes' ? [row.door.task] : []))
  const reasons: readonly string[] = order.waits ?? approval?.reasons.map((entry) => entry.reason) ?? []
  const waits = order.status === 'PENDING_APPROVAL'
  const strips: WhereStrip[] = []

  // The order's own yes: asked (its task, or a request open the reader does not see as a task) or nobody asked yet.
  const own = tasks.find((task) => task.kind === 'SALES_ORDER') ?? null
  const request = approval ? openRequest(approval) : null
  if (own || (waits && (reasons.includes('REQUEST_PENDING') || reasons.includes('NO_REQUEST')))) {
    strips.push({ key: 'yes', kind: 'yes', task: own, asked: !!own || !!request, who: own?.approver.name ?? request?.approver ?? null, since: own?.requestedAt ?? request?.requestedAt ?? null })
  }
  // The credit hold: its override's yes when one is asked (it may also hold a release while the order is in work).
  const credit = tasks.find((task) => task.kind === 'CREDIT_OVERRIDE') ?? null
  if (credit || (waits && (reasons.includes('CREDIT_HOLD') || !!approval?.creditHold))) {
    strips.push({ key: 'credit', kind: 'credit', task: credit, asked: !!credit, who: credit?.approver.name ?? null, since: credit?.requestedAt ?? null })
  }
  if (waits && reasons.includes('MEASUREMENTS')) strips.push({ key: 'review', kind: 'review', count: order.madeToMeasure?.waitingReview ?? null, since: null })

  // The deposit: the list's row (an open request, or none asked) — or, without the production read, the order read's gate while confirmed.
  const depositRow = rows.find((row) => row.kind === 'DEPOSIT') ?? null
  const gate = depositGate(order)
  if (depositRow) {
    const requestId = depositRow.ref?.type === 'DepositRequest' ? depositRow.ref.id : null
    const due = requestId ? (order.chain.depositRequests.find((entry) => entry.id === requestId)?.dueDate ?? null) : null
    strips.push({ key: 'deposit', kind: 'deposit', state: requestId ? 'WAITING' : 'MISSING', requestId, due, since: depositRow.since })
  } else if (waiting.status !== 'ready' && order.status === 'CONFIRMED' && (gate.state === 'WAITING' || gate.state === 'MISSING')) {
    strips.push({ key: 'deposit', kind: 'deposit', state: gate.state, requestId: gate.request?.id ?? null, due: gate.request?.dueDate ?? null, since: gate.request?.createdAt ?? null })
  }

  // ONE strip per hold kind, "on N work orders" (a work order held twice counts once; one not reached is counted, never named).
  const work = read?.work?.workOrders ?? []
  const leftOut = read?.work ? read.work.workOrdersLeftOut : null
  const groups = new Map<string, { kind: 'quality' | 'production' | 'pause' | 'other'; blocker: string; rows: WaitingRow[] }>()
  for (const row of rows) {
    if (row.kind === 'YES' || row.kind === 'DEPOSIT') continue
    const kind = HOLD_STRIPS[row.kind] ?? 'other'
    const key = kind === 'other' ? `other:${row.kind}` : kind
    const group = groups.get(key) ?? { kind, blocker: row.kind, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  const holdStrips = [...groups.entries()].map(([key, group]): WhereStrip => {
    const ids = [...new Set(group.rows.flatMap((row) => (row.ref?.type === 'WorkOrder' ? [row.ref.id] : [])))]
    const reached = ids
      .map((id): StripWorkOrder => {
        const known = work.find((entry) => entry.id === id)
        return { id, number: known?.number ?? order.chain.workOrders.find((entry) => entry.id === id)?.number ?? null, shared: known?.sharedWithOtherCustomers ?? false }
      })
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }))
    // A row with no work order named is one this reader does not reach — never more than the read says are left out.
    const hidden = group.rows.filter((row) => !row.ref).length
    const notReached = leftOut === null ? hidden : Math.min(hidden, leftOut)
    const said = group.kind === 'other' ? group.rows.flatMap((row) => (row.words.kind === 'api' ? [row.words.words] : [])) : (read?.headline?.holds ?? []).filter((hold) => hold.kind === REASON_KIND[group.kind as keyof typeof REASON_KIND]).map((hold) => hold.words)
    const words = said.filter((entry, index) => said.findIndex((other) => other.en === entry.en) === index)
    const since = earliestOf(group.rows.map((row) => row.since)) ?? (group.kind === 'other' ? null : earliestOf((read?.headline?.holds ?? []).filter((hold) => hold.kind === REASON_KIND[group.kind as keyof typeof REASON_KIND]).map((hold) => hold.since)))
    return { key, kind: group.kind, blocker: group.blocker, reasons: group.kind === 'pause' ? [] : words, workOrders: { reached, notReached }, since }
  })
  // Most blocking first: quality, production, the customer's pause; other kinds after them, the oldest first (no known start last).
  holdStrips.sort((a, b) => ORDER_OF.indexOf(a.kind) - ORDER_OF.indexOf(b.kind) || byStart(a.since, b.since))
  return { strips: [...strips, ...holdStrips], holds }
}
// ---- end F-OO-104

// ---- F-OO-105 (order overview §1.3; review F1, F8, F13): each strip's real doors — at most 3 visible buttons per strip ----
/**
 * What a strip lets this reader do, each door the real one, held with words when the reader may not (never hidden without why):
 *
 *   the order's yes    the band's own door (YesDoorView): Confirm the order + Refuse… for an approver who did not ask; held for the
 *                      asker, with Take the request back; anyone else reads who decides (in the strip's words) and the Take back
 *                      held with why — nobody asked yet: Ask for a yes (the depth's dialogs and holds, as the banner)
 *   the credit hold    its override's yes the same way (Approve: Credit override + Refuse…); F-OO-106: then, on the order's own
 *                      hold (its credit read), Check credit again and Ask for a yes… (only when one may be asked)
 *   the review         Open the review › — the unit's factory review (the review banner's own door; several units: each opens from
 *                      the banner), held without the right to see measurements
 *   the deposit        Record the payment (the money dialog on its request), held without payments.record beside Money ›; none
 *                      asked: Money › (where the deposit is asked)
 *   quality            Release on Quality › — Quality's holds of the work order (a release needs a signature and a fresh code)
 *   production, pause  Lift… on ONE work order (the shared HoldDialog of its row, held with who does it); several: Production ›
 *                      holds (one Lift for N is F-OO-109); only a shared one: its own page, where it is lifted
 *
 * Read-only on the page: words only, no door at all.
 */
export type StripDoor =
  | { readonly kind: 'yes'; readonly door: YesDoor }
  /** The depth's Ask for a yes / Take the request back (its own dialogs), held in the depth's words. */
  | { readonly kind: 'ask' | 'withdraw'; readonly held: Phrase | null }
  | { readonly kind: 'payment'; readonly requestId: string; readonly held: Phrase | null }
  /** A tab of this page at its section: Money (the deposit to ask), Production › holds (each work order's own Lift). */
  | { readonly kind: 'tab'; readonly tab: 'money' | 'production'; readonly anchor: string | null }
  | { readonly kind: 'lift'; readonly row: WorkOrderOwn; readonly label: 'wo.act.lift' | 'wo.liftPause'; readonly held: Phrase | null }
  /** A shared work order's own page (it makes other customers' work: lifted there). */
  | { readonly kind: 'workOrder'; readonly href: string; readonly number: string }
  | { readonly kind: 'quality'; readonly href: string; readonly number: string }
  | { readonly kind: 'review'; readonly href: string | null; readonly held: Phrase | null }
  // ---- F-OO-106: the order's own credit hold — Check credit again (held without the credit right), Ask for a yes… (only when one may
  // be asked: its check id is the lock), Try again when its read failed ----
  | { readonly kind: 'creditCheck'; readonly held: Phrase | null }
  | { readonly kind: 'creditAsk'; readonly checkId: string; readonly held: Phrase | null }
  | { readonly kind: 'creditRetry' }

export interface StripDoorsInput {
  readonly prefix: string
  readonly order: Pick<Order, 'lines'>
  readonly can: Pick<OrderAbilities, 'recordPayment' | 'measurements'>
  /** Read-only on the page (the band's rule, readOnlyOnPage): words only. */
  readonly readOnly: boolean
  /** A write of the page runs: every door held with its words. */
  readonly busy: boolean
  /** The yes's own read (its request, Ask / Take back) and the depth's rights; null: not read here. */
  readonly approval: Pick<Approval, 'requests' | 'may' | 'waiting'> | null
  readonly depthCan: Pick<DepthCan, 'manage'> | null
  /** The production read's work orders (each one's version and the reader's rights) and the page's acts rights; null: none here. */
  readonly work: readonly WorkOrderOwn[]
  readonly acts: ActsCan | null
  /** F-OO-106: the order's credit as this page reads it (absent / null: not read here). */
  readonly credit?: CreditState | null
}

/** A work order's own page. */
export const workOrderHref = (prefix: string, workOrderId: string): string => `${prefix}/production/work-orders/${encodeURIComponent(workOrderId)}`

export function stripDoorsOf(strip: WhereStrip, input: StripDoorsInput): StripDoor[] {
  if (input.readOnly) return []
  const busy = input.busy ? phrase('held.busy') : null
  switch (strip.kind) {
    case 'yes': {
      // The banner's own doors (DepthBand's Waiting): the approver decides here; who decides is the strip's words for anyone else.
      const door = strip.task ? yesDoorOf(strip.task, input.busy) : null
      const doors: StripDoor[] = door && door.kind !== 'whoDecides' ? [{ kind: 'yes', door }] : []
      const approval = input.approval
      if ((door && door.kind === 'decide') || !approval) return doors
      const depthCan = input.depthCan ?? { manage: false }
      const withdraw: StripDoor = { kind: 'withdraw', held: withdrawHeld(approval, depthCan) ?? busy }
      const ask: StripDoor = { kind: 'ask', held: askHeld(approval, depthCan) ?? busy }
      return [...doors, openRequest(approval) || strip.asked ? withdraw : ask]
    }
    case 'credit': {
      const door = strip.task ? yesDoorOf(strip.task, input.busy) : null
      // F-OO-106: then the order's own hold's doors (its read: Check credit again, Ask for a yes… only when one may be asked).
      return [...(door && door.kind !== 'whoDecides' ? [{ kind: 'yes' as const, door }] : []), ...creditDoorsOf(input.credit ?? null, busy)]
    }
    case 'review': {
      const units = input.order.lines.filter((line) => line.kind === 'MADE_TO_MEASURE')
      if (units.length !== 1) return []
      const rider = units[0]!.rider ?? null
      if (!input.can.measurements || !rider) return [{ kind: 'review', href: null, held: phrase('where.strip.reviewDoor.noRight') }]
      return [{ kind: 'review', href: profileHref(input.prefix, rider.profileId, 'measurements', 'review'), held: null }]
    }
    case 'deposit': {
      const money: StripDoor = { kind: 'tab', tab: 'money', anchor: null }
      if (strip.state === 'MISSING' || !strip.requestId) return [money]
      if (!input.can.recordPayment) return [{ kind: 'payment', requestId: strip.requestId, held: phrase('held.noPayments') }, money]
      return [{ kind: 'payment', requestId: strip.requestId, held: busy }]
    }
    case 'quality': {
      const first = strip.workOrders.reached[0]
      return first ? [{ kind: 'quality', href: `${input.prefix}/quality/holds${holdsAddress({ view: 'open', subjectType: 'WorkOrder', subjectId: first.id })}`, number: first.number ?? '—' }] : []
    }
    case 'production':
    case 'pause': {
      const own = strip.workOrders.reached.filter((entry) => !entry.shared)
      const shared = strip.workOrders.reached.filter((entry) => entry.shared)
      if (own.length === 1 && shared.length === 0 && strip.workOrders.notReached === 0) {
        const row = input.work.find((entry) => entry.id === own[0]!.id) ?? null
        const lift = row && input.acts ? (rowActsOf(row, input.acts).menu.find((entry) => entry.act === 'lift') ?? null) : null
        if (row && lift) return [{ kind: 'lift', row, label: strip.kind === 'pause' ? 'wo.liftPause' : 'wo.act.lift', held: lift.held ?? busy }]
      }
      if (own.length > 0) return [{ kind: 'tab', tab: 'production', anchor: 'holds' }]
      const first = shared[0]
      return first ? [{ kind: 'workOrder', href: workOrderHref(input.prefix, first.id), number: first.number ?? '—' }] : []
    }
    case 'other':
      return strip.workOrders.reached.length > 0 ? [{ kind: 'tab', tab: 'production', anchor: 'holds' }] : []
  }
}
// ---- end F-OO-105

// ---- F-OO-107 (order overview §1.5; review F8): the moves row — the order's own moves only ----
/**
 * Under the stages, the order's OWN moves, each where the band offers it and held by the band's own rule (never a second one):
 *
 *   Mark ready…                              an order in production (readyHeld)                       a button
 *   Record a shipment made elsewhere…        while it may still ship (ELSEWHERE_FROM; the door's held)  More ▾
 *   Cancel order…                            the states a cancel is a move of (the domain's CANCEL_STATUSES, a waiting order
 *                                            too — B-OO-003; cancelHeld)                                More ▾
 *   Close order…                             shipped or delivered (closeHeld)                           More ▾
 *
 * The SAME dialogs as the band (Ready, Cancel, Close: the page's one dialog slot; made elsewhere: its own container). Hold the whole
 * order… joins the buttons with F-OO-108; Make work orders… and Create shipment… make the next record: Linked records and the band
 * (F8), never here; the yes is its strip's. A move the reader may not run shows held with words (the band hides Cancel without
 * orders.manage: here it is held with why). Read-only: no row at all; a closed or cancelled order: none either (nothing applies).
 */
export const WHERE_MOVES = ['ready', 'elsewhere', 'cancel', 'close'] as const
export type WhereMoveId = (typeof WHERE_MOVES)[number]

export interface WhereMove {
  readonly id: WhereMoveId
  readonly label: Phrase
  /** The band's own rule's words (null: it runs). */
  readonly held: Phrase | null
}

/** The buttons in view (at most 2 with Hold the whole order…, F-OO-108) and the rest under More ▾: at most 3 visible in all. */
export interface WhereMoves {
  readonly shown: readonly WhereMove[]
  readonly more: readonly WhereMove[]
}

export function whereMovesOf(order: Order, input: { readonly can: OrderAbilities; readonly readOnly: boolean; /** The made-elsewhere door (its container's, held with its words); absent: not offered here. */ readonly elsewhere: { readonly held: Phrase | null } | null | undefined }): WhereMoves | null {
  if (input.readOnly) return null
  const shown: WhereMove[] = []
  const more: WhereMove[] = []
  if (order.status === 'IN_PRODUCTION') shown.push({ id: 'ready', label: phrase('action.ready'), held: readyHeld(order, input.can) })
  // F-OO-108 (W11): "Hold the whole order…" joins `shown` here.
  if (input.elsewhere && ELSEWHERE_FROM.includes(order.status)) more.push({ id: 'elsewhere', label: phrase('elsewhere.title'), held: input.elsewhere.held })
  if (CANCEL_STATUSES.includes(order.status)) more.push({ id: 'cancel', label: phrase('action.cancel'), held: cancelHeld(order, input.can) })
  if (isShippedInFull(order)) more.push({ id: 'close', label: phrase('step.close'), held: closeHeld(order, input.can) })
  return shown.length + more.length > 0 ? { shown, more } : null
}
// ---- end F-OO-107

// ---- F-OO-106 (order overview §1.3, §1.4; review F8, F16; B-OO-004): the order's own credit hold, decided from its strip ----------
/**
 * The order's credit as the page reads it: only with sales.credit.view (`view`), and only while the order waits on its own credit
 * hold (`creditHoldWaits`). A reader without the right reads who decides, in words; nobody reads an amount here (findings only).
 */
export interface CreditState {
  /** sales.credit.view: the reader reads the order's credit (else who decides is said in words). */
  readonly view: boolean
  /** The order's credit (its one customer) while it waits on a credit hold; null: not read (no right, or nothing held). */
  readonly record: { readonly value: CreditCustomer | null; readonly problem: string | null } | null
}

/** The order waits on its own credit hold (its waiting reasons, else a credit yes asked on it): its credit is read then. */
export function creditHoldWaits(order: Pick<Order, 'status' | 'openApprovals'> & { readonly waits?: readonly string[] | null }, approval?: Pick<Approval, 'creditHold'> | null): boolean {
  if (order.status !== 'PENDING_APPROVAL') return false
  return !!approval?.creditHold || !!order.waits?.includes('CREDIT_HOLD') || (order.openApprovals ?? []).some((task) => task.kind === 'CREDIT_OVERRIDE')
}

/**
 * The hold's own doors after its yes (F8: at most 3 buttons — the approver's two and Check credit again; "Ask for a yes…" only when
 * one may be asked, so never beside a yes that is open): Check credit again, held with words without the credit right; Ask for a yes…
 * on the hold's check (its id: the lock). Not read (no right, still reading, nothing held): none; the read failed: Try again.
 */
export function creditDoorsOf(credit: CreditState | null, busy: Phrase | null): StripDoor[] {
  const record = credit?.view ? credit.record : null
  if (!record) return []
  if (!record.value) return record.problem ? [{ kind: 'creditRetry' }] : []
  const { held, may } = record.value
  if (!held) return []
  const check: StripDoor = { kind: 'creditCheck', held: may.checkAgain ? busy : phrase('where.credit.held.noRight') }
  return may.ask ? [check, { kind: 'creditAsk', checkId: held.checkId, held: busy }] : [check]
}

/** A quiet line of the credit strip: a phrase of the orders catalogue, the day it names, the findings it lists. */
export interface CreditLine {
  readonly phrase: Phrase
  /** An instant the line names as `{date}` (the view says it in the page's way). */
  readonly date?: string
  /** What the check found, named as `{findings}` in the Finance page's own words (`sales-credit` finding.*). */
  readonly findings?: readonly CreditCustomer['findings'][number][]
}

/**
 * The credit strip's quiet lines, never an amount: what the check found (the Finance page's own words), the last answer to a yes
 * asked on it ("Finance said no on 18/11/2026: …" — the words only with the price grain, as the API sends them; a request taken
 * back), and for a reader without the credit right who checks it. The read failed: said, with Try again among the doors.
 */
export function creditLinesOf(credit: CreditState | null, waits: boolean): CreditLine[] {
  if (!waits || !credit) return []
  if (!credit.view) return [{ phrase: phrase('where.credit.whoDecides') }]
  const value = credit.record?.value ?? null
  if (!value) return credit.record?.problem ? [{ phrase: phrase('where.credit.failed') }] : []
  const lines: CreditLine[] = []
  const found = [...new Set([...value.findings, ...(value.onHold && !value.findings.includes('ON_HOLD') ? (['ON_HOLD'] as const) : [])])]
  if (found.length > 0) lines.push({ phrase: phrase('where.credit.found'), findings: found })
  const answer = value.held?.lastAnswer ?? null
  if (answer?.status === 'REJECTED') {
    const reason = answer.reason?.trim() || null
    if (answer.by) lines.push({ phrase: phrase(reason ? 'where.credit.saidNoWhy' : 'where.credit.saidNo', { who: answer.by, ...(reason ? { reason } : {}) }), date: answer.at })
    else lines.push({ phrase: phrase(reason ? 'where.credit.saidNoSomeoneWhy' : 'where.credit.saidNoSomeone', reason ? { reason } : undefined), date: answer.at })
  } else if (answer?.status === 'WITHDRAWN') {
    lines.push({ phrase: answer.by ? phrase('where.credit.takenBack', { who: answer.by }) : phrase('where.credit.takenBackSystem'), date: answer.at })
  }
  return lines
}

/** Who a yes on the hold is asked of now (its open request's approver), as the credit read names it. */
export const creditAskedOf = (value: CreditCustomer | null): string | null => value?.held?.request?.approver ?? null

/** A notice of the page after a credit act: its tone and words. */
export interface CreditNotice {
  readonly tone: 'success' | 'info' | 'warning'
  readonly words: Phrase
}

/**
 * "Check credit again" answered: passed — the order is confirmed (or it still waits for its other yes or review); still held — a yes
 * was asked (of whom the read names now), or nobody may say yes (the customer pays, or Finance raises the limit).
 */
export function creditCheckNoticeOf(answer: CreditCheckAnswer, who: string | null): CreditNotice {
  if (answer.result !== 'HOLD') return answer.orderGoesOn ? { tone: 'success', words: phrase('where.credit.passed') } : { tone: 'success', words: phrase('where.credit.passedWaits') }
  if (answer.asked) return { tone: 'info', words: who ? phrase('where.credit.stillAsked', { who }) : phrase('where.credit.stillAskedSomeone') }
  return { tone: 'warning', words: phrase('where.credit.stillNobody') }
}

/** "Ask for a yes…" answered: a yes was asked (of whom the read names now). */
export const creditAskNoticeOf = (who: string | null): CreditNotice => ({ tone: 'success', words: who ? phrase('where.credit.asked', { who }) : phrase('where.credit.askedSomeone') })

/** The API's issue words a refusal of the credit routes carries (apps/factory-api sales/credit/override.ts), each with its meaning. */
const CREDIT_REFUSALS: Readonly<Record<string, string>> = Object.freeze({ 'Nobody to ask.': 'where.credit.refused.nobody', 'No rule.': 'where.credit.refused.noRule', 'Asked already.': 'where.credit.refused.asked', 'Checked meanwhile.': 'where.credit.refused.meanwhile' })

/**
 * A refused credit act in this page's words, said in its dialog: nobody to ask (no credit rule names someone else who may say yes),
 * no rule any more, a yes asked already, or checked meanwhile — the check id is the lock: a newer check, or the hold gone, is
 * "checked meanwhile" (the credit is read again). Without the right: the held words. Anything else: the page's write words.
 */
export function creditRefusalOf(error: unknown): Phrase {
  if (isApiError(error)) {
    if (error.kind === 'conflict') {
      const key = error.issues.map((issue) => CREDIT_REFUSALS[issue.message ?? ''] ?? null).find((entry) => entry !== null)
      return phrase(key ?? 'where.credit.refused.meanwhile')
    }
    if (error.kind === 'forbidden') return phrase('where.credit.held.noRight')
  }
  return { key: writeProblem(error).key }
}

/**
 * Beside a yes this reader decides here (Refuse… in view), what a no does — the Refuse… dialog is the band's (DepthBand, imported
 * as it is), so the strip says it: a no on the credit leaves it held and cancels nothing (the hold stays, B-OO-004: no machine change);
 * a no on the order's own yes cancels the order (the approval engine's rejectedInCommand).
 */
export function refuseLineOf(strip: WhereStrip, doors: readonly StripDoor[]): Phrase | null {
  if (strip.kind !== 'yes' && strip.kind !== 'credit') return null
  if (!doors.some((door) => door.kind === 'yes' && door.door.kind === 'decide')) return null
  return phrase(strip.kind === 'credit' ? 'where.refuse.credit' : 'where.refuse.order')
}

/** The ask's note (the API keeps at most 4000; the dialog asks a word, at most 1000). */
export const CREDIT_ASK_NOTE_MAX = 1000
// ---- end F-OO-106
