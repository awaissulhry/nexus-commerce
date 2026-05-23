'use client'

// IM.3 — Master image panel.
//
// Full-featured master gallery: upload, DnD reorder, delete, type/alt
// edit, and per-image context menu with quick "add to channel" actions.
// All master operations persist immediately (same as previous ImagesTab).
// "Add to channel" creates a pending listing-image via addToChannel().

import { useCallback, useEffect, useRef, useState } from 'react'
import { beFetch } from './api'
import {
  AlertTriangle,
  CheckSquare,
  Image as ImageIcon,
  Library,
  Loader2,
  MoreHorizontal,
  Plus,
  Share2,
  Sparkles,
  Square,
  Star,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import ScopeUploadModal, { type ScopeChoice } from './ScopeUploadModal'
import BulkApplyModal from './BulkApplyModal'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary, WorkspaceProduct } from './types'

const IMAGE_TYPES = ['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'] as const
type ImageType = typeof IMAGE_TYPES[number]

// IR.2.5 — Compact metadata subtitle: "1200×1200 · JPG · 245 KB"
// Skips silently when every field is NULL (legacy row pre-backfill).
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatImageMeta(img: ProductImage): string | null {
  const parts: string[] = []
  if (img.width && img.height) parts.push(`${img.width}×${img.height}`)
  if (img.mimeType) parts.push(img.mimeType.replace(/^image\//, '').toUpperCase())
  if (img.fileSize) parts.push(formatBytes(img.fileSize))
  return parts.length > 0 ? parts.join(' · ') : null
}

const TYPE_COLORS: Record<ImageType, string> = {
  MAIN:      'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  ALT:       'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  LIFESTYLE: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  SWATCH:    'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800',
  DIAGRAM:   'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
}

interface Props {
  product: WorkspaceProduct
  images: ProductImage[]
  onImagesChange: (images: ProductImage[]) => void
  onAddToChannel: (url: string, masterImageId: string, channel: 'amazon' | 'ebay' | 'shopify' | 'all') => void
  onToast?: (msg: string) => void
  // IR.3.2 — click on a thumbnail opens the shared lightbox at ImagesTab.
  onOpenLightbox?: (img: ProductImage) => void
  // IR.7.4 — open the DAM library picker.
  onOpenDamPicker?: () => void
  // IR.14 — open the Imagen lifestyle generation modal.
  onOpenLifestyle?: () => void
  // IE.10 — variant-targeted upload. The "Upload to variant…" CTA opens
  // ScopeUploadModal which uses these to populate the axis + value
  // dropdowns and to auto-pick the next free Amazon slot when fanning
  // the new image out into pending ListingImage upserts.
  listingImages?: ListingImage[]
  variants?: VariantSummary[]
  activeAxis?: string
  availableAxes?: string[]
  addPendingUpsert?: (u: Omit<PendingUpsert, '_tempId'>) => void
}

export default function MasterPanel({
  product,
  images,
  onImagesChange,
  onAddToChannel,
  onToast,
  onOpenLightbox,
  onOpenDamPicker,
  onOpenLifestyle,
  listingImages = [],
  variants = [],
  activeAxis = 'Color',
  availableAxes = [],
  addPendingUpsert,
}: Props) {
  const { t } = useTranslations()
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // IE.1.3 — Near-duplicate confirmation state. Set when the backend
  // responds 409 NEAR_DUPLICATE; cleared on either "use existing" or
  // "upload anyway" (the latter re-runs the upload with ?force=true).
  const [nearDup, setNearDup] = useState<{
    file: File
    type: ImageType
    hammingDistance: number
    threshold: number
    candidate: { id: string; url: string; type: string; alt: string | null; width: number | null; height: number | null }
  } | null>(null)
  const [forcingUpload, setForcingUpload] = useState(false)
  // IE.10 — staged files awaiting scope selection. Set when the
  // operator hits "Upload to variant…"; the modal reads from here and
  // calls handleScopedUpload(scope) on confirm.
  const [scopedFiles, setScopedFiles] = useState<File[]>([])
  // IE.12 — master image awaiting bulk-apply target selection.
  const [bulkApplyImage, setBulkApplyImage] = useState<ProductImage | null>(null)
  // IR.8.3 — apply-to-children flow state.
  const [applyConfirm, setApplyConfirm] = useState(false)
  const [applying, setApplying] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editAlt, setEditAlt] = useState('')
  const [editType, setEditType] = useState<ImageType>('ALT')
  const [savingEdit, setSavingEdit] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [dropZoneActive, setDropZoneActive] = useState(false)
  // IM.8 — Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // IR.11.2 — Track which images have finished loading so the
  // skeleton placeholder fades out on completion.
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set())
  const markLoaded = (id: string) => setLoadedIds((prev) => {
    if (prev.has(id)) return prev
    const next = new Set(prev)
    next.add(id)
    return next
  })
  const dragIndexRef = useRef<number | null>(null)
  const newTypeRef = useRef<ImageType>('ALT')

  const selectedCount = selectedIds.size
  const allSelected = images.length > 0 && selectedCount === images.length

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelectedIds(new Set(images.map((i) => i.id)))
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  function applySelectionToChannel(channel: 'amazon' | 'ebay' | 'shopify' | 'all') {
    const selected = images.filter((i) => selectedIds.has(i.id))
    for (const img of selected) {
      onAddToChannel(img.url, img.id, channel)
    }
    const label = channel === 'all' ? 'all channels' : channel.charAt(0).toUpperCase() + channel.slice(1)
    onToast?.(`${selected.length} image${selected.length === 1 ? '' : 's'} added to ${label} — save to confirm`)
    clearSelection()
  }

  // Cmd+A select-all, Esc deselect.
  // Guard against firing while the operator is typing — alt-text inputs,
  // textareas, and contenteditable nodes get the keystroke first.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    const tag = target?.tagName
    const isEditing =
      tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true
    if (isEditing) return

    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      selectAll()
    }
    if (e.key === 'Escape') clearSelection()
  }, [images]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const hasMain = images.some((i) => i.type === 'MAIN')
  const tooFew = images.length > 0 && images.length < 3

  // ── Upload ────────────────────────────────────────────────────────────
  async function handleFiles(files: File[]) {
    if (!files.length) return
    setUploading(true)
    setUploadError(null)
    // Accumulate created rows locally so a multi-file drop only fires
    // a single onImagesChange — important so the React-Query cache
    // doesn't refetch between files.
    let next = images
    try {
      for (const file of files) {
        // IM.10 — file size guard (Shopify max 20 MB; Amazon max 10 MB)
        if (file.size > 20 * 1024 * 1024) {
          setUploadError(`${file.name} exceeds 20 MB — too large for any channel`)
          continue
        }
        const result = await uploadOne(file, newTypeRef.current, false)
        if (result.outcome === 'created') {
          next = [...next, result.image]
        } else if (result.outcome === 'reused') {
          // Already in the gallery — surface a toast but don't add a
          // duplicate card to the grid.
          onToast?.(t('products.edit.images.masterPanel.duplicateReused', {
            type: result.image.type,
          }))
        } else if (result.outcome === 'near-duplicate') {
          // Halt the loop and pop the confirmation modal. Operator
          // either accepts the existing candidate (no further upload)
          // or chooses to upload anyway (force=true re-runs this file).
          setNearDup({
            file,
            type: newTypeRef.current,
            hammingDistance: result.hammingDistance,
            threshold: result.threshold,
            candidate: result.candidate,
          })
          break
        }
      }
      if (next !== images) onImagesChange(next)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  type UploadOutcome =
    | { outcome: 'created'; image: ProductImage }
    | { outcome: 'reused'; image: ProductImage }
    | {
        outcome: 'near-duplicate'
        hammingDistance: number
        threshold: number
        candidate: { id: string; url: string; type: string; alt: string | null; width: number | null; height: number | null }
      }

  async function uploadOne(file: File, type: ImageType, force: boolean): Promise<UploadOutcome> {
    const fd = new FormData()
    fd.append('file', file)
    const qs = new URLSearchParams()
    qs.set('type', type)
    if (force) qs.set('force', 'true')
    const res = await beFetch(
      `/api/products/${product.id}/images?${qs.toString()}`,
      { method: 'POST', body: fd },
    )
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}))
      if (body?.error === 'NEAR_DUPLICATE' && body.candidate) {
        return {
          outcome: 'near-duplicate',
          hammingDistance: body.hammingDistance,
          threshold: body.threshold,
          candidate: body.candidate,
        }
      }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `Upload failed: ${res.status}`)
    }
    const json: ProductImage & { reused?: 'exact' } = await res.json()
    if (json.reused === 'exact') return { outcome: 'reused', image: json }
    return { outcome: 'created', image: json }
  }

  // IE.1.3 — Near-dup modal actions. "use existing" is a no-op (the
  // candidate is already in the gallery); "upload anyway" re-runs the
  // POST with ?force=true so the dedup gate accepts it.
  async function handleNearDupUseExisting() {
    if (!nearDup) return
    onToast?.(t('products.edit.images.masterPanel.duplicateReused', {
      type: nearDup.candidate.type,
    }))
    setNearDup(null)
  }

  // IE.10 — Variant-targeted upload entrypoint. The hidden input fires
  // this with the picked files, we stage them, and ScopeUploadModal
  // opens so the operator picks Master vs Variant + axis + channels
  // before any POST. The dedup gate from IE.1 still runs on each
  // upload regardless of scope.
  const scopedInputRef = useRef<HTMLInputElement>(null)
  function openScopedPicker() {
    scopedInputRef.current?.click()
  }
  function handleScopedInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setScopedFiles(files)
    if (scopedInputRef.current) scopedInputRef.current.value = ''
  }

  // Amazon slot from ProductImage.type, picking the next free PT01..PT08
  // when the type maps to a gallery slot. Reads from listingImages +
  // any pending upserts at the matching scope so we don't collide.
  function nextAmazonSlotForType(t: ImageType, axis: string, val: string): string {
    if (t === 'MAIN') return 'MAIN'
    if (t === 'SWATCH') return 'SWCH'
    const occupied = new Set<string>()
    for (const li of listingImages) {
      if (li.platform === 'AMAZON' && li.variantGroupKey === axis && li.variantGroupValue === val && li.amazonSlot) {
        occupied.add(li.amazonSlot)
      }
    }
    for (let i = 1; i <= 8; i++) {
      const slot = `PT0${i}`
      if (!occupied.has(slot)) return slot
    }
    return 'PT08'
  }

  function nextEbayPosition(): number {
    let max = -1
    for (const li of listingImages) {
      if (li.platform === 'EBAY' && !li.variantGroupKey) max = Math.max(max, li.position)
    }
    return (max + 1) * 10 + 10
  }

  function nextShopifyPosition(): number {
    let max = -1
    for (const li of listingImages) {
      if (li.platform === 'SHOPIFY' && !li.variantGroupKey) max = Math.max(max, li.position)
    }
    return (max + 1) * 10 + 10
  }

  async function handleScopedUpload(scope: ScopeChoice) {
    const files = scopedFiles
    setScopedFiles([])
    if (files.length === 0) return
    setUploading(true)
    setUploadError(null)
    let next = images
    let amazonSlotCursor = 0
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) {
          setUploadError(`${file.name} exceeds 20 MB — too large for any channel`)
          continue
        }
        const result = await uploadOne(file, scope.type, false)
        let masterImage: ProductImage | null = null
        if (result.outcome === 'created') {
          masterImage = result.image
          next = [...next, result.image]
        } else if (result.outcome === 'reused') {
          masterImage = result.image
          onToast?.(t('products.edit.images.masterPanel.duplicateReused', { type: result.image.type }))
        } else if (result.outcome === 'near-duplicate') {
          // For variant uploads we don't gate on near-dup; treat the
          // existing candidate as the master and continue. This matches
          // the "I know this is similar — use it for the variant" intent.
          masterImage = {
            id: result.candidate.id,
            url: result.candidate.url,
            type: result.candidate.type,
          } as ProductImage
          onToast?.(t('products.edit.images.masterPanel.duplicateReused', { type: result.candidate.type }))
        }

        if (!masterImage || scope.kind === 'master' || !addPendingUpsert) continue

        // IE.10 — Fan the master image into pending ListingImage rows
        // for each selected channel + the chosen variant axis value.
        // Amazon slot advances per file so a 3-file PT-batch lands in
        // PT01, PT02, PT03 without colliding on the same row.
        for (const channel of scope.channels) {
          if (channel === 'amazon') {
            const baseSlot = nextAmazonSlotForType(scope.type, scope.axis, scope.value)
            const slot = baseSlot.startsWith('PT')
              ? `PT0${Math.min(8, parseInt(baseSlot.slice(2), 10) + amazonSlotCursor)}`
              : baseSlot
            if (baseSlot.startsWith('PT')) amazonSlotCursor++
            addPendingUpsert({
              scope: 'PLATFORM',
              platform: 'AMAZON',
              marketplace: null,
              amazonSlot: slot,
              variantGroupKey: scope.axis,
              variantGroupValue: scope.value,
              url: masterImage.url,
              sourceProductImageId: masterImage.id,
              role: slot === 'MAIN' ? 'MAIN' : slot === 'SWCH' ? 'SWATCH' : 'GALLERY',
              position: slot === 'MAIN' ? 0 : slot === 'SWCH' ? 9 : parseInt(slot.slice(2), 10),
            })
          } else if (channel === 'ebay') {
            addPendingUpsert({
              scope: 'PLATFORM',
              platform: 'EBAY',
              marketplace: null,
              variantGroupKey: scope.axis,
              variantGroupValue: scope.value,
              url: masterImage.url,
              sourceProductImageId: masterImage.id,
              role: 'GALLERY',
              position: nextEbayPosition(),
            })
          } else if (channel === 'shopify') {
            addPendingUpsert({
              scope: 'PLATFORM',
              platform: 'SHOPIFY',
              marketplace: null,
              variantGroupKey: scope.axis,
              variantGroupValue: scope.value,
              url: masterImage.url,
              sourceProductImageId: masterImage.id,
              role: 'GALLERY',
              position: nextShopifyPosition(),
            })
          }
        }
      }
      if (next !== images) onImagesChange(next)
      if (scope.kind === 'variant') {
        onToast?.(t('products.edit.images.scopeUpload.applied', {
          count: files.length,
          axis: scope.axis,
          value: scope.value,
        }))
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleNearDupForce() {
    if (!nearDup) return
    setForcingUpload(true)
    setUploadError(null)
    try {
      const result = await uploadOne(nearDup.file, nearDup.type, true)
      if (result.outcome === 'created') {
        onImagesChange([...images, result.image])
      } else if (result.outcome === 'reused') {
        // Race: someone else uploaded the same bytes between the 409
        // and the force retry. Surface as a duplicate, not an error.
        onToast?.(t('products.edit.images.masterPanel.duplicateReused', {
          type: result.image.type,
        }))
      }
      setNearDup(null)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setForcingUpload(false)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    handleFiles(Array.from(e.target.files ?? []))
  }

  // ── Desktop drag-to-grid drop ─────────────────────────────────────
  function handleGridDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDropZoneActive(true)
    }
  }
  function handleGridDragLeave() { setDropZoneActive(false) }
  function handleGridDrop(e: React.DragEvent) {
    setDropZoneActive(false)
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault()
      handleFiles(Array.from(e.dataTransfer.files))
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────
  async function handleDelete(imageId: string) {
    setDeletingId(imageId)
    try {
      const res = await beFetch(`/api/products/${product.id}/images/${imageId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      onImagesChange(images.filter((i) => i.id !== imageId))
    } finally {
      setDeletingId(null)
    }
  }

  // ── IR.8.3 — Apply this product's master gallery to all children ────
  async function handleApplyToChildren() {
    setApplying(true)
    try {
      const res = await beFetch(`/api/products/${product.id}/images/apply-to-children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'replace' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Apply failed: ${res.status}`)
      }
      const data = await res.json() as {
        targetsTotal: number
        targetsUpdated: number
        imagesCreated: number
        errors: unknown[]
      }
      if (data.targetsTotal === 0) {
        onToast?.(t('products.edit.images.masterPanel.noChildren'))
      } else if (data.errors.length > 0) {
        onToast?.(t('products.edit.images.masterPanel.appliedWithErrors', {
          updated: data.targetsUpdated,
          total: data.targetsTotal,
          created: data.imagesCreated,
          errors: data.errors.length,
        }))
      } else {
        onToast?.(t('products.edit.images.masterPanel.applied', {
          updated: data.targetsUpdated,
          total: data.targetsTotal,
          created: data.imagesCreated,
        }))
      }
      setApplyConfirm(false)
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'Apply to children failed')
    } finally {
      setApplying(false)
    }
  }

  // ── Alt / type edit ──────────────────────────────────────────────────
  function startEdit(img: ProductImage) {
    setMenuOpenId(null)
    setEditingId(img.id)
    setEditAlt(img.alt ?? '')
    setEditType((img.type as ImageType) ?? 'ALT')
  }

  async function commitEdit() {
    if (!editingId) return
    setSavingEdit(true)
    try {
      const res = await beFetch(`/api/products/${product.id}/images/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alt: editAlt || null, type: editType }),
      })
      if (!res.ok) throw new Error()
      const updated: ProductImage = await res.json()
      onImagesChange(images.map((i) => (i.id === updated.id ? updated : i)))
      setEditingId(null)
    } finally {
      setSavingEdit(false)
    }
  }

  // ── PG.4 — Set / clear the operator-curated hero image ──────────────
  // The catalog thumbnail picker (pickFaceImage) prefers isPrimary over
  // type=MAIN + sortOrder, so clicking the ★ flips the /products row
  // thumb within ~2s of the API round-trip. Optimistic update so the
  // gold ★ moves immediately; rollback on failure.
  const [settingPrimaryId, setSettingPrimaryId] = useState<string | null>(null)
  async function handleTogglePrimary(img: ProductImage) {
    const nextValue = !img.isPrimary
    setSettingPrimaryId(img.id)

    // Optimistic: at most one row may be primary at a time.
    const optimistic = images.map((i) => ({
      ...i,
      isPrimary: i.id === img.id ? nextValue : nextValue ? false : i.isPrimary,
    }))
    onImagesChange(optimistic)

    try {
      const res = await beFetch(
        `/api/products/${product.id}/images/${img.id}/primary`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPrimary: nextValue }),
        },
      )
      if (!res.ok) throw new Error(`set-primary failed: ${res.status}`)
    } catch (err) {
      // Roll back to the server-of-record state.
      onImagesChange(images)
      onToast?.(err instanceof Error ? err.message : 'Set primary failed')
    } finally {
      setSettingPrimaryId(null)
    }
  }

  // ── DnD reorder ──────────────────────────────────────────────────────
  function onDragStart(e: React.DragEvent, index: number) {
    if (e.dataTransfer.types.includes('Files')) return
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'copyMove'
    // Expose URL + id so channel panels can accept drags from master gallery
    e.dataTransfer.setData('application/nexus-image-url', images[index].url)
    e.dataTransfer.setData('application/nexus-image-id', images[index].id)
  }

  function onDragOver(e: React.DragEvent, index: number) {
    if (e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOverIndex(index)
  }

  function onDragLeave() { setDragOverIndex(null) }

  async function onDrop(e: React.DragEvent, targetIndex: number) {
    if (e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOverIndex(null)
    const fromIndex = dragIndexRef.current
    dragIndexRef.current = null
    if (fromIndex === null || fromIndex === targetIndex) return

    const reordered = [...images]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(targetIndex, 0, moved)
    const withOrder = reordered.map((img, i) => ({ ...img, sortOrder: i }))
    onImagesChange(withOrder)

    setReordering(true)
    try {
      await beFetch(`/api/products/${product.id}/images/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: withOrder.map((img) => ({ id: img.id, sortOrder: img.sortOrder })) }),
      })
    } finally {
      setReordering(false)
    }
  }

  // ── Context menu "Add to channel" ────────────────────────────────────
  function handleAddToChannel(img: ProductImage, channel: 'amazon' | 'ebay' | 'shopify' | 'all') {
    setMenuOpenId(null)
    onAddToChannel(img.url, img.id, channel)
    const label = channel === 'all' ? 'all channels' : channel.charAt(0).toUpperCase() + channel.slice(1)
    onToast?.(`Added to ${label} — save to confirm`)
  }

  return (
    <div className="space-y-4">
      {/* Quality banner */}
      {((!hasMain && images.length > 0) || tooFew) && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
          <div className="space-y-0.5">
            {!hasMain && images.length > 0 && <div>No MAIN image set — required by all channels.</div>}
            {tooFew && <div>Only {images.length} image{images.length === 1 ? '' : 's'} — most channels require 3+.</div>}
          </div>
        </div>
      )}

      {/* IR.8.3 — Apply-to-children confirmation banner */}
      {applyConfirm && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-sm">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <Share2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
            <div className="space-y-0.5 text-blue-800 dark:text-blue-200">
              <div className="font-medium">{t('products.edit.images.masterPanel.applyConfirmTitle')}</div>
              <div className="text-xs text-blue-700/80 dark:text-blue-300/80">
                {t('products.edit.images.masterPanel.applyConfirmHint', { count: images.length })}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button size="sm" variant="ghost" onClick={() => setApplyConfirm(false)} disabled={applying} className="text-xs h-7">
              {t('products.edit.images.lightbox.cancel')}
            </Button>
            <Button size="sm" onClick={handleApplyToChildren} disabled={applying} className="text-xs h-7 gap-1.5">
              {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Share2 className="w-3 h-3" />}
              {t('products.edit.images.masterPanel.apply')}
            </Button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
          <ImageIcon className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Master gallery</span>
          <span className="text-xs text-slate-400">{images.length} image{images.length !== 1 ? 's' : ''}</span>
          {reordering && (
            <span className="flex items-center gap-1 text-xs text-slate-400 ml-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Saving order…
            </span>
          )}
          {/* IM.8 — Select all toggle */}
          {images.length > 0 && (
            <button
              type="button"
              onClick={allSelected ? clearSelection : selectAll}
              className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 ml-1"
              title={allSelected ? 'Deselect all (Esc)' : 'Select all (⌘A)'}
            >
              {allSelected
                ? <CheckSquare className="w-3.5 h-3.5 text-blue-500" />
                : <Square className="w-3.5 h-3.5" />}
              {selectedCount > 0 ? `${selectedCount} selected` : 'Select'}
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <select
              className="text-xs border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none"
              onChange={(e) => { newTypeRef.current = e.target.value as ImageType }}
              defaultValue="ALT"
            >
              {IMAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Upload
            </Button>
            {addPendingUpsert && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={openScopedPicker}
                disabled={uploading}
                title={t('products.edit.images.scopeUpload.buttonTooltip')}
              >
                <Tag className="w-3.5 h-3.5 text-blue-500" />
                {t('products.edit.images.scopeUpload.buttonLabel')}
              </Button>
            )}
            {onOpenDamPicker && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={onOpenDamPicker}
                disabled={uploading}
                title="Pull an asset from /marketing/content's library"
              >
                <Library className="w-3.5 h-3.5" />
                {t('products.edit.images.masterPanel.fromLibrary')}
              </Button>
            )}
            {onOpenLifestyle && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={onOpenLifestyle}
                disabled={uploading}
                title={t('products.edit.images.lifestyle.buttonTooltip')}
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                {t('products.edit.images.lifestyle.buttonLabel')}
              </Button>
            )}
            {product.isParent && images.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => setApplyConfirm(true)}
                disabled={uploading || applying}
                title="Mirror this gallery to every child product (replaces their current images)"
              >
                <Share2 className="w-3.5 h-3.5" />
                {t('products.edit.images.masterPanel.applyToChildren')}
              </Button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={handleFileInput} />
            <input
              ref={scopedInputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={handleScopedInput}
            />
          </div>
        </div>

        {/* IM.8 — Bulk action bar (appears when images selected) */}
        {selectedCount > 0 && (
          <div className="px-5 py-2 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-800 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
              {selectedCount} image{selectedCount === 1 ? '' : 's'} selected — apply to:
            </span>
            {(['amazon', 'ebay', 'shopify', 'all'] as const).map((ch) => (
              <Button
                key={ch}
                size="sm"
                variant="ghost"
                onClick={() => applySelectionToChannel(ch)}
                className="text-xs h-6 px-2 border border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30"
              >
                {ch === 'all' ? 'All channels' : ch === 'amazon' ? 'Amazon' : ch === 'ebay' ? 'eBay' : 'Shopify'}
              </Button>
            ))}
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto text-xs text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
            >
              Clear (Esc)
            </button>
          </div>
        )}

        {/* Grid — also a desktop drop zone */}
        <div
          className={cn('px-5 py-4 relative', dropZoneActive && 'ring-2 ring-inset ring-blue-400 dark:ring-blue-500')}
          onDragOver={handleGridDragOver}
          onDragLeave={handleGridDragLeave}
          onDrop={handleGridDrop}
        >
          {dropZoneActive && (
            <div className="absolute inset-0 bg-blue-50/80 dark:bg-blue-950/50 flex items-center justify-center z-10 rounded pointer-events-none">
              <div className="text-blue-600 dark:text-blue-400 font-medium text-sm flex items-center gap-2">
                <Upload className="w-4 h-4" /> Drop to upload
              </div>
            </div>
          )}

          {uploadError && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-3">{uploadError}</p>
          )}

          {images.length === 0 ? (
            <div
              className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-16 flex flex-col items-center gap-3 text-slate-400 cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className="w-10 h-10" />
              <div className="text-center">
                <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No master images yet</p>
                <p className="text-xs mt-1">Drop images here or click to upload</p>
              </div>
              <Button size="sm" className="gap-1">
                <Plus className="w-3.5 h-3.5" /> Add images
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {images.map((img, index) => (
                <div
                  key={img.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, index)}
                  onDragOver={(e) => onDragOver(e, index)}
                  onDragLeave={onDragLeave}
                  onDrop={(e) => onDrop(e, index)}
                  // IR.11.1 — content-visibility lets the browser skip
                  // layout + paint for grid items scrolled offscreen.
                  // ~250px is a safe estimate for our aspect-square cards
                  // at the smallest viewport (250 wide × 250 tall + footer).
                  style={{ contentVisibility: 'auto', containIntrinsicSize: '250px 350px' }}
                  // IA.13 — cursor-grab signals the whole card is draggable.
                  // Inner buttons (checkbox, menu, edit form) override with
                  // their own cursor; clicks on them still fire normally
                  // because they capture pointer-up before any drag movement.
                  className={cn(
                    'group relative rounded-xl border bg-slate-50 dark:bg-slate-800 overflow-hidden transition-all cursor-grab active:cursor-grabbing',
                    selectedIds.has(img.id)
                      ? 'border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600'
                      : dragOverIndex === index
                        ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                  title="Drag to reorder, or drop on a channel cell to assign"
                >
                  {/* Thumbnail — click opens lightbox; drag from anywhere
                      on the card still fires because the parent is
                      draggable. IA.13 dropped the cursor-zoom-in
                      override so the card-wide cursor-grab is visible —
                      operators were confused that only the checkbox
                      area looked draggable. */}
                  <div
                    className="aspect-square relative bg-slate-100 dark:bg-slate-700"
                    onClick={() => onOpenLightbox?.(img)}
                  >
                    {/* IR.11.2 — Skeleton placeholder shimmers under the
                        image until onLoad fires. animate-pulse is
                        cheap (compositor-only) and stops at the same
                        moment the real bytes paint. */}
                    {!loadedIds.has(img.id) && (
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 animate-pulse bg-gradient-to-br from-slate-100 via-slate-200 to-slate-100 dark:from-slate-800 dark:via-slate-700 dark:to-slate-800"
                      />
                    )}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.alt ?? img.type}
                      className={cn(
                        'relative w-full h-full object-contain transition-opacity duration-200',
                        loadedIds.has(img.id) ? 'opacity-100' : 'opacity-0',
                      )}
                      loading={index < 4 ? 'eager' : 'lazy'}
                      decoding="async"
                      fetchPriority={index === 0 ? 'high' : index < 4 ? 'auto' : 'low'}
                      onLoad={() => markLoaded(img.id)}
                      onError={() => markLoaded(img.id)}
                    />

                    {/* Selection checkbox — top-left */}
                    <button
                      type="button"
                      onClick={(e) => toggleSelect(img.id, e)}
                      aria-label={selectedIds.has(img.id) ? 'Deselect image' : 'Select image'}
                      className={cn(
                        'absolute top-1 left-1 transition-opacity',
                        selectedIds.has(img.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                    >
                      {selectedIds.has(img.id)
                        ? <CheckSquare className="w-4 h-4 text-blue-500 drop-shadow" />
                        : <Square className="w-4 h-4 text-white drop-shadow" />}
                    </button>

                    {/* Context menu button — top-right, visible on hover (incl. MAIN) */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenId(menuOpenId === img.id ? null : img.id)
                      }}
                      aria-label="Image actions"
                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 dark:bg-slate-900/80 rounded p-1"
                    >
                      <MoreHorizontal className="w-3.5 h-3.5 text-slate-500" />
                    </button>

                    {/* Position number — bottom-left */}
                    <div className="absolute bottom-1 left-1.5 text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-white/70 dark:bg-slate-900/70 rounded px-1">
                      {index + 1}
                    </div>

                    {/* PG.4 — Curated "hero image" ★ — bottom-right.
                        Gold fill when isPrimary=true (always visible);
                        outlined + hover-only when not primary. Single
                        click toggles; the API clears siblings atomically.
                        This row wins the /products thumbnail picker over
                        type=MAIN. Separate from the type=MAIN indicator
                        (which is now the small pill in the footer). */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (settingPrimaryId === img.id) return
                        void handleTogglePrimary(img)
                      }}
                      aria-label={img.isPrimary ? 'Clear catalog hero' : 'Set as catalog hero'}
                      aria-pressed={img.isPrimary}
                      title={
                        img.isPrimary
                          ? 'Catalog hero — wins the /products thumbnail. Click to clear.'
                          : 'Set as catalog hero — wins the /products thumbnail.'
                      }
                      disabled={settingPrimaryId === img.id}
                      className={cn(
                        'absolute bottom-1 right-1 rounded p-0.5 transition-all',
                        img.isPrimary
                          ? 'bg-amber-500 opacity-100 shadow'
                          : 'bg-white/80 dark:bg-slate-900/80 opacity-0 group-hover:opacity-100 hover:bg-amber-50 dark:hover:bg-amber-950/40',
                        settingPrimaryId === img.id && 'cursor-wait',
                      )}
                    >
                      <Star
                        className={cn(
                          'w-3 h-3',
                          img.isPrimary
                            ? 'text-white fill-white'
                            : 'text-amber-500',
                        )}
                      />
                    </button>

                    {/* MAIN type indicator — small, bottom-center-left.
                        Distinct from the PG.4 ★ above: this is the
                        type=MAIN tag (channel-required), the ★ is the
                        operator's curated catalog pick. */}
                    {img.type === 'MAIN' && (
                      <div
                        className="absolute bottom-1 left-7 text-[9px] font-bold uppercase tracking-wider bg-blue-500 text-white rounded px-1 py-px"
                        title="Channel MAIN — required by Amazon/eBay/Shopify"
                      >
                        MAIN
                      </div>
                    )}

                    {/* Context menu dropdown */}
                    {menuOpenId === img.id && (
                      <>
                        {/* Backdrop — stopPropagation so closing the menu doesn't also open the lightbox */}
                        <div
                          className="fixed inset-0 z-20"
                          onClick={(e) => { e.stopPropagation(); setMenuOpenId(null) }}
                        />
                        <div
                          className="absolute top-7 right-1 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[160px] text-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => startEdit(img)}>
                            Edit alt text
                          </button>
                          <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
                          <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => handleAddToChannel(img, 'amazon')}>
                            Use in Amazon
                          </button>
                          <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => handleAddToChannel(img, 'ebay')}>
                            Use in eBay
                          </button>
                          <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => handleAddToChannel(img, 'shopify')}>
                            Use in Shopify
                          </button>
                          <button className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 font-medium" onClick={() => handleAddToChannel(img, 'all')}>
                            Use in all channels
                          </button>
                          {addPendingUpsert && variants.length > 0 && (
                            <>
                              <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
                              <button
                                className="w-full text-left px-3 py-1.5 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 font-medium"
                                onClick={() => { setMenuOpenId(null); setBulkApplyImage(img) }}
                              >
                                Apply to…
                              </button>
                            </>
                          )}
                          <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
                          <button
                            className="w-full text-left px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20"
                            onClick={() => { setMenuOpenId(null); handleDelete(img.id) }}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-2 py-2 space-y-1.5">
                    {editingId === img.id ? (
                      <div className="space-y-1.5">
                        <select
                          value={editType}
                          onChange={(e) => setEditType(e.target.value as ImageType)}
                          className="w-full text-xs border border-slate-200 dark:border-slate-700 rounded px-1.5 py-1 bg-white dark:bg-slate-900 focus:outline-none"
                        >
                          {IMAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <input
                          value={editAlt}
                          onChange={(e) => setEditAlt(e.target.value)}
                          placeholder="Alt text…"
                          className="w-full text-xs border border-slate-200 dark:border-slate-700 rounded px-1.5 py-1 bg-white dark:bg-slate-900 focus:outline-none"
                          onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null) }}
                          autoFocus
                        />
                        <div className="flex gap-1">
                          <Button size="sm" className="flex-1 text-xs h-6" onClick={commitEdit} disabled={savingEdit}>
                            {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs h-6 px-2" onClick={() => setEditingId(null)}>✕</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-1">
                        <button
                          onClick={() => startEdit(img)}
                          className={cn(
                            'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-opacity hover:opacity-80 truncate max-w-[80%]',
                            TYPE_COLORS[(img.type as ImageType) ?? 'ALT'],
                          )}
                        >
                          {img.type}
                        </button>
                        <IconButton
                          size="sm"
                          aria-label="Delete image"
                          onClick={() => handleDelete(img.id)}
                          disabled={deletingId === img.id}
                          className="text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 flex-shrink-0"
                        >
                          {deletingId === img.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        </IconButton>
                      </div>
                    )}
                    {img.alt && editingId !== img.id && (
                      <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate" title={img.alt}>{img.alt}</p>
                    )}
                    {editingId !== img.id && (() => {
                      const meta = formatImageMeta(img)
                      return meta ? (
                        <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate" title={meta}>
                          {meta}
                        </p>
                      ) : null
                    })()}
                  </div>
                </div>
              ))}

              {/* Add-more card */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center gap-1.5 text-slate-400 cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
              >
                <Plus className="w-6 h-6" />
                <span className="text-xs">Add more</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tips */}
      <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1 px-1">
        <p>• Drag images to reorder. Position 1 becomes the default for all channels.</p>
        <p>• Use the ··· menu to copy any image into a channel panel for slot assignment.</p>
        <p>• Drop image files anywhere on the grid to upload.</p>
      </div>

      {/* IE.10 — Variant-targeted upload modal */}
      <ScopeUploadModal
        open={scopedFiles.length > 0}
        files={scopedFiles}
        variants={variants}
        availableAxes={availableAxes}
        defaultAxis={activeAxis}
        defaultType={newTypeRef.current}
        onCancel={() => setScopedFiles([])}
        onConfirm={(scope) => { void handleScopedUpload(scope) }}
      />

      {/* IE.12 — Bulk-apply target picker */}
      {addPendingUpsert && (
        <BulkApplyModal
          open={bulkApplyImage !== null}
          image={bulkApplyImage}
          variants={variants}
          listingImages={listingImages}
          activeAxis={activeAxis}
          addPendingUpsert={addPendingUpsert}
          onClose={() => setBulkApplyImage(null)}
          onToast={onToast}
        />
      )}

      {/* IE.1.3 — Near-duplicate confirmation modal. Triggers when the
          upload endpoint returns 409 NEAR_DUPLICATE. Shows the
          candidate side-by-side and lets the operator either keep
          the existing image or force-upload the new one. */}
      {nearDup && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-slate-950/70 flex items-center justify-center px-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 max-w-2xl w-full p-6 space-y-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {t('products.edit.images.masterPanel.nearDupTitle')}
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {t('products.edit.images.masterPanel.nearDupHint', {
                    distance: nearDup.hammingDistance,
                    threshold: nearDup.threshold,
                  })}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  {t('products.edit.images.masterPanel.nearDupExisting')}
                </p>
                <div className="aspect-square rounded-xl bg-slate-100 dark:bg-slate-800 overflow-hidden border border-slate-200 dark:border-slate-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={nearDup.candidate.url}
                    alt={nearDup.candidate.alt ?? ''}
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {nearDup.candidate.type}
                  {nearDup.candidate.width && nearDup.candidate.height
                    ? ` · ${nearDup.candidate.width}×${nearDup.candidate.height}`
                    : ''}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  {t('products.edit.images.masterPanel.nearDupNew')}
                </p>
                <div className="aspect-square rounded-xl bg-slate-100 dark:bg-slate-800 overflow-hidden border border-slate-200 dark:border-slate-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={URL.createObjectURL(nearDup.file)}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={nearDup.file.name}>
                  {nearDup.file.name}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleNearDupUseExisting}
                disabled={forcingUpload}
                className="text-xs"
              >
                {t('products.edit.images.masterPanel.nearDupUseExisting')}
              </Button>
              <Button
                size="sm"
                onClick={handleNearDupForce}
                disabled={forcingUpload}
                className="text-xs gap-1.5"
              >
                {forcingUpload ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                {t('products.edit.images.masterPanel.nearDupForce')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
