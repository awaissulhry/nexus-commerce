/**
 * PES.7 — what an edit to a matrix cell actually writes. Pure, tested, no React.
 *
 * `POST /images-workspace/bulk-save` takes `{ upserts, deletes }` and its two sharpest edges are
 * both invisible from the call site:
 *
 * 🔴 **An upsert WITHOUT `id` creates.** The route does not reconcile by coordinate — it updates
 *    when given an id and creates otherwise. So writing to a cell that already has a row of its own
 *    without carrying that row's id silently produces a SECOND row at the same (bucket, slot,
 *    market), and the cascade then picks one of them arbitrarily.
 *
 * 🔴 **Every upsert resets `publishStatus` to DRAFT and clears `publishError`.** Editing a live
 *    cell un-publishes it. That is correct — the picture on Amazon is no longer the picture here —
 *    but the UI must show the cell leaving `live`, not keep a green tick over changed bytes.
 *
 * And the rule that decides between them: **pinning is not editing.** A cell showing an INHERITED
 * picture (the shared bucket's, or master's) has no row of its own. Writing to it must CREATE a row
 * for this bucket — updating the row it inherits FROM would change every other bucket that inherits
 * the same picture. One drop on Nero must not repaint Giallo.
 */
import type { CascadeRow, ResolvedCell } from './cascade'

/** The `ListingImageUpsert` shape the route accepts. */
export interface ListingUpsert {
  /** Present = update that row. Absent = create. Getting this wrong duplicates the coordinate. */
  id?: string
  scope: 'PLATFORM' | 'MARKETPLACE'
  platform: 'AMAZON'
  marketplace: string | null
  amazonSlot: string
  variantGroupKey: string | null
  variantGroupValue: string | null
  url: string
  sourceProductImageId?: string | null
  position?: number
  role?: string
}

export interface CellCoordinate {
  slot: string
  /** null is the shared "all colours" bucket. */
  groupValue: string | null
  /** The stored key the buckets use — NOT the axis's display name (Color vs Colore). */
  groupKey: string | null
  /** The market being viewed; null means the all-markets layer. */
  market: string | null
}

/**
 * The write for placing `url` into a cell.
 *
 * Pins at the coordinate being VIEWED: with a market selected the write is MARKETPLACE-scoped, so
 * an edit never reaches further than the matrix the operator is looking at. Widening to every
 * market is a deliberate, separate action — not a side effect of a drop.
 */
export function placeImage(args: {
  at: CellCoordinate
  url: string
  /** What the cell resolves to NOW — decides update-in-place versus create-a-pin. */
  resolved: ResolvedCell
  sourceProductImageId?: string | null
}): ListingUpsert {
  const { at, url, resolved, sourceProductImageId = null } = args

  const scope: ListingUpsert['scope'] = at.market ? 'MARKETPLACE' : 'PLATFORM'
  const marketplace = at.market ?? null

  // Only a row that belongs to THIS coordinate may be updated. An inherited picture belongs to a
  // different bucket (or to master), and updating it would repaint every bucket that shares it.
  const ownRow = ownRowAt(resolved, at)

  return {
    ...(ownRow ? { id: ownRow.id } : {}),
    scope,
    platform: 'AMAZON',
    marketplace,
    amazonSlot: at.slot,
    variantGroupKey: at.groupValue == null ? null : at.groupKey,
    variantGroupValue: at.groupValue,
    url,
    sourceProductImageId,
    position: 0,
    role: 'GALLERY',
  }
}

/**
 * The row the cell owns at this exact coordinate, or null when the picture is inherited.
 *
 * `pictureless` counts as owned: the row exists at this coordinate and holds no picture, so filling
 * it is an update, not a new pin — creating instead would leave the phantom row behind alongside
 * the new one.
 */
export function ownRowAt(resolved: ResolvedCell, at: CellCoordinate): CascadeRow | null {
  if (!resolved.row) return null
  if (resolved.origin === 'shared' || resolved.origin === 'master' || resolved.origin === 'empty') return null
  const row = resolved.row
  // The row must sit at the same market layer the write will target.
  const rowMarket = row.scope === 'MARKETPLACE' ? row.marketplace : null
  if (rowMarket !== (at.market ?? null)) return null
  if ((row.variantGroupValue ?? null) !== at.groupValue) return null
  return row
}

/**
 * Clearing a cell.
 *
 * Only a row this coordinate OWNS can be deleted. Clearing an inherited cell would delete the
 * shared row and strip the picture from every bucket — so it is refused, and the caller is told
 * why rather than being handed a delete that does something bigger than it looks.
 */
export function clearCell(args: { at: CellCoordinate; resolved: ResolvedCell }):
  | { kind: 'delete'; id: string }
  | { kind: 'refused'; reason: string } {
  const own = ownRowAt(args.resolved, args.at)
  if (own) return { kind: 'delete', id: own.id }
  if (args.resolved.origin === 'shared') {
    return { kind: 'refused', reason: 'This picture belongs to the shared row — clearing it here would remove it from every bucket. Clear it on the shared row instead.' }
  }
  if (args.resolved.origin === 'master') {
    return { kind: 'refused', reason: 'This picture comes from the master gallery, not from Amazon. Remove it there, or pin a different image here.' }
  }
  return { kind: 'refused', reason: 'There is nothing to clear in this slot.' }
}

/**
 * Moving a picture from one cell to another: a place at the target, plus a clear at the source when
 * the source owns its row. A move out of an INHERITED cell is a copy — there is nothing to remove.
 */
export function moveImage(args: {
  from: CellCoordinate
  fromResolved: ResolvedCell
  to: CellCoordinate
  toResolved: ResolvedCell
}): { upsert: ListingUpsert; deleteId: string | null } | null {
  const { from, fromResolved, to, toResolved } = args
  if (!fromResolved.url) return null
  const upsert = placeImage({
    at: to,
    url: fromResolved.url,
    resolved: toResolved,
    sourceProductImageId: fromResolved.row?.sourceProductImageId ?? null,
  })
  const source = ownRowAt(fromResolved, from)
  // Moving the same row onto itself would delete what was just written.
  const deleteId = source && source.id !== upsert.id ? source.id : null
  return { upsert, deleteId }
}
