/**
 * Listing readiness — the three kinds of grid row: a family root or single product (top level), a row inside an open
 * family, and the family footer (a full-width row: "Showing 10 of 40 variations", "View all 40"). Pure.
 */
import type { ReadinessFamilyRow, ReadinessMembersPage, ReadinessMemberRow } from '@nexus/shared/listing-readiness'

/** The full-width row beneath an open family. `shown` and `total` count VARIATIONS (the parent's own listing is not one). */
export interface ReadinessFooterRow {
  __familyFooter: true
  id: string
  parentId: string
  shown: number
  total: number
}

export type ReadinessDataRow = ReadinessFamilyRow | ReadinessMemberRow
export type ReadinessGridRow = ReadinessDataRow | ReadinessFooterRow

export const isReadinessFooter = (d: unknown): d is ReadinessFooterRow =>
  !!d && typeof d === 'object' && (d as { __familyFooter?: unknown }).__familyFooter === true

export const isMemberRow = (d: ReadinessGridRow | null | undefined): d is ReadinessMemberRow =>
  !!d && !isReadinessFooter(d) && 'isParentListing' in d

export const isFamilyRow = (d: ReadinessGridRow | null | undefined): d is ReadinessFamilyRow =>
  !!d && !isReadinessFooter(d) && 'isParent' in d

/** A top-level row folds open when it is a family with members that match the filters. A single product does not. */
export const canExpand = (d: ReadinessGridRow | null | undefined): boolean =>
  isFamilyRow(d) && d.isParent && d.matchingCount > 0

export const familyFooterId = (parentId: string): string => `__readiness_footer__${parentId}`

export function familyFooter(parentId: string, shown: number, total: number): ReadinessFooterRow {
  return { __familyFooter: true, id: familyFooterId(parentId), parentId, shown, total }
}

/**
 * A row id unique across the whole tree. A parent's own listing ("Parent listing") sits inside its family under the
 * same product id as the family row above it, so the id carries its path.
 */
export function readinessRowId(data: { id: string }, parentKeys: readonly string[] | undefined): string {
  return [...(parentKeys ?? []), data.id].join('/')
}

/**
 * An open family's preview: up to `limit` variations, plus the parent's own listing first when it matches — the
 * members endpoint is asked for `limit + 1` rows, because the parent sorts first and must not cost a variation.
 * The footer then counts variations only, so it agrees with the family row's "20 variations".
 */
export function familyPreview(rootId: string, members: Pick<ReadinessMembersPage, 'rows' | 'total'>, limit: number): ReadinessGridRow[] {
  const parent = members.rows[0]?.isParentListing === true ? 1 : 0
  const rows = members.rows.slice(0, limit + parent)
  if (rows.length === 0 && members.total === 0) return []
  return [...rows, familyFooter(rootId, rows.length - parent, Math.max(0, members.total - parent))]
}
