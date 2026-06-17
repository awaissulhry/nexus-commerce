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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Folder, ImageIcon, Loader2, Search, Tag as TagIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from './api'
import { useTranslations } from '@/lib/i18n/use-translations'
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

interface FolderItem {
  id: string
  name: string
  parentId: string | null
  _count: { assets: number }
}

interface TagItem {
  id: string
  name: string
  _count: { assets: number }
}

interface Props {
  productId: string
  onClose: () => void
  /** Called after a successful import so the parent can refresh the
   *  master gallery. Receives the new ProductImage row. */
  onImported: (img: ProductImage) => void
  // IE.7 — cross-product reuse. Pre-scopes the picker to assets
  // already used by Products with the same brand + productType.
  // Operator can clear either chip to widen the search.
  productBrand?: string | null
  productProductType?: string | null
}

export default function DamPickerModal({
  productId,
  onClose,
  onImported,
  productBrand,
  productProductType,
}: Props) {
  const { t } = useTranslations()
  const [items, setItems] = useState<LibraryItem[]>([])
  const [search, setSearch] = useState('')
  const [folderId, setFolderId] = useState<string>('') // '' = any, 'unfiled' = none, else folder id
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set())
  const [missingAltOnly, setMissingAltOnly] = useState(false)
  // IE.7 — scope chips. Default ON when the corresponding field is
  // available so the operator sees same-brand + same-productType
  // matches first. Clearing widens to the full DAM.
  const [scopeBrand, setScopeBrand] = useState<boolean>(!!productBrand)
  const [scopeProductType, setScopeProductType] = useState<boolean>(!!productProductType)
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [tags, setTags] = useState<TagItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // Fetch folders + tags once on mount — they don't change while
  // the picker is open, and the response is small enough to skip
  // pagination.
  useEffect(() => {
    void (async () => {
      try {
        const [foldersRes, tagsRes] = await Promise.all([
          beFetch('/api/asset-folders'),
          beFetch('/api/asset-tags'),
        ])
        if (foldersRes.ok) {
          const body = await foldersRes.json()
          setFolders(body.folders ?? [])
        }
        if (tagsRes.ok) {
          const body = await tagsRes.json()
          // Show only tags that have at least one asset — empty tags
          // would surface as dead options.
          setTags((body.tags ?? []).filter((t: TagItem) => (t._count?.assets ?? 0) > 0))
        }
      } catch {
        // Filter loading is non-fatal — the picker still works with
        // search only if folder/tag endpoints fail.
      }
    })()
  }, [])

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
      if (folderId) params.set('folderId', folderId)
      if (selectedTagIds.size > 0) params.set('tagIds', Array.from(selectedTagIds).join(','))
      if (missingAltOnly) params.set('missingAlt', '1')
      // IE.7 — Cross-product reuse filters. Library API joins
      // through AssetUsage to find DigitalAssets already in use by
      // Products with the same brand / productType.
      if (scopeBrand && productBrand) params.set('relatedBrand', productBrand)
      if (scopeProductType && productProductType) params.set('relatedProductType', productProductType)
      const res = await beFetch(`/api/assets/library?${params.toString()}`)
      if (!res.ok) throw new Error(`Library fetch failed: ${res.status}`)
      const body: LibraryResponse = await res.json()
      setItems(body.items ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Library fetch failed')
    } finally {
      setLoading(false)
    }
  }, [search, folderId, selectedTagIds, missingAltOnly, scopeBrand, scopeProductType, productBrand, productProductType])

  useEffect(() => { void fetchLibrary() }, [fetchLibrary])

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }

  function clearFilters() {
    setSearch('')
    setFolderId('')
    setSelectedTagIds(new Set())
    setMissingAltOnly(false)
  }

  const hasActiveFilters = useMemo(
    () => !!search || !!folderId || selectedTagIds.size > 0 || missingAltOnly,
    [search, folderId, selectedTagIds, missingAltOnly],
  )

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
        <div className="flex items-center justify-between px-5 py-4 border-b border-default dark:border-slate-700 flex-shrink-0 gap-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.images.dam.title')}
          </h2>
          <div className="flex-1 max-w-md relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('products.edit.images.dam.search')}
              className="w-full text-sm border border-default dark:border-slate-700 rounded pl-7 pr-2 py-1.5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* IE.7 — Cross-product scope chips. Default ON so the
            picker surfaces brand/productType matches first; the
            operator can click a chip to widen to the full DAM. */}
        {(productBrand || productProductType) && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-subtle dark:border-slate-800 flex-shrink-0 text-xs">
            <span className="text-[11px] uppercase tracking-wide text-tertiary font-medium">Scope</span>
            {productBrand && (
              <button
                type="button"
                onClick={() => setScopeBrand((v) => !v)}
                className={cn(
                  'inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                  scopeBrand
                    ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300'
                    : 'border-default dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
                title="Show only assets already used by other products in this brand"
              >
                Brand: {productBrand}
              </button>
            )}
            {productProductType && (
              <button
                type="button"
                onClick={() => setScopeProductType((v) => !v)}
                className={cn(
                  'inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                  scopeProductType
                    ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300'
                    : 'border-default dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
                title="Show only assets already used by other products of the same type"
              >
                Type: {productProductType}
              </button>
            )}
          </div>
        )}

        {/* Filter strip — folder, tags, missing-alt + clear */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-subtle dark:border-slate-800 flex-shrink-0 flex-wrap text-xs">
          {/* Folder */}
          <div className="flex items-center gap-1.5">
            <Folder className="w-3.5 h-3.5 text-tertiary" />
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="text-xs border border-default dark:border-slate-700 rounded px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400 max-w-[180px]"
            >
              <option value="">{t('products.edit.images.dam.anyFolder')}</option>
              <option value="unfiled">{t('products.edit.images.dam.unfiled')}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f._count?.assets ?? 0})
                </option>
              ))}
            </select>
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <TagIcon className="w-3.5 h-3.5 text-tertiary" />
              {tags.slice(0, 10).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTag(t.id)}
                  className={cn(
                    'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                    selectedTagIds.has(t.id)
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300'
                      : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}

          {/* Missing alt */}
          <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={missingAltOnly}
              onChange={(e) => setMissingAltOnly(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 text-blue-500 focus:ring-blue-400"
            />
            {t('products.edit.images.dam.missingAlt')}
          </label>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-auto text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 underline"
            >
              {t('products.edit.images.dam.clearFilters')}
            </button>
          )}
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
            <div className="flex items-center justify-center py-16 text-tertiary">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-tertiary">
              <ImageIcon className="w-10 h-10 mb-2 text-slate-300" />
              <p className="text-sm">{t('products.edit.images.dam.noMatch')}</p>
              <p className="text-xs mt-1">{t('products.edit.images.dam.uploadFirst')}</p>
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
                    'group aspect-square relative rounded-xl border-2 border-default dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 overflow-hidden bg-slate-50 dark:bg-slate-800 transition-all focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50',
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
                    decoding="async"
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
        <div className="flex items-center justify-between px-5 py-3 border-t border-default dark:border-slate-700 flex-shrink-0">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {t('products.edit.images.dam.clickToImport')}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">
            {t('products.edit.images.dam.done')}
          </Button>
        </div>
      </div>
    </div>
  )
}
