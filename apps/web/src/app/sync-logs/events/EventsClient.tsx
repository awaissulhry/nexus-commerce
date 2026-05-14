'use client'

/**
 * ES.4 — /sync-logs/events
 *
 * Focused event feed showing sync-related ProductEvents:
 * SYNC_QUEUED, SYNC_SUCCEEDED, SYNC_FAILED, CHANNEL_LISTING_PUBLISHED,
 * CHANNEL_LISTING_SUPPRESSED, FLAT_FILE_IMPORTED.
 *
 * Backed by GET /api/events?eventType=...
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  Radio,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface ProductEvent {
  id: string
  aggregateId: string
  aggregateType: string
  eventType: string
  data: Record<string, unknown> | null
  metadata: {
    source?: string
    fileName?: string
    flatFileType?: string
    channel?: string
    marketplace?: string
  } | null
  createdAt: string
}

const SYNC_EVENT_TYPES = [
  'SYNC_QUEUED',
  'SYNC_SUCCEEDED',
  'SYNC_FAILED',
  'CHANNEL_LISTING_PUBLISHED',
  'CHANNEL_LISTING_SUPPRESSED',
  'FLAT_FILE_IMPORTED',
].join(',')

const EVENT_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'SYNC_QUEUED,SYNC_SUCCEEDED,SYNC_FAILED', label: 'Sync Jobs' },
  { value: 'CHANNEL_LISTING_PUBLISHED,CHANNEL_LISTING_SUPPRESSED', label: 'Listings' },
  { value: 'FLAT_FILE_IMPORTED', label: 'Flat File' },
]

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType === 'SYNC_SUCCEEDED' || eventType === 'CHANNEL_LISTING_PUBLISHED')
    return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
  if (eventType === 'SYNC_FAILED' || eventType === 'CHANNEL_LISTING_SUPPRESSED')
    return <XCircle className="h-4 w-4 text-red-500" />
  if (eventType === 'FLAT_FILE_IMPORTED')
    return <FileSpreadsheet className="h-4 w-4 text-amber-500" />
  return <Radio className="h-4 w-4 text-blue-400" />
}

function eventBadge(eventType: string): 'success' | 'danger' | 'warning' | 'info' | 'default' {
  if (eventType === 'SYNC_SUCCEEDED' || eventType === 'CHANNEL_LISTING_PUBLISHED') return 'success'
  if (eventType === 'SYNC_FAILED' || eventType === 'CHANNEL_LISTING_SUPPRESSED') return 'danger'
  if (eventType === 'FLAT_FILE_IMPORTED') return 'warning'
  return 'info'
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export default function EventsClient() {
  const [events, setEvents] = useState<ProductEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fetchEvents = useCallback(async (cursor?: string) => {
    if (!cursor) setLoading(true); else setLoadingMore(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        eventType: typeFilter === 'all' ? SYNC_EVENT_TYPES : typeFilter,
        limit: '75',
      })
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
  }, [typeFilter])

  useEffect(() => { void fetchEvents() }, [fetchEvents])

  const toggleExpand = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="space-y-4">
      {/* Filter + refresh bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {EVENT_FILTERS.map(f => (
            <button key={f.value} onClick={() => setTypeFilter(f.value)}
              className={cn('px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                typeFilter === f.value
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              )}>
              {f.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={() => fetchEvents()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="text-center py-16 text-sm text-slate-400">
          No sync events yet. They will appear here as products are synced.
        </div>
      )}

      {!loading && events.length > 0 && (
        <div className="space-y-1.5">
          {events.map(ev => {
            const isOpen = expanded.has(ev.id)
            const dataEntries = ev.data ? Object.entries(ev.data) : []
            return (
              <div key={ev.id}
                className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                <button onClick={() => toggleExpand(ev.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                  <EventIcon eventType={ev.eventType} />
                  <Badge variant={eventBadge(ev.eventType)} size="sm">
                    {ev.eventType.replace(/_/g, ' ')}
                  </Badge>
                  <span className="text-sm text-slate-700 dark:text-slate-300 flex-1 truncate font-mono text-xs">
                    {ev.aggregateId.slice(-8)}
                    {ev.metadata?.fileName && (
                      <span className="ml-2 font-sans text-slate-500">· {ev.metadata.fileName}</span>
                    )}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0">{relativeTime(ev.createdAt)}</span>
                  {dataEntries.length > 0 && (
                    isOpen
                      ? <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  )}
                </button>
                {isOpen && dataEntries.length > 0 && (
                  <div className="border-t border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                    {dataEntries.map(([k, v]) => (
                      <div key={k} className="flex gap-2 px-3 py-1.5 text-xs font-mono">
                        <span className="text-slate-500 w-36 shrink-0 truncate">{k}</span>
                        <span className="text-slate-800 dark:text-slate-200 truncate">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
                        </span>
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
