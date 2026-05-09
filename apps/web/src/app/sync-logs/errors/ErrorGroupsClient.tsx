'use client'

/**
 * L.8.1 — /sync-logs/errors client.
 *
 * Lists SyncLogErrorGroup rows with filter chips for resolution
 * status (ACTIVE / RESOLVED / MUTED / IGNORED) and channel. Each
 * row exposes the resolution actions inline:
 *
 *   - ACTIVE   → [Resolve] [Mute] [Ignore]
 *   - RESOLVED → [Reopen]
 *   - MUTED    → [Unmute] [Resolve]
 *   - IGNORED  → [Reopen]
 *
 * Counts pill shows the current occurrences in the active window
 * (default 7d). First-seen / last-seen flank a sample message
 * for the operator to recognise the error.
 *
 * URL state via search params:
 *   ?status=ACTIVE  &channel=AMAZON  &since=ISO
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  EyeOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  VolumeX,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import SavedSearchPicker from '../_shared/SavedSearchPicker'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

const STATUS_OPTIONS = ['ACTIVE', 'RESOLVED', 'MUTED', 'IGNORED', 'ALL'] as const
type Status = (typeof STATUS_OPTIONS)[number]

interface ErrorGroup {
  id: string
  fingerprint: string
  channel: string
  operation: string
  errorType: string | null
  errorCode: string | null
  sampleMessage: string | null
  count: number
  firstSeen: string
  lastSeen: string
  resolutionStatus: 'ACTIVE' | 'RESOLVED' | 'MUTED' | 'IGNORED'
  resolvedAt: string | null
  resolvedBy: string | null
  notes: string | null
}

interface ListResponse {
  items: ErrorGroup[]
  nextCursor: string | null
  totals: Array<{ status: string; count: number }>
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

const STATUS_BADGE: Record<
  Status,
  { variant: 'success' | 'warning' | 'danger' | 'info' | 'default' }
> = {
  ACTIVE: { variant: 'danger' },
  RESOLVED: { variant: 'success' },
  MUTED: { variant: 'warning' },
  IGNORED: { variant: 'default' },
  ALL: { variant: 'default' },
}

export default function ErrorGroupsClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { t } = useTranslations()

  const urlStatus = (searchParams.get('status') ?? 'ACTIVE') as Status
  const urlChannel = searchParams.get('channel') ?? ''

  const [items, setItems] = useState<ErrorGroup[]>([])
  const [totals, setTotals] = useState<Array<{ status: string; count: number }>>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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

  const fetchList = useCallback(
    async (resetCursor = true) => {
      if (resetCursor) setLoading(true)
      else setLoadingMore(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        params.set('status', urlStatus)
        if (urlChannel) params.set('channel', urlChannel)
        params.set('limit', '50')
        if (!resetCursor && nextCursor) params.set('cursor', nextCursor)

        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/error-groups?${params.toString()}`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as ListResponse
        if (resetCursor) {
          setItems(json.items)
          setTotals(json.totals)
        } else {
          setItems((prev) => [...prev, ...json.items])
        }
        setNextCursor(json.nextCursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (resetCursor) setLoading(false)
        else setLoadingMore(false)
      }
    },
    [urlStatus, urlChannel, nextCursor],
  )

  useEffect(() => {
    void fetchList(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlStatus, urlChannel])

  const resolve = useCallback(
    async (
      group: ErrorGroup,
      status: 'ACTIVE' | 'RESOLVED' | 'MUTED' | 'IGNORED',
    ) => {
      setBusyId(group.id)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/error-groups/${group.id}/resolve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        toast.success(t('syncLogs.errors.action.markedStatus', {
          status: t(`syncLogs.errorStatus.${status}`).toLowerCase(),
        }))
        void fetchList(true)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
      }
    },
    [fetchList, toast, t],
  )

  const channels = useMemo(() => {
    const set = new Set(items.map((i) => i.channel))
    return Array.from(set).sort()
  }, [items])

  const totalsMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of totals) m.set(t.status, t.count)
    return m
  }, [totals])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
          {t('syncLogs.errors.filter.status')}
        </span>
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => updateUrl({ status: s === 'ACTIVE' ? '' : s })}
            className={cn(
              'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
              urlStatus === s
                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
            )}
          >
            {t(`syncLogs.errorStatus.${s}`)}
            {s !== 'ALL' && totalsMap.has(s) && (
              <span className="ml-1 opacity-70">{totalsMap.get(s)}</span>
            )}
          </button>
        ))}

        {channels.length > 0 && (
          <>
            <span className="ml-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-500 font-medium mr-1">
              {t('syncLogs.errors.filter.channel')}
            </span>
            {channels.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => updateUrl({ channel: urlChannel === c ? '' : c })}
                className={cn(
                  'px-2 py-0.5 text-sm font-medium rounded border transition-colors',
                  urlChannel === c
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
                )}
              >
                {c}
              </button>
            ))}
          </>
        )}

        <div className="ml-auto" />
        <SavedSearchPicker
          surface="errors"
          currentFilters={{ status: urlStatus, channel: urlChannel }}
          onApply={(filters) => updateUrl({ status: '', channel: '', ...filters })}
        />

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchList(true)}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {t('syncLogs.errors.refresh')}
        </Button>
      </div>

      {error && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-20 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md animate-pulse"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={
            urlStatus === 'ACTIVE'
              ? t('syncLogs.errors.empty.active.title')
              : t('syncLogs.errors.empty.other.title', {
                  status: t(`syncLogs.errorStatus.${urlStatus}`).toLowerCase(),
                })
          }
          description={
            urlStatus === 'ACTIVE'
              ? t('syncLogs.errors.empty.active.description')
              : t('syncLogs.errors.empty.other.description')
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((g) => (
            <li
              key={g.id}
              className={cn(
                'border rounded-md bg-white dark:bg-slate-900 p-3 transition-colors',
                g.resolutionStatus === 'ACTIVE'
                  ? 'border-rose-200 dark:border-rose-900 bg-rose-50/30 dark:bg-rose-950/30'
                  : g.resolutionStatus === 'RESOLVED'
                    ? 'border-emerald-200 dark:border-emerald-900'
                    : g.resolutionStatus === 'MUTED'
                      ? 'border-amber-200 dark:border-amber-900'
                      : 'border-slate-200 dark:border-slate-800',
              )}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Badge
                      variant={STATUS_BADGE[g.resolutionStatus].variant}
                      size="sm"
                    >
                      {t(`syncLogs.errorStatus.${g.resolutionStatus}`)}
                    </Badge>
                    <Badge variant="default" size="sm">
                      {g.channel}
                    </Badge>
                    {g.errorType && (
                      <Badge
                        variant={
                          g.errorType === 'AUTHENTICATION' ||
                          g.errorType === 'SERVER'
                            ? 'danger'
                            : g.errorType === 'RATE_LIMIT'
                              ? 'warning'
                              : 'default'
                        }
                        size="sm"
                      >
                        {g.errorType}
                      </Badge>
                    )}
                    {g.errorCode && (
                      <code className="text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded">
                        {g.errorCode}
                      </code>
                    )}
                    <span className="ml-auto font-mono text-base font-bold text-slate-900 dark:text-slate-100">
                      {g.count.toLocaleString()}×
                    </span>
                  </div>

                  <div className="text-base font-mono text-slate-900 dark:text-slate-100 mb-1 truncate">
                    {g.operation}
                  </div>

                  {g.sampleMessage && (
                    <div
                      className="text-sm text-slate-600 dark:text-slate-400 mb-1 truncate"
                      title={g.sampleMessage}
                    >
                      {g.sampleMessage}
                    </div>
                  )}

                  <div className="text-xs text-slate-500 dark:text-slate-500 flex items-center gap-2 flex-wrap">
                    <span>{t('syncLogs.errors.meta.first', { when: fmtRelative(g.firstSeen) })}</span>
                    <span className="text-slate-300">·</span>
                    <span>{t('syncLogs.errors.meta.last', { when: fmtRelative(g.lastSeen) })}</span>
                    {g.resolvedBy && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span>{t('syncLogs.errors.meta.resolvedBy', { who: g.resolvedBy })}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Resolution actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {g.resolutionStatus === 'ACTIVE' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void resolve(g, 'RESOLVED')}
                        disabled={busyId === g.id}
                        className="h-7 px-2 text-sm font-medium rounded border border-emerald-300 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3 h-3" /> {t('syncLogs.errors.action.resolve')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolve(g, 'MUTED')}
                        disabled={busyId === g.id}
                        className="h-7 px-2 text-sm font-medium rounded border border-amber-300 bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 hover:bg-amber-50 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        <VolumeX className="w-3 h-3" /> {t('syncLogs.errors.action.mute')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolve(g, 'IGNORED')}
                        disabled={busyId === g.id}
                        className="h-7 px-2 text-sm font-medium rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        <EyeOff className="w-3 h-3" /> {t('syncLogs.errors.action.ignore')}
                      </button>
                    </>
                  )}
                  {(g.resolutionStatus === 'RESOLVED' ||
                    g.resolutionStatus === 'IGNORED') && (
                    <button
                      type="button"
                      onClick={() => void resolve(g, 'ACTIVE')}
                      disabled={busyId === g.id}
                      className="h-7 px-2 text-sm font-medium rounded border border-rose-300 bg-white dark:bg-slate-900 text-rose-700 dark:text-rose-400 hover:bg-rose-50 inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" /> {t('syncLogs.errors.action.reopen')}
                    </button>
                  )}
                  {g.resolutionStatus === 'MUTED' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void resolve(g, 'ACTIVE')}
                        disabled={busyId === g.id}
                        className="h-7 px-2 text-sm font-medium rounded border border-rose-300 bg-white dark:bg-slate-900 text-rose-700 dark:text-rose-400 hover:bg-rose-50 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {t('syncLogs.errors.action.unmute')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolve(g, 'RESOLVED')}
                        disabled={busyId === g.id}
                        className="h-7 px-2 text-sm font-medium rounded border border-emerald-300 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3 h-3" /> {t('syncLogs.errors.action.resolve')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}

          {nextCursor && (
            <li className="text-center pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchList(false)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                {t('syncLogs.errors.loadMore')}
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
