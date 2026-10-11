/**
 * The rules of `ReviewChangesPanel` beyond the review's own (`reviewChangesModel.ts`) — pure, tested in Node
 * (Keyword Harvest page, lane HTO, 2026-10-11; design gap H2).
 *
 * The panel is the review body without the Modal frame, for a review that is a STEP inside a window ("Harvest to…":
 * set up → Review → Done in one dialog, never a dialog on a dialog). Two things a step needs that the one-table modal
 * did not: the table split into tabs ("Keywords 3 · Negatives 6 · New campaign 1"; each change names its tab in
 * `group`, an empty tab is left out) and a Result that carries its own tone ("Waiting" is not a success).
 */
import type { ReviewChange, ReviewResult } from './reviewChangesModel'

/** A change of the panel: a review change, optionally in a tab (`group` = a tab's id). */
export interface ReviewPanelChange extends ReviewChange {
  /** The tab it is listed under (`ReviewChangesPanel` `groups`). Without it: the first tab. */
  group?: string
}

/** A result that names its own tone: "Approved" (success), "Waiting" (warning), "Taken back" (neutral). */
export interface ReviewPanelResult extends ReviewResult {
  tone?: 'success' | 'info' | 'warning' | 'danger' | 'neutral'
}

/** One tab of the panel's table. */
export interface ReviewGroup { id: string; label: string }
export interface ReviewGroupCount extends ReviewGroup { count: number }

/** The group a change is listed under: its own when it names a known one, else the first. */
export function groupOf(change: Pick<ReviewPanelChange, 'group'>, groups: readonly ReviewGroup[]): string | null {
  if (!groups.length) return null
  return change.group && groups.some((g) => g.id === change.group) ? change.group : groups[0].id
}

/** The tabs that have changes, in the host's order, each with its count. An empty tab is left out. */
export function groupCounts(changes: readonly Pick<ReviewPanelChange, 'group'>[], groups: readonly ReviewGroup[]): ReviewGroupCount[] {
  const counts = new Map<string, number>()
  for (const c of changes) {
    const g = groupOf(c, groups)
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  return groups.filter((g) => (counts.get(g.id) ?? 0) > 0).map((g) => ({ ...g, count: counts.get(g.id) ?? 0 }))
}

/** The tab to show: the one asked when it has changes, else the first that has any; null when there are no tabs. */
export function activeGroup(tabs: readonly ReviewGroupCount[], wanted: string | null | undefined): string | null {
  if (!tabs.length) return null
  return tabs.some((t) => t.id === wanted) ? (wanted as string) : tabs[0].id
}

/** The changes of one tab (all of them without tabs). */
export function changesIn<C extends Pick<ReviewPanelChange, 'group'>>(changes: readonly C[], groups: readonly ReviewGroup[], tab: string | null): readonly C[] {
  if (!groups.length || tab === null) return changes
  return changes.filter((c) => groupOf(c, groups) === tab)
}

/** A Result's tag tone: its own, else success when it went through and danger when it did not. */
export function resultTone(result: ReviewPanelResult): NonNullable<ReviewPanelResult['tone']> {
  return result.tone ?? (result.ok ? 'success' : 'danger')
}
