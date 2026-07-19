'use client'

// IE.16 — Hash-powered duplicate review for the master gallery.
//
// Fetches server-side duplicate clusters (exact bytes via contentHash,
// visually-similar via the same dual-hash rule as the upload gate) and
// lets the operator prune re-uploads that predate the gate. Deletes go
// through the normal per-image DELETE route; "Locate" closes the modal
// and flashes the card in the gallery.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Copy, Crosshair, Loader2, Star, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { beFetch } from './api'
import type { ProductImage } from './types'

interface DupGroup {
  kind: 'exact' | 'near'
  images: ProductImage[]
}

interface Props {
  open: boolean
  productId: string
  onClose: () => void
  onDeleted: (imageId: string) => void
  onLocate: (imageId: string) => void
  onToast?: (msg: string) => void
}

export default function FindDuplicatesModal({ open, productId, onClose, onDeleted, onLocate, onToast }: Props) {
  const { t } = useTranslations()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<DupGroup[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/duplicate-groups`)
      if (!res.ok) throw new Error(`Scan failed: ${res.status}`)
      const data = await res.json() as { groups: DupGroup[] }
      setGroups(data.groups)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function handleDelete(img: ProductImage) {
    setDeletingId(img.id)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${img.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
      // Drop the member locally; collapse groups that fall to one member.
      setGroups((prev) => prev
        .map((g) => ({ ...g, images: g.images.filter((i) => i.id !== img.id) }))
        .filter((g) => g.images.length > 1))
      onDeleted(img.id)
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-slate-950/70 flex items-center justify-center px-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-default dark:border-slate-700 max-w-3xl w-full p-6 space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 flex-shrink-0">
          <div className="flex items-start gap-3">
            <Copy className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {t('products.edit.images.dupGroups.title')}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('products.edit.images.dupGroups.hint')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('products.edit.images.lightbox.close')}
            className="text-tertiary hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 space-y-3 pr-1">
          {loading && (
            <div className="flex items-center gap-2 justify-center py-10 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('products.edit.images.dupGroups.scanning')}
            </div>
          )}
          {!loading && error && (
            <div className="flex items-center gap-2 justify-center py-10 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="w-4 h-4" /> {error}
            </div>
          )}
          {!loading && !error && groups.length === 0 && (
            <div className="text-center py-10 text-sm text-slate-500 dark:text-slate-400">
              {t('products.edit.images.dupGroups.none')}
            </div>
          )}
          {!loading && !error && groups.map((g, gi) => (
            <div key={gi} className="p-3 rounded-xl border border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 space-y-2">
              <span
                className={cn(
                  'inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border',
                  g.kind === 'exact'
                    ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
                    : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
                )}
              >
                {g.kind === 'exact'
                  ? t('products.edit.images.dupGroups.exact')
                  : t('products.edit.images.dupGroups.near')}
                {' · '}{g.images.length}
              </span>
              <div className="flex flex-wrap gap-3">
                {g.images.map((img) => (
                  <div key={img.id} className="w-32 space-y-1">
                    <div className="relative w-32 h-32 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden border border-default dark:border-slate-700">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={img.alt ?? img.type} className="w-full h-full object-contain" />
                      {img.isPrimary && (
                        <Star className="absolute top-1 left-1 w-4 h-4 text-amber-400 fill-amber-400 drop-shadow" />
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {img.type}
                      {img.width && img.height ? ` · ${img.width}×${img.height}` : ''}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onLocate(img.id)}
                        className="text-[11px] h-6 px-1.5 gap-1"
                        title={t('products.edit.images.dupGroups.locate')}
                      >
                        <Crosshair className="w-3 h-3" />
                        {t('products.edit.images.dupGroups.locate')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(img)}
                        disabled={deletingId !== null}
                        className="text-[11px] h-6 px-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                        title={t('products.edit.images.dupGroups.delete')}
                      >
                        {deletingId === img.id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Trash2 className="w-3 h-3" />}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end pt-3 border-t border-subtle dark:border-slate-800 flex-shrink-0">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">
            {t('products.edit.images.lightbox.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}
