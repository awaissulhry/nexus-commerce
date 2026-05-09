'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Play,
  RefreshCw,
  SkipForward,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { BarcodeScanInput } from '@/components/ui/BarcodeScanInput'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface CountItem {
  id: string
  productId: string
  variationId: string | null
  sku: string
  productName: string | null
  expectedQuantity: number
  countedQuantity: number | null
  variance: number | null
  status: string // PENDING | COUNTED | RECONCILED | IGNORED
  countedAt: string | null
  reconciledAt: string | null
  notes: string | null
}

interface CountSession {
  id: string
  status: string
  notes: string | null
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  cancelledReason: string | null
  createdAt: string
  location: { id: string; code: string; name: string }
  items: CountItem[]
}

type StatusFilter = 'all' | 'PENDING' | 'COUNTED' | 'RECONCILED' | 'IGNORED' | 'variance'

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'RECONCILED':
    case 'COMPLETED':
      return 'success'
    case 'COUNTED':
      return 'info'
    case 'IGNORED':
      return 'default'
    case 'PENDING':
    case 'DRAFT':
    case 'IN_PROGRESS':
      return 'warning'
    case 'CANCELLED':
      return 'danger'
    default:
      return 'default'
  }
}

export default function CycleCountSessionClient({ countId }: { countId: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const { t } = useTranslations()
  const [data, setData] = useState<CountSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const [busyTopAction, setBusyTopAction] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  // Per-item input draft so the operator can type a number then commit on blur.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // S.5 — replace window.prompt() with the Modal primitive. One modal
  // covers both flows (cancel session, ignore item variance) so we
  // don't duplicate the textarea + buttons + a11y wiring.
  const [reasonPrompt, setReasonPrompt] = useState<
    | { kind: 'cancel' }
    | { kind: 'ignore'; itemId: string; sku: string }
    | null
  >(null)
  const [reasonInput, setReasonInput] = useState('')
  const [reasonSubmitting, setReasonSubmitting] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json.count ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [countId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const filteredItems = useMemo(() => {
    if (!data) return []
    switch (filter) {
      case 'all':
        return data.items
      case 'variance':
        return data.items.filter(
          (it) => it.variance != null && it.variance !== 0,
        )
      default:
        return data.items.filter((it) => it.status === filter)
    }
  }, [data, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: data?.items.length ?? 0,
      PENDING: 0,
      COUNTED: 0,
      RECONCILED: 0,
      IGNORED: 0,
      variance: 0,
    }
    if (data) {
      for (const it of data.items) {
        c[it.status] = (c[it.status] ?? 0) + 1
        if (it.variance != null && it.variance !== 0) c.variance++
      }
    }
    return c
  }, [data])

  const isInProgress = data?.status === 'IN_PROGRESS'
  const allResolved =
    data?.items.every((i) => i.status === 'RECONCILED' || i.status === 'IGNORED') ?? false

  const handleStart = async () => {
    setBusyTopAction('start')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/start`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('cycleCount.session.startedToast'))
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.session.startFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusyTopAction(null)
    }
  }

  const handleComplete = async () => {
    if (!(await askConfirm({
      title: t('cycleCount.session.completeConfirmTitle'),
      description: t('cycleCount.session.completeConfirmDescription'),
      confirmLabel: t('cycleCount.session.completeConfirm'),
      tone: 'warning',
    }))) return
    setBusyTopAction('complete')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/complete`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('cycleCount.session.completedToast'))
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.session.completeFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusyTopAction(null)
    }
  }

  // S.5 — open the reason modal. Submission lives in submitReason
  // below so the same flow can serve cancel + ignore.
  const handleCancel = () => {
    setReasonInput('')
    setReasonPrompt({ kind: 'cancel' })
  }

  const performCancel = async (reason: string | null) => {
    setBusyTopAction('cancel')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/cancel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('cycleCount.session.cancelledToast'))
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.session.cancelFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusyTopAction(null)
    }
  }

  const handleRecord = async (item: CountItem, raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const qty = Number(trimmed)
    if (!Number.isInteger(qty) || qty < 0) {
      toast.error(t('cycleCount.session.qtyInvalid'))
      return
    }
    setActingId(item.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/items/${item.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ countedQuantity: qty }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // Clear draft now that it's committed
      setDrafts((d) => {
        const { [item.id]: _, ...rest } = d
        return rest
      })
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.session.recordFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setActingId(null)
    }
  }

  const handleReconcile = async (item: CountItem) => {
    setActingId(item.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/items/${item.id}/reconcile`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const variance = (item.countedQuantity ?? 0) - item.expectedQuantity
      toast.success(
        variance === 0
          ? t('cycleCount.session.matchedToast', { sku: item.sku })
          : t('cycleCount.session.varianceAppliedToast', {
              sku: item.sku,
              sign: variance > 0 ? '+' : '',
              n: variance,
            }),
      )
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.session.reconcileFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setActingId(null)
    }
  }

  const handleIgnore = (item: CountItem) => {
    setReasonInput('')
    setReasonPrompt({ kind: 'ignore', itemId: item.id, sku: item.sku })
  }

  const performIgnore = async (itemId: string, sku: string, notes: string | null) => {
    setActingId(itemId)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/items/${itemId}/ignore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('cycleCount.session.ignoredToast', { sku }))
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.session.ignoreFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setActingId(null)
    }
  }

  // S.7 — barcode-driven workflow. USB scanners emit SKU+Enter as
  // keystrokes; mobile cameras decode via @zxing/browser. Either way,
  // BarcodeScanInput passes us the raw text and we route it to the
  // matching CountItem. Match is case-insensitive on full SKU; partial
  // matches are intentionally NOT accepted (a half-typed SKU should
  // not race-trigger a focus jump). On match: scroll the row into
  // view, focus its count input. On miss: toast + the scanner
  // refocuses for the next attempt.
  const handleScan = useCallback(
    (raw: string) => {
      if (!data) return
      const target = raw.trim().toUpperCase()
      if (!target) return
      const item = data.items.find((it) => it.sku.toUpperCase() === target)
      if (!item) {
        toast.error(t('cycleCount.session.scanNotInCount', { sku: raw.trim() }))
        return
      }
      if (item.status === 'RECONCILED' || item.status === 'IGNORED') {
        toast.success(t('cycleCount.session.scanAlreadyResolved', { sku: item.sku, status: item.status.toLowerCase() }))
        return
      }
      // querySelector targets the data attribute we'll set on each
      // count input (added below). Defer one tick so a status filter
      // change driven by the scan also has time to settle.
      window.setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>(
          `input[data-cycle-count-input="${item.id}"]`,
        )
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          el.focus()
          el.select()
        } else {
          toast.error(t('cycleCount.session.scanRowHidden', { sku: item.sku }))
        }
      }, 0)
    },
    [data, toast, t],
  )

  // S.5 — submit handler for the reason prompt modal. Routes to the
  // correct perform* by reasonPrompt.kind. Closes the modal after the
  // action settles. Empty input becomes null (server distinguishes
  // "no reason" from an empty string).
  const submitReason = async () => {
    if (!reasonPrompt) return
    const reason = reasonInput.trim() ? reasonInput.trim() : null
    setReasonSubmitting(true)
    try {
      if (reasonPrompt.kind === 'cancel') {
        await performCancel(reason)
      } else {
        await performIgnore(reasonPrompt.itemId, reasonPrompt.sku, reason)
      }
      setReasonPrompt(null)
      setReasonInput('')
    } finally {
      setReasonSubmitting(false)
    }
  }

  const FILTER_KEYS: Array<{ key: StatusFilter; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'PENDING', label: 'Pending' },
    { key: 'COUNTED', label: 'Counted' },
    { key: 'variance', label: 'Variance > 0' },
    { key: 'RECONCILED', label: 'Reconciled' },
    { key: 'IGNORED', label: 'Ignored' },
  ]

  return (
    <div className="space-y-3">
      <Button variant="secondary" size="sm" onClick={() => router.push('/fulfillment/stock/cycle-count')}>
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to list
      </Button>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded animate-pulse" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Header card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <ClipboardCheck className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                  <Badge variant={statusVariant(data.status)} size="sm">
                    {data.status.replace(/_/g, ' ')}
                  </Badge>
                  <span className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {data.location.name}
                  </span>
                  <span className="text-sm font-mono text-slate-500 dark:text-slate-400">
                    ({data.location.code})
                  </span>
                </div>
                {data.notes && (
                  <div className="text-base text-slate-600 dark:text-slate-400 mt-1 italic">
                    {data.notes}
                  </div>
                )}
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {data.startedAt && <>Started {new Date(data.startedAt).toLocaleString()}</>}
                  {data.completedAt && <> · Completed {new Date(data.completedAt).toLocaleString()}</>}
                  {data.cancelledAt && (
                    <> · Cancelled {new Date(data.cancelledAt).toLocaleString()}
                      {data.cancelledReason && <> ({data.cancelledReason})</>}
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {data.status === 'DRAFT' && (
                  <>
                    <Button variant="primary" size="sm" onClick={handleStart} disabled={busyTopAction !== null}>
                      {busyTopAction === 'start' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                      Start counting
                    </Button>
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={busyTopAction !== null}
                      className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium text-red-700 bg-white dark:bg-slate-900 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                    >
                      <Ban className="w-3 h-3" />
                      Cancel
                    </button>
                  </>
                )}
                {isInProgress && (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleComplete}
                      disabled={!allResolved || busyTopAction !== null}
                      title={
                        allResolved
                          ? t('cycleCount.session.completeReadyTitle')
                          : t('cycleCount.session.completeBlockedTitle')
                      }
                    >
                      {busyTopAction === 'complete' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      Complete count
                    </Button>
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={busyTopAction !== null}
                      className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium text-red-700 bg-white dark:bg-slate-900 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                    >
                      <Ban className="w-3 h-3" />
                      Cancel
                    </button>
                  </>
                )}
                <Button variant="secondary" size="sm" onClick={fetchData}>
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* Progress bar */}
            {data.items.length > 0 && data.status !== 'CANCELLED' && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400 mb-1">
                  <span>
                    {(counts.RECONCILED ?? 0) + (counts.IGNORED ?? 0)} of {data.items.length} resolved
                  </span>
                  <span>
                    {Math.round(
                      (((counts.RECONCILED ?? 0) + (counts.IGNORED ?? 0)) / data.items.length) * 100,
                    )}%
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all',
                      data.status === 'COMPLETED' ? 'bg-green-500' : 'bg-blue-500',
                    )}
                    style={{
                      width: `${(((counts.RECONCILED ?? 0) + (counts.IGNORED ?? 0)) / data.items.length) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-1 flex-wrap">
            {FILTER_KEYS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  'min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium rounded border transition-colors',
                  filter === f.key
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {f.label}
                <span className="ml-1 opacity-70">{counts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>

          {/* S.7 — barcode-driven workflow. Only shown while the
              session is IN_PROGRESS (counts can actually be entered).
              Scanner emits SKU + Enter → BarcodeScanInput calls
              handleScan → row is scrolled into view + count input
              focused. Camera mode (mobile) is enabled by default. */}
          {isInProgress && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
              <BarcodeScanInput
                label={t('cycleCount.session.scanLabel')}
                placeholder={t('cycleCount.session.scanPlaceholder')}
                onScan={handleScan}
                autoFocus={false}
              />
              <div className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">
                {t('cycleCount.session.scanHelp')}
              </div>
            </div>
          )}

          {/* S.9 — mobile card layout. Below sm: the items table is
              hidden in favor of a stacked card view: each row becomes
              a self-contained card with SKU + name on top, expected /
              counted / variance on a row, status badge, and per-item
              actions on the bottom. Same filteredItems source so the
              filters above continue to work. */}
          <div className="sm:hidden space-y-2">
            {filteredItems.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-6 text-center text-base text-slate-500 dark:text-slate-400">
                No items match this filter.
              </div>
            ) : (
              filteredItems.map((it) => {
                const draft = drafts[it.id]
                const showInput =
                  isInProgress && (it.status === 'PENDING' || it.status === 'COUNTED')
                const inputValue =
                  draft !== undefined
                    ? draft
                    : it.countedQuantity != null
                      ? String(it.countedQuantity)
                      : ''
                const isVarianceZero = it.variance === 0
                return (
                  <div
                    key={it.id}
                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm text-slate-900 dark:text-slate-100 break-all">{it.sku}</div>
                        {it.productName && (
                          <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{it.productName}</div>
                        )}
                      </div>
                      <Badge variant={statusVariant(it.status)} size="sm">
                        {it.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <div>
                        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Expected</div>
                        <div className="tabular-nums text-slate-700 dark:text-slate-300 text-base">{it.expectedQuantity}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Counted</div>
                        {showInput ? (
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={inputValue}
                            data-cycle-count-input={it.id}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [it.id]: e.target.value }))
                            }
                            onBlur={() => draft !== undefined && handleRecord(it, draft)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur()
                              }
                            }}
                            disabled={actingId === it.id}
                            className="mt-0.5 w-24 h-11 px-2 text-right tabular-nums text-base border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-300"
                            placeholder="—"
                          />
                        ) : (
                          <div className="tabular-nums text-slate-700 dark:text-slate-300 text-base">{it.countedQuantity ?? '—'}</div>
                        )}
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Variance</div>
                        <div className={cn(
                          'tabular-nums text-base font-semibold',
                          it.variance == null
                            ? 'text-slate-400 dark:text-slate-500'
                            : isVarianceZero
                              ? 'text-slate-400 dark:text-slate-500'
                              : it.variance > 0
                                ? 'text-amber-700'
                                : 'text-red-700',
                        )}>
                          {it.variance == null ? '—' : `${it.variance > 0 ? '+' : ''}${it.variance}`}
                        </div>
                      </div>
                    </div>
                    {it.status === 'COUNTED' && isInProgress && (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handleReconcile(it)}
                          disabled={actingId === it.id}
                          className="flex-1 inline-flex items-center justify-center gap-1 min-h-[44px] px-3 text-sm font-medium text-white bg-green-600 border border-green-600 rounded hover:bg-green-700 disabled:opacity-50"
                        >
                          {actingId === it.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5" />
                          )}
                          {isVarianceZero ? 'Match' : 'Reconcile'}
                        </button>
                        {!isVarianceZero && (
                          <button
                            type="button"
                            onClick={() => handleIgnore(it)}
                            disabled={actingId === it.id}
                            className="flex-1 inline-flex items-center justify-center gap-1 min-h-[44px] px-3 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                          >
                            <SkipForward className="w-3.5 h-3.5" />
                            Ignore
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          {/* Items table — hidden on mobile (cards above). */}
          <div className="hidden sm:block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <table className="w-full text-base">
              <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="text-left font-medium px-3 py-2">SKU</th>
                  <th className="text-right font-medium px-3 py-2 w-24">Expected</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Counted</th>
                  <th className="text-right font-medium px-3 py-2 w-24">Variance</th>
                  <th className="text-left font-medium px-3 py-2 w-32">Status</th>
                  <th className="text-right font-medium px-3 py-2 w-56"></th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-base text-slate-500 dark:text-slate-400">
                      No items match this filter.
                    </td>
                  </tr>
                )}
                {filteredItems.map((it) => {
                  const draft = drafts[it.id]
                  const showInput =
                    isInProgress && (it.status === 'PENDING' || it.status === 'COUNTED')
                  const inputValue =
                    draft !== undefined
                      ? draft
                      : it.countedQuantity != null
                        ? String(it.countedQuantity)
                        : ''
                  const isVarianceZero = it.variance === 0
                  return (
                    <tr key={it.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 align-middle">
                      <td className="px-3 py-2">
                        <div className="font-mono text-sm text-slate-900 dark:text-slate-100">{it.sku}</div>
                        {it.productName && (
                          <div className="text-sm text-slate-500 dark:text-slate-400 truncate max-w-md">
                            {it.productName}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {it.expectedQuantity}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {showInput ? (
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={inputValue}
                            data-cycle-count-input={it.id}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [it.id]: e.target.value }))
                            }
                            onBlur={() => draft !== undefined && handleRecord(it, draft)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur()
                              }
                            }}
                            disabled={actingId === it.id}
                            className="w-24 h-11 sm:h-8 px-2 text-right tabular-nums text-base border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-300"
                            placeholder="—"
                          />
                        ) : (
                          <span className="tabular-nums text-slate-700 dark:text-slate-300">
                            {it.countedQuantity ?? '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {it.variance == null ? (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        ) : (
                          <span
                            className={cn(
                              'font-semibold',
                              isVarianceZero
                                ? 'text-slate-400 dark:text-slate-500'
                                : it.variance > 0
                                  ? 'text-amber-700'
                                  : 'text-red-700',
                            )}
                          >
                            {it.variance > 0 ? '+' : ''}
                            {it.variance}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={statusVariant(it.status)} size="sm">
                          {it.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {it.status === 'COUNTED' && isInProgress && (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleReconcile(it)}
                              disabled={actingId === it.id}
                              className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-white bg-green-600 border border-green-600 rounded hover:bg-green-700 disabled:opacity-50"
                              title={
                                isVarianceZero
                                  ? t('cycleCount.session.actionMatchTitle')
                                  : t('cycleCount.session.actionReconcileTitle')
                              }
                            >
                              {actingId === it.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                              ) : (
                                <Check className="w-3 h-3" aria-hidden="true" />
                              )}
                              {isVarianceZero ? t('cycleCount.session.actionMatch') : t('cycleCount.session.actionReconcile')}
                            </button>
                            {!isVarianceZero && (
                              <button
                                type="button"
                                onClick={() => handleIgnore(it)}
                                disabled={actingId === it.id}
                                className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                                title={t('cycleCount.session.actionIgnoreTitle')}
                              >
                                <SkipForward className="w-3 h-3" aria-hidden="true" />
                                {t('cycleCount.session.actionIgnore')}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* S.5 — reason prompt modal (cancel session / ignore item).
          Replaces two window.prompt() calls. The Modal primitive handles
          focus management, Escape, backdrop dismiss, and body scroll lock. */}
      <Modal
        open={reasonPrompt !== null}
        onClose={() => {
          if (reasonSubmitting) return
          setReasonPrompt(null)
          setReasonInput('')
        }}
        title={
          reasonPrompt?.kind === 'cancel'
            ? t('cycleCount.session.reasonModal.cancelTitle')
            : reasonPrompt?.kind === 'ignore'
              ? t('cycleCount.session.reasonModal.ignoreTitle', { sku: reasonPrompt.sku })
              : ''
        }
        description={
          reasonPrompt?.kind === 'cancel'
            ? t('cycleCount.session.reasonModal.cancelDescription')
            : t('cycleCount.session.reasonModal.ignoreDescription')
        }
        size="md"
      >
        <ModalBody>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
            {t('cycleCount.session.reasonModal.label')} <span className="text-slate-400 dark:text-slate-500 font-normal">{t('cycleCount.session.reasonModal.optional')}</span>
          </label>
          <textarea
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            rows={3}
            placeholder={
              reasonPrompt?.kind === 'cancel'
                ? t('cycleCount.session.reasonModal.cancelPlaceholder')
                : t('cycleCount.session.reasonModal.ignorePlaceholder')
            }
            className="w-full px-3 py-2 text-base border border-slate-200 dark:border-slate-700 rounded focus:border-slate-400 focus:outline-none"
            disabled={reasonSubmitting}
          />
        </ModalBody>
        <ModalFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setReasonPrompt(null)
              setReasonInput('')
            }}
            disabled={reasonSubmitting}
          >
            Back
          </Button>
          <Button
            variant={reasonPrompt?.kind === 'cancel' ? 'danger' : 'primary'}
            onClick={submitReason}
            disabled={reasonSubmitting}
          >
            {reasonSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {reasonPrompt?.kind === 'cancel' ? 'Cancel count' : 'Ignore variance'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}
