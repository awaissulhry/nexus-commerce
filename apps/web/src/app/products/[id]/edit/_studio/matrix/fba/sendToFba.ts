/**
 * Send to FBA (Step 4 part E1, Owner 2026-10-07) — the Matrix dialog's pure model. The rules, the counts, the boxes and
 * the words are the shared `@nexus/shared/fba-send` (`sendSummary`, `planBoxes`, `sendProblems`, `FBA_SEND_COPY`): the
 * server re-checks a create with the same functions, so the dialog cannot promise a box or a count the server would
 * refuse. What is here: who is sent (the ticked rows), the defaults, the table's per-SKU words, one Banner per kind of
 * problem, the create request, the three routes the dialog calls, and the Matrix read's two Step 4 fields.
 *
 *     Send to FBA · 6 SKUs                                         ✕
 *     From [IT-MAIN · Rimini]   To [Amazon IT]   Ready [08/10/2026]
 *     Prep by [Amazon|Seller]   Labels by [Amazon|Seller]   Saved for these SKUs    ← only when one is "not set"
 *     SKU        Free          Cases   Units   Boxes        Check
 *     GALE-M     48 · 4 cases  [- 2 +] [- 0 +] 2            Ready
 *     GALE-L     12            —       [- 5 +] 1 mixed      Ready
 *     Loose units go in 1 mixed box · 60 × 40 × 40 cm   ▸ Change box size
 *     [ SKUs 2 | Units 29 | Boxes 3 | Weight 31.4 kg ]
 *     ⚠ one Banner per kind of problem
 *                                          [Cancel] [Create plan · 29 units]
 *     → Done: "Plan sent to Amazon. …"   [Undo]            [Follow it] [Done]
 */
import {
  FBA_SEND_COPY, FBA_SEND_MAX_SKUS, MIXED_BOX_DEFAULT, isFbaPlanOpen, isFbaPlanStatus, sendSummary,
  type FbaBoxResult, type FbaCreateRequest, type FbaMixedBox, type FbaPlanView, type FbaSendChoice, type FbaSendDraft,
  type FbaSendLine, type FbaSendLocation, type FbaSendMarket, type FbaSendOwners, type FbaSendProblem, type FbaSendProblemCode,
  type FbaSendSku, type FbaSendSummary,
} from '@nexus/shared/fba-send'
import type { CaseOwner } from '@nexus/shared/stock-cases'

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

/** This family's open plans (`MatrixRead.fbaPlans`), newest first as read; absent = an older server = none. */
export function openPlans(read: Pick<MatrixRead, 'fbaPlans'> | null | undefined): MatrixFbaPlan[] {
  return (read?.fbaPlans ?? []).filter((p) => isFbaPlanOpen(p.status))
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

const zero = (productId: string): FbaSendLine => ({ productId, cases: 0, looseUnits: 0 })

/** Every SKU at 0 (the Owner's default), keeping what was typed for a SKU still in the new draft (From / To changed). */
export function startLines(draft: Pick<FbaSendDraft, 'skus'>, keep?: SendLines): Record<string, FbaSendLine> {
  const out: Record<string, FbaSendLine> = {}
  for (const s of draft.skus) out[s.productId] = keep?.[s.productId] ? { ...keep[s.productId]!, productId: s.productId } : zero(s.productId)
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

/** POST /api/fba/inbound/plans — only the SKUs with units; null while there is no From warehouse. */
export function createRequest(draft: FbaSendDraft, form: SendForm): FbaCreateRequest | null {
  if (!draft.from) return null
  const choice = choiceOf(draft, form)
  return {
    from: draft.from.code,
    market: draft.market,
    readyToShipOn: form.readyToShipOn,
    lines: choice.lines.filter((l) => l.cases > 0 || l.looseUnits > 0).map((l) => ({ productId: l.productId, cases: l.cases, looseUnits: l.looseUnits })),
    mixedBox: choice.mixedBox ?? null,
    owners: choice.owners ?? null,
  }
}

/** The primary button: its words, and why it is held (busy first, then the first blocking problem). */
export function primaryOf(summary: FbaSendSummary, busy: 'reading' | 'creating' | null): { label: string; held: string | null } {
  if (busy === 'creating') return { label: 'Creating…', held: 'Creating…' }
  if (busy === 'reading') return { label: summary.primary, held: 'Reading the warehouse…' }
  return { label: summary.primary, held: summary.held }
}

/* ── the table ────────────────────────────────────────────────────────────────────────────────── */

/** A SKU's Units stepper may go up to its free units (the shared check still names a total over free). */
export const unitsMax = (sku: Pick<FbaSendSku, 'free'>): number => Math.max(0, sku.free)
/** A SKU's Cases stepper: up to its free sealed cases; null = no case size (no stepper). */
export const casesMax = (sku: Pick<FbaSendSku, 'unitsPerCase' | 'freeSealed'>): number | null =>
  typeof sku.unitsPerCase === 'number' && sku.unitsPerCase >= 1 ? Math.max(0, sku.freeSealed) : null

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
  return line && (line.cases > 0 || line.looseUnits > 0) ? { tone: 'success', text: 'Ready', message: null } : null
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
  undone: 'Plan cancelled. The units are free again.',
  created: (units: number) => `FBA plan created · ${units} ${units === 1 ? 'unit' : 'units'} held`,
  undoneToast: 'FBA plan cancelled · the units are free again',
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

export interface DraftQuery { productIds: readonly string[]; from?: string | null; market?: string | null }

export function draftUrl(base: string, q: DraftQuery): string {
  const params = new URLSearchParams({ productIds: q.productIds.join(',') })
  if (q.from) params.set('from', q.from)
  if (q.market) params.set('market', q.market)
  return `${base}/api/fba/inbound/send-draft?${params.toString()}`
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const owner = (v: unknown): CaseOwner | null => (v === 'AMAZON' || v === 'SELLER' ? v : null)

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
      const c = s.case as Record<string, unknown> | null | undefined
      const u = s.unit as Record<string, unknown> | null | undefined
      return [{
        productId: s.productId,
        sku: str(s.sku) ?? s.productId,
        msku: str(s.msku),
        unitsPerCase: typeof s.unitsPerCase === 'number' && s.unitsPerCase >= 1 ? s.unitsPerCase : null,
        case: c && typeof c === 'object' ? { lengthCm: num(c.lengthCm), widthCm: num(c.widthCm), heightCm: num(c.heightCm), weightKg: num(c.weightKg) } : null,
        unitWeightKg: typeof s.unitWeightKg === 'number' && s.unitWeightKg > 0 ? s.unitWeightKg : null,
        unit: u && typeof u === 'object' ? { lengthCm: num(u.lengthCm), widthCm: num(u.widthCm), heightCm: num(u.heightCm) } : null,
        name: str(s.name) ?? '',
        onHand: num(s.onHand),
        free: num(s.free),
        freeSealed: num(s.freeSealed),
        freeLoose: num(s.freeLoose),
        prepOwner: owner(s.prepOwner),
        labelOwner: owner(s.labelOwner),
        openPlanUnits: num(s.openPlanUnits),
      }]
    }),
  }
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

/** POST /api/fba/inbound/plans with the intent's Idempotency-Key (a double click or a resend makes ONE plan). */
export async function postSendPlan(slot: CommandKey, req: FbaCreateRequest, opts: Pick<RouteOptions, 'baseUrl'> = {}): Promise<CreateOutcome> {
  const { response, body, conflict } = await sendCommand<Record<string, unknown>>(slot, `${opts.baseUrl ?? getBackendUrl()}/api/fba/inbound/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (conflict) return { ok: false, message: commandConflictMessage(conflict, 'plan request'), problems: [] }
  if (response.ok && body && typeof body.planId === 'string') return { ok: true, planId: body.planId }
  return { ok: false, message: errorSentence(body, response.status, 'The plan was not created'), problems: problemsOf(body) }
}

export type CancelOutcome = { ok: true; plan: FbaPlanView | null } | { ok: false; message: string }

/** POST /api/fba/inbound/plans/:id/cancel — Undo: the holds are released at the click; free until confirmed with Amazon. */
export async function postCancelPlan(slot: CommandKey, planId: string, opts: Pick<RouteOptions, 'baseUrl'> = {}): Promise<CancelOutcome> {
  const { response, body, conflict } = await sendCommand<Record<string, unknown>>(slot, `${opts.baseUrl ?? getBackendUrl()}/api/fba/inbound/plans/${encodeURIComponent(planId)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (conflict) return { ok: false, message: commandConflictMessage(conflict, 'cancel request') }
  if (response.ok) return { ok: true, plan: body && typeof body.id === 'string' ? (body as unknown as FbaPlanView) : null }
  return { ok: false, message: errorSentence(body, response.status, 'The plan was not cancelled') }
}

/* ── the Matrix read's Step 4 fields (`source.ts` parses through these) ──────────────────────── */

/** `MatrixRowRead.fbaInbound`: absent = not read (`undefined`); `null` = nothing inbound or planned; malformed = not read. */
export function parseFbaInbound(raw: unknown): MatrixFbaInbound | null | undefined {
  if (raw === null) return null
  const f = raw as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object' || typeof f.units !== 'number' || !Number.isFinite(f.units)) return undefined
  return {
    units: f.units, working: num(f.working), shipped: num(f.shipped), receiving: num(f.receiving),
    readAt: typeof f.readAt === 'string' ? f.readAt : null, planned: num(f.planned),
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
