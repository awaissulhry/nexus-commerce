'use client'

/**
 * P.4 — extracted from ProductsWorkspace.tsx (was lines 4615-4787).
 *
 * Bundle editor modal. Lists bundles, lets the user create one by
 * picking a wrapper product (the SKU customers actually buy) plus
 * one or more component products with per-component quantities. The
 * wrapper's available stock is computed server-side from the
 * components' available stock.
 *
 * No internal coupling to the rest of the workspace beyond the
 * `onChanged` callback that the parent uses to refresh its grid.
 */

import { useCallback, useEffect, useState } from 'react'
import { Package, Plus, Trash2, X } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'

interface BundleComponentDraft {
  productId: string
  sku: string
  name: string
  quantity: number
}

interface BundleDraft {
  wrapperProductId: string
  wrapperName: string
  name: string
  components: BundleComponentDraft[]
}

export default function BundleEditor({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [bundles, setBundles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [draft, setDraft] = useState<BundleDraft | null>(null)

  const fetchBundles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/bundles`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setBundles(data.items ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBundles()
  }, [fetchBundles])

  const searchProducts = useCallback(async () => {
    if (!search.trim()) {
      setSearchResults([])
      return
    }
    const res = await fetch(
      `${getBackendUrl()}/api/products?search=${encodeURIComponent(search.trim())}&limit=10`,
    )
    if (res.ok) {
      const data = await res.json()
      setSearchResults(data.products ?? [])
    }
  }, [search])

  useEffect(() => {
    const t = setTimeout(searchProducts, 200)
    return () => clearTimeout(t)
  }, [searchProducts])

  const createBundle = async () => {
    if (!draft || !draft.wrapperProductId || !draft.name.trim()) return
    const res = await fetch(`${getBackendUrl()}/api/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: draft.wrapperProductId,
        name: draft.name,
        components: draft.components.map((c) => ({
          productId: c.productId,
          quantity: c.quantity,
        })),
      }),
    })
    if (res.ok) {
      setDraft(null)
      setCreating(false)
      fetchBundles()
      onChanged()
    } else {
      const err = await res.json()
      toast.error(err.error ?? 'Failed to create bundle')
    }
  }

  const deleteBundle = async (id: string) => {
    if (!(await askConfirm({ title: 'Delete this bundle?', confirmLabel: 'Delete', tone: 'danger' }))) return
    await fetch(`${getBackendUrl()}/api/bundles/${id}`, { method: 'DELETE' })
    fetchBundles()
  }

  return (
    // U.3b — Modal primitive replaces hand-rolled overlay + panel.
    // Custom header retained (Package icon + "Bundles" title) since
    // Modal's default `title` prop renders text-only; header={null}
    // keeps the existing sticky-top header with the close X.
    <Modal open onClose={onClose} placement="centered" size="3xl" header={null}>
        <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900 z-10 dark:bg-slate-900 dark:border-slate-800">
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2 dark:text-slate-100"><Package size={16} /> Bundles</div>
          <IconButton onClick={onClose} aria-label="Close" size="md" className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"><X size={16} /></IconButton>
        </header>
        <div className="p-5 space-y-4 overflow-y-auto">
          {!creating ? (
            <>
              <Button
                onClick={() => {
                  setCreating(true)
                  setDraft({ wrapperProductId: '', wrapperName: '', name: '', components: [] })
                }}
                className="bg-slate-900 dark:bg-slate-100 text-white border-slate-900 hover:bg-slate-800"
                icon={<Plus size={12} />}
              >
                New bundle
              </Button>
              {loading ? <div className="text-md text-slate-500 dark:text-slate-400 py-6 text-center">Loading…</div> : bundles.length === 0 ? (
                <EmptyState icon={Package} title="No bundles yet" description="Create a bundle to group multiple products into one purchasable unit." />
              ) : (
                <div className="space-y-2">
                  {bundles.map((b) => (
                    <div key={b.id} className="border border-slate-200 dark:border-slate-700 rounded p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-md font-semibold text-slate-900 dark:text-slate-100">{b.name}</div>
                          <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                            Wrapper: <span className="font-mono">{b.wrapperProduct?.sku ?? '?'}</span> · Available: <span className="font-semibold tabular-nums">{b.availableStock}</span>
                          </div>
                          <div className="mt-2 flex items-center gap-1 flex-wrap">
                            {b.components.map((c: any, i: number) => (
                              <span key={i} className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">
                                {c.product?.sku ?? '?'} × {c.quantity}
                              </span>
                            ))}
                          </div>
                        </div>
                        <IconButton
                          onClick={() => deleteBundle(b.id)}
                          aria-label={`Delete bundle ${b.name}`}
                          size="md"
                          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-slate-400 dark:text-slate-500 hover:text-rose-600"
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : draft && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100">New bundle</div>
                <button onClick={() => { setCreating(false); setDraft(null) }} className="text-base text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100">Cancel</button>
              </div>

              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Bundle name</label>
                <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded mt-1" placeholder="e.g. Starter kit — Jacket + Helmet + Gloves" />
              </div>

              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Wrapper product (the SKU customers actually buy)</label>
                {draft.wrapperProductId ? (
                  <div className="mt-1 px-2 py-1.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded text-base flex items-center justify-between">
                    <span>{draft.wrapperName}</span>
                    <button onClick={() => setDraft({ ...draft, wrapperProductId: '', wrapperName: '' })} className="text-rose-600 dark:text-rose-400">Remove</button>
                  </div>
                ) : (
                  <>
                    <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU or name…" className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded mt-1" />
                    {searchResults.length > 0 && (
                      <div className="mt-1 border border-slate-200 dark:border-slate-700 rounded max-h-40 overflow-y-auto">
                        {searchResults.map((p) => (
                          <button key={p.id} onClick={() => { setDraft({ ...draft, wrapperProductId: p.id, wrapperName: `${p.sku} — ${p.name}` }); setSearch('') }} className="w-full text-left px-2 py-1.5 text-base hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-0">
                            <div className="font-mono text-slate-700 dark:text-slate-300">{p.sku}</div>
                            <div className="text-slate-500 dark:text-slate-400">{p.name}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Components</label>
                {draft.components.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {draft.components.map((c, i) => (
                      <li key={i} className="flex items-center gap-2 px-2 py-1 bg-slate-50 dark:bg-slate-800 rounded">
                        <span className="text-base font-mono flex-1 truncate">{c.sku}</span>
                        <input type="number" min="1" value={c.quantity} onChange={(e) => setDraft({ ...draft, components: draft.components.map((cc, j) => j === i ? { ...cc, quantity: Number(e.target.value) || 1 } : cc) })} className="w-16 h-7 px-1 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-base" />
                        <IconButton
                          onClick={() => setDraft({ ...draft, components: draft.components.filter((_, j) => j !== i) })}
                          aria-label={`Remove ${c.sku} from bundle`}
                          size="sm"
                          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                        >
                          <X size={12} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
                {searchResults.length > 0 && search && !draft.wrapperProductId === false && (
                  <div className="mt-1 border border-slate-200 dark:border-slate-700 rounded max-h-40 overflow-y-auto">
                    <div className="px-2 py-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800">Add as component</div>
                    {searchResults.map((p) => (
                      <button key={`comp-${p.id}`} onClick={() => { setDraft({ ...draft, components: [...draft.components, { productId: p.id, sku: p.sku, name: p.name, quantity: 1 }] }); setSearch('') }} className="w-full text-left px-2 py-1.5 text-base hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <div className="font-mono text-slate-700 dark:text-slate-300">{p.sku}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <Button
                onClick={createBundle}
                disabled={!draft.wrapperProductId || !draft.name.trim() || draft.components.length === 0}
                className="bg-slate-900 dark:bg-slate-100 text-white border-slate-900 hover:bg-slate-800"
              >
                Create bundle
              </Button>
            </div>
          )}
        </div>
    </Modal>
  )
}
