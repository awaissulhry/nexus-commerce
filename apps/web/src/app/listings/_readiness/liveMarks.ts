/**
 * Listings — the live layer on the chips and in the "On the channel" column (step 3 of
 * docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md, section 1 "The chip").
 *
 * Readiness says whether Nexus's saved data is good enough; the live layer says what the channel shows now, as far as
 * Nexus knows (the API's `ReadinessChip.live`). Each chip keeps its readiness colour and gets one mark:
 *   ●  every listing here is Active (the Pill's own dot)
 *   ◐  the listings differ ("Mixed")
 *   ○  not selling here: Not listed, Inactive or Ended
 *   ▲  a problem on the channel: Suppressed, a failed push or an open channel error. It wins over the others.
 *   no mark  Shared, a chip the channel was not read for (`live` null), or a state Nexus cannot name (Unknown)
 * A chip waiting for its rebuild keeps the spinner. A page with no live data at all (an older API, or a person
 * without `listings.view`) draws every chip exactly as before: the dot.
 *
 * The words are the design system's: the selling states (`SELLING_STATE_WORD`, Owner 2026-10-04: Active · Inactive ·
 * Not listed · Ended · Mixed; a draft reads Not listed) and "Suppressed" (`presence.ts`). Nothing here decides a state —
 * it only says what the API answered.
 *
 * Pure — no React — so every mark and sentence is a test.
 */
import type { ReadinessChip, ReadinessLiveSummary } from '@nexus/shared/listing-readiness'
import type { SellingState } from '@nexus/shared/listing-actions'
import { factMeta } from '@/design-system/grid/renderers/presence'
import { SELLING_STATE_WORD } from '@/design-system/grid/renderers/sellingStatus'

/** The live mark of one chip. */
export type LiveMark = 'active' | 'mixed' | 'off' | 'problem'

/** What a chip's glyph slot draws: the rebuild spinner, the Pill dot, a live mark, or nothing. */
export type ChipGlyph = 'pending' | 'dot' | 'mixed' | 'off' | 'problem' | 'none'

/** The design system's word for a listing the channel hides. */
export const SUPPRESSED_WORD = factMeta('SUPPRESSED').label

/** A problem on the channel: suppressed, the last push failed, or an open channel error. */
export function hasChannelProblem(live: Pick<ReadinessLiveSummary, 'suppressedCount' | 'syncFailedCount' | 'channelErrorCount'>): boolean {
  return live.suppressedCount > 0 || live.syncFailedCount > 0 || live.channelErrorCount > 0
}

/** The chip's live mark; null when there is nothing to say (Shared, not read, Unknown). */
export function liveMark(live: ReadinessLiveSummary | null | undefined): LiveMark | null {
  if (!live) return null
  if (hasChannelProblem(live)) return 'problem'
  switch (live.state) {
    case 'active': return 'active'
    case 'mixed': return 'mixed'
    case 'paused':
    case 'ended':
    case 'draft':
    case 'not_listed': return 'off'
    default: return null
  }
}

/**
 * The glyph a chip draws. `liveShown`: the page has live data (`pageHasLive`). Without it every chip keeps the dot it
 * always had; with it the dot means "every listing here is Active".
 */
export function chipGlyph(chip: Pick<ReadinessChip, 'pending' | 'live'>, liveShown: boolean): ChipGlyph {
  if (chip.pending) return 'pending'
  if (!liveShown) return 'dot'
  const mark = liveMark(chip.live)
  return mark === 'active' ? 'dot' : mark ?? 'none'
}

/** Does this answer carry live data? The families page says so with its tiles; a family's own page by its chips. */
export function pageHasLive(page: { liveStats?: unknown; rows: ReadonlyArray<{ chips: ReadonlyArray<Pick<ReadinessChip, 'live'>> }> }): boolean {
  return page.liveStats != null || page.rows.some((row) => row.chips.some((chip) => chip.live != null))
}

/* ── The words ────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The order the states are said in. A draft is said as Not listed (one set of words, Owner 2026-10-04). */
export const SAID_STATES = ['active', 'paused', 'mixed', 'not_listed', 'ended', 'unknown'] as const
export type SaidState = (typeof SAID_STATES)[number]

/** A row's listings on the channel, summed over its chips. */
export interface LiveTotals {
  /** Listings by state, plus the products with no listing on a destination (`notListed`) as Not listed. */
  byState: Record<SaidState, number>
  suppressed: number
  syncFailed: number
  channelErrors: number
  outOfSync: number
}

const said = (state: string): SaidState | null => {
  if (state === 'draft') return 'not_listed'
  return (SAID_STATES as readonly string[]).includes(state) ? (state as SaidState) : null
}

/**
 * The sum of the summaries given; null when none carries live data. `byState` counts listings, `notListed` the
 * products without one: both read Not listed.
 */
export function liveTotals(summaries: Iterable<ReadinessLiveSummary | null | undefined>): LiveTotals | null {
  let any = false
  const totals: LiveTotals = {
    byState: { active: 0, paused: 0, mixed: 0, not_listed: 0, ended: 0, unknown: 0 },
    suppressed: 0, syncFailed: 0, channelErrors: 0, outOfSync: 0,
  }
  for (const live of summaries) {
    if (!live) continue
    any = true
    for (const [state, n] of Object.entries(live.byState) as Array<[SellingState, number | undefined]>) {
      const key = said(state)
      if (key && n) totals.byState[key] += n
    }
    totals.byState.not_listed += live.notListed
    totals.suppressed += live.suppressedCount
    totals.syncFailed += live.syncFailedCount
    totals.channelErrors += live.channelErrorCount
    totals.outOfSync += live.outOfSyncCount
  }
  return any ? totals : null
}

const count = (n: number) => n.toLocaleString('en')

/** "18 Active", "2 Not listed" — the states with listings, in the fixed order. */
export function stateParts(totals: LiveTotals): string[] {
  return SAID_STATES.filter((state) => totals.byState[state] > 0).map((state) => `${count(totals.byState[state])} ${SELLING_STATE_WORD[state]}`)
}

/** "1 Suppressed", "1 Push failed", "3 channel errors", "2 Out of sync" — the problems, after the states. */
export function problemParts(totals: LiveTotals): string[] {
  const parts: string[] = []
  if (totals.suppressed > 0) parts.push(`${count(totals.suppressed)} ${SUPPRESSED_WORD}`)
  if (totals.syncFailed > 0) parts.push(`${count(totals.syncFailed)} Push failed`)
  if (totals.channelErrors > 0) parts.push(`${count(totals.channelErrors)} ${totals.channelErrors === 1 ? 'channel error' : 'channel errors'}`)
  if (totals.outOfSync > 0) parts.push(`${count(totals.outOfSync)} Out of sync`)
  return parts
}

/**
 * The chip's live sentence, after its readiness sentence: "On Amazon: Mixed, 18 Active, 2 Not listed. 1 Suppressed."
 * One product says its state only ("On eBay: Active."); several in one state say how many ("On Amazon: 20 Active.").
 * `channel` is the store's word ("Amazon").
 */
export function liveSentence(live: ReadinessLiveSummary, channel: string): string {
  const totals = liveTotals([live])
  const states = totals ? stateParts(totals) : []
  const problems = totals ? problemParts(totals) : []
  const products = live.listed + live.notListed
  const word = SELLING_STATE_WORD[live.state]
  const head = live.state === 'mixed' ? [word, ...states].join(', ') : products > 1 && states.length > 0 ? states.join(', ') : word
  return `On ${channel}: ${head}.${problems.length ? ` ${problems.join(', ')}.` : ''}`
}

/** The "On the channel" cell: the row's listings in view, summed over its chips. Null = no live data for the row. */
export interface OnChannelWords {
  /** "18 Active · 2 Not listed" */
  states: string
  /** "1 Suppressed · 2 Out of sync" — empty when there is no problem. */
  problems: string
  /** Both, as one sentence for the cell's value and a screen reader. */
  text: string
}

export function onChannelWords(chips: ReadonlyArray<Pick<ReadinessChip, 'live'>>): OnChannelWords | null {
  const totals = liveTotals(chips.map((chip) => chip.live))
  if (!totals) return null
  const states = stateParts(totals)
  const problems = problemParts(totals)
  if (states.length === 0 && problems.length === 0) return null
  return { states: states.join(' · '), problems: problems.join(' · '), text: [...states, ...problems].join(' · ') }
}

/* ── The "On the channel" column ──────────────────────────────────────────────────────────────────────────────────── */

/** Its column id. It exists only while the page has live data. */
export const LIVE_COLUMN = 'live'

/**
 * Did the grid state the page starts from have the column (the last visit had live data)? Then the page starts with it,
 * so its remembered width, place and visibility apply as the grid comes up; otherwise it waits for an answer with live
 * data, and an older API or a person without `listings.view` sees the page as it was.
 */
export function hasLiveColumn(state: { columnOrder?: { orderedColIds?: readonly string[] } } | null | undefined): boolean {
  return state?.columnOrder?.orderedColIds?.includes(LIVE_COLUMN) ?? false
}

/**
 * A column that arrives after the grid is up goes to the end (AG keeps the order it has); this one belongs right after
 * Markets. The column order with it there, or null when there is nothing to move.
 */
export function orderWithLiveAfterMarkets(ids: readonly string[]): string[] | null {
  const at = ids.indexOf('markets')
  const live = ids.indexOf(LIVE_COLUMN)
  if (at < 0 || live < 0 || live === at + 1) return null
  const rest = ids.filter((id) => id !== LIVE_COLUMN)
  rest.splice(rest.indexOf('markets') + 1, 0, LIVE_COLUMN)
  return rest
}
