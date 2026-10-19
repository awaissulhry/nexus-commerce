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
import { SELLING_STATE_LABEL, STATUS_TARGET_LABEL } from '@nexus/shared/listing-actions'
import { blockedChanges, leftOutReason, type StudioPublishChange, type StudioPublishIssue, type StudioPublishRemoval, type StudioPublishReview, type StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublishStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import type { Tone } from '@/design-system/primitives/tone'
import { plainValue } from '@/design-system/lib/format'
import { addTallies, rowSends, sendTally, type ActionPlanRow } from './actionPlan'
import { destinationStateLabel, isSparse, stateLine, type DestinationState } from './destinations'
import { problemGroups, publicationProblems } from './model'

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
  review: (Pick<StudioPublishReview, 'id' | 'scope' | 'rows' | 'changes' | 'removals' | 'issues'> & Partial<Pick<StudioPublishReview, 'sendsWhole'>>) | null
  selectedIds: readonly string[]
  lifecycleIds: readonly string[]
  /** Set when the market has nothing the table can list yet, or needs something only its tab offers. */
  state?: ReviewMarketState | null
  /** After the send: each row that went, with its real result (`planRowResults`). Absent until something is sent. */
  results?: ReadonlyMap<string, PublishStatusMeta> | null
  /** The sheet behind the window shows this market: a problem that names a product offers "Show in sheet". */
  inSheet?: boolean
}

export type ReviewTableRow =
  | { type: 'state'; key: string; market: ReviewMarketRef; state: ReviewMarketState }
  /**
   * One problem, with every SKU it is on: the same "Item package height is required" on 20 SKUs is ONE row to fix. The
   * product (and field) it names first is where the sheet lands; `holds` says what it keeps from this send.
   */
  | { type: 'problem'; key: string; market: ReviewMarketRef; skus: string[]; message: string; detail: string | null; productId: string | null; field: string | null; holds: string }
  /** "All markets": the market's notes (warnings) in one quiet row; they block nothing and must be seen. */
  | { type: 'note'; key: string; market: ReviewMarketRef; notes: string[] }
  | { type: 'plan'; key: string; market: ReviewMarketRef; row: ActionPlanRow }
  | { type: 'field'; key: string; market: ReviewMarketRef; row: ActionPlanRow; change: StudioPublishChange }
  | { type: 'removal'; key: string; market: ReviewMarketRef; row: ActionPlanRow; label: string; value: string }

/** All rows; only the problems to fix; or what a send removes (Delete, End, a move's old SKU, a Full update's values). */
export type ReviewFilter = 'all' | 'problems' | 'removes'

const isFull = (row: ActionPlanRow) => row.what.column === 'send' && row.what.mode === 'full'

/** A field that changes: not one the channel already holds as Nexus does. */
const changing = (change: StudioPublishChange) => change.status !== 'SAME'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** An error that names no field and no product: it holds back the whole destination's content. */
const namesNothing = (issue: StudioPublishIssue) => issue.severity === 'error' && !issue.field && !issue.productId

/**
 * What one problem keeps from this send, for its "Nexus sends" cell. On a kept change-only review (option A, Owner
 * 2026-10-19) a problem leaves out only the changes that would send its field; anywhere else (a whole product, a review
 * that cannot be sent, a problem that names nothing) it holds back the content of the destination.
 */
function problemHolds(review: ReviewTableMarket['review'], issues: readonly StudioPublishIssue[]): string {
  const kept = !!review?.id && isSparse(review)
  if (!kept || issues.some(namesNothing)) return 'Holds back the content here until it is fixed.'
  const left = blockedChanges(review)
  const mine = new Set(issues)
  const n = (review?.changes ?? []).filter(change => changing(change) && mine.has(left.get(change.id)!)).length
  return n ? `Leaves out ${plural(n, 'change', 'changes')} until it is fixed.` : 'Blocks nothing this publish sends.'
}

/**
 * The rows of the table, problems first in each market, then each product's row followed by its own rows. `notes`
 * ("All markets"): one quiet row per market with its notes — a market tab shows them in its own open fold.
 */
export function reviewTableRows(markets: readonly ReviewTableMarket[], filter: ReviewFilter = 'all', opts: { notes?: boolean } = {}): ReviewTableRow[] {
  const out: ReviewTableRow[] = []
  for (const m of markets) {
    const market = { key: m.key, label: m.label }
    if (m.state && filter === 'all') out.push({ type: 'state', key: `${m.key}|state`, market, state: m.state })
    if (filter !== 'removes') {
      for (const p of problemGroups(m.review?.issues ?? [])) {
        out.push({ type: 'problem', key: `${m.key}|problem|${p.id}`, market, skus: p.skus, message: p.message, detail: p.detail, productId: p.productId, field: p.field,
          holds: problemHolds(m.review, p.issues) })
      }
    }
    // The Problems filter lists the problems to fix — nothing else, so its count is its rows.
    if (filter === 'problems') continue
    const notes = opts.notes && filter === 'all' ? publicationProblems(m.review?.issues ?? []).notes : []
    if (notes.length) out.push({ type: 'note', key: `${m.key}|notes`, market, notes })
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
      if (filter === 'removes') {
        const removals = own.filter(r => r.type === 'removal')
        if (!row.danger && !removals.length) continue
        out.push({ type: 'plan', key: `${m.key}|plan|${row.key}`, market, row }, ...removals)
        continue
      }
      out.push({ type: 'plan', key: `${m.key}|plan|${row.key}`, market, row }, ...own)
    }
  }
  return out
}

/** Where a problem's "Show in sheet" lands: its product (and field) on the sheet's own market; null where the sheet cannot land. */
export function showInSheetTarget(row: Extract<ReviewTableRow, { type: 'problem' }>, market: Pick<ReviewTableMarket, 'inSheet'> | undefined): { productId: string; field: string | null } | null {
  if (!market?.inSheet || !row.productId) return null
  return { productId: row.productId, field: row.field }
}

/**
 * The table's pages (grid audit wave 3): about `size` rows each, the Owner's rows-per-page shape (the page scrolls, the
 * grid is the page of rows). A product's row and its own rows are never split across two pages.
 */
export function reviewPages(rows: readonly ReviewTableRow[], size = 100): ReviewTableRow[][] {
  const groups: ReviewTableRow[][] = []
  for (const row of rows) {
    if ((row.type === 'field' || row.type === 'removal') && groups.length) groups[groups.length - 1].push(row)
    else groups.push([row])
  }
  const pages: ReviewTableRow[][] = []
  let page: ReviewTableRow[] = []
  for (const group of groups) {
    if (page.length && page.length + group.length > size) { pages.push(page); page = [] }
    page.push(...group)
  }
  if (page.length) pages.push(page)
  return pages
}

/**
 * The tiles over "All markets" and the filters' numbers, counted the window's ONE way: what goes from `sendTally` (the
 * same count as the summary line and the button), problems as distinct problems (`problemGroups`, the table's rows).
 */
export interface ReviewCounts {
  /** Markets with a review the table lists. */
  markets: number
  /** Listings that send something (a product's content, or a Status change or Delete). */
  listings: number
  /** Ticked fields that go (a Full update's every field) and ticked Active or Inactive status changes. */
  changes: number
  /** Distinct problems (one per message and market: the table's problem rows), and the SKUs they are on. */
  problems: number
  problemSkus: number
  /** What a send removes, ticked: listings ended or deleted (a move deletes its old SKU), and values a Full update removes. */
  removedListings: number
  removedValues: number
  /** What the Removes filter lists, ticked or not: Delete, End and move rows, and every value a Full update would remove. */
  removesListed: number
}

export function reviewCounts(markets: readonly ReviewTableMarket[]): ReviewCounts {
  const tally = addTallies(markets.map(m => sendTally(m)))
  const skus = new Set<string>()
  let problems = 0
  for (const m of markets) {
    const groups = problemGroups(m.review?.issues ?? [])
    problems += groups.length
    for (const group of groups) for (const sku of group.skus) skus.add(sku)
  }
  const removesListed = reviewTableRows(markets, 'removes').filter(r => r.type === 'removal' || (r.type === 'plan' && r.row.danger)).length
  return {
    markets: markets.filter(m => m.rows.length || m.review).length,
    listings: tally.listings, changes: tally.changes, problems, problemSkus: skus.size,
    removedListings: tally.ended + tally.delete + (tally.moved ?? 0), removedValues: tally.removedValues, removesListed,
  }
}

/**
 * A field's tick: on, and whether the person can change it (a Full update's fields follow their row's tick). A change a
 * problem leaves out (`leftOut`, `blockedChanges` — option A, Owner 2026-10-19) is never on and cannot be ticked.
 */
export function fieldTick(row: ActionPlanRow, change: StudioPublishChange, opts: { selectedIds: readonly string[]; locked: boolean; reviewId: string | null | undefined
  leftOut?: ReadonlyMap<string, unknown> }): { on: boolean; enabled: boolean } {
  if (opts.leftOut?.has(change.id)) return { on: false, enabled: false }
  if (change.locked || isFull(row)) return { on: row.tick === 'on' || row.tick === 'whole', enabled: false }
  return { on: opts.selectedIds.includes(change.id), enabled: change.selectable && !opts.locked && !!opts.reviewId && !row.notSent }
}

/** A field's note: "Left out: <problem>" when a problem leaves it out, else its own reason (and an offer line's note). */
export function fieldNote(change: StudioPublishChange, leftOut?: ReadonlyMap<string, StudioPublishIssue>): string {
  const issue = leftOut?.get(change.id)
  return issue ? leftOutReason(issue) : [change.reason, change.display?.note].filter(Boolean).join(' ')
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

/**
 * A market's row in "All markets" when it has nothing the table can list yet or needs something only its tab offers —
 * null when it is ready, has nothing to send, or its problems are rows of their own. "Check again" for a review that
 * failed or expired; "Open" for a choice its tab holds (an inventory location, the overwrite confirmation, a skipped
 * exact request, an earlier publish still waiting).
 */
export function marketStateRow(state: DestinationState): ReviewMarketState | null {
  const said = destinationStateLabel(state)
  const text = stateLine(said)
  switch (state.kind) {
    case 'checking': case 'not_checked': return { tone: said.tone, text }
    case 'error': return { tone: 'danger', text: `${said.label}: ${state.message}`, action: 'check' }
    case 'expired': return { tone: said.tone, text, action: 'check' }
    case 'blocked': return state.problems && !state.request ? null : { tone: said.tone, text, action: 'open' }
    case 'earlier': case 'input': return { tone: said.tone, text, action: 'open' }
    default: return null
  }
}

/**
 * A product's row in one word, with its tone (Owner audit 2026-10-19: a green "Sent" stood on every row before anything
 * was sent, and stayed after the channel refused it). Before the send: what WILL happen ("Will be sent", "Will be
 * deleted"…), or why it does not ("Not sent", "Unticked"). After it (`results` given): the row's real result, or "Not
 * sent" when this send carried nothing for it.
 */
export function planRowTag(row: ActionPlanRow, results?: ReadonlyMap<string, PublishStatusMeta> | null): { label: string; tone: Tone; meta?: PublishStatusMeta } {
  if (row.notSent || row.tick === 'none') return { label: 'Not sent', tone: 'neutral' }
  if (row.tick === 'off') return { label: 'Unticked', tone: 'neutral' }
  if (results) {
    const meta = results.get(row.key)
    return meta ? { label: meta.label, tone: meta.tone, meta } : { label: 'Not sent', tone: 'neutral' }
  }
  if (row.danger) return { label: row.action === 'end' ? 'Will be ended' : row.action === 'delete' ? 'Will be deleted' : 'Will be moved', tone: 'danger' }
  return { label: 'Will be sent', tone: 'info' }
}

/**
 * A value a Full update removes, in a word: "Will be removed" while its row goes; "Stays" when the row is unticked or
 * held (nothing of it is sent, so the channel keeps the value). After the send, its row's result says what happened.
 */
export function removalTag(row: ActionPlanRow): { label: string; tone: Tone } {
  return rowSends(row) ? { label: 'Will be removed', tone: 'danger' } : { label: 'Stays', tone: 'neutral' }
}

/**
 * A status change's or a Delete's two values (Owner audit 2026-10-19: a Delete showed nothing under "Channel now"): the
 * listing as the channel has it now — "Active on eBay · IT" — and what this Publish makes of it: "Removed" (Delete),
 * "Ended", "Inactive", "Active". Null for every other row.
 */
export function lifecycleValues(row: Pick<ActionPlanRow, 'kind' | 'action' | 'listingState' | 'what'>, place: string): { now: string; sends: string } | null {
  if (row.kind !== 'lifecycle' || !row.listingState) return null
  const now = row.listingState === 'unknown' ? `On ${place} (its state was not read)` : `${SELLING_STATE_LABEL[row.listingState]} on ${place}`
  const sends = row.action === 'delete' ? 'Removed' : row.what.column === 'status' ? STATUS_TARGET_LABEL[row.what.target] : 'Removed'
  return { now, sends }
}

/**
 * The banner over a review's problems (Owner audit 2026-10-19: it said "Fix these before publishing" while ticked status
 * changes, or the changes a problem does not touch, could still go). `kept`: a change-only review with an id (option A);
 * `leftOut`: the changes the problems leave out, as the table lists them, and the distinct problems behind them;
 * `statusChangesGo`: a ticked status change or Delete is sent whatever the problems; `inTable`: the problems are the
 * first rows of the table below.
 */
export function problemBanner(input: { kept: boolean; namesNothing: boolean; leftOut: { changes: number; problems: number }; statusChangesGo: boolean; inTable: boolean }): { title: string; body: string } {
  if (!input.kept || input.namesNothing) {
    if (input.statusChangesGo) return { title: 'These hold back the content here', body: 'The status changes below can still be sent. Fix the problems, then check again to send the content.' }
    return { title: 'Fix these before publishing', body: input.inTable ? 'They are the first rows of the table below. Fix them, then check again.' : 'Each row says what to fix. Fix them, then check again.' }
  }
  if (input.leftOut.changes) {
    const { changes, problems } = input.leftOut
    return { title: `${plural(changes, 'change is', 'changes are')} left out by ${plural(problems, 'problem', 'problems')}`,
      body: `The other changes${input.statusChangesGo ? ' and the status changes' : ''} can be sent now. Fix the problems, then check again to send the rest.` }
  }
  return { title: 'These problems block nothing this publish sends', body: 'They are on fields this update does not send. Fix them before a Full update or a new listing.' }
}
