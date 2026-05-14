'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  History as HistoryIcon,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  User,
  Webhook,
  X,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface AuditEntry {
  id: string
  userId: string | null
  ip: string | null
  entityType: string
  entityId: string
  action: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

interface FacetEntry {
  value: string
  count: number
}

interface SearchResponse {
  success: boolean
  items: AuditEntry[]
  nextCursor: string | null
  facets: {
    entityType: FacetEntry[]
    action: FacetEntry[]
  }
}

const ACTION_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
  create: 'success',
  update: 'info',
  delete: 'danger',
  submit: 'warning',
  replicate: 'info',
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

function formatStateValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function diffEntries(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Array<{ key: string; before: unknown; after: unknown; changed: boolean }> {
  const keys = new Set<string>()
  if (before) Object.keys(before).forEach((k) => keys.add(k))
  if (after) Object.keys(after).forEach((k) => keys.add(k))
  return Array.from(keys).map((key) => {
    const b = before ? before[key] : undefined
    const a = after ? after[key] : undefined
    return {
      key,
      before: b,
      after: a,
      changed: JSON.stringify(b) !== JSON.stringify(a),
    }
  })
}

function EntryRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false)
  const diffs = expanded ? diffEntries(entry.before, entry.after) : []
  const changed = diffs.filter((d) => d.changed)

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left"
      >
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
          )}
        </div>
        <Badge variant={ACTION_VARIANT[entry.action] ?? 'default'} size="sm">
          {entry.action}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-medium text-slate-900 dark:text-slate-100">
              {entry.entityType}
            </span>
            <span className="font-mono text-sm text-slate-600 dark:text-slate-400">
              {entry.entityId.slice(0, 16)}
              {entry.entityId.length > 16 && '…'}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            <span title={new Date(entry.createdAt).toLocaleString()}>
              {relativeTime(entry.createdAt)}
            </span>
            {entry.userId && <span>· {entry.userId}</span>}
            {entry.ip && (
              <span className="font-mono text-xs text-slate-400 dark:text-slate-500">
                · {entry.ip}
              </span>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 px-4 py-3 space-y-3">
          {changed.length > 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded">
              <div className="px-3 py-1.5 border-b border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                Diff ({changed.length} changed{diffs.length !== changed.length && ` of ${diffs.length}`})
              </div>
              <div className="divide-y divide-slate-100">
                {diffs.map((d) => (
                  <div
                    key={d.key}
                    className={cn(
                      'px-3 py-1.5 text-sm flex items-start gap-2',
                      !d.changed && 'opacity-60',
                    )}
                  >
                    <span className="font-medium text-slate-700 dark:text-slate-300 w-32 flex-shrink-0">
                      {d.key}
                    </span>
                    <span
                      className={cn(
                        'font-mono break-all',
                        d.changed ? 'text-slate-500 dark:text-slate-400 line-through' : 'text-slate-500 dark:text-slate-400',
                      )}
                    >
                      {formatStateValue(d.before)}
                    </span>
                    {d.changed && (
                      <>
                        <ArrowRight className="w-3 h-3 text-slate-400 dark:text-slate-500 flex-shrink-0 mt-0.5" />
                        <span className="font-mono text-slate-900 dark:text-slate-100 font-medium break-all">
                          {formatStateValue(d.after)}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-500 dark:text-slate-400 italic">
              No diff available (before/after empty).
            </div>
          )}

          {entry.metadata && Object.keys(entry.metadata).length > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded">
              <div className="px-3 py-1.5 border-b border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                Metadata
              </div>
              <pre className="px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── ES.4: Event Log mode ──────────────────────────────────────────────

type EventSource = 'OPERATOR' | 'API' | 'WEBHOOK' | 'AUTOMATION' | 'AI' | 'FLAT_FILE_IMPORT' | 'SYSTEM'

interface ProductEvent {
  id: string
  aggregateId: string
  aggregateType: string
  eventType: string
  data: Record<string, unknown> | null
  metadata: { source?: EventSource; userId?: string; fileName?: string; flatFileType?: string; rowCount?: number; bulkOperationId?: string } | null
  createdAt: string
}

const EVENT_SOURCE_FILTERS = [
  { value: 'all', label: 'All Sources' },
  { value: 'OPERATOR', label: 'Operator' },
  { value: 'FLAT_FILE_IMPORT', label: 'Flat File' },
  { value: 'AUTOMATION', label: 'Automation' },
  { value: 'AI', label: 'AI' },
  { value: 'WEBHOOK', label: 'Webhook' },
  { value: 'SYSTEM', label: 'System' },
]

function EventSourceIcon({ source }: { source?: EventSource }) {
  const cls = 'h-3.5 w-3.5'
  switch (source) {
    case 'FLAT_FILE_IMPORT': return <FileSpreadsheet className={cls} />
    case 'AUTOMATION': return <Zap className={cls} />
    case 'AI': return <Bot className={cls} />
    case 'WEBHOOK': return <Webhook className={cls} />
    case 'SYSTEM': return <Settings2 className={cls} />
    default: return <User className={cls} />
  }
}

function EventFeed() {
  const [events, setEvents] = useState<ProductEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fetchEvents = useCallback(async (cursor?: string) => {
    if (!cursor) setLoading(true); else setLoadingMore(true)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (sourceFilter !== 'all') params.set('source', sourceFilter)
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(`${getBackendUrl()}/api/events?${params}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: { events: ProductEvent[]; nextCursor: string | null } = await res.json()
      if (!cursor) setEvents(json.events); else setEvents(prev => [...prev, ...json.events])
      setNextCursor(json.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false); setLoadingMore(false)
    }
  }, [sourceFilter])

  useEffect(() => { void fetchEvents() }, [fetchEvents])

  const toggleExpand = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="space-y-3">
      {/* Source filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {EVENT_SOURCE_FILTERS.map(f => (
          <button key={f.value} onClick={() => setSourceFilter(f.value)}
            className={cn('px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
              sourceFilter === f.value
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
            )}>
            {f.label}
          </button>
        ))}
      </div>

      {loading && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>}
      {!loading && error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}
      {!loading && !error && events.length === 0 && (
        <div className="text-center py-12 text-sm text-slate-400">No events found. Run the backfill first.</div>
      )}
      {!loading && events.length > 0 && (
        <div className="space-y-1">
          {events.map(ev => {
            const source = ev.metadata?.source
            const isOpen = expanded.has(ev.id)
            const dataEntries = ev.data ? Object.entries(ev.data) : []
            return (
              <div key={ev.id} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                <button onClick={() => toggleExpand(ev.id)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                  <EventSourceIcon source={source} />
                  <Badge variant="default" size="sm">{ev.aggregateType}</Badge>
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200 flex-1 truncate">
                    {ev.eventType.replace(/_/g, ' ')}
                    {ev.metadata?.fileName && <span className="ml-2 font-normal text-slate-500">· {ev.metadata.fileName}</span>}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0">{relativeTime(ev.createdAt)}</span>
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />}
                </button>
                {isOpen && dataEntries.length > 0 && (
                  <div className="border-t border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                    {dataEntries.map(([k, v]) => (
                      <div key={k} className="flex gap-2 px-3 py-1.5 text-xs font-mono">
                        <span className="text-slate-500 w-40 shrink-0 truncate">{k}</span>
                        <span className="text-slate-800 dark:text-slate-200 truncate">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {nextCursor && (
            <div className="pt-2">
              <button onClick={() => fetchEvents(nextCursor)} disabled={loadingMore}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1.5">
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Load older events
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function AuditLogClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  // URL-shareable filter state.
  const urlEntityType = searchParams.get('entityType') ?? ''
  const urlEntityId = searchParams.get('entityId') ?? ''
  // O.74: drawer "View full audit log" links pass a comma-separated
  // entityIds for multi-package orders. Backend resolves it to an
  // IN clause; the client just forwards.
  const urlEntityIds = searchParams.get('entityIds') ?? ''
  const urlAction = searchParams.get('action') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const urlSince = searchParams.get('since') ?? ''

  const [mode, setMode] = useState<'audit' | 'events'>('audit')
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch)
  const [data, setData] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const debounceTimer = useRef<number | null>(null)

  // Debounce search → URL
  useEffect(() => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current)
    debounceTimer.current = window.setTimeout(() => {
      setDebouncedSearch(searchInput)
    }, 300)
    return () => {
      if (debounceTimer.current) window.clearTimeout(debounceTimer.current)
    }
  }, [searchInput])

  const updateUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (!v) params.delete(k)
        else params.set(k, v)
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  // Sync debounced search → URL
  useEffect(() => {
    if (debouncedSearch !== urlSearch) {
      updateUrl({ search: debouncedSearch })
    }
  }, [debouncedSearch, urlSearch, updateUrl])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const url = new URL(`${getBackendUrl()}/api/audit-log/search`)
      if (urlEntityType) url.searchParams.set('entityType', urlEntityType)
      if (urlEntityId) url.searchParams.set('entityId', urlEntityId)
      else if (urlEntityIds) url.searchParams.set('entityIds', urlEntityIds)
      if (urlAction) url.searchParams.set('action', urlAction)
      if (urlSearch) url.searchParams.set('search', urlSearch)
      if (urlSince) url.searchParams.set('since', urlSince)
      url.searchParams.set('limit', '50')
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [urlEntityType, urlEntityId, urlEntityIds, urlAction, urlSearch, urlSince])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Time-window quick filters
  const SINCE_PRESETS = useMemo(
    () => [
      { key: '', label: 'All time' },
      { key: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), label: 'Last 24h' },
      { key: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), label: 'Last 7d' },
      { key: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), label: 'Last 30d' },
    ],
    [],
  )

  return (
    <div className="space-y-3">
      {/* ES.4 — Mode toggle: Audit Log vs Event Log */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 w-fit">
        {(['audit', 'events'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={cn('px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              mode === m
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
            )}>
            {m === 'audit' ? 'Audit Log' : 'Event Log'}
          </button>
        ))}
      </div>

      {/* ES.4 — Event Log feed */}
      {mode === 'events' && <EventFeed />}

      {/* Original Audit Log (hidden when mode = events) */}
      {mode === 'audit' && <>
      {/* Filter bar */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500 pointer-events-none" />
            <Input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by entityId, type, action, user…"
              className="pl-7"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                aria-label="Clear"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchData}
            disabled={loading}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {/* Time chips */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-sm text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide mr-1">
            Time:
          </span>
          {SINCE_PRESETS.map((p) => {
            const active = urlSince === p.key
            return (
              <button
                key={p.key || 'all'}
                type="button"
                onClick={() => updateUrl({ since: p.key })}
                className={cn(
                  'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                  active
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {p.label}
              </button>
            )
          })}
        </div>

        {/* Entity type chips */}
        {data?.facets?.entityType && data.facets.entityType.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-sm text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide mr-1">
              Type:
            </span>
            <button
              type="button"
              onClick={() => updateUrl({ entityType: '' })}
              className={cn(
                'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                !urlEntityType
                  ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              All
            </button>
            {data.facets.entityType.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => updateUrl({ entityType: f.value })}
                className={cn(
                  'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                  urlEntityType === f.value
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {f.value}
                <span className="ml-1 opacity-70">{f.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Action chips */}
        {data?.facets?.action && data.facets.action.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-sm text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide mr-1">
              Action:
            </span>
            <button
              type="button"
              onClick={() => updateUrl({ action: '' })}
              className={cn(
                'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                !urlAction
                  ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              All
            </button>
            {data.facets.action.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => updateUrl({ action: f.value })}
                className={cn(
                  'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                  urlAction === f.value
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {f.value}
                <span className="ml-1 opacity-70">{f.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {data && data.items.length === 0 && !loading && (
        <EmptyState
          icon={HistoryIcon}
          title="No audit entries match these filters"
          description="Try widening the time window, removing filters, or clearing the search box."
        />
      )}

      {data && data.items.length > 0 && (
        <div className="space-y-1.5">
          {data.items.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
          {data.nextCursor && (
            <div className="text-center py-2">
              <button
                type="button"
                onClick={() => {
                  toast.info('Pagination — load more not yet wired (PR follow-up)')
                }}
                className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 italic"
              >
                More entries available · cursor pagination coming
              </button>
            </div>
          )}
        </div>
      )}
      </> /* end mode === 'audit' */}
    </div>
  )
}
