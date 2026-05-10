'use client'

/**
 * LWV.1 — Matrix variant builder.
 *
 * Replaces the row-by-row PromotePanel with the bulk pattern operators
 * actually want for variant creation: pick a variation theme → list
 * the axis values (Sizes, Colors, …) as chips → live-preview the
 * resulting Cartesian-product matrix with auto-generated SKUs → one
 * POST to /api/catalog/products/:parentId/bulk-variants creates them
 * all in a single transaction.
 *
 * Why theme-first: Amazon (and most channels) require the variation
 * theme up front to validate the children's attributes — the matrix's
 * axes are EXACTLY the theme.requiredAttributes. Picking the theme
 * first means every generated variant is automatically valid.
 *
 * Per-channel theme override stays the existing post-create flow on
 * Step 4 (selectedThemeByChannel) — this surface focuses on the
 * single most-common case: pick one theme, generate the matrix.
 *
 * Bulk paste: operators paste TSV/CSV from a spreadsheet
 * (Size\tColor\tSKU?\tPrice?\tStock?). The parser maps known column
 * headers to axes / overrides; rows beyond the recognised headers
 * are ignored. Empty SKUs fall back to the auto-generator.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  Clipboard,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

interface ThemeOption {
  id: string
  label: string
  requiredAttributes: string[]
}

interface VariationsPayload {
  parentSku: string
  parentName: string
  channels: Array<{ platform: string; marketplace: string; productType: string }>
  themesByChannel: Record<string, ThemeOption[]>
  commonThemes: ThemeOption[]
}

interface VariantRowOverrides {
  sku?: string
  price?: string
  stock?: string
}

interface BuiltVariant {
  optionValues: Record<string, string>
  sku: string
  name: string
  priceOverride?: number
  stockOverride?: number
}

const DEFAULT_SKU_PATTERN = '{parent}-{values}'

export default function MatrixVariantBuilder({
  payload,
  onCreated,
  wizardId,
}: {
  payload: VariationsPayload
  onCreated: () => void
  wizardId: string
}) {
  // ── Real-time Amazon variation themes ─────────────────────────
  // On mount, fetch fresh themes from SP-API (via the backend cache
  // layer) for the first Amazon channel's productType. This replaces
  // the schema-cache themes that may be stale or empty (bundled).
  const [liveThemes, setLiveThemes] = useState<ThemeOption[] | null>(null)
  const [liveLoading, setLiveLoading] = useState(false)

  const fetchLiveThemes = async () => {
    const amazonChannel = payload.channels.find((c) => c.platform === 'AMAZON')
    if (!amazonChannel?.productType || !amazonChannel.marketplace) return
    setLiveLoading(true)
    try {
      const url = new URL(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/variation-themes`,
      )
      url.searchParams.set('marketplace', amazonChannel.marketplace)
      url.searchParams.set('productType', amazonChannel.productType)
      const res = await fetch(url.toString())
      if (!res.ok) return
      const json = await res.json()
      if (Array.isArray(json?.themes) && json.themes.length > 0) {
        setLiveThemes(json.themes as ThemeOption[])
      }
    } catch {
      // Swallow — payload themes are the fallback.
    } finally {
      setLiveLoading(false)
    }
  }

  useEffect(() => {
    void fetchLiveThemes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId, payload.channels])

  // Merge live themes over the payload's theme list. Live themes win
  // when available; payload themes are the fallback for the duration
  // of the SP-API fetch.
  const effectivePayload: VariationsPayload = useMemo(() => {
    if (!liveThemes) return payload
    // Find the Amazon channel key to override themesByChannel.
    const amazonChannel = payload.channels.find((c) => c.platform === 'AMAZON')
    if (!amazonChannel) return { ...payload, commonThemes: liveThemes }
    const channelKey = `${amazonChannel.platform}:${amazonChannel.marketplace}`
    return {
      ...payload,
      commonThemes: liveThemes,
      themesByChannel: { ...payload.themesByChannel, [channelKey]: liveThemes },
    }
  }, [payload, liveThemes])

  // Default-pick the first common theme so the operator sees axis
  // inputs immediately rather than an empty form. Falls back to the
  // first per-channel theme when no common one exists.
  const initialThemeId =
    effectivePayload.commonThemes[0]?.id ??
    Object.values(effectivePayload.themesByChannel).flat()[0]?.id ??
    null

  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(
    initialThemeId,
  )
  const [axisValues, setAxisValues] = useState<Record<string, string[]>>({})
  const [axisDrafts, setAxisDrafts] = useState<Record<string, string>>({})
  const [skuPattern, setSkuPattern] = useState(DEFAULT_SKU_PATTERN)
  const [defaultPrice, setDefaultPrice] = useState('')
  const [defaultStock, setDefaultStock] = useState('0')
  const [overrides, setOverrides] = useState<Record<number, VariantRowOverrides>>(
    {},
  )
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allThemes = useMemo(() => {
    const seen = new Set<string>()
    const out: ThemeOption[] = []
    for (const t of effectivePayload.commonThemes) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
    for (const channelThemes of Object.values(effectivePayload.themesByChannel)) {
      for (const t of channelThemes) {
        if (seen.has(t.id)) continue
        seen.add(t.id)
        out.push(t)
      }
    }
    return out
  }, [effectivePayload])

  const selectedTheme = useMemo(
    () => allThemes.find((t) => t.id === selectedThemeId) ?? null,
    [allThemes, selectedThemeId],
  )

  // Cartesian product of every axis × every other axis. Empty when
  // any axis has no values (so the operator never submits a partial
  // matrix). Skipped axes (theme.requiredAttributes is empty) yield
  // a single "default" combo so simple themes still work.
  const variants: BuiltVariant[] = useMemo(() => {
    if (!selectedTheme) return []
    const attrs = selectedTheme.requiredAttributes
    if (attrs.length === 0) return []
    let combos: Record<string, string>[] = [{}]
    for (const attr of attrs) {
      const values = axisValues[attr] ?? []
      if (values.length === 0) return []
      const next: Record<string, string>[] = []
      for (const combo of combos) {
        for (const v of values) {
          next.push({ ...combo, [attr]: v })
        }
      }
      combos = next
    }
    return combos.map((optionValues, idx) => {
      const valuesPart = Object.values(optionValues)
        .map((v) => v.replace(/[^A-Za-z0-9]+/g, '').toUpperCase())
        .join('-')
      const autoSku = skuPattern
        .replace('{parent}', effectivePayload.parentSku)
        .replace('{values}', valuesPart)
      const ov = overrides[idx] ?? {}
      const overrideSku = ov.sku?.trim()
      const sku = overrideSku && overrideSku.length > 0 ? overrideSku : autoSku
      const name = `${effectivePayload.parentName} — ${Object.values(optionValues).join(' / ')}`
      const priceN = ov.price && ov.price.trim() ? Number(ov.price) : undefined
      const stockN = ov.stock && ov.stock.trim() ? Number(ov.stock) : undefined
      return {
        optionValues,
        sku,
        name,
        priceOverride: Number.isFinite(priceN as number) ? priceN : undefined,
        stockOverride: Number.isFinite(stockN as number) ? stockN : undefined,
      }
    })
  }, [selectedTheme, axisValues, skuPattern, effectivePayload.parentSku, effectivePayload.parentName, overrides])

  const skuConflicts = useMemo(() => {
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const v of variants) {
      if (seen.has(v.sku)) dupes.add(v.sku)
      else seen.add(v.sku)
    }
    return dupes
  }, [variants])

  const onAddAxisValue = (attr: string) => {
    const draft = (axisDrafts[attr] ?? '').trim()
    if (draft.length === 0) return
    // Split on common separators so paste of "Red, Blue, Green" or
    // "Red Blue Green" lands as three values rather than one.
    const parts = draft
      .split(/[,;\n\t]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (parts.length === 0) return
    setAxisValues((prev) => {
      const existing = prev[attr] ?? []
      const dedup = new Set(existing)
      for (const p of parts) dedup.add(p)
      return { ...prev, [attr]: Array.from(dedup) }
    })
    setAxisDrafts((prev) => ({ ...prev, [attr]: '' }))
  }

  const onRemoveAxisValue = (attr: string, value: string) => {
    setAxisValues((prev) => ({
      ...prev,
      [attr]: (prev[attr] ?? []).filter((v) => v !== value),
    }))
  }

  const onPasteParse = () => {
    if (pasteText.trim().length === 0) {
      setPasteOpen(false)
      return
    }
    if (!selectedTheme) return
    const attrs = selectedTheme.requiredAttributes
    const lines = pasteText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) return
    // Try to detect a header row by checking if the first cells
    // match known axis names (case-insensitive).
    const firstCells = lines[0].split(/\t|,/).map((c) => c.trim().toLowerCase())
    const attrLower = attrs.map((a) => a.toLowerCase())
    const isHeader = firstCells.some((c) => attrLower.includes(c))
    const dataLines = isHeader ? lines.slice(1) : lines
    const headerCells = isHeader ? firstCells : attrLower
    // Build per-axis sets from each row's value at the matching column.
    const collected: Record<string, Set<string>> = {}
    for (const attr of attrs) collected[attr] = new Set()
    for (const line of dataLines) {
      const cells = line.split(/\t|,/).map((c) => c.trim())
      for (let i = 0; i < headerCells.length; i += 1) {
        const matchIdx = attrLower.indexOf(headerCells[i])
        if (matchIdx === -1) continue
        const val = cells[i]
        if (val && val.length > 0) collected[attrs[matchIdx]].add(val)
      }
    }
    setAxisValues((prev) => {
      const next = { ...prev }
      for (const attr of attrs) {
        const incoming = Array.from(collected[attr])
        if (incoming.length > 0) {
          const existing = new Set(prev[attr] ?? [])
          for (const v of incoming) existing.add(v)
          next[attr] = Array.from(existing)
        }
      }
      return next
    })
    setPasteText('')
    setPasteOpen(false)
  }

  const handleSubmit = async () => {
    if (variants.length === 0) {
      setError('Add at least one value to every axis to generate variants.')
      return
    }
    if (skuConflicts.size > 0) {
      setError(
        `Duplicate SKUs in matrix: ${Array.from(skuConflicts).slice(0, 3).join(', ')}${
          skuConflicts.size > 3 ? '…' : ''
        }`,
      )
      return
    }
    const price = Number(defaultPrice)
    if (!Number.isFinite(price) || price <= 0) {
      setError('Default price is required and must be greater than 0.')
      return
    }
    const stock = Number(defaultStock)
    if (!Number.isFinite(stock) || stock < 0) {
      setError('Default stock must be a non-negative integer.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const productId = window.location.pathname.split('/')[2]
      if (!productId) {
        setError("Couldn't resolve product id from URL.")
        return
      }
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/products/${productId}/bulk-variants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variations: variants.map((v) => ({
              sku: v.sku,
              name: v.name,
              optionValues: v.optionValues,
              // LWV.2 — per-variant overrides flow through. The API
              // falls back to globalPrice/globalStock when these are
              // missing or invalid.
              price: v.priceOverride,
              stock: v.stockOverride,
            })),
            globalPrice: price,
            globalStock: stock,
          }),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.success === false) {
        setError(
          json?.error?.message ??
            json?.error ??
            `Couldn't create variants (HTTP ${res.status}).`,
        )
        return
      }
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (allThemes.length === 0 && !liveLoading) {
    return (
      <div className="border border-amber-200 dark:border-amber-900 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-5 py-4 text-base text-amber-900 dark:text-amber-200 inline-flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          No variation themes available for the channels you picked.
          Pick a product type in Step 2 first — themes come from the
          channel's category schema.
        </div>
      </div>
    )
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <div className="text-md font-medium text-slate-900 dark:text-slate-100">
            Matrix variant builder
          </div>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Pick a variation theme, list the axis values, and we generate
          every combination as a child SKU. Per-marketplace theme
          override happens after the matrix is created.
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Theme picker */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Variation theme
            </label>
            <button
              type="button"
              onClick={() => void fetchLiveThemes()}
              disabled={liveLoading}
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"
              title="Refresh themes from Amazon SP-API"
            >
              <RefreshCw className={cn('w-2.5 h-2.5', liveLoading && 'animate-spin')} />
              {liveLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <select
            value={selectedThemeId ?? ''}
            onChange={(e) => {
              setSelectedThemeId(e.target.value || null)
              // Clear axis values when theme changes — old axes may
              // not match the new theme's requiredAttributes.
              setAxisValues({})
              setAxisDrafts({})
              setOverrides({})
            }}
            className="w-full h-9 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900"
          >
            {allThemes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.requiredAttributes.length > 0
                  ? ` — ${t.requiredAttributes.join(' × ')}`
                  : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {liveLoading ? (
              <span className="inline-flex items-center gap-1">
                <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                Fetching live themes from Amazon…
              </span>
            ) : liveThemes ? (
              <span className="text-blue-600 dark:text-blue-400">
                Live from Amazon SP-API · {liveThemes.length} theme
                {liveThemes.length === 1 ? '' : 's'} available
              </span>
            ) : effectivePayload.commonThemes.find((t) => t.id === selectedThemeId) ? (
              'Common to every selected channel.'
            ) : (
              'Available on at least one of the selected channels.'
            )}
          </p>
        </div>

        {/* Axis inputs — one per required attribute */}
        {selectedTheme && selectedTheme.requiredAttributes.length > 0 && (
          <div className="space-y-3">
            {selectedTheme.requiredAttributes.map((attr) => {
              const values = axisValues[attr] ?? []
              return (
                <div key={attr}>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {attr}
                    <span className="ml-1 text-slate-400 dark:text-slate-500">
                      ({values.length})
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    {values.map((v) => (
                      <span
                        key={v}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200"
                      >
                        {v}
                        <button
                          type="button"
                          onClick={() => onRemoveAxisValue(attr, v)}
                          className="text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                          aria-label={`Remove ${v}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={axisDrafts[attr] ?? ''}
                      onChange={(e) =>
                        setAxisDrafts((prev) => ({
                          ...prev,
                          [attr]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          onAddAxisValue(attr)
                        }
                      }}
                      placeholder={`Add ${attr.toLowerCase()} (Enter, or comma-separated)`}
                      className="flex-1 h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => onAddAxisValue(attr)}
                      className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      Add
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Defaults */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Default price (€)
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={defaultPrice}
              onChange={(e) => setDefaultPrice(e.target.value)}
              placeholder="0.00"
              className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 tabular-nums"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Default stock
            </label>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              value={defaultStock}
              onChange={(e) => setDefaultStock(e.target.value)}
              className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 tabular-nums"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              SKU pattern
            </label>
            <input
              type="text"
              value={skuPattern}
              onChange={(e) => setSkuPattern(e.target.value)}
              placeholder="{parent}-{values}"
              className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 font-mono"
            />
          </div>
        </div>

        {/* Bulk paste */}
        <div>
          <button
            type="button"
            onClick={() => setPasteOpen((v) => !v)}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
          >
            <Clipboard className="w-3 h-3" />
            {pasteOpen ? 'Hide bulk paste' : 'Bulk paste from spreadsheet…'}
          </button>
          {pasteOpen && (
            <div className="mt-2 space-y-2">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={5}
                placeholder={
                  selectedTheme?.requiredAttributes
                    ? `${selectedTheme.requiredAttributes.join('\t')}\nS\tRed\nM\tBlack\n…`
                    : 'Paste TSV/CSV here'
                }
                className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 font-mono"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Header row optional. Recognised columns map to the
                theme's axes; unknown columns are ignored.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={onPasteParse}>
                  Parse + add
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setPasteText('')
                    setPasteOpen(false)
                  }}
                  className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live matrix preview */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Preview
              <span className="ml-1 text-slate-400 dark:text-slate-500">
                ({variants.length} variant{variants.length === 1 ? '' : 's'}
                {skuConflicts.size > 0 ? `, ${skuConflicts.size} SKU conflicts` : ''})
              </span>
            </div>
            {variants.length > 0 && (
              <button
                type="button"
                onClick={() => setOverrides({})}
                className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                Clear overrides
              </button>
            )}
          </div>
          {variants.length === 0 ? (
            <div className="text-center py-6 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg text-base text-slate-500 dark:text-slate-400">
              {selectedTheme && selectedTheme.requiredAttributes.length > 0
                ? 'Add at least one value to every axis to generate variants.'
                : 'Pick a theme with variation axes to generate the matrix.'}
            </div>
          ) : (
            <div className="border border-slate-200 dark:border-slate-700 rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800">
                  <tr>
                    {selectedTheme?.requiredAttributes.map((attr) => (
                      <th
                        key={attr}
                        className="px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400"
                      >
                        {attr}
                      </th>
                    ))}
                    <th className="px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                      SKU
                    </th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 w-24">
                      Price (€)
                    </th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 w-20">
                      Stock
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {variants.map((v, idx) => {
                    const isDup = skuConflicts.has(v.sku)
                    const ov = overrides[idx] ?? {}
                    return (
                      <tr key={idx} className={isDup ? 'bg-rose-50/50 dark:bg-rose-950/20' : ''}>
                        {selectedTheme?.requiredAttributes.map((attr) => (
                          <td
                            key={attr}
                            className="px-2 py-1 text-slate-700 dark:text-slate-300"
                          >
                            {v.optionValues[attr]}
                          </td>
                        ))}
                        <td className="px-2 py-1">
                          <input
                            type="text"
                            value={ov.sku ?? v.sku}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [idx]: { ...(prev[idx] ?? {}), sku: e.target.value },
                              }))
                            }
                            className={cn(
                              'w-full h-7 px-1.5 text-sm border rounded-md font-mono bg-white dark:bg-slate-900',
                              isDup
                                ? 'border-rose-400 dark:border-rose-700'
                                : 'border-slate-200 dark:border-slate-700',
                            )}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            value={ov.price ?? ''}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [idx]: { ...(prev[idx] ?? {}), price: e.target.value },
                              }))
                            }
                            placeholder={defaultPrice || '0.00'}
                            className="w-full h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 tabular-nums text-right"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            inputMode="numeric"
                            step="1"
                            min="0"
                            value={ov.stock ?? ''}
                            onChange={(e) =>
                              setOverrides((prev) => ({
                                ...prev,
                                [idx]: { ...(prev[idx] ?? {}), stock: e.target.value },
                              }))
                            }
                            placeholder={defaultStock || '0'}
                            className="w-full h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 tabular-nums text-right"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="text-xs text-slate-500 dark:text-slate-400 px-2 py-1.5 border-t border-slate-100 dark:border-slate-800">
                Empty cells fall back to the defaults above. Per-variant
                price / stock are applied at create time — the edit page
                handles further per-listing overrides.
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md text-sm text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={
              variants.length === 0 ||
              skuConflicts.size > 0 ||
              submitting
            }
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            Promote &amp; create {variants.length} variant
            {variants.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  )
}
