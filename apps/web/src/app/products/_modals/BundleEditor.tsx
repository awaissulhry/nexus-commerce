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
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2"><Package size={16} /> Bundles</div>
          <button onClick={onClose} aria-label="Close" className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {!creating ? (
            <>
              <button onClick={() => { setCreating(true); setDraft({ wrapperProductId: '', wrapperName: '', name: '', components: [] }) }} className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
                <Plus size={12} /> New bundle
              </button>
              {loading ? <div className="text-md text-slate-500 py-6 text-center">Loading…</div> : bundles.length === 0 ? (
                <EmptyState icon={Package} title="No bundles yet" description="Create a bundle to group multiple products into one purchasable unit." />
              ) : (
                <div className="space-y-2">
                  {bundles.map((b) => (
                    <div key={b.id} className="border border-slate-200 rounded p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-md font-semibold text-slate-900">{b.name}</div>
                          <div className="text-sm text-slate-500 mt-0.5">
                            Wrapper: <span className="font-mono">{b.wrapperProduct?.sku ?? '?'}</span> · Available: <span className="font-semibold tabular-nums">{b.availableStock}</span>
                          </div>
                          <div className="mt-2 flex items-center gap-1 flex-wrap">
                            {b.components.map((c: any, i: number) => (
                              <span key={i} className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                                {c.product?.sku ?? '?'} × {c.quantity}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button onClick={() => deleteBundle(b.id)} aria-label={`Delete bundle ${b.name}`} className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-slate-400 hover:text-rose-600 inline-flex items-center justify-center rounded">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : draft && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-md font-semibold text-slate-900">New bundle</div>
                <button onClick={() => { setCreating(false); setDraft(null) }} className="text-base text-slate-500 hover:text-slate-900">Cancel</button>
              </div>

              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold">Bundle name</label>
                <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full h-8 px-2 text-md border border-slate-200 rounded mt-1" placeholder="e.g. Starter kit — Jacket + Helmet + Gloves" />
              </div>

              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold">Wrapper product (the SKU customers actually buy)</label>
                {draft.wrapperProductId ? (
                  <div className="mt-1 px-2 py-1.5 bg-blue-50 border border-blue-200 rounded text-base flex items-center justify-between">
                    <span>{draft.wrapperName}</span>
                    <button onClick={() => setDraft({ ...draft, wrapperProductId: '', wrapperName: '' })} className="text-rose-600">Remove</button>
                  </div>
                ) : (
                  <>
                    <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU or name…" className="w-full h-8 px-2 text-md border border-slate-200 rounded mt-1" />
                    {searchResults.length > 0 && (
                      <div className="mt-1 border border-slate-200 rounded max-h-40 overflow-y-auto">
                        {searchResults.map((p) => (
                          <button key={p.id} onClick={() => { setDraft({ ...draft, wrapperProductId: p.id, wrapperName: `${p.sku} — ${p.name}` }); setSearch('') }} className="w-full text-left px-2 py-1.5 text-base hover:bg-slate-50 border-b border-slate-100 last:border-0">
                            <div className="font-mono text-slate-700">{p.sku}</div>
                            <div className="text-slate-500">{p.name}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold">Components</label>
                {draft.components.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {draft.components.map((c, i) => (
                      <li key={i} className="flex items-center gap-2 px-2 py-1 bg-slate-50 rounded">
                        <span className="text-base font-mono flex-1 truncate">{c.sku}</span>
                        <input type="number" min="1" value={c.quantity} onChange={(e) => setDraft({ ...draft, components: draft.components.map((cc, j) => j === i ? { ...cc, quantity: Number(e.target.value) || 1 } : cc) })} className="w-16 h-7 px-1 text-right tabular-nums border border-slate-200 rounded text-base" />
                        <button onClick={() => setDraft({ ...draft, components: draft.components.filter((_, j) => j !== i) })} aria-label={`Remove ${c.sku} from bundle`} className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-rose-600"><X size={12} /></button>
                      </li>
                    ))}
                  </ul>
                )}
                {searchResults.length > 0 && search && !draft.wrapperProductId === false && (
                  <div className="mt-1 border border-slate-200 rounded max-h-40 overflow-y-auto">
                    <div className="px-2 py-1 text-xs uppercase tracking-wider text-slate-500 bg-slate-50">Add as component</div>
                    {searchResults.map((p) => (
                      <button key={`comp-${p.id}`} onClick={() => { setDraft({ ...draft, components: [...draft.components, { productId: p.id, sku: p.sku, name: p.name, quantity: 1 }] }); setSearch('') }} className="w-full text-left px-2 py-1.5 text-base hover:bg-slate-50 border-b border-slate-100 last:border-0">
                        <div className="font-mono text-slate-700">{p.sku}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button onClick={createBundle} disabled={!draft.wrapperProductId || !draft.name.trim() || draft.components.length === 0} className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Create bundle</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
