'use client'

/**
 * PES.4.4 — the record's images, at a glance.
 *
 * Read-only on purpose. PES.7 owns the Images tab and everything that writes an image; this strip
 * exists so an operator reading a record can see what it looks like without leaving the drawer,
 * and it takes its data from the host rather than fetching — two components fetching the same
 * gallery would eventually show two different galleries.
 */

import { ImageOff } from 'lucide-react'
import styles from '../drawer.module.css'

export interface GalleryImage {
  id: string
  url: string
  alt?: string
  isMain?: boolean
  /** These are the PARENT's images, shown because this record has none of its own. */
  inherited?: boolean
}

export interface GalleryStripProps {
  images: readonly GalleryImage[]
  /**
   * The parent these came from, or null when they are the record's own.
   *
   * 🔴 The distinction is the whole point, and getting it wrong was measurable: on GALE-JACKET the
   * parent holds 24 images and all 20 children hold none, so an own-rows-only read would have made
   * this strip announce "No images on this record — every channel that requires one will refuse the
   * listing" on twenty perfectly illustrated SKUs. Inheriting fixes that; saying so quietly is what
   * keeps it honest, because "these are its own" and "these come from the parent" are different
   * facts an operator acts on differently.
   */
  inheritedFrom?: string | null
}

export function GalleryStrip({ images, inheritedFrom }: GalleryStripProps) {
  if (images.length === 0) {
    // Genuinely empty is still genuinely empty — the parent had none either.
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <ImageOff size={14} className={styles.noteIcon} aria-hidden />
        <span>No images on this record. Every channel that requires one will refuse the listing.</span>
      </div>
    )
  }
  return (
    <>
      {inheritedFrom && (
        <div className={styles.galNote}>
          Showing {inheritedFrom}&rsquo;s images — this record has none of its own.
        </div>
      )}
    <div className={styles.gal}>
      {images.map((img) => (
        <div key={img.id} className={`${styles.galItem}${img.isMain ? ` ${styles.galMain}` : ''}`}>
          {/* Plain <img>: these are remote marketplace URLs on arbitrary hosts, which next/image
              cannot optimise without every host being configured, and a 72px thumbnail is not
              where that budget belongs. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.url} alt={img.alt ?? ''} loading="lazy" />
          {img.isMain && <span className={styles.galBadge}>MAIN</span>}
        </div>
      ))}
    </div>
    </>
  )
}
