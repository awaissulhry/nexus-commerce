'use client'

/**
 * IR.12 — Bulk "Apply images" modal.
 *
 * Operator selects N rows in /products, clicks Bulk Images in the
 * BulkActionBar → this modal opens. Operator types to find a SOURCE
 * product (typeahead), picks replace vs append, confirms, and a
 * single POST /api/products/images/bulk-apply mirrors that source's
 * master gallery onto every selected target.
 *
 * Same idempotency + partial-success semantics as the
 * apply-to-children action (IR.8.3) — each target gets its own
 * transaction + AuditLog row.
 */

import { useCallback, useEffect, useState } from 'react'
import { Image as ImageIcon, Loader2, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useTranslations } from '@/lib/i18n/use-translations'

interface BulkImagesModalProps {
  productIds: string[]
  onClose: () => void
  onComplete: () => void
}

interface SourceCandidate {
  id: string
  sku: string
  name: string
}

export default function BulkImagesModal({ productIds, onClose, onComplete }: BulkImagesModalProps) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SourceCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [source, setSource] = useState<SourceCandidate | null>(null)
  const [mode, setMode] = useState<'replace' | 'append'>('replace')
  const [busy, setBusy] = useState(false)

  // Typeahead — same pattern as BundleEditor.
  const searchProducts = useCallback(async () => {
    if (!search.trim()) {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products?search=${encodeURIComponent(search.trim())}&limit=10`,
      )
      if (res.ok) {
        const data = await res.json()
        // Filter out targets so operator can't self-apply.
        const filtered = (data.products ?? [])
          .filter((p: SourceCandidate) => !productIds.includes(p.id))
        setSearchResults(filtered)
      }
    } finally {
      setSearching(false)
    }
  }, [search, productIds])

  useEffect(() => {
    const t = setTimeout(searchProducts, 200)
    return () => clearTimeout(t)
  }, [searchProducts])

  async function submit() {
    if (!source) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/images/bulk-apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceProductId: source.id,
            targetProductIds: productIds,
            mode,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Bulk apply failed: ${res.status}`)
      }
      const result = await res.json() as {
        targetsTotal: number
        targetsUpdated: number
        imagesCreated: number
        errors: unknown[]
      }
      if (result.errors.length > 0) {
        toast.warning(t('products.bulkImages.appliedWithErrors', {
          updated: result.targetsUpdated,
          total: result.targetsTotal,
          created: result.imagesCreated,
          errors: result.errors.length,
        }))
      } else {
        toast.success(t('products.bulkImages.applied', {
          updated: result.targetsUpdated,
          total: result.targetsTotal,
          created: result.imagesCreated,
        }))
      }
      // Every target's master gallery changed — invalidate cleanly.
      for (const id of productIds) {
        emitInvalidation({ type: 'product.updated', id })
      }
      onComplete()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk apply failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('products.bulkImages.title')}
      size="md"
    >
      <div className="space-y-4 px-1">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('products.bulkImages.intro', { count: productIds.length })}
        </p>

        {/* Source picker */}
        <div>
          <label className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1 block">
            {t('products.bulkImages.sourceLabel')}
          </label>
          {source ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
              <ImageIcon className="w-3.5 h-3.5 text-blue-500" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{source.name}</div>
                <div className="text-[11px] font-mono text-slate-500">{source.sku}</div>
              </div>
              <button
                type="button"
                onClick={() => { setSource(null); setSearch('') }}
                className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="Clear source"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary pointer-events-none" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('products.bulkImages.searchPlaceholder')}
                  className="w-full text-sm border border-default dark:border-slate-700 rounded pl-7 pr-2 py-1.5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  autoFocus
                />
              </div>
              {search.length > 0 && (
                <ul className="mt-1 max-h-48 overflow-y-auto border border-default dark:border-slate-700 rounded divide-y divide-slate-100 dark:divide-slate-800">
                  {searching && (
                    <li className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('products.bulkImages.searching')}
                    </li>
                  )}
                  {!searching && searchResults.length === 0 && (
                    <li className="px-3 py-2 text-xs text-tertiary italic">
                      {t('products.bulkImages.noResults')}
                    </li>
                  )}
                  {searchResults.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setSource(r)}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <div className="text-sm text-slate-800 dark:text-slate-100 truncate">{r.name}</div>
                        <div className="text-[11px] font-mono text-slate-500">{r.sku}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* Mode toggle */}
        <div>
          <label className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1 block">
            {t('products.bulkImages.modeLabel')}
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('replace')}
              disabled={busy}
              className={mode === 'replace'
                ? 'flex-1 px-3 py-2 text-xs rounded border-2 border-blue-400 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
                : 'flex-1 px-3 py-2 text-xs rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }
            >
              <div className="font-medium">{t('products.bulkImages.replaceTitle')}</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{t('products.bulkImages.replaceHint')}</div>
            </button>
            <button
              type="button"
              onClick={() => setMode('append')}
              disabled={busy}
              className={mode === 'append'
                ? 'flex-1 px-3 py-2 text-xs rounded border-2 border-blue-400 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
                : 'flex-1 px-3 py-2 text-xs rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }
            >
              <div className="font-medium">{t('products.bulkImages.appendTitle')}</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{t('products.bulkImages.appendHint')}</div>
            </button>
          </div>
        </div>
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('products.bulkImages.cancel')}
        </Button>
        <Button onClick={submit} disabled={!source || busy} className="gap-1.5">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t('products.bulkImages.applyAction', { count: productIds.length })}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
