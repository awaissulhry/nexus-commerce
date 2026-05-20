'use client'

// IR.7.4 — DAM library picker.
//
// Browse + filter + pick a DigitalAsset from /marketing/content's
// library. Selecting one POSTs to /import-from-dam which creates a
// ProductImage referencing the same Cloudinary publicId — no
// re-upload, no asset duplication.
//
// The picker calls the same /api/assets/library endpoint the DAM hub
// uses, so search / folder / tag / quality filters land for free over
// time without per-feature wiring here.

import { useCallback, useEffect, useState } from 'react'
import { ImageIcon, Loader2, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from './api'
import type { ProductImage } from './types'

interface LibraryItem {
  id: string
  label: string
  url: string
  source: 'digital_asset' | 'product_image'
  mimeType?: string | null
  storageId?: string | null
  width?: number | null
  height?: number | null
}

interface LibraryResponse {
  items: LibraryItem[]
  total: number
  page: number
  pageSize: number
}

interface Props {
  productId: string
  onClose: () => void
  /** Called after a successful import so the parent can refresh the
   *  master gallery. Receives the new ProductImage row. */
  onImported: (img: ProductImage) => void
}

export default function DamPickerModal({ productId, onClose, onImported }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const fetchLibrary = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams({
        types: 'image',
        sources: 'digital_asset', // only the DAM side; product_image would self-recurse
        pageSize: '60',
      })
      if (search) params.set('search', search)
      const res = await beFetch(`/api/assets/library?${params.toString()}`)
      if (!res.ok) throw new Error(`Library fetch failed: ${res.status}`)
      const body: LibraryResponse = await res.json()
      setItems(body.items ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Library fetch failed')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => { void fetchLibrary() }, [fetchLibrary])

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function importAsset(asset: LibraryItem) {
    setImportingId(asset.id)
    setImportError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/import-from-dam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id, type: 'ALT', alt: asset.label }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Import failed: ${res.status}`)
      }
      const { image } = await res.json() as { image: ProductImage }
      onImported(image)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImportingId(null)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="DAM library picker" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0 gap-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Add from DAM library
          </h2>
          <div className="flex-1 max-w-md relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by filename, label, tag…"
              className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded pl-7 pr-2 py-1.5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loadError && (
            <div className="text-xs text-red-600 dark:text-red-400 mb-3">{loadError}</div>
          )}
          {importError && (
            <div className="text-xs text-red-600 dark:text-red-400 mb-3">{importError}</div>
          )}

          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <ImageIcon className="w-10 h-10 mb-2 text-slate-300" />
              <p className="text-sm">No assets match your search.</p>
              <p className="text-xs mt-1">Upload assets in /marketing/content first.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => importAsset(item)}
                  disabled={importingId !== null}
                  className={cn(
                    'group aspect-square relative rounded-xl border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 overflow-hidden bg-slate-50 dark:bg-slate-800 transition-all focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50',
                    importingId === item.id && 'ring-2 ring-blue-400',
                  )}
                  title={item.label}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.url}
                    alt={item.label}
                    className="w-full h-full object-contain group-hover:scale-105 transition-transform"
                    loading="lazy"
                  />
                  {importingId === item.id && (
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 text-white animate-spin" />
                    </div>
                  )}
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                    <p className="text-[10px] text-white truncate">{item.label}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Click an asset to import it as a master image. Cloudinary publicId is reused — no extra storage.
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
