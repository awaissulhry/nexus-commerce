'use client'

/**
 * PES.7 — eBay's bucket × position grid, on the same GDS media substrate as the Amazon matrix.
 *
 * Same engine, different meaning. Amazon's columns are NAMED slots; eBay's are an ORDER, and the
 * first one is the cover a buyer sees in search results. So the columns are numbered, the header
 * says which is the cover, and the twelfth is where eBay stops looking.
 *
 * 🔴 Positions are ZERO-based in storage and ONE-based on screen. Nobody calls the first photo
 * "position 0", and a grid that did would have the operator counting from the wrong end when they
 * talk to eBay's own UI. The conversion happens here, once, at the column definition.
 */
import { useCallback, useMemo, useState } from 'react'

import {
  MediaCell, MediaCellProvider, MEDIA_MATRIX_GRID_OPTIONS, NexusGrid,
  type ColDef, type MediaCellHandlers, type ValueGetterParams,
} from '@/design-system/grid'
import { Button } from '@/design-system/primitives'

import type { ApiResult } from '../../api'
import { isPublished, type ListingAsset, type MasterAsset } from '../../types'
import {
  buildBuckets, bucketWarnings, EBAY_MAX_PER_BUCKET, ebayRows, type EbayBucket,
} from './buckets'
import { useEbayEdits } from './useEbayEdits'
import styles from '../amazon/matrix.module.css'

export interface EbayGridProps {
  publicationAvailable?: boolean
  productId: string
  listing: ListingAsset[]
  master: MasterAsset[]
  axisValues: string[]
  axisName: string | null
  reload(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

const TILE_PX = 84

export function EbayGrid({
  publicationAvailable = true, productId, listing, master, axisValues, axisName, reload, write,
}: EbayGridProps) {
  const [picking, setPicking] = useState<{ bucketId: string; position: number } | null>(null)
  // No cast: `EbayRow` is a `Pick` of `ListingAsset`.
  const rows = useMemo(() => ebayRows(listing), [listing])
  const buckets = useMemo(() => buildBuckets({ rows, axisValues }), [axisValues, rows])
  const groupKey = useMemo(
    () => rows.find((r) => r.variantGroupKey)?.variantGroupKey ?? axisName,
    [axisName, rows],
  )
  const edits = useEbayEdits({ productId, rows, groupKey, reload, write })

  const handlers = useMemo<MediaCellHandlers>(() => ({
    size: TILE_PX,
    onOpen: (bucketId, colId) => setPicking({ bucketId, position: Number(colId.replace('pos', '')) }),
  }), [])

  const getRowId = useCallback((p: { data: EbayBucket }) => p.data.id, [])

  const columnDefs = useMemo<ColDef<EbayBucket>[]>(() => [
    {
      colId: 'bucket',
      headerName: axisName ?? 'Bucket',
      field: 'label',
      pinned: 'left',
      width: 210,
      sortable: false,
      resizable: false,
    },
    ...Array.from({ length: EBAY_MAX_PER_BUCKET }, (_, index) => ({
      colId: `pos${index}`,
      // 1-based on screen; 0-based in `index`. The cover is named rather than left to be inferred.
      headerName: index === 0 ? '1 · cover' : String(index + 1),
      width: TILE_PX + 16,
      sortable: false,
      resizable: false,
      valueGetter: (p: ValueGetterParams<EbayBucket>) => {
        const photo = p.data?.photos[index]
        if (!photo) return { src: null, alt: `position ${index + 1}` }
        return {
          src: photo.url,
          alt: `${p.data?.label ?? ''} · position ${index + 1}`,
          // A photo in a colour bucket is that bucket's own; nothing here is inherited, because
          // eBay's model is one-bucket-per-photo rather than a cascade.
          provenance: 'own' as const,
          locked: photo.locked === true,
          publish: !publicationAvailable ? undefined : isPublished(photo.publishStatus) ? ('live' as const)
            : photo.publishStatus === 'ERROR' ? ('failed' as const) : ('queued' as const),
        }
      },
      cellRenderer: MediaCell,
      cellStyle: { padding: 2, display: 'flex' },
    })),
  ], [axisName, publicationAvailable])

  const warnings = useMemo(
    () => buckets.flatMap((b) => bucketWarnings(b).map((w) => ({ bucket: b.label, w }))),
    [buckets],
  )

  const pickingBucket = picking ? buckets.find((b) => b.id === picking.bucketId) ?? null : null

  return (
    <section className={styles.matrix}>
      <header className={styles.head}>
        <h2 className={styles.title}>eBay images</h2>
        <span className={styles.count}>
          {buckets.length} bucket{buckets.length === 1 ? '' : 's'} · {rows.length} photos ·
          {' '}max {EBAY_MAX_PER_BUCKET} per variation
        </span>
        <span className={styles.spacer} />
        <span className={styles.mechanism} title="eBay does not reliably de-duplicate, so each photo lives in exactly one bucket. Moving a photo into a colour removes it from Default.">
          one bucket per photo
        </span>
      </header>

      {warnings.length > 0 && (
        <p className={styles.notice}>
          {warnings.map((x, i) => <span key={i}>{x.bucket}: {x.w} </span>)}
        </p>
      )}

      {edits.refusal && (
        <p className={styles.warning} role="alert" onClick={edits.dismiss}>{edits.refusal}</p>
      )}

      <MediaCellProvider value={handlers}>
        <NexusGrid<EbayBucket>
          rows="media"
          domLayout="autoHeight"
          rowData={buckets}
          columnDefs={columnDefs}
          getRowId={getRowId}
          {...MEDIA_MATRIX_GRID_OPTIONS}
        />
      </MediaCellProvider>

      {picking && pickingBucket && (
        <EbayPositionPicker
          bucket={pickingBucket}
          position={picking.position}
          master={master}
          busy={edits.busy}
          onPick={(asset) => { void edits.place(asset.url, pickingBucket, picking.position).then(() => setPicking(null)) }}
          onRemove={() => { void edits.remove(pickingBucket, picking.position).then(() => setPicking(null)) }}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  )
}

/* ── the picker ────────────────────────────────────────────────────────────────────────────── */

import { Modal } from '@/design-system/components'
import { cdnFit } from '@/design-system/lib/cdn-image'

function EbayPositionPicker({
  bucket, position, master, busy, onPick, onRemove, onClose,
}: {
  bucket: EbayBucket
  position: number
  master: MasterAsset[]
  busy: boolean
  onPick(asset: MasterAsset): void
  onRemove(): void
  onClose(): void
}) {
  const existing = bucket.photos[position] ?? null
  return (
    <Modal
      open
      onClose={onClose}
      size="xxl"
      title={`${bucket.label} · position ${position + 1}${position === 0 && bucket.groupValue == null ? ' (cover)' : ''}`}
      subtitle="Shared eBay gallery · all accounts and markets"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          {existing && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>Remove from this bucket</Button>
          )}
        </>
      }
    >
      <p className={styles.pickerState}>
        {existing
          ? 'Choosing a different photo replaces this one here.'
          : 'Choosing a photo adds it here.'}
        {' '}A photo can only be in one bucket — if it is already in another, it MOVES.
      </p>
      <div className={styles.pickerGrid}>
        {master.map((m) => (
          <Button key={m.id} variant="ghost" className={styles.pickerCard} disabled={busy}
            onClick={() => onPick(m)} title={m.alt ?? m.type}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.pickerImg} src={cdnFit(m.url, 200)} alt="" loading="lazy" />
            <span className={styles.pickerLabel}>{m.type}</span>
          </Button>
        ))}
      </div>
    </Modal>
  )
}
