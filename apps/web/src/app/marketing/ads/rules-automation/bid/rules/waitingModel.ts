/**
 * Bid page, a rule's "Waiting" tab (2026-10-10) — the asks a rule at Ask me left for a person, decided on the Bid page.
 * Pure, tested in Node.
 *
 * Read: GET /api/advertising/suggestions?status=pending (the Suggestions page's own list; it has no rule filter, so the
 * rule's asks are cut here) and, for who sets each bid, GET /api/advertising/bids?campaignId=. Decided: POST
 * /api/advertising/suggestions/bulk (`apply` / `dismiss`, a result per ask). Undone: approved asks through
 * POST /api/advertising/bid-rules/:id/asks/undo { suggestionIds } (audit R4: the old bids go back as the RULE's undo — not
 * a person's bid — and the asks wait again); while the server has no such route, an approval offers no Undo (never the
 * old person-bid undo). A rejected ask back to waiting (`restore`).
 *
 * What the server does with an approval decides what the tab offers (ads-suggestion-decide.service.ts applySuggestion):
 *   · a rule that is Off, archived or edited since → refused ("the rule no longer stands behind it");
 *   · ads automation halted → refused;
 *   · a campaign the Brain owns → stored as the Brain's input for 7 days, not written (BB-9) — said on the row;
 *   · the Brain's bids stopped there (the Owner's kill switch) → nothing would change: Approve is held, Reject stays.
 */
import type { ReviewChange, ReviewResult } from '@/design-system/patterns'
import { periodWord, relWords } from '../_shared/format'
import { holdWord, marketMoney, plural, type BidRuleRow, type Ref } from './bidRulesModel'

// ── the API's shapes ────────────────────────────────────────────────────────────────────────────────────────────────

/** One row of GET /api/advertising/suggestions, the fields the tab reads. */
export interface WaitingSuggestion {
  id: string
  ruleId: string
  status: string
  entityType: string
  entityId: string
  entityName: string | null
  marketplace: string | null
  proposedAction: { type?: string; op?: string; value?: number; wouldChange?: string } | null
  createdAt: string
  lastSeenAt?: string | null
  source?: {
    href?: string | null; label?: string; keyword?: string; matchType?: string
    campaignId?: string; campaignName?: string; adGroupId?: string; adGroupName?: string
  } | null
  metrics?: { windowDays: number; clicks: number; orders: number; acos: number | null } | null
  current?: { bidCents?: number | null; entityStatus?: string | null } | null
  suggested?: { bidCents?: number | null } | null
  /** Applied rows: the Change-Log handle the rollback service takes. */
  undo?: { actionLogId: string; rolledBack: boolean } | null
}

/** Who sets one bid now (GET /api/advertising/bids → owner): only what the tab needs. */
export interface BidOwnerInfo { kind: string; name: string }

// ── one ask, in the page's words ────────────────────────────────────────────────────────────────────────────────────

export type AskGate = 'brain' | 'brainStopped' | null

export interface WaitingAsk {
  id: string
  keyword: string
  /** "Exact", "Phrase", "Broad", "Auto" — null when the ask is not on a keyword. */
  match: string | null
  campaign: Ref | null
  adGroup: Ref | null
  /** What changes ("Bid", "State") and its now → proposed, in the market's money. */
  what: string
  now: string
  next: string
  /** The ask's own numbers in a few words ("30 orders · ACoS 5 %", "120 clicks · 0 orders"), and their window. */
  reason: string
  /** "2 d ago": when it was first asked ("ago", as every time on the page, audit R19); when it expires if no run asks it
   *  again (null: unknown). */
  age: string
  expires: string | null
  gate: AskGate
  /** Why Approve is not offered for this ask (Reject always is); null = it may be approved. */
  held: string | null
}

const MATCH_WORD: Readonly<Record<string, string>> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad', AUTO: 'Auto', TARGETING_EXPRESSION: 'Product', NEGATIVE_EXACT: 'Neg. exact', NEGATIVE_PHRASE: 'Neg. phrase' }
export const matchWord = (m: string | null | undefined): string | null => (m ? MATCH_WORD[m.toUpperCase()] ?? m.charAt(0) + m.slice(1).toLowerCase() : null)

const campaignHref = (id: string) => `/marketing/ads/campaigns/${encodeURIComponent(id)}`
const adGroupHref = (campaignId: string, id: string) => `${campaignHref(campaignId)}/ad-groups/${encodeURIComponent(id)}`

/** A card's own "60¢ → 66¢" (the handler's dry run when it asked). */
export function parseCents(v: unknown): { from: number; to: number } | null {
  if (typeof v !== 'string') return null
  const m = /(-?\d+(?:\.\d+)?)\s*¢\s*→\s*(-?\d+(?:\.\d+)?)\s*¢/.exec(v)
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null
}

const STATE_OF: Readonly<Record<string, string>> = { pause_target: 'Paused', enable_target: 'On' }

/** What the ask changes: a bid (from the server's current and suggested bid, else the card's own words) or a state. */
export function askChange(s: WaitingSuggestion, market: string | null): { what: string; now: string; next: string } {
  const type = s.proposedAction?.type ?? ''
  if (STATE_OF[type]) return { what: 'State', now: s.current?.entityStatus === 'PAUSED' ? 'Paused' : 'On', next: STATE_OF[type] }
  const card = parseCents(s.proposedAction?.wouldChange)
  const now = s.current?.bidCents ?? card?.from ?? null
  const next = s.suggested?.bidCents ?? card?.to ?? null
  return { what: 'Bid', now: marketMoney(now, market), next: marketMoney(next, market) }
}

/** The ask's numbers in a few words: orders and ACoS when it sold, clicks and no orders when it did not. */
export function askReason(m: WaitingSuggestion['metrics']): string {
  if (!m) return 'No data'
  const days = periodWord(m.windowDays)
  if (m.orders > 0) return `${plural(m.orders, 'order')} · ACoS ${m.acos == null ? '—' : `${Math.round(m.acos * 1000) / 10} %`} · ${days}`
  return `${plural(m.clicks, 'click')} · 0 orders · ${days}`
}

// ── expiry (mirrors ads-suggestions.service.ts expiryWindowMs) ──────────────────────────────────────────────────────

const DAY_MS = 86_400_000
export const DEFAULT_EXPIRE_MS = 3 * DAY_MS

/** How long an ask may go un-asked before it expires: 3 days, or twice a scheduled rule's interval when that is longer. */
export function expiryWindowMs(actions: unknown): number {
  let interval = 0
  for (const a of Array.isArray(actions) ? (actions as Array<Record<string, unknown>>) : []) {
    const s = a?.schedule as { frequency?: string; everyN?: number | string; interval?: string } | undefined
    if (!s?.frequency) continue
    const f = String(s.frequency).toLowerCase()
    let ms = f === 'hourly' ? 3_600_000 : f === 'daily' ? DAY_MS : f === 'weekly' ? 7 * DAY_MS : f === 'monthly' ? 30 * DAY_MS : 0
    if (f === 'custom') {
      const n = Math.max(1, Number(s.everyN) || 1)
      const unit = String(s.interval ?? 'Days').toLowerCase()
      ms = n * (unit === 'months' ? 30 * DAY_MS : unit === 'weeks' ? 7 * DAY_MS : DAY_MS)
    }
    interval = Math.max(interval, ms)
  }
  return Math.max(DEFAULT_EXPIRE_MS, 2 * interval)
}

// ── what holds Approve ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why no ask of this rule may be approved now (the server would refuse every one), or null. A stop of the Brain's bids is
 * not one of these: it holds only the asks on its campaigns (`gateOf`), never the rule's others.
 */
export function ruleApproveHeld(row: Pick<BidRuleRow, 'archived' | 'mode'>, decideHeld: string | null): string | null {
  if (decideHeld) return decideHeld
  if (row.archived) return 'Archived: restore the rule first'
  if (row.mode.set === 'OFF') return 'The rule is Off: switch it on first'
  const h = row.mode.heldBy
  if (h?.kind === 'stopped' && !/brain/i.test(h.label)) return `${holdWord(h.label)}: nothing can be approved now`
  return null
}

/** What happens to an ask on its campaign: the Brain owns it (an input), or the Brain's bids are stopped there. */
export function gateOf(owner: BidOwnerInfo | null | undefined): AskGate {
  if (!owner || owner.kind !== 'BRAIN') return null
  return /stopped/i.test(owner.name) ? 'brainStopped' : 'brain'
}

export const GATE_WORD: Readonly<Record<Exclude<AskGate, null>, string>> = { brain: 'Brain decides', brainStopped: 'Brain off' }
export const GATE_MEANS: Readonly<Record<Exclude<AskGate, null>, string>> = {
  brain: 'The Brain runs this campaign: approving passes this ask to the Brain for 7 days, and the Brain sets the bid.',
  brainStopped: 'You stopped the Brain’s bids on this campaign: approving would change nothing.',
}

export interface AskContext {
  market: string | null
  /** Who sets each bid, by target id (the bids API); absent = not known. */
  owners: ReadonlyMap<string, BidOwnerInfo>
  /** Why the rule's asks cannot be approved at all (ruleApproveHeld). */
  ruleHeld: string | null
  expiryMs: number
  now: number
}

export function askOf(s: WaitingSuggestion, c: AskContext): WaitingAsk {
  const src = s.source ?? {}
  const campaign = src.campaignId ? { id: src.campaignId, name: src.campaignName ?? src.campaignId, href: campaignHref(src.campaignId) } : null
  const adGroup = src.adGroupId && src.campaignId ? { id: src.adGroupId, name: src.adGroupName ?? src.adGroupId, href: adGroupHref(src.campaignId, src.adGroupId) } : null
  const gate = s.entityType === 'AD_TARGET' ? gateOf(c.owners.get(s.entityId)) : null
  const change = askChange(s, s.marketplace ?? c.market)
  const seen = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : NaN
  return {
    id: s.id,
    keyword: src.keyword ?? s.entityName ?? src.label ?? s.entityId,
    match: matchWord(src.matchType),
    campaign,
    adGroup,
    ...change,
    reason: askReason(s.metrics),
    age: relWords(s.createdAt, c.now),
    expires: !Number.isFinite(seen) ? null : seen + c.expiryMs <= c.now ? 'now' : relWords(new Date(seen + c.expiryMs).toISOString(), c.now),
    gate,
    held: c.ruleHeld ?? (gate === 'brainStopped' ? GATE_MEANS.brainStopped : null),
  }
}

/** The rule's waiting asks, newest first. `capped`: the list the page read was cut at the server's limit. */
export function waitingOf(items: readonly WaitingSuggestion[], ruleId: string): WaitingSuggestion[] {
  return items.filter((s) => s.ruleId === ruleId && s.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ── selection ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The server has no such route (Fastify's own 404), as opposed to a refusal from a route that is there. */
export function routeMissing(status: number, body: unknown): boolean {
  if (status !== 404) return false
  const m = body && typeof body === 'object' ? (body as { message?: unknown }).message : null
  return typeof m === 'string' && /^Route .+ not found/i.test(m)
}

/**
 * Undo of approvals — POST /bid-rules/:id/asks/undo → `{ results: [{ suggestionId, restored, reopened, reason }], undone,
 * reopened }`: a result per ask, in the server's words. `restored`: the value is back as the rule's undo (or the approval
 * had changed nothing); `reopened`: the ask waits again; `reason`: why not, or what else happened, in one line. A refused
 * ask (not restored) keeps its own reason on the Done screen.
 */
export interface AskUndoItem { suggestionId?: unknown; id?: unknown; restored?: unknown; reopened?: unknown; reason?: unknown }
export function askUndoResults(ids: readonly string[], body: unknown): Record<string, ReviewResult> {
  const b = (body && typeof body === 'object' ? body : {}) as { results?: unknown }
  const list = Array.isArray(b.results) ? (b.results as AskUndoItem[]) : []
  const out: Record<string, ReviewResult> = {}
  for (const id of ids) {
    const r = list.find((x) => x.suggestionId === id || x.id === id)
    const reason = r && typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().replace(/\.$/, '') : null
    if (!r) out[id] = { ok: false, words: 'No answer for this ask', verb: 'undone' }
    else if (r.restored !== true) out[id] = { ok: false, words: reason ?? 'Not undone', verb: 'undone' }
    else if (r.reopened === true) out[id] = { ok: true, words: reason ? `Undone: waiting again. ${reason}` : 'Undone: waiting again' }
    else out[id] = { ok: true, words: reason ? `Undone: ${reason}` : 'Undone' }
  }
  return out
}

/** The bulk route takes at most 200 decisions in one call. */
export const BULK_MAX = 200
export function chunks<T>(list: readonly T[], size = BULK_MAX): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Keep only ids still on the list (after a reload some asks are gone). */
export const keepSelected = (selected: ReadonlySet<string>, asks: readonly WaitingAsk[]): Set<string> =>
  new Set(asks.filter((a) => selected.has(a.id)).map((a) => a.id))

/** What the two buttons do with the ticked asks: Approve takes the ones that may be approved, Reject every one. */
export function decideCounts(asks: readonly WaitingAsk[], selected: ReadonlySet<string>): { approve: WaitingAsk[]; reject: WaitingAsk[]; held: WaitingAsk[] } {
  const ticked = asks.filter((a) => selected.has(a.id))
  return { approve: ticked.filter((a) => !a.held), reject: ticked, held: ticked.filter((a) => !!a.held) }
}

/** Why a button is held, or null. */
export function approveHeld(c: ReturnType<typeof decideCounts>, decideHeld: string | null): string | null {
  if (decideHeld) return decideHeld
  if (!c.reject.length) return 'Tick at least one ask'
  if (!c.approve.length) return c.held[0]?.held ?? 'None of these can be approved'
  return null
}
export function rejectHeld(c: ReturnType<typeof decideCounts>, decideHeld: string | null): string | null {
  if (decideHeld) return decideHeld
  return c.reject.length ? null : 'Tick at least one ask'
}

// ── the review ──────────────────────────────────────────────────────────────────────────────────────────────────────

const whereOf = (a: WaitingAsk) => [a.keyword, a.campaign?.name].filter(Boolean).join(' · ')

/** Approve: one line per ask, now → proposed; an ask on the Brain's campaign says it becomes the Brain's input. */
export function approveChanges(asks: readonly WaitingAsk[]): ReviewChange[] {
  return asks.map((a) => ({
    id: a.id, where: whereOf(a), what: a.what, now: a.now, next: a.next,
    ...(a.gate === 'brain' ? { note: 'Brain decides: passed to it for 7 days' } : {}),
  }))
}

/** Reject: one line per ask; it leaves the waiting list (Undo puts it back). */
export function rejectChanges(asks: readonly WaitingAsk[]): ReviewChange[] {
  return asks.map((a) => ({ id: a.id, where: whereOf(a), what: 'Ask', now: `${a.now} → ${a.next}`, next: 'Rejected' }))
}

/** The counted buttons: "Approve 3", "Reject 1"; with nothing ticked just the verb (held, it says why). */
export const approveLabel = (n: number): string => (n > 0 ? `Approve ${n}` : 'Approve')
export const rejectLabel = (n: number): string => (n > 0 ? `Reject ${n}` : 'Reject')

export interface BulkResult { id: string; kind: string; ok: boolean; refused?: boolean; error?: string }

/** The bulk answer as the Done step's results, in the server's words. An ask the answer did not name is said so. */
export function decideResults(ids: readonly string[], results: readonly BulkResult[], kind: 'apply' | 'dismiss', gates: ReadonlyMap<string, AskGate> = new Map()): Record<string, ReviewResult> {
  const byId = new Map(results.map((r) => [r.id, r]))
  const out: Record<string, ReviewResult> = {}
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) { out[id] = { ok: false, words: 'No answer for this ask' }; continue }
    if (r.ok) out[id] = { ok: true, words: kind === 'dismiss' ? 'Rejected' : gates.get(id) === 'brain' ? 'Passed to the Brain' : 'Approved' }
    else out[id] = { ok: false, words: r.error ? (r.refused ? `Refused: ${r.error}` : r.error) : 'Not decided' }
  }
  return out
}
