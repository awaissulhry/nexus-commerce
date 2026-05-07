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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
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
import { useToast } from '@/components/ui/Toast'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from '@/lib/i18n/use-translations'
import PageHeader from '@/components/layout/PageHeader'
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
  const router = useRouter()
  const params = useSearchParams()
  const { t } = useTranslations()
  // C.4 — URL-driven tab + per-tab search. Bookmarkable, reload-stable.
  // Tab default 'groups' (auto-detected variation clusters); the
  // search/filters per tab live in their own components and read from
  // the same URL params via useSearchParams individually.
  const initialTab = ((): Tab => {
    const t = params.get('tab')
    if (t === 'standalone' || t === 'parents' || t === 'groups') return t
    return 'groups'
  })()
  const [tab, setTab] = useState<Tab>(initialTab)
  useEffect(() => {
    const next = new URLSearchParams(Array.from(params.entries()))
    if (tab === 'groups') next.delete('tab')
    else next.set('tab', tab)
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
  const { toast } = useToast()

  // U.8 — adapter so the existing tab signatures
  // (onStatus({ kind, text })) keep working while routing the message
  // through the global toast service. Replaces the inline auto-
  // dismissing banner that lived above the tab strip.
  const onStatus = useCallback(
    (s: { kind: 'success' | 'error'; text: string }) => {
      if (s.kind === 'success') toast.success(s.text)
      else toast.error(s.text)
    },
    [toast],
  )

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto space-y-5">
      {/* U.8 — switched from a custom h1 (text-[24px] arbitrary value)
          + ad-hoc header layout to the shared PageHeader. Brings the
          page onto the U.1 typography scale and matches the chrome of
          /products and /products/drafts. */}
      <PageHeader
        title={t('organize.title')}
        description={t('organize.description')}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/catalog' },
          { label: t('organize.title') },
        ]}
      />

      {/* Tab strip — U.8 made sticky so users can swap tabs without
          scrolling back up on long lists (Standalone tab can have
          1000+ rows). Translucent backdrop keeps body content
          readable behind the bar. */}
      <nav
        role="tablist"
        aria-label={t('organize.title')}
        className="sticky top-0 z-10 -mx-6 px-6 bg-white/85 backdrop-blur border-b border-slate-200 flex items-center gap-1 overflow-x-auto dark:bg-slate-950/85 dark:border-slate-800"
      >
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            type="button"
            role="tab"
            aria-selected={tab === tabDef.id}
            tabIndex={tab === tabDef.id ? 0 : -1}
            onClick={() => setTab(tabDef.id)}
            className={cn(
              'inline-flex items-center gap-2 h-10 px-4 text-md font-medium border-b-2 transition-colors whitespace-nowrap',
              tab === tabDef.id
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            {tabDef.id === 'groups' && <Layers className="w-3.5 h-3.5" />}
            {tabDef.id === 'standalone' && <Boxes className="w-3.5 h-3.5" />}
            {tabDef.id === 'parents' && <Package className="w-3.5 h-3.5" />}
            {tabDef.id === 'groups'
              ? t('organize.tab.groups')
              : tabDef.id === 'standalone'
                ? t('organize.tab.standalone')
                : t('organize.tab.parents')}
          </button>
        ))}
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
        <div className="min-w-0">
          {tab === 'groups' && (
            <GroupsTab
              onStatus={onStatus}
            />
          )}
          {tab === 'standalone' && (
            <StandaloneTab
              onStatus={onStatus}
            />
          )}
          {tab === 'parents' && (
            <ParentsTab onStatus={onStatus} />
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
  // C.4 — URL state for search. Shared `?q=` param across tabs so
  // a search persists when the user switches tabs (matches the
  // expectation that they're hunting for the same thing in different
  // views).
  const router = useRouter()
  const urlParams = useSearchParams()
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [search, setSearch] = useState(() => urlParams.get('q') ?? '')
  const [minConfidence, setMinConfidence] = useState(0)
  useEffect(() => {
    const next = new URLSearchParams(Array.from(urlParams.entries()))
    if (search.trim()) next.set('q', search.trim())
    else next.delete('q')
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

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
              className="w-full h-8 pl-8 pr-2 text-base border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-600">
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
            className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
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
        <div className="mt-2 flex items-center gap-4 text-sm text-slate-600">
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
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label="Loading suggested groups"
        >
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-slate-200 rounded-lg p-4"
            >
              <Skeleton variant="text" lines={2} />
            </div>
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
          <div className="text-md font-semibold text-slate-900 truncate">
            {group.baseName}
          </div>
          <div className="text-sm text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
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
                <span className="uppercase tracking-wide text-xs text-slate-400">
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
                  <div className="text-md font-medium text-slate-900 truncate font-mono">
                    {m.sku}
                  </div>
                  <div className="text-sm text-slate-500 truncate">
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
  // C.4 — URL state. ?q seeds search; ?coverage seeds the coverage
  // filter. Both flow back to the URL via the writeback effect.
  const router = useRouter()
  const urlParams = useSearchParams()
  const [search, setSearch] = useState(() => urlParams.get('q') ?? '')
  const [debouncedSearch, setDebouncedSearch] = useState(
    urlParams.get('q') ?? '',
  )
  const [coverage, setCoverage] = useState<
    'all' | 'unlisted' | 'partial' | 'complete'
  >(() => {
    const c = urlParams.get('coverage')
    return c === 'unlisted' || c === 'partial' || c === 'complete'
      ? c
      : 'all'
  })
  useEffect(() => {
    const next = new URLSearchParams(Array.from(urlParams.entries()))
    if (search.trim()) next.set('q', search.trim())
    else next.delete('q')
    if (coverage !== 'all') next.set('coverage', coverage)
    else next.delete('coverage')
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, coverage])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // C.4 — bulk promote target. When non-null, PromoteModal renders
  // in bulk mode and calls /pim/bulk-promote-to-parent.
  const [bulkPromoteOpen, setBulkPromoteOpen] = useState<
    StandaloneItem[] | null
  >(null)
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
              className="w-full h-8 pl-8 pr-2 text-base border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <select
            value={coverage}
            onChange={(e) => setCoverage(e.target.value as any)}
            className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white"
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
            className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
          {selected.size > 0 && (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  setAttachOpen({ productIds: Array.from(selected) })
                }
              >
                Attach {selected.size} to parent
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // C.4 — bulk promote uses the same PromoteModal in
                  // bulk mode. Resolves the StandaloneItem objects from
                  // the current items list since the modal needs SKUs
                  // for display + ids for the request.
                  const targets = items.filter((i) => selected.has(i.id))
                  setBulkPromoteOpen(targets)
                }}
              >
                <PackagePlus className="w-3.5 h-3.5" />
                Promote {selected.size} to parents
              </Button>
            </>
          )}
        </div>
        <div className="mt-2 text-sm text-slate-500">
          <strong className="text-slate-900">{items.length}</strong> shown of{' '}
          {total} standalone product{total === 1 ? '' : 's'}.
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div
          className="space-y-2"
          aria-busy="true"
          aria-label="Loading standalone products"
        >
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="border border-slate-200 rounded-lg bg-white p-3"
            >
              <Skeleton variant="text" lines={2} />
            </div>
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
          <table className="w-full text-base">
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
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Channels
                </th>
                <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Price
                </th>
                <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Stock
                </th>
                <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold">
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
                  <td className="px-3 py-2 font-mono text-sm">
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
                      <div className="text-xs text-slate-500">
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
                        className="h-6 px-2 text-xs rounded-md border border-slate-200 hover:bg-slate-100 text-slate-700"
                        title="Mark as parent (will accept variants)"
                      >
                        Promote
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachOpen({ productIds: [p.id] })
                        }
                        className="h-6 px-2 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700"
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

      {bulkPromoteOpen && bulkPromoteOpen.length > 0 && (
        <PromoteModal
          products={bulkPromoteOpen}
          onClose={() => setBulkPromoteOpen(null)}
          onPromoted={(count) => {
            onStatus({
              kind: 'success',
              text: `Promoted ${count ?? bulkPromoteOpen.length} product${(count ?? bulkPromoteOpen.length) === 1 ? '' : 's'} to parent.`,
            })
            setBulkPromoteOpen(null)
            setSelected(new Set())
            emitInvalidation({
              type: 'pim.changed',
              meta: {
                bulkPromoted: count ?? bulkPromoteOpen.length,
              },
            })
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
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border border-slate-200 bg-slate-50 text-slate-600">
        unlisted
      </span>
    )
  }
  return (
    <div className="flex items-center gap-1 flex-wrap max-w-[200px]">
      {cov.slots.slice(0, 4).map((s) => (
        <span
          key={s}
          className="font-mono text-xs px-1 py-0.5 rounded bg-slate-100 text-slate-700"
        >
          {s.replace(':', '·')}
        </span>
      ))}
      {cov.slots.length > 4 && (
        <span className="text-xs text-slate-500">
          +{cov.slots.length - 4}
        </span>
      )}
      {cov.status === 'partial' && (
        <span className="text-xs text-amber-700">
          {cov.draftCount + cov.failedCount > 0
            ? `${cov.draftCount}d/${cov.failedCount}f`
            : 'partial'}
        </span>
      )}
      {cov.status === 'complete' && (
        <span className="text-xs text-emerald-700">all live</span>
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
  // AttachModal's search is modal-internal (parent typeahead) — not
  // URL state. Stays as plain useState.
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

  // C.4 — axis values keep insertion order from the Set, which
  // mirrored DB-row order and felt random to the user. Sort
  // alphabetically when extracting so the dropdown reads
  // consistently (S/M/L style, Black/Brown/Red etc.). Numeric-aware
  // compare so '8' / '10' / '12' sort the right way.
  const valuesByAxis = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const ax of parentAxes) m.set(ax, [])
    for (const v of parentVariants) {
      for (const ax of parentAxes) {
        const val = v.attrs?.[ax]
        if (!val) continue
        const list = m.get(ax)!
        if (!list.includes(val)) list.push(val)
      }
    }
    for (const [ax, list] of m) {
      list.sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
      )
      m.set(ax, list)
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
    <Modal
      open
      onClose={() => !submitting && onClose()}
      title={`Attach ${productIds.length} product${productIds.length === 1 ? '' : 's'} to parent`}
      size="2xl"
      placement="top"
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
    >
      <div className="space-y-4">
        {/*
          C.4 — Modal primitive replaces the prior `fixed inset-0`
          overlay. Focus trap, body scroll lock, escape-to-close,
          restored focus on dismiss, and the X close button are all
          primitive-handled. Backdrop dismissal honors submitting so
          a mid-flight click can't dismount the modal.
        */}
          {!selected && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Search parent SKU or name
              </label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Min 2 characters"
                  className="w-full h-8 pl-8 pr-2 text-base border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div className="mt-2 max-h-[200px] overflow-y-auto border border-slate-100 rounded-md">
                {searching && (
                  <div className="px-3 py-2 text-sm text-slate-500 inline-flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Searching…
                  </div>
                )}
                {!searching && results.length === 0 && search.trim().length >= 2 && (
                  <div className="px-3 py-3 text-sm text-slate-500 text-center">
                    No parents match.
                  </div>
                )}
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className="w-full text-left px-3 py-2 text-base hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                  >
                    <div className="font-mono text-slate-900">{p.sku}</div>
                    <div className="text-xs text-slate-500 truncate">
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
                  <div className="text-sm text-slate-500">Parent</div>
                  <div className="font-mono text-md text-slate-900">
                    {selected.sku}
                  </div>
                  <div className="text-sm text-slate-600">
                    {selected.name}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-xs text-slate-500 hover:underline"
                >
                  change
                </button>
              </div>

              {parentAxes.length > 0 && parentVariants.length > 0 && (
                <div className="border border-slate-200 rounded-md px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-1">
                    Existing variants under this parent
                  </div>
                  <div className="text-sm text-slate-600 max-h-[100px] overflow-y-auto">
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
                      <div className="text-xs text-slate-400">
                        …and {parentVariants.length - 8} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <div className="text-sm font-medium text-slate-700 mb-1">
                  Set axis values per product (optional but recommended)
                </div>
                {parentAxes.length === 0 ? (
                  <p className="text-sm text-slate-500 italic">
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
      <ModalFooter>
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
      </ModalFooter>
    </Modal>
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
  /** C.4 — sorted string list (alphabetical, numeric-aware) instead
   *  of an unordered Set. The Map shape stays so callers don't have
   *  to change their lookups. */
  valuesByAxis: Map<string, string[]>
  onChange: (axis: string, value: string) => void
}) {
  return (
    <div className="border border-slate-200 rounded-md p-2.5 bg-slate-50/30">
      <div className="text-xs font-mono text-slate-500 mb-1.5 truncate">
        {productId}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {axes.map((axis) => {
          const known = valuesByAxis.get(axis) ?? []
          const v = values[axis] ?? ''
          const isCustom = v !== '' && !known.includes(v)
          return (
            <div key={axis}>
              <div className="text-xs text-slate-500 mb-0.5">{axis}</div>
              <select
                value={isCustom ? '__custom__' : v}
                onChange={(e) => {
                  if (e.target.value === '__custom__') onChange(axis, '')
                  else onChange(axis, e.target.value)
                }}
                className="w-full h-7 px-2 text-base border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
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
                  className="mt-1 w-full h-7 px-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// C.4 — guided theme picker. Replaces the prior free-text input
// that left the user staring at a blank field. The 5 common themes
// cover ~90% of motorcycle/apparel catalogs; "Custom…" preserves
// the free-text path for unusual cases. Format matches what
// /pim/promote-to-parent already accepts: '/'-separated axis names.
const COMMON_THEMES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'Size', label: 'Size', hint: 'XS / S / M / L / XL' },
  { value: 'Color', label: 'Color', hint: 'Black / Brown / Red…' },
  { value: 'Size / Color', label: 'Size + Color', hint: 'Apparel default' },
  {
    value: 'Size / Material',
    label: 'Size + Material',
    hint: 'Boots, jackets',
  },
  {
    value: 'BodyType / Size',
    label: 'Body type + Size',
    hint: "Men's / Women's / Kids'",
  },
]

function PromoteModal({
  product,
  // C.4 — bulk variant: when products is provided, the modal calls
  // /pim/bulk-promote-to-parent instead of the single endpoint and
  // shows aggregate copy.
  products,
  onClose,
  onPromoted,
  onError,
}: {
  product?: StandaloneItem
  products?: StandaloneItem[]
  onClose: () => void
  onPromoted: (count?: number) => void
  onError: (text: string) => void
}) {
  // Picker state: which theme tile is selected, or 'CUSTOM' for free-text.
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null)
  const [customTheme, setCustomTheme] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const isBulk = !!products && products.length > 0
  const targets = isBulk ? products! : product ? [product] : []
  const titleSku =
    targets.length === 1
      ? targets[0]!.sku
      : `${targets.length} products`

  const effectiveTheme =
    selectedTheme === 'CUSTOM'
      ? customTheme.trim()
      : selectedTheme ?? ''

  return (
    <Modal
      open
      onClose={() => !submitting && onClose()}
      title={`Promote ${titleSku} to parent${targets.length === 1 ? '' : 's'}`}
      size="lg"
      placement="top"
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
    >
      <div className="space-y-4">
        <p className="text-base text-slate-700">
          {isBulk
            ? `Marks ${targets.length} products as parents. You can attach standalones to them from this page; existing variants on each product carry through.`
            : 'Marks this product as a parent. You can then add child variants from the Variations tab on its edit page, or attach existing standalones to it from this page.'}
        </p>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Variation theme{' '}
            <span className="font-normal text-xs text-slate-500">
              (optional — controls which axes children share)
            </span>
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {COMMON_THEMES.map((t) => {
              const active = selectedTheme === t.value
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setSelectedTheme(t.value)}
                  disabled={submitting}
                  className={cn(
                    'text-left rounded-md border px-2.5 py-2 transition-colors',
                    active
                      ? 'border-blue-300 bg-blue-50/40 ring-1 ring-blue-200'
                      : 'border-slate-200 bg-white hover:border-slate-300',
                    submitting && 'opacity-50 cursor-not-allowed',
                  )}
                  aria-pressed={active}
                >
                  <div className="text-base font-medium text-slate-900">
                    {t.label}
                  </div>
                  <div className="text-xs text-slate-500">{t.hint}</div>
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setSelectedTheme('CUSTOM')}
              disabled={submitting}
              className={cn(
                'text-left rounded-md border px-2.5 py-2 transition-colors',
                selectedTheme === 'CUSTOM'
                  ? 'border-blue-300 bg-blue-50/40 ring-1 ring-blue-200'
                  : 'border-slate-200 bg-white hover:border-slate-300',
                submitting && 'opacity-50 cursor-not-allowed',
              )}
              aria-pressed={selectedTheme === 'CUSTOM'}
            >
              <div className="text-base font-medium text-slate-900">
                Custom…
              </div>
              <div className="text-xs text-slate-500">
                Free-form, e.g. "Color / Material"
              </div>
            </button>
            <button
              type="button"
              onClick={() => setSelectedTheme(null)}
              disabled={submitting}
              className={cn(
                'text-left rounded-md border px-2.5 py-2 transition-colors',
                selectedTheme === null
                  ? 'border-blue-300 bg-blue-50/40 ring-1 ring-blue-200'
                  : 'border-slate-200 bg-white hover:border-slate-300',
                submitting && 'opacity-50 cursor-not-allowed',
              )}
              aria-pressed={selectedTheme === null}
            >
              <div className="text-base font-medium text-slate-900">
                No theme yet
              </div>
              <div className="text-xs text-slate-500">
                Set later from the parent's Variations tab
              </div>
            </button>
          </div>

          {selectedTheme === 'CUSTOM' && (
            <input
              type="text"
              value={customTheme}
              onChange={(e) => setCustomTheme(e.target.value)}
              placeholder="Size / Color"
              autoFocus
              className="mt-2 w-full h-8 px-2.5 text-base border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              disabled={submitting}
            />
          )}
        </div>
      </div>
      <ModalFooter>
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
          disabled={
            submitting ||
            (selectedTheme === 'CUSTOM' && customTheme.trim().length === 0)
          }
          onClick={async () => {
            setSubmitting(true)
            try {
              const axes = effectiveTheme
                ? effectiveTheme.split(/\s*\/\s*/).filter(Boolean)
                : undefined
              if (isBulk) {
                const res = await fetch(
                  `${getBackendUrl()}/api/pim/bulk-promote-to-parent`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Idempotency-Key': `pim-bulk-promote:${targets
                        .map((t) => t.id)
                        .sort()
                        .join(',')}`,
                    },
                    body: JSON.stringify({
                      productIds: targets.map((t) => t.id),
                      variationTheme: effectiveTheme || undefined,
                      variationAxes: axes,
                    }),
                  },
                )
                const json = await res.json().catch(() => ({}))
                if (!res.ok || json?.success === false) {
                  onError(
                    json?.error ?? `Bulk promote failed (HTTP ${res.status})`,
                  )
                  return
                }
                onPromoted(json.promoted ?? targets.length)
              } else {
                const res = await fetch(
                  `${getBackendUrl()}/api/pim/promote-to-parent`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Idempotency-Key': `pim-promote:${targets[0]!.id}`,
                    },
                    body: JSON.stringify({
                      productId: targets[0]!.id,
                      variationTheme: effectiveTheme || undefined,
                      variationAxes: axes,
                    }),
                  },
                )
                const json = await res.json().catch(() => ({}))
                if (!res.ok || json?.success === false) {
                  onError(
                    json?.error ?? `Promote failed (HTTP ${res.status})`,
                  )
                  return
                }
                onPromoted(1)
              }
            } catch (err) {
              onError(err instanceof Error ? err.message : String(err))
            } finally {
              setSubmitting(false)
            }
          }}
        >
          {isBulk
            ? `Promote ${targets.length} to parents`
            : 'Promote to parent'}
        </Button>
      </ModalFooter>
    </Modal>
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
  const router = useRouter()
  const urlParams = useSearchParams()
  const [search, setSearch] = useState(() => urlParams.get('q') ?? '')
  const [debouncedSearch, setDebouncedSearch] = useState(
    urlParams.get('q') ?? '',
  )
  const [incompleteOnly, setIncompleteOnly] = useState(
    urlParams.get('incomplete') === '1',
  )
  useEffect(() => {
    const next = new URLSearchParams(Array.from(urlParams.entries()))
    if (search.trim()) next.set('q', search.trim())
    else next.delete('q')
    if (incompleteOnly) next.set('incomplete', '1')
    else next.delete('incomplete')
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, incompleteOnly])
  // C.4 / A.5 — child-list preview state. expandedId = which parent's
  // children panel is open. childrenByParent caches the fetched
  // children so collapsing + re-expanding doesn't re-fetch.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [childrenByParent, setChildrenByParent] = useState<
    Record<
      string,
      {
        loading: boolean
        children: Array<{
          id: string
          sku: string
          name: string
          variantAttributes: Record<string, unknown> | null
          amazonAsin: string | null
          ebayItemId: string | null
        }> | null
        error: string | null
      }
    >
  >({})
  const [selectedChildren, setSelectedChildren] = useState<Set<string>>(
    new Set(),
  )
  const confirm = useConfirm()
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

  // C.4 / A.5 — fetch children for a parent on first expand. Hits
  // the new /pim/parent/:id/children endpoint; cached in state so
  // subsequent toggles are free. invalidationTypes on the outer
  // poll already include pim.changed, so a detach elsewhere triggers
  // a refetch of the list — for the inline panel we re-fetch on
  // demand below after a successful detach.
  const loadChildren = useCallback(
    async (parentId: string, force = false) => {
      if (!force && childrenByParent[parentId]?.children) return
      setChildrenByParent((s) => ({
        ...s,
        [parentId]: { loading: true, children: null, error: null },
      }))
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/pim/parent/${encodeURIComponent(parentId)}/children`,
        )
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          setChildrenByParent((s) => ({
            ...s,
            [parentId]: {
              loading: false,
              children: null,
              error: json?.error ?? `HTTP ${res.status}`,
            },
          }))
          return
        }
        setChildrenByParent((s) => ({
          ...s,
          [parentId]: {
            loading: false,
            children: json.children ?? [],
            error: null,
          },
        }))
      } catch (err) {
        setChildrenByParent((s) => ({
          ...s,
          [parentId]: {
            loading: false,
            children: null,
            error: err instanceof Error ? err.message : String(err),
          },
        }))
      }
    },
    [childrenByParent],
  )

  const toggleExpand = useCallback(
    (parentId: string) => {
      setExpandedId((cur) => {
        const next = cur === parentId ? null : parentId
        if (next) void loadChildren(next)
        return next
      })
      // Clear cross-parent selection when switching panels.
      setSelectedChildren(new Set())
    },
    [loadChildren],
  )

  const performDetach = useCallback(
    async (parentId: string, childIds: string[]) => {
      if (childIds.length === 0) return
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/amazon/pim/unlink-child`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productIds: childIds }),
          },
        )
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json?.success === false) {
          onStatus({
            kind: 'error',
            text: json?.error ?? `Detach failed (HTTP ${res.status})`,
          })
          return
        }
        onStatus({
          kind: 'success',
          text: `Detached ${json.detached ?? childIds.length} child${(json.detached ?? childIds.length) === 1 ? '' : 'ren'}.`,
        })
        emitInvalidation({
          type: 'pim.changed',
          meta: { detached: json.detached ?? childIds.length },
        })
        setSelectedChildren((s) => {
          const next = new Set(s)
          for (const id of childIds) next.delete(id)
          return next
        })
        await loadChildren(parentId, true)
        await refetch()
      } catch (err) {
        onStatus({
          kind: 'error',
          text: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [onStatus, loadChildren, refetch],
  )

  const onDetachOne = useCallback(
    async (parentId: string, child: { id: string; sku: string }) => {
      const ok = await confirm({
        title: `Detach ${child.sku}?`,
        description:
          'The child will become a standalone product. Listings remain on the channels — only the catalog hierarchy changes.',
        confirmLabel: 'Detach',
        tone: 'danger',
      })
      if (!ok) return
      await performDetach(parentId, [child.id])
    },
    [confirm, performDetach],
  )

  const onDetachBulk = useCallback(
    async (parentId: string) => {
      const ids = Array.from(selectedChildren)
      if (ids.length === 0) return
      const ok = await confirm({
        title: `Detach ${ids.length} child${ids.length === 1 ? '' : 'ren'}?`,
        description:
          'They become standalone products. Listings on channels are kept; only the catalog hierarchy changes.',
        confirmLabel: 'Detach selected',
        tone: 'danger',
      })
      if (!ok) return
      await performDetach(parentId, ids)
    },
    [selectedChildren, confirm, performDetach],
  )

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
              className="w-full h-8 pl-8 pr-2 text-base border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
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
            className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
        </div>
        <div className="mt-2 text-sm text-slate-500">
          <strong className="text-slate-900">{items.length}</strong> shown of{' '}
          {total} parent product{total === 1 ? '' : 's'}.
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div
          className="space-y-2"
          aria-busy="true"
          aria-label="Loading parents"
        >
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="border border-slate-200 rounded-lg p-3 bg-white"
            >
              <Skeleton variant="text" lines={2} />
            </div>
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
          <table className="w-full text-base">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 w-[36px]" />
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Theme
                </th>
                <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Children
                </th>
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Listings
                </th>
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Channels
                </th>
                <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const isExpanded = expandedId === p.id
                const panel = childrenByParent[p.id]
                return (
                  <Fragment key={p.id}>
                    <tr
                      className={cn(
                        'border-t border-slate-100',
                        isExpanded
                          ? 'bg-blue-50/40'
                          : 'hover:bg-slate-50/50',
                      )}
                    >
                      <td className="px-3 py-2">
                        <Tooltip
                          content={
                            isExpanded
                              ? 'Collapse children'
                              : 'Show children inline'
                          }
                          placement="right"
                        >
                          <button
                            type="button"
                            onClick={() => toggleExpand(p.id)}
                            disabled={p.childCount === 0}
                            aria-expanded={isExpanded}
                            aria-controls={`children-${p.id}`}
                            aria-label={
                              isExpanded
                                ? 'Collapse children'
                                : 'Show children inline'
                            }
                            className={cn(
                              'inline-flex items-center justify-center w-6 h-6 rounded text-slate-500',
                              p.childCount === 0
                                ? 'opacity-30 cursor-not-allowed'
                                : 'hover:bg-slate-100 hover:text-slate-900',
                            )}
                          >
                            <ChevronRight
                              className={cn(
                                'w-3.5 h-3.5 transition-transform',
                                isExpanded && 'rotate-90',
                              )}
                            />
                          </button>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2 font-mono text-sm">
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
                          <div className="text-xs text-slate-500">
                            {p.brand}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {p.variationTheme ? (
                          <span className="text-slate-700">
                            {p.variationTheme}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span
                          className={
                            p.childCount === 0
                              ? 'text-amber-600'
                              : 'text-slate-700'
                          }
                        >
                          {p.childCount}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="inline-flex gap-1">
                          <span className="px-1.5 py-0.5 text-xs rounded border border-emerald-200 bg-emerald-50 text-emerald-700 tabular-nums">
                            {p.listings.live} live
                          </span>
                          {p.listings.draft > 0 && (
                            <span className="px-1.5 py-0.5 text-xs rounded border border-amber-200 bg-amber-50 text-amber-700 tabular-nums">
                              {p.listings.draft} draft
                            </span>
                          )}
                          {p.listings.failed > 0 && (
                            <span className="px-1.5 py-0.5 text-xs rounded border border-rose-200 bg-rose-50 text-rose-700 tabular-nums">
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
                              className="font-mono text-xs px-1 py-0.5 rounded bg-slate-100 text-slate-700"
                            >
                              {c.replace(':', '·')}
                            </span>
                          ))}
                          {p.listings.channels.length > 4 && (
                            <span className="text-xs text-slate-500">
                              +{p.listings.channels.length - 4}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/products/${p.id}/edit`}
                          className="inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border border-slate-200 hover:bg-slate-50 text-slate-700"
                        >
                          Open
                          <ChevronRight className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr id={`children-${p.id}`}>
                        <td
                          colSpan={8}
                          className="bg-slate-50/60 border-t border-slate-100 px-4 py-3"
                        >
                          {panel?.loading && (
                            <div
                              className="space-y-1.5"
                              aria-busy="true"
                            >
                              <Skeleton variant="text" lines={3} />
                            </div>
                          )}
                          {panel?.error && !panel.loading && (
                            <div className="text-sm text-rose-700">
                              Failed to load children: {panel.error}
                            </div>
                          )}
                          {panel?.children && (
                            <div className="space-y-2">
                              {selectedChildren.size > 0 && (
                                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-blue-50 border border-blue-200">
                                  <span className="text-base font-medium text-blue-900 tabular-nums">
                                    {selectedChildren.size} selected
                                  </span>
                                  <span className="text-blue-300">·</span>
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => void onDetachBulk(p.id)}
                                  >
                                    Detach {selectedChildren.size}
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                      setSelectedChildren(new Set())
                                    }
                                  >
                                    Clear
                                  </Button>
                                </div>
                              )}
                              {panel.children.length === 0 ? (
                                <div className="text-sm text-slate-500 px-2 py-1">
                                  No children — this parent is empty.
                                </div>
                              ) : (
                                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md bg-white">
                                  {panel.children.map((c) => {
                                    const checked = selectedChildren.has(c.id)
                                    const attrs = c.variantAttributes
                                      ? Object.entries(c.variantAttributes)
                                          .map(
                                            ([k, v]) =>
                                              `${k}=${String(v ?? '')}`,
                                          )
                                          .join(' · ')
                                      : ''
                                    return (
                                      <li
                                        key={c.id}
                                        className="flex items-center gap-3 px-3 py-2 text-sm"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() =>
                                            setSelectedChildren((s) => {
                                              const next = new Set(s)
                                              if (next.has(c.id))
                                                next.delete(c.id)
                                              else next.add(c.id)
                                              return next
                                            })
                                          }
                                          aria-label={`Select ${c.sku}`}
                                          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
                                        />
                                        <div className="font-mono text-slate-700 min-w-[120px]">
                                          {c.sku}
                                        </div>
                                        <div className="flex-1 min-w-0 truncate text-slate-700">
                                          {c.name}
                                        </div>
                                        {attrs && (
                                          <div className="text-xs text-slate-500 truncate max-w-[260px]">
                                            {attrs}
                                          </div>
                                        )}
                                        <div className="flex items-center gap-1">
                                          <Link
                                            href={`/products/${c.id}/edit`}
                                            className="inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border border-slate-200 hover:bg-slate-50 text-slate-700"
                                          >
                                            Open
                                            <ChevronRight className="w-3 h-3" />
                                          </Link>
                                          <Tooltip
                                            content="Detach from parent"
                                            placement="top"
                                          >
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void onDetachOne(p.id, c)
                                              }
                                              aria-label="Detach from parent"
                                              className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-rose-700 hover:bg-rose-50"
                                            >
                                              <X className="w-3.5 h-3.5" />
                                            </button>
                                          </Tooltip>
                                        </div>
                                      </li>
                                    )
                                  })}
                                </ul>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
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
        <div className="text-sm text-slate-600 leading-snug space-y-2">
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
        <ul className="text-base text-slate-700 space-y-1">
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
