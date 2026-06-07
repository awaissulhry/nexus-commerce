'use client'

// IM.3 — Images workspace state hook.
//
// Owns:
//   - workspace data fetch (GET /api/products/:id/images-workspace)
//   - pending listing-image changes (staged, not auto-saved)
//   - savePending → POST .../bulk-save
//   - discardPending → reset local state
//   - addToChannel → quick "copy master image to channel" shortcut
//   - axis preference persistence (PATCH .../axis)
//
// Master image mutations (upload/delete/reorder/patch) live in
// MasterPanel.tsx and hit the existing /api/products/:id/images
// endpoints directly — they persist immediately and reload workspace
// data via the reload() callback.

import { useCallback, useEffect, useRef, useState } from 'react'
import { beFetch } from './api'
import type { WorkspaceData, PendingUpsert, ProductImage, ListingImage } from './types'
import { setDraftField } from '../../_shared/draft-bus/useProductDraftBus'

let _tempIdCounter = 0
function tempId(): string {
  return `tmp_${++_tempIdCounter}`
}

// AC.5b — Project master ProductImage[] into the shape the cockpit
// compositor expects (url + type + sortOrder + isPrimary). Strips
// pending/temp rows that don't have a real URL yet so the preview
// doesn't show broken thumbs. Read by useAmazonCompositor.
function pushImagesDraft(productId: string, master: ProductImage[]): void {
  const projected = master
    .filter((m) => typeof m.url === 'string' && m.url.length > 0)
    .map((m) => ({
      url: m.url,
      type: m.type,
      sortOrder: m.sortOrder ?? 0,
      isPrimary: !!m.isPrimary,
    }))
  setDraftField(productId, 'images', projected)
}

export function useImagesWorkspace(
  productId: string,
  discardSignal: number,
  onDirtyChange: (count: number) => void,
) {
  const [data, setData] = useState<WorkspaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Pending listing-image changes — Map keyed by _tempId
  const [pendingUpserts, setPendingUpserts] = useState<Map<string, PendingUpsert>>(new Map())
  // Listing-image IDs to delete on save
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set())

  const dirtyCount = pendingUpserts.size + pendingDeletes.size

  // Keep onDirtyChange ref-stable so the effect below doesn't re-run
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])

  useEffect(() => {
    onDirtyChangeRef.current(dirtyCount)
  }, [dirtyCount])

  // ── Load ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images-workspace`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      // AC.5b — seed the cockpit's draft bus with the workspace's
      // master images on load + reload. If another tab uploaded
      // since the SSR fetch, the cockpit picks the new list up here
      // rather than waiting for an explicit edit.
      if (Array.isArray(json?.master)) {
        pushImagesDraft(productId, json.master as ProductImage[])
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load images')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => { void load() }, [load])

  // discardSignal → reset pending + reload
  useEffect(() => {
    if (discardSignal === 0) return
    setPendingUpserts(new Map())
    setPendingDeletes(new Set())
    void load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardSignal])

  // ── Mutations ────────────────────────────────────────────────────────

  const addPendingUpsert = useCallback((upsert: Omit<PendingUpsert, '_tempId'>) => {
    const id = upsert.id ?? tempId()
    const full: PendingUpsert = { ...upsert, _tempId: id }
    setPendingUpserts((prev) => {
      const next = new Map(prev)
      // If updating existing row (id set), replace any prior pending for same id
      if (upsert.id) {
        for (const [k, v] of next) {
          if (v.id === upsert.id) { next.delete(k); break }
        }
      }
      next.set(id, full)
      return next
    })
  }, [])

  const removePendingUpsert = useCallback((tempId: string) => {
    setPendingUpserts((prev) => {
      const next = new Map(prev)
      next.delete(tempId)
      return next
    })
  }, [])

  const addPendingDelete = useCallback((listingImageId: string) => {
    // Remove any pending upsert for this id (no point saving then deleting)
    setPendingUpserts((prev) => {
      const next = new Map(prev)
      for (const [k, v] of next) {
        if (v.id === listingImageId) { next.delete(k); break }
      }
      return next
    })
    setPendingDeletes((prev) => new Set([...prev, listingImageId]))
  }, [])

  // Quick-add: copy a master image URL to a channel as a pending listing image
  const addToChannel = useCallback((
    url: string,
    masterImageId: string,
    channel: 'amazon' | 'ebay' | 'shopify' | 'all',
  ) => {
    if (channel === 'all') {
      addPendingUpsert({
        scope: 'GLOBAL',
        platform: null,
        marketplace: null,
        url,
        sourceProductImageId: masterImageId,
        role: 'GALLERY',
        position: 999,
      })
    } else {
      const platform = channel === 'amazon' ? 'AMAZON' : channel === 'ebay' ? 'EBAY' : 'SHOPIFY'
      addPendingUpsert({
        scope: 'PLATFORM',
        platform,
        marketplace: null,
        url,
        sourceProductImageId: masterImageId,
        role: 'GALLERY',
        position: 999,
      })
    }
  }, [addPendingUpsert])

  // ── Save ─────────────────────────────────────────────────────────────
  const savePending = useCallback(async (): Promise<boolean> => {
    if (pendingUpserts.size === 0 && pendingDeletes.size === 0) return true
    setSaving(true)
    try {
      const res = await beFetch(`/api/products/${productId}/images-workspace/bulk-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts: Array.from(pendingUpserts.values()).map(({ _tempId, ...rest }) => rest),
          deletes: Array.from(pendingDeletes),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Save failed: ${res.status}`)
      }
      setPendingUpserts(new Map())
      setPendingDeletes(new Set())
      await load()
      return true
    } catch (err) {
      console.error('[useImagesWorkspace] savePending failed', err)
      return false
    } finally {
      setSaving(false)
    }
  }, [productId, pendingUpserts, pendingDeletes, load])

  const discardPending = useCallback(() => {
    setPendingUpserts(new Map())
    setPendingDeletes(new Set())
  }, [])

  // ── Cross-channel copy ───────────────────────────────────────────────
  // Reads server listing images (+ master) and creates pending upserts
  // to copy images from one channel/scope into another.
  //
  // type:
  //   'gallery'   – product-level images (no variantGroup)
  //   'colorSets' – variant-group images (variantGroupKey = activeAxis)
  //   'all'       – both
  //
  // Returns { copied, skipped } so the caller can show a toast.
  const copyChannelImages = useCallback((opts: {
    fromPlatform: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'MASTER'
    toPlatform: 'AMAZON' | 'EBAY' | 'SHOPIFY'
    type: 'gallery' | 'colorSets' | 'all'
    activeAxis: string
    overwrite?: boolean
  }): { copied: number; skipped: number } => {
    if (!data) return { copied: 0, skipped: 0 }
    const { fromPlatform, toPlatform, type, activeAxis, overwrite = false } = opts

    type SrcItem = {
      url: string
      variantGroupKey: string | null
      variantGroupValue: string | null
      position: number
      sourceId: string
    }

    let sourceItems: SrcItem[]

    if (fromPlatform === 'MASTER') {
      // MM — copy only IMAGE media to channels; videos aren't gallery images.
      sourceItems = data.master
        .filter((img) => (img.mediaType ?? 'IMAGE') === 'IMAGE')
        .map((img, idx) => ({
        url: img.url,
        variantGroupKey: null,
        variantGroupValue: null,
        position: idx,
        sourceId: img.id,
      }))
    } else {
      sourceItems = data.listing
        .filter((img) => img.platform === fromPlatform)
        .filter((img) => {
          if (type === 'gallery') return !img.variantGroupKey
          if (type === 'colorSets') return !!img.variantGroupKey && img.variantGroupKey === activeAxis
          return true
        })
        .map((img) => ({
          url: img.url,
          variantGroupKey: img.variantGroupKey,
          variantGroupValue: img.variantGroupValue,
          position: img.position,
          sourceId: img.id,
        }))
    }

    let copied = 0
    let skipped = 0

    for (const src of sourceItems) {
      if (!overwrite) {
        // Skip if target already has an image for this variantGroup (or gallery position)
        const existsOnServer = data.listing.some((li) =>
          li.platform === toPlatform &&
          (li.variantGroupKey ?? null) === (src.variantGroupKey ?? null) &&
          (li.variantGroupValue ?? null) === (src.variantGroupValue ?? null),
        )
        const existsInPending = Array.from(pendingUpserts.values()).some((u) =>
          u.platform === toPlatform &&
          (u.variantGroupKey ?? null) === (src.variantGroupKey ?? null) &&
          (u.variantGroupValue ?? null) === (src.variantGroupValue ?? null),
        )
        if (existsOnServer || existsInPending) { skipped++; continue }
      }

      addPendingUpsert({
        scope: 'PLATFORM',
        platform: toPlatform,
        marketplace: null,
        variantGroupKey: src.variantGroupKey,
        variantGroupValue: src.variantGroupValue,
        url: src.url,
        sourceProductImageId: src.sourceId,
        role: src.variantGroupKey ? 'GALLERY' : (src.position === 0 ? 'MAIN' : 'GALLERY'),
        position: src.position,
      })
      copied++
    }

    return { copied, skipped }
  }, [data, pendingUpserts, addPendingUpsert])

  // ── Axis preference ──────────────────────────────────────────────────
  const setAxisPreference = useCallback(async (axis: string) => {
    // Optimistic update
    setData((prev) =>
      prev ? { ...prev, product: { ...prev.product, imageAxisPreference: axis } } : prev,
    )
    try {
      await beFetch(`/api/products/${productId}/images-workspace/axis`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axis }),
      })
    } catch {
      // Non-fatal — local state still reflects the choice
    }
  }, [productId])

  // IA.12 — Optimistic patches. Callers update local state instead
  // of calling reload() after every mutation. The patch functions
  // are no-ops when the workspace hasn't loaded yet (data === null).
  // On a background-POST failure, caller falls back to reload() to
  // re-sync.
  const setMasterImages = useCallback((updater: (prev: ProductImage[]) => ProductImage[]) => {
    setData((prev) => {
      if (!prev) return prev
      const next = updater(prev.master)
      // AC.5b — push the new master image list into the in-page
      // draft bus so the Amazon Listing Cockpit's preview + health
      // panel react instantly to image edits (reorder, primary
      // change, add, delete) without waiting for a router.refresh.
      // useAmazonCompositor reads draft.images and overlays the
      // url/sortOrder/isPrimary/type quad onto product.images.
      pushImagesDraft(productId, next)
      return { ...prev, master: next }
    })
  }, [productId])
  const patchMasterImage = useCallback((id: string, patch: Partial<ProductImage>) => {
    setData((prev) => {
      if (!prev) return prev
      const next = prev.master.map((m) => (m.id === id ? { ...m, ...patch } : m))
      pushImagesDraft(productId, next)
      return { ...prev, master: next }
    })
  }, [productId])
  // Real-time — optimistic patch of listing rows (e.g. bulk lock/unlock) so the
  // matrix reflects the change instantly instead of waiting for a full reload.
  const patchListingImages = useCallback((ids: string[], patch: Partial<ListingImage>) => {
    const idSet = new Set(ids)
    setData((prev) =>
      prev ? { ...prev, listing: prev.listing.map((li) => (idSet.has(li.id) ? { ...li, ...patch } : li)) } : prev,
    )
  }, [])

  // IA.19 — Restore pending state to a captured snapshot. Used by
  // the undo-last-drag affordance: operator drags → we snapshot
  // before-state → toast shows "Undo" → click reverts to snapshot.
  // Atomic: both pendingUpserts and pendingDeletes flip in one
  // render so the matrix doesn't flash a half-undone state.
  const restorePending = useCallback((
    upserts: Map<string, PendingUpsert>,
    deletes: Set<string>,
  ) => {
    setPendingUpserts(new Map(upserts))
    setPendingDeletes(new Set(deletes))
  }, [])

  return {
    data,
    loading,
    loadError,
    saving,
    reload: load,
    pendingUpserts,
    pendingDeletes,
    dirtyCount,
    addPendingUpsert,
    removePendingUpsert,
    addPendingDelete,
    addToChannel,
    copyChannelImages,
    savePending,
    discardPending,
    setAxisPreference,
    // IA.12 — optimistic local patches
    setMasterImages,
    patchMasterImage,
    patchListingImages,
    // IA.19 — undo-last-drag snapshot restore
    restorePending,
  }
}
