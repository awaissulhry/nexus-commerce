/**
 * Grid audit wave 3 (Owner 2026-10-13, the PSIE shape) — the Publish review as ONE table, one row per change.
 *
 * Pure rules (no React) for `ReviewTable`: the rows, the filter, the counts of the summary strip and the words of a
 * value. The same table serves "All markets" (every chosen market, a Where column) and one market's tab. Before, a market
 * tab listed one row per product ("3 of 5 fields · 1 replaces an Amazon value") and its fields, their values and what the
 * channel holds sat behind a per-row "Show fields" (audit D3); values were cut at 120 characters (D6).
 *
 * A product's row (the plan's `ActionPlanRow`: what it does, its tick, why nothing is sent) is followed by its own rows:
 * one per field that changes (Channel now → Nexus sends, ticked one by one), and on a Full update, one per value the
 * channel loses ("Will be removed", whole). The review's problems are rows of the same table, first.
 */
import { isPhotoChangeId, type StudioPublishChange, type StudioPublishIssue, type StudioPublishRemoval, type StudioPublishReview, type StudioPublishValue } from '@nexus/shared/studio-publication'
import type { Tone } from '@/design-system/primitives/tone'
import type { ActionPlanRow } from './actionPlan'
import { destinationStateLabel, type DestinationState } from './destinations'
import { publicationProblems } from './model'

export interface ReviewMarketRef {
  /** The destination key (one per market or listing alias). */
  key: string
  /** "Amazon · IT", "eBay · IT · ① Racing edition". */
  label: string
}

/** A market that has not reached a review the table can list (checking, could not be read, expired, needs a choice). */
export interface ReviewMarketState {
  tone: Tone
  text: string
  /** What the row offers: check the market again, or open its tab (a choice only its tab holds). */
  action?: 'check' | 'open'
}

export interface ReviewTableMarket extends ReviewMarketRef {
  rows: ActionPlanRow[]
  review: Pick<StudioPublishReview, 'id' | 'changes' | 'removals' | 'photosOnly' | 'issues'> | null
  selectedIds: readonly string[]
  lifecycleIds: readonly string[]
  /** Set when the market has nothing the table can list yet, or needs something only its tab offers. */
  state?: ReviewMarketState | null
}

export type ReviewTableRow =
  | { type: 'state'; key: string; market: ReviewMarketRef; state: ReviewMarketState }
  | { type: 'problem'; key: string; market: ReviewMarketRef; sku: string; message: string; detail: string | null }
  | { type: 'plan'; key: string; market: ReviewMarketRef; row: ActionPlanRow }
  | { type: 'field'; key: string; market: ReviewMarketRef; row: ActionPlanRow; change: StudioPublishChange }
  | { type: 'removal'; key: string; market: ReviewMarketRef; row: ActionPlanRow; label: string; value: string }

export type ReviewFilter = 'all' | 'problems' | 'deletes'

const isFull = (row: ActionPlanRow) => row.what.column === 'send' && row.what.mode === 'full'

/** A field that changes: not one the channel already holds as Nexus does. */
const changing = (change: StudioPublishChange) => change.status !== 'SAME'

/** The rows of the table, problems first in each market, then each product's row followed by its own rows. */
export function reviewTableRows(markets: readonly ReviewTableMarket[], filter: ReviewFilter = 'all'): ReviewTableRow[] {
  const out: ReviewTableRow[] = []
  for (const m of markets) {
    const market = { key: m.key, label: m.label }
    if (m.state) out.push({ type: 'state', key: `${m.key}|state`, market, state: m.state })
    const { problems } = publicationProblems((m.review?.issues ?? []) as StudioPublishIssue[])
    for (const p of problems) out.push({ type: 'problem', key: `${m.key}|problem|${p.id}`, market, sku: p.sku, message: p.message, detail: p.detail ?? null })
    for (const row of m.rows) {
      const own: ReviewTableRow[] = []
      if (row.kind === 'content' && !row.notSent && row.what.column === 'send') {
        for (const change of (m.review?.changes ?? []).filter(c => c.productId === row.productId && changing(c))) {
          own.push({ type: 'field', key: `${m.key}|field|${change.id}`, market, row, change })
        }
        if (isFull(row)) {
          (m.review?.removals ?? []).filter(r => r.productId === row.productId).forEach((removal: StudioPublishRemoval, at) => {
            own.push({ type: 'removal', key: `${m.key}|removal|${row.productId}|${at}`, market, row, label: removal.label, value: valueText({ state: 'value', value: removal.value }) })
          })
        }
      }
      if (filter === 'problems' && !row.notSent) continue
      if (filter === 'deletes') {
        const removals = own.filter(r => r.type === 'removal')
        if (!row.danger && !removals.length) continue
        out.push({ type: 'plan', key: `${m.key}|plan|${row.key}`, market, row }, ...removals)
        continue
      }
      out.push({ type: 'plan', key: `${m.key}|plan|${row.key}`, market, row }, ...(filter === 'problems' ? [] : own))
    }
  }
  if (filter === 'problems') return out.filter(r => r.type !== 'field' && r.type !== 'removal')
  if (filter === 'deletes') return out.filter(r => r.type === 'plan' || r.type === 'removal' || r.type === 'state')
  return out
}

export interface ReviewCounts {
  /** Markets with a review the table lists. */
  markets: number
  /** Listings that send something (a product's content, or a Status change or Delete). */
  listings: number
  /** Changes that go: ticked fields (every field of a row sent whole) and ticked Status changes or Deletes. */
  changes: number
  problems: number
  /** What a send deletes: ticked Deletes and moves, and the values a sent Full update removes. */
  deletes: number
}

const sends = (row: ActionPlanRow) => !row.notSent && (row.tick === 'on' || row.tick === 'some' || row.tick === 'whole')

export function reviewCounts(markets: readonly ReviewTableMarket[]): ReviewCounts {
  const counts: ReviewCounts = { markets: 0, listings: 0, changes: 0, problems: 0, deletes: 0 }
  for (const m of markets) {
    if (m.rows.length || m.review) counts.markets += 1
    counts.problems += publicationProblems((m.review?.issues ?? []) as StudioPublishIssue[]).problems.length
    for (const row of m.rows) {
      if (!sends(row)) continue
      counts.listings += 1
      if (row.kind === 'lifecycle') {
        counts.changes += 1
        if (row.action === 'delete') counts.deletes += 1
        continue
      }
      if (row.what.column === 'move') counts.deletes += 1
      const fields = (m.review?.changes ?? []).filter(c => c.productId === row.productId && changing(c))
      counts.changes += row.tick === 'some' || (row.tick === 'on' && !isFull(row)) ? row.fields.ticked : Math.max(fields.length, 1)
      if (isFull(row)) counts.deletes += (m.review?.removals ?? []).filter(r => r.productId === row.productId).length
    }
  }
  return counts
}

/** A field's tick: on, and whether the person can change it (a Full update's fields follow their row's tick). */
export function fieldTick(row: ActionPlanRow, change: StudioPublishChange, opts: { selectedIds: readonly string[]; locked: boolean; reviewId: string | null | undefined; photosOnly?: boolean }): { on: boolean; enabled: boolean } {
  if (change.locked || isFull(row)) return { on: row.tick === 'on' || row.tick === 'whole', enabled: false }
  const blocked = !!opts.photosOnly && !isPhotoChangeId(change.id)
  return { on: opts.selectedIds.includes(change.id), enabled: change.selectable && !blocked && !opts.locked && !!opts.reviewId && !row.notSent }
}

/** One field's two values, as the table shows them: what the channel has now, and what Publish sends. */
export function fieldValues(change: StudioPublishChange): { now: string; sends: string } {
  if (change.display) return { now: change.display.channel, sends: change.display.current }
  return { now: valueText(change.channel), sends: change.operation === 'delete' ? 'Removed' : valueText(change.current) }
}

/** "Changed in Nexus" · "Differs on channel" · "Cannot compare", with its tone (the words of the field list before). */
export function fieldStatus(change: Pick<StudioPublishChange, 'status'>): { label: string; tone: Tone } {
  if (change.status === 'DIFFERS') return { label: 'Differs on channel', tone: 'warning' }
  if (change.status === 'CANNOT_COMPARE') return { label: 'Cannot compare', tone: 'neutral' }
  return { label: 'Changed in Nexus', tone: 'info' }
}

/**
 * A value in words, WHOLE (audit D6: a value the channel loses was cut at 120 characters, the rest nowhere): text as it is,
 * a list one item per line, an object one "key: value" per line. Never raw JSON with its braces and quotes (D4).
 */
export function valueText(value: StudioPublishValue): string {
  if (value.state === 'unknown') return `Unknown — ${value.reason}`
  if (value.state === 'absent') return 'Not set'
  return plainValue(value.value)
}

function plainValue(value: unknown): string {
  if (value === null || value === undefined) return 'Empty'
  if (typeof value === 'string') return value.trim() === '' ? '(empty text)' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (!value.length) return 'Empty list'
    return value.map(item => `• ${inline(item)}`).join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return 'Empty'
    return entries.map(([key, item]) => `${key}: ${inline(item)}`).join('\n')
  }
  return String(value)
}

/** One item on one line: a nested list or object reads "a, b" / "key: value; key: value". */
function inline(value: unknown): string {
  if (value === null || value === undefined) return 'Empty'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(inline).join(', ')
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${inline(v)}`).join('; ')
  return String(value)
}

/**
 * A market's row in "All markets" when it has nothing the table can list yet or needs something only its tab offers —
 * null when it is ready, has nothing to send, or its problems are rows of their own. "Check again" for a review that
 * failed or expired; "Open" for a choice its tab holds (an inventory location, the overwrite confirmation, a skipped
 * exact request, an earlier publish still waiting).
 */
export function marketStateRow(state: DestinationState): ReviewMarketState | null {
  const said = destinationStateLabel(state)
  const text = `${said.label}. ${said.hint}`
  switch (state.kind) {
    case 'checking': case 'not_checked': return { tone: said.tone, text }
    case 'error': return { tone: 'danger', text: `${said.label}: ${state.message}`, action: 'check' }
    case 'expired': return { tone: said.tone, text, action: 'check' }
    case 'blocked': return state.problems && !state.request ? null : { tone: said.tone, text, action: 'open' }
    case 'earlier': case 'input': return { tone: said.tone, text, action: 'open' }
    default: return null
  }
}
