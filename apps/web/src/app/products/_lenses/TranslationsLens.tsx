'use client'

/**
 * W5.6 — Translations lens (Akeneo per-locale completeness).
 *
 * Matrix view: products × supported locales. Each cell shows
 * translation coverage for that (product, language) tuple — how
 * many of the 4 ProductTranslation fields (name / description /
 * bullets / keywords) have content. Click a cell → drawer at the
 * translations tab so the operator can fill the gaps directly.
 *
 * Locale set is fixed for now to match Xavia's active EU
 * marketplaces (it + en + de + fr + es). When the team adds new
 * marketplaces or a configurable supportedLocales setting lands,
 * this list can move to BrandSettings.
 *
 * The legend's "primary" badge marks the operator's primary
 * language (NEXUS_PRIMARY_LANGUAGE = 'it' default per the API
 * config). The primary cell is special because that's where the
 * master content lives — empty here means the product has no
 * content at all, not just no translations.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Globe } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { type ProductRow } from '../_types'

// Active locale set. Move to BrandSettings when configurability
// matters.
const LOCALES = [
  { code: 'it', label: 'Italian',  primary: true  },
  { code: 'en', label: 'English',  primary: false },
  { code: 'de', label: 'German',   primary: false },
  { code: 'fr', label: 'French',   primary: false },
  { code: 'es', label: 'Spanish',  primary: false },
] as const
type Locale = (typeof LOCALES)[number]['code']

const FIELD_TOTAL = 4 // name / description / bullets / keywords

interface CoverageCell {
  hasContent: boolean
  fieldCount: number
  reviewed: boolean
}

interface BulkResponse {
  results: Record<string, Record<string, CoverageCell>>
}

function tone(fieldCount: number): string {
  if (fieldCount >= FIELD_TOTAL)
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
  if (fieldCount > 0)
    return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
  return 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
}

export function TranslationsLens({
  products,
  loading: parentLoading,
}: {
  products: ProductRow[]
  loading: boolean
}) {
  const [byProduct, setByProduct] = useState<
    Record<string, Record<string, CoverageCell>>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (products.length === 0) {
      setByProduct({})
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/translation-coverage/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: products.map((p) => p.id) }),
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: BulkResponse) => {
        if (cancelled) return
        setByProduct(data.results ?? {})
      })
      .catch((e) => !cancelled && setError(e?.message ?? String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [products])

  // Per-locale aggregate: how many products have ANY content in
  // each locale. Powers the column header counts.
  const localeCoverage = useMemo(() => {
    const counts: Record<Locale, number> = {
      it: 0,
      en: 0,
      de: 0,
      fr: 0,
      es: 0,
    }
    for (const p of products) {
      const cov = byProduct[p.id]
      if (!cov) continue
      for (const loc of LOCALES) {
        if (cov[loc.code]?.hasContent) counts[loc.code]++
      }
    }
    return counts
  }, [byProduct, products])

  if (parentLoading) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400">
        Loading products…
      </div>
    )
  }
  if (products.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="No products to translate"
        description="Adjust filters so at least one product matches and the translation matrix appears here."
        action={{ label: 'Clear filters', href: '/products' }}
      />
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Per-locale aggregate cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {LOCALES.map((loc) => {
          const covered = localeCoverage[loc.code]
          const pct =
            products.length > 0
              ? Math.round((covered / products.length) * 100)
              : 0
          return (
            <Card key={loc.code} title={loc.label}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'inline-flex items-center px-1.5 py-0.5 text-base font-semibold rounded tabular-nums',
                      pct >= 90
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : pct >= 50
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                          : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
                    )}
                  >
                    {pct}%
                  </span>
                  {loc.primary && (
                    <span className="text-xs italic text-slate-500 dark:text-slate-400">
                      primary
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {covered} / {products.length}
                </span>
              </div>
            </Card>
          )
        })}
      </div>

      {/* Per-product matrix */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left">
              <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                Product
              </th>
              {LOCALES.map((loc) => (
                <th
                  key={loc.code}
                  className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-center w-24 uppercase tracking-wider"
                >
                  {loc.code}
                  {loc.primary && (
                    <span className="ml-1 text-xs italic font-normal text-slate-400 dark:text-slate-500 normal-case tracking-normal">
                      primary
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.slice(0, 200).map((p) => {
              const cov = byProduct[p.id] ?? {}
              return (
                <tr
                  key={p.id}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/products?drawer=${p.id}&drawerTab=translations`}
                      className="text-slate-900 dark:text-slate-100 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-md">
                      {p.sku}
                      {p.brand && (
                        <span className="ml-1 text-slate-400 dark:text-slate-500">
                          · {p.brand}
                        </span>
                      )}
                    </div>
                  </td>
                  {LOCALES.map((loc) => {
                    const c = cov[loc.code]
                    if (loading && !cov[loc.code]) {
                      return (
                        <td key={loc.code} className="px-3 py-2 text-center">
                          <span className="inline-block w-12 h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
                        </td>
                      )
                    }
                    const fieldCount = c?.fieldCount ?? 0
                    return (
                      <td key={loc.code} className="px-3 py-2 text-center">
                        <Link
                          href={`/products?drawer=${p.id}&drawerTab=translations`}
                          className={cn(
                            'inline-flex items-center px-2 py-0.5 text-sm font-medium rounded tabular-nums hover:opacity-80',
                            tone(fieldCount),
                          )}
                          title={
                            fieldCount === FIELD_TOTAL
                              ? `Complete${c?.reviewed ? ' · reviewed' : ''}`
                              : `${fieldCount} of ${FIELD_TOTAL} fields filled`
                          }
                        >
                          {fieldCount}/{FIELD_TOTAL}
                          {c?.reviewed && (
                            <span className="ml-0.5 text-xs">✓</span>
                          )}
                        </Link>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
