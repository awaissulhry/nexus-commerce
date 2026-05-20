'use client'

// IR.3.1 — Lightbox state hook.
//
// The lightbox is one shared modal that any panel (master, Amazon
// matrix, eBay gallery / color sets, Shopify pool / variant
// assignment) can open. Image identity is normalised so the modal
// doesn't need to know whether the source is a ProductImage or a
// ListingImage row.
//
// Siblings let the lightbox advance with ← / → arrow keys without
// closing — the panel that opened the modal supplies the list it
// considers "next" (e.g. the master gallery for master clicks).

import { useCallback, useState } from 'react'
import type { ListingImage, ProductImage } from './types'

export type LightboxKind = 'master' | 'listing'

export interface LightboxImage {
  kind: LightboxKind
  // Stable identity for prev/next + "used in" cross-reference lookup.
  id: string
  url: string
  alt?: string | null
  // Master rows only — type tag (MAIN / ALT / LIFESTYLE / SWATCH / DIAGRAM).
  type?: string
  width?: number | null
  height?: number | null
  mimeType?: string | null
  fileSize?: number | null
  // For listing rows: which channel + slot this image is on.
  platform?: string | null
  marketplace?: string | null
  amazonSlot?: string | null
  variantGroupKey?: string | null
  variantGroupValue?: string | null
  publishStatus?: string | null
  publishError?: string | null
  // ProductImage row this listing image was copied from (if any). Lets
  // the drawer surface "this listing image came from master MAIN".
  sourceProductImageId?: string | null
}

export interface LightboxState {
  image: LightboxImage
  siblings: LightboxImage[]
}

export function fromMaster(p: ProductImage): LightboxImage {
  return {
    kind: 'master',
    id: p.id,
    url: p.url,
    alt: p.alt,
    type: p.type,
    width: p.width,
    height: p.height,
    mimeType: p.mimeType,
    fileSize: p.fileSize,
  }
}

export function fromListing(l: ListingImage): LightboxImage {
  return {
    kind: 'listing',
    id: l.id,
    url: l.url,
    width: l.width,
    height: l.height,
    mimeType: l.mimeType,
    fileSize: l.fileSize,
    platform: l.platform,
    marketplace: l.marketplace,
    amazonSlot: l.amazonSlot,
    variantGroupKey: l.variantGroupKey,
    variantGroupValue: l.variantGroupValue,
    publishStatus: l.publishStatus,
    publishError: l.publishError,
    sourceProductImageId: l.sourceProductImageId,
  }
}

export function useLightbox() {
  const [state, setState] = useState<LightboxState | null>(null)

  const open = useCallback((image: LightboxImage, siblings: LightboxImage[] = []) => {
    setState({ image, siblings })
  }, [])

  const close = useCallback(() => setState(null), [])

  const navigate = useCallback((dir: 'prev' | 'next') => {
    setState((prev) => {
      if (!prev || prev.siblings.length === 0) return prev
      const idx = prev.siblings.findIndex((s) => s.id === prev.image.id)
      if (idx === -1) return prev
      const nextIdx = dir === 'next'
        ? (idx + 1) % prev.siblings.length
        : (idx - 1 + prev.siblings.length) % prev.siblings.length
      return { image: prev.siblings[nextIdx]!, siblings: prev.siblings }
    })
  }, [])

  return { state, open, close, navigate }
}
