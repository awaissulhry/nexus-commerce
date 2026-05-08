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
      toast.success('Count session started')
      await fetchData()
    } catch (err) {
      toast.error(`Start failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyTopAction(null)
    }
  }

  const handleComplete = async () => {
    if (!(await askConfirm({ title: 'Complete this count session?', description: 'Make sure every variance has been resolved.', confirmLabel: 'Complete', tone: 'warning' }))) return
    setBusyTopAction('complete')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/cycle-counts/${countId}/complete`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success('Count completed')
      await fetchData()
    } catch (err) {
      toast.error(`Complete failed: ${err instanceof Error ? err.message : String(err)}`)
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
      toast.success('Count cancelled')
      await fetchData()
    } catch (err) {
      toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyTopAction(null)
    }
  }

  const handleRecord = async (item: CountItem, raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    const qty = Number(trimmed)
    if (!Number.isInteger(qty) || qty < 0) {
      toast.error('Counted quantity must be a non-negative integer')
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
      toast.error(`Record failed: ${err instanceof Error ? err.message : String(err)}`)
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
          ? `${item.sku}: matched (no variance)`
          : `${item.sku}: variance ${variance > 0 ? '+' : ''}${variance} applied`,
      )
      await fetchData()
    } catch (err) {
      toast.error(`Reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
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
      toast.success(`${sku} marked ignored`)
      await fetchData()
    } catch (err) {
      toast.error(`Ignore failed: ${err instanceof Error ? err.message : String(err)}`)
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
        toast.error(`SKU ${raw.trim()} not in this count`)
        return
      }
      if (item.status === 'RECONCILED' || item.status === 'IGNORED') {
        toast.success(`${item.sku} already ${item.status.toLowerCase()}`)
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
          toast.error(`Row hidden by current filter — clear the filter to count ${item.sku}`)
        }
      }, 0)
    },
    [data, toast],
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
            <div key={i} className="h-10 bg-white border border-slate-200 rounded animate-pulse" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Header card */}
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <ClipboardCheck className="w-5 h-5 text-slate-500" />
                  <Badge variant={statusVariant(data.status)} size="sm">
                    {data.status.replace(/_/g, ' ')}
                  </Badge>
                  <span className="text-lg font-semibold text-slate-900">
                    {data.location.name}
                  </span>
                  <span className="text-sm font-mono text-slate-500">
                    ({data.location.code})
                  </span>
                </div>
                {data.notes && (
                  <div className="text-base text-slate-600 mt-1 italic">
                    {data.notes}
                  </div>
                )}
                <div className="text-sm text-slate-500 mt-1">
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
                      className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium text-red-700 bg-white border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
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
                          ? 'Close this count session'
                          : 'Resolve every variance (reconcile or ignore) before completing'
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
                      className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium text-red-700 bg-white border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
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
                <div className="flex items-center justify-between text-sm text-slate-500 mb-1">
                  <span>
                    {(counts.RECONCILED ?? 0) + (counts.IGNORED ?? 0)} of {data.items.length} resolved
                  </span>
                  <span>
                    {Math.round(
                      (((counts.RECONCILED ?? 0) + (counts.IGNORED ?? 0)) / data.items.length) * 100,
                    )}%
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
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
                    : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
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
            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <BarcodeScanInput
                label="Scan SKU to count"
                placeholder="Aim scanner here or type SKU…"
                onScan={handleScan}
                autoFocus={false}
              />
              <div className="text-sm text-slate-500 mt-1.5">
                Scan or type a SKU to jump to its count input. Camera mode (📷) works on phones.
              </div>
            </div>
          )}

          {/* Items table */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-base">
              <thead className="bg-slate-50 text-sm text-slate-600 border-b border-slate-200">
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
                    <td colSpan={6} className="px-3 py-8 text-center text-base text-slate-500">
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
                    <tr key={it.id} className="border-b border-slate-100 last:border-0 align-middle">
                      <td className="px-3 py-2">
                        <div className="font-mono text-sm text-slate-900">{it.sku}</div>
                        {it.productName && (
                          <div className="text-sm text-slate-500 truncate max-w-md">
                            {it.productName}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
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
                            className="w-24 h-11 sm:h-8 px-2 text-right tabular-nums text-base border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-300"
                            placeholder="—"
                          />
                        ) : (
                          <span className="tabular-nums text-slate-700">
                            {it.countedQuantity ?? '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {it.variance == null ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span
                            className={cn(
                              'font-semibold',
                              isVarianceZero
                                ? 'text-slate-400'
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
                                  ? 'Mark reconciled (no variance)'
                                  : 'Apply variance via StockMovement'
                              }
                            >
                              {actingId === it.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Check className="w-3 h-3" />
                              )}
                              {isVarianceZero ? 'Match' : 'Reconcile'}
                            </button>
                            {!isVarianceZero && (
                              <button
                                type="button"
                                onClick={() => handleIgnore(it)}
                                disabled={actingId === it.id}
                                className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
                                title="Don't apply this variance"
                              >
                                <SkipForward className="w-3 h-3" />
                                Ignore
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
            ? 'Cancel this count?'
            : reasonPrompt?.kind === 'ignore'
              ? `Ignore variance on ${reasonPrompt.sku}?`
              : ''
        }
        description={
          reasonPrompt?.kind === 'cancel'
            ? 'The session will move to CANCELLED and stop accepting counts. Already-reconciled adjustments are kept.'
            : 'The variance is left in the audit trail but is not applied to stock.'
        }
        size="md"
      >
        <ModalBody>
          <label className="text-sm font-medium text-slate-700 block mb-1">
            Reason <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            rows={3}
            placeholder={
              reasonPrompt?.kind === 'cancel'
                ? 'e.g. recount tomorrow with new operator'
                : 'e.g. damaged unit pulled separately'
            }
            className="w-full px-3 py-2 text-base border border-slate-200 rounded focus:border-slate-400 focus:outline-none"
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
