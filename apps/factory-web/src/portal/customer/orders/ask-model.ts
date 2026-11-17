import { isApiError, issuePath } from '../../../lib/api/errors'
import type { AskImpact, AskSampleKind, AskVerdict, ChangeRequest, ChangeRules, ProductionAskBody, ProductionAskKind, RuleLine } from './api'
import { askRefusal, cancellableLines, MAX_NOTE, type AskFacts } from './model'

/**
 * F-PR-13 — the portal Ask dialog (production plan §3 "Brand asks, we decide", §5; 06-tree B.2 P-ORD-ask; lead picks L4, R-50; wall
 * PW-P06), pure. Step 1 says what: change (sizes, quantities, the date, the delivery address), cancel, and the production asks the
 * customer's limits open — make it urgent ("Urgent – asked", only while its urgency switch is on), pause, resume, ship what is
 * ready, another sample. Step 2 the details of a production ask; step 3 its impact before Send: what is frozen, the cost (an amount
 * only for a price role, else "A price may apply"), the earliest date (a date only). A kind whose request waits is not asked twice:
 * the request is withdrawn here, and our counter-offer is answered in Waiting for you (the one answering place, F-PR-14).
 *
 * The wall: everything here comes from the session's own reads of its OWN order (the rules, its requests, the impact); a body names
 * only lines of that order; the impact's words carry no load, no other order and no other customer (the API builds them so; the
 * view adds only our own words).
 */

export const ASK_KINDS = ['CHANGE', 'CANCEL', 'RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] as const
export type AskKind = (typeof ASK_KINDS)[number]
export const isAskKind = (value: unknown): value is AskKind => typeof value === 'string' && (ASK_KINDS as readonly string[]).includes(value)
export const isProductionKind = (kind: AskKind): kind is ProductionAskKind => kind !== 'CHANGE' && kind !== 'CANCEL'

/** A request that waits for our answer on a kind: withdrawn here (OPEN) or answered in Waiting for you (COUNTERED). */
export interface WaitingAsk {
  readonly requestId: string
  readonly status: 'OPEN' | 'COUNTERED'
  /** The day it was asked (`YYYY-MM-DD`). */
  readonly day: string | null
  readonly version: number | null
}

/** One choice of step 1. */
export interface AskChoice {
  readonly kind: AskKind
  /** It may be asked now (nothing holds it, nothing of the kind waits). */
  readonly possible: boolean
  /** Why not, in our words (a key and its day) — or, where only the API's words carry it (our lock's reason), those words. */
  readonly held: { readonly key: string; readonly params?: Readonly<Record<string, string>> } | { readonly words: { readonly it: string; readonly en: string } } | null
  readonly waiting: WaitingAsk | null
}

/** A verdict code in our words (a key of `portal-orders`); null: the API's words say it (our lock and its reason). */
export function verdictKey(kind: ProductionAskKind, verdict: Pick<AskVerdict, 'code' | 'day'>): { key: string; params?: Record<string, string> } | null {
  switch (verdict.code) {
    case 'FREE':
    case 'LOCKED':
      return null
    case 'READY':
      return { key: kind === 'HOLD' ? 'ask.verdict.READY_HOLD' : 'ask.verdict.READY' }
    case 'WAITING':
    case 'CUT':
    case 'LEATHER_CUT':
      return verdict.day ? { key: `ask.verdict.${verdict.code}`, params: { day: verdict.day } } : { key: `ask.verdict.${verdict.code}_NO_DAY` }
    default:
      return { key: `ask.verdict.${verdict.code}` }
  }
}

const waitingOf = (requests: readonly ChangeRequest[], match: (request: ChangeRequest) => boolean, fallback: { id: string; day: string | null } | null): WaitingAsk | null => {
  const found = requests.find((request) => (request.status === 'OPEN' || request.status === 'COUNTERED') && match(request))
  if (found) return { requestId: found.id, status: found.status === 'COUNTERED' ? 'COUNTERED' : 'OPEN', day: found.askedAt.slice(0, 10), version: found.version }
  return fallback ? { requestId: fallback.id, status: 'OPEN', day: fallback.day, version: null } : null
}

/**
 * Step 1's choices, in the dialog's order: change and cancel (they follow the company's cut-offs and are always named, held with
 * the API's words when closed), then each production ask the customer's limits open (a closed one is not drawn at all).
 */
export function askChoicesOf(rules: ChangeRules, requests: readonly ChangeRequest[]): AskChoice[] {
  const out: AskChoice[] = []
  // One change or cancel waits per order (B-W2b-183): the rules name it.
  const openChange = rules.openRequestId ? requests.find((request) => request.id === rules.openRequestId) ?? null : null
  for (const kind of ['CHANGE', 'CANCEL'] as const) {
    const verdict = kind === 'CHANGE' ? rules.change : rules.cancel
    const waiting = openChange && openChange.kind === kind ? waitingOf(requests, (request) => request.id === openChange.id, null) : null
    const possible = (kind === 'CHANGE' ? verdict.possible : verdict.possible || cancellableLines(rules).length > 0) && waiting === null && !(openChange && openChange.kind !== kind)
    out.push({ kind, possible, held: possible || waiting ? null : { words: verdict.words }, waiting })
  }
  for (const ask of rules.asks ?? []) {
    if (!ask.open) continue
    const waiting = ask.waitingRequestId ? waitingOf(requests, (request) => request.id === ask.waitingRequestId, { id: ask.waitingRequestId, day: ask.verdict.day }) : null
    const key = waiting ? null : verdictKey(ask.kind, ask.verdict)
    out.push({ kind: ask.kind, possible: ask.verdict.possible && waiting === null, held: ask.verdict.possible || waiting ? null : key ?? { words: ask.verdict.words }, waiting })
  }
  return out
}

// ── step 2: the details of a production ask ───────────────────────────────────────────────────────────────────────────────
export interface AskDraft {
  /** RUSH: the date it is needed by (optional); SPLIT_SHIPMENT: the first part's date (optional). */
  readonly requestedDate: string
  /** Their words (HOLD: why, required). */
  readonly note: string
  /** SPLIT_SHIPMENT: line → size → pieces that should ship first (0 or absent: none of that size). */
  readonly cells: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** SAMPLE_ROUND: the line the sample is of and the kind of round. */
  readonly lineId: string
  readonly sampleKind: AskSampleKind | ''
}
export const EMPTY_ASK: AskDraft = { requestedDate: '', note: '', cells: {}, lineId: '', sampleKind: '' }

/** The kinds that take a date (RUSH's need-by date, the first part's date). */
export const takesDate = (kind: ProductionAskKind): boolean => kind === 'RUSH' || kind === 'SPLIT_SHIPMENT'

/** The lines a ship-what-is-ready may name (the line's own verdict; an older answer without one: the line as it is). */
export const splitLines = (rules: Pick<ChangeRules, 'lines'>): RuleLine[] => rules.lines.filter((line) => line.split?.possible ?? true)

/** The first part's cells, only of the order's own lines and sizes, at most the pieces ordered (the wall: nothing else is named). */
export function splitCells(rules: Pick<ChangeRules, 'lines'>, draft: Pick<AskDraft, 'cells'>): { lineId: string; size: string; quantity: number }[] {
  const out: { lineId: string; size: string; quantity: number }[] = []
  for (const line of splitLines(rules)) {
    const touched = draft.cells[line.lineId]
    if (!touched) continue
    for (const size of line.sizes) {
      const pieces = touched[size.size]
      if (pieces !== undefined && Number.isInteger(pieces) && pieces > 0 && size.quantity > 0) out.push({ lineId: line.lineId, size: size.size, quantity: Math.min(pieces, size.quantity) })
    }
  }
  return out
}

/** Every piece of every open line first is the whole order: it ships as one already. */
export function splitIsWhole(rules: Pick<ChangeRules, 'lines'>, draft: Pick<AskDraft, 'cells'>): boolean {
  const asked = new Map(splitCells(rules, draft).map((cell) => [`${cell.lineId}|${cell.size}`, cell.quantity]))
  const sized = rules.lines.flatMap((line) => line.sizes.filter((size) => size.quantity > 0).map((size) => `${line.lineId}|${size.size}|${size.quantity}`))
  return sized.length > 0 && sized.every((entry) => {
    const [lineId, size, quantity] = entry.split('|')
    return asked.get(`${lineId}|${size}`) === Number(quantity)
  })
}

/** The line a sample round names, only one of the order's own. */
const ownLine = (rules: Pick<ChangeRules, 'lines'>, lineId: string): RuleLine | null => rules.lines.find((line) => line.lineId === lineId) ?? null

/** A sample round's kinds on a line, each with what the rules say now (an older answer: none offered). */
export const sampleKindsOf = (line: RuleLine | null): readonly { sampleKind: AskSampleKind; verdict: AskVerdict }[] => line?.samples ?? []

/** What Send sends for a production ask (only what the kind takes). */
export function askBodyOf(kind: ProductionAskKind, rules: Pick<ChangeRules, 'lines'>, draft: AskDraft): ProductionAskBody {
  const note = draft.note.trim()
  const date = takesDate(kind) && draft.requestedDate ? { requestedDate: draft.requestedDate } : {}
  switch (kind) {
    case 'SPLIT_SHIPMENT':
      return { kind, cells: splitCells(rules, draft), ...date, ...(note ? { note } : {}) }
    case 'SAMPLE_ROUND': {
      const line = ownLine(rules, draft.lineId)
      return { kind, lineId: line ? line.lineId : null, sampleKind: draft.sampleKind || null, ...(note ? { note } : {}) }
    }
    default:
      return { kind, ...date, ...(note ? { note } : {}) }
  }
}

/** What the person still has to fix before Review (a key of `portal-orders`), in the order they fix it; null: nothing. */
export function askProblem(kind: ProductionAskKind, rules: Pick<ChangeRules, 'lines' | 'order'>, draft: AskDraft, today: string): string | null {
  if (draft.note.length > MAX_NOTE) return 'ask.problem.long'
  if (takesDate(kind) && draft.requestedDate && draft.requestedDate < today) return 'ask.problem.past'
  switch (kind) {
    case 'RUSH':
      if (draft.requestedDate && rules.order.promiseDate && draft.requestedDate >= rules.order.promiseDate) return 'ask.problem.rushLater'
      return null
    case 'HOLD':
      return draft.note.trim() === '' ? 'ask.problem.holdWhy' : null
    case 'SPLIT_SHIPMENT':
      if (splitCells(rules, draft).length === 0) return 'ask.problem.splitNothing'
      if (splitIsWhole(rules, draft)) return 'ask.problem.splitWhole'
      return null
    case 'SAMPLE_ROUND': {
      const line = ownLine(rules, draft.lineId)
      if (!line) return 'ask.problem.sampleLine'
      if (!draft.sampleKind) return 'ask.problem.sampleKind'
      const verdict = sampleKindsOf(line).find((entry) => entry.sampleKind === draft.sampleKind)?.verdict
      if (verdict && !verdict.possible) return 'ask.problem.sampleClosed'
      return null
    }
    default:
      return null
  }
}

/** Why the ask cannot go on now (a key), in the order the person fixes it; null when it may. */
export function askHeld(kind: AskKind | null, rules: ChangeRules | null, choices: readonly AskChoice[], facts: AskFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.mayAsk) return 'held.mayAsk'
  if (!rules) return 'held.reading'
  if (kind === null) return 'ask.problem.choose'
  const choice = choices.find((entry) => entry.kind === kind)
  if (!choice) return 'ask.held.closed'
  if (choice.waiting) return 'ask.held.waiting'
  if (!choice.possible) return 'ask.held.closed'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  return null
}

// ── step 3: the impact before Send ──────────────────────────────────────────────────────────────────────────────────────────
export interface ImpactView {
  /** The headline: nothing frozen, frozen as a priced change, or a part that cannot change any more (our words). */
  readonly headline: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' }
  /** What the ask touches that the freeze rules hold now, in the API's words (its own lines only). */
  readonly frozen: readonly { readonly words: { readonly it: string; readonly en: string }; readonly blocked: boolean }[]
  /** The cost: an amount only for a price role (a cancel's fee), else "A price may apply", or "No price applies". */
  readonly cost: { readonly key: string; readonly params?: Readonly<Record<string, string>> }
  /** The earliest date (an estimate, a date only); null: planning was not asked (no date said, no pieces added). */
  readonly earliest: { readonly key: string; readonly date: string | null; readonly partial: boolean } | null
  /** What the kind may do to the date (our words, per kind). */
  readonly notes: readonly string[]
  /** A change of sizes or quantities: "after release a size change means cancel and remake", said plainly. */
  readonly afterRelease: boolean
  /** Send is held: a part cannot change any more. */
  readonly blocked: boolean
}

const NOTE_KINDS: ReadonlySet<AskKind> = new Set(['RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'])

/**
 * The impact as the dialog draws it. `fee` is the cancel's fee in minor units, present only for a reader with the price grain (the
 * API leaves it out otherwise); `money` writes it. `sizesAsked`: a change names sizes or quantities.
 */
export function impactViewOf(kind: AskKind, impact: AskImpact, options: { seesPrices: boolean; fee: number | null; money: (minor: number) => string; sizesAsked: boolean }): ImpactView {
  const headline = impact.frozen.length === 0 ? { key: 'ask.impact.nothingFrozen', tone: 'success' as const } : impact.blocked ? { key: 'ask.impact.blocked', tone: 'danger' as const } : { key: 'ask.impact.frozen', tone: 'warning' as const }
  const cost = options.seesPrices && options.fee !== null && options.fee > 0 ? { key: 'ask.impact.fee', params: { fee: options.money(options.fee) } } : impact.priced ? { key: 'ask.impact.mayApply' } : { key: 'ask.impact.noPrice' }
  const earliest = impact.earliest
    ? { key: impact.earliest.date === null ? 'ask.impact.earliestNone' : impact.earliest.meetsWanted === false ? 'ask.impact.earliestLater' : 'ask.impact.earliest', date: impact.earliest.date, partial: impact.earliest.partial }
    : null
  return {
    headline,
    frozen: impact.frozen.map((item) => ({ words: item.words, blocked: item.state === 'BLOCKED' })),
    cost,
    earliest,
    notes: impact.notes.length > 0 && NOTE_KINDS.has(kind) ? [`ask.impact.note.${kind}`] : [],
    afterRelease: kind === 'CHANGE' && options.sizesAsked,
    blocked: impact.blocked,
  }
}

/** Send waits for the impact (read, and nothing blocked): a key, or null. */
export function impactHeld(impact: { state: 'loading' | 'error' | 'ready'; view: ImpactView | null } | null): string | null {
  if (!impact) return null
  if (impact.state === 'loading') return 'ask.impact.reading'
  if (impact.state === 'error' || !impact.view) return 'ask.impact.failedHeld'
  return impact.view.blocked ? 'ask.impact.blockedHeld' : null
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ASK_CODES = ['NOT_OPEN', 'NOT_ASKABLE', 'WAITING', 'READY', 'LOCKED', 'ALREADY_URGENT', 'PAUSED', 'NOT_PAUSED', 'SHIPS_AS_READY', 'CLOSED_SHORT', 'CUT', 'LEATHER_CUT'] as const

/**
 * A refused production ask in our words: a closed or held ask names its code in the issue's path (`body/PAUSED`,
 * `body/cells/0/CUT`) — said, and the rules read again; a part that cannot change any more (`body/SIZE_QUANTITY`) too; anything
 * else as the change and cancel requests say it.
 */
export function productionAskRefusal(error: unknown): { key: string; reread: boolean } {
  if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')) {
    const lasts = error.issues.map((issue) => issuePath(issue).split(/[/.]/).pop() ?? '')
    const code = lasts.find((last) => (ASK_CODES as readonly string[]).includes(last))
    if (code) return { key: code === 'WAITING' || code === 'CUT' || code === 'LEATHER_CUT' ? `ask.verdict.${code}_NO_DAY` : `ask.verdict.${code}`, reread: true }
    if (lasts.some((last) => last === 'SIZE_QUANTITY' || last === 'COLOURWAY' || last === 'DELIVERY_DATE' || last === 'SHIP_TO')) return { key: 'ask.impact.blockedHeld', reread: true }
  }
  return askRefusal(error)
}
