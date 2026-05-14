'use client'

/**
 * ES.4 — Timeline tab on /products/[id]/edit.
 *
 * Shows the ProductEvent log scoped to this product with source-aware
 * rendering. Flat-file imports are grouped as batch rows (one row per
 * import call, expandable to per-field delta). Operator edits, bulk
 * ops, and AI events each get a distinct icon + badge colour.
 *
 * Falls back to the legacy AuditLog feed if no ProductEvents exist
 * yet (products touched before ES.2 wiring).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Settings2,
  User,
  Webhook,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { SnapshotModal } from './SnapshotModal'

// ── Types ─────────────────────────────────────────────────────────────

type EventSource =
  | 'OPERATOR'
  | 'API'
  | 'WEBHOOK'
  | 'AUTOMATION'
  | 'AI'
  | 'FLAT_FILE_IMPORT'
  | 'SYSTEM'

interface ProductEvent {
  id: string
  aggregateId: string
  aggregateType: string
  eventType: string
  data: Record<string, unknown> | null
  metadata: {
    source?: EventSource
    userId?: string | null
    ip?: string | null
    fileName?: string
    flatFileType?: string
    rowIndex?: number
    importJobId?: string
    bulkOperationId?: string
    automationRuleId?: string
    rowCount?: number
  } | null
  createdAt: string
}

interface AuditRow {
  id: string
  entityType: string
  entityId: string
  action: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

interface Props {
  product: { id: string; sku: string; version?: number }
  discardSignal: number
  onDirtyChange: (count: number) => void
}

// ── Helpers ───────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<EventSource, string> = {
  OPERATOR: 'Operator',
  API: 'API',
  WEBHOOK: 'Webhook',
  AUTOMATION: 'Automation',
  AI: 'AI',
  FLAT_FILE_IMPORT: 'Flat File',
  SYSTEM: 'System',
}

const SOURCE_BADGE: Record<EventSource, 'default' | 'info' | 'success' | 'warning' | 'danger'> = {
  OPERATOR: 'info',
  API: 'default',
  WEBHOOK: 'default',
  AUTOMATION: 'warning',
  AI: 'success',
  FLAT_FILE_IMPORT: 'warning',
  SYSTEM: 'default',
}

function SourceIcon({ source, className }: { source?: EventSource; className?: string }) {
  const cls = cn('h-3.5 w-3.5', className)
  switch (source) {
    case 'FLAT_FILE_IMPORT': return <FileSpreadsheet className={cls} />
    case 'AUTOMATION': return <Zap className={cls} />
    case 'AI': return <Bot className={cls} />
    case 'WEBHOOK': return <Webhook className={cls} />
    case 'SYSTEM': return <Settings2 className={cls} />
    default: return <User className={cls} />
  }
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
  return day < 30 ? `${day}d ago` : new Date(iso).toLocaleDateString()
}

function eventLabel(eventType: string): string {
  return eventType
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}

// ── Source filter chips ────────────────────────────────────────────────

const SOURCE_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'OPERATOR', label: 'Operator' },
  { value: 'FLAT_FILE_IMPORT', label: 'Flat File' },
  { value: 'AUTOMATION', label: 'Automation' },
  { value: 'AI', label: 'AI' },
  { value: 'WEBHOOK', label: 'Webhook' },
  { value: 'SYSTEM', label: 'System' },
]

// ── Event row ─────────────────────────────────────────────────────────

function EventRow({ event }: { event: ProductEvent }) {
  const [expanded, setExpanded] = useState(false)
  const source = event.metadata?.source ?? 'OPERATOR'
  const isFlatFile = source === 'FLAT_FILE_IMPORT'
  const dataEntries = event.data ? Object.entries(event.data) : []

  return (
    <div className="relative pl-8">
      {/* Timeline dot */}
      <span
        className={cn(
          'absolute left-2.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-slate-900',
          isFlatFile
            ? 'bg-amber-400'
            : source === 'AI'
            ? 'bg-emerald-400'
            : source === 'AUTOMATION'
            ? 'bg-violet-400'
            : 'bg-blue-400',
        )}
      />

      <div className="pb-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <Badge variant={SOURCE_BADGE[source]} size="sm">
              <SourceIcon source={source} className="mr-1" />
              {SOURCE_LABELS[source]}
            </Badge>
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {eventLabel(event.eventType)}
            </span>
            {isFlatFile && event.metadata?.fileName && (
              <span className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[180px]">
                · {event.metadata.fileName}
                {event.metadata.rowIndex !== undefined && ` · row ${event.metadata.rowIndex}`}
              </span>
            )}
            {event.metadata?.bulkOperationId && (
              <span className="text-xs text-slate-400 font-mono">
                bulk:{event.metadata.bulkOperationId.slice(-6)}
              </span>
            )}
          </div>
          <span className="shrink-0 text-xs text-slate-400 whitespace-nowrap">
            {relativeTime(event.createdAt)}
          </span>
        </div>

        {/* Expandable delta */}
        {dataEntries.length > 0 && (
          <div className="mt-1.5">
            <button
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {isFlatFile
                ? `${dataEntries.length} field${dataEntries.length !== 1 ? 's' : ''} updated`
                : 'Show changes'}
            </button>
            {expanded && (
              <div className="mt-2 rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
                {dataEntries.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0 font-mono"
                  >
                    <span className="text-slate-500 dark:text-slate-400 shrink-0 w-32 truncate">
                      {key}
                    </span>
                    <span className="text-slate-800 dark:text-slate-200 truncate">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Audit fallback row ─────────────────────────────────────────────────

function AuditRow({ row }: { row: AuditRow }) {
  const [expanded, setExpanded] = useState(false)
  const afterEntries = row.after ? Object.entries(row.after) : []

  return (
    <div className="relative pl-8">
      <span className="absolute left-2.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-slate-900 bg-slate-300 dark:bg-slate-600" />
      <div className="pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Badge variant="default" size="sm">{row.action}</Badge>
            <span className="text-sm text-slate-700 dark:text-slate-300">{row.entityType}</span>
          </div>
          <span className="shrink-0 text-xs text-slate-400">{relativeTime(row.createdAt)}</span>
        </div>
        {afterEntries.length > 0 && (
          <div className="mt-1.5">
            <button
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Show changes
            </button>
            {expanded && (
              <div className="mt-2 rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
                {afterEntries.map(([key, value]) => (
                  <div key={key} className="flex gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0 font-mono">
                    <span className="text-slate-500 w-32 truncate shrink-0">{key}</span>
                    <span className="text-slate-800 dark:text-slate-200 truncate">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────

export function TimelineTab({ product, discardSignal }: Props) {
  const [events, setEvents] = useState<ProductEvent[]>([])
  const [auditRows, setAuditRows] = useState<AuditRow[]>([])
  const [usingFallback, setUsingFallback] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchEvents = useCallback(
    async (cursor?: string) => {
      if (!cursor) setLoading(true)
      else setLoadingMore(true)
      setError(null)

      try {
        const params = new URLSearchParams({ limit: '50' })
        if (sourceFilter !== 'all') params.set('source', sourceFilter)
        if (cursor) params.set('cursor', cursor)

        const res = await fetch(
          `${getBackendUrl()}/api/products/${product.id}/events?${params}`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: { events: ProductEvent[]; nextCursor: string | null } = await res.json()

        if (!cursor && json.events.length === 0 && sourceFilter === 'all') {
          // No events yet — fall back to AuditLog for this product.
          const auditRes = await fetch(
            `${getBackendUrl()}/api/audit-log/search?entityType=Product&entityId=${product.id}&limit=50`,
            { cache: 'no-store' },
          )
          if (auditRes.ok) {
            const auditJson = await auditRes.json()
            setAuditRows(auditJson.items ?? [])
            setUsingFallback(true)
          }
        } else {
          if (!cursor) {
            setEvents(json.events)
            setUsingFallback(false)
          } else {
            setEvents((prev) => [...prev, ...json.events])
          }
          setNextCursor(json.nextCursor)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [product.id, sourceFilter],
  )

  useEffect(() => {
    void fetchEvents()
  }, [fetchEvents, discardSignal])

  const isEmpty = !loading && !error && events.length === 0 && auditRows.length === 0
  const [showSnapshot, setShowSnapshot] = useState(false)

  return (
    <div className="space-y-4 py-4">
      {/* ES.5 — Time Travel modal */}
      {showSnapshot && (
        <SnapshotModal
          productId={product.id}
          productVersion={product.version ?? 1}
          onClose={() => setShowSnapshot(false)}
          onRestored={() => {
            setShowSnapshot(false)
            void fetchEvents()
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setSourceFilter(f.value)}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                sourceFilter === f.value
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setShowSnapshot(true)}>
            <Clock className="h-4 w-4 mr-1.5" />
            Time Travel
          </Button>
          <Button variant="ghost" size="sm" onClick={() => fetchEvents()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4 mr-1.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {usingFallback && (
        <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          Showing legacy audit log — structured event history begins after ES.2 deployment.
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
          <Button variant="ghost" size="sm" onClick={() => fetchEvents()}>Retry</Button>
        </div>
      )}

      {/* Empty */}
      {isEmpty && (
        <EmptyState
          icon={RefreshCw}
          title="No events yet"
          description="Events will appear here as changes are made to this product."
        />
      )}

      {/* Timeline — ProductEvents */}
      {!loading && !error && events.length > 0 && (
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-3.5 top-0 bottom-0 w-px bg-slate-200 dark:bg-slate-700" />
          <div className="space-y-0">
            {events.map((ev) => (
              <EventRow key={ev.id} event={ev} />
            ))}
          </div>
          {nextCursor && (
            <div className="pt-2 pl-8">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchEvents(nextCursor)}
                disabled={loadingMore}
              >
                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                Load older events
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Timeline — AuditLog fallback */}
      {!loading && !error && usingFallback && auditRows.length > 0 && (
        <div className="relative">
          <div className="absolute left-3.5 top-0 bottom-0 w-px bg-slate-200 dark:bg-slate-700" />
          {auditRows.map((row) => (
            <AuditRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
