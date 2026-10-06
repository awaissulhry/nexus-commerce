/**
 * CR rebuild 5 — Campaigns: what automation may touch on each campaign, as a DRAFT the person reviews before anything
 * is saved. Pure: the tab renders these, the tests drive them directly.
 *
 * Before (the old Guardrails grid, report 7 §5): a bid box saved when focus left it, "Managed" and the pins were
 * one-click toggles, and the bulk bar ran one write per campaign with no question. Now every edit — a cell, a toggle,
 * a bulk action — only changes this draft. Review shows one table old → new; Save sends it. A change that lets
 * automation touch MORE (allow it, loosen a bid bound, clear one, unlock a part) is a raise: the review asks for the tick.
 *
 * Each write goes to the endpoint that already existed:
 *   · Automation may change it → PATCH /api/advertising/campaigns/:id/live-writes  { enabled }
 *   · Lowest / highest bid      → PATCH …/guardrails  { minBidCents?, maxBidCents? } — ONLY the bound the person edited.
 *                                 The server checks the resulting pair against what is stored (ads-guardrails.ts
 *                                 `validateGuardrails`), so a one-sided body is safe. Sending both (CR review #1) put back
 *                                 the other bound from the page's first read and silently cleared a limit set elsewhere.
 *   · Bid limit for you and Claude → PATCH …/cpc-ceiling { enabled: false } | { enabled: true, multiple } (1–10)
 *   · Locked parts              → PATCH …/pins        { pinPlacement?, pinBids?, pinBudget? } — only the changed ones
 *
 * The order per campaign (CR review #3): blocking automation goes FIRST (a brake); bounds, the bid limit and locks next;
 * allowing automation goes LAST and is not sent when an earlier change for that campaign was refused — a campaign is
 * never opened to automation without the limits the person reviewed with it.
 */
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'

export type Part = 'placement' | 'bids' | 'budget'
export const PARTS: readonly Part[] = ['placement', 'bids', 'budget']
export const PART_WORD: Record<Part, string> = { placement: 'Placement', bids: 'Bids', budget: 'Budget' }
const PIN_FIELD: Record<Part, 'pinPlacement' | 'pinBids' | 'pinBudget'> = { placement: 'pinPlacement', bids: 'pinBids', budget: 'pinBudget' }

/** One row of GET /api/advertising/control-room/guardrail-grid (ads-control-room-detail.service.ts). */
export interface CampaignRow {
  id: string
  name: string
  marketplace: string | null
  status: string
  portfolioName: string | null
  managed: boolean
  minBidCents: number | null
  maxBidCents: number | null
  dailyBudgetCents: number | null
  /** The campaign's OWN target, in whole percent; null = it has none of its own. */
  targetAcosPct: number | null
  /** A multiple of the target's historical CPC; null = off. */
  cpcCeiling: { enabled: boolean; multiple: number } | null
  suppressedAt: string | null
  suppressedBy: string | null
  pins: Record<Part, boolean>
  pinNote: string | null
  pinnedBy: string | null
  boundRules: Array<{ id: string; name: string; level: string; enabled: boolean }>
}

export interface CampaignGrid {
  rows: CampaignRow[]
  accountWideRules: number
  totals: { campaigns: number; managed: number; withMinBid: number; withMaxBid: number; pinned: number; suppressed: number }
}

/** What the person changed on one campaign. A field that is absent is unchanged. */
export interface CampaignEdit {
  allowed?: boolean
  minBidCents?: number | null
  maxBidCents?: number | null
  cpcMultiple?: number | null
  pins?: Partial<Record<Part, boolean>>
}
export type Draft = Readonly<Record<string, CampaignEdit>>

/** The values the campaign would have after the edit. */
export interface CampaignValues {
  allowed: boolean
  minBidCents: number | null
  maxBidCents: number | null
  cpcMultiple: number | null
  pins: Record<Part, boolean>
}

export function storedValues(row: CampaignRow): CampaignValues {
  return {
    allowed: row.managed,
    minBidCents: row.minBidCents,
    maxBidCents: row.maxBidCents,
    cpcMultiple: row.cpcCeiling?.enabled ? row.cpcCeiling.multiple : null,
    pins: { ...row.pins },
  }
}

export function valuesOf(row: CampaignRow, edit: CampaignEdit | undefined): CampaignValues {
  const s = storedValues(row)
  if (!edit) return s
  return {
    allowed: edit.allowed ?? s.allowed,
    minBidCents: edit.minBidCents !== undefined ? edit.minBidCents : s.minBidCents,
    maxBidCents: edit.maxBidCents !== undefined ? edit.maxBidCents : s.maxBidCents,
    cpcMultiple: edit.cpcMultiple !== undefined ? edit.cpcMultiple : s.cpcMultiple,
    pins: { ...s.pins, ...edit.pins },
  }
}

/** The edit with every field that equals the stored value left out; undefined when nothing is left. */
function tidy(row: CampaignRow, edit: CampaignEdit): CampaignEdit | undefined {
  const s = storedValues(row)
  const out: CampaignEdit = {}
  if (edit.allowed !== undefined && edit.allowed !== s.allowed) out.allowed = edit.allowed
  if (edit.minBidCents !== undefined && edit.minBidCents !== s.minBidCents) out.minBidCents = edit.minBidCents
  if (edit.maxBidCents !== undefined && edit.maxBidCents !== s.maxBidCents) out.maxBidCents = edit.maxBidCents
  if (edit.cpcMultiple !== undefined && edit.cpcMultiple !== s.cpcMultiple) out.cpcMultiple = edit.cpcMultiple
  const pins = Object.fromEntries(PARTS.filter((p) => edit.pins?.[p] !== undefined && edit.pins[p] !== s.pins[p]).map((p) => [p, edit.pins![p]]))
  if (Object.keys(pins).length) out.pins = pins
  return Object.keys(out).length ? out : undefined
}

/** The draft with this change merged in for one campaign. Setting a field back to its stored value removes it. */
export function setEdit(draft: Draft, row: CampaignRow, patch: CampaignEdit): Draft {
  const prev = draft[row.id] ?? {}
  const merged: CampaignEdit = { ...prev, ...patch, pins: patch.pins ? { ...prev.pins, ...patch.pins } : prev.pins }
  const next = tidy(row, merged)
  const out = { ...draft }
  if (next) out[row.id] = next
  else delete out[row.id]
  return out
}

export type BulkOp =
  | { kind: 'allowed'; value: boolean }
  | { kind: 'minBid'; cents: number | null }
  | { kind: 'maxBid'; cents: number | null }
  | { kind: 'pin'; part: Part; value: boolean }

/** A bulk action fills the draft for every ticked campaign; it never writes. */
export function applyBulk(draft: Draft, rows: readonly CampaignRow[], op: BulkOp): Draft {
  let out = draft
  for (const row of rows) {
    const patch: CampaignEdit = op.kind === 'allowed' ? { allowed: op.value }
      : op.kind === 'minBid' ? { minBidCents: op.cents }
        : op.kind === 'maxBid' ? { maxBidCents: op.cents }
          : { pins: { [op.part]: op.value } }
    out = setEdit(out, row, patch)
  }
  return out
}

// ── money and numbers ───────────────────────────────────────────────────────────────────────────────────

/** The currency Amazon bills the campaign's market in; null when Nexus has no checked row for it. */
export const currencyOf = (market: string | null): string | null => marketLimitsOf(market)?.currency ?? null

export function moneyWords(cents: number | null, currency: string | null): string {
  if (cents == null) return '—'
  return currency
    ? new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100)
    : (cents / 100).toFixed(2)
}

/** "1,50" or "1.50" → 150; "" → null (clear); anything else → NaN. */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN
  return Math.round(Number(t) * 100)
}

/** "1.5" → 1.5; "" → null (off); anything else → NaN. */
export function parseMultiple(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return /^\d+(\.\d+)?$/.test(t) && Number.isFinite(n) ? n : Number.NaN
}

/** A stored amount as the text an input box starts with: 150 → "1.50", null → "". */
export const moneyInput = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2))

// ── checks ──────────────────────────────────────────────────────────────────────────────────────────────

/** What is wrong with the campaign after the edit, in words; empty when it can be saved. */
export function problemsOf(row: CampaignRow, edit: CampaignEdit | undefined): string[] {
  if (!edit) return []
  const v = valuesOf(row, edit)
  const out: string[] = []
  for (const [label, cents] of [['Lowest bid', v.minBidCents], ['Highest bid', v.maxBidCents]] as const) {
    if (cents != null && !(Number.isFinite(cents) && cents > 0)) out.push(`${label} must be a number above 0.`)
  }
  if (v.minBidCents != null && v.maxBidCents != null && Number.isFinite(v.minBidCents) && Number.isFinite(v.maxBidCents) && v.minBidCents > v.maxBidCents) {
    out.push('The lowest bid is above the highest bid. Nothing could change its bids.')
  }
  if (v.cpcMultiple != null && !(Number.isFinite(v.cpcMultiple) && v.cpcMultiple >= 1 && v.cpcMultiple <= 10)) {
    out.push('The bid limit for you and Claude must be from 1 to 10 times the usual click cost.')
  }
  return out
}

// ── the review ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The per-campaign limit on bid edits by a person or Claude, as a multiple of the usual cost per click. Not a second
 * "highest bid": the engines do not read it (ads-cpc-ceiling.ts is read only by the bid routes and Claude's tools).
 */
export const CEILING_WORD = 'Bid limit for you and Claude'
export const multipleWords = (m: number | null) => (m == null ? 'Off' : `${m} × usual click cost`)

export interface ReviewLine {
  id: string
  campaignId: string
  campaign: string
  what: string
  before: string
  after: string
  /** It lets automation touch more: the review asks for the tick. */
  raise: boolean
}

const looser = (before: number | null, after: number | null, higherIsLooser: boolean): boolean => {
  if (after == null) return before != null // clearing a bound loosens it
  if (before == null) return false // a first bound tightens
  return higherIsLooser ? after > before : after < before
}

export function reviewLines(draft: Draft, rowsById: ReadonlyMap<string, CampaignRow>): ReviewLine[] {
  const out: ReviewLine[] = []
  for (const [id, edit] of Object.entries(draft)) {
    const row = rowsById.get(id)
    if (!row) continue
    const s = storedValues(row)
    const cur = currencyOf(row.marketplace)
    const line = (what: string, before: string, after: string, raise: boolean) =>
      out.push({ id: `${id}:${what}`, campaignId: id, campaign: row.name, what, before, after, raise })
    if (edit.allowed !== undefined) line('Automation may change it', s.allowed ? 'Yes' : 'No', edit.allowed ? 'Yes' : 'No', edit.allowed)
    if (edit.minBidCents !== undefined) line('Lowest bid', moneyWords(s.minBidCents, cur), moneyWords(edit.minBidCents, cur), looser(s.minBidCents, edit.minBidCents, false))
    if (edit.maxBidCents !== undefined) line('Highest bid', moneyWords(s.maxBidCents, cur), moneyWords(edit.maxBidCents, cur), looser(s.maxBidCents, edit.maxBidCents, true))
    if (edit.cpcMultiple !== undefined) {
      line(CEILING_WORD, multipleWords(s.cpcMultiple), multipleWords(edit.cpcMultiple), looser(s.cpcMultiple, edit.cpcMultiple, true))
    }
    for (const part of PARTS) {
      const to = edit.pins?.[part]
      if (to === undefined) continue
      line(`${PART_WORD[part]} locked`, s.pins[part] ? 'Locked' : 'Not locked', to ? 'Locked' : 'Not locked', !to)
    }
  }
  return out
}

export const changeCount = (draft: Draft, rowsById: ReadonlyMap<string, CampaignRow>) => reviewLines(draft, rowsById).length

/** The review, one group per campaign (three short columns read on a phone without words breaking). */
export function reviewGroups(lines: readonly ReviewLine[]): Array<{ campaignId: string; campaign: string; lines: ReviewLine[] }> {
  const out = new Map<string, { campaignId: string; campaign: string; lines: ReviewLine[] }>()
  for (const l of lines) {
    const g = out.get(l.campaignId) ?? { campaignId: l.campaignId, campaign: l.campaign, lines: [] }
    g.lines.push(l)
    out.set(l.campaignId, g)
  }
  return [...out.values()]
}

/** A stored value that changed on the server since the draft was made (someone else, a rule, Claude). */
export interface Conflict { campaignId: string; campaign: string; what: string; was: string; now: string }

/**
 * The drafted fields whose STORED value differs between the read the draft was made on (`before`) and a fresh read
 * (`after`). The review shows the fresh value as "Now", so the person sees what Save would overwrite.
 */
export function conflictsOf(draft: Draft, before: ReadonlyMap<string, CampaignRow>, after: ReadonlyMap<string, CampaignRow>): Conflict[] {
  const out: Conflict[] = []
  for (const [id, edit] of Object.entries(draft)) {
    const a = before.get(id)
    const b = after.get(id)
    if (!a || !b) continue
    const sa = storedValues(a)
    const sb = storedValues(b)
    const cur = currencyOf(b.marketplace)
    const add = (what: string, was: string, now: string) => { if (was !== now) out.push({ campaignId: id, campaign: b.name, what, was, now }) }
    if (edit.allowed !== undefined) add('Automation may change it', sa.allowed ? 'Yes' : 'No', sb.allowed ? 'Yes' : 'No')
    if (edit.minBidCents !== undefined) add('Lowest bid', moneyWords(sa.minBidCents, cur), moneyWords(sb.minBidCents, cur))
    if (edit.maxBidCents !== undefined) add('Highest bid', moneyWords(sa.maxBidCents, cur), moneyWords(sb.maxBidCents, cur))
    if (edit.cpcMultiple !== undefined) add(CEILING_WORD, multipleWords(sa.cpcMultiple), multipleWords(sb.cpcMultiple))
    for (const part of PARTS) {
      if (edit.pins?.[part] === undefined) continue
      add(`${PART_WORD[part]} locked`, sa.pins[part] ? 'Locked' : 'Not locked', sb.pins[part] ? 'Locked' : 'Not locked')
    }
  }
  return out
}

/** "Save 3 changes" / "Save 1 change". */
export const saveWords = (n: number) => `Save ${n} ${n === 1 ? 'change' : 'changes'}`

// ── the writes ──────────────────────────────────────────────────────────────────────────────────────────

/** A drafted field, as the draft names it: the keys of CampaignEdit, and one per locked part. */
export type DraftField = 'allowed' | 'minBidCents' | 'maxBidCents' | 'cpcMultiple' | `pin:${Part}`

export type RequestKind = 'block' | 'bounds' | 'ceiling' | 'pins' | 'allow'

export interface CampaignRequest {
  kind: RequestKind
  what: string
  path: string
  body: Record<string, unknown>
  /** The drafted fields this request saves (they leave the draft when it succeeds). */
  fields: DraftField[]
}

/**
 * The PATCHes one campaign's edit needs, in the order they are sent: block automation first (a brake), then the bounds
 * (only the edited ones), the bid limit and the locks, and allowing automation last.
 */
export function requestsFor(row: CampaignRow, edit: CampaignEdit): CampaignRequest[] {
  const base = `/api/advertising/campaigns/${encodeURIComponent(row.id)}`
  const out: CampaignRequest[] = []
  if (edit.allowed === false) out.push({ kind: 'block', what: 'Automation may change it', path: `${base}/live-writes`, body: { enabled: false }, fields: ['allowed'] })
  const bounds: Record<string, number | null> = {}
  const boundFields: DraftField[] = []
  if (edit.minBidCents !== undefined) { bounds.minBidCents = edit.minBidCents; boundFields.push('minBidCents') }
  if (edit.maxBidCents !== undefined) { bounds.maxBidCents = edit.maxBidCents; boundFields.push('maxBidCents') }
  if (boundFields.length) {
    out.push({ kind: 'bounds', what: boundFields.length === 2 ? 'Lowest and highest bid' : boundFields[0] === 'minBidCents' ? 'Lowest bid' : 'Highest bid', path: `${base}/guardrails`, body: bounds, fields: boundFields })
  }
  if (edit.cpcMultiple !== undefined) {
    out.push({ kind: 'ceiling', what: CEILING_WORD, path: `${base}/cpc-ceiling`, body: edit.cpcMultiple == null ? { enabled: false } : { enabled: true, multiple: edit.cpcMultiple }, fields: ['cpcMultiple'] })
  }
  const pins = PARTS.filter((p) => edit.pins?.[p] !== undefined)
  if (pins.length) out.push({ kind: 'pins', what: 'Locked parts', path: `${base}/pins`, body: Object.fromEntries(pins.map((p) => [PIN_FIELD[p], edit.pins![p]])), fields: pins.map((p) => `pin:${p}` as const) })
  if (edit.allowed === true) out.push({ kind: 'allow', what: 'Automation may change it', path: `${base}/live-writes`, body: { enabled: true }, fields: ['allowed'] })
  return out
}

/** Why a request is NOT sent: allowing automation waits for every other change of that campaign to succeed. */
export function skipReason(req: CampaignRequest, earlierRefused: boolean): string | null {
  return req.kind === 'allow' && earlierRefused
    ? 'Not sent: another change for this campaign was refused, so automation stays off for it until you review again.'
    : null
}

/** The draft with the fields a successful request saved taken out (used when the list cannot be re-read after Save). */
export function dropSaved(draft: Draft, campaignId: string, fields: readonly DraftField[]): Draft {
  const edit = draft[campaignId]
  if (!edit) return draft
  const next: CampaignEdit = { ...edit, pins: edit.pins ? { ...edit.pins } : undefined }
  for (const f of fields) {
    if (f.startsWith('pin:')) { if (next.pins) delete next.pins[f.slice(4) as Part] } else delete next[f as Exclude<DraftField, `pin:${Part}`>]
  }
  if (next.pins && Object.keys(next.pins).length === 0) delete next.pins
  if (!next.pins) delete next.pins
  const out = { ...draft }
  if (Object.keys(next).length) out[campaignId] = next
  else delete out[campaignId]
  return out
}

/** A response body can carry a refusal with HTTP 200 (`ok: false`); both are read. */
export function refusalOf(status: number, body: unknown): string | null {
  const b = (body ?? {}) as { ok?: boolean; error?: string; message?: string }
  if (status >= 200 && status < 300 && b.ok !== false) return null
  return b.error ?? b.message ?? `Refused (${status}).`
}

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────

export type AllowedFilter = 'all' | 'yes' | 'no'
export type GapFilter = 'all' | 'no-min' | 'no-max' | 'no-bounds' | 'suppressed'
export type LockedFilter = 'all' | 'locked' | 'unlocked'

export interface CampaignFilter { search: string; market: string; allowed: AllowedFilter; gap: GapFilter; locked: LockedFilter }
export const NO_CAMPAIGN_FILTER: CampaignFilter = { search: '', market: 'all', allowed: 'all', gap: 'all', locked: 'all' }

export const ALLOWED_LABEL: Record<AllowedFilter, string> = { all: 'Automation: all', yes: 'May change it', no: 'May not change it' }
export const GAP_LABEL: Record<GapFilter, string> = {
  all: 'Any limits',
  'no-min': 'No lowest bid',
  'no-max': 'No highest bid',
  'no-bounds': 'No bid limits at all',
  suppressed: 'Bids held low',
}
export const LOCKED_LABEL: Record<LockedFilter, string> = { all: 'Locked: all', locked: 'Something locked', unlocked: 'Nothing locked' }

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
export const isAllowedFilter = (v: string): v is AllowedFilter => has(ALLOWED_LABEL, v)
export const isGapFilter = (v: string): v is GapFilter => has(GAP_LABEL, v)
export const isLockedFilter = (v: string): v is LockedFilter => has(LOCKED_LABEL, v)

/** Filters read the STORED values, so a row does not vanish from view while the person edits it. */
export function campaignMatches(row: CampaignRow, f: CampaignFilter): boolean {
  if (f.market !== 'all' && row.marketplace !== f.market) return false
  if (f.allowed !== 'all' && row.managed !== (f.allowed === 'yes')) return false
  if (f.gap === 'no-min' && row.minBidCents != null) return false
  if (f.gap === 'no-max' && row.maxBidCents != null) return false
  if (f.gap === 'no-bounds' && (row.minBidCents != null || row.maxBidCents != null)) return false
  if (f.gap === 'suppressed' && !row.suppressedAt) return false
  const anyLocked = PARTS.some((p) => row.pins[p])
  if (f.locked === 'locked' && !anyLocked) return false
  if (f.locked === 'unlocked' && anyLocked) return false
  const q = f.search.trim().toLowerCase()
  return !q || [row.name, row.marketplace ?? '', row.portfolioName ?? ''].some((t) => t.toLowerCase().includes(q))
}

export const isCampaignFiltered = (f: CampaignFilter) =>
  f.search.trim() !== '' || f.market !== 'all' || f.allowed !== 'all' || f.gap !== 'all' || f.locked !== 'all'

/** "Bids, budget" / "—". */
export const lockedWords = (pins: Record<Part, boolean>) => PARTS.filter((p) => pins[p]).map((p) => PART_WORD[p]).join(', ') || '—'

/** Who holds the bids low, in words: "automation:budget-enforce" → "budget-enforce". */
export const suppressedWords = (row: CampaignRow) =>
  row.suppressedAt ? `Held low by ${row.suppressedBy?.replace(/^automation:/, '') ?? 'an unknown engine'}` : '—'


/**
 * The draft checked again against fresh rows (after a save or a reload): what now equals the stored value leaves it
 * (it saved), what still differs stays (it was refused, or it was never sent), and a campaign that is gone drops out.
 */
export function retidy(draft: Draft, rowsById: ReadonlyMap<string, CampaignRow>): Draft {
  const out: Record<string, CampaignEdit> = {}
  for (const [id, edit] of Object.entries(draft)) {
    const row = rowsById.get(id)
    if (!row) continue
    const next = tidy(row, edit)
    if (next) out[id] = next
  }
  return out
}
