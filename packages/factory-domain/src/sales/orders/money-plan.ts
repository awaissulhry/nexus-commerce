import type { BusinessDate } from '../../core/time'
import { Dec, HUNDRED, parseDecimal, ZERO } from '../../tax/decimal'
import type { MilestoneKind, MilestoneStatus } from './schedule'

/**
 * An order's money plan (order money tab, B-OM-004; 13-backend §1, §3): its payment steps and the deposit requests behind them,
 * read as ONE plan, pure.
 *
 *   coverage      an ON_DELIVERY / ON_INVOICE step has no request: it falls due with the goods' invoice. The money paid on
 *                 the order's goods invoices (less refunds, plus the small differences written off on them) is given out to
 *                 those OPEN steps in seq order; a step covered in full reads "Paid with the invoices" (`settledBy`
 *                 INVOICES). Derived, never written: the database's step stays OPEN.
 *   overdue       the OPEN steps whose due day passed (the business day, Europe/Rome), less what is paid on them so far
 *                 (their request's payments) and what the invoices cover.
 *   by hand       every hand change of the plan writes ONE audit row `orders.planByHand` on the SalesOrder (PR S2) whose
 *                 `after` names the act, the steps and the requests it touched, and each request it replaced: the read
 *                 tags those steps and requests "Set by hand" from the newest row naming them (no column).
 *   undo          whether a payment on a deposit request may be undone here (reversed, and voided when it then pays
 *                 nothing): held in words (EN/IT) by the request's or the payment's state; no door without the rights.
 */

export interface Words {
  readonly en: string
  readonly it: string
}

// ---- by hand ---------------------------------------------------------------------------------------------------------------

/** The audit action of every hand change of an order's money plan (written by PR S2's POST …/money-plan). */
export const PLAN_BY_HAND_ACTION = 'orders.planByHand'

/** The hand acts on an order's money plan (PR S2; 13-backend §3). */
export const MONEY_PLAN_ACTS = ['REPLACE_DEPOSIT', 'MOVE_DUE', 'ASK_AGAIN', 'ADD_STEP', 'CHANGE_STEP', 'REMOVE_STEP', 'RENAME_STEP', 'UNDO_OPEN', 'CHANGE_TERMS', 'ACCEPT_SHORT'] as const
export type MoneyPlanAct = (typeof MONEY_PLAN_ACTS)[number]

/** What a planByHand audit row names (its `after`): the act, the steps and requests it touched, each request it replaced. */
export interface PlanByHandMark {
  readonly act: MoneyPlanAct
  readonly milestoneIds: readonly string[]
  readonly depositRequestIds: readonly string[]
  /** A request made in place of another (REPLACE_DEPOSIT, ASK_AGAIN, a changed advance): `from` → `to`. */
  readonly replacements: readonly { readonly from: string; readonly to: string }[]
  /** ACCEPT_SHORT: why the short part was accepted. */
  readonly why: string | null
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/** A planByHand audit row's `after` read back; null when it is not one (an unknown act, not an object). */
export function planByHandMarkOf(after: unknown): PlanByHandMark | null {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return null
  const row = after as Record<string, unknown>
  const act = row.act
  if (typeof act !== 'string' || !(MONEY_PLAN_ACTS as readonly string[]).includes(act)) return null
  const replacements = Array.isArray(row.replacements)
    ? row.replacements.flatMap((entry) => {
        const pair = entry as Record<string, unknown> | null
        return pair && typeof pair.from === 'string' && typeof pair.to === 'string' ? [{ from: pair.from, to: pair.to }] : []
      })
    : []
  return { act: act as MoneyPlanAct, milestoneIds: strings(row.milestoneIds), depositRequestIds: strings(row.depositRequestIds), replacements, why: typeof row.why === 'string' ? row.why : null }
}

// ---- coverage and overdue --------------------------------------------------------------------------------------------------

/** The steps that fall due with the goods' invoice (no request of their own). */
export const INVOICE_STEP_KINDS = ['ON_DELIVERY', 'ON_INVOICE'] as const satisfies readonly MilestoneKind[]
export const isInvoiceStep = (kind: MilestoneKind): boolean => (INVOICE_STEP_KINDS as readonly MilestoneKind[]).includes(kind)

export interface PlanStep {
  readonly id: string
  readonly seq: number
  readonly kind: MilestoneKind
  readonly status: MilestoneStatus
  readonly amount: number
  readonly dueDate: BusinessDate | null
  /** What payments placed on its request so far (null: it has no request). */
  readonly paidSoFar: number | null
}

/**
 * What the goods' invoices cover of each OPEN ON_DELIVERY / ON_INVOICE step: `goodsMoney` (paid on the order's goods invoices,
 * less refunds, plus what is written off on them) given out in seq order, each step at most its amount. Others: absent (0).
 */
export function coverageOf(steps: readonly PlanStep[], goodsMoney: number): Map<string, number> {
  const out = new Map<string, number>()
  let left = Math.max(0, goodsMoney)
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (step.status !== 'OPEN' || !isInvoiceStep(step.kind)) continue
    const covered = Math.min(Math.max(0, step.amount), left)
    out.set(step.id, covered)
    left -= covered
  }
  return out
}

export type SettledBy = 'PAYMENT' | 'INVOICES'

/** How a step is settled: PAID (its request paid), the goods' invoices cover an ON_* step in full, or not yet (null). */
export function settledByOf(step: Pick<PlanStep, 'kind' | 'status' | 'amount'>, covered: number): SettledBy | null {
  if (step.status === 'PAID') return 'PAYMENT'
  if (step.status === 'OPEN' && isInvoiceStep(step.kind) && step.amount > 0 && covered >= step.amount) return 'INVOICES'
  return null
}

/** What of the OPEN steps is past due on `today`: each step's amount less what is paid on it so far and what invoices cover. */
export function overdueOf(steps: readonly PlanStep[], coverage: ReadonlyMap<string, number>, today: BusinessDate): number {
  return steps.reduce((sum, step) => {
    if (step.status !== 'OPEN' || step.dueDate === null || step.dueDate >= today) return sum
    return sum + Math.max(0, step.amount - (step.paidSoFar ?? 0) - (coverage.get(step.id) ?? 0))
  }, 0)
}

// ---- undo a payment --------------------------------------------------------------------------------------------------------

/** Why a payment on a deposit request is not undone here (PR S2's POST /payments/:paymentId/undo refuses the same). */
export const UNDO_HELD = ['CARRIED', 'PAID', 'DEPOSIT_INVOICE_ISSUED', 'DEPOSIT_INVOICE_DRAFT', 'WRITE_OFF', 'HARD_LOCKED'] as const
export type UndoHeld = (typeof UNDO_HELD)[number]

export const UNDO_HELD_WORDS: Readonly<Record<UndoHeld, Words>> = Object.freeze({
  CARRIED: {
    en: "This deposit issues no deposit invoice and is paid: its money is carried onto the order's invoice, not undone.",
    it: "Questo acconto non emette fattura d'acconto ed è pagato: il suo importo passa sulla fattura dell'ordine, non si annulla.",
  },
  PAID: {
    en: 'This deposit is paid in full: its payments stay (a refund is a credit note and a refund, in Finance).',
    it: 'Questo acconto è pagato per intero: i suoi pagamenti restano (un rimborso è una nota di credito e un rimborso, in Finanza).',
  },
  DEPOSIT_INVOICE_ISSUED: {
    en: 'A deposit invoice was issued for this deposit: a credit note first, in Finance.',
    it: "Per questo acconto è stata emessa una fattura d'acconto: prima una nota di credito, in Finanza.",
  },
  DEPOSIT_INVOICE_DRAFT: {
    en: 'A deposit invoice draft is made for this deposit: delete the draft in Finance first.',
    it: "C'è una bozza di fattura d'acconto per questo acconto: prima elimina la bozza in Finanza.",
  },
  WRITE_OFF: {
    en: 'A small difference is written off on this payment: take the write-off back in Finance first.',
    it: 'Su questo pagamento è abbuonata una piccola differenza: prima annulla l’abbuono in Finanza.',
  },
  HARD_LOCKED: {
    en: "This payment's month is closed for good: it is not undone.",
    it: 'Il mese di questo pagamento è chiuso definitivamente: non si annulla.',
  },
})

export interface UndoFacts {
  /** The reader holds payments.record AND payments.void over the order (else no door at all). */
  readonly mayAct: boolean
  readonly request: { readonly status: string; readonly fiscalDocument: 'TD02' | 'NONE' }
  /** A TD02 of the request issued (not a draft, not rejected) and not credited in full. */
  readonly depositInvoiceIssued: boolean
  /** A TD02 draft of the request. */
  readonly depositInvoiceDraft: boolean
  /** A write-off still standing on the payment. */
  readonly writeOffStanding: boolean
  /** The payment's day is inside a HARD period lock. */
  readonly hardLocked: boolean
}

export interface UndoVerdict {
  readonly may: boolean
  /** Why not, in words; null when it may, or when the reader has no right (the screen hides the door). */
  readonly why: Words | null
  readonly code: UndoHeld | null
}

/** Whether a payment on a deposit request may be undone here, and why not (the first reason, in this order). */
export function undoVerdictOf(facts: UndoFacts): UndoVerdict {
  if (!facts.mayAct) return { may: false, why: null, code: null }
  const held = (code: UndoHeld): UndoVerdict => ({ may: false, why: UNDO_HELD_WORDS[code], code })
  if (facts.request.status === 'PAID' && facts.request.fiscalDocument === 'NONE') return held('CARRIED')
  if (facts.request.status === 'PAID') return held('PAID')
  if (facts.depositInvoiceIssued) return held('DEPOSIT_INVOICE_ISSUED')
  if (facts.depositInvoiceDraft) return held('DEPOSIT_INVOICE_DRAFT')
  if (facts.writeOffStanding) return held('WRITE_OFF')
  if (facts.hardLocked) return held('HARD_LOCKED')
  return { may: true, why: null, code: null }
}

// ── B-OM-024 (order money tab W-01, W-02): a request short, and whether that is within the company's write-off tolerance — ONE
// rule, read by the plan read (`requests[].short`) and by ACCEPT_SHORT (the planner below and the API's fresh-code check) ──
/** What is missing on an OPEN request with money on it and less than its amount (minor units); null: nothing is short. */
export function shortOf(request: { readonly status: string; readonly amount: number; readonly paid: number }): number | null {
  if (request.status !== 'OPEN' || request.paid <= 0 || request.paid >= request.amount) return null
  return request.amount - request.paid
}

/** Why a short part goes beyond the company's write-off tolerance (it sets none, or the part is more), or null: within it. */
export function beyondToleranceOf(short: number, tolerance: number | null): 'NO_TOLERANCE' | 'OVER_TOLERANCE' | null {
  if (tolerance === null) return 'NO_TOLERANCE'
  return short > tolerance ? 'OVER_TOLERANCE' : null
}
// ── end B-OM-024 ──

// ════ the hand planner (PR S2; B-OM-011 … 016; 13-backend §3) ════════════════════════════════════════════════════════════════
/**
 * ONE pure planner for every hand act on an order's money plan: what the act writes (steps changed or added, requests cancelled,
 * made, moved or paid, the deposit flag), or why not in words (EN/IT). The API reads the facts under the requests' money locks and
 * the order's row, checks the version it was sent, then writes exactly this; its preview answers it without writing. A request's
 * amount never changes (the database's rule): a new amount is a new request in its place (`replacements`). A cancelled step's or
 * request's note is plain words, never the reason (Sales reads them); the reason lives in the audit (price grain).
 */

export const MONEY_PLAN_REFUSALS = [
  'ORDER_FINAL',
  'GOODS_LEFT',
  'MONEY_PLACED',
  'NOT_OPEN',
  'NOT_ADVANCE',
  'NOT_DEPOSIT',
  'NOT_WAIVED',
  'NOT_OPENED',
  'TOTAL_CHANGES',
  'BELOW_ZERO',
  'OVER_TOTAL',
  'REST_TO',
  'NO_DAY',
  'PAST_DAY',
  'SECOND_DEPOSIT',
  'LAST_STEP',
  'NOTHING_CHANGES',
  'NOTHING_SHORT',
  'OVER_TOLERANCE',
  'NO_TOLERANCE',
  'TERMS_ARCHIVED',
  'TERMS_SAME',
] as const
export type MoneyPlanRefusal = (typeof MONEY_PLAN_REFUSALS)[number]

/** Each refusal in words: the office reads them (409 `moneyPlan/<CODE>`); Italian "tu". */
export const MONEY_PLAN_REFUSAL_WORDS: Readonly<Record<MoneyPlanRefusal, Words>> = Object.freeze({
  ORDER_FINAL: { en: 'The order is closed or cancelled: its money plan does not change any more.', it: "L'ordine è chiuso o annullato: il suo piano dei pagamenti non cambia più." },
  GOODS_LEFT: { en: "Goods of the order have left: what is still due is paid on the goods' invoice, not as an advance.", it: 'La merce dell’ordine è partita: quanto resta dovuto si paga sulla fattura della merce, non come anticipo.' },
  MONEY_PLACED: { en: 'Money is already placed on this request: its amount stays (undo the payment first, or change another step).', it: 'Su questa richiesta ci sono già dei pagamenti: il suo importo resta (prima annulla il pagamento, o cambia un’altra rata).' },
  NOT_OPEN: { en: 'This step or request is not open any more: there is nothing to change on it.', it: 'Questa rata o richiesta non è più aperta: non c’è nulla da cambiare.' },
  NOT_ADVANCE: { en: "This step falls due with the goods' invoice: it has no day and no request of its own.", it: 'Questa rata scade con la fattura della merce: non ha una scadenza né una richiesta propria.' },
  NOT_DEPOSIT: { en: "This request is a step's before shipping, not the order's deposit: change the step's amount instead.", it: "Questa richiesta è di una rata prima della spedizione, non l'acconto dell'ordine: cambia invece l'importo della rata." },
  NOT_WAIVED: { en: 'Only a deposit or a step that was waived is asked for again.', it: 'Si richiede di nuovo solo un acconto o una rata abbuonati.' },
  NOT_OPENED: { en: 'This step is not open for payment: there is no opening to undo.', it: 'Questa rata non è aperta al pagamento: non c’è un’apertura da annullare.' },
  TOTAL_CHANGES: { en: "The steps must add up to the order's total: say which step takes the difference.", it: "Le rate devono dare il totale dell'ordine: indica quale rata prende la differenza." },
  BELOW_ZERO: { en: 'A step is more than nothing: the amount leaves a step at 0 or below.', it: "Una rata vale più di zero: l'importo lascia una rata a 0 o meno." },
  OVER_TOTAL: { en: "The deposit is more than the order's total.", it: "L'acconto supera il totale dell'ordine." },
  REST_TO: { en: 'The step that takes the difference must be another open step with nothing paid on it.', it: 'La rata che prende la differenza deve essere un’altra rata aperta senza pagamenti.' },
  NO_DAY: { en: 'A deposit needs the day it falls due.', it: "Un acconto ha bisogno della sua scadenza." },
  PAST_DAY: { en: 'Give a day from today on.', it: 'Indica un giorno da oggi in poi.' },
  SECOND_DEPOSIT: { en: 'The order has its deposit already: change it instead of adding a second one.', it: "L'ordine ha già il suo acconto: cambialo invece di aggiungerne un secondo." },
  LAST_STEP: { en: 'This is the last open step: change it, or change the payment terms.', it: "È l'ultima rata aperta: cambiala, oppure cambia i termini di pagamento." },
  NOTHING_CHANGES: { en: 'Nothing changes: it is like this already.', it: 'Non cambia nulla: è già così.' },
  NOTHING_SHORT: { en: 'Nothing is short: accept a deposit short only when part of it is paid.', it: "Non manca nulla: si accetta un acconto con meno solo quando una parte è pagata." },
  OVER_TOLERANCE: { en: "The short part is over the company's write-off tolerance: only the Owner accepts it, with a fresh code.", it: "La parte mancante supera la tolleranza di abbuono dell'azienda: la accetta solo il titolare, con un codice nuovo." },
  NO_TOLERANCE: { en: 'The company has no write-off tolerance: only the Owner accepts a short deposit, with a fresh code.', it: "L'azienda non ha una tolleranza di abbuono: un acconto con meno lo accetta solo il titolare, con un codice nuovo." },
  TERMS_ARCHIVED: { en: 'These payment terms are archived: choose terms in use.', it: 'Questi termini di pagamento sono archiviati: scegli termini in uso.' },
  TERMS_SAME: { en: 'The order has these payment terms already.', it: "L'ordine ha già questi termini di pagamento." },
})

/** Why the short part of a deposit was accepted (ACCEPT_SHORT). */
export const ACCEPT_SHORT_WHYS = ['ROUNDING', 'BANK_CHARGES', 'OTHER'] as const
export type AcceptShortWhy = (typeof ACCEPT_SHORT_WHYS)[number]

/** The plain words a cancelled step or request keeps (statusNote; never the reason). */
export const BY_HAND_NOTES = Object.freeze({
  REPLACED: 'Replaced by hand',
  REMOVED: 'Removed by hand',
  UNDONE: 'Opening undone by hand',
  CHANGED: 'Changed by hand: a new request in its place',
})

/** A step as the planner reads it (SalesOrderMilestone). */
export interface PlannerStep {
  readonly id: string
  readonly seq: number
  readonly kind: MilestoneKind
  readonly status: MilestoneStatus
  readonly amount: number
  readonly sharePct: string | null
  readonly dueDate: BusinessDate | null
  readonly label: string | null
  readonly depositRequestId: string | null
}

/** A deposit request of the order as the planner reads it, with what its payments placed on it. */
export interface PlannerRequest {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly amount: number
  readonly paid: number
  readonly dueDate: BusinessDate
}

export interface PlannerFacts {
  readonly order: { readonly status: string; readonly gross: number; readonly goodsLeft: boolean; readonly paymentTermsId: string | null }
  /** Every step of the order, cancelled ones too. */
  readonly steps: readonly PlannerStep[]
  readonly requests: readonly PlannerRequest[]
  /** The business day (Europe/Rome). */
  readonly today: BusinessDate
}

export type MoneyPlanAction =
  | { readonly act: 'REPLACE_DEPOSIT'; readonly requestId: string; readonly amount: number }
  | { readonly act: 'MOVE_DUE'; readonly milestoneId?: string | undefined; readonly requestId?: string | undefined; readonly dueDate: BusinessDate }
  | { readonly act: 'ASK_AGAIN'; readonly milestoneId?: string | undefined; readonly requestId?: string | undefined; readonly dueDate: BusinessDate }
  | { readonly act: 'ADD_STEP'; readonly kind: MilestoneKind; readonly amount: number; readonly dueDate: BusinessDate | null; readonly label: string | null; readonly from: string }
  | { readonly act: 'CHANGE_STEP'; readonly milestoneId: string; readonly amount: number; readonly restTo: string | null }
  | { readonly act: 'REMOVE_STEP'; readonly milestoneId: string; readonly restTo: string | null }
  | { readonly act: 'RENAME_STEP'; readonly milestoneId: string; readonly label: string | null }
  | { readonly act: 'UNDO_OPEN'; readonly milestoneId: string }
  | { readonly act: 'CHANGE_TERMS'; readonly paymentTermsId: string; readonly termsArchived: boolean }
  | { readonly act: 'ACCEPT_SHORT'; readonly requestId: string; readonly why: AcceptShortWhy; readonly tolerance: number | null; readonly override: boolean }

/** A request the act makes (its ref names it until it has an id). */
export interface PlannedRequest {
  readonly ref: string
  readonly kind: string
  readonly amount: number
  readonly dueDate: BusinessDate
  readonly sharePct: string | null
  readonly stepKind: 'DEPOSIT' | 'BEFORE_SHIPPING'
}

/** A step as the act leaves it (changed, or new: `id` null); `request` is a request's id or a new request's ref. */
export interface PlannedStep {
  readonly id: string | null
  readonly seq: number
  readonly kind: MilestoneKind
  readonly status: 'OPEN' | 'CANCELLED'
  readonly amount: number
  readonly sharePct: string | null
  readonly dueDate: BusinessDate | null
  readonly label: string | null
  readonly statusNote: string | null
  readonly request: string | null
}

export interface MoneyPlanResult {
  readonly act: MoneyPlanAct
  readonly steps: readonly PlannedStep[]
  readonly cancelRequests: readonly { readonly id: string; readonly note: string }[]
  readonly newRequests: readonly PlannedRequest[]
  readonly moveRequests: readonly { readonly id: string; readonly dueDate: BusinessDate }[]
  /** ACCEPT_SHORT: the request marked PAID with what is paid on it. */
  readonly payRequest: string | null
  /** A request made in place of another: `to` is the new request's ref. */
  readonly replacements: readonly { readonly from: string; readonly to: string }[]
  /** The order's "production waits for a deposit" set to this; null: unchanged. */
  readonly depositRequired: boolean | null
  /** The other OPEN steps are shared again over the order's terms (REPLACE_DEPOSIT, CHANGE_TERMS), hand steps kept. */
  readonly remake: boolean
  /** ACCEPT_SHORT: the short part, and whether it is over (or without) the tolerance, accepted by the Owner with a fresh code. */
  readonly short: number | null
  readonly overridden: boolean
}

export type MoneyPlanOutcome = { readonly ok: true; readonly plan: MoneyPlanResult } | { readonly ok: false; readonly refusal: MoneyPlanRefusal }

/** A step's share of the order's gross, 4 places (above 0, at most 100); null when it is not one. */
export function sharePctOf(amount: number, gross: number): string | null {
  if (gross <= 0 || amount <= 0) return null
  const value = new Dec(amount).times(HUNDRED).dividedBy(gross)
  return value.gt(ZERO) && value.lte(HUNDRED) ? value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4) : null
}

/** An amount typed as a share of the gross ("30" %): minor units, half up; null when the share is not a number in 0–100. */
export function amountOfPct(pct: string, gross: number): number | null {
  const share = parseDecimal(pct)
  if (share === null || share.lte(ZERO) || share.gt(HUNDRED)) return null
  const whole = new Dec(gross).times(share).dividedBy(HUNDRED).toDecimalPlaces(0, Dec.ROUND_HALF_UP)
  return Number(whole.toFixed(0))
}

const ADVANCE: readonly MilestoneKind[] = ['DEPOSIT', 'BEFORE_SHIPPING']
const isFinal = (status: string): boolean => status === 'CANCELLED' || status === 'CLOSED'

/** What one hand act writes, or why not (see the section's head). The API checked the version and that the targets exist. */
export function planByHand(facts: PlannerFacts, action: MoneyPlanAction): MoneyPlanOutcome {
  const refuse = (refusal: MoneyPlanRefusal): MoneyPlanOutcome => ({ ok: false, refusal })
  if (isFinal(facts.order.status)) return refuse('ORDER_FINAL')
  const gross = facts.order.gross
  const stepOf = (id: string | null | undefined) => (id ? facts.steps.find((step) => step.id === id) : undefined)
  const requestOf = (id: string | null | undefined) => (id ? facts.requests.find((request) => request.id === id) : undefined)
  const paidOn = (requestId: string | null) => requestOf(requestId)?.paid ?? 0
  let seq = Math.max(0, ...facts.steps.map((step) => step.seq))
  const nextSeq = () => (seq += 10)
  let refs = 0
  const steps: PlannedStep[] = []
  const cancelRequests: { id: string; note: string }[] = []
  const newRequests: PlannedRequest[] = []
  const moveRequests: { id: string; dueDate: BusinessDate }[] = []
  const replacements: { from: string; to: string }[] = []
  let depositRequired: boolean | null = null
  const result = (extra: Partial<Pick<MoneyPlanResult, 'payRequest' | 'remake' | 'short' | 'overridden'>> = {}): MoneyPlanOutcome => ({
    ok: true,
    plan: { act: action.act, steps, cancelRequests, newRequests, moveRequests, payRequest: extra.payRequest ?? null, replacements, depositRequired, remake: extra.remake ?? false, short: extra.short ?? null, overridden: extra.overridden ?? false },
  })
  const newRequest = (fields: Omit<PlannedRequest, 'ref' | 'sharePct'>): string => {
    const ref = `new:${++refs}`
    newRequests.push({ ref, ...fields, sharePct: sharePctOf(fields.amount, gross) })
    return ref
  }
  const keep = (step: PlannerStep, change: Partial<Omit<PlannedStep, 'id' | 'seq' | 'kind'>>): PlannedStep => ({
    id: step.id,
    seq: step.seq,
    kind: step.kind,
    status: 'OPEN',
    amount: step.amount,
    sharePct: step.sharePct,
    dueDate: step.dueDate,
    label: step.label,
    statusNote: null,
    request: step.depositRequestId,
    ...change,
  })
  /** An OPEN step at a new amount: its OPEN request (nothing on it) is replaced by one of the new amount. */
  const reAmounted = (step: PlannerStep, amount: number): PlannedStep => {
    const request = requestOf(step.depositRequestId)
    let requestRef = step.depositRequestId
    if (request && request.status === 'OPEN' && (step.kind === 'DEPOSIT' || step.kind === 'BEFORE_SHIPPING')) {
      cancelRequests.push({ id: request.id, note: BY_HAND_NOTES.CHANGED })
      requestRef = newRequest({ kind: request.kind, amount, dueDate: request.dueDate, stepKind: step.kind })
      replacements.push({ from: request.id, to: requestRef })
    }
    return keep(step, { amount, sharePct: sharePctOf(amount, gross), request: requestRef })
  }
  const liveOpen = facts.steps.filter((step) => step.status === 'OPEN')

  switch (action.act) {
    // ---- B-OM-011: replace the deposit (the old request cancelled, a new one in its place; the other open steps shared again) ----
    case 'REPLACE_DEPOSIT': {
      const request = requestOf(action.requestId)
      if (!request || request.status !== 'OPEN') return refuse('NOT_OPEN')
      if (request.paid !== 0) return refuse('MONEY_PLACED')
      const named = liveOpen.filter((step) => step.depositRequestId === request.id)
      if (named.some((step) => step.kind !== 'DEPOSIT')) return refuse('NOT_DEPOSIT')
      if (facts.order.goodsLeft) return refuse('GOODS_LEFT')
      if (action.amount <= 0) return refuse('BELOW_ZERO')
      if (action.amount > gross) return refuse('OVER_TOTAL')
      if (action.amount === request.amount) return refuse('NOTHING_CHANGES')
      cancelRequests.push({ id: request.id, note: BY_HAND_NOTES.REPLACED })
      const ref = newRequest({ kind: request.kind, amount: action.amount, dueDate: request.dueDate, stepKind: 'DEPOSIT' })
      replacements.push({ from: request.id, to: ref })
      for (const step of named) steps.push(keep(step, { amount: action.amount, sharePct: sharePctOf(action.amount, gross), request: ref }))
      return result({ remake: true })
    }
    // ---- B-OM-012: move a due day (the step's and its open request's together) ----
    case 'MOVE_DUE': {
      if (action.dueDate < facts.today) return refuse('PAST_DAY')
      const step = stepOf(action.milestoneId)
      if (step) {
        if (step.status !== 'OPEN') return refuse('NOT_OPEN')
        if (!ADVANCE.includes(step.kind)) return refuse('NOT_ADVANCE')
        if (step.dueDate === action.dueDate) return refuse('NOTHING_CHANGES')
        steps.push(keep(step, { dueDate: action.dueDate }))
        const request = requestOf(step.depositRequestId)
        if (request && request.status === 'OPEN') moveRequests.push({ id: request.id, dueDate: action.dueDate })
        return result()
      }
      const request = requestOf(action.requestId)
      if (!request || request.status !== 'OPEN') return refuse('NOT_OPEN')
      if (request.dueDate === action.dueDate) return refuse('NOTHING_CHANGES')
      moveRequests.push({ id: request.id, dueDate: action.dueDate })
      for (const named of liveOpen.filter((entry) => entry.depositRequestId === request.id)) steps.push(keep(named, { dueDate: action.dueDate }))
      return result()
    }
    // ---- B-OM-013: ask for a waived deposit (or step) again: a new request and a new step; the waived rows stay ----
    case 'ASK_AGAIN': {
      if (action.dueDate < facts.today) return refuse('PAST_DAY')
      const step = stepOf(action.milestoneId)
      if (step) {
        if (step.status !== 'WAIVED') return refuse('NOT_WAIVED')
        if (!ADVANCE.includes(step.kind)) return refuse('NOT_ADVANCE')
        if (facts.order.goodsLeft) return refuse('GOODS_LEFT')
        const waived = requestOf(step.depositRequestId)
        const ref = newRequest({ kind: waived?.kind ?? 'ACCONTO', amount: step.amount, dueDate: action.dueDate, stepKind: step.kind as 'DEPOSIT' | 'BEFORE_SHIPPING' })
        if (waived) replacements.push({ from: waived.id, to: ref })
        steps.push({ id: null, seq: nextSeq(), kind: step.kind, status: 'OPEN', amount: step.amount, sharePct: step.sharePct ?? sharePctOf(step.amount, gross), dueDate: action.dueDate, label: step.label, statusNote: null, request: ref })
        return result()
      }
      const request = requestOf(action.requestId)
      if (!request || request.status !== 'WAIVED') return refuse('NOT_WAIVED')
      if (facts.order.goodsLeft) return refuse('GOODS_LEFT')
      const ref = newRequest({ kind: request.kind, amount: request.amount, dueDate: action.dueDate, stepKind: 'DEPOSIT' })
      replacements.push({ from: request.id, to: ref })
      return result()
    }
    // ---- B-OM-014: add a step, taken out of another open step ----
    case 'ADD_STEP': {
      const from = stepOf(action.from)
      if (!from || from.status !== 'OPEN' || paidOn(from.depositRequestId) > 0) return refuse('REST_TO')
      if (action.amount <= 0 || action.amount >= from.amount) return refuse('BELOW_ZERO')
      const advance = ADVANCE.includes(action.kind)
      if (action.kind === 'DEPOSIT' && facts.steps.some((step) => step.kind === 'DEPOSIT' && (step.status === 'OPEN' || step.status === 'PAID'))) return refuse('SECOND_DEPOSIT')
      if (advance && facts.order.goodsLeft) return refuse('GOODS_LEFT')
      const dueDate = advance ? action.dueDate : null
      if (action.kind === 'DEPOSIT' && dueDate === null) return refuse('NO_DAY')
      if (dueDate !== null && dueDate < facts.today) return refuse('PAST_DAY')
      steps.push(reAmounted(from, from.amount - action.amount))
      const request = action.kind === 'DEPOSIT' || (action.kind === 'BEFORE_SHIPPING' && dueDate !== null) ? newRequest({ kind: 'ACCONTO', amount: action.amount, dueDate: dueDate!, stepKind: action.kind }) : null
      steps.push({ id: null, seq: nextSeq(), kind: action.kind, status: 'OPEN', amount: action.amount, sharePct: sharePctOf(action.amount, gross), dueDate, label: action.label, statusNote: null, request })
      if (action.kind === 'DEPOSIT') depositRequired = true
      return result()
    }
    // ---- B-OM-014: change a step's amount; another open step takes the difference (the total kept) ----
    case 'CHANGE_STEP': {
      const step = stepOf(action.milestoneId)
      if (!step || step.status !== 'OPEN') return refuse('NOT_OPEN')
      if (action.restTo === null) return refuse('TOTAL_CHANGES')
      const rest = stepOf(action.restTo)
      if (!rest || rest.id === step.id || rest.status !== 'OPEN') return refuse('REST_TO')
      if (paidOn(step.depositRequestId) > 0 || paidOn(rest.depositRequestId) > 0) return refuse('MONEY_PLACED')
      if (action.amount === step.amount) return refuse('NOTHING_CHANGES')
      const restAmount = rest.amount + (step.amount - action.amount)
      if (action.amount <= 0 || restAmount <= 0) return refuse('BELOW_ZERO')
      steps.push(reAmounted(step, action.amount), reAmounted(rest, restAmount))
      return result()
    }
    // ---- B-OM-014: remove a step; another open step takes its amount ----
    case 'REMOVE_STEP': {
      const step = stepOf(action.milestoneId)
      if (!step || step.status !== 'OPEN') return refuse('NOT_OPEN')
      if (paidOn(step.depositRequestId) > 0) return refuse('MONEY_PLACED')
      if (!liveOpen.some((entry) => entry.id !== step.id)) return refuse('LAST_STEP')
      if (action.restTo === null) return refuse('TOTAL_CHANGES')
      const rest = stepOf(action.restTo)
      if (!rest || rest.id === step.id || rest.status !== 'OPEN') return refuse('REST_TO')
      if (paidOn(rest.depositRequestId) > 0) return refuse('MONEY_PLACED')
      const request = requestOf(step.depositRequestId)
      if (request && request.status === 'OPEN') cancelRequests.push({ id: request.id, note: BY_HAND_NOTES.REMOVED })
      steps.push(keep(step, { status: 'CANCELLED', statusNote: BY_HAND_NOTES.REMOVED }), reAmounted(rest, rest.amount + step.amount))
      // The order's last deposit removed: production no longer waits for one.
      if (step.kind === 'DEPOSIT' && !facts.steps.some((entry) => entry.id !== step.id && entry.kind === 'DEPOSIT' && entry.status !== 'CANCELLED')) depositRequired = false
      return result()
    }
    // ---- B-OM-014: rename a step (as printed; none: its kind's words) ----
    case 'RENAME_STEP': {
      const step = stepOf(action.milestoneId)
      if (!step || step.status !== 'OPEN') return refuse('NOT_OPEN')
      if ((step.label ?? null) === action.label) return refuse('NOTHING_CHANGES')
      steps.push(keep(step, { label: action.label }))
      return result()
    }
    // ---- B-OM-014: undo "Open for payment" of a step before shipping (its request, nothing paid, cancelled) ----
    case 'UNDO_OPEN': {
      const step = stepOf(action.milestoneId)
      if (!step || step.status !== 'OPEN') return refuse('NOT_OPEN')
      if (step.kind !== 'BEFORE_SHIPPING') return refuse('NOT_ADVANCE')
      const request = requestOf(step.depositRequestId)
      if (!request) return refuse('NOT_OPENED')
      if (request.status !== 'OPEN') return refuse('NOT_OPEN')
      if (request.paid !== 0) return refuse('MONEY_PLACED')
      cancelRequests.push({ id: request.id, note: BY_HAND_NOTES.UNDONE })
      steps.push(keep(step, { request: null }))
      return result()
    }
    // ---- B-OM-015: change the payment terms after the yes: the open steps made again (hand steps kept) ----
    case 'CHANGE_TERMS': {
      if (action.paymentTermsId === facts.order.paymentTermsId) return refuse('TERMS_SAME')
      if (action.termsArchived) return refuse('TERMS_ARCHIVED')
      return result({ remake: true })
    }
    // ---- B-OM-016 (lead L1): accept a deposit short — PAID by hand with what is paid; the short part stays owed ----
    case 'ACCEPT_SHORT': {
      const request = requestOf(action.requestId)
      if (!request || request.status !== 'OPEN') return refuse('NOT_OPEN')
      // B-OM-024: the one rule the plan read's `short` says too.
      const short = shortOf(request)
      if (short === null) return refuse('NOTHING_SHORT')
      const beyond = beyondToleranceOf(short, action.tolerance)
      if (beyond && !action.override) return refuse(beyond)
      return result({ payRequest: request.id, short, overridden: beyond !== null })
    }
  }
}
