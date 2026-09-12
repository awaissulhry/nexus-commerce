/**
 * PES.7 — turning the workspace payload into the matrix's rows, columns and cell values. Pure.
 *
 * Kept out of the component for the reason the crop geometry taught: a wrong rectangle and a wrong
 * cascade look identical on screen, and neither is diagnosable by clicking at it. Everything here
 * is arithmetic over data and is tested as such.
 */
import type { CellProvenance } from '@/design-system/grid'

import { isPublished, type AmazonSlotDef, type ListingAsset, type MasterAsset } from '../../types'
import { bucketValues, resolveCell, type CascadeRow, type CascadeOrigin } from './cascade'

/** The shared "all colours" row is a real bucket with a null value, not the absence of one. */
export const SHARED_ROW_ID = '__shared__'

export interface MatrixRow {
  id: string
  label: string
  /** null on the shared row. */
  groupValue: string | null
  /** True when this bucket is stored on the channel but the axis no longer declares it. */
  orphaned?: boolean
}

export interface MatrixColumn {
  slot: string
  /** False when Amazon's schema marks the locator Seller-Central-only. */
  writable: boolean
  kind: AmazonSlotDef['kind']
}

/** Exactly the `MediaCellValue` shape the DS cell reads — built here, carried in the cell's value. */
export interface MatrixCellValue {
  src: string | null
  alt?: string
  provenance?: CellProvenance
  inheritedFrom?: string | null
  locked?: boolean
  publish?: 'live' | 'queued' | 'failed' | null
  warn?: string | null
  refused?: string | null
}

/**
 * The columns to show.
 *
 * 🔴 From `amazonSlotTaxonomy` — the set Amazon's own cached schema says exists for THIS product
 * type — not a hardcoded list. The server has always sent it and the previous tab dropped it
 * (inventory §4B), rendering a fixed 10 or 16 regardless of the product. Measured: GALE-JACKET
 * (OUTERWEAR) resolves 16 slots, the eBay listing shells resolve 10.
 *
 * The fallback exists because the field is optional on older API responses; it is the legacy set,
 * and a caller can tell the two apart because `fromSchema` says so.
 */
const LEGACY_SLOTS = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'SWCH']

/** Where the columns came from. `unknown` is its own state — an older API that did not say. */
export type SlotSetSource = 'schema' | 'fallback' | 'unknown'

export function matrixColumns(
  taxonomy: AmazonSlotDef[] | undefined,
  /**
   * 🔴 The server's own answer, and the only trustworthy one.
   *
   * This used to be inferred as `taxonomy.length > 0 ? 'schema' : 'fallback'`, which is WRONG: a
   * fallback arrives as a perfectly good non-empty list of ten slots, so the matrix claimed the
   * legacy set was authoritative and never showed its own warning. Same falsely-clean shape as the
   * cached-fallback defect it was written to guard against.
   */
  source?: 'schema' | 'fallback',
): { columns: MatrixColumn[]; slotSetSource: SlotSetSource } {
  if (taxonomy && taxonomy.length > 0) {
    const columns = [...taxonomy]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ slot: s.slot, writable: s.writable, kind: s.kind }))
    return { columns, slotSetSource: source ?? 'unknown' }
  }
  return {
    columns: LEGACY_SLOTS.map((slot) => ({
      slot,
      writable: true,
      kind: slot === 'MAIN' ? 'MAIN' as const : slot === 'SWCH' ? 'SWATCH' as const : 'OTHER' as const,
    })),
    // No taxonomy at all: these are the legacy slots, and we know that for certain.
    slotSetSource: 'fallback',
  }
}

/** The rows: the shared bucket first, then the axis's values in declared order, then any orphans. */
export function matrixRows(axisValues: readonly string[], rows: readonly CascadeRow[]): MatrixRow[] {
  const { values, orphaned } = bucketValues(axisValues, rows)
  return [
    { id: SHARED_ROW_ID, label: 'All colours (shared)', groupValue: null },
    ...values.map((v) => ({ id: v, label: v, groupValue: v })),
    // Surfaced, not dropped: a picture that exists on the channel must appear somewhere.
    ...orphaned.map((v) => ({ id: v, label: v, groupValue: v, orphaned: true })),
  ]
}

/** How the cascade's origin reads in the CELL vocabulary the text cells already use (ruling #64). */
function provenanceFor(origin: CascadeOrigin): CellProvenance | undefined {
  switch (origin) {
    // A row of this coordinate's own is the value being pinned here.
    case 'market': return 'pinned'
    case 'platform': return 'own'
    // A market showing the all-markets picture, or a colour showing the shared one, IS inheritance.
    case 'shared': return 'inherited'
    case 'master': return 'inherited'
    // A pictureless row has no provenance to report — there is no picture to have come from
    // anywhere. The warning carries the meaning instead.
    default: return undefined
  }
}

function publishFor(status: string | undefined): MatrixCellValue['publish'] {
  switch (status) {
    case 'PUBLISHED': return 'live'
    case 'ERROR': return 'failed'
    case 'DRAFT':
    case 'OUTDATED': return 'queued'
    default: return null
  }
}

export function buildCellValue(args: {
  rows: readonly CascadeRow[]
  slot: string
  market: string | null
  groupValue: string | null
  masterFallbackUrl?: string | null
  writable: boolean
}): MatrixCellValue {
  const { rows, slot, market, groupValue, masterFallbackUrl, writable } = args
  const r = resolveCell({ rows, slot, market, groupValue, masterFallbackUrl })
  const publish = publishFor(r.row?.publishStatus)
  return {
    src: r.url,
    alt: `${groupValue ?? 'all colours'} · ${slot}`,
    provenance: provenanceFor(r.origin),
    inheritedFrom: r.inheritedFrom,
    // A read-only slot cannot take a drop; so can a row the channel itself locked.
    locked: !writable || r.row?.locked === true,
    publish,
    refused: r.row?.publishError ?? null,
    // An empty row that the channel believes is filled is the contradiction worth surfacing — the
    // operator sees a blank slot and would otherwise have no way to know a row is claiming it.
    warn: r.origin === 'pictureless'
      ? (publish === 'live'
        ? 'This slot is marked published on Amazon but holds no image'
        : 'A row claims this slot but holds no image')
      : null,
  }
}

/** What master would publish into a slot, when nothing on the channel covers it. */
export function masterFallback(master: readonly MasterAsset[], slot: string): string | null {
  if (slot === 'MAIN') {
    const main = master.find((m) => m.isPrimary) ?? master.find((m) => m.type === 'MAIN')
    return main?.url ?? null
  }
  return null
}

/** Narrow the workspace's listing rows to the ones this matrix resolves over. */
export function amazonRows(listing: readonly ListingAsset[]): CascadeRow[] {
  // No cast: `CascadeRow` is a `Pick` of `ListingAsset`, so this is assignable on its own.
  return listing.filter((l) => l.platform === 'AMAZON')
}

/**
 * Coordinates where a row exists and holds no picture.
 *
 * ⚠ The DS media cell resolves `empty` BEFORE `warned` (and `mediaCellTitle` does the same), so a
 * `warn` set on a cell with no `src` is currently unreachable — the tile reads "No image yet" and
 * the contradiction disappears. That precedence is right for the case it was written for (an empty
 * locked slot should read as "nothing here"), so this is NOT forked; the count is surfaced at the
 * MATRIX level instead, where "N slots are marked published but hold no image" is more use to an
 * operator than the same fact spread across N tooltips. Reported to PES.2 as a gap, not a bug.
 */
export function picturelessCoordinates(args: {
  rows: readonly CascadeRow[]
  columns: readonly MatrixColumn[]
  matrix: readonly MatrixRow[]
  market: string | null
}): { total: number; claimingLive: number } {
  const { rows, columns, matrix, market } = args
  let total = 0
  let claimingLive = 0
  for (const r of matrix) {
    for (const c of columns) {
      const res = resolveCell({ rows, slot: c.slot, market, groupValue: r.groupValue })
      if (res.origin !== 'pictureless') continue
      total++
      if (isPublished(res.row?.publishStatus)) claimingLive++
    }
  }
  return { total, claimingLive }
}
