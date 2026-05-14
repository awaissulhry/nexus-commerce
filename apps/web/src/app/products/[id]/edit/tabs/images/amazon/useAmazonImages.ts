'use client'

// IM.4 — Amazon images state hook.
//
// Manages:
//   - activeMarketplace (All Markets | IT | DE | FR | ES)
//   - variantGroups: variants grouped by activeAxis (e.g. Color)
//   - resolveCell: cascade resolution for a (groupValue, slot) pair
//   - assignCell / assignColumn: creates pending upserts via addPendingUpsert
//   - imagePicker state (which cell triggered the picker)
//   - columnFill state (drag-to-header fill confirmation)
//   - publish: calls POST /api/products/:id/amazon-images/publish + polls

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary, AmazonJobSummary } from '../types'

export type AmazonSlot = 'MAIN' | 'PT01' | 'PT02' | 'PT03' | 'PT04' | 'PT05' | 'PT06' | 'PT07' | 'PT08' | 'SWCH'
export const ALL_SLOTS: AmazonSlot[] = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'SWCH']
export const SLOT_LABELS: Record<AmazonSlot, string> = {
  MAIN: 'Main', PT01: 'PT01', PT02: 'PT02', PT03: 'PT03', PT04: 'PT04',
  PT05: 'PT05', PT06: 'PT06', PT07: 'PT07', PT08: 'PT08', SWCH: 'Swatch',
}

const SLOT_ROLE: Record<AmazonSlot, string> = {
  MAIN: 'MAIN', SWCH: 'SWATCH',
  PT01: 'GALLERY', PT02: 'GALLERY', PT03: 'GALLERY', PT04: 'GALLERY',
  PT05: 'GALLERY', PT06: 'GALLERY', PT07: 'GALLERY', PT08: 'GALLERY',
}

export const AMAZON_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
export type AmazonMarketplace = 'ALL' | typeof AMAZON_MARKETPLACES[number]

export interface VariantGroup {
  groupValue: string
  variants: VariantSummary[]
  displayAsin: string | null
  displaySku: string
}

export interface CellDisplay {
  url: string
  origin: 'own' | 'inherited'   // own = exact scope match, inherited = fallback
  isPending: boolean
  listingImageId?: string
  hasWhiteBackground?: boolean | null
  width?: number | null
  height?: number | null
  publishStatus?: string
  publishError?: string | null
}

export interface ImagePickerState {
  groupValue: string | null    // null = All Colors row
  slot: AmazonSlot
}

export interface ColumnFillState {
  slot: AmazonSlot
  url: string
  sourceId?: string
}

interface FeedJobStatus {
  jobId: string
  marketplace: string
  status: string
  submittedAt: string
  completedAt?: string | null
  errorMessage?: string | null
  skuCount: number
}

interface UseAmazonImagesInput {
  productId: string
  variants: VariantSummary[]
  listingImages: ListingImage[]
  masterImages: ProductImage[]
  activeAxis: string
  pendingUpserts: Map<string, PendingUpsert>
  addPendingUpsert: (u: Omit<PendingUpsert, '_tempId'>) => void
  amazonJobs: AmazonJobSummary[]
  onSavePending: () => Promise<boolean>
  onReload: () => void
}

export function useAmazonImages({
  productId,
  variants,
  listingImages,
  masterImages,
  activeAxis,
  pendingUpserts,
  addPendingUpsert,
  amazonJobs,
  onSavePending,
  onReload,
}: UseAmazonImagesInput) {
  const [activeMarketplace, setActiveMarketplace] = useState<AmazonMarketplace>('ALL')
  const [imagePicker, setImagePicker] = useState<ImagePickerState | null>(null)
  const [columnFill, setColumnFill] = useState<ColumnFillState | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [feedJobs, setFeedJobs] = useState<FeedJobStatus[]>([])
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Group variants by activeAxis
  const variantGroups = useMemo<VariantGroup[]>(() => {
    const map = new Map<string, VariantSummary[]>()
    for (const v of variants) {
      const val = (v.variantAttributes as Record<string, string> | null)?.[activeAxis] ?? '—'
      if (!map.has(val)) map.set(val, [])
      map.get(val)!.push(v)
    }
    return Array.from(map.entries()).map(([groupValue, vs]) => ({
      groupValue,
      variants: vs,
      displayAsin: vs.find((v) => v.amazonAsin)?.amazonAsin ?? null,
      displaySku: vs[0]?.sku ?? groupValue,
    }))
  }, [variants, activeAxis])

  // Which marketplaces have any listing images (show tab as "active")
  const populatedMarketplaces = useMemo(() => {
    const set = new Set<string>()
    for (const img of listingImages) {
      if (img.platform === 'AMAZON' && img.marketplace) set.add(img.marketplace)
    }
    return set
  }, [listingImages])

  // ── Cell resolution ────────────────────────────────────────────────
  const resolveCell = useCallback((
    groupValue: string | null,
    slot: AmazonSlot,
    marketplace: AmazonMarketplace = activeMarketplace,
  ): CellDisplay | null => {
    const isAll = marketplace === 'ALL'
    const targetScope = isAll ? 'PLATFORM' : 'MARKETPLACE'
    const targetMkt = isAll ? null : marketplace

    function matchesGroup(img: { variantGroupKey: string | null; variantGroupValue: string | null }): boolean {
      if (groupValue === null) return !img.variantGroupKey && !img.variantGroupValue
      return img.variantGroupKey === activeAxis && img.variantGroupValue === groupValue
    }

    function matchesMkt(u: PendingUpsert): boolean {
      return u.scope === targetScope && (targetMkt === null ? !u.marketplace : u.marketplace === targetMkt)
    }

    // 1. Pending (exact marketplace)
    for (const u of pendingUpserts.values()) {
      if (u.platform !== 'AMAZON' || u.amazonSlot !== slot) continue
      if (!matchesGroup(u as any) || !matchesMkt(u)) continue
      return { url: u.url, origin: 'own', isPending: true }
    }

    // 2. Server (exact scope/marketplace)
    const serverOwn = listingImages.find((img) =>
      img.platform === 'AMAZON' &&
      img.amazonSlot === slot &&
      img.scope === targetScope &&
      img.marketplace === targetMkt &&
      matchesGroup(img),
    )
    if (serverOwn) {
      return {
        url: serverOwn.url, origin: 'own', isPending: false,
        listingImageId: serverOwn.id, hasWhiteBackground: serverOwn.hasWhiteBackground,
        width: serverOwn.width, height: serverOwn.height,
        publishStatus: serverOwn.publishStatus, publishError: serverOwn.publishError,
      }
    }

    // 3. If viewing specific marketplace: check All Markets (PLATFORM scope) as inherited
    if (!isAll) {
      // Pending All Markets
      for (const u of pendingUpserts.values()) {
        if (u.platform !== 'AMAZON' || u.amazonSlot !== slot || u.scope !== 'PLATFORM' || u.marketplace) continue
        if (!matchesGroup(u as any)) continue
        return { url: u.url, origin: 'inherited', isPending: true }
      }
      // Server All Markets
      const serverPlatform = listingImages.find((img) =>
        img.platform === 'AMAZON' && img.amazonSlot === slot &&
        img.scope === 'PLATFORM' && !img.marketplace && matchesGroup(img),
      )
      if (serverPlatform) {
        return {
          url: serverPlatform.url, origin: 'inherited', isPending: false,
          listingImageId: serverPlatform.id, hasWhiteBackground: serverPlatform.hasWhiteBackground,
          width: serverPlatform.width, height: serverPlatform.height,
          publishStatus: serverPlatform.publishStatus,
        }
      }
    }

    // 4. If groupValue is set, fall back to All Colors (groupValue=null) as inherited
    if (groupValue !== null) {
      const fallback = resolveCell(null, slot, marketplace)
      return fallback ? { ...fallback, origin: 'inherited' } : null
    }

    return null
  }, [activeMarketplace, activeAxis, listingImages, pendingUpserts])

  // ── Cell assignment ────────────────────────────────────────────────
  const assignCell = useCallback((
    groupValue: string | null,
    slot: AmazonSlot,
    url: string,
    sourceId?: string,
  ) => {
    const isAll = activeMarketplace === 'ALL'

    // Find existing server row to update (or create new)
    const existing = listingImages.find((img) =>
      img.platform === 'AMAZON' &&
      img.amazonSlot === slot &&
      img.scope === (isAll ? 'PLATFORM' : 'MARKETPLACE') &&
      img.marketplace === (isAll ? null : activeMarketplace) &&
      (groupValue === null
        ? !img.variantGroupKey
        : img.variantGroupKey === activeAxis && img.variantGroupValue === groupValue),
    )

    addPendingUpsert({
      id: existing?.id,
      scope: isAll ? 'PLATFORM' : 'MARKETPLACE',
      platform: 'AMAZON',
      marketplace: isAll ? null : activeMarketplace,
      amazonSlot: slot,
      variantGroupKey: groupValue !== null ? activeAxis : null,
      variantGroupValue: groupValue,
      url,
      sourceProductImageId: sourceId,
      role: SLOT_ROLE[slot],
      position: ALL_SLOTS.indexOf(slot),
    })
  }, [activeMarketplace, activeAxis, listingImages, addPendingUpsert])

  // ── Column fill ────────────────────────────────────────────────────
  const assignColumn = useCallback((
    slot: AmazonSlot,
    url: string,
    mode: 'empty' | 'all',
    sourceId?: string,
  ) => {
    // Fill each variant group row
    for (const group of variantGroups) {
      if (mode === 'empty' && resolveCell(group.groupValue, slot)) continue
      assignCell(group.groupValue, slot, url, sourceId)
    }
    // Fill All Colors row
    if (mode === 'empty' && resolveCell(null, slot)) return
    assignCell(null, slot, url, sourceId)
  }, [variantGroups, resolveCell, assignCell])

  // ── Publish ────────────────────────────────────────────────────────
  const publish = useCallback(async (marketplace: AmazonMarketplace) => {
    if (marketplace === 'ALL') return
    setPublishing(true)
    setPublishError(null)
    try {
      // Save pending first
      const saved = await onSavePending()
      if (!saved) { setPublishError('Save failed — fix errors before publishing'); return }

      const res = await fetch(`/api/products/${productId}/amazon-images/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace, activeAxis }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Publish failed: ${res.status}`)
      }
      const data: { jobId: string; feedId: string | null; skus: string[] } = await res.json()
      setFeedJobs((prev) => [{
        jobId: data.jobId, marketplace,
        status: 'IN_QUEUE', submittedAt: new Date().toISOString(),
        skuCount: data.skus.length,
      }, ...prev])
      startPolling(data.jobId)
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }, [productId, activeAxis, onSavePending])

  function startPolling(jobId: string) {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    pollTimerRef.current = setInterval(async () => {
      const res = await fetch(`/api/products/${productId}/amazon-images/feed-status/${jobId}`)
      if (!res.ok) return
      const { status } = await res.json()
      setFeedJobs((prev) => prev.map((j) => j.jobId === jobId ? { ...j, status } : j))
      if (['DONE', 'FATAL', 'CANCELLED'].includes(status)) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current)
        onReload()
      }
    }, 30_000)
  }

  // Seed feedJobs from workspace amazonJobs on mount
  useEffect(() => {
    setFeedJobs(amazonJobs.map((j) => ({
      jobId: j.id,
      marketplace: j.marketplace,
      status: j.status,
      submittedAt: j.submittedAt,
      completedAt: j.completedAt,
      errorMessage: j.errorMessage,
      skuCount: Array.isArray(j.skus) ? (j.skus as string[]).length : 0,
    })))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current) }, [])

  return {
    activeMarketplace, setActiveMarketplace,
    variantGroups, populatedMarketplaces,
    resolveCell, assignCell, assignColumn,
    imagePicker, setImagePicker,
    columnFill, setColumnFill,
    publishing, publishError,
    feedJobs,
    publish,
    masterImages,
  }
}
