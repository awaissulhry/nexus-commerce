'use client'

// M.1 — multi-marketplace AI listing-content generator.
//
// Replaces single-marketplace flow with one-pass fan-out across the
// operator's selected marketplaces. Each marketplace gets its own
// LLM call (terminology block + language differ per marketplace), but
// all of them fire from one Generate click — eliminates the "had to
// do separately" friction (TECH_DEBT #28).
//
// Page-level config: channel (Amazon / eBay / Shopify per active scope),
// marketplaces (multi-select chips, ≥1 required), provider, fields.
// Picks persist to localStorage.
//
// Per-product flow: search the catalog, hit Generate on a row, see N
// per-marketplace result tabs inline. Results are ephemeral — copy out,
// paste into the listing wizard or product editor. The save-as-draft +
// publish-to-channel flows live elsewhere (per-channel adapters gated
// behind NEXUS_ENABLE_<CH>_PUBLISH from C.6/C.7).

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Zap,
  Search,
  Sparkles,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface Product {
  id: string
  sku: string
  name: string
  basePrice: number
  totalStock: number
  brand?: string | null
  images?: Array<{ url: string }>
}

type Field = 'title' | 'bullets' | 'description' | 'keywords'
type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  costUSD: number
  model: string
  provider: string
}

interface GenerationResult {
  title?: { content: string; charCount: number; insights: string[] }
  bullets?: { content: string[]; charCounts: number[]; insights: string[] }
  description?: { content: string; preview: string; insights: string[] }
  keywords?: { content: string; charCount: number; insights: string[] }
  usage: ProviderUsage[]
  metadata: {
    productSku: string
    marketplace: string
    language: string
    model: string
    provider: string
    elapsedMs: number
    generatedAt: string
  }
}

// Active channel scope per project memory: Amazon + eBay + Shopify.
// Marketplace lists per channel — Amazon/eBay both seed the EU 5
// markets used by Xavia; Shopify is single-shop so just the global
// option (locale tag drives prompt language).
const MARKETPLACE_OPTIONS: Record<Channel, Array<{ id: string; label: string }>> = {
  AMAZON: [
    { id: 'IT', label: 'Italy' },
    { id: 'DE', label: 'Germany' },
    { id: 'FR', label: 'France' },
    { id: 'ES', label: 'Spain' },
    { id: 'UK', label: 'United Kingdom' },
  ],
  EBAY: [
    { id: 'EBAY_IT', label: 'Italy' },
    { id: 'EBAY_DE', label: 'Germany' },
    { id: 'EBAY_ES', label: 'Spain' },
    { id: 'EBAY_FR', label: 'France' },
    { id: 'EBAY_GB', label: 'United Kingdom' },
  ],
  SHOPIFY: [{ id: 'GLOBAL', label: 'Shop' }],
}

const PROVIDER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Auto (env default)' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', label: 'Anthropic Claude' },
]

const FIELD_OPTIONS: Array<{ id: Field; label: string }> = [
  { id: 'title', label: 'Title' },
  { id: 'bullets', label: 'Bullets' },
  { id: 'description', label: 'Description' },
  { id: 'keywords', label: 'Keywords' },
]

const STORAGE_KEY = 'listings.generate.config.v3'
const STORAGE_KEY_LEGACY = 'listings.generate.config.v2'

interface SavedConfig {
  channel?: Channel
  marketplaces?: string[]
  provider?: string
  fields?: Field[]
}

function loadConfig(): SavedConfig {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as SavedConfig
    // Backwards-compat: v2 stored a single `marketplace` string.
    const legacy = window.localStorage.getItem(STORAGE_KEY_LEGACY)
    if (legacy) {
      const parsed = JSON.parse(legacy) as { marketplace?: string } & SavedConfig
      const upgraded: SavedConfig = {
        channel: parsed.channel,
        marketplaces: parsed.marketplace ? [parsed.marketplace] : undefined,
        provider: parsed.provider,
        fields: parsed.fields,
      }
      return upgraded
    }
    return {}
  } catch {
    return {}
  }
}

// One product × one marketplace generation slice.
type MarketplaceState = {
  loading: boolean
  result?: GenerationResult
  error?: string
}

// One product, expanded inline with N marketplace tabs.
type ProductState = {
  expanded?: boolean
  /** Active marketplace tab. Defaults to first selected marketplace. */
  activeTab?: string
  byMarketplace: Record<string, MarketplaceState>
}

export default function GeneratorPage() {
  const { toast } = useToast()
  const [products, setProducts] = useState<Product[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  // Page-level config — persisted across sessions.
  const [channel, setChannel] = useState<Channel>('AMAZON')
  const [marketplaces, setMarketplaces] = useState<string[]>(['IT'])
  const [provider, setProvider] = useState<string>('')
  const [fields, setFields] = useState<Field[]>(['title', 'bullets', 'description'])

  // Hydrate from localStorage on mount.
  useEffect(() => {
    const saved = loadConfig()
    if (saved.channel && saved.channel in MARKETPLACE_OPTIONS) {
      setChannel(saved.channel)
    }
    if (Array.isArray(saved.marketplaces) && saved.marketplaces.length > 0) {
      setMarketplaces(saved.marketplaces)
    }
    if (typeof saved.provider === 'string') setProvider(saved.provider)
    if (Array.isArray(saved.fields) && saved.fields.length > 0) {
      setFields(saved.fields as Field[])
    }
  }, [])

  // Persist on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ channel, marketplaces, provider, fields }),
      )
    } catch {
      /* swallow — quota / privacy mode */
    }
  }, [channel, marketplaces, provider, fields])

  // When channel changes, drop marketplaces that don't belong to the
  // new channel's option set. Prevents an "IT" picked under Amazon
  // sticking when the operator switches to eBay (where the value is
  // "EBAY_IT" not "IT").
  useEffect(() => {
    const valid = new Set(MARKETPLACE_OPTIONS[channel].map((o) => o.id))
    const filtered = marketplaces.filter((m) => valid.has(m))
    if (filtered.length === 0) {
      setMarketplaces([MARKETPLACE_OPTIONS[channel][0].id])
    } else if (filtered.length !== marketplaces.length) {
      setMarketplaces(filtered)
    }
  }, [channel, marketplaces])

  // ── Per-product per-marketplace generation state ────────────────
  const [resultByProduct, setResultByProduct] = useState<
    Record<string, ProductState>
  >({})

  useEffect(() => {
    let cancelled = false
    const fetchProducts = async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/products?limit=200`)
        const data = await res.json()
        const list = Array.isArray(data) ? data : (data.products ?? [])
        if (!cancelled) setProducts(list)
      } catch (err) {
        if (!cancelled) toast.error('Failed to load products')
      } finally {
        if (!cancelled) setProductsLoading(false)
      }
    }
    fetchProducts()
    return () => {
      cancelled = true
    }
  }, [toast])

  const filteredProducts = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.sku.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
    )
  }, [products, searchTerm])

  const generateOne = useCallback(
    async (productId: string, mp: string) => {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-content/generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId,
            marketplace: mp,
            fields,
            variant: 0,
            provider: provider || undefined,
          }),
        },
      )
      if (res.status === 503) {
        const j = await res.json().catch(() => ({}))
        throw new Error(
          j.error ??
            'AI provider not configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY on the API.',
        )
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      return (await res.json()) as GenerationResult
    },
    [fields, provider],
  )

  const generate = useCallback(
    async (productId: string) => {
      if (fields.length === 0) {
        toast.error('Pick at least one field to generate')
        return
      }
      if (marketplaces.length === 0) {
        toast.error('Pick at least one marketplace')
        return
      }
      // Initialise loading=true for every selected marketplace, set
      // active tab to the first one.
      setResultByProduct((prev) => {
        const next: ProductState = {
          expanded: true,
          activeTab: marketplaces[0],
          byMarketplace: { ...(prev[productId]?.byMarketplace ?? {}) },
        }
        for (const mp of marketplaces) {
          next.byMarketplace[mp] = { loading: true }
        }
        return { ...prev, [productId]: next }
      })

      // Fan out one fetch per marketplace, in parallel. The backend's
      // listing-content.service.ts already runs the field tasks in
      // parallel for one call, so this gives us full marketplace ×
      // field parallelism. Each marketplace is allowed to fail
      // independently so a 429 on one doesn't poison the others.
      await Promise.all(
        marketplaces.map(async (mp) => {
          try {
            const r = await generateOne(productId, mp)
            setResultByProduct((prev) => ({
              ...prev,
              [productId]: {
                ...(prev[productId] ?? { byMarketplace: {} }),
                byMarketplace: {
                  ...(prev[productId]?.byMarketplace ?? {}),
                  [mp]: { loading: false, result: r },
                },
              },
            }))
          } catch (e: any) {
            setResultByProduct((prev) => ({
              ...prev,
              [productId]: {
                ...(prev[productId] ?? { byMarketplace: {} }),
                byMarketplace: {
                  ...(prev[productId]?.byMarketplace ?? {}),
                  [mp]: { loading: false, error: e?.message ?? String(e) },
                },
              },
            }))
            toast.error(`${mp}: ${e?.message ?? 'Generation failed'}`)
          }
        }),
      )
    },
    [fields, marketplaces, generateOne, toast],
  )

  const toggleField = (f: Field) => {
    setFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    )
  }

  const toggleMarketplace = (id: string) => {
    setMarketplaces((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const selectAllMarketplaces = () => {
    setMarketplaces(MARKETPLACE_OPTIONS[channel].map((o) => o.id))
  }

  // Cost rollup: sum across every product × marketplace result.
  const totalCost = useMemo(() => {
    let sum = 0
    for (const ps of Object.values(resultByProduct)) {
      for (const ms of Object.values(ps.byMarketplace)) {
        if (ms.result) {
          for (const u of ms.result.usage) sum += u.costUSD
        }
      }
    }
    return sum
  }, [resultByProduct])

  // Generation count = total successful (product × marketplace) pairs.
  const generationCount = useMemo(() => {
    let n = 0
    for (const ps of Object.values(resultByProduct)) {
      for (const ms of Object.values(ps.byMarketplace)) {
        if (ms.result) n++
      }
    }
    return n
  }, [resultByProduct])

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI listing content"
        description="Generate per-channel, per-marketplace listing copy. Fan out to multiple marketplaces in one pass — terminology + language adapt per marketplace. Ephemeral — copy results out and paste into the listing wizard or product editor."
        breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'AI generate' }]}
      />

      {/* Config panel */}
      <Card>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                Channel
              </label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as Channel)}
                className="w-full h-9 px-2 text-md border border-slate-200 dark:border-slate-700 rounded"
              >
                <option value="AMAZON">Amazon</option>
                <option value="EBAY">eBay</option>
                <option value="SHOPIFY">Shopify</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                Provider
              </label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full h-9 px-2 text-md border border-slate-200 dark:border-slate-700 rounded"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                Fields
              </label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {FIELD_OPTIONS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => toggleField(f.id)}
                    className={`h-7 px-2 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                      fields.includes(f.id)
                        ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 text-blue-700 dark:text-blue-300'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                    aria-pressed={fields.includes(f.id)}
                    aria-label={`Toggle ${f.label} field`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Marketplaces
                {marketplaces.length > 1 && (
                  <span className="ml-2 text-xs font-normal normal-case text-blue-600 dark:text-blue-400">
                    {marketplaces.length} selected — one Generate click fans out to all
                  </span>
                )}
              </label>
              {MARKETPLACE_OPTIONS[channel].length > 1 && (
                <button
                  onClick={selectAllMarketplaces}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 font-medium"
                >
                  Select all
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {MARKETPLACE_OPTIONS[channel].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => toggleMarketplace(opt.id)}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    marketplaces.includes(opt.id)
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 text-blue-700 dark:text-blue-300'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                  aria-pressed={marketplaces.includes(opt.id)}
                  aria-label={`Toggle ${opt.label} marketplace`}
                >
                  {opt.label}{' '}
                  <span className="text-xs text-slate-400 dark:text-slate-500 ml-0.5 font-mono">
                    {opt.id}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Search + cost rollup */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="text-slate-400 dark:text-slate-500" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search SKU or name…"
          />
        </div>
        {generationCount > 0 && (
          <div className="text-sm text-slate-500 dark:text-slate-400 ml-auto inline-flex items-center gap-3">
            <span>
              <span className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                {generationCount}
              </span>{' '}
              generated
            </span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span>
              Total cost{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                ${totalCost.toFixed(4)}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Product list */}
      {productsLoading ? (
        <Card>
          <Skeleton variant="text" lines={4} />
        </Card>
      ) : filteredProducts.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
            {searchTerm ? 'No products match the search.' : 'No products available.'}
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredProducts.map((p) => {
            const state = resultByProduct[p.id]
            return (
              <ProductRow
                key={p.id}
                product={p}
                state={state}
                marketplaces={marketplaces}
                onGenerate={() => generate(p.id)}
                onToggle={() =>
                  setResultByProduct((prev) => ({
                    ...prev,
                    [p.id]: {
                      ...(prev[p.id] ?? { byMarketplace: {} }),
                      expanded: !prev[p.id]?.expanded,
                    },
                  }))
                }
                onSelectTab={(mp) =>
                  setResultByProduct((prev) => ({
                    ...prev,
                    [p.id]: {
                      ...(prev[p.id] ?? { byMarketplace: {} }),
                      activeTab: mp,
                    },
                  }))
                }
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// ProductRow — collapsed by default; expanded reveals N marketplace tabs.
// ────────────────────────────────────────────────────────────────────
function ProductRow({
  product,
  state,
  marketplaces,
  onGenerate,
  onToggle,
  onSelectTab,
}: {
  product: Product
  state?: ProductState
  marketplaces: string[]
  onGenerate: () => void
  onToggle: () => void
  onSelectTab: (mp: string) => void
}) {
  const expanded = state?.expanded ?? false
  // Are any marketplaces still loading for this product?
  const anyLoading = state
    ? Object.values(state.byMarketplace).some((m) => m.loading)
    : false
  // Has any marketplace produced a result?
  const anyResult = state
    ? Object.values(state.byMarketplace).some((m) => m.result)
    : false
  const activeTab =
    state?.activeTab && state.byMarketplace[state.activeTab]
      ? state.activeTab
      : Object.keys(state?.byMarketplace ?? {})[0]
  const activeSlice = activeTab ? state?.byMarketplace[activeTab] : undefined

  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
            {product.name}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">{product.sku}</div>
        </div>
        <div className="flex items-center gap-2">
          {anyResult && (
            <button
              onClick={onToggle}
              aria-label={expanded ? 'Collapse result' : 'Expand result'}
              className="h-8 w-8 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          <button
            onClick={onGenerate}
            disabled={anyLoading}
            aria-label={
              anyLoading
                ? `Generating content for ${product.sku}`
                : anyResult
                  ? `Regenerate content for ${product.sku}`
                  : `Generate AI content for ${product.sku}`
            }
            className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-60 inline-flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            {anyLoading ? (
              <>
                <Loader2 size={12} className="animate-spin" />{' '}
                {marketplaces.length > 1
                  ? `Generating × ${marketplaces.length}`
                  : 'Generating'}
              </>
            ) : anyResult ? (
              <>
                <Sparkles size={12} /> Regenerate
                {marketplaces.length > 1 && (
                  <span className="text-xs opacity-90">× {marketplaces.length}</span>
                )}
              </>
            ) : (
              <>
                <Zap size={12} /> Generate
                {marketplaces.length > 1 && (
                  <span className="text-xs opacity-90">× {marketplaces.length}</span>
                )}
              </>
            )}
          </button>
        </div>
      </div>
      {expanded && state && (
        <div className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3">
          {/* Marketplace tabs */}
          {Object.keys(state.byMarketplace).length > 1 && (
            <div className="flex items-center gap-1 mb-3 flex-wrap">
              {Object.entries(state.byMarketplace).map(([mp, slice]) => {
                const tone = slice.error
                  ? 'border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300'
                  : slice.loading
                    ? 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                    : 'border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
                const isActive = mp === activeTab
                return (
                  <button
                    key={mp}
                    onClick={() => onSelectTab(mp)}
                    className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 inline-flex items-center gap-1.5 ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-800 font-semibold'
                        : `bg-white dark:bg-slate-900 ${tone} hover:bg-slate-50 dark:hover:bg-slate-800`
                    }`}
                    aria-pressed={isActive}
                  >
                    {slice.loading ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : slice.error ? (
                      <AlertCircle size={10} />
                    ) : (
                      <CheckCircle2 size={10} />
                    )}
                    <span className="font-mono text-xs">{mp}</span>
                  </button>
                )
              })}
            </div>
          )}
          {/* Active tab content */}
          {activeSlice && (
            <>
              {activeSlice.loading && (
                <div className="text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" /> Generating with the
                  configured provider…
                </div>
              )}
              {activeSlice.error && (
                <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-2">
                  <AlertCircle size={12} /> {activeSlice.error}
                </div>
              )}
              {activeSlice.result && (
                <GenerationResultView result={activeSlice.result} />
              )}
            </>
          )}
        </div>
      )}
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────
// GenerationResultView — title / bullets / description / keywords +
// per-field copy buttons + cost summary.
// ────────────────────────────────────────────────────────────────────
function GenerationResultView({ result }: { result: GenerationResult }) {
  const { toast } = useToast()
  const copyToClipboard = (label: string, text: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      toast.error('Clipboard unavailable')
      return
    }
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${label} copied`))
      .catch(() => toast.error('Copy failed'))
  }

  const totalCost = result.usage.reduce((acc, u) => acc + u.costUSD, 0)
  const totalTokens = result.usage.reduce(
    (acc, u) => acc + u.inputTokens + u.outputTokens,
    0,
  )

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={11} /> {result.metadata.provider} ·{' '}
          {result.metadata.model}
        </span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span className="tabular-nums">
          ${totalCost.toFixed(4)} · {totalTokens.toLocaleString()} tokens
        </span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span className="tabular-nums">
          {result.metadata.elapsedMs} ms
        </span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span>{result.metadata.marketplace}</span>
      </div>

      {result.title && (
        <FieldBlock
          label="Title"
          subtitle={`${result.title.charCount} chars`}
          onCopy={() => copyToClipboard('Title', result.title!.content)}
        >
          <div className="text-sm text-slate-800 dark:text-slate-200">{result.title.content}</div>
        </FieldBlock>
      )}

      {result.bullets && (
        <FieldBlock
          label="Bullets"
          subtitle={`${result.bullets.content.length} bullets`}
          onCopy={() =>
            copyToClipboard('Bullets', result.bullets!.content.join('\n'))
          }
        >
          <ul className="text-sm text-slate-800 dark:text-slate-200 list-disc pl-5 space-y-0.5">
            {result.bullets.content.map((b, i) => (
              <li key={i}>
                {b}
                <span className="text-xs text-slate-400 dark:text-slate-500 ml-2 tabular-nums">
                  ({result.bullets!.charCounts[i]})
                </span>
              </li>
            ))}
          </ul>
        </FieldBlock>
      )}

      {result.description && (
        <FieldBlock
          label="Description"
          subtitle={`${result.description.content.length} chars`}
          onCopy={() => copyToClipboard('Description', result.description!.content)}
        >
          <div className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
            {result.description.preview}
          </div>
        </FieldBlock>
      )}

      {result.keywords && (
        <FieldBlock
          label="Keywords"
          subtitle={`${result.keywords.charCount} chars`}
          onCopy={() => copyToClipboard('Keywords', result.keywords!.content)}
        >
          <div className="text-sm text-slate-800 dark:text-slate-200 font-mono">
            {result.keywords.content}
          </div>
        </FieldBlock>
      )}
    </div>
  )
}

function FieldBlock({
  label,
  subtitle,
  onCopy,
  children,
}: {
  label: string
  subtitle?: string
  onCopy: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="inline-flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {label}
          </div>
          {subtitle && (
            <div className="text-xs text-slate-400 dark:text-slate-500">{subtitle}</div>
          )}
        </div>
        <button
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="h-6 w-6 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-blue-600 rounded"
        >
          <Copy size={11} />
        </button>
      </div>
      {children}
    </div>
  )
}
