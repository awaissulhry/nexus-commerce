'use client'

// PB.16 — Image-publish audit log viewer.
//
// Reads the existing AuditLog table via /api/audit-log/search, filtered
// to entityType=Product + entityId=this product + action LIKE
// imagePublish*. Rendered as a collapsible accordion at the bottom of
// the Images tab so it doesn't compete with the publish history strip.
//
// Each row shows: action chip · channel chip · marketplace · timestamp
// · key metadata fields (skuCount, jobId, error). Errors are expanded
// inline with a tooltip on long messages.

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  Layers,
  Loader2,
  PlayCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { beFetch } from './api'

const IMAGE_PUBLISH_ACTIONS = new Set([
  'imagePublishStarted',
  'imagePublishCompleted',
  'imagePublishFailed',
  'imagePublishScheduled',
  'imagePublishBulk',
])

interface AuditRow {
  id: string
  userId: string | null
  entityType: string
  entityId: string
  action: string
  metadata: {
    channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY'
    marketplace?: string | null
    jobId?: string
    feedId?: string
    skuCount?: number
    scheduledFor?: string
    scheduleId?: string
    batchSize?: number
    pictureCount?: number
    colorSetCount?: number
    poolImagesPublished?: number
    variantsAssigned?: number
    error?: string
    dryRun?: boolean
    forced?: boolean
  } | null
  createdAt: string
}

interface Props {
  productId: string
  /** Bumped by ImagesTab after every publish so the log refreshes. */
  refreshKey?: number
}

function elapsed(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function actionIcon(action: string) {
  if (action === 'imagePublishStarted')   return <PlayCircle className="w-3 h-3 text-blue-500" />
  if (action === 'imagePublishCompleted') return <CheckCircle2 className="w-3 h-3 text-emerald-500" />
  if (action === 'imagePublishFailed')    return <AlertCircle className="w-3 h-3 text-rose-500" />
  if (action === 'imagePublishScheduled') return <Calendar className="w-3 h-3 text-amber-500" />
  if (action === 'imagePublishBulk')      return <Layers className="w-3 h-3 text-purple-500" />
  return <Clock className="w-3 h-3 text-slate-400" />
}

function actionLabel(action: string): string {
  if (action === 'imagePublishStarted')   return 'Started'
  if (action === 'imagePublishCompleted') return 'Completed'
  if (action === 'imagePublishFailed')    return 'Failed'
  if (action === 'imagePublishScheduled') return 'Scheduled'
  if (action === 'imagePublishBulk')      return 'Bulk entry'
  return action
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON:  'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  EBAY:    'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  SHOPIFY: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
}

export default function PublishAuditLog({ productId, refreshKey = 0 }: Props) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAudit = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Pull a wider net then client-filter to image-publish actions —
      // the audit-log search endpoint doesn't accept multiple action
      // filters in one query string.
      const params = new URLSearchParams({
        entityType: 'Product',
        entityId: productId,
        limit: '50',
      })
      const res = await beFetch(`/api/audit-log/search?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { items: AuditRow[] }
      setRows((body.items ?? []).filter((r) => IMAGE_PUBLISH_ACTIONS.has(r.action)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audit fetch failed')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (open) void fetchAudit()
  }, [open, fetchAudit, refreshKey])

  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
        aria-expanded={open}
      >
        <Clock className="w-3.5 h-3.5 text-slate-400" />
        <span className="font-medium">Publish audit log</span>
        <span className="text-slate-400 ml-1">— who/what/when on every image-publish action</span>
        {loading && open && <Loader2 className="w-3 h-3 animate-spin text-slate-400 ml-auto" />}
        {!loading && (
          <ChevronDown className={cn('w-3.5 h-3.5 ml-auto text-slate-400 transition-transform', open && 'rotate-180')} />
        )}
      </button>
      {open && (
        <div className="px-4 pb-4">
          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 px-2 py-1">{error}</div>
          )}
          {!error && rows.length === 0 && !loading && (
            <div className="text-xs text-slate-400 italic px-2 py-3">No image-publish actions logged for this product yet.</div>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
                    <th className="py-1.5 pr-3 font-medium">Action</th>
                    <th className="py-1.5 pr-3 font-medium">Channel</th>
                    <th className="py-1.5 pr-3 font-medium">Market</th>
                    <th className="py-1.5 pr-3 font-medium">Detail</th>
                    <th className="py-1.5 pr-3 font-medium">User</th>
                    <th className="py-1.5 pr-3 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 dark:border-slate-800/50 last:border-0">
                      <td className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-1">
                          {actionIcon(r.action)}
                          <span className="font-medium text-slate-700 dark:text-slate-300">{actionLabel(r.action)}</span>
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.metadata?.channel && (
                          <span className={cn(
                            'text-[10px] uppercase font-semibold px-1.5 py-px rounded tracking-wide',
                            CHANNEL_TONE[r.metadata.channel] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-500',
                          )}>
                            {r.metadata.channel}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-slate-600 dark:text-slate-400">
                        {r.metadata?.marketplace ?? '—'}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500 dark:text-slate-400">
                        <Detail row={r} />
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-400">
                        {r.userId ?? '—'}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-slate-400" title={r.createdAt}>
                        {elapsed(r.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Detail({ row }: { row: AuditRow }) {
  const m = row.metadata ?? {}
  const bits: string[] = []
  if (m.skuCount !== undefined)              bits.push(`${m.skuCount} SKU${m.skuCount === 1 ? '' : 's'}`)
  if (m.pictureCount !== undefined)          bits.push(`${m.pictureCount} pics`)
  if (m.colorSetCount !== undefined && m.colorSetCount > 0) bits.push(`${m.colorSetCount} color sets`)
  if (m.poolImagesPublished !== undefined)   bits.push(`${m.poolImagesPublished} pool`)
  if (m.variantsAssigned !== undefined && m.variantsAssigned > 0) bits.push(`${m.variantsAssigned} variants`)
  if (m.batchSize !== undefined)             bits.push(`batch ${m.batchSize}`)
  if (m.scheduledFor)                        bits.push(`fires ${new Date(m.scheduledFor).toLocaleString()}`)
  if (m.dryRun)                              bits.push('dry-run')
  if (m.forced)                              bits.push('forced')
  if (m.jobId)                               bits.push(`job ${m.jobId.slice(0, 8)}`)
  if (m.error) {
    return (
      <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400" title={m.error}>
        <AlertCircle className="w-3 h-3 flex-shrink-0" />
        <span className="truncate max-w-[260px]">{m.error}</span>
      </span>
    )
  }
  return <span>{bits.length > 0 ? bits.join(' · ') : '—'}</span>
}
