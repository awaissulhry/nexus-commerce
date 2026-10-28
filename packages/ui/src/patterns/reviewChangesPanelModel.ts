/**
 * The rules of `ReviewChangesPanel` beyond the review's own (`reviewChangesModel.ts`) — pure, tested in Node
 * (Keyword Harvest page, lane HTO, 2026-10-11; design gap H2).
 *
 * The panel is the review body without the Modal frame, for a review that is a STEP inside a window ("Harvest to…":
 * set up → Review → Done in one dialog, never a dialog on a dialog). Two things a step needs that the one-table modal
 * did not: the table split into tabs ("Keywords 3 · Negatives 6 · New campaign 1"; each change names its tab in
 * `group`, an empty tab is left out) and a Result that carries its own tone ("Waiting" is not a success).
 */
import type { ReactNode } from 'react'
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

/**
 * One line of a change's phone card (2026-10-26, the review on a phone): a column and its cell, or `Now → New` as one
 * line holding both values.
 */
export type ReviewCardField =
  | { key: string; kind: 'value'; label: string; value: ReactNode }
  | { key: 'now-new'; kind: 'change'; now: ReactNode; next: ReactNode }

/** A cell with nothing to say: an empty string, null, undefined or false. */
const blank = (v: ReactNode): boolean => v === '' || v === null || v === undefined || v === false

/**
 * A change's card below 760 px: the table's columns in order, each on its own line, with Now and New joined into one
 * `Now → New` line, and a column whose cell is empty for this change left out (one change has a Note, another not).
 * PURE: the same columns and cells the table draws, so the two forms can never say different things.
 */
export function reviewCardFields(columns: readonly string[], cells: readonly ReactNode[]): ReviewCardField[] {
  const nowAt = columns.indexOf('Now')
  const nextAt = columns.indexOf('New')
  const out: ReviewCardField[] = []
  columns.forEach((column, i) => {
    if (i === nowAt && nextAt >= 0) { out.push({ key: 'now-new', kind: 'change', now: cells[nowAt], next: cells[nextAt] }); return }
    if (i === nextAt && nowAt >= 0) return
    if (blank(cells[i])) return
    out.push({ key: column, kind: 'value', label: column, value: cells[i] })
  })
  return out
}

