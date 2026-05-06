// /catalog/organize — 3-tab catalog organization workspace.
// (Renamed from /pim/review on 2026-05-06; old path 301s here. The
// page does catalog organization, not a review queue, so the URL
// now matches the behaviour.)
//
// Tabs:
//   1. Suggested Groups   — auto-detected variation clusters
//                          (existing detect/apply flow, lightly
//                          enhanced with channel coverage badges
//                          and search)
//   2. Standalone         — products that are neither parents nor
//                          children. The user's main ask: attach
//                          to existing parent (typeahead + axis
//                          values per row), or promote to parent.
//                          Bulk select for batch attach.
//   3. Parents            — catalog overview of every parent with
//                          child counts, listing health, channel
//                          coverage; click to drawer with member
//                          list.
//
// Right rail = catalog snapshot, recent activity, quick filters.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Boxes,
  Check,
  ChevronRight,
  ExternalLink,
  Filter,
  Layers,
  Loader2,
  Package,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

type Tab = 'groups' | 'standalone' | 'parents'

interface DetectedGroup {
  id: string
  baseName: string
  suggestedMasterSku: string
  confidence: number
  detectionMethod?: string
  variationAxes: string[]
  members: Array<{
    productId: string
    sku: string
    name: string
    asin: string | null
    detectedAttributes: Record<string, string>
  }>
}

interface StandaloneItem {
  id: string
  sku: string
  name: string
  brand: string | null
  productType: string | null
  basePrice: number
  totalStock: number
  amazonAsin: string | null
  ebayItemId: string | null
  channelCoverage: {
    status: 'unlisted' | 'partial' | 'complete'
    slots: string[]
    liveCount: number
    draftCount: number
    failedCount: number
  }
}

interface ParentRow {
  id: string
  sku: string
  name: string
  brand: string | null
  productType: string | null
  variationTheme: string | null
  variationAxes: unknown
  childCount: number
  listings: {
    live: number
    draft: number
    failed: number
    channels: string[]
  }
}

interface ParentSearchHit {
  id: string
  sku: string
  name: string
}

const TABS: Array<{ id: Tab; label: string; description: string }> = [
  {
    id: 'groups',
    label: 'Suggested Groups',
    description: 'Auto-detected variation clusters',
  },
  {
    id: 'standalone',
    label: 'Standalone Products',
    description: 'Orphans waiting to be promoted or linked',
  },
  {
    id: 'parents',
    label: 'Parents',
    description: 'Catalog overview',
  },
]

export default function OrganizeClient() {
  const [tab, setTab] = useState<Tab>('groups')
  const [statusMsg, setStatusMsg] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  useEffect(() => {
    if (!statusMsg) return
    const t = window.setTimeout(() => setStatusMsg(null), 4000)
    return () => window.clearTimeout(t)
  }, [statusMsg])

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto">
      <header className="mb-5">
        <h1 className="text-[24px] font-semibold text-slate-900">
          Catalog Organization
        </h1>
        <p className="text-[13px] text-slate-600 mt-0.5">
          Promote standalones to parents, attach orphans to existing
          parents, and approve auto-detected variation groups.
          Multi-channel awareness throughout.
        </p>
      </header>

      {statusMsg && (
        <div
          className={cn(
            'mb-4 border rounded-lg px-4 py-2 text-[12px] flex items-start justify-between gap-3',
            statusMsg.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800',
          )}
        >
          <div className="inline-flex items-start gap-2 min-w-0">
            {statusMsg.kind === 'success' ? (
              <Check className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            )}
            <span className="break-words">{statusMsg.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusMsg(null)}
            className="opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Tab strip */}
      <nav
        role="tablist"
        aria-label="Catalog organization tabs"
        className="border-b border-slate-200 mb-5 flex items-center gap-1 overflow-x-auto"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={cn(
              'inline-flex items-center gap-2 h-10 px-4 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap',
              tab === t.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900',
            )}
          >
            {t.id === 'groups' && <Layers className="w-3.5 h-3.5" />}
            {t.id === 'standalone' && <Boxes className="w-3.5 h-3.5" />}
            {t.id === 'parents' && <Package className="w-3.5 h-3.5" />}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
        <div className="min-w-0">
          {tab === 'groups' && (
            <GroupsTab
              onStatus={setStatusMsg}
            />
          )}
          {tab === 'standalone' && (
            <StandaloneTab
              onStatus={setStatusMsg}
            />
          )}
          {tab === 'parents' && (
            <ParentsTab onStatus={setStatusMsg} />
          )}
        </div>
        <RightRail tab={tab} />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Tab 1 — Suggested Groups
// ───────────────────────────────────────────────────────────────────

function GroupsTab({
  onStatus,
}: {
  onStatus: (s: { kind: 'success' | 'error'; text: string }) => void
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [search, setSearch] = useState('')
  const [minConfidence, setMinConfidence] = useState(0)

  // Phase 10 — usePolledList centralises fetch + ETag + 30s polling +
  // visibility refresh + invalidation listening. Listens for
  // pim.changed so a successful attach/promote on another tab
  // (or the Parents/Standalones sub-tabs here) triggers a refresh.
  const { data, loading, error, refetch } = usePolledList<{
    groups: DetectedGroup[]
  }>({
    url: '/api/amazon/pim/detect-groups',
    intervalMs: 60_000,
    invalidationTypes: ['pim.changed', 'product.created', 'product.deleted'],
  })
  const groups = data?.groups ?? []
  const fetchDetection = refetch
  useEffect(() => {
    if (error) {
      onStatus({ kind: 'error', text: `Detection failed: ${error}` })
    }
  }, [error, onStatus])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return groups.filter(
      (g) =>
        g.confidence >= minConfidence &&
        (q === '' ||
          g.baseName.toLowerCase().includes(q) ||
          g.suggestedMasterSku.toLowerCase().includes(q)),
    )
  }, [groups, search, minConfidence])

  async function applyApproved() {
    setApplying(true)
    try {
      const toApply = groups
        .filter((g) => approved.has(g.id))
        .map((g) => ({
          masterSku: g.suggestedMasterSku,
          masterName: g.baseName,
          variationAxes: g.variationAxes,
          children: g.members.map((m) => ({
            productId: m.productId,
            attributes: m.detectedAttributes,
          })),
        }))
      const res = await fetch(
        `${getBackendUrl()}/api/amazon/pim/apply-groups`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `pim-apply:${toApply.map((g) => g.masterSku).join(',')}`,
          },
          body: JSON.stringify({ groups: toApply }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      onStatus({
        kind: 'success',
        text: `Created ${json.mastersCreated} master${
          json.mastersCreated === 1 ? '' : 's'
        }, linked ${json.childrenLinked} children${
          json.errors?.length ? ` (${json.errors.length} errors)` : ''
        }`,
      })
      setApproved(new Set())
      setRejected(new Set())
      // Phase 10 — broadcast so other open pages (/products,
      // /listings, /catalog/organize sub-tabs in another tab) refresh.
      emitInvalidation({
        type: 'pim.changed',
        meta: {
          mastersCreated: json.mastersCreated,
          childrenLinked: json.childrenLinked,
        },
      })
      await fetchDetection()
    } catch (err) {
      onStatus({
        kind: 'error',
        text: `Apply failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
    } finally {
      setApplying(false)
    }
  }

  const totalMembers = filtered.reduce((s, g) => s + g.members.length, 0)
  const pending = filtered.length - approved.size - rejected.size

  return (
    <div className="space-y-4">
      <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search base name or master SKU"
              className="w-full h-8 pl-8 pr-2 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
            Min confidence
            <input
              type="range"
              min="0"
              max="100"
              step="10"
              value={minConfidence}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
              className="w-24"
            />
            <span className="w-8 text-right tabular-nums">{minConfidence}%</span>
          </label>
          <button
            type="button"
            onClick={() => void fetchDetection()}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || filtered.length === 0}
            onClick={() =>
              setApproved(
                new Set(
                  filtered.filter((g) => g.confidence >= 80).map((g) => g.id),
                ),
              )
            }
          >
            Auto-approve 80%+
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={applying}
            disabled={approved.size === 0}
            onClick={() => void applyApproved()}
          >
            Apply {approved.size || ''}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-600">
          <span>
            <strong className="text-slate-900">{filtered.length}</strong> group
            {filtered.length === 1 ? '' : 's'} ·{' '}
            <strong className="text-slate-900">{totalMembers}</strong> products
          </span>
          <span className="text-emerald-700">{approved.size} approved</span>
          <span className="text-rose-700">{rejected.size} rejected</span>
          <span className="text-slate-500">{pending} pending</span>
        </div>
      </div>

      {loading && groups.length === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-slate-200 rounded-lg p-4 animate-pulse h-16"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No groups match"
          description="Try lowering the min-confidence slider or clearing the search."
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              isApproved={approved.has(g.id)}
              isRejected={rejected.has(g.id)}
              isExpanded={expandedGroup === g.id}
              onToggleExpand={() =>
                setExpandedGroup(expandedGroup === g.id ? null : g.id)
              }
              onApprove={() => {
                setApproved((s) => {
                  const next = new Set(s)
                  if (next.has(g.id)) next.delete(g.id)
                  else next.add(g.id)
                  return next
                })
                setRejected((s) => {
                  const next = new Set(s)
                  next.delete(g.id)
                  return next
                })
              }}
              onReject={() => {
                setRejected((s) => {
                  const next = new Set(s)
                  if (next.has(g.id)) next.delete(g.id)
                  else next.add(g.id)
                  return next
                })
                setApproved((s) => {
                  const next = new Set(s)
                  next.delete(g.id)
                  return next
                })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupRow({
  group,
  isApproved,
  isRejected,
  isExpanded,
  onToggleExpand,
  onApprove,
  onReject,
}: {
  group: DetectedGroup
  isApproved: boolean
  isRejected: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onApprove: () => void
  onReject: () => void
}) {
  const confTone =
    group.confidence >= 80
      ? 'success'
      : group.confidence >= 60
      ? 'warning'
      : 'danger'
  return (
    <div
      className={cn(
        'bg-white border-2 rounded-lg overflow-hidden transition-colors',
        isApproved && 'border-emerald-400',
        isRejected && 'border-rose-300 opacity-60',
        !isApproved && !isRejected && 'border-slate-200',
      )}
    >
      <div className="p-4 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onToggleExpand}
          className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors"
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          <ChevronRight
            className={cn(
              'w-4 h-4 transition-transform',
              isExpanded && 'rotate-90',
            )}
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-slate-900 truncate">
            {group.baseName}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
            <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
              {group.suggestedMasterSku}
            </span>
            <span>·</span>
            <span>
              {group.members.length} variant{group.members.length === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span>{group.variationAxes.join(' / ') || '—'}</span>
            {group.detectionMethod && (
              <>
                <span>·</span>
                <span className="uppercase tracking-wide text-[10px] text-slate-400">
                  {group.detectionMethod.replace(/_/g, ' ')}
                </span>
              </>
            )}
          </div>
        </div>
        <Badge variant={confTone} size="md">
          {group.confidence}%
        </Badge>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onApprove}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              isApproved
                ? 'bg-emerald-500 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-emerald-100',
            )}
            title="Approve"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onReject}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              isRejected
                ? 'bg-rose-500 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-rose-100',
            )}
            title="Reject"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="border-t border-slate-200 bg-slate-50 p-4">
          <ul className="space-y-1.5">
            {group.members.map((m) => (
              <li
                key={m.productId}
                className="bg-white border border-slate-200 rounded-md p-2.5 flex items-center justify-between gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-slate-900 truncate font-mono">
                    {m.sku}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {m.name}
                  </div>
                </div>
                <div className="flex gap-1 flex-wrap justify-end max-w-[60%]">
                  {Object.entries(m.detectedAttributes).map(([k, v]) => (
                    <Badge key={k} variant="info" size="sm">
                      <span className="text-blue-600">{k}:</span>
                      <span className="ml-1">{v}</span>
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Tab 2 — Standalone Products
// ───────────────────────────────────────────────────────────────────

function StandaloneTab({
  onStatus,
}: {
  onStatus: (s: { kind: 'success' | 'error'; text: string }) => void
}) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [coverage, setCoverage] = useState<
    'all' | 'unlisted' | 'partial' | 'complete'
  >('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [attachOpen, setAttachOpen] = useState<{
    productIds: string[]
  } | null>(null)
  const [promoteId, setPromoteId] = useState<StandaloneItem | null>(null)

  // 250ms debounce — keeps the input snappy while batching the fetch
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(t)
  }, [search])

  // Phase 10 — usePolledList replaces the bespoke fetch + useEffect.
  // ETag round-trip on the server side (10b) means idle polling
  // collapses to 304s.
  const url = useMemo(() => {
    const params = new URLSearchParams()
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())
    if (coverage !== 'all') params.set('coverage', coverage)
    params.set('limit', '50')
    return `/api/pim/standalones?${params.toString()}`
  }, [debouncedSearch, coverage])
  const { data, loading, error, refetch } = usePolledList<{
    items: StandaloneItem[]
    total: number
  }>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['pim.changed', 'product.created', 'product.deleted'],
  })
  const items = data?.items ?? []
  const total = data?.total ?? 0
  useEffect(() => {
    if (error) {
      onStatus({
        kind: 'error',
        text: `Couldn't load standalones: ${error}`,
      })
    }
  }, [error, onStatus])

  const allSelected = items.length > 0 && selected.size === items.length

  return (
    <div className="space-y-4">
      <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU, name, brand"
              className="w-full h-8 pl-8 pr-2 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <select
            value={coverage}
            onChange={(e) => setCoverage(e.target.value as any)}
            className="h-8 px-2 text-[12px] border border-slate-200 rounded-md bg-white"
          >
            <option value="all">All</option>
            <option value="unlisted">Unlisted only</option>
            <option value="partial">Partial coverage</option>
            <option value="complete">Fully listed</option>
          </select>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
          {selected.size > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                setAttachOpen({ productIds: Array.from(selected) })
              }
            >
              Attach {selected.size} to parent
            </Button>
          )}
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          <strong className="text-slate-900">{items.length}</strong> shown of{' '}
          {total} standalone product{total === 1 ? '' : 's'}.
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-white border border-slate-200 rounded-lg p-3 animate-pulse h-16"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No standalone products"
          description="Either every product is grouped, or your filters exclude them all."
        />
      ) : (
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(items.map((i) => i.id))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Channels
                </th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Price
                </th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Stock
                </th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-slate-100 hover:bg-slate-50/50"
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const next = new Set(s)
                          if (e.target.checked) next.add(p.id)
                          else next.delete(p.id)
                          return next
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    <Link
                      href={`/products/${p.id}/edit`}
                      className="text-blue-600 hover:underline"
                    >
                      {p.sku}
                    </Link>
                  </td>
                  <td className="px-3 py-2 max-w-[260px]">
                    <div className="truncate text-slate-800">{p.name}</div>
                    {p.brand && (
                      <div className="text-[10px] text-slate-500">
                        {p.brand}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <CoverageBadge cov={p.channelCoverage} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    €{p.basePrice.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={
                        p.totalStock === 0 ? 'text-rose-600' : 'text-slate-700'
                      }
                    >
                      {p.totalStock}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPromoteId(p)}
                        className="h-6 px-2 text-[10px] rounded-md border border-slate-200 hover:bg-slate-100 text-slate-700"
                        title="Mark as parent (will accept variants)"
                      >
                        Promote
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachOpen({ productIds: [p.id] })
                        }
                        className="h-6 px-2 text-[10px] rounded-md bg-blue-600 text-white hover:bg-blue-700"
                      >
                        Attach to parent
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {attachOpen && (
        <AttachModal
          productIds={attachOpen.productIds}
          onClose={() => setAttachOpen(null)}
          onAttached={(count) => {
            onStatus({
              kind: 'success',
              text: `Attached ${count} product${count === 1 ? '' : 's'} to parent.`,
            })
            setAttachOpen(null)
            setSelected(new Set())
            // Phase 10 — invalidate so other tabs / pages refresh.
            emitInvalidation({ type: 'pim.changed', meta: { attached: count } })
            void refetch()
          }}
          onError={(text) => onStatus({ kind: 'error', text })}
        />
      )}

      {promoteId && (
        <PromoteModal
          product={promoteId}
          onClose={() => setPromoteId(null)}
          onPromoted={() => {
            onStatus({
              kind: 'success',
              text: `${promoteId.sku} is now a parent.`,
            })
            setPromoteId(null)
            // Phase 10 — invalidate so other tabs / pages refresh.
            emitInvalidation({ type: 'pim.changed', id: promoteId.id, meta: { promotedTo: 'parent' } })
            void refetch()
          }}
          onError={(text) => onStatus({ kind: 'error', text })}
        />
      )}
    </div>
  )
}

function CoverageBadge({ cov }: { cov: StandaloneItem['channelCoverage'] }) {
  if (cov.status === 'unlisted') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-slate-200 bg-slate-50 text-slate-600">
        unlisted
      </span>
    )
  }
  return (
    <div className="flex items-center gap-1 flex-wrap max-w-[200px]">
      {cov.slots.slice(0, 4).map((s) => (
        <span
          key={s}
          className="font-mono text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-700"
        >
          {s.replace(':', '·')}
        </span>
      ))}
      {cov.slots.length > 4 && (
        <span className="text-[9px] text-slate-500">
          +{cov.slots.length - 4}
        </span>
      )}
      {cov.status === 'partial' && (
        <span className="text-[9px] text-amber-700">
          {cov.draftCount + cov.failedCount > 0
            ? `${cov.draftCount}d/${cov.failedCount}f`
            : 'partial'}
        </span>
      )}
      {cov.status === 'complete' && (
        <span className="text-[9px] text-emerald-700">all live</span>
      )}
    </div>
  )
}

function AttachModal({
  productIds,
  onClose,
  onAttached,
  onError,
}: {
  productIds: string[]
  onClose: () => void
  onAttached: (count: number) => void
  onError: (text: string) => void
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<ParentSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<ParentSearchHit | null>(null)
  const [parentVariants, setParentVariants] = useState<
    Array<{ sku: string; attrs: Record<string, string> }>
  >([])
  const [parentAxes, setParentAxes] = useState<string[]>([])
  const [axisValues, setAxisValues] = useState<
    Record<string, Record<string, string>>
  >({})
  const [submitting, setSubmitting] = useState(false)
  const lastTermRef = useRef('')

  // Search parents.
  useEffect(() => {
    const term = search.trim()
    if (term.length < 2) {
      setResults([])
      return
    }
    lastTermRef.current = term
    const t = window.setTimeout(async () => {
      setSearching(true)
      try {
        const url = new URL(`${getBackendUrl()}/api/products/bulk-fetch`)
        url.searchParams.set('search', term)
        url.searchParams.set('limit', '10')
        const res = await fetch(url.toString())
        const json = await res.json()
        if (lastTermRef.current !== term) return
        const hits: ParentSearchHit[] = (json?.products ?? [])
          .filter((p: { isParent?: boolean; id?: string }) => p.isParent && p.id)
          .map((p: { id: string; sku: string; name: string }) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
          }))
        setResults(hits)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [search])

  // Fetch selected parent's variants + axes.
  useEffect(() => {
    if (!selected) {
      setParentVariants([])
      setParentAxes([])
      return
    }
    let cancelled = false
    fetch(
      `${getBackendUrl()}/api/catalog/products/${encodeURIComponent(
        selected.id,
      )}`,
    )
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const data = json?.data ?? json
        const axes: string[] = Array.isArray(data?.variationAxes)
          ? data.variationAxes
          : typeof data?.variationTheme === 'string' &&
            data.variationTheme.length > 0
          ? data.variationTheme.split(/\s*\/\s*/)
          : []
        const variants =
          data?.variations?.map(
            (v: {
              sku: string
              variationAttributes?: Record<string, unknown>
            }) => ({
              sku: v.sku,
              attrs: Object.fromEntries(
                Object.entries(v.variationAttributes ?? {}).map(([k, val]) => [
                  k,
                  String(val ?? ''),
                ]),
              ),
            }),
          ) ?? []
        setParentVariants(variants)
        // If we have axes from theme/axes, use those. Else derive
        // from existing variants.
        if (axes.length > 0) {
          setParentAxes(axes)
        } else if (variants.length > 0) {
          const set = new Set<string>()
          for (const v of variants) {
            for (const k of Object.keys(v.attrs ?? {})) set.add(k)
          }
          setParentAxes(Array.from(set))
        } else {
          setParentAxes([])
        }
      })
      .catch(() => {
        setParentVariants([])
        setParentAxes([])
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const valuesByAxis = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const ax of parentAxes) m.set(ax, new Set())
    for (const v of parentVariants) {
      for (const ax of parentAxes) {
        const val = v.attrs?.[ax]
        if (val) m.get(ax)!.add(val)
      }
    }
    return m
  }, [parentAxes, parentVariants])

  function setAxis(productId: string, axis: string, value: string) {
    setAxisValues((s) => ({
      ...s,
      [productId]: { ...(s[productId] ?? {}), [axis]: value },
    }))
  }

  async function handleAttach() {
    if (!selected) return
    setSubmitting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pim/attach-to-parent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `pim-attach:${selected.id}:${productIds.sort().join(',')}`,
          },
          body: JSON.stringify({
            parentId: selected.id,
            productIds,
            axisValues,
          }),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.success === false) {
        onError(json?.error ?? `Attach failed (HTTP ${res.status})`)
        return
      }
      onAttached(json.attached ?? productIds.length)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 backdrop-blur-sm pt-[6vh] px-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[680px] max-w-[92vw] flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-[15px] font-semibold text-slate-900">
            Attach {productIds.length} product{productIds.length === 1 ? '' : 's'}{' '}
            to parent
          </h2>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            className="text-slate-400 hover:text-slate-700 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!selected && (
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                Search parent SKU or name
              </label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Min 2 characters"
                  className="w-full h-8 pl-8 pr-2 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div className="mt-2 max-h-[200px] overflow-y-auto border border-slate-100 rounded-md">
                {searching && (
                  <div className="px-3 py-2 text-[11px] text-slate-500 inline-flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Searching…
                  </div>
                )}
                {!searching && results.length === 0 && search.trim().length >= 2 && (
                  <div className="px-3 py-3 text-[11px] text-slate-500 text-center">
                    No parents match.
                  </div>
                )}
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className="w-full text-left px-3 py-2 text-[12px] hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                  >
                    <div className="font-mono text-slate-900">{p.sku}</div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {p.name}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selected && (
            <>
              <div className="border border-slate-200 rounded-md px-3 py-2 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-slate-500">Parent</div>
                  <div className="font-mono text-[13px] text-slate-900">
                    {selected.sku}
                  </div>
                  <div className="text-[11px] text-slate-600">
                    {selected.name}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-[10px] text-slate-500 hover:underline"
                >
                  change
                </button>
              </div>

              {parentAxes.length > 0 && parentVariants.length > 0 && (
                <div className="border border-slate-200 rounded-md px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                    Existing variants under this parent
                  </div>
                  <div className="text-[11px] text-slate-600 max-h-[100px] overflow-y-auto">
                    {parentVariants.slice(0, 8).map((v) => (
                      <div
                        key={v.sku}
                        className="flex items-center gap-2 truncate"
                      >
                        <span className="font-mono text-slate-700">{v.sku}</span>
                        <span className="text-slate-500">
                          {Object.entries(v.attrs ?? {})
                            .map(([k, val]) => `${k}=${val}`)
                            .join(' · ')}
                        </span>
                      </div>
                    ))}
                    {parentVariants.length > 8 && (
                      <div className="text-[10px] text-slate-400">
                        …and {parentVariants.length - 8} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <div className="text-[11px] font-medium text-slate-700 mb-1">
                  Set axis values per product (optional but recommended)
                </div>
                {parentAxes.length === 0 ? (
                  <p className="text-[11px] text-slate-500 italic">
                    The parent has no defined axes yet — your values
                    here will set them.
                  </p>
                ) : null}
                <div className="space-y-2 max-h-[260px] overflow-y-auto">
                  {productIds.map((pid) => (
                    <ProductAxisRow
                      key={pid}
                      productId={pid}
                      axes={
                        parentAxes.length > 0
                          ? parentAxes
                          : ['axis']
                      }
                      values={axisValues[pid] ?? {}}
                      valuesByAxis={valuesByAxis}
                      onChange={(axis, value) => setAxis(pid, axis, value)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleAttach()}
            disabled={!selected || submitting}
            loading={submitting}
          >
            Attach
          </Button>
        </div>
      </div>
    </div>
  )
}

function ProductAxisRow({
  productId,
  axes,
  values,
  valuesByAxis,
  onChange,
}: {
  productId: string
  axes: string[]
  values: Record<string, string>
  valuesByAxis: Map<string, Set<string>>
  onChange: (axis: string, value: string) => void
}) {
  return (
    <div className="border border-slate-200 rounded-md p-2.5 bg-slate-50/30">
      <div className="text-[10px] font-mono text-slate-500 mb-1.5 truncate">
        {productId}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {axes.map((axis) => {
          const known = Array.from(valuesByAxis.get(axis) ?? [])
          const v = values[axis] ?? ''
          const isCustom = v !== '' && !known.includes(v)
          return (
            <div key={axis}>
              <div className="text-[10px] text-slate-500 mb-0.5">{axis}</div>
              <select
                value={isCustom ? '__custom__' : v}
                onChange={(e) => {
                  if (e.target.value === '__custom__') onChange(axis, '')
                  else onChange(axis, e.target.value)
                }}
                className="w-full h-7 px-2 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
              >
                <option value="">— Select —</option>
                {known.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="__custom__">+ New value…</option>
              </select>
              {(isCustom || (v === '' && known.length === 0)) && (
                <input
                  type="text"
                  value={v}
                  onChange={(e) => onChange(axis, e.target.value)}
                  placeholder={`New ${axis} value`}
                  className="mt-1 w-full h-7 px-2 text-[11px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PromoteModal({
  product,
  onClose,
  onPromoted,
  onError,
}: {
  product: StandaloneItem
  onClose: () => void
  onPromoted: () => void
  onError: (text: string) => void
}) {
  const [theme, setTheme] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 backdrop-blur-sm pt-[12vh] px-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[460px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200">
          <h2 className="text-[15px] font-semibold text-slate-900">
            Promote {product.sku} to parent
          </h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-[12px] text-slate-700">
            Marks this product as a parent. You can then add child variants
            from the Variations tab on its edit page, or attach existing
            standalones to it from this page.
          </p>
          <div>
            <label className="block text-[11px] font-medium text-slate-700 mb-1">
              Variation theme (optional)
              <span className="ml-2 font-normal text-[10px] text-slate-500">
                e.g. "Size / Color"
              </span>
            </label>
            <input
              type="text"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="Size / Color"
              className="w-full h-8 px-2.5 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              disabled={submitting}
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={submitting}
            onClick={async () => {
              setSubmitting(true)
              try {
                const axes = theme.trim()
                  ? theme.split(/\s*\/\s*/).filter(Boolean)
                  : undefined
                const res = await fetch(
                  `${getBackendUrl()}/api/pim/promote-to-parent`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Idempotency-Key': `pim-promote:${product.id}`,
                    },
                    body: JSON.stringify({
                      productId: product.id,
                      variationTheme: theme.trim() || undefined,
                      variationAxes: axes,
                    }),
                  },
                )
                const json = await res.json().catch(() => ({}))
                if (!res.ok || json?.success === false) {
                  onError(json?.error ?? `Promote failed (HTTP ${res.status})`)
                  return
                }
                onPromoted()
              } catch (err) {
                onError(err instanceof Error ? err.message : String(err))
              } finally {
                setSubmitting(false)
              }
            }}
          >
            Promote to parent
          </Button>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Tab 3 — Parents
// ───────────────────────────────────────────────────────────────────

function ParentsTab({
  onStatus,
}: {
  onStatus: (s: { kind: 'success' | 'error'; text: string }) => void
}) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [incompleteOnly, setIncompleteOnly] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(t)
  }, [search])

  // Phase 10 — usePolledList replaces the bespoke fetch + useEffect.
  const url = useMemo(() => {
    const params = new URLSearchParams()
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())
    if (incompleteOnly) params.set('incomplete', '1')
    params.set('limit', '50')
    return `/api/pim/parents-overview?${params.toString()}`
  }, [debouncedSearch, incompleteOnly])
  const { data, loading, error, refetch } = usePolledList<{
    items: ParentRow[]
    total: number
  }>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['pim.changed', 'product.created', 'product.deleted'],
  })
  const items = data?.items ?? []
  const total = data?.total ?? 0
  useEffect(() => {
    if (error) {
      onStatus({ kind: 'error', text: `Couldn't load parents: ${error}` })
    }
  }, [error, onStatus])

  return (
    <div className="space-y-4">
      <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search parent SKU or name"
              className="w-full h-8 pl-8 pr-2 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-700">
            <input
              type="checkbox"
              checked={incompleteOnly}
              onChange={(e) => setIncompleteOnly(e.target.checked)}
            />
            Incomplete only
          </label>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={loading}
            className="inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          <strong className="text-slate-900">{items.length}</strong> shown of{' '}
          {total} parent product{total === 1 ? '' : 's'}.
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-slate-200 rounded-lg p-3 animate-pulse h-16"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No parents match"
          description="Promote a standalone or apply a suggested group to create one."
        />
      ) : (
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Theme
                </th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Children
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Listings
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Channels
                </th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-slate-100 hover:bg-slate-50/50"
                >
                  <td className="px-3 py-2 font-mono text-[11px]">
                    <Link
                      href={`/products/${p.id}/edit`}
                      className="text-blue-600 hover:underline"
                    >
                      {p.sku}
                    </Link>
                  </td>
                  <td className="px-3 py-2 max-w-[260px]">
                    <div className="truncate text-slate-800">{p.name}</div>
                    {p.brand && (
                      <div className="text-[10px] text-slate-500">
                        {p.brand}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {p.variationTheme ? (
                      <span className="text-slate-700">{p.variationTheme}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={
                        p.childCount === 0 ? 'text-amber-600' : 'text-slate-700'
                      }
                    >
                      {p.childCount}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="inline-flex gap-1">
                      <span className="px-1.5 py-0.5 text-[9px] rounded border border-emerald-200 bg-emerald-50 text-emerald-700 tabular-nums">
                        {p.listings.live} live
                      </span>
                      {p.listings.draft > 0 && (
                        <span className="px-1.5 py-0.5 text-[9px] rounded border border-amber-200 bg-amber-50 text-amber-700 tabular-nums">
                          {p.listings.draft} draft
                        </span>
                      )}
                      {p.listings.failed > 0 && (
                        <span className="px-1.5 py-0.5 text-[9px] rounded border border-rose-200 bg-rose-50 text-rose-700 tabular-nums">
                          {p.listings.failed} failed
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {p.listings.channels.slice(0, 4).map((c) => (
                        <span
                          key={c}
                          className="font-mono text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-700"
                        >
                          {c.replace(':', '·')}
                        </span>
                      ))}
                      {p.listings.channels.length > 4 && (
                        <span className="text-[9px] text-slate-500">
                          +{p.listings.channels.length - 4}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/products/${p.id}/edit`}
                      className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded-md border border-slate-200 hover:bg-slate-50 text-slate-700"
                    >
                      Open
                      <ChevronRight className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Right rail
// ───────────────────────────────────────────────────────────────────

function RightRail({ tab }: { tab: Tab }) {
  return (
    <aside className="space-y-4">
      <Card title="Tab help">
        <div className="text-[11px] text-slate-600 leading-snug space-y-2">
          {tab === 'groups' && (
            <p>
              Auto-detected variation clusters. Approve the ones that
              look right, reject the rest, then click <strong>Apply</strong>.
              The slider controls the minimum confidence threshold.
            </p>
          )}
          {tab === 'standalone' && (
            <p>
              Products with no parent and no auto-detected group. Either
              <strong> promote</strong> to make it a parent (add variants
              later) or <strong>attach</strong> to an existing parent —
              you can multi-select rows for bulk attach.
            </p>
          )}
          {tab === 'parents' && (
            <p>
              Catalog overview of every parent with its child count,
              listing health, and channel coverage. Click a row to open
              its edit page (Variations tab supports add/edit/delete).
            </p>
          )}
        </div>
      </Card>

      <Card title="Quick actions">
        <ul className="text-[12px] text-slate-700 space-y-1">
          <li>
            <Link
              href="/products/new"
              className="inline-flex items-center gap-1.5 hover:text-blue-700"
            >
              <PackagePlus className="w-3.5 h-3.5 text-slate-500" />
              Add new product
            </Link>
          </li>
          <li>
            <Link
              href="/bulk-operations"
              className="inline-flex items-center gap-1.5 hover:text-blue-700"
            >
              <Filter className="w-3.5 h-3.5 text-slate-500" />
              Bulk operations grid
            </Link>
          </li>
          <li>
            <Link
              href="/dashboard/overview"
              className="inline-flex items-center gap-1.5 hover:text-blue-700"
            >
              <Sparkles className="w-3.5 h-3.5 text-slate-500" />
              Command Center
            </Link>
          </li>
          <li>
            <Link
              href="/settings/channels"
              className="inline-flex items-center gap-1.5 hover:text-blue-700"
            >
              <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
              Channel settings
            </Link>
          </li>
        </ul>
      </Card>
    </aside>
  )
}

void Plus
