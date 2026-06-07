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
import { beFetch } from '../api'
import { fireBrowserNotification } from '@/lib/notifications/browser-notifications'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary, AmazonJobSummary } from '../types'

// M6 — PS01..PS06 are Amazon's Product-Safety (GPSR) image slots. Ordered
// MAIN → PT → PS → SWCH to match the schema taxonomy. The matrix renders
// columns straight off ALL_SLOTS, so adding them here surfaces the PS columns.
export type AmazonSlot =
  | 'MAIN'
  | 'PT01' | 'PT02' | 'PT03' | 'PT04' | 'PT05' | 'PT06' | 'PT07' | 'PT08'
  | 'PS01' | 'PS02' | 'PS03' | 'PS04' | 'PS05' | 'PS06'
  | 'SWCH'
export const ALL_SLOTS: AmazonSlot[] = [
  'MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08',
  'PS01', 'PS02', 'PS03', 'PS04', 'PS05', 'PS06', 'SWCH',
]
export const SLOT_LABELS: Record<AmazonSlot, string> = {
  MAIN: 'Main', PT01: 'PT01', PT02: 'PT02', PT03: 'PT03', PT04: 'PT04',
  PT05: 'PT05', PT06: 'PT06', PT07: 'PT07', PT08: 'PT08',
  PS01: 'PS01', PS02: 'PS02', PS03: 'PS03', PS04: 'PS04', PS05: 'PS05', PS06: 'PS06',
  SWCH: 'Swatch',
}

const SLOT_ROLE: Record<AmazonSlot, string> = {
  MAIN: 'MAIN', SWCH: 'SWATCH',
  PT01: 'GALLERY', PT02: 'GALLERY', PT03: 'GALLERY', PT04: 'GALLERY',
  PT05: 'GALLERY', PT06: 'GALLERY', PT07: 'GALLERY', PT08: 'GALLERY',
  PS01: 'INFOGRAPHIC', PS02: 'INFOGRAPHIC', PS03: 'INFOGRAPHIC',
  PS04: 'INFOGRAPHIC', PS05: 'INFOGRAPHIC', PS06: 'INFOGRAPHIC',
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
  /** BE — server lock flag; bulk Delete / Clear-override skip locked cells. */
  locked?: boolean
  hasWhiteBackground?: boolean | null
  width?: number | null
  height?: number | null
  publishStatus?: string
  publishError?: string | null
  // IE.3 — set when the cell renders the master gallery image as
  // the cascade's final fallback (no ListingImage row at any scope).
  // Distinct from `origin: 'inherited'`, which is also set on
  // Platform-scope and All-Colors fallbacks. When true, the matrix
  // renders a chain-link badge + dashed border so the operator sees
  // "this is the default; override by dropping a variant image".
  fromMaster?: boolean
  masterImageId?: string
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
  /** IA.10 — Server rows queued for deletion. Resolver skips these
   *  so a "revert" or cell-move "source delete" reflects in the UI
   *  immediately, not after Save+reload. */
  pendingDeletes?: Set<string>
  addPendingUpsert: (u: Omit<PendingUpsert, '_tempId'>) => void
  amazonJobs: AmazonJobSummary[]
  onSavePending: () => Promise<boolean>
  onReload: () => void
  // PB.9 — fired after a successful publish to a specific marketplace.
  // Owner captures the per-marketplace snapshot. Optional so callers
  // that don't care about rollback can skip wiring.
  onPublishSuccess?: (marketplace: AmazonMarketplace) => void
}

export function useAmazonImages({
  productId,
  variants,
  listingImages,
  masterImages,
  activeAxis,
  pendingUpserts,
  pendingDeletes,
  addPendingUpsert,
  amazonJobs,
  onSavePending,
  onReload,
  onPublishSuccess,
}: UseAmazonImagesInput) {
  const [activeMarketplace, setActiveMarketplace] = useState<AmazonMarketplace>('ALL')
  const [imagePicker, setImagePicker] = useState<ImagePickerState | null>(null)
  const [columnFill, setColumnFill] = useState<ColumnFillState | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishingAll, setPublishingAll] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [feedJobs, setFeedJobs] = useState<FeedJobStatus[]>([])
  // One poll timer PER job id — publishAll queues several markets at once and a
  // single shared timer meant only the last market ever polled (the rest stuck
  // on IN_QUEUE forever).
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  // PB.15 — Ref-mirror of feedJobs so the poll callback can read the
  // latest array without rebuilding the interval on every change.
  const feedJobsRef = useRef<FeedJobStatus[]>([])

  // Group variants by activeAxis.
  // 'ASIN' and 'SKU' are virtual axes — they pull from dedicated fields
  // rather than variantAttributes, giving one row per ASIN or per SKU.
  const variantGroups = useMemo<VariantGroup[]>(() => {
    const map = new Map<string, VariantSummary[]>()
    for (const v of variants) {
      let val: string
      if (activeAxis === 'ASIN') {
        val = v.amazonAsin ?? '—'
      } else if (activeAxis === 'SKU') {
        val = v.sku
      } else {
        val = (v.variantAttributes as Record<string, string> | null)?.[activeAxis] ?? '—'
      }
      if (!map.has(val)) map.set(val, [])
      map.get(val)!.push(v)
    }
    return Array.from(map.entries()).map(([groupValue, vs]) => ({
      groupValue,
      variants: vs,
      displayAsin: activeAxis === 'ASIN' ? groupValue : (vs.find((v) => v.amazonAsin)?.amazonAsin ?? null),
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

  // ── Master-gallery slot mapping ────────────────────────────────────
  // IE.3 — When no ListingImage row covers a (group, slot) cell at
  // any scope, the matrix falls back to a master image so the
  // common "all variants share MAIN + lifestyle shots" case
  // requires zero manual drags. Mapping:
  //   MAIN     → master image with type='MAIN' (first, by sortOrder)
  //   SWCH     → master image with type='SWATCH'
  //   PT01–08  → nth master image with type='LIFESTYLE' (then 'ALT' as overflow)
  const resolveMasterForSlot = useCallback((slot: AmazonSlot): ProductImage | null => {
    // MM.1 — image slots only ever resolve IMAGE masters; gallery videos
    // (mediaType=VIDEO) must never be picked into an image slot. Legacy rows
    // with no mediaType are treated as IMAGE.
    const imgs = masterImages.filter((m) => (m.mediaType ?? 'IMAGE') === 'IMAGE')
    if (slot === 'MAIN') {
      // PG.4 hero override beats type=MAIN: an operator who marked a
      // LIFESTYLE shot as "primary" wants that one as the Amazon MAIN.
      return (
        imgs.find((m) => m.isPrimary)
        ?? imgs.find((m) => m.type === 'MAIN')
        ?? null
      )
    }
    if (slot === 'SWCH') {
      return imgs.find((m) => m.type === 'SWATCH') ?? null
    }
    // PT01..PT08 → 0..7 into the [LIFESTYLE, then ALT] sequence.
    // Sorted by sortOrder upstream in useImagesWorkspace.
    const idx = parseInt(slot.slice(2), 10) - 1
    const lifestyles = imgs.filter((m) => m.type === 'LIFESTYLE')
    if (idx < lifestyles.length) return lifestyles[idx]
    const alts = imgs.filter((m) => m.type === 'ALT')
    const overflow = idx - lifestyles.length
    if (overflow >= 0 && overflow < alts.length) return alts[overflow]
    return null
  }, [masterImages])

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

    // 1. Pending (exact marketplace). IA.11 — empty url = blocker row;
    // the cell is explicitly empty and the cascade short-circuits here
    // (no fallback to inherited / master). Used by drag-move to clear
    // the source cell even when its image came from a parent scope.
    for (const u of pendingUpserts.values()) {
      if (u.platform !== 'AMAZON' || u.amazonSlot !== slot) continue
      if (!matchesGroup(u as any) || !matchesMkt(u)) continue
      if (!u.url) return null
      return { url: u.url, origin: 'own', isPending: true }
    }

    // 2. Server (exact scope/marketplace) — skip rows queued for delete.
    const serverOwn = listingImages.find((img) =>
      img.platform === 'AMAZON' &&
      img.amazonSlot === slot &&
      img.scope === targetScope &&
      img.marketplace === targetMkt &&
      matchesGroup(img) &&
      !pendingDeletes?.has(img.id),
    )
    if (serverOwn) {
      if (!serverOwn.url) return null  // IA.11 blocker on server row
      return {
        url: serverOwn.url, origin: 'own', isPending: false,
        listingImageId: serverOwn.id, hasWhiteBackground: serverOwn.hasWhiteBackground,
        width: serverOwn.width, height: serverOwn.height,
        publishStatus: serverOwn.publishStatus, publishError: serverOwn.publishError,
        locked: serverOwn.locked,
      }
    }

    // 3. If viewing specific marketplace: check All Markets (PLATFORM scope) as inherited
    if (!isAll) {
      // Pending All Markets
      for (const u of pendingUpserts.values()) {
        if (u.platform !== 'AMAZON' || u.amazonSlot !== slot || u.scope !== 'PLATFORM' || u.marketplace) continue
        if (!matchesGroup(u as any)) continue
        if (!u.url) return null  // IA.11 — blocker at Platform suppresses master fallback for this group
        return { url: u.url, origin: 'inherited', isPending: true }
      }
      // Server All Markets — skip pending deletes
      const serverPlatform = listingImages.find((img) =>
        img.platform === 'AMAZON' && img.amazonSlot === slot &&
        img.scope === 'PLATFORM' && !img.marketplace && matchesGroup(img) &&
        !pendingDeletes?.has(img.id),
      )
      if (serverPlatform) {
        if (!serverPlatform.url) return null
        return {
          url: serverPlatform.url, origin: 'inherited', isPending: false,
          listingImageId: serverPlatform.id, hasWhiteBackground: serverPlatform.hasWhiteBackground,
          width: serverPlatform.width, height: serverPlatform.height,
          publishStatus: serverPlatform.publishStatus,
          locked: serverPlatform.locked,
        }
      }
    }

    // 4. If groupValue is set, fall back to All Colors (groupValue=null) as inherited
    if (groupValue !== null) {
      const fallback = resolveCell(null, slot, marketplace)
      if (fallback) return { ...fallback, origin: 'inherited' }
      // groupValue !== null but no All-Colors row either → check master
      // directly so a variant row inherits straight from the gallery
      // without an intermediate All-Colors record.
    }

    // 5. IE.3 — Master gallery fallback. No ListingImage row exists at
    // any scope, so surface the master image whose type maps to this
    // slot. Operator sees the gallery image with a chain-link badge;
    // dropping a variant image on the cell creates the override that
    // wins over this default in the cascade above.
    const masterImg = resolveMasterForSlot(slot)
    if (masterImg) {
      return {
        url: masterImg.url,
        origin: 'inherited',
        isPending: false,
        width: masterImg.width,
        height: masterImg.height,
        hasWhiteBackground: null,
        fromMaster: true,
        masterImageId: masterImg.id,
      }
    }

    return null
  }, [activeMarketplace, activeAxis, listingImages, pendingUpserts, pendingDeletes, resolveMasterForSlot])

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
  const publish = useCallback(async (marketplace: AmazonMarketplace): Promise<{ ok: boolean; error?: string }> => {
    if (marketplace === 'ALL') return { ok: false }
    setPublishing(true)
    setPublishError(null)
    try {
      // Save pending first
      const saved = await onSavePending()
      if (!saved) { const e = 'Save failed — fix errors before publishing'; setPublishError(e); return { ok: false, error: e } }

      const res = await beFetch(`/api/products/${productId}/amazon-images/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace, activeAxis }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // Prefer the human message (e.g. "Every variant is blocked: …") over the
        // bare code so the bar shows something actionable, not "VALIDATION_FAILED".
        const e = (body?.message as string) ?? (body?.error as string) ?? `Publish failed: ${res.status}`
        setPublishError(e)
        return { ok: false, error: e }
      }
      const data: { jobId: string; feedId: string | null; skus: string[]; skippedAsins?: number } = await res.json()
      setFeedJobs((prev) => [{
        jobId: data.jobId, marketplace,
        status: 'IN_QUEUE', submittedAt: new Date().toISOString(),
        skuCount: data.skus.length,
      }, ...prev])
      startPolling(data.jobId)
      // PB.9 — Notify owner so it can capture a rollback snapshot.
      onPublishSuccess?.(marketplace)
      // Partial publish — some variants were skipped (e.g. no MAIN). Surface it.
      if (data.skippedAsins && data.skippedAsins > 0) {
        setPublishError(`${marketplace}: published, but ${data.skippedAsins} variant${data.skippedAsins === 1 ? '' : 's'} skipped (no MAIN). Add a MAIN, then re-publish.`)
      }
      return { ok: true }
    } catch (err) {
      const e = err instanceof Error ? err.message : 'Publish failed'
      setPublishError(e)
      return { ok: false, error: e }
    } finally {
      setPublishing(false)
    }
  }, [productId, activeAxis, onSavePending, onPublishSuccess])

  function startPolling(jobId: string) {
    const timers = pollTimersRef.current
    const prior = timers.get(jobId)
    if (prior) clearInterval(prior)
    const stop = () => { const t = pollTimersRef.current.get(jobId); if (t) { clearInterval(t); pollTimersRef.current.delete(jobId) } }
    const timer = setInterval(async () => {
      const res = await beFetch(`/api/products/${productId}/amazon-images/feed-status/${jobId}`)
      if (!res.ok) return
      const { status } = await res.json()
      let priorStatus: string | undefined
      setFeedJobs((prev) => {
        const existing = prev.find((j) => j.jobId === jobId)
        priorStatus = existing?.status
        return prev.map((j) => j.jobId === jobId ? { ...j, status } : j)
      })
      if (['DONE', 'FATAL', 'CANCELLED'].includes(status)) {
        stop()
        onReload()
        // PB.15 — Browser notification on terminal transition.
        // Only fires when the status genuinely changed (avoids
        // dupes on re-render) and the operator has opted in.
        if (priorStatus !== status) {
          const job = feedJobsRef.current.find((j) => j.jobId === jobId)
          const marketplace = job?.marketplace ?? '?'
          if (status === 'DONE') {
            fireBrowserNotification('imagePublishComplete', `Amazon ${marketplace} image feed complete`, {
              body: `${job?.skuCount ?? 0} SKU${job?.skuCount === 1 ? '' : 's'} processed.`,
              tagSuffix: jobId,
            })
          } else {
            fireBrowserNotification('imagePublishFailed', `Amazon ${marketplace} image feed ${status.toLowerCase()}`, {
              body: 'Open the recent-jobs strip on the product to see Amazon\'s error.',
              tagSuffix: jobId,
            })
          }
        }
      }
    }, 30_000)
    timers.set(jobId, timer)
  }

  // PB.15 — Keep ref in sync so the poll callback reads latest.
  useEffect(() => { feedJobsRef.current = feedJobs }, [feedJobs])

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
    // Resume polling for any job still in flight (tab closed mid-publish, or
    // publishAll left several markets queued) so the badge resolves instead of
    // spinning on IN_QUEUE forever.
    for (const j of amazonJobs) {
      if (!['DONE', 'FATAL', 'CANCELLED'].includes(j.status)) startPolling(j.id)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const publishAll = useCallback(async () => {
    setPublishingAll(true)
    setPublishError(null)
    const failures: string[] = []
    try {
      for (const mkt of AMAZON_MARKETPLACES) {
        const r = await publish(mkt)
        if (!r.ok) failures.push(`${mkt}: ${r.error ?? 'failed'}`)
      }
    } finally {
      setPublishingAll(false)
    }
    // Each publish() clears publishError on entry, so without this a market that
    // failed mid-run would leave no visible error. Surface a combined summary.
    if (failures.length > 0) setPublishError(`Some markets failed — ${failures.join(' · ')}`)
  }, [publish])

  // Cleanup on unmount — clear every per-job timer.
  useEffect(() => () => { for (const t of pollTimersRef.current.values()) clearInterval(t); pollTimersRef.current.clear() }, [])

  return {
    activeMarketplace, setActiveMarketplace,
    variantGroups, populatedMarketplaces,
    resolveCell, assignCell, assignColumn,
    imagePicker, setImagePicker,
    columnFill, setColumnFill,
    publishing, publishingAll, publishError,
    feedJobs,
    publish, publishAll,
    masterImages,
  }
}
