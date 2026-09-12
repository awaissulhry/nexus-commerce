'use client'

import { VariantIdentity as SharedVariantIdentity } from '../VariantIdentity'

/**
 * VP.3 — the variants grid's THREE column groups (§3.3): `PRODUCT` · `AXES` · `CHANNEL PROJECTIONS`.
 *
 * ## What this file does NOT build
 *
 * The axis columns. They are the MASTER SHEET's own columns, taken from `buildMasterColumns` and
 * re-grouped here — so the editor a `Colore` cell opens, the option list it offers, the validation
 * it applies, the provenance glyph it wears and the write it commits are the sheet's, on this page
 * and on Information alike. A second implementation of "edit an axis value" is the exact drift
 * `feedback_shared_components_no_copy_props` exists to stop, and it would have been the easy thing
 * to write: the columns are `select` cells with an option list, and a hand-rolled one would have
 * looked right and quietly lost the refusal reasons, the length caps and the `=` formula path.
 *
 * Only two things here are this page's own: the identity band's composition (§3.3 fixes its slots
 * and this page's second line is always the axis values, never the product name) and the projection
 * columns, which have no counterpart on the sheet.
 */
import type { MutableRefObject } from 'react'

import {
  ProjectionCell,
  type ColDef,
  type ColGroupDef,
  type ICellRendererParams,
  type ProjectionCellParams,
  type ProjectionFacts,
  type ValueGetterParams,
} from '@/design-system/grid'
import type { MenuItemDef } from '@/design-system/components'

import { buildMasterColumns } from '../../sheet/master/columns'
import type { CellSaveTracker } from '@/design-system/grid'
import type { SheetColumn, StudioRow } from '../../sheet/master/types'

import type { AxisSummary } from './coverage'
import { parentIdentityNote, projectionIncluded, projectionState, type FamilyProjections, type ProjectionChannel } from './projections'

/**
 * The identity column's id.
 *
 * 🔴 `identity`, not `product`, and both halves of that matter. AG keeps column ids and column-GROUP
 * ids in ONE namespace, so `colId: 'product'` inside `groupId: 'product'` collided and AG renamed
 * the column `product_1` with warning #273 — on screen as a console warning, and §7's bar is zero
 * console errors on the canvas states (VP.1 caught it). And `identity` is the id
 * `scripts/check-layout-v2.mjs` looks for when it measures this column, so a private name here is a
 * NOT MEASURED there.
 */
export const IDENTITY_COL = 'identity'

/* ── §3.3's measured widths, from the canvas ──────────────────────────────────────────────── */

/**
 * The identity column, FIXED at the canvas's 380.
 *
 * 🔴 Deliberately NOT the sheet's derived width, and the difference is a property of this page. The
 * sheet derives (`deriveBandWidthFromDom`, clamped 240–420) because its band's CONTENT varies: some
 * rows carry a tree chevron and some do not, a channel's alias band row has a different trail, and a
 * constant there went stale the moment `CompletenessPill` changed size (#731, five SKUs truncated
 * silently). This page's slot set is fixed by §3.3 — no expander on any row, one trail on every row
 * — so there is nothing for a derivation to respond to, and 380 is what the design chose, what §7
 * measures, and what the layout gate asserts. A derived 404 here would be a page that disagrees with
 * its own spec by 24px for no reason anybody could name.
 */
export const IDENTITY_COL_W = 380
/** One axis column. The canvas draws `Colore` and `Taglia` at 140 each. */
export const AXIS_COL_W = 140
/** A channel column naming a market (`Amazon · IT`). */
export const CHANNEL_COL_W = 170
/** A global channel (`Shopify · GLOBAL`) — a shorter label, and the canvas gives it 160. */
export const GLOBAL_CHANNEL_COL_W = 160

/* ── the identity cell ────────────────────────────────────────────────────────────────────── */

/**
 * The second line, always the axis values (§3.3) — `Nero · XXS` on a variant, `Parent · 20 variants`
 * on the parent.
 *
 * 🔴 NOT `identitySecondary` from the sheet. That rule chooses between the axis values and the
 * product NAME depending on whether the family is fully covered (#716), which is right for a sheet
 * whose job is the attributes and wrong here: on a page about the axes, a row that falls back to
 * its name is the one row whose axis values you cannot read. A variant missing a value says so.
 */
export function identityLine(row: StudioRow, axes: readonly AxisSummary[]): string {
  if (row.isParent) {
    const n = row.childCount
    return `Parent · ${n} ${n === 1 ? 'variant' : 'variants'}`
  }
  if (axes.length === 0) return row.name ?? ''
  return axes.map(axis => String(row.axisValues?.[axis.key] ?? '—')).join(' · ')
}

interface IdentityParams {
  axesRef: MutableRefObject<AxisSummary[]>
  rowMenuRef: MutableRefObject<(row: StudioRow) => MenuItemDef[]>
}

function VariantIdentity(p: ICellRendererParams<StudioRow> & Partial<IdentityParams>) {
  const d = p.data
  if (!d) return null
  return <SharedVariantIdentity sku={d.sku} isParent={d.isParent} parentId={d.parentId} childCount={d.childCount}
    image={d.imageUrl} inherited={d.imageInherited} axes={(p.axesRef?.current ?? []).map(axis => d.axisValues?.[axis.key] ?? '—')}
    suspect={(d as StudioRow & { axisValuesSuspect?: Array<{ reason: string }> }).axisValuesSuspect}
    pct={d.completeness.overall.pct} menuItems={p.rowMenuRef?.current(d)} />
}

/* ── the projection cell ──────────────────────────────────────────────────────────────────── */

export interface ProjectionWrite {
  /** Toggle inclusion on this coordinate. ABSENT while §5.4 is unbuilt — the checkbox then holds. */
  setIncluded?: (row: StudioRow, channel: ProjectionChannel, next: boolean) => void
  /** Why the checkbox is inert, when it is. A disabled control must be able to explain itself. */
  heldReason?: string
}

function projectionColumn(
  channel: ProjectionChannel,
  last: boolean,
  projectionsRef: MutableRefObject<FamilyProjections>,
  write: ProjectionWrite,
): ColDef<StudioRow> {
  /*
   * 🔴 ONE object per column, built here and never inline in the JSX. `ProjectionCell`'s own
   * header says why: an inline `cellRendererParams` literal is a new identity on every render and
   * re-runs AG's whole column model (reference_ag_react_inline_options_rerun_column_model).
   */
  const params: ProjectionCellParams = {
    facts: (p): ProjectionFacts | null => {
      const d = p.data as StudioRow | undefined
      if (!d) return null
      const projections = projectionsRef.current
      const projection = projections.byProduct[d.id]?.[channel.key]
      const state = projectionState(channel, projection)
      if (d.isParent) {
        /* The parent carries the family's OWN record on the channel — an ASIN, an eBay item id, a
           Shopify product id — not an inclusion. `state: null` is how `ProjectionCell` is told to
           draw the identity instead of a word; where there is no identity to draw, the state is
           worth saying (an unconnected channel still reads "Not set up"). */
        if (!channel.connected) return { state }
        if (!projection?.externalId) return { state: 'excluded' }
        return {
          state: null,
          detail: projection.externalId,
          note: parentIdentityNote(channel, projections.listingsPerChannel[channel.key] ?? 0, state),
        }
      }
      return { state, heldReason: channel.connected ? write.heldReason ?? null : null }
    },
    ...(write.setIncluded
      ? { onToggle: (next, p) => { const d = p.data as StudioRow | undefined; if (d) write.setIncluded?.(d, channel, next) } }
      : {}),
    label: (p) => {
      const d = p.data as StudioRow | undefined
      return `Include ${d?.sku ?? 'this variant'} on ${channel.label}`
    },
    readOnlyReason: write.heldReason ?? 'Inclusion cannot be changed here yet',
  }
  return {
    colId: `proj:${channel.key}`,
    headerName: channel.label,
    headerTooltip: channel.connected
      ? `Included variants and their listing state on ${channel.label}`
      : `${channel.label} is not set up — no account is connected`,
    ...(last ? { flex: 1, minWidth: GLOBAL_CHANNEL_COL_W } : { width: channel.market === 'GLOBAL' ? GLOBAL_CHANNEL_COL_W : CHANNEL_COL_W }),
    sortable: true,
    resizable: true,
    suppressMovable: true,
    suppressHeaderMenuButton: true,
    /*
     * 🔴 NOT editable, and that is the §5.4 HOLD rather than a design choice: inclusion is a write
     * VP.2 has still to prove pushes nothing to a channel. AG refuses to fill a non-editable
     * column, so the fill handle cannot smear inclusion across twenty live listings while the
     * endpoint does not exist. It becomes `editable` in the same edit that supplies `setIncluded`,
     * and the `valueSetter` below is already the one AG's fill needs (it MUTATES `params.data`).
     */
    editable: false,
    cellClass: 'nds-ag-cell',
    /* The VALUE is the include flag and nothing else — `ProjectionCell`'s contract, and what lets
       AG's fill handle carry inclusion down a column without stamping one variant's ASIN onto
       nineteen others. `null` on the parent: it has no tick. */
    valueGetter: (p: ValueGetterParams<StudioRow>) =>
      !p.data || p.data.isParent ? null : projectionIncluded(channel, projectionsRef.current.byProduct[p.data.id]?.[channel.key]),
    cellRenderer: ProjectionCell,
    cellRendererParams: params,
  }
}

/* ── the whole model ──────────────────────────────────────────────────────────────────────── */

export interface BuildVariantColumnsOptions {
  /** The sheet's column set — the axis columns are taken from it, never rebuilt. */
  columns: SheetColumn[]
  tracker: CellSaveTracker
  locale: string
  market: string
  /** The family's axes, in stored order. Only these become AXES columns, and in this order. */
  axes: readonly AxisSummary[]
  /** Read at PAINT time so a projections reload repaints without rebuilding the column model. */
  projectionsRef: MutableRefObject<FamilyProjections>
  axesRef: MutableRefObject<AxisSummary[]>
  rowMenuRef: MutableRefObject<(row: StudioRow) => MenuItemDef[]>
  write: ProjectionWrite
}

export function buildVariantColumns(opts: BuildVariantColumnsOptions): (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] {
  const { columns, tracker, locale, market, axes, projectionsRef, axesRef, rowMenuRef, write } = opts

  const identity: ColDef<StudioRow> = {
    colId: IDENTITY_COL,
    headerName: 'Product',
    width: IDENTITY_COL_W,
    /* A restored column state cannot argue with `minWidth`, and that is not theoretical: the sheet's
       persisted layout was carrying a 46.4px auto-fit remainder that beat its def on every load
       (#709a). Pinned to the same number, so nothing can squeeze the band below what it draws. */
    minWidth: IDENTITY_COL_W,
    maxWidth: IDENTITY_COL_W,
    pinned: 'left',
    lockPinned: true,
    lockPosition: 'left',
    suppressMovable: true,
    suppressHeaderMenuButton: true,
    sortable: false,
    cellClass: 'nds-ag-cell',
    cellRenderer: VariantIdentity,
    cellRendererParams: { axesRef, rowMenuRef },
    headerTooltip: 'The parent and its variants',
    getQuickFilterText: (p) => `${p.data?.sku ?? ''} ${p.data?.name ?? ''}`,
  }

  /*
   * The AXES group, from the sheet's own factory.
   *
   * `reservedColumnIds` keeps `sku` out (the identity band already draws it, and two columns with
   * one id makes AG rename the second `sku_1`). `grouped: false` so it hands back flat ColDefs for
   * this file to group; the sheet's own grouping path carries a `marryChildren` that double-draws a
   * header once anything is pinned, and nothing here needs it.
   */
  const sheetColumns = buildMasterColumns(
    { columns, tracker, locale, market, reservedColumnIds: [IDENTITY_COL, 'sku'], grouped: false },
    { current: [] },
  ) as ColDef<StudioRow>[]
  const byKey = new Map(sheetColumns.map(c => [(c.colId ?? '').toLowerCase(), c]))
  const axisColumns = axes.map(axis => {
    const column = axisSheetColumn(byKey, axis)
    if (column) return { ...column, headerName: axis.label, headerTooltip: `${axis.label} — shared across channels`, width: AXIS_COL_W, minWidth: AXIS_COL_W, suppressMovable: true } satisfies ColDef<StudioRow>
    return {
      colId: `axis:${axis.key}`, headerName: axis.label, width: AXIS_COL_W, minWidth: AXIS_COL_W,
      editable: false, valueGetter: p => p.data?.isParent ? null : p.data?.axisValues?.[axis.key] ?? null,
      tooltipValueGetter: () => `This product family has no writable attribute for ${axis.label}. Review its classification.`,
    } satisfies ColDef<StudioRow>
  })

  const channels = projectionsRef.current.channels
  const projectionColumns = channels.map((channel, i) =>
    projectionColumn(channel, i === channels.length - 1, projectionsRef, write),
  )

  /*
   * 🔴 The group ids are PREFIXED, because AG holds column ids and group ids in one namespace and a
   * collision is resolved silently by renaming the COLUMN (`product` → `product_1`, warning #273).
   * `marryChildren` is deliberately absent: it draws a group header TWICE the moment any child
   * crosses the pinned boundary, and the identity column is pinned left (`columns.tsx` in the sheet
   * carries the same finding). Nothing here needs it — every column is `suppressMovable`.
   */
  const groups: (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] = [
    { groupId: 'grp-product', headerName: 'Product', children: [identity] },
  ]
  if (axisColumns.length > 0) groups.push({ groupId: 'grp-axes', headerName: 'Axes', children: axisColumns })
  if (projectionColumns.length > 0) groups.push({ groupId: 'grp-projections', headerName: 'Channel projections', children: projectionColumns })
  return groups
}


/**
 * The sheet column that stores an axis, or `undefined`.
 *
 * 🔴 Paired through the server's OWN `storedKey` (`Colore` → `Color`), never through a local copy of
 * the API's canonicalisation table (`variant-attribute-keys.ts`). That table already has one home,
 * and a client re-derivation of it is a fork that would drift the first time a language is added.
 */
function axisSheetColumn(byKey: Map<string, ColDef<StudioRow>>, axis: AxisSummary): ColDef<StudioRow> | undefined {
  return byKey.get((axis.storedKey ?? axis.key).toLowerCase()) ?? byKey.get(axis.key.toLowerCase())
}

/**
 * Which of the family's axes the sheet carries a column for, paired the same way.
 *
 * 🔴 An axis with NO column is a real gap — nothing could ever write it. An axis WITH one is not
 * automatically writable here either; see the hold in `buildVariantColumns`. The band and the
 * columns share this predicate so they cannot disagree about which is which.
 */
export function axisColumnsFor(columns: readonly SheetColumn[], axes: readonly AxisSummary[]): SheetColumn[] {
  return axes.flatMap(axis => {
    const want = [(axis.storedKey ?? axis.key).toLowerCase(), axis.key.toLowerCase()]
    const hit = columns.find(c => want.includes(c.key.toLowerCase()))
    return hit ? [hit] : []
  })
}
