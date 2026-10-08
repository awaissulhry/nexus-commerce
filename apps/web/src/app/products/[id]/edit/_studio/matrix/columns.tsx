'use client'

/**
 * MX.P — the Matrix grid's column model (design §3.3, Revision): PRODUCT · SHARED · one GROUP per
 * coordinate in the read's order · `Not listed` singles.
 *
 * ## What this file does NOT build
 *
 * The cells. Every Matrix cell kind is ONE engine definition (`matrixColumnDef`, MX.G), consumed
 * here by `colId`, coordinate and a `cells` reader — the reader hands back the row's CLONE, which the
 * engine's setter mutates (see `useMatrix.commitRead`).
 * The SHARED group's `Base price` is the Information sheet's OWN column def, taken from
 * `buildMasterColumns` and re-grouped (`feedback_shared_components_no_copy_props`). The identity band
 * is the Variants page's shared `VariantIdentity`. The Nexus product status (`ACTIVE` …) is NOT shown:
 * since 2026-10-04 (Owner) it is the Products list's catalog status, not a selling state, and the
 * Information page's Shared scope dropped it — each market's own Status column says whether it sells.
 *
 * What is genuinely this page's: the group shape, the strip tag, the `Not listed` column (hidden at first, Owner
 * 2026-10-08: one footer line names those coordinates, `notListedLine`), the `Stock` column (a read of
 * `MatrixRowRead.stock`, never a number derived here), the `Case` column (a read of `MatrixRowRead.pack`, Step 3) and the
 * locked `FBA qty` column (a read of `MatrixRowRead.fba`). No Sync column (Owner 2026-10-08, `drawnCells`).
 */
import type { MutableRefObject } from 'react'

import { CellAction, type MenuItemDef } from '@/design-system/components'
import { Pill, Tag } from '@/design-system/primitives'
import { poolSourceSentence } from '@/app/_shared/stock-pool/PoolSourceTag'
import {
  EmptyValue, ExpandButton, ExpandSlot, formatGridValue, groupToneClasses, IdentityBand, ProvenanceMark, groupToneHeaderClasses, LockGlyph, lockedColumn, matrixColumnDef, numericColumn, withGroupHeaderClass,
  WarnGlyph, type CellSaveTracker, type ColDef, type ColGroupDef, type HeaderGroupTone, type ICellRendererParams, type LockedCellParams, type MatrixColumnOptions,
} from '@/design-system/grid'
import { FBA_SEND_COPY, fbaInboundShown } from '@nexus/shared/fba-send'

import { when } from '../drawer/format'
import { buildMasterColumns } from '../sheet/master/columns'
import type { SheetColumn, StudioRow } from '../sheet/master/types'
import { ProductRoleChip } from '../sheet/ProductRoleChip'
import { sharedProgressColumn } from '../sheet/progressColumns'
import type { AxisSummary } from '../variants/family/coverage'

import { MATRIX_ABSENT_CELL_LABELS, MATRIX_COPY, type CoordinateKey, type FulfilmentMethod, type MatrixAbsentCellKind, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixFbaPlan, type MatrixRowRead } from './contract'
import { refusedTooltip } from './refusals'
import { CASE_EDIT_COPY, CASE_HEADER_TIP, CASE_LABEL, caseCellView, type CaseCellView } from './casePack'
import { FROM_COL_W, FROM_LABEL, fromBefore, fromCellText, fromCellView, isMatrixFromColId, matrixFromColId } from './sellsFrom'
import styles from './matrix.module.css'

/**
 * The identity column's id — `identity`, the same id the Variants page uses and the one
 * `scripts/check-layout-v2.mjs` measures. AG holds column ids and group ids in ONE namespace, so
 * every group id below is `grp-` prefixed (a `product` column inside a `product` group is renamed
 * `product_1` with warning #273).
 */
export const IDENTITY_COL = 'identity'
/** §3.3: the identity column FIXED at 380 (the same reasoning as the Variants page: a fixed slot set). */
/**
 * The Product column: 380 wide at every screen width. On a phone it is not pinned (the Information page's own rule,
 * `sheet/useNarrowSheet.ts`, 2026-10-08): it scrolls away with the row, so the coordinate columns can be reached and the
 * SKU is never cut to "GAL…" (the 2026-09-30 shrink-to-160 did that).
 */
export const IDENTITY_COL_W = 380
export const BASE_PRICE_COL = 'basePrice'
/**
 * MX.F item 2, measured on the live page at 1440/1728: at 100px the header's 10/10 padding and the 16px menu button left a
 * 56px label box for a 59.02px `Base price` (11.5px/700 Inter) → `Base pr…`. 120 fits the text, the menu button AND the sort
 * indicator AG adds once the column is sorted (59 + 16 + 16 + gaps inside 100). `Stock` 96 (32.1px) and `Status` 104 (36.3px) fit.
 */
export const BASE_PRICE_COL_W = 120
export const STOCK_COL = 'shared.stock'
/** The Case column (Step 3, Owner 2026-10-07): units per case, case size and weight, FBA prep and labels — the pop-up writes it. */
export const CASE_COL = 'shared.case'
export const CASE_COL_W = 104
/** The FBA qty column (Owner 2026-10-06): Amazon's FBA units, shown and LOCKED — nothing on this page can write it. */
export const FBA_COL = 'shared.fba'
/* 112 (2026-10-08): every Matrix header now carries the ⋮ menu, which cut "FBA qty" to "FBA …" at 96. */
export const FBA_COL_W = 112
/**
 * The Matrix's own minimum per cell kind where the header's ⋮ menu (on every column since the audit, 2026-10-08) left
 * too little room for its name: "Buffer" read "B…" at the engine's 76. Wider kinds keep the engine's width.
 */
const MATRIX_MENU_WIDTHS: Partial<Record<MatrixCellKind, number>> = { syncBuffer: 100 }
export const NOT_LISTED_W = 120

export const matrixColId = (key: CoordinateKey, kind: MatrixCellKind | 'notListed'): string => `${key}.${kind}`

/**
 * The Status column of one market (Owner 2026-10-07): the Information page's own Status column (`statusColumn`), once
 * per market, right after Listing. Its id is not a Matrix cell id (`parseMatrixColId` → null), so no Matrix write path
 * can take it: its values are the publish actions' (`usePublishActions`), written by `usePublishCellEditing`.
 */
export const matrixStatusColId = (key: CoordinateKey): string => `${key}.status`
export const isMatrixStatusColId = (colId: string | null | undefined): boolean => !!colId && colId.lastIndexOf('.') > 0 && colId.endsWith('.status')
/** The market group a column belongs to (its coordinate key): a Matrix cell's, a market's Status or From; null for the rest. */
export function matrixGroupKeyOf(colId: string | null | undefined): CoordinateKey | null {
  const parsed = parseMatrixColId(colId)
  if (parsed) return parsed.key
  // A market's Status and From columns belong to its group too.
  return isMatrixStatusColId(colId) || isMatrixFromColId(colId) ? colId!.slice(0, colId!.lastIndexOf('.')) : null
}
/** A market that draws a Status column: one with a Listing cell (a listed market, or an alias), never a region's inventory. */
export const hasMatrixStatus = (coord: Pick<MatrixCoordinate, 'connected' | 'cells'>): boolean => coord.connected && coord.cells.includes('listing')

/**
 * The cells a group DRAWS: every kind it serves but `syncState` (Owner 2026-10-08). The Sync column folded into the Qty
 * and Price cells (a failed push is their ✗, the Amazon EU conflict the Qty cell's ⚠); the server still serves the kind,
 * because the Edit dialog's "Stock sync" (hold · release · push · retry) is offered where a group serves it.
 * Columns, presets, Customise, saved views and the export all read this list.
 */
export const drawnCells = (coord: Pick<MatrixCoordinate, 'cells'>): MatrixCellKind[] => coord.cells.filter((k) => k !== 'syncState')

/** `AMAZON:IT.price` → `{ key: 'AMAZON:IT', kind: 'price' }`; a non-Matrix id → null. Keys carry no `.`. */
export function parseMatrixColId(colId: string | undefined | null): { key: CoordinateKey; kind: MatrixCellKind } | null {
  if (!colId) return null
  const i = colId.lastIndexOf('.')
  if (i <= 0) return null
  const key = colId.slice(0, i)
  const kind = colId.slice(i + 1)
  if (key === 'shared') return null
  const kinds: readonly string[] = ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice']
  return kinds.includes(kind) ? { key, kind: kind as MatrixCellKind } : null
}

/* ── the group colours ────────────────────────────────────────────────────────────────────── */

/**
 * The Owner, 2026-10-08: the Matrix's groups wear colours "just like the product information page" — the same tones
 * (`tokens/groupTones.ts`) through the same DS helper (`grid/columns/groupTone.ts`), ONE colour per channel, the same in
 * every family and in Customise. Product: none (the Information page leaves its identity column plain). Progress: slate
 * (its group on the Information page). Shared: emerald (price and stock are "Offer" there). Red and yellow stay free:
 * they mean danger and warning.
 */
const CHANNEL_TONES: Readonly<Record<string, string>> = { AMAZON: 'orange', EBAY: 'blue', SHOPIFY: 'purple', ETSY: 'pink', WOOCOMMERCE: 'violet' }
export const MATRIX_GROUP_TONES = { progress: 'slate', shared: 'emerald' } as const
/** A channel's colour; any channel without its own: cyan. */
export const channelTone = (channel: string | null | undefined): string => CHANNEL_TONES[(channel ?? '').toUpperCase()] ?? 'cyan'

/* ── the identity cell ────────────────────────────────────────────────────────────────────── */

interface IdentityParams {
  axesRef: MutableRefObject<AxisSummary[]>
  rowMenuRef: MutableRefObject<(row: StudioRow) => MenuItemDef[]>
  /** The parent's chevron: are the variants folded away (read at paint time), and the toggle. */
  variantsCollapsedRef: MutableRefObject<boolean>
  onToggleVariants: () => void
}

/**
 * The Product cell, composed EXACTLY as the Information page's (`sheet/master/useMasterSheetAdapter.tsx` `ProductCell`,
 * Matrix audit 2026-10-08): the tree control (the parent's chevron folds its variants; a variant keeps the empty slot so
 * every SKU starts on one x), the role chip, the picture with its "inherited" mark, the SKU, and the axis values as the
 * second line — none on the parent (the toolbar counts the variants once).
 */
function MatrixIdentity(p: ICellRendererParams<StudioRow> & Partial<IdentityParams>) {
  const d = p.data
  if (!d) return null
  const expanded = !(p.variantsCollapsedRef?.current ?? false)
  const expand = d.isParent && d.childCount > 0
    ? <ExpandButton expanded={expanded} onToggle={() => p.onToggleVariants?.()} labels={['Show the variants', 'Fold the variants away']} />
    : <ExpandSlot />
  const axes = d.isParent ? '' : (p.axesRef?.current ?? []).map((axis) => d.axisValues?.[axis.key] ?? '—').join(' · ')
  const suspect = (d as StudioRow & { axisValuesSuspect?: Array<{ reason: string }> }).axisValuesSuspect ?? []
  const secondary = axes || suspect.length
    ? <>{axes}{suspect.length > 0 && <span className="nds-cell-warning" role="img" aria-label="Shared axis values need review"> <WarnGlyph /></span>}</>
    : undefined
  return (
    <IdentityBand
      expand={expand}
      role={<ProductRoleChip product={{ isParent: d.isParent, parentId: d.parentId ?? null, childCount: d.childCount }} />}
      image={d.imageUrl} noImage={!d.imageUrl}
      imageMark={d.imageInherited ? <ProvenanceMark provenance="inherited" tooltip="Inherited from the family's picture — this variation has none of its own" /> : null}
      sku={d.sku}
      secondary={secondary}
      secondaryTitle={suspect.map((entry) => entry.reason).join(' ') || axes || undefined}
      menuItems={p.rowMenuRef?.current(d)}
      menuLabel={`Actions for ${d.sku}`}
    />
  )
}

/* ── the strip tag ────────────────────────────────────────────────────────────────────────── */

/**
 * The coordinate's strip label + roll-up tag (`19 listed · 1 not listed`). `listed: null` = not counted
 * → NO tag, never `0 listed` (rule 7). A counted zero is shown: it is a fact.
 */
/**
 * The strip's title. A LISTED coordinate: its cell count (+ the EU note). Item 8(b): a coordinate that is CONNECTED but has
 * no listing (`connected: true, cells: []` — Amazon NL, eBay FR…) says so; ONLY an unconnected one (WooCommerce) says no
 * account is connected. The same two sentences head the `Not listed` column.
 */
export function notListedTitle(c: MatrixCoordinate): string {
  if (!c.connected) return `${c.label} — ${MATRIX_COPY.noAccountConnected}`
  if (c.cells.length === 0) return `${c.label} — ${MATRIX_COPY.noListingYet}`
  const n = drawnCells(c).length
  return `${c.label} — ${n} ${n === 1 ? 'cell' : 'cells'}${c.sharedInventoryWith ? ` · ${MATRIX_COPY.sharedEu(c.sharedInventoryWith)}` : ''}`
}

/** `Amazon · IT` → `IT`, `eBay · IT ②` → `IT ②`, `WooCommerce` → `` — a coordinate's place inside its channel. */
const placeOf = (c: Pick<MatrixCoordinate, 'label'>): string => (c.label.includes(' · ') ? c.label.split(' · ').slice(1).join(' · ') : '')

/** `Amazon IT DE FR · eBay IT` — coordinates said by channel, in the read's order (each channel once). */
export function placesText(coords: ReadonlyArray<Pick<MatrixCoordinate, 'label'>>): string {
  const byChannel = new Map<string, string[]>()
  for (const c of coords) {
    const name = c.label.includes(' · ') ? c.label.split(' · ')[0]! : c.label
    const places = byChannel.get(name) ?? []
    const place = placeOf(c)
    if (place && !places.includes(place)) places.push(place)
    byChannel.set(name, places)
  }
  return [...byChannel.entries()].map(([name, places]) => (places.length ? `${name} ${places.join(' ')}` : name)).join(' · ')
}

/**
 * The footer's ONE line for the coordinates this family is not listed on (Owner 2026-10-08) — their `Not listed` columns
 * start hidden, and Customise shows them: `Not listed: Amazon NL BE PL · eBay FR ES`. Null when every coordinate is listed.
 */
export function notListedLine(coords: readonly MatrixCoordinate[]): string | null {
  const gone = coords.filter((c) => !c.connected || c.cells.length === 0)
  return gone.length ? `Not listed: ${placesText(gone)}` : null
}

/**
 * Customise's hint (Owner 2026-10-08): the cells a coordinate has no store for, GROUPED BY CELL — `B2B price, Tiers —
 * Amazon IT DE FR: <reason> · Sale — eBay IT: <reason>; Etsy: <reason> · Fulfilment — Shopify: …` — instead of one line
 * per coordinate and cell. Inside a cell, the places that share a reason are said once; cells whose places and reasons
 * are the same (B2B price and Tiers) are one group. The server's own sentences are kept whole. Null when nothing is absent.
 */
/**
 * Customise's ONE short line (Owner 2026-10-08, audit: the grouped paragraph filled a quarter of the dialog at 390 px):
 * the cells some channels do not offer — `Not on every channel: B2B price, Tiers, Sale`. The reasons, word for word,
 * are its info tip (`absentHint`). Null when nothing is absent.
 */
export function absentLine(coords: readonly MatrixCoordinate[]): string | null {
  const cells = [...new Set(coords.flatMap((c) => c.absent.map((a) => a.cell)))]
  return cells.length ? `Not on every channel: ${cells.map((cell) => MATRIX_ABSENT_CELL_LABELS[cell]).join(', ')}` : null
}

export function absentHint(coords: readonly MatrixCoordinate[]): string | null {
  const byCell = new Map<MatrixAbsentCellKind, Map<string, MatrixCoordinate[]>>()
  for (const c of coords) for (const a of c.absent) {
    const reasons = byCell.get(a.cell) ?? new Map<string, MatrixCoordinate[]>()
    reasons.set(a.reason, [...(reasons.get(a.reason) ?? []), c])
    byCell.set(a.cell, reasons)
  }
  const groups = new Map<string, MatrixAbsentCellKind[]>()
  for (const [cell, reasons] of byCell) {
    const body = [...reasons].map(([reason, cs]) => `${placesText(cs)}: ${reason}`).join('; ')
    groups.set(body, [...(groups.get(body) ?? []), cell])
  }
  const lines = [...groups].map(([body, cells]) => `${cells.map((cell) => MATRIX_ABSENT_CELL_LABELS[cell]).join(', ')} — ${body}`)
  return lines.length ? `Not offered here: ${lines.join(' · ')}` : null
}

/**
 * The group's roll-up tag: `20 listed`, `0 listed · 1 not listed` (a draft is Not listed — one set of selling words,
 * Owner 2026-10-04); null for a group that serves no `Listing` cell.
 */
export function stripTag(c: MatrixCoordinate | undefined): string | null {
  /* A group that serves no `Listing` cell (the EU inventory group) has nothing to count: no tag,
     rather than a `0 listed` that reads as "nothing is listed here". */
  return c && c.listed !== null && c.cells.includes('listing')
    ? `${c.listed} listed${c.draft !== null && c.draft > 0 ? ` · ${c.draft} not listed` : ''}`
    : null
}

/** The strip's tooltip: the whole name, and the counts — which a narrow group moves off its line (matrix.module.css). */
export function stripTitle(c: MatrixCoordinate | undefined, displayName: string): string {
  if (!c) return displayName
  const tag = stripTag(c)
  return tag ? `${notListedTitle(c)} · ${tag}` : notListedTitle(c)
}

export function MatrixGroupHeader(p: { displayName: string; coordinate?: MatrixCoordinate }) {
  const c = p.coordinate
  const tag = stripTag(c)
  return (
    <span className="nds-matrix-strip" title={stripTitle(c, p.displayName)}>
      <span className="nds-matrix-strip-label">{p.displayName}</span>
      {tag && <Tag tone={c && c.listed! > 0 ? 'success' : 'neutral'} className="nds-matrix-strip-tag">{tag}</Tag>}
    </span>
  )
}

/* ── the stock cell ───────────────────────────────────────────────────────────────────────── */

function stockOf(row: MatrixRowRead | null): MatrixRowRead['stock'] | null { return row?.stock ?? null }

/** The Stock cell's door: the Products page's inventory editor (stock per location), for this row. */
export const STOCK_EDIT_COPY = { label: 'Stock by location', detail: 'Enter or F2 opens the stock per location.' } as const

function StockCell(p: ICellRendererParams<StudioRow> & { rowOf?: (id: string) => MatrixRowRead | null; onOpenStock?: (rowId: string) => void }) {
  const d = p.data
  const s = d ? stockOf(p.rowOf?.(d.id) ?? null) : null
  if (!d || !s) return null
  const open = p.onOpenStock
    ? <CellAction label={STOCK_EDIT_COPY.label} description={STOCK_EDIT_COPY.detail} onActivate={() => p.onOpenStock?.(d.id)}
        onFocusCell={() => { const col = p.column?.getColId(); if (p.node.rowIndex != null && col) p.api.setFocusedCell(p.node.rowIndex, col) }} />
    : null
  if (s.uncounted) return <span className={styles.stockShared}>{open}<span className="nds-cell-value nds-cell-stock-out"><span className="nds-cell-value-text"><WarnGlyph /> {MATRIX_COPY.uncounted}</span></span></span>
  const number = <span className="nds-cell-value nds-cell-num"><span className="nds-cell-value-text">{s.available ?? '—'}</span></span>
  // Shared stock by SKU: a SKU that sells from another business's stock says so; the tooltip names the business.
  if (s.source) return <span className={styles.stockShared}>{open}{number}<Pill tone="info">Shared</Pill></span>
  return open ? <span className={styles.stockShared}>{open}{number}</span> : number
}

/**
 * Shared stock by SKU (Owner 2026-10-01): a Qty or Mode cell whose number follows ANOTHER business's stock right now —
 * the row sells from a lent stock and the listing follows it (a fixed, paused or Amazon-managed listing does not). Such a
 * cell carries the DS state `nds-cell-is-shared-stock` (violet) and says the lender in its tooltip: never colour alone.
 */
export const SHARED_STOCK_CELL = 'nds-cell-is-shared-stock'
export function sharedStockOf(sync: MatrixCells['sync'] | null | undefined, source: MatrixRowRead['stock']['source']): NonNullable<MatrixRowRead['stock']['source']> | null {
  return source && sync?.kind === 'FOLLOW' ? source : null
}

/** The Stock cell's tooltip: where the number comes from, and which warehouses hold it. */
export function stockTooltip(s: MatrixRowRead['stock']): string {
  if (s.uncounted) return MATRIX_COPY.uncountedHint
  const where = s.locations.length ? s.locations.map((l) => `${l.code} ${l.available}`).join(' · ') : 'No routed location'
  if (!s.source) return where
  return `${poolSourceSentence({ lenderName: s.source.lenderName, available: s.available ?? 0 })} ${where}. This business's own stock is not used.`
}

/* ── the Case cell (Step 3) ─────────────────────────────────────────────────────────────────── */

/** A row's Case view: a variant its own; the parent sums up its variants (every other Matrix row). */
export function caseViewOf(rowId: string, rowOf: (id: string) => MatrixRowRead | null, rows: readonly { id: string }[]): CaseCellView {
  const row = rowOf(rowId)
  if (row?.role !== 'parent') return caseCellView(row)
  return caseCellView(row, rows.flatMap((r) => { const m = r.id === rowId ? null : rowOf(r.id); return m && m.role !== 'parent' ? [m] : [] }))
}

function CaseCell(p: ICellRendererParams<StudioRow> & { viewOf?: (rowId: string) => CaseCellView; onOpenCase?: (rowId: string, anchor: HTMLElement | null) => void }) {
  const d = p.data
  if (!d || !p.viewOf) return null
  const v = p.viewOf(d.id)
  const open = v.door && p.onOpenCase
    ? <CellAction label={CASE_EDIT_COPY.label} description={CASE_EDIT_COPY.detail} onActivate={(anchor) => p.onOpenCase?.(d.id, anchor)}
        onFocusCell={() => { const col = p.column?.getColId(); if (p.node.rowIndex != null && col) p.api.setFocusedCell(p.node.rowIndex, col) }} />
    : null
  // No case size: the grid's empty cell (the muted dash every empty Matrix cell draws); the pencil still opens the pop-up.
  const text = v.look === 'none'
    ? <EmptyValue />
    : <span className={`nds-cell-value${v.look === 'mixed' ? ' nds-cell-muted' : ''}`}><span className="nds-cell-value-text">{v.text}</span></span>
  return open ? <span className={styles.stockShared}>{open}{text}</span> : text
}

/* ── the FBA qty cell ─────────────────────────────────────────────────────────────────────── */

/** The FBA number a row shows: units, or null for "no FBA row" AND for "not read" (the tooltip tells them apart). */
export function fbaUnitsOf(row: MatrixRowRead | null | undefined): number | null {
  return row?.fba?.units ?? null
}

/**
 * Send to FBA (Step 4): the muted "+24" after the FBA number — the bigger of Amazon's inbound units and the units Nexus
 * marked Shipped that Amazon has not counted yet (`fbaInboundShown`: never their sum); null when none. Planned units
 * (not shipped) never make a "+N".
 */
export function fbaInboundText(row: Pick<MatrixRowRead, 'fbaInbound'> | null | undefined): string | null {
  const units = fbaInboundShown(row?.fbaInbound)
  return units > 0 ? FBA_SEND_COPY.inbound(units) : null
}

/** The open plans a row's planned units sit in, by their short tag (`#a1b2c3`, the end of the Amazon plan name). */
const planTags = (plans: readonly MatrixFbaPlan[]): string => plans.map((p) => `#${p.id.slice(-6)}`).join(', ')

/**
 * The FBA qty cell's tooltip: how many units and where, when Nexus last updated them, Amazon's inbound (working, shipped,
 * receiving) and the units in open Nexus plans, and — on every row, whatever the number — why the cell is locked. `null`
 * (no FBA row) and `undefined` (not read) say different things: neither is `0`.
 * The product sheet's Amazon FBA qty column reads it too (`sheet/channel/stockColumns.tsx`).
 */
export function fbaTooltip(row: (Pick<MatrixRowRead, 'role' | 'fba'> & Partial<Pick<MatrixRowRead, 'fbaInbound'>>) | null | undefined, plans: readonly MatrixFbaPlan[] = []): string {
  const f = row?.fba
  const lines: string[] = []
  if (f === undefined) lines.push(MATRIX_COPY.fbaNotRead)
  else if (f === null) lines.push(MATRIX_COPY.fbaNone)
  else {
    lines.push(`${row?.role === 'parent' ? 'Family total: ' : ''}${MATRIX_COPY.fbaUnits(f.units, f.locations.map((l) => `${l.code} ${l.units}`))}`)
    if (f.updatedAt && Number.isFinite(Date.parse(f.updatedAt))) lines.push(`Last updated in Nexus ${when(f.updatedAt)}`)
  }
  const inbound = row?.fbaInbound
  if (inbound && inbound.units > 0) {
    lines.push(FBA_SEND_COPY.inboundDetail(inbound.units, inbound.working, inbound.shipped, inbound.receiving))
    if (inbound.readAt && Number.isFinite(Date.parse(inbound.readAt))) lines.push(`read ${when(inbound.readAt)}`)
  }
  if (inbound && (inbound.sent ?? 0) > inbound.units) lines.push(FBA_SEND_COPY.sentNotCounted(inbound.sent!))
  if (inbound && inbound.planned > 0) lines.push(plans.length ? FBA_SEND_COPY.inPlan(inbound.planned, planTags(plans)) : `${inbound.planned} in open Nexus plans`)
  lines.push(MATRIX_COPY.fbaLocked)
  return lines.join(' · ')
}

/**
 * The FBA qty cell: Amazon's number, Amazon's inbound "+24" muted after it (Step 4), and the DS lock — the same parts
 * as the DS `LockedCell`. The value stays the FBA number: a sort, a copy and an export read 92, never "92 +24".
 */
function FbaQtyCell(p: ICellRendererParams<StudioRow> & LockedCellParams & { rowOf?: (id: string) => MatrixRowRead | null }) {
  const f = formatGridValue(p.kind ?? 'integer', p.value)
  const inbound = p.data ? fbaInboundText(p.rowOf?.(p.data.id)) : null
  return (
    <span className="nds-cell-locked">
      {f.empty ? '—' : f.text}
      {inbound && <span className="nds-cell-muted">{inbound}</span>}
      <LockGlyph reason={p.reason} />
    </span>
  )
}

/* ── the From cell ("Sells from", Step 2) ─────────────────────────────────────────────────────── */

/** The From cell's door: the "Sells from" pop-up for this row on this market group. */
export const FROM_EDIT_COPY = { label: 'Sells from', detail: 'Enter or F2 opens the warehouses it sells from.' } as const
export const FROM_HEADER_TIP = 'The warehouses this market sells from, in sale order. Listings show the sum.'

interface FromCellParams {
  coordinate: MatrixCoordinate
  rowOf: (id: string) => MatrixRowRead | null
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  onOpenFrom?: (rowId: string, key: CoordinateKey, anchor: HTMLElement | null) => void
}

function FromCell(p: ICellRendererParams<StudioRow> & Partial<FromCellParams>) {
  const d = p.data
  if (!d || !p.coordinate || !p.rowOf || !p.cellsOf) return null
  const coord = p.coordinate
  const v = fromCellView(p.rowOf(d.id), p.cellsOf(d.id, coord.key), coord)
  // Nothing to say here (a parent, a row with no source): the grid's empty cell, the same dash as every other column.
  if (v.look === 'none') return <EmptyValue />
  if (v.look === 'shared') return <span className="nds-cell-value"><Pill tone="info">{v.text}</Pill></span>
  const open = v.door && p.onOpenFrom
    ? <CellAction label={FROM_EDIT_COPY.label} description={FROM_EDIT_COPY.detail} onActivate={(anchor) => p.onOpenFrom?.(d.id, coord.key, anchor)}
        onFocusCell={() => { const col = p.column?.getColId(); if (p.node.rowIndex != null && col) p.api.setFocusedCell(p.node.rowIndex, col) }} />
    : null
  // Muted while it follows the market default; normal weight once this product has its own choice.
  return <span className="nds-cell-value"><span className={`nds-cell-value-text${v.look === 'own' ? '' : ' nds-cell-muted'}`}>{v.text}</span>{open}</span>
}

function NotListedCell() {
  return <span className="nds-cell-value nds-cell-muted"><span className="nds-cell-value-text">{MATRIX_COPY.notListed}</span></span>
}

/* ── the whole model ──────────────────────────────────────────────────────────────────────── */

export interface BuildMatrixColumnsOptions {
  /** The coordinates ON SCREEN, in the read's (= the contract's) order — already scope-filtered. */
  coordinates: readonly MatrixCoordinate[]
  /** A row's cells on a coordinate, read at PAINT time — a new read repaints without a rebuild. */
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  rowOf: (rowId: string) => MatrixRowRead | null
  tracker: CellSaveTracker
  /** The sheet's column set — `Base price` and `Status` are taken from it, never rebuilt. */
  sheetColumns: readonly SheetColumn[]
  locale: string
  market: string
  axesRef: MutableRefObject<AxisSummary[]>
  rowMenuRef: MutableRefObject<(row: StudioRow) => MenuItemDef[]>
  /** The fulfilment select's CHOICE — the engine's setter routes it here and writes nothing (§3.4). */
  onPickFulfilment: (method: FulfilmentMethod, params: ICellRendererParams) => void
  rowsRef: MutableRefObject<StudioRow[]>
  /** The parent's chevron (`MatrixIdentity`): are the variants folded away, and the toggle. */
  variantsCollapsedRef?: MutableRefObject<boolean>
  onToggleVariants?: () => void
  /** A market's Status column (the page builds it with `statusColumn`), placed right after its Listing; null = none. */
  statusColumnOf?: (coord: MatrixCoordinate) => ColDef<StudioRow> | null
  /** The Stock cell opens the stock per location for a row (absent = no door: no right to adjust stock). */
  onOpenStock?: (rowId: string) => void
  /** A market's From cell opens "Sells from" (absent = no door: no right to adjust stock, or no warehouse). */
  onOpenFrom?: (rowId: string, key: CoordinateKey, anchor: HTMLElement | null) => void
  /** The Case cell opens the Case pop-up for a row (absent = no door: no right to adjust stock). */
  onOpenCase?: (rowId: string, anchor: HTMLElement | null) => void
  /** Send to FBA (Step 4): this family's open plans, read at PAINT time (the FBA qty tooltip names them). */
  fbaPlansOf?: () => readonly MatrixFbaPlan[]
}

const rowId = (r: StudioRow) => r.id

export function buildMatrixColumns(opts: BuildMatrixColumnsOptions): (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] {
  const { coordinates, cellsOf, rowOf, tracker, sheetColumns, locale, market, axesRef, rowMenuRef, onPickFulfilment, rowsRef } = opts
  const identityWidth = IDENTITY_COL_W

  const identity: ColDef<StudioRow> = {
    colId: IDENTITY_COL,
    headerName: 'Product',
    /* Still a FIXED slot at any one grid width (min = max = width): only the grid's own width changes it. */
    width: identityWidth, minWidth: identityWidth, maxWidth: identityWidth, resizable: false,
    pinned: 'left', lockPinned: true, lockPosition: 'left',
    suppressMovable: true, suppressHeaderMenuButton: true, sortable: false,
    cellClass: 'nds-ag-cell',
    cellRenderer: MatrixIdentity,
    cellRendererParams: { axesRef, rowMenuRef, variantsCollapsedRef: opts.variantsCollapsedRef, onToggleVariants: opts.onToggleVariants },
    headerTooltip: 'The parent and its variants',
    getQuickFilterText: (p) => `${p.data?.sku ?? ''} ${p.data?.name ?? ''}`,
  }

  /* The SHARED group: the sheet's own `basePrice` and `status` defs, re-grouped. `grouped: false`
     hands back flat ColDefs; `reservedColumnIds` keeps the identity band's `sku` out. */
  const sheetDefs = buildMasterColumns(
    { columns: [...sheetColumns], tracker, locale, market, reservedColumnIds: [IDENTITY_COL, 'sku'], grouped: false },
    rowsRef,
  ) as ColDef<StudioRow>[]
  const byId = new Map(sheetDefs.map((c) => [(c.colId ?? '').toLowerCase(), c]))
  const basePriceFallback: ColDef<StudioRow> = {
    colId: BASE_PRICE_COL, headerName: 'Base price', width: BASE_PRICE_COL_W, minWidth: BASE_PRICE_COL_W, editable: false,
    valueGetter: (p) => p.data?.basePrice ?? null, cellClass: 'nds-ag-cell nds-cell-num',
  }
  const basePrice: ColDef<StudioRow> = { ...(byId.get(BASE_PRICE_COL.toLowerCase()) ?? basePriceFallback), suppressMovable: true }
  const stock: ColDef<StudioRow> = {
    colId: STOCK_COL,
    headerName: 'Stock',
    headerTooltip: 'The routed WAREHOUSE pool this SKU follows — the number Follow rows derive from. "Shared": the stock another business lends. Parent = the family total. Enter or the pencil opens the stock per location.',
    width: 112, minWidth: 96,
    editable: false, suppressMovable: true, sortable: true, resizable: true,
    /* A number column: right-aligned with tabular figures, as FBA qty and every market's Qty and Price beside it. */
    type: numericColumn.type, cellClass: [...numericColumn.cellClass, 'nds-reveal-row'], headerClass: numericColumn.headerClass,
    valueGetter: (p) => (p.data ? stockOf(rowOf(p.data.id))?.available ?? null : null),
    cellRenderer: StockCell,
    cellRendererParams: { rowOf, onOpenStock: opts.onOpenStock,
      suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
    tooltipValueGetter: (p) => {
      const s = p.data ? stockOf(rowOf(p.data.id)) : null
      if (!s) return undefined
      return stockTooltip(s)
    },
    getQuickFilterText: (p) => { const s = p.data ? stockOf(rowOf(p.data.id)) : null; return s?.uncounted ? MATRIX_COPY.uncounted : `${s?.available ?? ''}${s?.source ? ` shared ${s.source.lenderName}` : ''}` },
  }

  /* The Case column (Step 3): a read of `MatrixRowRead.pack`; the pop-up is its only writer. A sort, a copy and an export
     read the number (units per case); the cell says `12 / case`, the parent `Mixed` when its variants differ. */
  const caseView = (data: StudioRow | undefined) => (data ? caseViewOf(data.id, rowOf, rowsRef.current) : null)
  const caseCol: ColDef<StudioRow> = {
    colId: CASE_COL,
    headerName: CASE_LABEL,
    headerTooltip: CASE_HEADER_TIP,
    width: CASE_COL_W, minWidth: 96,
    editable: false, suppressMovable: true, suppressFillHandle: true, suppressPaste: true, sortable: true, resizable: true,
    type: numericColumn.type, cellClass: [...numericColumn.cellClass, 'nds-reveal-row'], headerClass: numericColumn.headerClass,
    valueGetter: (p) => caseView(p.data)?.value ?? null,
    cellRenderer: CaseCell,
    cellRendererParams: { viewOf: (id: string) => caseViewOf(id, rowOf, rowsRef.current), onOpenCase: opts.onOpenCase,
      suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
    tooltipValueGetter: (p) => caseView(p.data)?.tooltip,
    getQuickFilterText: (p) => caseView(p.data)?.text ?? '',
  }

  /* The DS locked column (`lockedColumn`, GRID.md rule 10: the lock is in the DEFINITION) — not editable, not movable, no
     fill handle, the lock glyph in the cell and the locked tint on it. Its value is a READ of `MatrixRowRead.fba`, the
     same way Stock reads `stock`: a copy, an export and a sort read the number; nothing can paste one back. Step 4: the
     cell adds Amazon's inbound "+24" (muted) before the lock, and the tooltip its breakdown and the open plans. */
  const fbaPlansOf = opts.fbaPlansOf ?? (() => [])
  const fba: ColDef<StudioRow> = {
    ...lockedColumn<StudioRow>(FBA_COL, { kind: 'integer', reason: MATRIX_COPY.fbaLocked }),
    field: undefined,
    colId: FBA_COL,
    headerName: 'FBA qty',
    headerTooltip: `Units Amazon holds at its FBA warehouses for this SKU; "+N" = on its way to Amazon. ${MATRIX_COPY.fbaLocked}. Parent = the family total.`,
    width: FBA_COL_W, minWidth: FBA_COL_W,
    suppressFillHandle: true, suppressPaste: true, sortable: true, resizable: true,
    cellRenderer: FbaQtyCell,
    cellRendererParams: { kind: 'integer', reason: MATRIX_COPY.fbaLocked, rowOf },
    cellClassRules: { 'nds-cell-is-locked': () => true },
    valueGetter: (p) => (p.data ? fbaUnitsOf(rowOf(p.data.id)) : null),
    valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
    tooltipValueGetter: (p) => (p.data ? fbaTooltip(rowOf(p.data.id), fbaPlansOf()) : undefined),
    getQuickFilterText: (p) => { const n = p.data ? fbaUnitsOf(rowOf(p.data.id)) : null; return n == null ? '' : `${n} fba` },
  }

  /* Every group's label sits at its start edge, in one header (`MatrixGroupHeader`), and wears its colour; each column
     NAME under it wears the same colour (`toneOf`, below). */
  const toneOf = new Map<string, HeaderGroupTone>()
  const group = (groupId: string, headerName: string, tone: string | null, children: ColDef<StudioRow>[], coordinate?: MatrixCoordinate): ColGroupDef<StudioRow> => {
    for (const child of children) if (child.colId) toneOf.set(child.colId, { group: groupId, ...(tone ? { tone } : {}) })
    return { groupId, headerName, headerGroupComponent: MatrixGroupHeader, headerGroupComponentParams: { coordinate }, headerClass: groupToneClasses(tone), children }
  }
  const groups: ColGroupDef<StudioRow>[] = [
    group('grp-product', 'Product', null, [identity]),
    /* The progress column has its OWN header group. Inside the Product group it split that group across the pinned
       boundary (Product is pinned, progress is not) and AG drew "PRODUCT" twice — measured on production 2026-09-27. */
    group('grp-progress', 'Progress', MATRIX_GROUP_TONES.progress, [sharedProgressColumn<StudioRow>({ market: opts.market, locale: opts.locale })]),
    group('grp-shared', 'Shared', MATRIX_GROUP_TONES.shared, [{ ...basePrice, headerName: 'Base price', width: BASE_PRICE_COL_W, minWidth: BASE_PRICE_COL_W }, stock, caseCol, fba]),
  ]

  /* A market group's From column ("Sells from", Step 2): read-only here — the pop-up is its only writer. */
  const fromColumn = (coord: MatrixCoordinate): ColDef<StudioRow> => {
    const colId = matrixFromColId(coord.key)
    const view = (data: StudioRow | undefined) => (data ? fromCellView(rowOf(data.id), cellsOf(data.id, coord.key), coord) : null)
    return {
      colId,
      headerName: FROM_LABEL,
      headerTooltip: FROM_HEADER_TIP,
      width: FROM_COL_W, minWidth: 96,
      editable: false, suppressMovable: true, suppressFillHandle: true, suppressPaste: true, sortable: false, resizable: true,
      cellClass: ['nds-ag-cell', 'nds-reveal-row'],
      valueGetter: (p) => (p.data ? fromCellText(rowOf(p.data.id), cellsOf(p.data.id, coord.key), coord) : null),
      cellRenderer: FromCell,
      cellRendererParams: { coordinate: coord, rowOf, cellsOf, onOpenFrom: opts.onOpenFrom,
        suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
      tooltipValueGetter: (p) => {
        const mark = p.data ? tracker?.get(rowId(p.data), colId) : undefined
        return refusedTooltip(mark?.state === 'refused' ? mark.reason : undefined, view(p.data)?.tooltip)
      },
      getQuickFilterText: (p) => view(p.data)?.text ?? '',
    }
  }

  for (const coord of coordinates) {
    const children: ColDef<StudioRow>[] = []
    const fromAt = fromBefore(coord)
    if (!coord.connected || coord.cells.length === 0) {
      /* ONE `Not listed` column — never eight empty cells (§3.1 rule 6) — HIDDEN at first (Owner 2026-10-08): the footer
         names these coordinates in one line, and Customise shows the column. `initialHide`, so a column the operator
         showed stays shown when the column model is rebuilt. */
      children.push({
        colId: matrixColId(coord.key, 'notListed'),
        headerName: MATRIX_COPY.notListed,
        headerTooltip: notListedTitle(coord),
        initialHide: true,
        width: NOT_LISTED_W, minWidth: NOT_LISTED_W,
        editable: false, sortable: false, suppressMovable: true, suppressFillHandle: true,
        cellClass: 'nds-ag-cell nds-cell-muted',
        valueGetter: () => null,
        cellRenderer: NotListedCell,
      })
    } else {
      for (const kind of drawnCells(coord)) {
        // Fulfilment · From · Mode · Qty · Buffer
        if (kind === fromAt) children.push(fromColumn(coord))
        const o: MatrixColumnOptions<StudioRow> = {
          colId: matrixColId(coord.key, kind),
          coordinate: coord,
          cells: (data) => (data ? cellsOf(data.id, coord.key) : null),
          tracker,
          rowIdOf: rowId,
          onPickFulfilment,
          /* The app's copy table, verbatim (Appendix A) — the engine asks, the page supplies. */
          copy: MATRIX_COPY,
        }
        const def = matrixColumnDef<StudioRow>(kind, o)
        const cellTooltip = def.tooltipValueGetter
        const colId = matrixColId(coord.key, kind)
        // Shared stock by SKU: the Qty and Mode cells of a row that follows another business's stock.
        const marksShared = kind === 'syncQty' || kind === 'syncMode'
        const sharedFrom = (data: StudioRow | undefined) => (marksShared && data ? sharedStockOf(cellsOf(data.id, coord.key)?.sync, rowOf(data.id)?.stock.source ?? null) : null)
        /* A refused cell's hover leads with WHY (`refusals.ts`); the footer note is the view, this elaborates. */
        children.push({
          ...def,
          /* Every Matrix column but the identity carries the header ⋮ menu, as every column of the Information page does
             (audit 2026-10-08: only the three columns borrowed from the sheet had it) — with room for its name. */
          suppressHeaderMenuButton: false,
          ...(MATRIX_MENU_WIDTHS[kind] ? { width: MATRIX_MENU_WIDTHS[kind], minWidth: MATRIX_MENU_WIDTHS[kind] } : {}),
          ...(marksShared ? { cellClassRules: { ...(def.cellClassRules as Record<string, unknown>), [SHARED_STOCK_CELL]: (p: { data?: StudioRow }) => !!sharedFrom(p.data) } as ColDef<StudioRow>['cellClassRules'] } : {}),
          tooltipValueGetter: (p) => {
            const mark = p.data ? tracker.get(rowId(p.data), colId) : undefined
            const base = cellTooltip?.(p) as string | undefined
            const shared = sharedFrom(p.data)
            const withSource = shared ? [base, `Follows ${shared.lenderName}'s stock (shared stock).`].filter(Boolean).join('\n') : base
            return refusedTooltip(mark?.state === 'refused' ? mark.reason : undefined, withSource)
          },
        })
        if (kind === 'listing' && hasMatrixStatus(coord)) {
          const status = opts.statusColumnOf?.(coord)
          if (status) children.push(status)
        }
      }
    }
    groups.push(group(`grp-${coord.key}`, coord.label, channelTone(coord.channel), children, coord))
  }
  /* Each column NAME wears its group's colour too, the first of a group its edge — as on the Information page. */
  return withGroupHeaderClass(groups, (params) => groupToneHeaderClasses(params, (colId) => toneOf.get(colId)))
}
