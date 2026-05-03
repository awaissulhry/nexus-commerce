'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PackageOpen,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface VariationChild {
  id: string
  sku: string
  attributes: Record<string, string>
  price: number
  stock: number
  missingAttributes: string[]
}

interface ThemeOption {
  id: string
  label: string
  requiredAttributes: string[]
}

interface VariationsPayload {
  isParent: boolean
  parentSku: string
  parentName: string
  themes: ThemeOption[]
  children: VariationChild[]
  presentAttributes: string[]
}

interface VariationsSlice {
  theme?: string
  includedSkus?: string[]
}

export default function Step5Variations({
  wizardState,
  updateWizardState,
  wizardId,
}: StepProps) {
  const slice = (wizardState.variations ?? {}) as VariationsSlice

  const [payload, setPayload] = useState<VariationsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<string | null>(slice.theme ?? null)
  const [includedSkus, setIncludedSkus] = useState<Set<string>>(
    new Set(slice.includedSkus ?? []),
  )

  // Fetch payload whenever the theme changes — server re-annotates
  // missing attributes per-row based on the selected theme.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const url = new URL(
      `${getBackendUrl()}/api/listing-wizard/${wizardId}/variations`,
    )
    if (theme) url.searchParams.set('theme', theme)
    fetch(url.toString())
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          return
        }
        const p = json as VariationsPayload
        setPayload(p)
        // First-render seed: include every child by default.
        if (includedSkus.size === 0 && p.children.length > 0) {
          setIncludedSkus(new Set(p.children.map((c) => c.sku)))
        }
        // Default-pick a theme once we know the present attributes.
        if (!theme && p.themes.length > 0) {
          const best = pickDefaultTheme(p.themes, p.presentAttributes)
          if (best) setTheme(best.id)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // includedSkus is read once on first-load to detect "not seeded yet";
    // depending on it would re-fire the fetch on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId, theme])

  const onToggleSku = useCallback((sku: string) => {
    setIncludedSkus((prev) => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }, [])

  const onSelectAll = useCallback(() => {
    if (!payload) return
    setIncludedSkus(new Set(payload.children.map((c) => c.sku)))
  }, [payload])

  const onSelectNone = useCallback(() => {
    setIncludedSkus(new Set())
  }, [])

  // Persist selection whenever theme or included set changes.
  useEffect(() => {
    if (loading) return
    void updateWizardState({
      variations: {
        theme: theme ?? undefined,
        includedSkus: Array.from(includedSkus),
      } as VariationsSlice,
    })
    // updateWizardState is stable from the wizard shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, includedSkus, loading])

  const includedChildren = useMemo(() => {
    if (!payload) return []
    return payload.children.filter((c) => includedSkus.has(c.sku))
  }, [payload, includedSkus])

  const blockingChildren = useMemo(() => {
    return includedChildren.filter((c) => c.missingAttributes.length > 0)
  }, [includedChildren])

  const onContinue = useCallback(async () => {
    if (!payload) return
    if (payload.isParent && includedChildren.length === 0) return
    if (blockingChildren.length > 0) return
    await updateWizardState(
      {
        variations: {
          theme: theme ?? undefined,
          includedSkus: Array.from(includedSkus),
        } as VariationsSlice,
      },
      { advance: true },
    )
  }, [
    blockingChildren.length,
    includedChildren.length,
    includedSkus,
    payload,
    theme,
    updateWizardState,
  ])

  // Single-product (non-parent) short-circuit.
  if (payload && !payload.isParent && payload.children.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6">
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-8">
          <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 rounded-full bg-slate-100 text-slate-500">
            <PackageOpen className="w-6 h-6" />
          </div>
          <h2 className="text-[18px] font-semibold text-slate-900 text-center">
            No variations to configure
          </h2>
          <p className="mt-2 text-[13px] text-slate-600 text-center">
            <span className="font-mono">{payload.parentSku}</span> is a single
            product without size/color/etc. children. Click Continue to skip
            this step.
          </p>
        </div>
        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={() =>
              updateWizardState({}, { advance: true }).catch(() => {})
            }
            className="h-8 px-4 rounded-md bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">
          Variations
        </h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Choose the variation theme Amazon should publish under, then pick
          which children to include.
        </p>
      </div>

      {loading && !payload && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading variations…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {payload && (
        <>
          {/* Theme picker */}
          <div className="border border-slate-200 rounded-lg bg-white px-4 py-3 mb-4">
            <label className="block text-[12px] font-medium text-slate-700 mb-1">
              Variation theme
            </label>
            <select
              value={theme ?? ''}
              onChange={(e) => setTheme(e.target.value || null)}
              className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
              disabled={payload.themes.length === 0}
            >
              {payload.themes.length === 0 ? (
                <option value="">
                  No themes published for this product type
                </option>
              ) : (
                <>
                  <option value="">— Select theme —</option>
                  {payload.themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} ({t.id})
                    </option>
                  ))}
                </>
              )}
            </select>
            {theme && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Required attributes per variation:{' '}
                <span className="font-mono">
                  {payload.themes
                    .find((t) => t.id === theme)
                    ?.requiredAttributes.join(', ') ?? '—'}
                </span>
              </p>
            )}
          </div>

          {/* Children list */}
          <div className="border border-slate-200 rounded-lg bg-white">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between text-[12px]">
              <span className="text-slate-700">
                <span className="font-medium">{includedSkus.size}</span> of{' '}
                {payload.children.length} variations included
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="text-blue-600 hover:underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={onSelectNone}
                  className="text-slate-500 hover:text-slate-700 hover:underline"
                >
                  Select none
                </button>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {payload.children.length === 0 ? (
                <div className="px-3 py-6 text-[12px] text-slate-500 text-center">
                  No children found. Add variations on the master product
                  before listing.
                </div>
              ) : (
                payload.children.map((c) => {
                  const included = includedSkus.has(c.sku)
                  const blocking =
                    included && c.missingAttributes.length > 0
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50',
                        blocking && 'bg-amber-50/40 hover:bg-amber-50/70',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => onToggleSku(c.sku)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[12px] text-slate-900 truncate">
                          {c.sku}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {Object.keys(c.attributes).length === 0
                            ? '(no attributes set)'
                            : Object.entries(c.attributes)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(' · ')}
                        </div>
                      </div>
                      <div className="text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        €{c.price.toFixed(2)} · {c.stock} in stock
                      </div>
                      {blocking && (
                        <span
                          className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded"
                          title={`Missing: ${c.missingAttributes.join(', ')}`}
                        >
                          missing {c.missingAttributes.join(' + ')}
                        </span>
                      )}
                    </label>
                  )
                })
              )}
            </div>
          </div>

          {/* Validation summary + Continue */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <ContinueStatus
              theme={theme}
              includedCount={includedChildren.length}
              blockingCount={blockingChildren.length}
              hasChildren={payload.children.length > 0}
            />
            <button
              type="button"
              onClick={onContinue}
              disabled={
                !payload ||
                (payload.children.length > 0 &&
                  (includedChildren.length === 0 ||
                    blockingChildren.length > 0))
              }
              className={cn(
                'h-8 px-4 rounded-md text-[13px] font-medium',
                !payload ||
                  (payload.children.length > 0 &&
                    (includedChildren.length === 0 ||
                      blockingChildren.length > 0))
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ContinueStatus({
  theme,
  includedCount,
  blockingCount,
  hasChildren,
}: {
  theme: string | null
  includedCount: number
  blockingCount: number
  hasChildren: boolean
}) {
  if (!hasChildren) {
    return <span className="text-[12px] text-slate-500">No variations</span>
  }
  if (includedCount === 0) {
    return (
      <span className="text-[12px] text-amber-700">
        Pick at least one variation
      </span>
    )
  }
  if (blockingCount > 0) {
    return (
      <span className="text-[12px] text-amber-700">
        {blockingCount} variation{blockingCount === 1 ? '' : 's'} missing
        attributes for this theme
      </span>
    )
  }
  if (!theme) {
    return (
      <span className="text-[12px] text-slate-500">
        {includedCount} included — pick a theme to continue
      </span>
    )
  }
  return (
    <span className="text-[12px] text-emerald-700 inline-flex items-center gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5" />
      {includedCount} variation{includedCount === 1 ? '' : 's'} ready
    </span>
  )
}

function pickDefaultTheme(
  themes: ThemeOption[],
  present: string[],
): ThemeOption | null {
  if (themes.length === 0) return null
  const presentSet = new Set(present)
  // Best fit: theme whose required attrs are all present in the data.
  const exact = themes.find((t) =>
    t.requiredAttributes.every((a) => presentSet.has(a)),
  )
  return exact ?? themes[0] ?? null
}
