'use client'

/**
 * PES.7 — the master gallery.
 *
 * Master IS the stored truth: these rows are what every channel layer cascades from, and every
 * operation here persists immediately through the frame's save reporter — there is no Save button
 * on this tab (layout §2.7).
 *
 * Written from scratch on the DS (layout §2.10). The capability list it must satisfy is
 * docs/2026-09-01-pes7-images-inventory.md §2.1; the old components are the specification for
 * WHAT, never the source for HOW.
 *
 * Reorder is a pointer drag (P1 spike: the model whose round trip completes) and the same reorder
 * is reachable from the keyboard, so the gesture is a convenience rather than the only way in.
 */
import { useCallback, useMemo, useRef, useState } from 'react'

import { FileDropzone } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { EmptyState } from '@/design-system/components'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import type { MasterAsset, UploadImageResponse } from '../types'
import { sortMaster } from '../useImageWorkspace'
import { LifestyleGenerator } from '../ai/LifestyleGenerator'
import { DamPicker } from '../dam/DamPicker'
import { ApplyToChildrenModal } from './ApplyToChildrenModal'
import { DuplicatesModal } from './DuplicatesModal'
import { GalleryTile } from './GalleryTile'
import styles from '../images.module.css'

export interface MasterGalleryProps {
  productId: string
  /** Only a parent can cascade its images down; the control says so rather than failing at the API. */
  isParent: boolean
  childCount: number
  /** Scopes the asset library to "things like this"; either may be absent on a product. */
  brand: string | null
  productType: string | null
  /** Seeds the lifestyle prompt with what the product actually is. */
  productName: string | null
  assets: MasterAsset[]
  damDrift: Set<string>
  onOpen(asset: MasterAsset): void
  /** Replace the tab's master rows with what the server confirmed. */
  onAssetsChange(next: MasterAsset[]): void
  /** Wraps a mutation so the studio header's autosave state speaks for image work too. */
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
  onError(message: string | null): void
}

/** How far the pointer must travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5

export function MasterGallery({
  productId, isParent, childCount, brand, productType, productName, assets, damDrift, onOpen,
  onAssetsChange, write, onError,
}: MasterGalleryProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [damOpen, setDamOpen] = useState(false)
  const [lifestyleOpen, setLifestyleOpen] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const pressRef = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(null)
  /** The last singly-clicked tile — the fixed end of a shift-range. */
  const anchorRef = useRef<string | null>(null)

  const ordered = useMemo(() => sortMaster(assets), [assets])

  /**
   * Plain click toggles one tile; shift-click extends from the last tile touched, the way a file
   * manager does — an operator tagging twelve consecutive lifestyle shots should click twice, not
   * twelve times. The anchor is the last SINGLE click, so a shift-click never re-anchors and a
   * range can be widened and narrowed against the same starting point.
   */
  const toggleSelect = useCallback((id: string, extend: boolean) => {
    const anchor = anchorRef.current
    if (extend && anchor && anchor !== id) {
      const from = ordered.findIndex((a) => a.id === anchor)
      const to = ordered.findIndex((a) => a.id === id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const span = ordered.slice(lo, hi + 1).map((a) => a.id)
        setSelected((prev) => new Set([...prev, ...span]))
        return
      }
    }
    anchorRef.current = id
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [ordered])

  const clearSelection = useCallback(() => { setSelected(new Set()); anchorRef.current = null }, [])

  /* ── upload ─────────────────────────────────────────────────────────────────────────────── */

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)
    onError(null)
    // Sequential on purpose: the API's dedup gate compares each upload against what is already
    // stored, so two parallel uploads of the same bytes can both pass the gate and both land.
    const added: MasterAsset[] = []
    const refusals: string[] = []
    for (const file of files) {
      const fd = new FormData()
      fd.append('file', file)
      // This route returns the row at the TOP level (unlike import-from-dam, which nests it).
      const res = await write(writeSubject.upload(file.name), () =>
        apiSend<UploadImageResponse>(`${routes.masterImages(productId)}?type=ALT`, 'POST', fd))
      if (!res.ok) { refusals.push(`${file.name}: ${res.message}`); continue }
      const row = res.data
      if (!row?.id) { refusals.push(`${file.name}: accepted, but the response could not be read`); continue }
      // A byte-identical re-upload answers 200 with the EXISTING row. Adding a tile for it would
      // show a duplicate the product does not have.
      if (row.reused === 'exact') refusals.push(`${file.name}: already on this product`)
      else if (!assets.some((a) => a.id === row.id)) added.push(row)
    }
    if (added.length) onAssetsChange(sortMaster([...assets, ...added]))
    // The server's own words, per file. A single "upload failed" would hide which one and why —
    // the dedup gate's refusal is the operator's most common and most useful message here.
    if (refusals.length) onError(refusals.join(' · '))
    setBusy(false)
  }, [assets, onAssetsChange, onError, productId, write])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'))
    void uploadFiles(files)
  }, [uploadFiles])

  /* ── per-asset writes ───────────────────────────────────────────────────────────────────── */

  const setPrimary = useCallback(async (asset: MasterAsset) => {
    const res = await write(writeSubject.asset(asset.id), () =>
      apiSend<unknown>(routes.primary(productId, asset.id), 'PATCH', { isPrimary: !asset.isPrimary }))
    if (!res.ok) { onError(res.message); return }
    // At most one primary per product (DB partial unique index) — clear the others locally so the
    // gallery cannot briefly show two heroes.
    onAssetsChange(assets.map((a) => (
      a.id === asset.id ? { ...a, isPrimary: !asset.isPrimary } : { ...a, isPrimary: false }
    )))
  }, [assets, onAssetsChange, onError, productId, write])

  const deleteSelected = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    onError(null)
    // Per-id outcomes: a partial failure must remove exactly the rows that DID delete and leave
    // the rest on screen still selected. Removing all of them on any success, or none of them on
    // any failure, would both show an order the server does not hold.
    const deleted = new Set<string>()
    const failed: string[] = []
    for (const id of ids) {
      const res = await write(writeSubject.asset(id), () => apiSend<unknown>(routes.masterImage(productId, id), 'DELETE'))
      if (res.ok) deleted.add(id)
      else failed.push(res.message)
    }
    if (deleted.size) onAssetsChange(assets.filter((a) => !deleted.has(a.id)))
    setSelected(new Set(ids.filter((id) => !deleted.has(id))))
    onError(failed.length ? failed.join(' · ') : null)
    setBusy(false)
  }, [assets, onAssetsChange, onError, productId, selected, write])

  /* ── reorder ────────────────────────────────────────────────────────────────────────────── */

  const persistOrder = useCallback(async (next: MasterAsset[]) => {
    const renumbered = next.map((a, i) => ({ ...a, sortOrder: i }))
    onAssetsChange(renumbered)   // paint first: the drag already showed this outcome
    const res = await write(writeSubject.surface('master-order'), () =>
      apiSend<unknown>(routes.reorder(productId), 'POST', { imageIds: renumbered.map((a) => a.id) }))
    if (!res.ok) {
      onError(`Order not saved — ${res.message}`)
      onAssetsChange(assets)     // put the operator's view back to what the server still holds
    }
  }, [assets, onAssetsChange, onError, productId, write])

  const moveBy = useCallback((asset: MasterAsset, delta: number) => {
    const from = ordered.findIndex((a) => a.id === asset.id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ordered.length) return
    const next = [...ordered]
    next.splice(to, 0, ...next.splice(from, 1))
    void persistOrder(next)
  }, [ordered, persistOrder])

  const onPointerDownHandle = useCallback((e: React.PointerEvent, asset: MasterAsset) => {
    if (e.button !== 0) return
    pressRef.current = { id: asset.id, x: e.clientX, y: e.clientY, dragging: false }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const press = pressRef.current
    if (!press) return
    if (!press.dragging) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return
      press.dragging = true
      setDragId(press.id)
    }
    const overEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
      ?.closest<HTMLElement>('[data-asset-id]')
    const overId = overEl?.dataset.assetId
    if (!overId || overId === press.id) { setDropTarget(null); return }
    const box = overEl!.getBoundingClientRect()
    setDropTarget({ id: overId, edge: e.clientX < box.left + box.width / 2 ? 'before' : 'after' })
  }, [])

  const onPointerUp = useCallback(() => {
    const press = pressRef.current
    pressRef.current = null
    const target = dropTarget
    setDragId(null)
    setDropTarget(null)
    if (!press?.dragging || !target) return
    const from = ordered.findIndex((a) => a.id === press.id)
    let to = ordered.findIndex((a) => a.id === target.id)
    if (from < 0 || to < 0) return
    if (target.edge === 'after') to += 1
    if (to > from) to -= 1
    if (to === from) return
    const next = [...ordered]
    next.splice(to, 0, ...next.splice(from, 1))
    void persistOrder(next)
  }, [dropTarget, ordered, persistOrder])

  /** "Locate" has to actually locate: scroll the tile into view and mark it briefly. */
  const locate = useCallback((id: string) => {
    setDuplicatesOpen(false)
    setFlashId(id)
    // One frame for the modal to unmount, then scroll — the tile is not scrollable while a modal
    // owns the viewport.
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        document.querySelector(`[data-asset-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 60)
    })
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 2200)
  }, [])

  /* ── render ─────────────────────────────────────────────────────────────────────────────── */

  const selectedAssets = ordered.filter((a) => selected.has(a.id))

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Master gallery</h2>
        <span className={styles.sectionCount}>
          {ordered.length} image{ordered.length === 1 ? '' : 's'}
          {selected.size > 0 && ` · ${selected.size} selected`}
        </span>
        <span className={styles.spacer} />
        <div className={styles.actions}>
          {selected.size > 0 && (
            <>
              {selectedAssets.length === 1 && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setPrimary(selectedAssets[0])}>
                  {selectedAssets[0].isPrimary ? 'Unset hero' : 'Set as hero'}
                </Button>
              )}
              {selectedAssets.length === 1 && (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => moveBy(selectedAssets[0], -1)}>← Move</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => moveBy(selectedAssets[0], 1)}>Move →</Button>
                </>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void deleteSelected()}>
                Delete {selected.size}
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}>Clear</Button>
            </>
          )}
          {isParent && childCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setApplyOpen(true)}>
              Apply to {childCount} SKUs
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDamOpen(true)}>
            Add from library
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLifestyleOpen(true)}>
            Generate scene
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDuplicatesOpen(true)}>
            Find duplicates
          </Button>
        </div>
      </header>

      {/*
        The DS dropzone, not a Button over a hidden `<input type="file">`.
        It carries the click path, the drag path, the accepted-format hint and the size/type
        refusal that the hand-rolled pair had none of. The gallery's own whole-area drop still
        works — this is the affordance that says so.
      */}
      <FileDropzone
        onFiles={(files) => void uploadFiles(files)}
        accept="image/*"
        multiple
        disabled={busy}
        hint={busy ? 'Working…' : 'Drop images here, or click to choose. Every channel cascades from this set.'}
      />

      {ordered.length === 0 ? (
        <EmptyState
          title="No master images yet"
          description="Upload the product's own images here. Every channel's gallery cascades from this set, so this is the one place a picture has to exist."
        />
      ) : (
        <div
          className={`${styles.gallery}${dropping ? ` ${styles.galleryDropping}` : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
          onDrop={onDrop}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {ordered.map((asset) => (
            <GalleryTile
              key={asset.id}
              asset={asset}
              selected={selected.has(asset.id)}
              dragging={dragId === asset.id}
              dropEdge={dropTarget?.id === asset.id ? dropTarget.edge : null}
              damDrifted={damDrift.has(asset.id)}
              flash={flashId === asset.id}
              onToggleSelect={toggleSelect}
              onOpen={onOpen}
              onPointerDownHandle={onPointerDownHandle}
            />
          ))}
        </div>
      )}

      <DuplicatesModal
        open={duplicatesOpen}
        productId={productId}
        onClose={() => setDuplicatesOpen(false)}
        onDeleted={(id) => onAssetsChange(assets.filter((a) => a.id !== id))}
        onLocate={locate}
        write={write}
      />

      <LifestyleGenerator
        open={lifestyleOpen}
        productId={productId}
        productName={productName}
        onClose={() => setLifestyleOpen(false)}
        onGenerated={(created) => onAssetsChange(sortMaster([...assets, created]))}
        write={write}
      />

      <DamPicker
        open={damOpen}
        productId={productId}
        brand={brand}
        productType={productType}
        onClose={() => setDamOpen(false)}
        onImported={(created) => onAssetsChange(sortMaster([...assets.filter(asset => asset.id !== created.id), created]))}
        write={write}
      />

      <ApplyToChildrenModal
        open={applyOpen}
        productId={productId}
        isParent={isParent}
        childCount={childCount}
        imageCount={ordered.length}
        onClose={() => setApplyOpen(false)}
        write={write}
      />
    </section>
  )
}
