/**
 * Send to FBA (Step 4 part E1, Owner 2026-10-07) — the Matrix dialog's pure model. The rules, the counts, the boxes and
 * the words are the shared `@nexus/shared/fba-send` (`sendSummary`, `planBoxes`, `sendProblems`, `FBA_SEND_COPY`): the
 * server re-checks a create with the same functions, so the dialog cannot promise a box or a count the server would
 * refuse. What is here: who is sent (the ticked rows), the defaults, the table's per-SKU words, one Banner per kind of
 * problem, the draft request, the routes the dialog and the FBA shipments page call, and the Matrix read's two Step 4
 * fields. Owner 2026-10-08: the dialog no longer creates a plan — "Add to draft" puts the SKUs into the ONE open draft
 * for that From + To (no Amazon call, no hold); the FBA shipments page (Fulfillment › Outbound) sends it.
 *
 *     Send to FBA · 6 SKUs                                         ✕
 *     From [IT-MAIN · Rimini]   To [Amazon IT]   Ready [08/10/2026]
 *     Prep by [Amazon|Seller]   Labels by [Amazon|Seller]   Saved for these SKUs    ← only when one is "not set"
 *     SKU        Free             Cases         Units   Boxes        Check
 *     GALE-M     48 · 4 cases     [- 2 +]       [- 0 +] 2            Ready
 *     GALE-S     36 · 2×12 + 1×6  [- 2 ×12 +]   [- 0 +] 3            Ready     ← several case sizes: one stepper each
 *                                 [- 1 ×6 +]
 *     GALE-L     12               —             [- 5 +] 1 mixed      Ready
 *     Loose units go in 1 mixed box · 60 × 40 × 40 cm   ▸ Change box size
 *     [ SKUs 2 | Units 29 | Boxes 3 | Weight 31.4 kg ]
 *     ⚠ one Banner per kind of problem
 *                                          [Cancel] [Create plan · 29 units]
 *     → Done: "Plan sent to Amazon. …"   [Undo]            [Follow it] [Done]
 */
import {
  FBA_SEND_COPY, FBA_SEND_MAX_SKUS, MIXED_BOX_DEFAULT, isFbaPlanOpen, isFbaPlanStatus, isFbaPlanUnderWay, lineCases, lineUnits, sendSummary,
  type FbaBoxResult, type FbaCaseSize, type FbaDraftAddRequest, type FbaDraftSendRequest, type FbaDraftUpdateRequest, type FbaMixedBox,
  type FbaPlanListView, type FbaPlanView, type FbaSendChoice, type FbaSendDraft, type FbaSendLine, type FbaSendLocation, type FbaSendMarket,
  type FbaSendOwners, type FbaSendProblem, type FbaSendProblemCode, type FbaSendSku, type FbaSendSummary,
} from '@nexus/shared/fba-send'
import type { CaseCount, CaseOwner } from '@nexus/shared/stock-cases'

import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, type CommandKey } from '@/lib/command-key'

import type { MatrixFbaInbound, MatrixFbaPlan, MatrixRead } from '../contract'

/* ── who is sent ──────────────────────────────────────────────────────────────────────────────── */

export interface SendRow { id: string; isParent: boolean }

/**
 * The SKUs the dialog sends: the ticked variations, in the grid's order; a ticked parent sends every variation (the
 * `Stock source…` rule). A parent itself is never sent — only a family with no variation sends its one row.
 */
export function sendProductIds(selected: readonly SendRow[], all: readonly SendRow[]): string[] {
  const ticked = new Set(selected.map((r) => r.id))
  const variants = all.filter((r) => !r.isParent)
  if (selected.some((r) => r.isParent)) return (variants.length ? variants : all.filter((r) => ticked.has(r.id))).map((r) => r.id)
  return all.filter((r) => ticked.has(r.id) && !r.isParent).map((r) => r.id)
}

/** The family is on Amazon: a listed Amazon market, or a row with an Amazon listing. */
export function hasAmazonListing(read: Pick<MatrixRead, 'coordinates' | 'rows'> | null | undefined): boolean {
  if (!read) return false
  const amazon = new Set(read.coordinates.filter((c) => c.channel === 'AMAZON' && c.connected).map((c) => c.key))
  if (amazon.size === 0) return false
  if (read.coordinates.some((c) => amazon.has(c.key) && (c.listed ?? 0) > 0)) return true
  return read.rows.some((r) => Object.entries(r.cells).some(([key, cell]) => amazon.has(key) && !!cell?.listingId))
}

export const SEND_HELD = {
  loading: 'The Matrix is still loading',
  none: 'Tick a variation to send',
  tooMany: `One plan takes up to ${FBA_SEND_MAX_SKUS} SKUs`,
} as const

/** Why the toolbar's `Send to FBA…` cannot open now, or null. */
export function sendHeld(i: { loading: boolean; productIds: readonly string[] }): string | null {
  if (i.loading) return SEND_HELD.loading
  if (i.productIds.length === 0) return SEND_HELD.none
  if (i.productIds.length > FBA_SEND_MAX_SKUS) return SEND_HELD.tooMany
  return null
}

/** The toolbar button's hover line. */
export function sendDescription(skus: number, wholeFamily: boolean): string {
  const n = `${skus} ${skus === 1 ? 'SKU' : 'SKUs'}`
  return wholeFamily ? `The whole family: ${n} to Amazon FBA` : `${n} to Amazon FBA`
}

/** This family's open plans and drafts (`MatrixRead.fbaPlans`), newest first as read; absent = an older server = none. */
export function openPlans(read: Pick<MatrixRead, 'fbaPlans'> | null | undefined): MatrixFbaPlan[] {
  return (read?.fbaPlans ?? []).filter((p) => isFbaPlanOpen(p.status))
}
/** This family's plans under way (sent, not closed): the FBA cell's "in Nexus plan", the footer's shipment link. */
export function underWayPlans(read: Pick<MatrixRead, 'fbaPlans'> | null | undefined): MatrixFbaPlan[] {
  return (read?.fbaPlans ?? []).filter((p) => isFbaPlanUnderWay(p.status))
}
/** This family's DRAFT(s) — normally one per From + To. */
export function draftPlans(read: Pick<MatrixRead, 'fbaPlans'> | null | undefined): MatrixFbaPlan[] {
  return (read?.fbaPlans ?? []).filter((p) => p.status === 'DRAFT')
}

/* ── the FBA shipments page (Fulfillment › Outbound, Owner 2026-10-08) ────────────────────────── */

export const FBA_PAGE_PATH = '/fulfillment/outbound/fba'

/** The page, on one shipment (`?plan=`) or on a tab (`?view=`); the workspace prefix is added by the caller's router. */
export function fbaPageHref(at: { plan?: string | null; view?: FbaPlanListView | null } = {}): string {
  const params = new URLSearchParams()
  if (at.view) params.set('view', at.view)
  if (at.plan) params.set('plan', at.plan)
  const q = params.toString()
  return q ? `${FBA_PAGE_PATH}?${q}` : FBA_PAGE_PATH
}

export interface FooterLink { key: 'draft' | 'shipments'; label: string; href: string; title: string }

/**
 * The Matrix footer's links to the page: `FBA draft · 18 units` when a DRAFT holds this family's SKUs, and
 * `FBA shipment · Ready to ship` / `FBA shipments · 3` for the plans under way. Each opens the page at that shipment
 * (one) or on its tab (several).
 */
export function footerLinks(read: Pick<MatrixRead, 'fbaPlans'> | null | undefined): FooterLink[] {
  const out: FooterLink[] = []
  const drafts = draftPlans(read)
  if (drafts.length > 0) {
    const units = drafts.reduce((n, p) => n + p.units, 0)
    out.push({
      key: 'draft', label: FBA_SEND_COPY.draftLink(units),
      href: drafts.length === 1 ? fbaPageHref({ plan: drafts[0].id }) : fbaPageHref({ view: 'drafts' }),
      title: FBA_SEND_COPY.openPage,
    })
  }
  const going = underWayPlans(read)
  if (going.length > 0) {
    out.push({
      key: 'shipments', label: FBA_SEND_COPY.shipmentLink(going.length, FBA_SEND_COPY.status[going[0].status] ?? going[0].status),
      href: going.length === 1 ? fbaPageHref({ plan: going[0].id }) : fbaPageHref({ view: 'active' }),
      title: FBA_SEND_COPY.openPage,
    })
  }
  return out
}

/* ── the form ─────────────────────────────────────────────────────────────────────────────────── */

export type SendLines = Readonly<Record<string, FbaSendLine>>

export interface SendForm {
  lines: SendLines
  readyToShipOn: string
  mixedBox: FbaMixedBox
  owners: FbaSendOwners
}

/** Owner decision: the dialog asks Prep by / Labels by only when a SKU has "not set"; Seller by default. */
export const OWNERS_DEFAULT: FbaSendOwners = { prepOwner: 'SELLER', labelOwner: 'SELLER' }
export const OWNER_OPTIONS: ReadonlyArray<{ value: CaseOwner; label: string }> = [
  { value: 'AMAZON', label: FBA_SEND_COPY.owner.AMAZON },
  { value: 'SELLER', label: FBA_SEND_COPY.owner.SELLER },
]

/** A SKU of this send has no prep or label owner: the dialog asks once, and the server saves the answer for those SKUs. */
export const ownersAsked = (draft: Pick<FbaSendDraft, 'skus'>): boolean => draft.skus.some((s) => s.prepOwner === null || s.labelOwner === null)

const zero = (productId: string): FbaSendLine => ({ productId, cases: [], looseUnits: 0 })

/**
 * Where each SKU starts: what was typed (a SKU still there after From / To changed), else the open draft's numbers for
 * it (`draft.lines`), else 0 (the Owner's default).
 */
export function startLines(draft: Pick<FbaSendDraft, 'skus'> & Partial<Pick<FbaSendDraft, 'lines'>>, keep?: SendLines): Record<string, FbaSendLine> {
  const inDraft = new Map((draft.lines ?? []).map((l) => [l.productId, l]))
  const out: Record<string, FbaSendLine> = {}
  for (const s of draft.skus) {
    const typed = keep?.[s.productId]
    const saved = inDraft.get(s.productId)
    out[s.productId] = typed
      ? { ...typed, productId: s.productId }
      : saved ? { productId: s.productId, cases: saved.cases.map((c) => ({ ...c })), looseUnits: saved.looseUnits } : zero(s.productId)
  }
  return out
}

export function startForm(draft: FbaSendDraft): SendForm {
  return { lines: startLines(draft), readyToShipOn: draft.readyToShipOn, mixedBox: { ...draft.mixedBox }, owners: { ...OWNERS_DEFAULT } }
}

const sameBox = (a: FbaMixedBox, b: FbaMixedBox) =>
  a.lengthCm === b.lengthCm && a.widthCm === b.widthCm && a.heightCm === b.heightCm && a.emptyKg === b.emptyKg && a.maxKg === b.maxKg

/** What the person chose, as the shared rules read it: every SKU's line (0s included), the box only when changed. */
export function choiceOf(draft: FbaSendDraft, form: SendForm): FbaSendChoice {
  return {
    lines: draft.skus.map((s) => form.lines[s.productId] ?? zero(s.productId)),
    readyToShipOn: form.readyToShipOn,
    mixedBox: sameBox(form.mixedBox, draft.mixedBox) ? null : form.mixedBox,
    owners: ownersAsked(draft) ? form.owners : null,
  }
}

/** The shared verdict: counts, boxes, problems, the primary button and why it is held. */
export const summarize = (draft: FbaSendDraft, form: SendForm): FbaSendSummary => sendSummary(draft, choiceOf(draft, form))

/** A line as the server keeps it: the sizes with 0 cases left out. */
const tidy = (l: FbaSendLine): FbaSendLine => ({ productId: l.productId, cases: l.cases.filter((c) => c.cases > 0).map((c) => ({ ...c })), looseUnits: l.looseUnits })
const hasUnits = (l: FbaSendLine): boolean => lineCases(l) > 0 || l.looseUnits > 0

/**
 * POST /api/fba/inbound/drafts — "Add to draft": every SKU of the dialog. A SKU with units goes into the draft with these
 * numbers; a SKU at 0 that the draft holds is taken out; a SKU at 0 the draft does not hold is left out. Null while there
 * is no From warehouse.
 */
export function draftAddRequest(draft: FbaSendDraft, form: SendForm): FbaDraftAddRequest | null {
  if (!draft.from) return null
  const choice = choiceOf(draft, form)
  const inDraft = new Set((draft.lines ?? []).map((l) => l.productId))
  return {
    from: draft.from.code,
    market: draft.market,
    lines: choice.lines.filter((l) => hasUnits(l) || inDraft.has(l.productId)).map(tidy),
    readyToShipOn: form.readyToShipOn,
    mixedBox: choice.mixedBox ?? null,
    owners: choice.owners ?? null,
  }
}

/** The Undo of an "Add to draft": these SKUs back to the numbers the draft held for them (0 = out of the draft again). */
export function draftUndoRequest(draft: FbaSendDraft, sent: FbaDraftAddRequest): FbaDraftAddRequest {
  const before = new Map((draft.lines ?? []).map((l) => [l.productId, l]))
  return {
    from: sent.from,
    market: sent.market,
    lines: sent.lines.map((l) => (before.has(l.productId) ? tidy(before.get(l.productId)!) : { productId: l.productId, cases: [], looseUnits: 0 })),
  }
}

/** Units an "Add to draft" puts in: the SKUs of this dialog with units. */
export const addedUnits = (req: Pick<FbaDraftAddRequest, 'lines'>): number => req.lines.reduce((n, l) => n + lineUnits(l), 0)

/** The refusals that hold "Add to draft" (a draft keeps every other problem for the page, where "Send to Amazon" checks). */
const ADD_BLOCKING = new Set<FbaSendProblemCode>(['NOT_A_WAREHOUSE', 'NO_ACCOUNT', 'UNKNOWN_SKU', 'INVALID_QUANTITY', 'TOO_MANY_SKUS'])

/**
 * The dialog's button, `Add to draft · N units`, and why it is held: busy first; then From / To / the counts; then
 * nothing to add (0 units, and no SKU of the draft to take out). Every other problem shows as a Banner and stays for
 * "Send to Amazon".
 */
export function addPrimaryOf(summary: FbaSendSummary, draft: Pick<FbaSendDraft, 'lines'>, form: Pick<SendForm, 'lines'>, busy: 'reading' | 'adding' | null): { label: string; held: string | null } {
  const label = FBA_SEND_COPY.addToDraft(summary.units)
  if (busy === 'adding') return { label: 'Adding…', held: 'Adding…' }
  if (busy === 'reading') return { label, held: 'Reading the warehouse…' }
  const blocking = summary.blocking.find((p) => ADD_BLOCKING.has(p.code))
  if (blocking) return { label, held: blocking.message }
  const inDraft = new Set((draft.lines ?? []).map((l) => l.productId))
  const removes = Object.values(form.lines).some((l) => inDraft.has(l.productId) && !hasUnits(l))
  if (summary.units === 0 && !removes) return { label, held: FBA_SEND_COPY.problem.noUnits }
  return { label, held: null }
}

/** The page's button, `Send to Amazon · N units`: held while busy or by the first blocking problem (the server's rule). */
export function sendPrimaryOf(summary: FbaSendSummary, busy: 'reading' | 'saving' | 'sending' | null): { label: string; held: string | null } {
  const label = FBA_SEND_COPY.sendToAmazon(summary.units)
  if (busy === 'sending') return { label: 'Sending…', held: 'Sending…' }
  if (busy === 'reading') return { label, held: 'Reading the warehouse…' }
  if (busy === 'saving') return { label, held: 'Saving the draft…' }
  return { label, held: summary.held }
}

/** The draft's lines as the page keeps them (PATCH `lines`): every SKU shown, 0-unit ones too (a SKU added, numbers to come). */
export function draftLinesOf(draft: Pick<FbaSendDraft, 'skus'>, form: Pick<SendForm, 'lines'>): FbaSendLine[] {
  return draft.skus.map((s) => tidy(form.lines[s.productId] ?? zero(s.productId)))
}

/** PATCH /api/fba/inbound/plans/:id — what the page saves as you type: the lines, the day, the box when changed, the owners when asked. */
export function draftUpdateRequest(draft: FbaSendDraft, form: SendForm): FbaDraftUpdateRequest {
  const choice = choiceOf(draft, form)
  return {
    lines: draftLinesOf(draft, form),
    readyToShipOn: form.readyToShipOn,
    mixedBox: choice.mixedBox ?? null,
    ...(choice.owners ? { owners: choice.owners } : {}),
  }
}

/** POST /api/fba/inbound/plans/:id/send — the day, the box when changed, the owners when asked. */
export function draftSendRequest(draft: FbaSendDraft, form: SendForm): FbaDraftSendRequest {
  const choice = choiceOf(draft, form)
  return { readyToShipOn: form.readyToShipOn, mixedBox: choice.mixedBox ?? null, ...(choice.owners ? { owners: choice.owners } : {}) }
}

/* ── the table ────────────────────────────────────────────────────────────────────────────────── */

/** A SKU's Units stepper may go up to its free units (the shared check still names a total over free). */
export const unitsMax = (sku: Pick<FbaSendSku, 'free'>): number => Math.max(0, sku.free)
/** A Cases stepper of one case size: up to that size's free sealed cases at From. */
export const casesMax = (sku: Pick<FbaSendSku, 'freeSealed'>, unitsPerCase: number): number =>
  Math.max(0, sku.freeSealed.find((c) => c.unitsPerCase === unitsPerCase)?.cases ?? 0)

/** A SKU's Cases steppers: one per case size, biggest first, each with its max; [] = no case size (no stepper). */
export function caseSteppers(sku: Pick<FbaSendSku, 'caseSizes' | 'freeSealed'>): Array<{ unitsPerCase: number; max: number }> {
  return [...sku.caseSizes].sort((a, b) => b.unitsPerCase - a.unitsPerCase).map((c) => ({ unitsPerCase: c.unitsPerCase, max: casesMax(sku, c.unitsPerCase) }))
}

/** The cases of one size a line sends (0 when it names none). */
export const casesOf = (line: Pick<FbaSendLine, 'cases'> | undefined, unitsPerCase: number): number =>
  line?.cases.find((c) => c.unitsPerCase === unitsPerCase)?.cases ?? 0

/** The line with `n` cases of this size (the other sizes kept), biggest size first. */
export function withCases(line: FbaSendLine, unitsPerCase: number, n: number): FbaSendLine {
  const cases = [...line.cases.filter((c) => c.unitsPerCase !== unitsPerCase), { unitsPerCase, cases: n }]
  return { ...line, cases: cases.sort((a, b) => b.unitsPerCase - a.unitsPerCase) }
}

/** The Boxes column of one SKU: `3` case boxes, `2 mixed` (the mixed boxes its loose units are in), `3 + 2 mixed`, `—`. */
export function skuBoxes(plan: Pick<FbaBoxResult, 'boxes'>, productId: string): string {
  let cases = 0
  let mixed = 0
  for (const box of plan.boxes) {
    if (!box.items.some((i) => i.productId === productId)) continue
    if (box.kind === 'case') cases += box.quantity
    else mixed += box.quantity
  }
  if (cases === 0 && mixed === 0) return '—'
  if (mixed === 0) return String(cases)
  return cases === 0 ? `${mixed} mixed` : `${cases} + ${mixed} mixed`
}

export interface SkuCheck { tone: 'danger' | 'warning' | 'success'; text: string; message: string | null }

/** The Check column of one SKU: its first refusal, else its first warning, else `Ready` when it sends units; null at 0. */
export function skuCheck(summary: Pick<FbaSendSummary, 'problems'>, productId: string, line: FbaSendLine | undefined): SkuCheck | null {
  const mine = summary.problems.filter((p) => p.productId === productId)
  const first = mine.find((p) => p.blocking) ?? mine[0]
  if (first) return { tone: first.blocking ? 'danger' : 'warning', text: FBA_SEND_COPY.problemTitle[first.code], message: first.message }
  return line && (lineCases(line) > 0 || line.looseUnits > 0) ? { tone: 'success', text: 'Ready', message: null } : null
}

export interface ProblemBanner {
  code: FbaSendProblemCode
  title: string
  tone: 'danger' | 'warning'
  messages: string[]
  /** About the whole plan (From, account, address, ready day, box) — shown next to From / To; else about SKUs. */
  whole: boolean
}

/**
 * One Banner per kind of problem, in the shared order. `Nothing to send` is not a Banner: it is the held button's reason
 * (a dialog that opens at 0 units would otherwise open on a red box).
 */
export function problemBanners(problems: readonly FbaSendProblem[]): ProblemBanner[] {
  const out: ProblemBanner[] = []
  const byCode = new Map<FbaSendProblemCode, ProblemBanner>()
  for (const p of problems) {
    if (p.code === 'NO_UNITS') continue
    let banner = byCode.get(p.code)
    if (!banner) {
      banner = { code: p.code, title: FBA_SEND_COPY.problemTitle[p.code], tone: p.blocking ? 'danger' : 'warning', messages: [], whole: p.productId === null }
      byCode.set(p.code, banner)
      out.push(banner)
    }
    if (p.blocking) banner.tone = 'danger'
    if (p.productId !== null) banner.whole = false
    if (!banner.messages.includes(p.message)) banner.messages.push(p.message)
  }
  return out
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** The ONE summary line (Owner): `6 SKUs · 120 units · 8 boxes · 96.4 kg` — the shared `sendSummary`'s numbers. */
export function summaryLine(s: Pick<FbaSendSummary, 'skus' | 'units' | 'boxes' | 'weightKg'>): string {
  return [plural(s.skus, 'SKU', 'SKUs'), plural(s.units, 'unit', 'units'), plural(s.boxes, 'box', 'boxes'), FBA_SEND_COPY.weight(s.weightKg)].join(' · ')
}

/** The From Select: `IT-MAIN · Rimini` (the town when known), the name on hover. */
export const locationOption = (l: FbaSendLocation) => ({ value: l.code, label: l.town ? `${l.code} · ${l.town}` : l.code, title: l.name })
/** The To Select: the market's name (`Amazon IT`), its code when the server sent none. */
export const marketOption = (m: FbaSendMarket) => ({ value: m.code, label: m.name || m.code })

/** A typed box side: a number > 0, or null (the field shows the problem; the shared check refuses the box). */
export function parseSide(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'))
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
}

/* ── the done screen ──────────────────────────────────────────────────────────────────────────── */

export const DONE_COPY = {
  /** The Matrix toast after "Add to draft". */
  added: (units: number) => `${FBA_SEND_COPY.addedToDraft} · ${units.toLocaleString('en')} ${units === 1 ? 'unit' : 'units'}`,
  undoneToast: 'Draft put back as it was',
  open: 'Open',
} as const

/* ── the routes ───────────────────────────────────────────────────────────────────────────────── */

interface RouteOptions { fetchImpl?: typeof fetch; baseUrl?: string; signal?: AbortSignal }

/** The server's sentence (`{ ok: false, code, error, problems }`), else one that names what failed. */
export function errorSentence(body: unknown, status: number, what: string): string {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  const said = b && (typeof b.error === 'string' && b.error.trim() ? b.error : typeof b.message === 'string' && b.message.trim() ? b.message : null)
  if (said && status !== 404) return said
  if (status === 404 || status === 501) return `Send to FBA is not ready on this server yet (HTTP ${status})`
  return `${what} (HTTP ${status})`
}

/** The refusals a 400 carries (`problems`), malformed ones dropped. */
export function problemsOf(body: unknown): FbaSendProblem[] {
  const list = body && typeof body === 'object' ? (body as Record<string, unknown>).problems : null
  if (!Array.isArray(list)) return []
  return list.flatMap((raw): FbaSendProblem[] => {
    const p = raw as Record<string, unknown> | null
    if (!p || typeof p.code !== 'string' || typeof p.message !== 'string') return []
    return [{ code: p.code as FbaSendProblemCode, message: p.message, productId: typeof p.productId === 'string' ? p.productId : null, blocking: p.blocking !== false }]
  })
}

/** The SKUs at From (the Matrix dialog), or a draft's own SKUs, From, To, day and box (`planId`, the page). */
export interface DraftQuery { productIds: readonly string[]; from?: string | null; market?: string | null; planId?: string | null }

export function draftUrl(base: string, q: DraftQuery): string {
  const params = new URLSearchParams()
  if (q.productIds.length) params.set('productIds', q.productIds.join(','))
  if (q.planId) params.set('planId', q.planId)
  if (q.from) params.set('from', q.from)
  if (q.market) params.set('market', q.market)
  return `${base}/api/fba/inbound/send-draft?${params.toString()}`
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const owner = (v: unknown): CaseOwner | null => (v === 'AMAZON' || v === 'SELLER' ? v : null)

const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1

/** A SKU's case sizes as sent (biggest first); a size with no whole units per case, or named twice, is dropped. */
function parseCaseSizes(raw: unknown): FbaCaseSize[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  return raw.flatMap((x): FbaCaseSize[] => {
    const c = x as Record<string, unknown> | null
    if (!c || !isSize(c.unitsPerCase) || seen.has(c.unitsPerCase)) return []
    seen.add(c.unitsPerCase)
    const d = c.case as Record<string, unknown> | null | undefined
    return [{
      unitsPerCase: c.unitsPerCase,
      case: d && typeof d === 'object' ? { lengthCm: num(d.lengthCm), widthCm: num(d.widthCm), heightCm: num(d.heightCm), weightKg: num(d.weightKg) } : null,
    }]
  }).sort((a, b) => b.unitsPerCase - a.unitsPerCase)
}

/** Free sealed cases per size as sent; malformed entries dropped, a count below 0 read as 0. */
function parseCaseCounts(raw: unknown): CaseCount[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x): CaseCount[] => {
    const c = x as Record<string, unknown> | null
    return c && isSize(c.unitsPerCase) ? [{ unitsPerCase: c.unitsPerCase, cases: Math.max(0, Math.floor(num(c.cases))) }] : []
  }).sort((a, b) => b.unitsPerCase - a.unitsPerCase)
}

/** The draft as the dialog reads it: a body without `skus` is refused; anything optional falls back to "none". */
export function parseSendDraft(body: unknown): FbaSendDraft {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!b || !Array.isArray(b.skus)) throw new Error('The server answered something that is not a send to FBA.')
  const location = (raw: unknown): FbaSendLocation | null => {
    const l = raw as Record<string, unknown> | null
    return l && typeof l.code === 'string' && typeof l.id === 'string'
      ? { id: l.id, code: l.code, name: str(l.name) ?? l.code, town: str(l.town), country: str(l.country), isDefault: l.isDefault === true }
      : null
  }
  const box = (b.mixedBox ?? null) as Record<string, unknown> | null
  const address = (b.address ?? null) as Record<string, unknown> | null
  return {
    from: location(b.from),
    locations: Array.isArray(b.locations) ? b.locations.flatMap((l) => location(l) ?? []) : [],
    market: str(b.market) ?? 'IT',
    markets: Array.isArray(b.markets)
      ? b.markets.flatMap((raw): FbaSendMarket[] => {
          const m = raw as Record<string, unknown> | null
          return m && typeof m.code === 'string' ? [{ code: m.code, marketplaceId: String(m.marketplaceId ?? ''), name: str(m.name) ?? m.code, accountId: String(m.accountId ?? '') }] : []
        })
      : [],
    readyToShipOn: str(b.readyToShipOn) ?? '',
    today: str(b.today) ?? '',
    address: {
      missing: Array.isArray(address?.missing) ? (address!.missing as FbaSendDraft['address']['missing']) : [],
      summary: str(address?.summary),
    },
    mixedBox: box && typeof box === 'object'
      ? {
          lengthCm: num(box.lengthCm, MIXED_BOX_DEFAULT.lengthCm), widthCm: num(box.widthCm, MIXED_BOX_DEFAULT.widthCm),
          heightCm: num(box.heightCm, MIXED_BOX_DEFAULT.heightCm), emptyKg: num(box.emptyKg, MIXED_BOX_DEFAULT.emptyKg), maxKg: num(box.maxKg, MIXED_BOX_DEFAULT.maxKg),
        }
      : { ...MIXED_BOX_DEFAULT },
    skus: b.skus.flatMap((raw): FbaSendSku[] => {
      const s = raw as Record<string, unknown> | null
      if (!s || typeof s.productId !== 'string') return []
      const u = s.unit as Record<string, unknown> | null | undefined
      return [{
        productId: s.productId,
        sku: str(s.sku) ?? s.productId,
        msku: str(s.msku),
        caseSizes: parseCaseSizes(s.caseSizes),
        unitWeightKg: typeof s.unitWeightKg === 'number' && s.unitWeightKg > 0 ? s.unitWeightKg : null,
        unit: u && typeof u === 'object' ? { lengthCm: num(u.lengthCm), widthCm: num(u.widthCm), heightCm: num(u.heightCm) } : null,
        name: str(s.name) ?? '',
        onHand: num(s.onHand),
        free: num(s.free),
        freeSealed: parseCaseCounts(s.freeSealed),
        freeLoose: num(s.freeLoose),
        prepOwner: owner(s.prepOwner),
        labelOwner: owner(s.labelOwner),
        openPlanUnits: num(s.openPlanUnits),
      }]
    }),
    draftId: str(b.draftId),
    lines: parseLines(b.lines),
  }
}

/** Lines as sent (`FbaSendLine[]`): one per SKU, whole counts ≥ 0, sizes biggest first; malformed entries dropped. */
export function parseLines(raw: unknown): FbaSendLine[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((x): FbaSendLine[] => {
    const l = x as Record<string, unknown> | null
    if (!l || typeof l.productId !== 'string' || seen.has(l.productId)) return []
    seen.add(l.productId)
    return [{ productId: l.productId, cases: parseCaseCounts(l.cases), looseUnits: Math.max(0, Math.floor(num(l.looseUnits))) }]
  })
}

/** GET /api/fba/inbound/send-draft — the SKUs at From, the markets, the address check and the defaults. */
export async function fetchSendDraft(q: DraftQuery, opts: RouteOptions = {}): Promise<FbaSendDraft> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(draftUrl(opts.baseUrl ?? getBackendUrl(), q), { signal: opts.signal })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(errorSentence(body, res.status, 'The send could not be read'))
  return parseSendDraft(body)
}

export type CreateOutcome = { ok: true; planId: string } | { ok: false; message: string; problems: FbaSendProblem[] }

/** POST /api/fba/inbound/drafts — "Add to draft" (and its Undo): the draft's planId, or the server's sentence. */
export async function postDraftAdd(req: FbaDraftAddRequest, opts: Pick<RouteOptions, 'baseUrl' | 'fetchImpl'> = {}): Promise<CreateOutcome> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${opts.baseUrl ?? getBackendUrl()}/api/fba/inbound/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  if (res.ok && body && typeof body.planId === 'string') return { ok: true, planId: body.planId }
  return { ok: false, message: errorSentence(body, res.status, 'The draft was not saved'), problems: problemsOf(body) }
}

export type DraftSaveOutcome = { ok: true; plan: FbaPlanView | null } | { ok: false; message: string; code: string | null; problems: FbaSendProblem[] }

const codeOf = (body: unknown): string | null => {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  return b && typeof b.code === 'string' ? b.code : null
}
const planOf = (body: unknown): FbaPlanView | null => {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  return b && typeof b.id === 'string' && typeof b.status === 'string' ? (b as unknown as FbaPlanView) : null
}

/** PATCH /api/fba/inbound/plans/:id — the page saves a draft as the person types; 409 DRAFT_EXISTS says so. */
export async function patchDraft(planId: string, req: FbaDraftUpdateRequest, opts: Pick<RouteOptions, 'baseUrl' | 'fetchImpl'> = {}): Promise<DraftSaveOutcome> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${opts.baseUrl ?? getBackendUrl()}/api/fba/inbound/plans/${encodeURIComponent(planId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  const body = await res.json().catch(() => null)
  if (res.ok) return { ok: true, plan: planOf(body) }
  return { ok: false, message: errorSentence(body, res.status, 'The draft was not saved'), code: codeOf(body), problems: problemsOf(body) }
}

/** DELETE /api/fba/inbound/plans/:id — "Delete draft" (and the Undo of an "Add to draft" that made it). */
export async function deleteDraft(planId: string, opts: Pick<RouteOptions, 'baseUrl' | 'fetchImpl'> = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${opts.baseUrl ?? getBackendUrl()}/api/fba/inbound/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' })
  if (res.ok) return { ok: true }
  return { ok: false, message: errorSentence(await res.json().catch(() => null), res.status, 'The draft was not deleted') }
}

/** POST /api/fba/inbound/plans/:id/send with the intent's Idempotency-Key — "Send to Amazon" (a double click sends ONE plan). */
export async function postSendDraft(slot: CommandKey, planId: string, req: FbaDraftSendRequest, opts: Pick<RouteOptions, 'baseUrl'> = {}): Promise<CreateOutcome> {
  const { response, body, conflict } = await sendCommand<Record<string, unknown>>(slot, `${opts.baseUrl ?? getBackendUrl()}/api/fba/inbound/plans/${encodeURIComponent(planId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (conflict) return { ok: false, message: commandConflictMessage(conflict, 'send request'), problems: [] }
  if (response.ok) return { ok: true, planId: body && typeof body.planId === 'string' ? body.planId : planId }
  return { ok: false, message: errorSentence(body, response.status, 'The plan was not sent'), problems: problemsOf(body) }
}

/* ── the Matrix read's Step 4 fields (`source.ts` parses through these) ──────────────────────── */

/** `MatrixRowRead.fbaInbound`: absent = not read (`undefined`); `null` = nothing inbound, planned or sent; malformed = not read. */
export function parseFbaInbound(raw: unknown): MatrixFbaInbound | null | undefined {
  if (raw === null) return null
  const f = raw as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object' || typeof f.units !== 'number' || !Number.isFinite(f.units)) return undefined
  return {
    units: f.units, working: num(f.working), shipped: num(f.shipped), receiving: num(f.receiving),
    readAt: typeof f.readAt === 'string' ? f.readAt : null, planned: num(f.planned),
    // Units Nexus marked Shipped that Amazon may not count yet: a number ≥ 0, else absent (an older server sends none).
    ...(typeof f.sent === 'number' && Number.isFinite(f.sent) && f.sent >= 0 ? { sent: f.sent } : {}),
  }
}

/** `MatrixRead.fbaPlans`: absent = an older server (`undefined`); an entry with no id or an unknown status is dropped. */
export function parseFbaPlans(raw: unknown): MatrixFbaPlan[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((x): MatrixFbaPlan[] => {
    const p = x as Record<string, unknown> | null
    if (!p || typeof p.id !== 'string' || !isFbaPlanStatus(p.status)) return []
    return [{ id: p.id, name: typeof p.name === 'string' ? p.name : p.id, status: p.status, units: num(p.units) }]
  })
}
