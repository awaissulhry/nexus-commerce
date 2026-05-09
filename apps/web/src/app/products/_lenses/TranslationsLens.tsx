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
import { AlertCircle, Globe, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { type ProductRow } from '../_types'

// Marketplace code per locale — bulk-generate endpoint takes
// marketplace, internally resolves to language via the
// translation-resolver service. Map matches the API's
// LANGUAGE_FOR_MARKETPLACE table (IT→it, DE→de, etc.).
const MARKETPLACE_FOR_LOCALE: Record<string, string> = {
  it: 'IT',
  en: 'UK',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
}

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
  const [translateLocale, setTranslateLocale] = useState<string>('de')
  const [translating, setTranslating] = useState(false)
  const { toast } = useToast()
  const { t } = useTranslations()

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

  // W5.8 — Bulk AI translate. Pulls the productIds visible in the
  // matrix that are MISSING content in the target locale, POSTs to
  // /products/ai/bulk-generate (capped at 50 per call by the
  // endpoint). Refresh on success so the matrix reflects new
  // coverage.
  const runBulkTranslate = async () => {
    if (translating) return
    setTranslating(true)
    try {
      const candidates = products
        .filter((p) => {
          const c = byProduct[p.id]?.[translateLocale]
          return !c || c.fieldCount === 0
        })
        .map((p) => p.id)
        .slice(0, 50) // endpoint cap

      if (candidates.length === 0) {
        toast.success(
          t('products.lens.translations.toast.allFilled', {
            locale: translateLocale.toUpperCase(),
          }),
        )
        return
      }

      const res = await fetch(
        `${getBackendUrl()}/api/products/ai/bulk-generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds: candidates,
            fields: ['title', 'description', 'bullets', 'keywords'],
            marketplace: MARKETPLACE_FOR_LOCALE[translateLocale] ?? 'IT',
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as {
        results?: Array<{ productId: string; ok: boolean; error?: string }>
      }
      const succeeded = (data.results ?? []).filter((r) => r.ok).length
      const failed = (data.results ?? []).filter((r) => !r.ok).length
      if (failed === 0) {
        toast.success(
          t(
            succeeded === 1
              ? 'products.lens.translations.toast.success.one'
              : 'products.lens.translations.toast.success.other',
            { count: succeeded, locale: translateLocale.toUpperCase() },
          ),
        )
      } else {
        toast.error(
          t('products.lens.translations.toast.partial', {
            succeeded,
            failed,
            locale: translateLocale.toUpperCase(),
          }),
        )
      }

      // Re-fetch coverage to reflect new translations.
      const cov = await fetch(
        `${getBackendUrl()}/api/products/translation-coverage/bulk`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: products.map((p) => p.id) }),
        },
      )
      if (cov.ok) {
        const covData = (await cov.json()) as BulkResponse
        setByProduct(covData.results ?? {})
      }
    } catch (e: any) {
      toast.error(t('products.lens.translations.toast.failed', { msg: e?.message ?? String(e) }))
    } finally {
      setTranslating(false)
    }
  }

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
        {t('products.lens.readiness.loading')}
      </div>
    )
  }
  if (products.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title={t('products.lens.translations.empty.title')}
        description={t('products.lens.translations.empty.body')}
        action={{
          label: t('products.lens.translations.empty.action'),
          href: '/products',
        }}
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

      {/* W5.8 — Bulk AI translate toolbar */}
      <div className="flex items-center gap-2 flex-wrap text-sm border border-slate-200 dark:border-slate-800 rounded-md p-2 bg-slate-50/50 dark:bg-slate-900/40">
        <span className="text-slate-600 dark:text-slate-400 inline-flex items-center gap-1">
          <Sparkles className="w-3.5 h-3.5" />
          {t('products.lens.translations.toolbar.label')}
        </span>
        <select
          value={translateLocale}
          onChange={(e) => setTranslateLocale(e.target.value)}
          className="h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          disabled={translating}
        >
          {LOCALES.filter((l) => !l.primary).map((loc) => (
            <option key={loc.code} value={loc.code}>
              {t(`products.lens.translations.locale.${loc.code}`)}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          size="sm"
          onClick={runBulkTranslate}
          loading={translating}
          icon={<Sparkles className="w-3 h-3" />}
        >
          {t('products.lens.translations.toolbar.action')}
        </Button>
        <span className="text-xs text-slate-500 dark:text-slate-400 ml-1">
          {t('products.lens.translations.toolbar.help')}
        </span>
      </div>

      {/* Per-locale aggregate cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {LOCALES.map((loc) => {
          const covered = localeCoverage[loc.code]
          const pct =
            products.length > 0
              ? Math.round((covered / products.length) * 100)
              : 0
          return (
            <Card key={loc.code} title={t(`products.lens.translations.locale.${loc.code}`)}>
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
                      {t('products.lens.translations.primary')}
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
                {t('products.lens.translations.col.product')}
              </th>
              {LOCALES.map((loc) => (
                <th
                  key={loc.code}
                  className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-center w-24 uppercase tracking-wider"
                >
                  {loc.code}
                  {loc.primary && (
                    <span className="ml-1 text-xs italic font-normal text-slate-400 dark:text-slate-500 normal-case tracking-normal">
                      {t('products.lens.translations.primary')}
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
                              ? t(
                                  c?.reviewed
                                    ? 'products.lens.translations.tooltip.completeReviewed'
                                    : 'products.lens.translations.tooltip.complete',
                                )
                              : t('products.lens.translations.tooltip.partial', {
                                  filled: fieldCount,
                                  total: FIELD_TOTAL,
                                })
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
