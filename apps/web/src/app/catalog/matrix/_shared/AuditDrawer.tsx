'use client'

/**
 * PIM B.5 — Audit drawer for matrix rows.
 *
 * Slide-out right-side panel showing recent ProductEvent entries for
 * one product. Reuses the existing GET /api/products/:id/events
 * endpoint (ES.4) that powers the TimelineTab on /products/[id]/edit
 * — same data, different surface.
 *
 * Compact: caller passes productId + product label; we fetch on open,
 * render up to 50 events with relative timestamps, source badges,
 * and operator-friendly summaries.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  X,
  Loader2,
  AlertCircle,
  Clock,
  ExternalLink,
  Bot,
  Webhook,
  Zap,
  User,
  FileSpreadsheet,
  Settings2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface ProductEvent {
  id: string
  aggregateId: string
  eventType: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

interface Props {
  open: boolean
  onClose: () => void
  productId: string
  productLabel: string
}

export default function AuditDrawer({ open, onClose, productId, productLabel }: Props) {
  const [events, setEvents] = useState<ProductEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchEvents = useCallback(async () => {
    if (!open) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/products/${productId}/events?limit=50`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as { events: ProductEvent[] }
      setEvents(data.events)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load events')
    } finally {
      setLoading(false)
    }
  }, [open, productId])

  useEffect(() => {
    void fetchEvents()
  }, [fetchEvents])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" />
      {/* Drawer */}
      <aside
        className="w-full max-w-md bg-white dark:bg-zinc-900 shadow-2xl flex flex-col h-full"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              Activity
            </h2>
            <p className="text-[11px] text-zinc-500 truncate" title={productLabel}>
              {productLabel}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href={`/products/${productId}/edit?tab=activity`}
              className="text-[11px] text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5"
              title="Open Timeline tab"
            >
              Full
              <ExternalLink className="w-3 h-3" />
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10 text-zinc-500 text-sm">
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
              Loading events…
            </div>
          )}
          {error && (
            <div className="m-4 p-2.5 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}
          {!loading && !error && events.length === 0 && (
            <div className="text-center py-10 text-zinc-500 text-sm italic">
              No activity recorded for this product yet.
            </div>
          )}
          {!loading && !error && events.length > 0 && (
            <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {events.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  )
}

function EventRow({ event }: { event: ProductEvent }) {
  const source = (event.metadata?.source as string | undefined) ?? 'SYSTEM'
  const summary = (event.metadata?.summary as string | undefined) ?? null
  const Icon = sourceIcon(source)
  return (
    <li className="px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
      <div className="flex items-start gap-2">
        <div
          className={cn(
            'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
            sourceTone(source),
          )}
        >
          <Icon className="w-2.5 h-2.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {event.eventType}
            </span>
            <RelativeTime iso={event.createdAt} />
          </div>
          {summary && (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-0.5 break-words">
              {summary}
            </p>
          )}
          <div className="text-[10px] text-zinc-400 mt-0.5">{source}</div>
        </div>
      </div>
    </li>
  )
}

function RelativeTime({ iso }: { iso: string }) {
  const ts = new Date(iso).getTime()
  const now = Date.now()
  const diff = now - ts
  let text = ''
  if (diff < 60_000) text = 'just now'
  else if (diff < 3_600_000) text = `${Math.floor(diff / 60_000)}m ago`
  else if (diff < 86_400_000) text = `${Math.floor(diff / 3_600_000)}h ago`
  else text = `${Math.floor(diff / 86_400_000)}d ago`
  return (
    <span
      className="text-[10px] text-zinc-500 flex-shrink-0 inline-flex items-center gap-0.5"
      title={new Date(iso).toLocaleString()}
    >
      <Clock className="w-2.5 h-2.5" />
      {text}
    </span>
  )
}

function sourceIcon(source: string) {
  if (source === 'AI') return Bot
  if (source === 'WEBHOOK') return Webhook
  if (source === 'AUTOMATION') return Zap
  if (source === 'FLAT_FILE_IMPORT') return FileSpreadsheet
  if (source === 'OPERATOR' || source === 'API') return User
  return Settings2
}

function sourceTone(source: string): string {
  switch (source) {
    case 'AI':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
    case 'WEBHOOK':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
    case 'AUTOMATION':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    case 'FLAT_FILE_IMPORT':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    case 'OPERATOR':
    case 'API':
      return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300'
    default:
      return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
  }
}
