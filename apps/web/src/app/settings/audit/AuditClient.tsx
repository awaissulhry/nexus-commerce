'use client'

/**
 * Settings rebuild — Phase B.5
 *
 * Settings change history viewer. Renders rows from
 * /api/settings/audit grouped by day, with field-level diff and
 * per-row revert. Filter chips above the list filter by key (with
 * 30-day count badges from /api/settings/audit/keys).
 *
 * Density follows the user's "visibility over minimalism" preference
 * — Salesforce/Airtable, not Linear. Field deltas inline; no
 * collapsible rows; full text wraps so the diff is always readable.
 */

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CornerDownLeft,
  Loader2,
  RefreshCw,
  RotateCcw,
  AlertCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface AuditRow {
  id: string
  key: string
  action: 'create' | 'update' | 'delete' | string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
  userId: string | null
}

export type KeyCountMap = Record<string, number>

const KEY_LABEL: Record<string, string> = {
  account: 'Business',
  profile: 'Profile',
  'profile.password': 'Profile · password',
  notifications: 'Notifications',
  'api-keys': 'API keys',
  company: 'Company & fiscal',
  terminology: 'Terminology',
}

const ACTION_STYLE: Record<string, string> = {
  create:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  update:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  delete:
    'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
}

// Keys where revert needs row-identity logic we haven't built yet.
// Mirrors the API's applyRevert() switch — keep in sync.
const REVERT_DISABLED_KEYS = new Set([
  'terminology',
  'api-keys',
  'profile.password',
])

interface Props {
  initial: AuditRow[]
  initialTotal: number
  initialKeyCounts: KeyCountMap
  initialError: string | null
}

export default function AuditClient({
  initial,
  initialTotal,
  initialKeyCounts,
  initialError,
}: Props) {
  const router = useRouter()
  const [rows, setRows] = useState<AuditRow[]>(initial)
  const [total, setTotal] = useState(initialTotal)
  const [keyCounts, setKeyCounts] = useState<KeyCountMap>(initialKeyCounts)
  const [activeKey, setActiveKey] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const [busyRevert, setBusyRevert] = useState<string | null>(null)

  const refetch = useCallback(
    async (key: string = activeKey) => {
      setLoading(true)
      setError(null)
      try {
        const url = `${getBackendUrl()}/api/settings/audit?limit=50${
          key !== 'all' ? `&key=${encodeURIComponent(key)}` : ''
        }`
        const [listRes, keysRes] = await Promise.all([
          fetch(url, { cache: 'no-store' }),
          fetch(`${getBackendUrl()}/api/settings/audit/keys`, {
            cache: 'no-store',
          }),
        ])
        if (!listRes.ok) {
          throw new Error(`HTTP ${listRes.status}`)
        }
        const data = (await listRes.json()) as {
          items: AuditRow[]
          total: number
        }
        setRows(data.items)
        setTotal(data.total)
        if (keysRes.ok) {
          const k = (await keysRes.json()) as { byKey: KeyCountMap }
          setKeyCounts(k.byKey ?? {})
        }
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setLoading(false)
      }
    },
    [activeKey],
  )

  const pickKey = useCallback(
    (key: string) => {
      setActiveKey(key)
      void refetch(key)
    },
    [refetch],
  )

  const revert = useCallback(
    async (row: AuditRow) => {
      if (REVERT_DISABLED_KEYS.has(row.key)) return
      // Confirm — revert is destructive at the row level.
      const fields = Object.keys(row.before ?? {})
      const ok = window.confirm(
        `Revert ${fields.length} field${fields.length === 1 ? '' : 's'} on “${
          KEY_LABEL[row.key] ?? row.key
        }”?\n\n${fields.join(', ')}`,
      )
      if (!ok) return
      setBusyRevert(row.id)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/settings/audit/${row.id}/revert`,
          { method: 'POST' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        // Refetch list — the revert produced a NEW audit row, so the
        // list grows by one and any active filter still applies.
        await refetch()
        // The reverted page itself needs a refresh — its underlying
        // data just changed.
        router.refresh()
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setBusyRevert(null)
      }
    },
    [refetch, router],
  )

  // Group rows by day for the timeline-style render. Dates are
  // computed against the client's locale; same convention the
  // /orders timeline uses.
  const grouped = useMemo(() => {
    const out: Array<{ day: string; rows: AuditRow[] }> = []
    let current: { day: string; rows: AuditRow[] } | null = null
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    for (const row of rows) {
      const day = fmt.format(new Date(row.createdAt))
      if (!current || current.day !== day) {
        current = { day, rows: [] }
        out.push(current)
      }
      current.rows.push(row)
    }
    return out
  }, [rows])

  // Filter chips — "All" + every known key, with count badges from
  // the keys rollup. Show keys that have no rows in the last 30d
  // greyed-out for discoverability.
  const chips = useMemo(() => {
    const order = [
      'all',
      'account',
      'profile',
      'profile.password',
      'notifications',
      'api-keys',
      'company',
      'terminology',
    ]
    return order.map((k) => ({
      key: k,
      label: k === 'all' ? 'All' : KEY_LABEL[k] ?? k,
      count: k === 'all' ? Object.values(keyCounts).reduce((s, n) => s + n, 0) : keyCounts[k] ?? 0,
    }))
  }, [keyCounts])

  return (
    <div className="space-y-4">
      {/* Filter chips + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        {chips.map((c) => {
          const isActive = activeKey === c.key
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => pickKey(c.key)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-sm border transition-colors',
                isActive
                  ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                  : c.count > 0
                    ? 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600'
                    : 'bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-600',
              )}
            >
              {c.label}
              <span
                className={cn(
                  'tabular-nums text-xs px-1.5 rounded',
                  isActive
                    ? 'bg-blue-700/60'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                )}
              >
                {c.count}
              </span>
            </button>
          )
        })}
        <div className="flex-1" />
        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          {total} total
        </span>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={loading}
          className="inline-flex items-center justify-center h-7 w-7 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
          aria-label="Refresh"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            No settings changes
            {activeKey !== 'all' && (
              <>
                {' '}
                on{' '}
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {KEY_LABEL[activeKey] ?? activeKey}
                </span>
              </>
            )}{' '}
            yet. Save any setting and it'll appear here.
          </p>
        </div>
      ) : (
        <ol className="space-y-6">
          {grouped.map((group) => (
            <li key={group.day}>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                {group.day}
              </div>
              <ul className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
                {group.rows.map((row) => (
                  <AuditRowItem
                    key={row.id}
                    row={row}
                    onRevert={revert}
                    busyRevert={busyRevert === row.id}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function AuditRowItem({
  row,
  onRevert,
  busyRevert,
}: {
  row: AuditRow
  onRevert: (r: AuditRow) => void
  busyRevert: boolean
}) {
  const time = new Date(row.createdAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const fields = useMemo(() => {
    const keys = new Set<string>([
      ...Object.keys(row.before ?? {}),
      ...Object.keys(row.after ?? {}),
    ])
    return Array.from(keys)
  }, [row.before, row.after])

  const revertDisabled =
    REVERT_DISABLED_KEYS.has(row.key) ||
    row.action !== 'update' ||
    !row.before ||
    Object.keys(row.before).length === 0

  const eventLabel = (row.metadata?.event as string | undefined) ?? null
  const userLabel = row.userId ?? 'system'

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2 flex-wrap min-w-0">
          <span
            className={cn(
              'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide border',
              ACTION_STYLE[row.action] ?? ACTION_STYLE.update,
            )}
          >
            {row.action}
          </span>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {KEY_LABEL[row.key] ?? row.key}
          </span>
          {eventLabel && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              · {eventLabel}
            </span>
          )}
          <span className="text-xs text-slate-400 dark:text-slate-500 font-mono tabular-nums">
            {time} · {userLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onRevert(row)}
          disabled={revertDisabled || busyRevert}
          title={
            REVERT_DISABLED_KEYS.has(row.key)
              ? `Revert not supported for ${KEY_LABEL[row.key] ?? row.key} yet`
              : row.action !== 'update'
                ? 'Only update rows can be reverted'
                : 'Restore the previous values'
          }
          className={cn(
            'inline-flex items-center gap-1 h-7 px-2 rounded text-xs border transition-colors',
            revertDisabled || busyRevert
              ? 'text-slate-400 border-slate-200 dark:border-slate-800 cursor-not-allowed'
              : 'text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800',
          )}
        >
          {busyRevert ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RotateCcw size={12} />
          )}
          Revert
        </button>
      </div>

      {fields.length > 0 && (
        <ul className="mt-2 space-y-1">
          {fields.map((field) => (
            <li
              key={field}
              className="grid grid-cols-[140px_1fr] gap-2 items-baseline text-sm"
            >
              <span className="font-mono text-xs text-slate-500 dark:text-slate-400 truncate">
                {field}
              </span>
              <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
                <Value v={row.before?.[field]} tone="before" />
                <CornerDownLeft
                  size={11}
                  className="text-slate-400 dark:text-slate-500 rotate-180 shrink-0"
                  aria-hidden
                />
                <Value v={row.after?.[field]} tone="after" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function Value({
  v,
  tone,
}: {
  v: unknown
  tone: 'before' | 'after'
}) {
  const display =
    v === undefined
      ? '—'
      : v === null
        ? 'null'
        : typeof v === 'string'
          ? v.length === 0
            ? '""'
            : v
          : typeof v === 'boolean'
            ? String(v)
            : Array.isArray(v)
              ? v.length === 0
                ? '[]'
                : JSON.stringify(v)
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v)

  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono max-w-full truncate',
        tone === 'before'
          ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300'
          : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
      )}
      title={display}
    >
      {display}
    </span>
  )
}
