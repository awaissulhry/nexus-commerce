'use client'

/**
 * W2.4 — Relations tab on /products/[id]/edit.
 *
 * Cross-sell / up-sell / accessory / replacement / bundle-part /
 * recommended links between products. Schema (ProductRelation) and
 * full CRUD API (H.11 in product-relations.routes.ts) have been in
 * place for weeks; the canonical edit page never surfaced them, so
 * 0/281 products in production have any relations even though the
 * resolver runs on every PDP fetch.
 *
 * The drawer doesn't have this surface — this is the first UI for
 * ProductRelation in the app.
 *
 * Two halves:
 *   - Outgoing: this product → other products, grouped by relation
 *     type. Each row shows the related product (sku, name, price,
 *     status, image), with notes + delete inline.
 *   - Incoming: other products → this product, collapsed by default.
 *     Read-only list because the source product owns those rows.
 *
 * Add-relation form: type select, debounced product search, optional
 * reciprocal checkbox (true by default for CROSS_SELL / RECOMMENDED
 * since those are usually mutual), optional notes.
 *
 * All actions persist immediately, so the tab never reports dirty.
 * discardSignal nudges a refetch.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

const RELATION_TYPES = [
  'CROSS_SELL',
  'UPSELL',
  'ACCESSORY',
  'RECOMMENDED',
  'REPLACEMENT',
  'BUNDLE_PART',
] as const
type RelationType = (typeof RELATION_TYPES)[number]

const RECIPROCAL_BY_DEFAULT: ReadonlySet<RelationType> = new Set([
  'CROSS_SELL',
  'RECOMMENDED',
])

interface RelatedProduct {
  id: string
  sku: string
  name: string
  basePrice: number | null
  totalStock: number
  status: string
  imageUrl: string | null
}

interface OutgoingRelation {
  id: string
  fromProductId: string
  toProductId: string
  type: string
  displayOrder: number
  notes: string | null
  toProduct: RelatedProduct | null
}

interface IncomingRelation {
  id: string
  fromProductId: string
  toProductId: string
  type: string
  displayOrder: number
  notes: string | null
  fromProduct: RelatedProduct | null
}

interface SearchResult {
  id: string
  sku: string
  name: string
  basePrice: number | string | null
  status: string
  imageUrl?: string | null
}

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  discardSignal: number
}

export default function RelationsTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()

  const [outgoing, setOutgoing] = useState<OutgoingRelation[]>([])
  const [incoming, setIncoming] = useState<IncomingRelation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showIncoming, setShowIncoming] = useState(false)

  // Add form state
  const [addType, setAddType] = useState<RelationType>('CROSS_SELL')
  const [addSearch, setAddSearch] = useState('')
  const [addResults, setAddResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [pickedProduct, setPickedProduct] = useState<SearchResult | null>(null)
  const [addNotes, setAddNotes] = useState('')
  const [addReciprocal, setAddReciprocal] = useState(
    RECIPROCAL_BY_DEFAULT.has('CROSS_SELL'),
  )
  const [adding, setAdding] = useState(false)

  // Stable "tab is never dirty" signal.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    onDirtyChange(0)
  }, [onDirtyChange])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/relations`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setOutgoing(json.outgoing ?? [])
      setIncoming(json.incoming ?? [])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [product.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Discard nudge — refetch in case another agent/user added rows.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    void refresh()
  }, [discardSignal, refresh])

  // Default reciprocal flag flips when relation type changes.
  useEffect(() => {
    setAddReciprocal(RECIPROCAL_BY_DEFAULT.has(addType))
  }, [addType])

  // Debounced product search. Skips when a result is already picked
  // (so clicking a result doesn't immediately re-fetch).
  useEffect(() => {
    if (pickedProduct) return
    const term = addSearch.trim()
    if (term.length < 2) {
      setAddResults([])
      return
    }
    const timer = globalThis.setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products?search=${encodeURIComponent(term)}&limit=8`,
          { cache: 'no-store' },
        )
        if (!res.ok) return
        const json = await res.json()
        const items = (json.products ?? [])
          .filter((p: any) => p.id !== product.id)
          .filter(
            (p: any) =>
              !outgoing.some(
                (r) => r.toProductId === p.id && r.type === addType,
              ),
          )
        setAddResults(items)
      } catch {
        /* swallow — banner errors are reserved for explicit actions */
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => globalThis.clearTimeout(timer)
  }, [addSearch, addType, outgoing, pickedProduct, product.id])

  const onPickResult = (r: SearchResult) => {
    setPickedProduct(r)
    setAddSearch(`${r.sku} — ${r.name}`)
    setAddResults([])
  }

  const onClearPick = () => {
    setPickedProduct(null)
    setAddSearch('')
    setAddResults([])
  }

  const onAdd = async () => {
    if (!pickedProduct) return
    setAdding(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/relations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toProductId: pickedProduct.id,
            type: addType,
            reciprocal: addReciprocal,
            notes: addNotes.trim() || undefined,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      onClearPick()
      setAddNotes('')
      toast.success(t('products.edit.relations.added'))
      void refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.relations.addFailed', {
          error: e?.message ?? String(e),
        }),
      )
    } finally {
      setAdding(false)
    }
  }

  const onDelete = async (rel: OutgoingRelation) => {
    const ok = await confirm({
      title: t('products.edit.relations.deleteTitle', {
        sku: rel.toProduct?.sku ?? rel.toProductId,
        type: typeLabel(rel.type, t),
      }),
      description: t('products.edit.relations.deleteBody'),
      confirmLabel: t('products.edit.relations.deleteConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/relations/${rel.id}?reciprocal=true`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.edit.relations.deleted'))
      void refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.relations.deleteFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  // Group outgoing by type for section rendering.
  const outgoingByType = useMemo(() => {
    const m = new Map<string, OutgoingRelation[]>()
    for (const r of outgoing) {
      const arr = m.get(r.type) ?? []
      arr.push(r)
      m.set(r.type, arr)
    }
    return m
  }, [outgoing])

  return (
    <div className="space-y-4">
      {/* ── Add relation form ────────────────────────────────── */}
      <Card
        title={t('products.edit.relations.addTitle')}
        description={t('products.edit.relations.addDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-3">
          <div className="space-y-1">
            <label className="text-base font-medium text-slate-700 dark:text-slate-300">
              {t('products.edit.relations.typeLabel')}
            </label>
            <select
              value={addType}
              onChange={(e) => setAddType(e.target.value as RelationType)}
              className="w-full h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3"
            >
              {RELATION_TYPES.map((typ) => (
                <option key={typ} value={typ}>
                  {typeLabel(typ, t)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 relative">
            <label className="text-base font-medium text-slate-700 dark:text-slate-300">
              {t('products.edit.relations.searchLabel')}
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 pointer-events-none" />
              <input
                type="text"
                value={addSearch}
                onChange={(e) => {
                  if (pickedProduct) setPickedProduct(null)
                  setAddSearch(e.target.value)
                }}
                placeholder={t('products.edit.relations.searchPlaceholder')}
                className="w-full h-8 pl-8 pr-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              {searching && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 animate-spin" />
              )}
            </div>
            {addResults.length > 0 && !pickedProduct && (
              <ul className="absolute z-10 left-0 right-0 mt-0.5 max-h-64 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg divide-y divide-slate-100 dark:divide-slate-800">
                {addResults.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onPickResult(r)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-md text-slate-900 dark:text-slate-100 truncate">
                          {r.name}
                        </span>
                        <Badge mono variant="default">
                          {r.sku}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        €
                        {Number(r.basePrice ?? 0).toFixed(2)} · {r.status}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
          <Input
            label={t('products.edit.relations.notesLabel')}
            placeholder={t('products.edit.relations.notesPlaceholder')}
            value={addNotes}
            onChange={(e) => setAddNotes(e.target.value)}
          />
          <div className="flex items-end gap-2">
            <label className="inline-flex items-center gap-1.5 text-md text-slate-700 dark:text-slate-300 select-none cursor-pointer h-8 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <input
                type="checkbox"
                checked={addReciprocal}
                onChange={(e) => setAddReciprocal(e.target.checked)}
                className="cursor-pointer"
              />
              <span>{t('products.edit.relations.reciprocal')}</span>
            </label>
            <Button
              variant="primary"
              size="sm"
              disabled={!pickedProduct}
              loading={adding}
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => void onAdd()}
            >
              {t('products.edit.relations.addButton')}
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Outgoing relations ───────────────────────────────── */}
      {error ? (
        <Card>
          <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        </Card>
      ) : loading ? (
        <Card>
          <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('products.edit.relations.loading')}
          </div>
        </Card>
      ) : outgoing.length === 0 ? (
        <Card title={t('products.edit.relations.outgoingTitle')}>
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-6 text-center">
            {t('products.edit.relations.outgoingEmpty')}
          </div>
        </Card>
      ) : (
        RELATION_TYPES.filter((typ) => outgoingByType.has(typ)).map((typ) => {
          const rows = outgoingByType.get(typ) ?? []
          return (
            <Card
              key={typ}
              title={typeLabel(typ, t)}
              description={t(`products.edit.relations.typeDesc.${typ}`)}
            >
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                {rows.map((rel) => (
                  <RelationRow
                    key={rel.id}
                    relation={rel}
                    onDelete={() => void onDelete(rel)}
                    t={t}
                  />
                ))}
              </ul>
            </Card>
          )
        })
      )}

      {/* ── Incoming (collapsed by default) ──────────────────── */}
      {incoming.length > 0 && (
        <Card
          title={t('products.edit.relations.incomingTitle', {
            count: incoming.length,
          })}
          description={t('products.edit.relations.incomingDesc')}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowIncoming((v) => !v)}
            >
              {showIncoming
                ? t('products.edit.relations.incomingHide')
                : t('products.edit.relations.incomingShow')}
            </Button>
          }
        >
          {showIncoming && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              {incoming.map((rel) => (
                <li
                  key={rel.id}
                  className="px-3 py-2 flex items-center gap-3 bg-white dark:bg-slate-900"
                >
                  <Badge mono variant="default">
                    {typeLabel(rel.type, t)}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-md text-slate-900 dark:text-slate-100 truncate">
                        {rel.fromProduct?.name ?? rel.fromProductId}
                      </span>
                      {rel.fromProduct?.sku && (
                        <Badge mono variant="default">
                          {rel.fromProduct.sku}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {rel.fromProduct && (
                    <Link
                      href={`/products/${rel.fromProductId}/edit`}
                      className="text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400"
                      aria-label={t('products.edit.relations.openLinkAria')}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}

// ── Row ────────────────────────────────────────────────────────
function RelationRow({
  relation,
  onDelete,
  t,
}: {
  relation: OutgoingRelation
  onDelete: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const p = relation.toProduct
  return (
    <li className="px-3 py-2 flex items-center gap-3 bg-white dark:bg-slate-900">
      <div className="flex-shrink-0 w-10 h-10 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center overflow-hidden">
        {p?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-md text-slate-900 dark:text-slate-100 truncate">
            {p?.name ?? relation.toProductId}
          </span>
          {p?.sku && (
            <Badge mono variant="default">
              {p.sku}
            </Badge>
          )}
          {p?.status && p.status !== 'ACTIVE' && (
            <Badge variant="warning">{p.status}</Badge>
          )}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          {p?.basePrice != null ? `€${Number(p.basePrice).toFixed(2)}` : '—'}
          {' · '}
          {t('products.edit.relations.stock', {
            count: p?.totalStock ?? 0,
          })}
          {relation.notes && (
            <>
              {' · '}
              <span className="italic" title={relation.notes}>
                {relation.notes}
              </span>
            </>
          )}
        </div>
      </div>
      {p && (
        <Link
          href={`/products/${relation.toProductId}/edit`}
          className="text-slate-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 flex-shrink-0"
          aria-label={t('products.edit.relations.openLinkAria')}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      )}
      <button
        type="button"
        onClick={onDelete}
        aria-label={t('products.edit.relations.deleteAria', {
          sku: p?.sku ?? relation.toProductId,
        })}
        className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 flex-shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}

// ── Helpers ────────────────────────────────────────────────────
function typeLabel(
  type: string,
  t: (key: string) => string,
): string {
  return t(`products.edit.relations.type.${type}`)
}
