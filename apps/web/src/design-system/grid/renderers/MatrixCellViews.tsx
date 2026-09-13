'use client'

/**
 * MX.G — the eight Matrix cell RENDERERS. They DRAW; `matrixCells.ts` beside this file DECIDES.
 *
 * 🔴 Named `MatrixCellViews.tsx`, not the mandate's `MatrixCells.tsx`, for a measured reason: this
 * filesystem is case-insensitive, and `tsc` resolved `./MatrixCells` to `matrixCells.ts` — TS1149
 * "differs from already included file name only in casing" (2026-09-13, first typecheck of this
 * file). Two modules whose names differ only by case cannot coexist here; the repo's own precedent
 * is `mediaCell.ts` + `MediaCellView.tsx`, and this follows it.
 *
 * Design `docs/2026-09-13-matrix-page-design.md` §3.4, Appendix A. Every word, tone, class and
 * tooltip a cell carries is read from the pure module — a renderer that wrote `sync.kind === …`
 * would have forked the vocabulary (`reference_two_column_builders_drift`). What lives here is
 * only the arrangement of glyph, word and mark inside a 36px cell.
 *
 * ## The one params shape
 *
 * `MatrixCellParams` is what `matrixColumnDef` hands every renderer, ONCE per column, as a STABLE
 * `cellRendererParams` object (`reference_ag_react_inline_options_rerun_column_model`). `facts`
 * reads the row's `MatrixCells` for this coordinate at PAINT time — so a new `MatrixRead` repaints
 * the cell without rebuilding the column model, and the cell's VALUE stays the one scalar a fill
 * may carry (`ProjectionCell` established the pattern and the reason: a value that was the whole
 * cell object would let the fill handle stamp one variant's ASIN onto nineteen others).
 *
 * ## Marks are the sheet's own
 *
 * 🔗 inherited · ✎ pinned · ƒ formula are `ProvenanceMark` — the same glyphs, the same classes,
 * the same tokens the Information sheet draws — never a second set. The three the Matrix adds are
 * characters, by the rule `provenanceMark.tsx` records for `ƒ` (every member of this vocabulary is
 * an unboxed glyph): ⚠ for a guard or pool the cell cannot back, ⇄ for a report that disagrees with
 * Nexus, ⏸ for a held push. Each is a DIFFERENT SHAPE, not a differently-coloured one — identity is
 * the glyph, never the colour (`reference_tag_identity_is_glyph_not_colour`).
 *
 * ## `ListingStateCell` is `ProjectionCell` with the tick ABSENT — a prop, not a fork
 *
 * `ProjectionCell` renders no checkbox when its VALUE is `null` (its own header: "the parent row,
 * which shows the channel's parent identity"). The Matrix's `Listing` cell is exactly that
 * rendering on every row — inclusion stays on the Variants page (design Revision) — so this file
 * passes `value: null` and maps `ListingCell` onto `ProjectionFacts`. One cell definition on both
 * pages, which is what the four added words in `projection.ts` were for.
 */
import { Fragment, memo, useCallback, type ComponentType, type ReactNode } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'

import { SelectChevron } from '../editors/SelectCellEditor'
import type { FulfilmentMethod, MatrixCellKind, MatrixCells, MatrixCoordinate, MatrixCopy } from '../matrix/contract'
import {
  MATRIX_CELL_COPY,
  MATRIX_DASH,
  MATRIX_OVERSOLD_SENTENCE,
  matrixCellState,
  matrixCellTone,
  matrixGuardDiffers,
  matrixModeWord,
  matrixMoney,
  matrixQtyText,
  matrixQueueGlyph,
  matrixQueueWord,
  matrixReportedDiffers,
  matrixSaleText,
} from './matrixCells'
import { ProjectionCell, type ProjectionCellParams, type ProjectionFacts } from './ProjectionCell'
import { ProvenanceMark } from './provenanceMark'

/** What `matrixColumnDef` hands every Matrix renderer — one STABLE object per column. */
export interface MatrixCellParams {
  kind: MatrixCellKind
  coordinate: MatrixCoordinate
  /** This row's cells for this coordinate, read at paint time. */
  facts: (params: ICellRendererParams) => MatrixCells | null
  /** `syncState` click — jump to Needs attention for this listing. */
  onJump?: (params: ICellRendererParams) => void
  /** `fulfilment` never writes inline: the select's choice opens the one-row preflight. Consumed by the column's setter. */
  onPickFulfilment?: (method: FulfilmentMethod, params: ICellRendererParams) => void
  /** The copy table. The engine default is Appendix A verbatim; the app may pass its own `MATRIX_COPY`. */
  copy?: MatrixCopy
  /** The clock `Sent <ago>` is measured against. Injectable so a screenshot compares to itself. */
  now?: () => number
}

export type MatrixCellProps = ICellRendererParams & MatrixCellParams

/* ── the shared frame: word + trailing marks ────────────────────────────────────────────── */

/**
 * `marks` is a LIST so the container is omitted when every mark is absent — its 3px lead measured as
 * the difference between `Uncounted` fitting (69px) and not (65px) at the contract's 88px.
 */
function Value({ children, muted, marks, className, version }: { children: ReactNode; muted?: boolean; marks?: ReactNode[]; className?: string; version?: number }) {
  const shown = (marks ?? []).filter((m) => m !== null && m !== undefined && m !== false)
  return (
    <span className={['nds-cell-value', muted ? 'nds-cell-muted' : '', className ?? ''].filter(Boolean).join(' ')} data-matrix-version={version}>
      <span className="nds-cell-value-text">{children}</span>
      {/* Keyed: an array child without keys is a `console.error` in React dev, on every cell. */}
      {shown.length ? <span className="nds-matrix-marks">{shown.map((m, i) => <Fragment key={i}>{m}</Fragment>)}</span> : null}
    </span>
  )
}

const Warn = ({ title }: { title: string }) => (
  <span className="nds-cell-prov nds-matrix-warn" aria-hidden title={title}>⚠</span>
)
const Reported = ({ title }: { title: string }) => (
  <span className="nds-cell-prov nds-matrix-reported" aria-hidden title={title}>⇄</span>
)
/** The ⏸ carries the LEVER on its title: at the contract's 96px a `· paused (listing)` suffix truncated the word (measured). */
const PauseGlyph = ({ via }: { via: 'POLICY' | 'LISTING' | null }) => (
  <span className="nds-matrix-pause" aria-hidden title={via === 'POLICY' ? 'Paused by the channel policy' : 'Paused by this listing'}>⏸</span>
)

/* ── Listing ────────────────────────────────────────────────────────────────────────────── */

type ListingHostParams = ICellRendererParams & ProjectionCellParams & { matrixFacts?: MatrixCellParams['facts'] }

/** `ListingCell` → `ProjectionFacts`. Module-level so `ProjectionCell` sees one identity per mount. */
const listingFacts = (params: ICellRendererParams): ProjectionFacts | null => {
  const cells = (params as ListingHostParams).matrixFacts?.(params)
  const l = cells?.listing
  if (!l) return null
  /* The mono id leads, the note takes the right edge — `ProjectionCell`'s own order. */
  return { state: l.state, detail: l.externalId ?? undefined, note: l.detail ?? undefined }
}

export const ListingStateCell = memo(function ListingStateCell(p: MatrixCellProps) {
  /* `value: null` is what makes the tick ABSENT (see the file header). */
  const host: ListingHostParams = { ...p, value: null, facts: listingFacts, matrixFacts: p.facts }
  return <ProjectionCell {...host} />
})

/* ── Fulfilment ─────────────────────────────────────────────────────────────────────────── */

export const FulfilmentCell = memo(function FulfilmentCell(p: MatrixCellProps) {
  const copy = p.copy ?? MATRIX_CELL_COPY
  const cells = p.facts(p)
  if (!cells) return null
  const f = cells.fulfilment
  if (!f || f.method == null) return <Value muted>{MATRIX_DASH}</Value>
  /* Both marks are independent facts (the guard AND the report can disagree at once), so they are
     read from the two predicates rather than from the one-word state, which has a precedence. */
  const guard = matrixGuardDiffers(f.method, f.guard)
  const reported = matrixReportedDiffers(f.method, f.reported)
  return (
    <Value
      marks={[
        <ProvenanceMark
          provenance={f.source === 'derived' ? 'inherited' : 'pinned'}
          tooltip={f.source === 'derived' ? 'Derived — nothing is stored on this listing' : copy.setHere}
        />,
        guard && <Warn title={copy.guardFba} />,
        reported && f.reported && <Reported title={copy.reported(f.reported)} />,
        cells.writable.fulfilment === true && <SelectChevron />,
      ]}
    >
      {f.method}
    </Value>
  )
})

/* ── Mode ───────────────────────────────────────────────────────────────────────────────── */

export const SyncModeCell = memo(function SyncModeCell(p: MatrixCellProps) {
  const cells = p.facts(p)
  if (!cells) return null
  const s = cells.sync
  if (!s) return <Value muted>{MATRIX_DASH}</Value>
  const state = matrixCellState('syncMode', cells)
  const word = matrixModeWord(s)
  const paused = state === 'paused-policy' || state === 'paused-listing'
  const showsMode = word !== MATRIX_DASH
  return (
    <Value
      muted={!showsMode}
      marks={[
        showsMode && !paused && s.mode === 'FOLLOW' && <ProvenanceMark provenance="inherited" tooltip="Follows the pool" />,
        showsMode && !paused && s.mode === 'PINNED' && <ProvenanceMark provenance="pinned" tooltip="Pinned" />,
        cells.writable.syncMode === true && <SelectChevron />,
      ]}
    >
      {paused && <PauseGlyph via={s.via} />}
      {word}
    </Value>
  )
})

/* ── Qty ────────────────────────────────────────────────────────────────────────────────── */

export const SyncQtyCell = memo(function SyncQtyCell(p: MatrixCellProps) {
  const copy = p.copy ?? MATRIX_CELL_COPY
  const cells = p.facts(p)
  if (!cells) return null
  const s = cells.sync
  if (!s) return <Value muted>{MATRIX_DASH}</Value>
  const state = matrixCellState('syncQty', cells)
  const text = matrixQtyText(cells, copy)
  /* Follow: the resolver's number, muted, 🔗 (§3.4). Amazon-managed and closed: the dash/word, muted.
     Pinned and paused are NOT muted — the pinned number is the operator's own, and a paused row's
     tint comes from `.nds-cell-is-paused` on the cell rather than from its text. */
  const muted = state === 'follow' || state === 'amazon-managed' || state === 'offer-closed'
  /* `Uncounted` is the warning — the WORD, in the warning-text token (R-VT-16's), with the sentence
     on the tooltip. A ⚠ beside it measured 68px against 52 available at the contract's 88px. */
  /* `data-matrix-version` (MX.P's ask): the listing's CAS token as a DOM fact, so a probe reads a version bump
     without a second edit. On the Qty cell, where the pin round trip is proven. */
  return (
    <Value
      muted={muted}
      version={cells.version}
      className={state === 'uncounted' ? 'nds-matrix-word-warn' : undefined}
      marks={[
        (state === 'follow' || (state === 'oversold' && s.kind === 'FOLLOW')) && <ProvenanceMark provenance="inherited" tooltip="Follows the pool" />,
        (state === 'pinned' || (state === 'oversold' && s.kind === 'PINNED')) && <ProvenanceMark provenance="pinned" tooltip="Pinned" />,
        state === 'oversold' && <Warn title={MATRIX_OVERSOLD_SENTENCE} />,
      ]}
    >
      {text}
    </Value>
  )
})

/* ── Buffer ─────────────────────────────────────────────────────────────────────────────── */

export const SyncBufferCell = memo(function SyncBufferCell(p: MatrixCellProps) {
  const cells = p.facts(p)
  if (!cells) return null
  const s = cells.sync
  /* `—` on Pinned / FBA / closed (§3.4) — the pure text rule decides, this only mutes the dash. */
  const text = !s || s.kind === 'FBA_EXCLUDED' || s.kind === 'CLOSED' || s.mode === 'PINNED' ? MATRIX_DASH : String(s.buffer)
  return <Value muted={text === MATRIX_DASH}>{text}</Value>
})

/* ── Sync ───────────────────────────────────────────────────────────────────────────────── */

export const SyncStateCell = memo(function SyncStateCell(p: MatrixCellProps) {
  const jump = p.onJump
  /* Hook before any early return — the rules of hooks, and this cell has two returns below. */
  const onClick = useCallback(() => jump?.(p), [jump, p])
  const cells = p.facts(p)
  if (!cells) return null
  const q = cells.queue
  if (!q) return <Value muted>{MATRIX_DASH}</Value>
  const now = p.now?.() ?? Date.now()
  /* Appendix A's word for the reader (`Sent 2 min`, `Paused · policy`); §3.4's glyph + short word on screen. */
  const word = matrixQueueWord(cells, now)
  const tone = matrixCellTone('syncState', cells)
  const at = matrixQueueGlyph(cells, now)
  if (!at) return <Value muted>{MATRIX_DASH}</Value>
  const { glyph, word: short } = at
  /* A BUTTON, because a click is the design (§3.4: "click = jump to Needs attention"). It is
     `aria-label`led with the word so a reader hears the state and the destination, and the cell's
     own tooltip (the column's `tooltipValueGetter`) carries the reason and the queue lane.
     The GLYPH is the identity (✓ ✗ ⏸ —) and wears the tone; a tone dot beside it was measured to
     push `✓ Sent 2 min` past the contract's 96px, and said nothing the glyph did not. */
  return (
    <button
      type="button"
      className="nds-matrix-syncbtn"
      onClick={onClick}
      aria-label={`${word} — open Needs attention for this listing`}
    >
      {glyph && <span className="nds-matrix-syncglyph" data-tone={tone ?? undefined} aria-hidden="true">{glyph}</span>}
      {short && <span className="nds-cell-value-text">{short}</span>}
    </button>
  )
})

/* ── Price ──────────────────────────────────────────────────────────────────────────────── */

export const PriceCell = memo(function PriceCell(p: MatrixCellProps) {
  const copy = p.copy ?? MATRIX_CELL_COPY
  const cells = p.facts(p)
  if (!cells) return null
  const price = cells.price
  if (!price) return <Value muted>{MATRIX_DASH}</Value>
  const text = matrixMoney(price.value, price.currency || p.coordinate.currency)
  return (
    <Value
      muted={price.value == null}
      marks={[
        price.source === 'master' && <ProvenanceMark provenance="inherited" tooltip={copy.followsBase(text)} />,
        price.source === 'override' && <ProvenanceMark provenance="pinned" tooltip={copy.setHere} />,
        price.source === 'formula' && <ProvenanceMark provenance="formula" tooltip={copy.formula(price.formula ?? '')} />,
        price.clamped && <Warn title={copy.clamped(price.clamped)} />,
      ]}
    >
      {text}
    </Value>
  )
})

/* ── Sale ───────────────────────────────────────────────────────────────────────────────── */

export const SaleCell = memo(function SaleCell(p: MatrixCellProps) {
  const cells = p.facts(p)
  if (!cells) return null
  const text = matrixSaleText(cells.sale, cells.price?.currency ?? p.coordinate.currency)
  return <Value muted={text === MATRIX_DASH}>{text}</Value>
})

/** ONE renderer per kind — the table `matrixColumnDef` reads. */
export const MATRIX_CELL_RENDERERS: Readonly<Record<MatrixCellKind, ComponentType<MatrixCellProps>>> = {
  listing: ListingStateCell,
  fulfilment: FulfilmentCell,
  syncMode: SyncModeCell,
  syncQty: SyncQtyCell,
  syncBuffer: SyncBufferCell,
  syncState: SyncStateCell,
  price: PriceCell,
  salePrice: SaleCell,
}
