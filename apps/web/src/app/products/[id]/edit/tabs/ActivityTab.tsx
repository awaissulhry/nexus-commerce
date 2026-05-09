'use client'

/**
 * W2.2 — Activity tab on /products/[id]/edit.
 *
 * Reads the AuditLog rows scoped to this product
 * (entityType='Product', entityId=product.id) via the existing
 * /api/audit-log/search endpoint. Cursor-paginated, filterable by
 * action and time window, with per-row expand-to-diff.
 *
 * AuditLog is append-only and written to by every mutation across
 * the app — products.routes.ts/bulk, master-price.service,
 * master-status.service, products-ai, products-images, pim.routes
 * — but until this tab there was no per-product UI to browse it.
 *
 * Read-only surface; no dirty state. discardSignal nudges a refetch
 * so the user sees the freshly-written rows from whatever they just
 * discarded (some flushes may have already landed before the
 * Discard click — those rows show up here).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface AuditRow {
  id: string
  userId: string | null
  ip: string | null
  entityType: string
  entityId: string
  action: string
  before: unknown
  after: unknown
  metadata: Record<string, unknown> | null
  createdAt: string
}

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  discardSignal: number
}

type TimeWindow = '1d' | '7d' | '30d' | '90d' | 'all'
type ActionFilter = 'all' | 'update' | 'create' | 'delete' | 'submit'

const TIME_WINDOW_HOURS: Record<TimeWindow, number | null> = {
  '1d': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
  all: null,
}

const PAGE_SIZE = 50

export default function ActivityTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()

  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('30d')
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Stable "this tab is never dirty" signal.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    onDirtyChange(0)
  }, [onDirtyChange])

  // Debounce the search input so typing doesn't pound the API.
  useEffect(() => {
    const timer = globalThis.setTimeout(
      () => setDebouncedSearch(search.trim()),
      300,
    )
    return () => globalThis.clearTimeout(timer)
  }, [search])

  const buildUrl = useCallback(
    (cursor?: string | null) => {
      const url = new URL(`${getBackendUrl()}/api/audit-log/search`)
      url.searchParams.set('entityType', 'Product')
      url.searchParams.set('entityId', product.id)
      url.searchParams.set('limit', String(PAGE_SIZE))
      if (actionFilter !== 'all') url.searchParams.set('action', actionFilter)
      const hours = TIME_WINDOW_HOURS[timeWindow]
      if (hours) {
        url.searchParams.set(
          'since',
          new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
        )
      }
      if (debouncedSearch.length > 0)
        url.searchParams.set('search', debouncedSearch)
      if (cursor) url.searchParams.set('cursor', cursor)
      return url.toString()
    },
    [product.id, actionFilter, timeWindow, debouncedSearch],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(buildUrl(), { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as {
        success?: boolean
        items?: AuditRow[]
        nextCursor?: string | null
      }
      setRows(json.items ?? [])
      setNextCursor(json.nextCursor ?? null)
      setExpanded(new Set())
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setRows([])
    } finally {
      setRefreshing(false)
    }
  }, [buildUrl])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(buildUrl(nextCursor), { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as {
        items?: AuditRow[]
        nextCursor?: string | null
      }
      setRows((prev) => [...(prev ?? []), ...(json.items ?? [])])
      setNextCursor(json.nextCursor ?? null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoadingMore(false)
    }
  }, [buildUrl, nextCursor, loadingMore])

  // Initial fetch + refetch when filters change.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Discard nudge: re-fetch so any rows that landed during the
  // pre-discard flush show up.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    void refresh()
  }, [discardSignal, refresh])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <Card
        title={t('products.edit.activity.title')}
        description={t('products.edit.activity.description')}
        action={
          <Button
            variant="ghost"
            size="sm"
            loading={refreshing}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={() => void refresh()}
          >
            {t('products.edit.activity.refresh')}
          </Button>
        }
      >
        {/* ── Filter row ───────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-1">
            {(['1d', '7d', '30d', '90d', 'all'] as TimeWindow[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setTimeWindow(w)}
                className={cn(
                  'h-7 px-2.5 rounded text-xs font-medium border transition-colors',
                  timeWindow === w
                    ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {t(`products.edit.activity.window.${w}`)}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" />
          <div className="flex items-center gap-1">
            {(
              ['all', 'update', 'create', 'delete', 'submit'] as ActionFilter[]
            ).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setActionFilter(a)}
                className={cn(
                  'h-7 px-2.5 rounded text-xs font-medium border transition-colors',
                  actionFilter === a
                    ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {t(`products.edit.activity.action.${a}`)}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-[160px] max-w-xs">
            <Input
              placeholder={t('products.edit.activity.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div className="text-sm text-rose-700 dark:text-rose-300 mb-3 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        {rows === null ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('products.edit.activity.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-6 text-center">
            {t('products.edit.activity.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            {rows.map((row) => (
              <ActivityRowItem
                key={row.id}
                row={row}
                expanded={expanded.has(row.id)}
                onToggle={() => toggle(row.id)}
                t={t}
              />
            ))}
          </ul>
        )}

        {nextCursor && rows && rows.length > 0 && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              {t('products.edit.activity.loadMore')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

// ── Row + diff ────────────────────────────────────────────────
function ActivityRowItem({
  row,
  expanded,
  onToggle,
  t,
}: {
  row: AuditRow
  expanded: boolean
  onToggle: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const summary = describeRow(row)
  const source = pickSource(row.metadata)
  const actor =
    typeof row.userId === 'string' && row.userId.length > 0
      ? row.userId
      : t('products.edit.activity.systemActor')

  return (
    <li className="bg-white dark:bg-slate-900">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
      >
        <span className="mt-1 text-slate-400 dark:text-slate-600 flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
        <span className="flex-shrink-0 mt-0.5">
          <ActionBadge action={row.action} t={t} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-md text-slate-900 dark:text-slate-100 truncate">
            {summary}
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{formatRelative(row.createdAt)}</span>
            <span>·</span>
            <span className="font-mono">{actor}</span>
            {source && (
              <>
                <span>·</span>
                <span className="px-1 py-px text-[10px] uppercase tracking-wide bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded">
                  {source}
                </span>
              </>
            )}
          </span>
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-600 tabular-nums flex-shrink-0">
          {formatAbsolute(row.createdAt)}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pl-9 text-xs">
          <DiffPanel before={row.before} after={row.after} t={t} />
          {row.metadata && Object.keys(row.metadata).length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100">
                {t('products.edit.activity.metadataLabel')}
              </summary>
              <pre className="mt-1 p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded font-mono whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300">
                {JSON.stringify(row.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </li>
  )
}

function DiffPanel({
  before,
  after,
  t,
}: {
  before: unknown
  after: unknown
  t: (key: string) => string
}) {
  const hasBefore = before !== null && before !== undefined
  const hasAfter = after !== null && after !== undefined
  if (!hasBefore && !hasAfter) {
    return (
      <div className="italic text-slate-500 dark:text-slate-400">
        {t('products.edit.activity.noDiff')}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      <DiffSide
        label={t('products.edit.activity.beforeLabel')}
        value={before}
        tone="before"
        empty={t('products.edit.activity.noBefore')}
      />
      <DiffSide
        label={t('products.edit.activity.afterLabel')}
        value={after}
        tone="after"
        empty={t('products.edit.activity.noAfter')}
      />
    </div>
  )
}

function DiffSide({
  label,
  value,
  tone,
  empty,
}: {
  label: string
  value: unknown
  tone: 'before' | 'after'
  empty: string
}) {
  const isEmpty = value === null || value === undefined
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-1">
        {label}
      </div>
      <pre
        className={cn(
          'p-2 rounded border font-mono text-xs whitespace-pre-wrap break-all',
          tone === 'before'
            ? 'border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/30 text-rose-900 dark:text-rose-200'
            : 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200',
          isEmpty && 'italic opacity-70',
        )}
      >
        {isEmpty ? empty : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function ActionBadge({
  action,
  t,
}: {
  action: string
  t: (key: string) => string
}) {
  const lower = action.toLowerCase()
  const variant: 'success' | 'info' | 'danger' | 'warning' | 'default' =
    lower === 'create'
      ? 'success'
      : lower === 'delete'
        ? 'danger'
        : lower === 'submit'
          ? 'warning'
          : lower === 'update'
            ? 'info'
            : 'default'
  const known = ['create', 'update', 'delete', 'submit'].includes(lower)
  const label = known
    ? t(`products.edit.activity.action.${lower}`)
    : action
  return (
    <Badge mono variant={variant}>
      {label}
    </Badge>
  )
}

// ── Helpers ────────────────────────────────────────────────────
function describeRow(row: AuditRow): string {
  const after = row.after as Record<string, unknown> | null
  const before = row.before as Record<string, unknown> | null
  if (after && typeof after.field === 'string') {
    const field = after.field as string
    const valueStr = stringifyValue(after.value)
    return `${field} → ${valueStr}`
  }
  // master-price + master-status writers store before/after with the
  // changed key directly (e.g. { basePrice: 9.99 }).
  const afterKeys =
    after && typeof after === 'object' ? Object.keys(after) : []
  if (afterKeys.length === 1) {
    const key = afterKeys[0]
    return `${key} → ${stringifyValue((after as any)[key])}`
  }
  if (row.action === 'create') return 'Created'
  if (row.action === 'delete') return 'Deleted'
  if (afterKeys.length > 1) return `Updated ${afterKeys.length} fields`
  if (before && typeof before === 'object') {
    const k = Object.keys(before)
    if (k.length > 0) return `Cleared ${k.join(', ')}`
  }
  return row.action
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'string') {
    return v.length > 60 ? `${v.slice(0, 60)}…` : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[${v.length} items]`
  }
  return JSON.stringify(v).slice(0, 80)
}

function pickSource(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null
  if (typeof metadata.source === 'string') return metadata.source
  if (typeof metadata.reason === 'string') return metadata.reason
  return null
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return iso
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}
