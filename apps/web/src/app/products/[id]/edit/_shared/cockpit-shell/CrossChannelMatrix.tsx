'use client'

// T3.3b — cross-channel matrix + propagation.
//
// A drawer that compares one product's key fields across every channel ×
// market (Amazon + eBay) AND lets the operator push one field's value
// from a chosen source coordinate to the rest — with diff-then-apply.
//
// Guardrails (operators can't read the target languages):
//   • currency-mismatch price targets are skipped (B2);
//   • machine-translated values are flagged for review (B3) and can be
//     back-translated to English on demand to verify meaning;
//   • nothing is written until the operator hits Apply.
// Complements the per-channel tabs — never merges them.

import { useEffect, useState } from 'react'
import { Loader2, ArrowRight, AlertTriangle, Languages, Check } from 'lucide-react'
import CockpitDrawer from './CockpitDrawer'
import {
  useFieldLinks,
  type PropagatePreview,
  type PropagationEntryDto,
  type ApplyResult,
} from './useFieldLinks'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ListingRow {
  channel: string
  marketplace: string
  status: string | null
  title: string | null
  hasDescription: boolean
  price: number | null
  lastSyncedAt: string | null
}

export interface CrossChannelMatrixProps {
  productId: string
  open: boolean
  onClose: () => void
}

type FieldChoice = 'title' | 'description' | 'price' | 'brand'
const FIELD_KEY: Record<FieldChoice, string> = {
  title: 'item_name',
  description: 'product_description',
  price: 'our_price',
  brand: 'brand',
}

function currencyFor(mp: string): string {
  const m = mp.toUpperCase()
  if (m === 'UK' || m === 'GB') return 'GBP'
  if (m === 'US') return 'USD'
  if (m === 'JP') return 'JPY'
  return 'EUR'
}
function fmtPrice(v: number | null, mp: string): string {
  if (v == null) return '—'
  const c = currencyFor(mp)
  const sym = c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'USD' ? '$' : c === 'JPY' ? '¥' : `${c} `
  return `${sym}${v.toFixed(2)}`
}
const coordKey = (c: string, m: string) => `${c}:${m}`

export default function CrossChannelMatrix({ productId, open, onClose }: CrossChannelMatrixProps) {
  const { t } = useTranslations()
  const fieldLinks = useFieldLinks(productId)
  const [rows, setRows] = useState<ListingRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Propagation state.
  const [field, setField] = useState<FieldChoice>('title')
  const [source, setSource] = useState<string>('') // "CHANNEL:MARKET"
  const [preview, setPreview] = useState<PropagatePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)
  const [backTr, setBackTr] = useState<Record<string, string>>({})
  const [backTrBusy, setBackTrBusy] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setPreview(null)
    setApplyResult(null)
    fetch(`${getBackendUrl()}/api/products/${productId}/listings`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: { listings: ListingRow[] }) => {
        if (cancelled) return
        const list = j.listings ?? []
        setRows(list)
        if (list.length > 0 && !source) setSource(coordKey(list[0].channel, list[0].marketplace))
      })
      .catch(() => {
        if (!cancelled) setError(t('products.edit.cockpit.xchannel.loadError'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productId, t])

  async function handlePropagate() {
    if (!rows || !source) return
    const [sc, sm] = source.split(':')
    const targets = rows
      .filter((r) => coordKey(r.channel, r.marketplace) !== source)
      .map((r) => ({ channel: r.channel, marketplace: r.marketplace }))
    if (targets.length === 0) return
    setPreviewing(true)
    setApplyResult(null)
    setBackTr({})
    const res = await fieldLinks.crossChannelPreview(
      FIELD_KEY[field],
      { channel: sc, marketplace: sm },
      targets,
      field === 'price' ? 'VERBATIM' : 'TRANSLATE',
    )
    setPreview(res ?? { entries: [], translatable: false, aiBudgetExceeded: false })
    setPreviewing(false)
  }

  async function handleApply(onlyFailed = false) {
    if (!preview) return
    setApplying(true)
    const targetEntries =
      onlyFailed && applyResult
        ? preview.entries.filter((e) =>
            applyResult.results.some(
              (r) => r.channel === e.channel && r.marketplace === e.marketplace && !r.ok,
            ),
          )
        : preview.entries
    const res = await fieldLinks.applyPropagation(FIELD_KEY[field], targetEntries)
    const [sc, sm] = source.split(':')
    await fieldLinks.recordPropagationApplied(FIELD_KEY[field], { channel: sc, marketplace: sm }, res.results)
    setApplyResult((prev) => {
      if (!onlyFailed || !prev) return res
      // Merge retry results over the prior run.
      const merged = new Map(prev.results.map((r) => [coordKey(r.channel, r.marketplace), r]))
      for (const r of res.results) merged.set(coordKey(r.channel, r.marketplace), r)
      const all = Array.from(merged.values())
      return { ok: all.filter((r) => r.ok).length, fail: all.filter((r) => !r.ok).length, results: all }
    })
    setApplying(false)
  }

  async function handleVerify(e: PropagationEntryDto) {
    const k = coordKey(e.channel, e.marketplace)
    if (!e.proposedValue) return
    setBackTrBusy((s) => new Set(s).add(k))
    const en = await fieldLinks.backTranslate(e.proposedValue, e.language ?? 'en')
    setBackTr((m) => ({ ...m, [k]: en ?? '—' }))
    setBackTrBusy((s) => {
      const n = new Set(s)
      n.delete(k)
      return n
    })
  }

  const fieldOptions: Array<{ v: FieldChoice; label: string }> = [
    { v: 'title', label: t('products.edit.cockpit.xchannel.fieldTitle') },
    { v: 'description', label: t('products.edit.cockpit.xchannel.fieldDescription') },
    { v: 'price', label: t('products.edit.cockpit.xchannel.fieldPrice') },
    { v: 'brand', label: t('products.edit.cockpit.xchannel.fieldBrand') },
  ]
  // Only rows that will actually write: not skipped, changed, and with a
  // resolved value. A "translate" row with a null proposal (AI off /
  // failed) can't apply, so it must not be counted as actionable.
  const applicable =
    preview?.entries.filter(
      (e) => e.action !== 'skip' && !e.unchanged && e.proposedValue != null,
    ) ?? []
  const appliedMap = new Map(
    (applyResult?.results ?? []).map((r) => [coordKey(r.channel, r.marketplace), r.ok]),
  )

  return (
    <CockpitDrawer
      open={open}
      onClose={onClose}
      width="lg"
      title={t('products.edit.cockpit.xchannel.title')}
    >
      <div className="p-4 space-y-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('products.edit.cockpit.xchannel.subtitle')}
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            {t('products.edit.cockpit.xchannel.loading')}
          </div>
        )}
        {error && <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>}
        {rows && rows.length === 0 && !loading && (
          <div className="text-sm text-slate-400">{t('products.edit.cockpit.xchannel.empty')}</div>
        )}

        {rows && rows.length > 0 && (
          <>
            {/* Propagation bar. Native selects (matches the rest of the UI);
                they work now that the drawer no longer thrashes focus on
                every re-render. */}
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <label className="text-xs text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.xchannel.fieldLabel')}
                <select
                  value={field}
                  onChange={(e) => {
                    setField(e.target.value as FieldChoice)
                    setPreview(null)
                    setApplyResult(null)
                  }}
                  className="mt-1 block rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm text-slate-900 dark:text-slate-100"
                >
                  {fieldOptions.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500 dark:text-slate-400">
                {t('products.edit.cockpit.xchannel.sourceLabel')}
                <select
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value)
                    setPreview(null)
                    setApplyResult(null)
                  }}
                  className="mt-1 block rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm text-slate-900 dark:text-slate-100"
                >
                  {rows.map((r) => (
                    <option key={coordKey(r.channel, r.marketplace)} value={coordKey(r.channel, r.marketplace)}>
                      {r.channel} {r.marketplace}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void handlePropagate()}
                disabled={previewing}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {previewing ? (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                )}
                {t('products.edit.cockpit.xchannel.propagate')}
              </button>
            </div>

            {/* Diff panel */}
            {preview && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-3 py-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    {t('products.edit.cockpit.xchannel.proposed')}
                  </span>
                  {applyResult ? (
                    <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span>
                        ✓ {applyResult.ok}
                        {applyResult.fail > 0 ? ` · ⚠ ${applyResult.fail}` : ''}
                      </span>
                      {applyResult.fail > 0 && (
                        <button
                          type="button"
                          onClick={() => void handleApply(true)}
                          disabled={applying}
                          className="inline-flex items-center gap-1 rounded-md border border-amber-300 dark:border-amber-800 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50"
                        >
                          {applying && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
                          {t('products.edit.cockpit.xchannel.retryFailed')}
                        </button>
                      )}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleApply(false)}
                      disabled={applying || applicable.length === 0}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {applying && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
                      {t('products.edit.cockpit.xchannel.apply')} ({applicable.length})
                    </button>
                  )}
                </div>
                {preview.entries.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-slate-400">
                    {t('products.edit.cockpit.xchannel.noChanges')}
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {preview.entries.map((e) => {
                      const k = coordKey(e.channel, e.marketplace)
                      // Translate target with no resolved value = AI off /
                      // failed. Don't render it as "current → —" (looks like
                      // a deletion); show a clear "couldn't translate" note.
                      const untranslatable =
                        e.action === 'translate' && e.proposedValue == null && !e.currencyMismatch
                      return (
                        <li key={k} className="px-3 py-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                              {e.channel} {e.marketplace}
                            </span>
                            <span className="flex items-center gap-1.5">
                              {e.currencyMismatch && (
                                <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                  <AlertTriangle aria-hidden className="h-3 w-3" />
                                  {t('products.edit.cockpit.xchannel.currencyMismatch')}
                                </span>
                              )}
                              {untranslatable && (
                                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                  <Languages aria-hidden className="h-3 w-3" />
                                  {t('products.edit.cockpit.xchannel.translateUnavailable')}
                                </span>
                              )}
                              {e.needsReview && !e.currencyMismatch && (
                                <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                                  <Languages aria-hidden className="h-3 w-3" />
                                  {t('products.edit.cockpit.xchannel.needsReview')}
                                </span>
                              )}
                              {e.unchanged && (
                                <span className="text-[10px] text-slate-400">
                                  {t('products.edit.cockpit.xchannel.unchanged')}
                                </span>
                              )}
                              {appliedMap.has(k) &&
                                (appliedMap.get(k) ? (
                                  <Check aria-hidden className="h-3.5 w-3.5 text-emerald-500" />
                                ) : (
                                  <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-rose-500" />
                                ))}
                            </span>
                          </div>
                          {!e.currencyMismatch && !untranslatable && (
                            <div className="mt-1 text-slate-500 dark:text-slate-400">
                              <span className="line-through opacity-60">{e.currentValue ?? '—'}</span>
                              <span className="mx-1">→</span>
                              <span className="text-slate-800 dark:text-slate-200">{e.proposedValue ?? '—'}</span>
                            </div>
                          )}
                          {e.needsReview && e.proposedValue && (
                            <div className="mt-1">
                              {backTr[k] !== undefined ? (
                                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                  <Check aria-hidden className="mr-1 inline h-3 w-3 text-emerald-500" />
                                  {t('products.edit.cockpit.xchannel.backTranslation')}: {backTr[k]}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleVerify(e)}
                                  disabled={backTrBusy.has(k)}
                                  className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-[10.5px] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                                >
                                  {backTrBusy.has(k) ? (
                                    <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Languages aria-hidden className="h-3 w-3" />
                                  )}
                                  {t('products.edit.cockpit.xchannel.verify')}
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {applyResult && applyResult.ok > 0 && (
                  <div className="border-t border-slate-100 dark:border-slate-800 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    {t('products.edit.cockpit.xchannel.pendingPublish', { n: String(applyResult.ok) })}
                  </div>
                )}
              </div>
            )}

            {/* Comparison table */}
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colChannel')}</th>
                    <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colMarket')}</th>
                    <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colStatus')}</th>
                    <th className="px-3 py-2 font-medium">{t('products.edit.cockpit.xchannel.colTitle')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('products.edit.cockpit.xchannel.colPrice')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={coordKey(r.channel, r.marketplace)} className="text-slate-700 dark:text-slate-300">
                      <td className="px-3 py-1.5 font-medium">{r.channel}</td>
                      <td className="px-3 py-1.5">{r.marketplace}</td>
                      <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">{r.status ?? '—'}</td>
                      <td className="px-3 py-1.5 max-w-[280px] truncate" title={r.title ?? undefined}>
                        {r.title ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtPrice(r.price, r.marketplace)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </CockpitDrawer>
  )
}
