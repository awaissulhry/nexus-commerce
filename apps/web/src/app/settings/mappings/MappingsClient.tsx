'use client'

/**
 * PIM D.2 — Mappings editor client.
 *
 * Two panes: marketplace picker on left (small list with field/mapped
 * counts), field editor on right. Selecting a marketplace fetches its
 * full field set + current rules and renders one FieldRuleRow per
 * field. Saves go through PUT /api/pim/mappings/:channel/:code/:fk,
 * deletes through DELETE.
 *
 * D.4 will replace the flat list with a drag-drop canvas (left:
 * external schema, right: internal variables). D.1 will add a
 * "Sync from <channel>" button that fetches live schema definitions.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  AlertCircle,
  Globe,
  Search,
  RefreshCw,
  Settings as SettingsIcon,
  Download,
  PlayCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils'
import FieldRuleRow, {
  type FieldRow,
  type FieldMappingRule,
} from './_shared/FieldRuleRow'

interface MarketplaceRow {
  channel: string
  code: string
  name: string
  currency: string
  language: string
  fieldCount: number
  mappedCount: number
}

interface MarketplaceView {
  channel: string
  code: string
  version: number
  lastSyncedAt: string | null
  schemaSnapshotVersion: string | null
  fields: FieldRow[]
}

export default function MappingsClient() {
  const { toast } = useToast()
  const [marketplaces, setMarketplaces] = useState<MarketplaceRow[]>([])
  const [marketplacesLoading, setMarketplacesLoading] = useState(true)
  const [marketplacesError, setMarketplacesError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<{ channel: string; code: string } | null>(null)
  const [view, setView] = useState<MarketplaceView | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  // D.5 — validate-against-product state
  const [validateProductId, setValidateProductId] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    productId: string
    productSku: string
    totalFields: number
    requiredFields: number
    ok: boolean
    errors: Array<{
      fieldKey: string
      code: string
      message: string
    }>
  } | null>(null)

  // ── Load marketplaces ───────────────────────────────────────────
  const fetchMarketplaces = useCallback(async () => {
    setMarketplacesLoading(true)
    setMarketplacesError(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/pim/mappings/marketplaces`, {
        cache: 'no-store',
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = (await r.json()) as { marketplaces: MarketplaceRow[] }
      setMarketplaces(d.marketplaces)
      // Auto-select first marketplace when none active yet.
      if (!active && d.marketplaces.length > 0) {
        setActive({ channel: d.marketplaces[0].channel, code: d.marketplaces[0].code })
      }
    } catch (e: any) {
      setMarketplacesError(e?.message ?? 'Failed to load marketplaces')
    } finally {
      setMarketplacesLoading(false)
    }
  }, [active])

  useEffect(() => {
    void fetchMarketplaces()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load fields for active marketplace ──────────────────────────
  const fetchView = useCallback(async () => {
    if (!active) return
    setViewLoading(true)
    setViewError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${active.channel}/${active.code}`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = (await r.json()) as MarketplaceView
      setView(d)
    } catch (e: any) {
      setViewError(e?.message ?? 'Failed to load fields')
    } finally {
      setViewLoading(false)
    }
  }, [active])

  useEffect(() => {
    void fetchView()
  }, [fetchView])

  // ── Save / delete handlers (re-fetch on success so counts update) ─
  const handleSave = useCallback(
    async (fieldKey: string, rule: FieldMappingRule) => {
      if (!active) return
      try {
        const r = await fetch(
          `${getBackendUrl()}/api/pim/mappings/${active.channel}/${active.code}/${encodeURIComponent(
            fieldKey,
          )}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rule),
          },
        )
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(
            body?.details
              ? Array.isArray(body.details)
                ? body.details.join('; ')
                : String(body.details)
              : body?.error ?? `HTTP ${r.status}`,
          )
        }
        toast.success(`Mapped ${fieldKey}`)
        await Promise.all([fetchView(), fetchMarketplaces()])
      } catch (e: any) {
        toast.error('Save failed', { description: e?.message })
        throw e
      }
    },
    [active, fetchView, fetchMarketplaces, toast],
  )

  const handleDelete = useCallback(
    async (fieldKey: string) => {
      if (!active) return
      try {
        const r = await fetch(
          `${getBackendUrl()}/api/pim/mappings/${active.channel}/${active.code}/${encodeURIComponent(
            fieldKey,
          )}`,
          { method: 'DELETE' },
        )
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${r.status}`)
        }
        toast.success(`Removed ${fieldKey}`)
        await Promise.all([fetchView(), fetchMarketplaces()])
      } catch (e: any) {
        toast.error('Delete failed', { description: e?.message })
        throw e
      }
    },
    [active, fetchView, fetchMarketplaces, toast],
  )

  // ── D.2b — Seed built-in Amazon/eBay/Shopify field definitions ──
  // Hits the CE-series endpoint that upserts ~30 well-known fields per
  // channel. Idempotent: re-running is safe (upsert-by-fieldKey). The
  // mapping editor refetches counts so operators see new fields land.
  const handleSeedBuiltIns = useCallback(async () => {
    setSeeding(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/feed-transform/seed-schemas`, {
        method: 'POST',
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${r.status}`)
      }
      const result = await r.json().catch(() => ({}))
      toast.success(
        `Seeded ${result?.upserted ?? '?'} built-in fields`,
        { description: 'Amazon, eBay, and Shopify base schemas' },
      )
      await Promise.all([fetchMarketplaces(), fetchView()])
    } catch (e: any) {
      toast.error('Seed failed', { description: e?.message })
    } finally {
      setSeeding(false)
    }
  }, [fetchMarketplaces, fetchView, toast])

  // D.5 — run pre-publish validation for one product against the
  // active marketplace's mapping rules.
  const handleValidate = useCallback(async () => {
    if (!active) return
    const pid = validateProductId.trim()
    if (pid === '') return
    setValidating(true)
    setValidationResult(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${active.channel}/${active.code}/validate/${encodeURIComponent(pid)}`,
        { cache: 'no-store' },
      )
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${r.status}`)
      }
      const data = await r.json()
      setValidationResult(data)
    } catch (e: any) {
      toast.error('Validation failed', { description: e?.message })
    } finally {
      setValidating(false)
    }
  }, [active, validateProductId, toast])

  // ── Filtered marketplace list ───────────────────────────────────
  const filteredMarketplaces = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return marketplaces
    return marketplaces.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) ||
        m.channel.toLowerCase().includes(needle) ||
        m.code.toLowerCase().includes(needle),
    )
  }, [marketplaces, search])

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* Left pane: marketplace picker */}
      <aside className="w-80 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col bg-white dark:bg-zinc-950">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <SettingsIcon className="w-3.5 h-3.5 text-zinc-400" />
            Mappings
          </h1>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            How internal data maps to each marketplace's payload schema.
          </p>
          <div className="relative mt-2">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search marketplace…"
              className="pl-6 text-xs"
            />
          </div>
          <button
            type="button"
            onClick={handleSeedBuiltIns}
            disabled={seeding}
            className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 border border-dashed border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
            title="Upsert ~30 built-in Amazon/eBay/Shopify field definitions. Safe to re-run."
          >
            {seeding ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            Seed built-in schemas
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {marketplacesLoading && (
            <div className="flex items-center justify-center py-8 text-zinc-500 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
              Loading marketplaces…
            </div>
          )}
          {marketplacesError && (
            <div className="m-3 p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              {marketplacesError}
            </div>
          )}
          {!marketplacesLoading && filteredMarketplaces.length === 0 && (
            <div className="text-center py-8 text-zinc-500 text-xs italic">
              No marketplaces match.
            </div>
          )}
          {filteredMarketplaces.map((m) => {
            const isActive =
              active?.channel === m.channel && active?.code === m.code
            return (
              <button
                key={`${m.channel}:${m.code}`}
                type="button"
                onClick={() => setActive({ channel: m.channel, code: m.code })}
                className={cn(
                  'w-full px-4 py-2.5 text-left border-b border-zinc-100 dark:border-zinc-800/60',
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-900/20'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50',
                )}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {m.name}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {m.channel}/{m.code}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="inline-flex items-center gap-1">
                    <Globe className="w-2.5 h-2.5" />
                    {m.language} · {m.currency}
                  </span>
                  <span className="ml-auto">
                    <span
                      className={cn(
                        'font-medium',
                        m.mappedCount === 0
                          ? 'text-zinc-400'
                          : m.mappedCount < m.fieldCount
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-emerald-600 dark:text-emerald-400',
                      )}
                    >
                      {m.mappedCount}
                    </span>
                    <span className="text-zinc-400">/{m.fieldCount}</span>
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      {/* Right pane: field editor */}
      <main className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
        {!active && (
          <div className="flex items-center justify-center h-full text-zinc-400 text-sm">
            Select a marketplace on the left.
          </div>
        )}
        {active && viewLoading && (
          <div className="flex items-center justify-center py-16 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading fields…
          </div>
        )}
        {active && viewError && (
          <div className="m-4 p-3 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {viewError}
          </div>
        )}
        {active && view && !viewLoading && (
          <>
            <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 sticky top-0 z-10">
              <div className="flex items-baseline justify-between">
                <div>
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    {view.channel} · {view.code}
                  </h2>
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    {view.fields.length} schema fields · v{view.version} ·{' '}
                    {view.lastSyncedAt
                      ? `synced ${new Date(view.lastSyncedAt).toLocaleString()}`
                      : 'never synced'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchView()}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <RefreshCw className="w-3 h-3" />
                  Refresh
                </button>
              </div>
            </header>
            {/* D.5 — Validate-against-product panel */}
            <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/30">
              <div className="flex items-center gap-2 mb-1.5">
                <PlayCircle className="w-3.5 h-3.5 text-blue-600" />
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Validate against a product
                </span>
                <span className="text-[10px] text-zinc-500 italic">
                  Pre-flight check: resolves every required mapping rule against the
                  product's data; flags fields that would block publish.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={validateProductId}
                  onChange={(e) => setValidateProductId(e.target.value)}
                  placeholder="Product ID (e.g. clxxx…)"
                  className="flex-1 font-mono text-xs"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleValidate()
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleValidate()}
                  disabled={validating || validateProductId.trim() === ''}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {validating ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <PlayCircle className="w-3 h-3" />
                  )}
                  Validate
                </button>
              </div>
              {validationResult && (
                <div
                  className={cn(
                    'mt-2 rounded border p-2 text-xs',
                    validationResult.ok
                      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20'
                      : 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20',
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    {validationResult.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-600" />
                    )}
                    <span
                      className={cn(
                        'font-medium',
                        validationResult.ok
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-red-700 dark:text-red-300',
                      )}
                    >
                      {validationResult.productSku}{' '}
                      {validationResult.ok ? '— publish-ready' : '— would block publish'}
                    </span>
                    <span className="text-[10px] text-zinc-500 ml-auto">
                      {validationResult.errors.length} error(s) ·{' '}
                      {validationResult.totalFields} fields
                    </span>
                  </div>
                  {validationResult.errors.length > 0 && (
                    <ul className="mt-1 space-y-1 ml-4 list-disc">
                      {validationResult.errors.map((e, i) => (
                        <li key={i} className="text-red-700 dark:text-red-300">
                          <span className="font-mono">{e.fieldKey}</span>: {e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {view.fields.length === 0 ? (
              <div className="text-center py-16 text-zinc-500 text-sm">
                No schema fields yet for this marketplace.
                <br />
                <span className="text-xs italic">
                  D.1 will add a "Sync from {view.channel}" button to fetch live schema
                  definitions.
                </span>
              </div>
            ) : (
              <div className="bg-white dark:bg-zinc-950">
                {view.fields.map((f) => (
                  <FieldRuleRow
                    key={f.fieldKey}
                    field={f}
                    onSave={handleSave}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
