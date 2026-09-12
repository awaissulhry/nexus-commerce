'use client'

/**
 * PES.7 — one master asset in the gallery.
 *
 * The tile states exactly what the row knows and nothing it does not:
 *   • dimensions print only when the server has them. NULL is a backfill gap, not a 0×0 image, so
 *     it reads "size unknown" (feedback_100_percent_honest_ui).
 *   • the ✦ analysis mark appears only once `aiAnalyzedAt` is set. An un-analysed image is not a
 *     failing one, and a grey mark on every tile would say it was.
 *   • ⚑ is the operator-curated hero (`isPrimary`), which is a different fact from `type: 'MAIN'`
 *     — the DB allows one primary per product and the catalog thumbnail follows it.
 *
 * Reordering is a POINTER drag, not an HTML5 one: the P1 spike measured pointer-drag as the model
 * whose round trip completes, and it keeps the keyboard path (the ⋯ menu's Move left/right) doing
 * the same work rather than a second, weaker one.
 */
import { memo } from 'react'

import { Button, Checkbox } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import type { MasterAsset } from '../types'
import styles from '../images.module.css'

export interface GalleryTileProps {
  asset: MasterAsset
  selected: boolean
  dragging: boolean
  dropEdge: 'before' | 'after' | null
  /** The asset's linked DAM copy has changed since it was added here. */
  damDrifted: boolean
  /** Briefly marked after "Locate" — so the operator's eye lands on the right tile. */
  flash?: boolean
  onToggleSelect(id: string, additive: boolean): void
  onOpen(asset: MasterAsset): void
  onPointerDownHandle(e: React.PointerEvent, asset: MasterAsset): void
}

/** The tile's rendered box is ~165px; ask for 2× so it stays sharp on a retina panel. */
const TILE_PX = 360

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export const GalleryTile = memo(function GalleryTile({
  asset, selected, dragging, dropEdge, damDrifted, flash = false,
  onToggleSelect, onOpen, onPointerDownHandle,
}: GalleryTileProps) {
  const hasDims = asset.width != null && asset.height != null
  const analysed = asset.aiAnalyzedAt != null
  const metaTitle = [
    asset.type,
    hasDims ? `${asset.width}×${asset.height}` : 'dimensions not recorded',
    asset.fileSize != null ? formatBytes(asset.fileSize) : null,
  ].filter(Boolean).join(' · ')

  const cls = [
    styles.tile,
    selected ? styles.tileSelected : '',
    dragging ? styles.tileDragging : '',
    dropEdge === 'before' ? styles.tileDropBefore : '',
    dropEdge === 'after' ? styles.tileDropAfter : '',
    flash ? styles.tileFlash : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      data-asset-id={asset.id}
      data-testid="gallery-tile"
      onPointerDown={(e) => onPointerDownHandle(e, asset)}
    >
      <Button
        variant="ghost"
        className={styles.thumb}
        onClick={() => onOpen(asset)}
        title={asset.alt ?? asset.type}
        aria-label={`Open ${asset.alt ?? asset.type}`}
      >
        {/*
          * Ask the CDN for a tile-sized rendition. A bare Cloudinary URL here serves the 2250×2250
          * ORIGINAL into a 165px box — measured: 24 of 24 still downloading, none painted. `c_fit`
          * rather than `c_fill` because a product photo must not be cropped to square in the one
          * place the operator checks its framing.
          */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.thumbImg} src={cdnFit(asset.url, TILE_PX)} alt="" loading="lazy" draggable={false} />
      </Button>

      <div className={styles.tileTop}>
        <span className={styles.tileSelect}>
          <Checkbox
            checked={selected}
            onChange={(e) => onToggleSelect(asset.id, (e.nativeEvent as MouseEvent).shiftKey)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${asset.alt ?? asset.type}`}
          />
        </span>
        <span className={styles.tileMarks}>
          {asset.isPrimary && <span className={`${styles.mark} ${styles.markOn}`} title="Hero image — the catalog thumbnail follows this">⚑</span>}
          {asset.derivedFromImageId && <span className={styles.mark} title="Edited from another master image">✎</span>}
          {analysed && <span className={styles.mark} title={`Analysed ${new Date(asset.aiAnalyzedAt!).toLocaleDateString()}`}>✦</span>}
          {damDrifted && <span className={`${styles.mark} ${styles.markDrift}`} title="The linked DAM asset has changed since this was added — re-link or re-upload">⚠</span>}
        </span>
        {/*
          🔴 The only signal that these tiles reorder by dragging.
          The drag is pointer-based and starts anywhere on the tile, so this handle needs no
          handler of its own — the pointerdown bubbles. What it adds is the affordance: SR.1 found
          the tile was a button with `cursor: zoom-in` and the wrapper `cursor: auto`, so nothing on
          screen said a drag was possible and an operator had no way to discover it. The image keeps
          `zoom-in`, because that is what clicking it does; the grab cursor belongs on the grip.
          The title names the keyboard route too — reordering must not be drag-only.
        */}
        <span
          className={styles.tileGrip}
          title="Drag to reorder — or select it and use ← Move / Move →"
          aria-hidden="true"
        >
          ⠿
        </span>
      </div>

      <div className={styles.tileBody}>
        {asset.alt
          ? <span className={styles.altText} title={asset.alt}>{asset.alt}</span>
          : <span className={styles.altMissing}>No alt text</span>}
        {/*
          * Type and dimensions only. File size used to sit here too and the line clipped mid-number
          * on a narrow tile — "1." is not a file size, and a truncated number is worse than an
          * absent one. Size moves to the tile's own title, where it cannot be cut in half.
          */}
        <span className={styles.tileMeta} title={metaTitle}>
          <span>{asset.type}</span>
          {hasDims
            ? <span className={styles.metaDims}>{asset.width}×{asset.height}</span>
            : <span className={styles.metaUnknown}>size unknown</span>}
        </span>
      </div>
    </div>
  )
})
