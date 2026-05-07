'use client'

// C.21 — multi-channel AI listing-content generator.
//
// Replaces the eBay-DraftListing-hardcoded surface with a flow that
// reads from the modern listing-content service (per-field generation,
// per-marketplace prompts, provider switching, terminology injection,
// cost tracking).
//
// Page-level config: channel (Amazon / eBay / Shopify per active scope),
// marketplace (per-channel list), provider (auto / Gemini / Claude),
// fields (title / bullets / description / keywords). Picks persist to
// localStorage so the operator's last setup carries across sessions.
//
// Per-product flow: search the catalog, hit Generate on a row, see the
// generated content + cost inline. Results are ephemeral — copy them
// out, paste into the listing wizard or product editor. The save-as-
// draft + publish-to-channel flows live elsewhere (per-channel adapters
// gated behind NEXUS_ENABLE_<CH>_PUBLISH from C.6/C.7).

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
    { id: 'IT', label: 'Italy (IT)' },
    { id: 'DE', label: 'Germany (DE)' },
    { id: 'FR', label: 'France (FR)' },
    { id: 'ES', label: 'Spain (ES)' },
    { id: 'UK', label: 'United Kingdom (UK)' },
  ],
  EBAY: [
    { id: 'EBAY_IT', label: 'Italy (EBAY_IT)' },
    { id: 'EBAY_DE', label: 'Germany (EBAY_DE)' },
    { id: 'EBAY_ES', label: 'Spain (EBAY_ES)' },
    { id: 'EBAY_FR', label: 'France (EBAY_FR)' },
    { id: 'EBAY_GB', label: 'United Kingdom (EBAY_GB)' },
  ],
  SHOPIFY: [{ id: 'GLOBAL', label: 'Shop (GLOBAL)' }],
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

const STORAGE_KEY = 'listings.generate.config.v2'

interface SavedConfig {
  channel?: Channel
  marketplace?: string
  provider?: string
  fields?: Field[]
}

function loadConfig(): SavedConfig {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SavedConfig) : {}
  } catch {
    return {}
  }
}

export default function GeneratorPage() {
  const { toast } = useToast()
  const [products, setProducts] = useState<Product[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  // Page-level config — persisted across sessions.
  const [channel, setChannel] = useState<Channel>('AMAZON')
  const [marketplace, setMarketplace] = useState<string>('IT')
  const [provider, setProvider] = useState<string>('')
  const [fields, setFields] = useState<Field[]>(['title', 'bullets', 'description'])

  // Hydrate from localStorage on mount.
  useEffect(() => {
    const saved = loadConfig()
    if (saved.channel && saved.channel in MARKETPLACE_OPTIONS) {
      setChannel(saved.channel)
    }
    if (saved.marketplace) setMarketplace(saved.marketplace)
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
        JSON.stringify({ channel, marketplace, provider, fields }),
      )
    } catch {
      /* swallow — quota / privacy mode */
    }
  }, [channel, marketplace, provider, fields])

  // When channel changes, snap marketplace to the first valid option
  // for that channel — prevents an "Italy (IT)" picked under Amazon
  // sticking when the operator switches to eBay (where the value is
  // "EBAY_IT" not "IT").
  useEffect(() => {
    const opts = MARKETPLACE_OPTIONS[channel]
    if (!opts.some((o) => o.id === marketplace)) {
      setMarketplace(opts[0].id)
    }
  }, [channel, marketplace])

  // ── Per-product generation state ────────────────────────────────
  const [resultByProduct, setResultByProduct] = useState<
    Record<string, { loading: boolean; result?: GenerationResult; error?: string; expanded?: boolean }>
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

  const generate = useCallback(
    async (productId: string) => {
      if (fields.length === 0) {
        toast.error('Pick at least one field to generate')
        return
      }
      setResultByProduct((prev) => ({
        ...prev,
        [productId]: { loading: true, expanded: true },
      }))
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-content/generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              productId,
              marketplace,
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
        const data = (await res.json()) as GenerationResult
        setResultByProduct((prev) => ({
          ...prev,
          [productId]: { loading: false, result: data, expanded: true },
        }))
      } catch (e: any) {
        setResultByProduct((prev) => ({
          ...prev,
          [productId]: { loading: false, error: e?.message ?? String(e), expanded: true },
        }))
        toast.error(e?.message ?? 'Generation failed')
      }
    },
    [fields, marketplace, provider, toast],
  )

  const toggleField = (f: Field) => {
    setFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    )
  }

  const totalCost = useMemo(() => {
    let sum = 0
    for (const v of Object.values(resultByProduct)) {
      if (v.result) {
        for (const u of v.result.usage) sum += u.costUSD
      }
    }
    return sum
  }, [resultByProduct])

  const generationCount = useMemo(
    () =>
      Object.values(resultByProduct).filter((v) => v.result).length,
    [resultByProduct],
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI listing content"
        description="Generate per-channel, per-marketplace listing copy with provider switching + cost tracking. Ephemeral — copy results out and paste into the listing wizard or product editor."
        breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'AI generate' }]}
      />

      {/* Config panel */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Channel
            </label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
              className="w-full h-9 px-2 text-md border border-slate-200 rounded"
            >
              <option value="AMAZON">Amazon</option>
              <option value="EBAY">eBay</option>
              <option value="SHOPIFY">Shopify</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Marketplace
            </label>
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              className="w-full h-9 px-2 text-md border border-slate-200 rounded"
            >
              {MARKETPLACE_OPTIONS[channel].map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full h-9 px-2 text-md border border-slate-200 rounded"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Fields
            </label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {FIELD_OPTIONS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => toggleField(f.id)}
                  className={`h-7 px-2 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    fields.includes(f.id)
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
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
      </Card>

      {/* Search + cost rollup */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="text-slate-400" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search SKU or name…"
          />
        </div>
        {generationCount > 0 && (
          <div className="text-sm text-slate-500 ml-auto inline-flex items-center gap-3">
            <span>
              <span className="font-semibold text-slate-700 tabular-nums">
                {generationCount}
              </span>{' '}
              generated
            </span>
            <span className="text-slate-300">·</span>
            <span>
              Total cost{' '}
              <span className="font-semibold text-slate-700 tabular-nums">
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
          <div className="text-center py-8 text-sm text-slate-500">
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
                onGenerate={() => generate(p.id)}
                onToggle={() =>
                  setResultByProduct((prev) => ({
                    ...prev,
                    [p.id]: { ...prev[p.id], expanded: !prev[p.id]?.expanded },
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
// ProductRow — collapsed by default; expands inline with results.
// ────────────────────────────────────────────────────────────────────
function ProductRow({
  product,
  state,
  onGenerate,
  onToggle,
}: {
  product: Product
  state?: { loading: boolean; result?: GenerationResult; error?: string; expanded?: boolean }
  onGenerate: () => void
  onToggle: () => void
}) {
  const expanded = state?.expanded ?? false
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-900 truncate">
            {product.name}
          </div>
          <div className="text-sm text-slate-500 font-mono">{product.sku}</div>
        </div>
        <div className="flex items-center gap-2">
          {state?.result && (
            <button
              onClick={onToggle}
              aria-label={expanded ? 'Collapse result' : 'Expand result'}
              className="h-8 w-8 inline-flex items-center justify-center text-slate-400 hover:text-slate-700"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          <button
            onClick={onGenerate}
            disabled={state?.loading}
            aria-label={
              state?.loading
                ? `Generating content for ${product.sku}`
                : state?.result
                  ? `Regenerate content for ${product.sku}`
                  : `Generate AI content for ${product.sku}`
            }
            className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60 inline-flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            {state?.loading ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Generating
              </>
            ) : state?.result ? (
              <>
                <Sparkles size={12} /> Regenerate
              </>
            ) : (
              <>
                <Zap size={12} /> Generate
              </>
            )}
          </button>
        </div>
      </div>
      {expanded && state && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {state.loading && (
            <div className="text-sm text-slate-500 inline-flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Generating with the
              configured provider…
            </div>
          )}
          {state.error && (
            <div className="text-sm text-rose-700 inline-flex items-center gap-2">
              <AlertCircle size={12} /> {state.error}
            </div>
          )}
          {state.result && <GenerationResultView result={state.result} />}
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
      <div className="text-xs text-slate-500 inline-flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1 text-emerald-700">
          <CheckCircle2 size={11} /> {result.metadata.provider} ·{' '}
          {result.metadata.model}
        </span>
        <span className="text-slate-300">·</span>
        <span className="tabular-nums">
          ${totalCost.toFixed(4)} · {totalTokens.toLocaleString()} tokens
        </span>
        <span className="text-slate-300">·</span>
        <span className="tabular-nums">
          {result.metadata.elapsedMs} ms
        </span>
        <span className="text-slate-300">·</span>
        <span>{result.metadata.marketplace}</span>
      </div>

      {result.title && (
        <FieldBlock
          label="Title"
          subtitle={`${result.title.charCount} chars`}
          onCopy={() => copyToClipboard('Title', result.title!.content)}
        >
          <div className="text-sm text-slate-800">{result.title.content}</div>
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
          <ul className="text-sm text-slate-800 list-disc pl-5 space-y-0.5">
            {result.bullets.content.map((b, i) => (
              <li key={i}>
                {b}
                <span className="text-xs text-slate-400 ml-2 tabular-nums">
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
          <div className="text-sm text-slate-800 whitespace-pre-wrap">
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
          <div className="text-sm text-slate-800 font-mono">
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
    <div className="border border-slate-200 rounded p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="inline-flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {label}
          </div>
          {subtitle && (
            <div className="text-xs text-slate-400">{subtitle}</div>
          )}
        </div>
        <button
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-blue-600 rounded"
        >
          <Copy size={11} />
        </button>
      </div>
      {children}
    </div>
  )
}
