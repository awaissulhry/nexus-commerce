/**
 * Bid page, Bids view — a keyword's own goal and max bid (KEYWORD-AUTO.md). Pure, tested in Node (`goalModel.vitest.test.ts`).
 *
 * One source of truth: the brain's settings store, a VALUE override with ref `target:<AdTarget.id>` (keyword > campaign >
 * product). Saved through the brain's control route, one setting per call:
 *   POST /api/advertising/automation/brain/control
 *     { op: 'set-value', productId, market, campaignId, ref: 'target:<id>', key, value | reset: true, why, approve: true }
 * `approve: true` is the person's own one-click approval (a bid matter: no authenticator code). The brain obeys it on its
 * next tick (every 15 min); a max is never passed by the brain. Only where an engine runs the keyword (auto ≠ NONE).
 */
import { money } from '../_shared/format'
import { MAX_BID_CENTS, MIN_BID_CENTS, parseBid, type BidGoal, type BidGridRow } from './bidsModel'

export const GOAL_KEYS = ['targetAcosPct', 'maxBidCents', 'tosTargetPct'] as const
export type GoalKey = (typeof GOAL_KEYS)[number]

/** The brain's bounds (brain/levers.ts): a whole percent; the max in cents. */
export const GOAL_BOUNDS: Record<GoalKey, { min: number; max: number }> = {
  targetAcosPct: { min: 1, max: 300 },
  maxBidCents: { min: MIN_BID_CENTS, max: MAX_BID_CENTS },
  tosTargetPct: { min: 5, max: 95 },
}

export const GOAL_LABEL: Record<GoalKey, string> = { targetAcosPct: 'Target ACoS', maxBidCents: 'Max bid', tosTargetPct: 'Top of search' }

/** The editor's three boxes, as typed. */
export interface GoalDraft { acos: string; max: string; tos: string }

const pctText = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '')

export function draftOf(goal: BidGoal | null | undefined): GoalDraft {
  return {
    acos: pctText(goal?.acosPct),
    max: typeof goal?.maxCents === 'number' ? (goal.maxCents / 100).toFixed(2) : '',
    tos: pctText(goal?.tosPct),
  }
}

/** "20" or "20 %" → 20; "" → null; anything else → NaN. Whole percents only (the brain's settings are whole numbers). */
export function parsePct(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, '')
  if (t === '') return null
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

export type GoalValues = Record<GoalKey, number | null>

export function goalValuesOf(goal: BidGoal | null | undefined): GoalValues {
  return { targetAcosPct: goal?.acosPct ?? null, maxBidCents: goal?.maxCents ?? null, tosTargetPct: goal?.tosPct ?? null }
}

/** The typed values, and what is wrong with each (one sentence per box). */
export function parseGoal(draft: GoalDraft): { values: GoalValues; problems: Partial<Record<GoalKey, string>> } {
  const values: GoalValues = { targetAcosPct: parsePct(draft.acos), maxBidCents: parseBid(draft.max), tosTargetPct: parsePct(draft.tos) }
  const problems: Partial<Record<GoalKey, string>> = {}
  for (const key of GOAL_KEYS) {
    const v = values[key]
    if (v === null) continue
    const { min, max } = GOAL_BOUNDS[key]
    if (!Number.isFinite(v)) problems[key] = key === 'maxBidCents' ? 'Not a bid' : 'A whole percent'
    else if (v < min || v > max) problems[key] = key === 'maxBidCents' ? `From ${(min / 100).toFixed(2)} to ${(max / 100).toFixed(2)}` : `From ${min} to ${max} %`
  }
  return { values, problems }
}

/** A value in words: "20 %", "€0.80", "—". */
export function goalValueWords(key: GoalKey, v: number | null, currency: string): string {
  if (v === null) return '—'
  return key === 'maxBidCents' ? money(v, currency) : `${v} %`
}

/** The compact cell: "20 % · max €0.80", "max €0.80", "ToS 30 %", or a dash. */
export function goalText(goal: BidGoal | null | undefined, currency: string): string {
  if (!goal) return '—'
  const parts: string[] = []
  if (typeof goal.acosPct === 'number') parts.push(`${goal.acosPct} %`)
  if (typeof goal.maxCents === 'number') parts.push(`max ${money(goal.maxCents, currency)}`)
  if (typeof goal.tosPct === 'number') parts.push(`ToS ${goal.tosPct} %`)
  return parts.length ? parts.join(' · ') : '—'
}

export interface GoalChange { key: GoalKey; now: number | null; next: number | null }

/** The values that apply when the keyword has none of its own (its campaign's or product's, as the brain reads them). */
export type InheritedGoal = Partial<Record<'targetAcosPct' | 'tosTargetPct', number | null>>

/**
 * Does this change let the brain spend more (the review's tick, audit R9)? A max is a cap: setting, lowering or raising
 * one is never a raise — only taking it away is. A target ACoS or top-of-search share is a raise when it goes above what
 * applied before: the keyword's own value, else the inherited one; when neither is known, it is not called a raise.
 */
export function goalRaises(c: GoalChange, inherited: InheritedGoal = {}): boolean {
  if (c.key === 'maxBidCents') return c.next === null && c.now !== null
  const inh = inherited[c.key] ?? null
  if (c.next === null) return c.now !== null && inh !== null && inh > c.now
  const before = c.now ?? inh
  return before !== null && c.next > before
}

/** Only what changes, in the boxes' order. */
export function goalChanges(goal: BidGoal | null | undefined, values: GoalValues): GoalChange[] {
  const before = goalValuesOf(goal)
  return GOAL_KEYS.filter((k) => before[k] !== values[k]).map((k) => ({ key: k, now: before[k], next: values[k] }))
}

/** The brain's market for this keyword: its own, else the view's (a single market). */
export function goalMarket(row: Pick<BidGridRow, 'market'>, viewMarket: string | null | undefined): string | null {
  const own = row.market?.trim()
  if (own) return own.toUpperCase()
  const v = viewMarket?.trim()
  return v && v.toLowerCase() !== 'all' ? v.toUpperCase() : null
}

/** Why this person may not set this keyword's goal here, or null. Honest when no engine runs it. */
export function goalHeld(row: Pick<BidGridRow, 'auto' | 'autoWhy' | 'brainProductId' | 'market' | 'bidNow'>, viewMarket: string | null | undefined, can: boolean): string | null {
  if (row.auto === 'NONE') return row.autoWhy?.trim() || 'No engine runs this campaign'
  if (!can) return 'Needs the ads automation permission'
  if (typeof row.bidNow !== 'number') return 'Bids are hidden for you'
  if (!row.brainProductId) return 'The brain that runs this keyword is not known'
  if (!goalMarket(row, viewMarket)) return 'Pick a market first'
  return null
}

export interface GoalBody {
  op: 'set-value'
  productId: string
  market: string
  campaignId: string
  ref: string
  key: GoalKey
  value?: number
  reset?: true
  why: string
  approve: true
}

/** One setting's call: its value, or `reset` to clear the keyword's own value (the campaign's or product's applies). */
export function goalBody(row: Pick<BidGridRow, 'targetId' | 'campaign' | 'brainProductId' | 'market' | 'text'>, change: Pick<GoalChange, 'key' | 'next'>, viewMarket: string | null | undefined): GoalBody | null {
  const market = goalMarket(row, viewMarket)
  if (!row.brainProductId || !market) return null
  const base = {
    op: 'set-value' as const, productId: row.brainProductId, market, campaignId: row.campaign.id, ref: `target:${row.targetId}`,
    key: change.key, why: `Bid page: ${GOAL_LABEL[change.key]} for ${row.text}`, approve: true as const,
  }
  return change.next === null ? { ...base, reset: true } : { ...base, value: change.next }
}

/** What the brain's answer says about one saved setting: ok, its words, and the warnings it carried. */
export function goalResult(status: number, body: unknown): { ok: boolean; words: string; warnings: string[] } {
  const b = (body ?? {}) as { error?: unknown; status?: unknown; approve?: { ok?: boolean; error?: unknown }; preview?: { warnings?: unknown } }
  const warnings = Array.isArray(b.preview?.warnings) ? (b.preview!.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : []
  if (status >= 400) return { ok: false, words: typeof b.error === 'string' && b.error ? b.error : `HTTP ${status}`, warnings }
  if (b.approve && b.approve.ok === false) return { ok: false, words: typeof b.approve.error === 'string' && b.approve.error ? b.approve.error : 'Waits for approval', warnings }
  return { ok: true, words: b.status === 'scheduled' || b.status === 'executed' ? 'Saved' : 'Waits for approval', warnings }
}
