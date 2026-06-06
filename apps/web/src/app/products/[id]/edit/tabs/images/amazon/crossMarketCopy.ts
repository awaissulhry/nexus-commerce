// CM.1 — Cross-market image copy (pure).
//
// Builds the pending upserts to replicate a SOURCE Amazon market's images onto
// one or more TARGET markets, at the SAME slot/placement. Reuses the existing
// staging path: the returned upserts go through addPendingUpsert → bulk-save
// (which upserts by bucket+slot). When the target already has a row at that
// (group, slot, market), we set its `id` so bulk-save UPDATES it (replaces in
// place) instead of creating a duplicate.
//
// Source = whatever the source market currently SHOWS for each (group, slot)
// via resolveCell (own / inherited / master fallback) — so the target ends up
// matching the source exactly. Empty source cells are skipped.

import type { CellDisplay } from './useAmazonImages'
import type { ListingImage, PendingUpsert } from '../types'

/** Target sentinel: copy to PLATFORM scope ("All Markets (shared)"). */
export const SHARED_TARGET = '__SHARED__'

export type CrossMarketUpsert = Omit<PendingUpsert, '_tempId'>

export interface CrossMarketCopyInput {
  /** The source/active market the resolveCell is bound to (skip copying onto itself). */
  sourceMarketplace: string
  /** Target market codes (e.g. ['DE','FR']) and/or SHARED_TARGET. */
  targets: string[]
  /** Slot codes to copy — all slots (whole-market) or a single slot (per-slot). */
  slots: string[]
  /** Group values to copy across; null = the "All Colors" / product-level row. */
  groups: Array<string | null>
  /** Axis key used for non-null groups (variantGroupKey). */
  activeAxis: string
  /** Resolves the SOURCE market's effective cell for (group, slot). */
  resolveCell: (group: string | null, slot: string) => CellDisplay | null
  /** All listing rows — for source enrichment + target existing-row (replace) lookup. */
  listingImages: ListingImage[]
}

function slotIndex(slot: string): number {
  if (slot === 'MAIN') return 0
  const m = slot.match(/(\d+)$/)
  return m ? Number(m[1]) : 999
}

export function buildCrossMarketUpserts(input: CrossMarketCopyInput): CrossMarketUpsert[] {
  const { sourceMarketplace, targets, slots, groups, activeAxis, resolveCell, listingImages } = input
  const out: CrossMarketUpsert[] = []

  for (const target of targets) {
    const isShared = target === SHARED_TARGET
    if (!isShared && target === sourceMarketplace) continue // never copy onto itself
    const tScope: PendingUpsert['scope'] = isShared ? 'PLATFORM' : 'MARKETPLACE'
    const tMarket: string | null = isShared ? null : target

    for (const group of groups) {
      for (const slot of slots) {
        const src = resolveCell(group, slot)
        if (!src || !src.url) continue // skip empty source slots

        const srcRow = src.listingImageId
          ? listingImages.find((li) => li.id === src.listingImageId)
          : undefined
        const sourceProductImageId = src.masterImageId ?? srcRow?.sourceProductImageId ?? null

        // Replace the target's same slot if it already exists (id → update).
        const existing = listingImages.find(
          (li) =>
            li.platform === 'AMAZON' &&
            li.amazonSlot === slot &&
            li.scope === tScope &&
            li.marketplace === tMarket &&
            (group === null
              ? !li.variantGroupKey
              : li.variantGroupKey === activeAxis && li.variantGroupValue === group),
        )

        out.push({
          ...(existing ? { id: existing.id } : {}),
          scope: tScope,
          platform: 'AMAZON',
          marketplace: tMarket,
          amazonSlot: slot,
          variantGroupKey: group === null ? null : activeAxis,
          variantGroupValue: group === null ? null : group,
          url: src.url,
          sourceProductImageId,
          role: srcRow?.role ?? 'GALLERY',
          position: srcRow?.position ?? slotIndex(slot),
          width: src.width ?? null,
          height: src.height ?? null,
        })
      }
    }
  }

  return out
}
