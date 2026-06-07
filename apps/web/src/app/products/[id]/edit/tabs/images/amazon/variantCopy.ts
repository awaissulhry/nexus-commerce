// VC — copy selected images across the VARIANT axis (e.g. Giallo's images →
// Nero / all other colours), at the same slot. Sibling of crossMarketCopy
// (which copies across MARKETS). Pure + unit-tested; reuses the staged
// addPendingUpsert → bulk-save path (upsert by bucket+slot = replace in place).

import type { CellDisplay } from './useAmazonImages'
import type { ListingImage, PendingUpsert } from '../types'

export type VariantCopyUpsert = Omit<PendingUpsert, '_tempId'>

export interface VariantCopyInput {
  /** The selected source cells (group = colour value, slot). */
  cells: Array<{ group: string | null; slot: string }>
  /** Target variant-group values (e.g. ['Nero','Rosso']). */
  targetGroups: string[]
  activeAxis: string
  /** 'ALL' → copies land at PLATFORM scope; a market → that MARKETPLACE scope. */
  activeMarketplace: string
  /** Resolves the source cell's effective image in the current market context. */
  resolveCell: (group: string | null, slot: string) => CellDisplay | null
  listingImages: ListingImage[]
}

export function buildVariantCopyUpserts(input: VariantCopyInput): VariantCopyUpsert[] {
  const { cells, targetGroups, activeAxis, activeMarketplace, resolveCell, listingImages } = input
  const isAll = activeMarketplace === 'ALL'
  const scope: PendingUpsert['scope'] = isAll ? 'PLATFORM' : 'MARKETPLACE'
  const marketplace: string | null = isAll ? null : activeMarketplace
  const out: VariantCopyUpsert[] = []

  for (const targetGroup of targetGroups) {
    for (const cell of cells) {
      if (cell.group === targetGroup) continue // never copy a variant onto itself
      const src = resolveCell(cell.group, cell.slot)
      if (!src || !src.url) continue // skip empty source cells

      const srcRow = src.listingImageId ? listingImages.find((li) => li.id === src.listingImageId) : undefined
      const sourceProductImageId = src.masterImageId ?? srcRow?.sourceProductImageId ?? null

      // Replace the target variant's same slot if it exists; skip if locked.
      const existing = listingImages.find(
        (li) =>
          li.platform === 'AMAZON' &&
          li.amazonSlot === cell.slot &&
          li.scope === scope &&
          li.marketplace === marketplace &&
          li.variantGroupKey === activeAxis &&
          li.variantGroupValue === targetGroup,
      )
      if (existing?.locked) continue

      out.push({
        ...(existing ? { id: existing.id } : {}),
        scope,
        platform: 'AMAZON',
        marketplace,
        amazonSlot: cell.slot,
        variantGroupKey: activeAxis,
        variantGroupValue: targetGroup,
        url: src.url,
        sourceProductImageId,
        role: srcRow?.role ?? 'GALLERY',
        position: srcRow?.position ?? 0,
        width: src.width ?? null,
        height: src.height ?? null,
      })
    }
  }

  return out
}
