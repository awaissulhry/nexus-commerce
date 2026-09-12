'use client'

/**
 * PES.7 — the Amazon Colour × Slot matrix, on the GDS media substrate.
 *
 * Rows are buckets (the shared "all colours" row, then the axis's values); columns are the image
 * slots Amazon's own schema declares for THIS product type. Every cell is a picture resolved
 * through the publisher's cascade, so what the matrix shows is what a publish would send.
 *
 * The three conditions the P1 spike established are met by CONSTRUCTION, not by care:
 *   1. the picture lives in the cell's VALUE (`valueGetter` returns a `MatrixCellValue`), so AG's
 *      change detection repaints it — a renderer drawing from params alone is invisible to it;
 *   2. handlers arrive through `MediaCellProvider`, never in `cellRendererParams`, so the column
 *      model is not re-run on every gesture;
 *   3. `MEDIA_MATRIX_GRID_OPTIONS` turns `cellSelection` off, because AG opens a range on the same
 *      mousedown that starts a tile drag and `stopPropagation` cannot stop it.
 *
 * 🔴 The market comes from the frame's scope bar, and the per-market model is deliberate: image
 * TEXT is localised per EU market (Owner, ruling #8). The header states which mechanism a market's
 * set actually rides, because SP-API image attributes are ASIN-GLOBAL even with a marketplace
 * selector — the honest advisory that ruling required.
 */
import { useCallback, useMemo, useState } from 'react'

import {
  MediaCell, MediaCellProvider, MEDIA_MATRIX_GRID_OPTIONS, NexusGrid,
  type ColDef, type MediaCellHandlers, type ValueGetterParams,
} from '@/design-system/grid'

import { Button } from '@/design-system/primitives'

import { apiSend, routes, type ApiResult } from '../../api'
import { writeSubject } from '../../imageWrites'
import type { AmazonSlotDef, ListingAsset, MasterAsset, UploadImageResponse } from '../../types'
import { bucketGroupKey, resolveCell } from './cascade'
import { BulkApplyModal } from './BulkApplyModal'
import { ChannelTruthPanel } from './ChannelTruthPanel'
import { PublishPanel } from './PublishPanel'
import { SlotPicker } from './SlotPicker'
import { useMatrixEdits } from './useMatrixEdits'
import { useTileDrag, type TileCoord } from './useTileDrag'
import {
  amazonRows, buildCellValue, masterFallback, matrixColumns, matrixRows, picturelessCoordinates,
  type MatrixRow,
} from './matrixModel'
import styles from './matrix.module.css'

export interface AmazonMatrixProps {
  publicationAvailable?: boolean
  market: string | null
  listing: ListingAsset[]
  master: MasterAsset[]
  /** The server's per-product-type slot set. Optional on older API responses. */
  slotTaxonomy: AmazonSlotDef[] | undefined
  /** The server's word on which slot set those are. */
  slotTaxonomySource: 'schema' | 'fallback' | undefined
  /** The authoritative axis values (declared order, deduped, ghosts removed). */
  axisValues: string[]
  axisName: string | null
  productId: string
  reload(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

/** The tile box. Drives the CDN rendition the cell asks for, so it is layout, not decoration. */
const TILE_PX = 84
const GROUP_COL_WIDTH = 190

export function AmazonMatrix({
  publicationAvailable = true, market, listing, master, slotTaxonomy, slotTaxonomySource, axisValues, axisName, productId, reload, write,
}: AmazonMatrixProps) {
  const [picking, setPicking] = useState<{ rowId: string; slot: string } | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const edits = useMatrixEdits({ productId, reload, write })
  /**
   * Belt and braces for PES ruling #156: the memoised callbacks below depend on these two
   * functions, not on `edits` as a whole. Each is individually stable, so the memos survive a
   * `busy`/`refusal` state change — and keep working even if a future edit to the hook forgets to
   * memoise its return object.
   */
  const { place: placeEdit, move: moveEdit } = edits
  const rows = useMemo(() => amazonRows(listing), [listing])
  const { columns, slotSetSource } = useMemo(
    () => matrixColumns(slotTaxonomy, slotTaxonomySource), [slotTaxonomy, slotTaxonomySource])
  const matrixData = useMemo<MatrixRow[]>(() => matrixRows(axisValues, rows), [axisValues, rows])

  const getRowId = useCallback((p: { data: MatrixRow }) => p.data.id, [])

  /** The one place a (rowId, slot) is turned into a resolution — columns, drag and picker share it. */
  const resolveAt = useCallback((rowId: string, slot: string) => {
    const r = matrixData.find((x) => x.id === rowId)
    if (!r) return null
    return {
      row: r,
      resolved: resolveCell({
        rows, slot, market, groupValue: r.groupValue,
        masterFallbackUrl: masterFallback(master, slot),
      }),
    }
  }, [market, master, matrixData, rows])

  const groupKey = useMemo(() => bucketGroupKey(rows, axisName), [axisName, rows])

  const coordOf = useCallback((rowId: string, slot: string) => {
    const hit = resolveAt(rowId, slot)
    if (!hit) return null
    return { at: { slot, groupValue: hit.row.groupValue, groupKey, market }, resolved: hit.resolved }
  }, [groupKey, market, resolveAt])

  /**
   * A desktop file dropped on a cell.
   *
   * Uploaded to the MASTER gallery first, then placed — a channel row references a picture, it does
   * not own bytes, so there has to be a master row for it to point at. Doing it in the other order
   * would leave a listing row pointing at nothing if the upload failed.
   */
  const dropFiles = useCallback(async (rowId: string, slot: string, files: FileList) => {
    const file = Array.from(files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    const hit = coordOf(rowId, slot)
    if (!hit) return
    const fd = new FormData()
    fd.append('file', file)
    const up = await write(writeSubject.upload(file.name), () => apiSend<UploadImageResponse>(
      `${routes.masterImages(productId)}?type=ALT`, 'POST', fd))
    if (!up.ok || !up.data?.id) return
    await placeEdit(hit.at, up.data.url, hit.resolved, up.data.id)
  }, [coordOf, placeEdit, productId, write])

  const drag = useTileDrag({
    // Only a picture that is actually there can be dragged; an empty or inherited-from-nothing
    // cell has nothing to pick up.
    canDragFrom: useCallback((c: TileCoord) => !!resolveAt(c.rowId, c.colId)?.resolved.url, [resolveAt]),
    onDrop: useCallback((from: TileCoord, to: TileCoord) => {
      const a = coordOf(from.rowId, from.colId)
      const b = coordOf(to.rowId, to.colId)
      if (!a || !b) return
      void moveEdit(a.at, a.resolved, b.at, b.resolved)
    }, [coordOf, moveEdit]),
  })

  // ONE stable handlers object — the whole point of the provider (spike condition 2).
  const handlers = useMemo<MediaCellHandlers>(() => ({
    size: TILE_PX,
    onOpen: (rowId, colId) => setPicking({ rowId, slot: colId }),
    onTilePointerDown: drag.onPointerDown,
    onFileDrop: (rowId, colId, files) => { void dropFiles(rowId, colId, files) },
  }), [drag.onPointerDown, dropFiles])

  const columnDefs = useMemo<ColDef<MatrixRow>[]>(() => [
    {
      colId: 'bucket',
      headerName: axisName ?? 'Bucket',
      field: 'label',
      pinned: 'left',
      width: GROUP_COL_WIDTH,
      sortable: false,
      resizable: false,
      cellClass: (p) => (p.data?.orphaned ? 'nds-cell-orphaned' : ''),
    },
    ...columns.map<ColDef<MatrixRow>>((col) => ({
      colId: col.slot,
      headerName: col.slot,
      width: TILE_PX + 16,
      sortable: false,
      resizable: false,
      // Condition 1: the picture IS the value.
      valueGetter: (p: ValueGetterParams<MatrixRow>) => {
        if (!p.data) return null
        const value = buildCellValue({
          rows,
          slot: col.slot,
          market,
          groupValue: p.data.groupValue,
          masterFallbackUrl: masterFallback(master, col.slot),
          writable: col.writable,
        })
        return publicationAvailable ? value : { ...value, publish: undefined }
      },
      cellRenderer: MediaCell,
      cellStyle: { padding: 2, display: 'flex' },
      headerClass: col.writable ? undefined : 'nds-head-readonly',
    })),
  ], [axisName, columns, market, master, rows, publicationAvailable])

  const filled = useMemo(() => rows.filter((r) => r.amazonSlot).length, [rows])

  const pictureless = useMemo(
    () => picturelessCoordinates({ rows, columns, matrix: matrixData, market }),
    [columns, market, matrixData, rows],
  )

  // The coordinate + current resolution the picker is acting on — same resolver as everything else.
  const pickingHit = picking ? resolveAt(picking.rowId, picking.slot) : null
  const pickingRow = pickingHit?.row ?? null
  const pickingResolved = pickingHit?.resolved ?? null
  const pickingCoord = picking && pickingRow
    ? { slot: picking.slot, groupValue: pickingRow.groupValue, groupKey, market }
    : null

  return (
    <section className={styles.matrix}>
      <header className={styles.head}>
        <h2 className={styles.title}>Amazon images</h2>
        <span className={styles.count}>
          {matrixData.length - 1} {axisName?.toLowerCase() ?? 'bucket'} row
          {matrixData.length - 1 === 1 ? '' : 's'} · {columns.length} slots · {filled} placed
        </span>
        <span className={styles.spacer} />
        {/* The honesty clause ruling #8 required: say which mechanism this market's set rides. */}
        <Button size="sm" variant="ghost" onClick={() => setBulkOpen(true)}>Fill slots…</Button>
        <Button size="sm" variant="secondary" disabled={!market || !publicationAvailable} onClick={() => setPublishing(true)}>
          Publish…
        </Button>
        <span className={styles.mechanism} title="SP-API maps image attributes to the ASIN globally, even with a marketplace selector (Amazon Listings APIs FAQ). Per-market image TEXT needs Country-Specific Upload or A+ Content.">
          {market ? `${market} · via SP-API (global to the ASIN)` : 'no market selected'}
        </span>
      </header>

      {slotSetSource !== 'schema' && (
        // The set on screen is not Amazon's answer, and an operator deciding whether a slot exists
        // deserves to know that rather than trusting columns that may not apply to this product.
        <p className={styles.notice}>
          {slotSetSource === 'fallback'
            ? 'Amazon’s schema did not answer for this product type, so these are the legacy 10 slots. Safety (PS) and swatch slots may be missing — images already sitting in them would not be shown here, or published.'
            : 'The server did not say whether these slots came from Amazon’s schema or the legacy fallback, so treat the set as unconfirmed.'}
        </p>
      )}

      {matrixData.some((r) => r.orphaned) && (
        <p className={styles.notice}>
          Rows marked below hold images on the channel under a value the current axis no longer
          lists. They are shown so nothing is hidden — move or clear them.
        </p>
      )}

      {pictureless.total > 0 && (
        <p className={styles.warning} role="status">
          {pictureless.claimingLive > 0
            ? `${pictureless.claimingLive} slot${pictureless.claimingLive === 1 ? ' is' : 's are'} marked published on Amazon but hold no image`
            : `${pictureless.total} slot${pictureless.total === 1 ? ' has' : 's have'} a row but no image`}
          {pictureless.total > pictureless.claimingLive && pictureless.claimingLive > 0 &&
            ` (${pictureless.total - pictureless.claimingLive} more hold a row but are not claiming to be live)`}
          . They publish nothing — the cascade stops there rather than showing an inherited picture
          that would not be sent.
        </p>
      )}

      {edits.refusal && (
        <p className={styles.warning} role="alert" onClick={edits.dismissRefusal}>{edits.refusal}</p>
      )}

      {publicationAvailable && <ChannelTruthPanel productId={productId} market={market} write={write} />}

      <MediaCellProvider value={handlers}>
        <NexusGrid<MatrixRow>
          rows="media"
          domLayout="autoHeight"
          rowData={matrixData}
          columnDefs={columnDefs}
          getRowId={getRowId}
          {...MEDIA_MATRIX_GRID_OPTIONS}
        />
      </MediaCellProvider>

      <BulkApplyModal
        open={bulkOpen}
        productId={productId}
        market={market}
        groupKey={groupKey}
        rows={matrixData}
        columns={columns}
        master={master}
        resolveAt={resolveAt}
        onClose={() => setBulkOpen(false)}
        onApplied={reload}
        write={write}
      />

      {publicationAvailable && <PublishPanel
        open={publishing}
        productId={productId}
        market={market}
        activeAxis={axisName}
        onClose={() => setPublishing(false)}
        onSubmitted={reload}
        write={write}
      />}

      <SlotPicker
        open={picking != null}
        slot={picking?.slot ?? ''}
        bucketLabel={pickingRow?.label ?? ''}
        market={market}
        resolved={pickingResolved}
        master={master}
        busy={edits.busy}
        onPick={(asset) => {
          if (!pickingCoord || !pickingResolved) return
          void edits.place(pickingCoord, asset.url, pickingResolved, asset.id).then(() => setPicking(null))
        }}
        onClear={() => {
          if (!pickingCoord || !pickingResolved) return
          void edits.clear(pickingCoord, pickingResolved).then(() => setPicking(null))
        }}
        onClose={() => setPicking(null)}
      />
    </section>
  )
}
