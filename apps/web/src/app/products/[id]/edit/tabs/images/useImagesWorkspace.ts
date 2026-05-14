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
import type { WorkspaceData, PendingUpsert } from './types'

let _tempIdCounter = 0
function tempId(): string {
  return `tmp_${++_tempIdCounter}`
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
      const res = await fetch(`/api/products/${productId}/images-workspace`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
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
      const res = await fetch(`/api/products/${productId}/images-workspace/bulk-save`, {
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
      sourceItems = data.master.map((img, idx) => ({
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
      await fetch(`/api/products/${productId}/images-workspace/axis`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axis }),
      })
    } catch {
      // Non-fatal — local state still reflects the choice
    }
  }, [productId])

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
  }
}
