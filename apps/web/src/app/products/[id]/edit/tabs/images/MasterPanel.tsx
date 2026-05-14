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
  GripVertical,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Plus,
  Square,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import type { ProductImage, WorkspaceProduct } from './types'

const IMAGE_TYPES = ['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'] as const
type ImageType = typeof IMAGE_TYPES[number]

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
}

export default function MasterPanel({
  product,
  images,
  onImagesChange,
  onAddToChannel,
  onToast,
}: Props) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
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

  // Cmd+A to select all, Escape to deselect
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
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
    try {
      for (const file of files) {
        // IM.10 — file size guard (Shopify max 20 MB; Amazon max 10 MB)
        if (file.size > 20 * 1024 * 1024) {
          setUploadError(`${file.name} exceeds 20 MB — too large for any channel`)
          continue
        }
        const fd = new FormData()
        fd.append('file', file)
        const res = await beFetch(
          `/api/products/${product.id}/images?type=${newTypeRef.current}`,
          { method: 'POST', body: fd },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `Upload failed: ${res.status}`)
        }
        const created: ProductImage = await res.json()
        onImagesChange([...images, created])
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
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
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={handleFileInput} />
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
                  className={cn(
                    'group relative rounded-xl border bg-slate-50 dark:bg-slate-800 overflow-hidden transition-all',
                    selectedIds.has(img.id)
                      ? 'border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600'
                      : dragOverIndex === index
                        ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                >
                  {/* Thumbnail */}
                  <div className="aspect-square relative bg-slate-100 dark:bg-slate-700">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt={img.alt ?? img.type} className="w-full h-full object-contain" loading="lazy" />

                    {/* Position number */}
                    <div className="absolute bottom-1 left-1.5 text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-white/70 dark:bg-slate-900/70 rounded px-1">
                      {index + 1}
                    </div>

                    {/* IM.8 — Selection checkbox (always visible on hover, solid when selected) */}
                    <button
                      type="button"
                      onClick={(e) => toggleSelect(img.id, e)}
                      className={cn(
                        'absolute top-1 left-1 transition-opacity',
                        selectedIds.has(img.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                    >
                      {selectedIds.has(img.id)
                        ? <CheckSquare className="w-4 h-4 text-blue-500 drop-shadow" />
                        : <Square className="w-4 h-4 text-white drop-shadow" />}
                    </button>

                    {/* Drag handle */}
                    <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab">
                      <div className="bg-white/80 dark:bg-slate-900/80 rounded p-1">
                        <GripVertical className="w-3.5 h-3.5 text-slate-500" />
                      </div>
                    </div>

                    {/* MAIN star */}
                    {img.type === 'MAIN' && (
                      <div className="absolute top-1 right-1">
                        <div className="bg-blue-500 rounded p-0.5">
                          <Star className="w-3 h-3 text-white fill-white" />
                        </div>
                      </div>
                    )}

                    {/* Context menu button — appears on hover */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenId(menuOpenId === img.id ? null : img.id)
                      }}
                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 dark:bg-slate-900/80 rounded p-1"
                      style={img.type === 'MAIN' ? { display: 'none' } : {}}
                    >
                      <MoreHorizontal className="w-3.5 h-3.5 text-slate-500" />
                    </button>

                    {/* Context menu dropdown */}
                    {menuOpenId === img.id && (
                      <>
                        {/* Backdrop */}
                        <div className="fixed inset-0 z-20" onClick={() => setMenuOpenId(null)} />
                        <div className="absolute top-7 right-1 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[160px] text-sm">
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
    </div>
  )
}
