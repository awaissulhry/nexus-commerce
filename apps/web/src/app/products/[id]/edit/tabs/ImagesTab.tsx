'use client'

/**
 * W8.1 — Inline images tab on /products/[id]/edit.
 *
 * Master image manager: upload, reorder, type-tag, alt-text, delete.
 * No extra deps — uses HTML5 DnD for drag reorder, native <input type=file>
 * for uploads, and fetch() directly.
 *
 * Images are fetched via GET /api/products/:id/images (sorted by
 * sortOrder). Reorder commits via POST /api/products/:id/images/reorder
 * on drop. Upload goes to POST /api/products/:id/images (multipart).
 * Delete goes to DELETE /api/products/:id/images/:imageId.
 *
 * Channel-scope overrides (ListingImage) remain on the separate
 * /products/:id/images page — this tab is master-only.
 *
 * Quality signal: badge when < 3 images (most channels require 3+),
 * warning when no MAIN type image.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  GripVertical,
  Image as ImageIcon,
  Loader2,
  Plus,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────

interface ProductImage {
  id: string
  productId: string
  url: string
  alt: string | null
  type: string
  sortOrder: number
  publicId: string | null
  createdAt: string
}

interface ImagesTabProps {
  product: { id: string; sku: string }
  discardSignal: number
  onDirtyChange: (count: number) => void
}

const IMAGE_TYPES = ['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'] as const
type ImageType = typeof IMAGE_TYPES[number]

const TYPE_LABELS: Record<ImageType, string> = {
  MAIN: 'Main',
  ALT: 'Alt',
  LIFESTYLE: 'Lifestyle',
  SWATCH: 'Swatch',
  DIAGRAM: 'Diagram',
}

const TYPE_COLORS: Record<ImageType, string> = {
  MAIN: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  ALT: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  LIFESTYLE: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  SWATCH: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800',
  DIAGRAM: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
}

// ── Component ──────────────────────────────────────────────────────────

export default function ImagesTab({ product, discardSignal, onDirtyChange }: ImagesTabProps) {
  const { t } = useTranslations()

  const [images, setImages] = useState<ProductImage[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editAlt, setEditAlt] = useState('')
  const [editType, setEditType] = useState<ImageType>('ALT')
  const [savingEdit, setSavingEdit] = useState(false)

  // Drag state
  const dragIndexRef = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [reordering, setReordering] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const newImageTypeRef = useRef<ImageType>('ALT')

  // ImagesTab doesn't have dirty state of its own (all actions persist
  // immediately), so always report 0.
  useEffect(() => { onDirtyChange(0) }, [onDirtyChange])

  const loadImages = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/products/${product.id}/images`)
      if (!res.ok) throw new Error()
      setImages(await res.json())
    } finally {
      setLoading(false)
    }
  }, [product.id])

  useEffect(() => { loadImages() }, [loadImages, discardSignal])

  // ── Upload ──────────────────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    setUploading(true)
    setUploadError(null)
    try {
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(
          `/api/products/${product.id}/images?type=${newImageTypeRef.current}`,
          { method: 'POST', body: fd },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `Upload failed: ${res.status}`)
        }
        const created: ProductImage = await res.json()
        setImages((prev) => [...prev, created])
      }
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────
  async function handleDelete(imageId: string) {
    setDeletingId(imageId)
    try {
      const res = await fetch(`/api/products/${product.id}/images/${imageId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error()
      setImages((prev) => prev.filter((img) => img.id !== imageId))
    } finally {
      setDeletingId(null)
    }
  }

  // ── Edit alt / type ─────────────────────────────────────────────────
  function startEdit(img: ProductImage) {
    setEditingId(img.id)
    setEditAlt(img.alt ?? '')
    setEditType((img.type as ImageType) ?? 'ALT')
  }

  async function commitEdit() {
    if (!editingId) return
    setSavingEdit(true)
    try {
      const res = await fetch(`/api/products/${product.id}/images/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alt: editAlt || null, type: editType }),
      })
      if (!res.ok) throw new Error()
      const updated: ProductImage = await res.json()
      setImages((prev) => prev.map((img) => (img.id === updated.id ? updated : img)))
      setEditingId(null)
    } finally {
      setSavingEdit(false)
    }
  }

  // ── Drag-to-reorder ─────────────────────────────────────────────────
  function handleDragStart(e: React.DragEvent, index: number) {
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    setDragOverIndex(index)
  }

  function handleDragLeave() {
    setDragOverIndex(null)
  }

  async function handleDrop(e: React.DragEvent, targetIndex: number) {
    e.preventDefault()
    setDragOverIndex(null)
    const fromIndex = dragIndexRef.current
    dragIndexRef.current = null
    if (fromIndex === null || fromIndex === targetIndex) return

    const reordered = [...images]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(targetIndex, 0, moved)
    const withOrder = reordered.map((img, i) => ({ ...img, sortOrder: i }))
    setImages(withOrder)

    setReordering(true)
    try {
      await fetch(`/api/products/${product.id}/images/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: withOrder.map((img) => ({ id: img.id, sortOrder: img.sortOrder })),
        }),
      })
    } finally {
      setReordering(false)
    }
  }

  // ── Quality signals ─────────────────────────────────────────────────
  const hasMain = images.some((img) => img.type === 'MAIN')
  const tooFew = images.length > 0 && images.length < 3

  return (
    <div className="space-y-6">
      {/* ── Quality banner ─────────────────────────────────────────── */}
      {((!hasMain && images.length > 0) || tooFew) && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
          <div>
            {!hasMain && images.length > 0 && (
              <div>{t('products.edit.images.noMain')}</div>
            )}
            {tooFew && (
              <div>{t('products.edit.images.tooFew', { count: images.length })}</div>
            )}
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.images.title')}
          </h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {images.length} {t('products.edit.images.imageCount')}
          </span>
          {reordering && (
            <span className="flex items-center gap-1 text-xs text-slate-400 ml-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('products.edit.images.saving')}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <select
              className="text-xs border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none"
              onChange={(e) => { newImageTypeRef.current = e.target.value as ImageType }}
              defaultValue="ALT"
            >
              {IMAGE_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Upload className="w-3.5 h-3.5" />}
              {t('products.edit.images.upload')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={handleFileChange}
            />
          </div>
        </div>

        {/* ── Grid ─────────────────────────────────────────────────── */}
        <div className="px-5 py-4">
          {uploadError && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-3">{uploadError}</p>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              {t('products.edit.images.loading')}
            </div>
          ) : images.length === 0 ? (
            <div
              className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-16 flex flex-col items-center gap-3 text-slate-400 cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className="w-10 h-10" />
              <div className="text-center">
                <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                  {t('products.edit.images.empty')}
                </p>
                <p className="text-xs mt-1">{t('products.edit.images.emptyHint')}</p>
              </div>
              <Button size="sm" className="gap-1" onClick={() => fileInputRef.current?.click()}>
                <Plus className="w-3.5 h-3.5" /> {t('products.edit.images.addFirst')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {images.map((img, index) => (
                <div
                  key={img.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  className={cn(
                    'group relative rounded-lg border bg-slate-50 dark:bg-slate-800 overflow-hidden transition-all',
                    dragOverIndex === index
                      ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600'
                      : 'border-slate-200 dark:border-slate-700',
                  )}
                >
                  {/* Image */}
                  <div className="aspect-square relative bg-slate-100 dark:bg-slate-700">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.alt ?? img.type}
                      className="w-full h-full object-contain"
                    />
                    {/* Drag handle overlay */}
                    <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab">
                      <div className="bg-white/80 dark:bg-slate-900/80 rounded p-1">
                        <GripVertical className="w-3.5 h-3.5 text-slate-500" />
                      </div>
                    </div>
                    {/* Star on MAIN */}
                    {img.type === 'MAIN' && (
                      <div className="absolute top-1 right-1">
                        <div className="bg-blue-500 rounded p-0.5">
                          <Star className="w-3 h-3 text-white fill-white" />
                        </div>
                      </div>
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
                          {IMAGE_TYPES.map((t) => (
                            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                          ))}
                        </select>
                        <input
                          value={editAlt}
                          onChange={(e) => setEditAlt(e.target.value)}
                          placeholder="Alt text"
                          className="w-full text-xs border border-slate-200 dark:border-slate-700 rounded px-1.5 py-1 bg-white dark:bg-slate-900 focus:outline-none"
                        />
                        <div className="flex gap-1">
                          <Button size="sm" className="flex-1 text-xs h-6" onClick={commitEdit} disabled={savingEdit}>
                            {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs h-6 px-2" onClick={() => setEditingId(null)}>
                            ✕
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(img)}
                          className={cn(
                            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium cursor-pointer transition-opacity hover:opacity-80',
                            TYPE_COLORS[(img.type as ImageType) ?? 'ALT'],
                          )}
                        >
                          {TYPE_LABELS[(img.type as ImageType)] ?? img.type}
                        </button>
                        {img.alt && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={img.alt}>
                            {img.alt}
                          </p>
                        )}
                        <div className="flex items-center justify-between">
                          <button
                            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            onClick={() => startEdit(img)}
                          >
                            {t('products.edit.images.edit')}
                          </button>
                          <IconButton
                            size="sm"
                            aria-label={t('products.edit.images.delete')}
                            onClick={() => handleDelete(img.id)}
                            disabled={deletingId === img.id}
                            className="text-slate-400 hover:text-red-500"
                          >
                            {deletingId === img.id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Trash2 className="w-3 h-3" />}
                          </IconButton>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}

              {/* Add-more card */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center gap-1.5 text-slate-400 cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
              >
                <Plus className="w-6 h-6" />
                <span className="text-xs">{t('products.edit.images.add')}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Tips ───────────────────────────────────────────────────── */}
      <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1 px-1">
        <p>• {t('products.edit.images.tip1')}</p>
        <p>• {t('products.edit.images.tip2')}</p>
        <p>• {t('products.edit.images.tip3')}</p>
      </div>
    </div>
  )
}
