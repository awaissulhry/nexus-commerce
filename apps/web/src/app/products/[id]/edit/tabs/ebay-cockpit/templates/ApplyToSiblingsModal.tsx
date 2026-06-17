'use client'

// EC.14 — ApplyToSiblingsModal
//
// After perfecting one product's eBay layout (aspects, policies,
// best offer, variation axes, compatibility), the operator can copy
// that layout onto N similar products in one shot. The modal:
//
//   1. Loads candidates — same productType, excluding the donor +
//      its children (the variation matrix already handles those).
//   2. Shows scope toggles — operator picks which layers to copy.
//      Category is OPT-IN by default since copying it across
//      sub-categories is risky.
//   3. Per-candidate diff preview — counts + flags so the operator
//      can spot dangerous targets (already-published listings,
//      different categoryId, etc.) before committing.
//   4. Apply — fires one POST that walks the targets, snapshotting
//      each one as "pre-template-apply" before write so undo per
//      target is one click via the existing version history.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  X, Loader2, Layers, ShieldCheck, Sparkles, Package, Tag,
  Check, AlertTriangle, ArrowRight,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface CandidateSummary {
  categoryId: string | null
  categoryName: string | null
  aspectCount: number
  hasBestOffer: boolean
  hasPolicies: boolean
  variationAxes: string[]
  hasCompatibility: boolean
}

interface Candidate {
  productId: string
  sku: string
  name: string
  productType: string | null
  hasListing: boolean
  listingStatus: string | null
  externalListingId: string | null
  summary: CandidateSummary
}

interface CandidatesResponse {
  donor: { id: string; sku: string; productType: string | null; categoryId: string | null }
  candidates: Candidate[]
  total: number
}

interface Scope {
  aspects: boolean
  policies: boolean
  bestOffer: boolean
  variations: boolean
  compatibility: boolean
  category: boolean
}

interface Props {
  productId: string
  marketplace: string
  open: boolean
  onClose: () => void
}

const DEFAULT_SCOPE: Scope = {
  aspects: true,
  policies: true,
  bestOffer: true,
  variations: true,
  compatibility: true,
  category: false,
}

export default function ApplyToSiblingsModal({
  productId, marketplace, open, onClose,
}: Props) {
  const router = useRouter()
  const [data, setData] = useState<CandidatesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE)
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<Array<{ productId: string; ok: boolean; error?: string }> | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setSelected(new Set())
    setResults(null)
    ;(async () => {
      try {
        const u = new URL(`${getBackendUrl()}/api/ebay/cockpit/template-candidates`)
        u.searchParams.set('productId', productId)
        u.searchParams.set('marketplace', marketplace)
        const res = await fetch(u.toString())
        const json = await res.json()
        if (!res.ok) setError(json?.error ?? `HTTP ${res.status}`)
        else setData(json as CandidatesResponse)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [open, productId, marketplace])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !applying) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, applying, onClose])

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const allIds = (data?.candidates ?? []).map((c) => c.productId)
      if (prev.size === allIds.length) return new Set()
      return new Set(allIds)
    })
  }, [data])

  const handleApply = useCallback(async () => {
    if (applying || selected.size === 0) return
    setApplying(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/template-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donorProductId: productId,
          marketplace,
          targetProductIds: Array.from(selected),
          scope,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      setResults(json.results ?? [])
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [applying, selected, productId, marketplace, scope, router])

  const scopeCount = useMemo(
    () => Object.values(scope).filter(Boolean).length,
    [scope],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={() => !applying && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-siblings-title"
        className="w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center justify-between">
          <div>
            <div id="apply-siblings-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-500" />
              Apply layout to siblings
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Copy this product&apos;s eBay {marketplace} setup to similar products in one shot.
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={applying} className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200 rounded" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scope chooser */}
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-2">
          <div className="text-[10.5px] uppercase tracking-wide text-slate-500 font-medium">
            Layers to copy ({scopeCount})
          </div>
          <div className="flex flex-wrap gap-2">
            <ScopeChip label="Aspects" icon={<Tag className="w-3 h-3" />} active={scope.aspects} onToggle={(v) => setScope((s) => ({ ...s, aspects: v }))} />
            <ScopeChip label="Policies" icon={<ShieldCheck className="w-3 h-3" />} active={scope.policies} onToggle={(v) => setScope((s) => ({ ...s, policies: v }))} />
            <ScopeChip label="Best Offer" icon={<Sparkles className="w-3 h-3" />} active={scope.bestOffer} onToggle={(v) => setScope((s) => ({ ...s, bestOffer: v }))} />
            <ScopeChip label="Variation axes" icon={<Layers className="w-3 h-3" />} active={scope.variations} onToggle={(v) => setScope((s) => ({ ...s, variations: v }))} />
            <ScopeChip label="Compatibility" icon={<Package className="w-3 h-3" />} active={scope.compatibility} onToggle={(v) => setScope((s) => ({ ...s, compatibility: v }))} />
            <ScopeChip
              label="Category"
              icon={<Tag className="w-3 h-3" />}
              active={scope.category}
              onToggle={(v) => setScope((s) => ({ ...s, category: v }))}
              warn
            />
          </div>
          {scope.category && (
            <div className="text-[10.5px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Copying category is risky — siblings may already be in a different sub-category. Their existing categoryId will be overwritten.
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <div className="text-xs text-slate-500 flex items-center gap-2 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading candidates…
            </div>
          )}
          {error && (
            <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
          {!loading && !error && data && data.candidates.length === 0 && (
            <div className="text-xs text-slate-500 italic py-8 text-center">
              No sibling candidates found. We look for products with the same
              productType as this one. Set a productType on similar SKUs to
              enable this flow.
            </div>
          )}
          {!loading && data && data.candidates.length > 0 && !results && (
            <>
              <div className="flex items-center justify-between mb-2 text-xs">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.size === data.candidates.length}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5"
                  />
                  <span className="text-slate-700 dark:text-slate-300">
                    Select all {data.candidates.length}
                  </span>
                </label>
                <span className="text-slate-500">
                  {selected.size} selected
                </span>
              </div>
              <div className="space-y-1">
                {data.candidates.map((c) => (
                  <CandidateRow
                    key={c.productId}
                    candidate={c}
                    donorCategoryId={data.donor.categoryId}
                    selected={selected.has(c.productId)}
                    onToggle={() => toggleSelect(c.productId)}
                  />
                ))}
              </div>
            </>
          )}
          {results && (
            <div className="space-y-2">
              <div className="px-3 py-2 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
                <Check className="w-4 h-4" />
                Applied to {results.filter((r) => r.ok).length} of {results.length} targets.
                {results.some((r) => !r.ok) && ' Failures are listed below.'}
              </div>
              <ul className="space-y-1 text-xs">
                {results.map((r) => (
                  <li key={r.productId} className={cn(
                    'px-2 py-1.5 rounded border',
                    r.ok
                      ? 'border-emerald-100 dark:border-emerald-900/40 text-slate-700 dark:text-slate-300'
                      : 'border-rose-200 dark:border-rose-800 bg-rose-50/40 dark:bg-rose-950/20 text-rose-800 dark:text-rose-300',
                  )}>
                    <span className="font-mono">{r.productId.slice(0, 12)}…</span>
                    {r.ok ? ' ✓ applied' : ` ✗ ${r.error}`}
                  </li>
                ))}
              </ul>
              <div className="text-[10.5px] text-tertiary italic">
                Each target got a "pre-template-apply" snapshot — undo per
                target via the History drawer.
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-subtle dark:border-slate-800 flex items-center justify-end gap-2">
          {!results && (
            <span className="text-[10.5px] text-tertiary mr-auto">
              {selected.size === 0 ? 'Pick at least one target' : `Will apply to ${selected.size} target${selected.size === 1 ? '' : 's'}`}
            </span>
          )}
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
            {results ? 'Close' : 'Cancel'}
          </button>
          {!results && (
            <button
              type="button"
              onClick={handleApply}
              disabled={applying || selected.size === 0 || scopeCount === 0}
              className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
              {applying ? `Applying to ${selected.size}…` : `Apply to ${selected.size}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ScopeChip({
  label, icon, active, onToggle, warn,
}: { label: string; icon: React.ReactNode; active: boolean; onToggle: (v: boolean) => void; warn?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border transition-colors',
        active
          ? warn
            ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
            : 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
          : 'border-default dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function CandidateRow({
  candidate, donorCategoryId, selected, onToggle,
}: { candidate: Candidate; donorCategoryId: string | null; selected: boolean; onToggle: () => void }) {
  const differentCategory =
    candidate.summary.categoryId &&
    donorCategoryId &&
    candidate.summary.categoryId !== donorCategoryId
  const published = candidate.listingStatus === 'ACTIVE' || candidate.listingStatus === 'PUBLISHED'
  return (
    <label className={cn(
      'flex items-start gap-2 px-2.5 py-2 rounded border cursor-pointer transition-colors',
      selected
        ? 'border-blue-300 dark:border-blue-700 bg-blue-50/40 dark:bg-blue-950/20'
        : 'border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800',
    )}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="mt-0.5 w-3.5 h-3.5"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
            {candidate.name || candidate.sku}
          </span>
          <span className="font-mono text-[10.5px] text-slate-500">{candidate.sku}</span>
          {!candidate.hasListing && (
            <span className="text-[10px] px-1 py-0 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">no listing yet</span>
          )}
          {published && (
            <span className="text-[10px] px-1 py-0 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">live</span>
          )}
          {differentCategory && (
            <span className="text-[10px] px-1 py-0 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300" title="Sibling is in a different eBay category">
              ≠ category
            </span>
          )}
        </div>
        <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{candidate.summary.aspectCount} aspects</span>
          {candidate.summary.hasPolicies && <span>· policies set</span>}
          {candidate.summary.hasBestOffer && <span>· best offer on</span>}
          {candidate.summary.variationAxes.length > 0 && (
            <span>· axes: {candidate.summary.variationAxes.join(', ')}</span>
          )}
          {candidate.summary.hasCompatibility && <span>· compatibility</span>}
        </div>
      </div>
    </label>
  )
}
