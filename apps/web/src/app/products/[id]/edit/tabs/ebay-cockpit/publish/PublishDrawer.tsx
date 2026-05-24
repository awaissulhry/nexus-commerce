'use client'

// EC.11 — PublishDrawer
//
// Drives the cockpit Publish button. Walks the operator through:
//
//   1. Pre-flight gate — surface any hard fails from EC.9 so the
//      operator can fix them BEFORE firing an eBay API call. The
//      adapter would catch these too, but we want a single clear
//      surface instead of an opaque API error.
//   2. Confirm — show what's about to ship (title, category, price,
//      qty, image count) and a "Publish to {marketplace}" CTA.
//   3. Three-step progress — Inventory / Offer / Publish with live
//      tick marks as the adapter walks through them. Per-step error
//      surfacing when the adapter returns failedStep.
//   4. Success — listing URL + "Open on eBay" + "Close".
//
// All four phases live inside the same drawer; the body swaps as the
// flow progresses. A failed publish always leaves the operator at
// the error step with a Retry button + a "Restore pre-publish
// snapshot" escape hatch.

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  X, Send, CheckCircle2, XCircle, Loader2, Ban, ExternalLink, ShieldAlert, RotateCcw,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Phase = 'preflight' | 'confirm' | 'running' | 'success' | 'failure'
type Step = 'createInventory' | 'createOffer' | 'publishOffer'
type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

interface HardFail {
  label: string
  hint?: string
}

interface PublishResult {
  ok: boolean
  sku?: string
  offerId?: string
  listingId?: string
  listingUrl?: string
  error?: string
  failedStep?: string
  snapshotId?: string
}

interface Props {
  productId: string
  marketplace: string
  marketName: string
  /** Hard fails from EC.9's health score — empty when ready to ship. */
  hardFails: HardFail[]
  /** Summary the confirm step shows. */
  summary: {
    title: string
    categoryName: string | null
    price: number | null
    currency: string
    quantity: number | null
    imageCount: number
    aspectCount: number
  }
  open: boolean
  onClose: () => void
}

const STEP_LABEL: Record<Step, string> = {
  createInventory: 'Create / replace inventory item',
  createOffer:     'Create offer',
  publishOffer:    'Publish offer',
}

const ALL_STEPS: Step[] = ['createInventory', 'createOffer', 'publishOffer']

export default function PublishDrawer(props: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>(() =>
    props.hardFails.length > 0 ? 'preflight' : 'confirm',
  )
  const [stepStatus, setStepStatus] = useState<Record<Step, StepStatus>>({
    createInventory: 'pending',
    createOffer: 'pending',
    publishOffer: 'pending',
  })
  const [result, setResult] = useState<PublishResult | null>(null)
  const [restoring, setRestoring] = useState(false)

  // Reset to initial phase whenever the drawer is reopened.
  // Otherwise a previous success would linger across opens.
  // useEffect not needed — phase resets via open prop check below.

  const handleStart = useCallback(async () => {
    setPhase('running')
    setStepStatus({ createInventory: 'running', createOffer: 'pending', publishOffer: 'pending' })
    setResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: props.productId, marketplace: props.marketplace }),
      })
      const json = (await res.json()) as PublishResult
      // The adapter is synchronous from the client's perspective —
      // we don't get per-step events. Reconstruct the step view
      // from failedStep + ok.
      if (json.ok) {
        setStepStatus({ createInventory: 'done', createOffer: 'done', publishOffer: 'done' })
        setResult(json)
        setPhase('success')
        router.refresh()
      } else {
        const failed = (json.failedStep ?? 'createInventory') as Step
        const next: Record<Step, StepStatus> = {
          createInventory: 'pending', createOffer: 'pending', publishOffer: 'pending',
        }
        let hit = false
        for (const s of ALL_STEPS) {
          if (hit) { next[s] = 'skipped'; continue }
          if (s === failed) { next[s] = 'failed'; hit = true; continue }
          next[s] = 'done'
        }
        setStepStatus(next)
        setResult(json)
        setPhase('failure')
      }
    } catch (err) {
      setStepStatus({ createInventory: 'failed', createOffer: 'skipped', publishOffer: 'skipped' })
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
      setPhase('failure')
    }
  }, [props.productId, props.marketplace, router])

  const handleRestoreSnapshot = useCallback(async () => {
    if (!result?.snapshotId || restoring) return
    setRestoring(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/snapshot/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: props.productId,
          marketplace: props.marketplace,
          snapshotId: result.snapshotId,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      router.refresh()
      props.onClose()
    } catch (err) {
      setResult((r) => r ? { ...r, error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` } : r)
    } finally {
      setRestoring(false)
    }
  }, [result, restoring, props, router])

  if (!props.open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex"
      onClick={() => { if (phase !== 'running') props.onClose() }}
    >
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-drawer-title"
        className="w-full max-w-md bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div id="publish-drawer-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Send className="w-4 h-4 text-blue-500" /> Publish to eBay {props.marketName}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Inventory API · three-step flow
            </div>
          </div>
          {phase !== 'running' && (
            <button
              type="button"
              onClick={props.onClose}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {phase === 'preflight' && <PreflightView hardFails={props.hardFails} onClose={props.onClose} />}
          {phase === 'confirm' && (
            <ConfirmView
              summary={props.summary}
              marketName={props.marketName}
              onStart={handleStart}
              onCancel={props.onClose}
            />
          )}
          {phase === 'running' && <ProgressView stepStatus={stepStatus} />}
          {phase === 'success' && result && (
            <SuccessView result={result} marketName={props.marketName} onClose={props.onClose} />
          )}
          {phase === 'failure' && result && (
            <FailureView
              result={result}
              stepStatus={stepStatus}
              onRetry={handleStart}
              onRestore={result.snapshotId ? handleRestoreSnapshot : null}
              restoring={restoring}
              onClose={props.onClose}
            />
          )}
        </div>
      </aside>
    </div>
  )
}

// ── Pre-flight ─────────────────────────────────────────────────────────
function PreflightView({ hardFails, onClose }: { hardFails: HardFail[]; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <div className="px-3 py-2 rounded border border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/30 text-xs text-rose-800 dark:text-rose-300 flex items-start gap-2">
        <Ban className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">Publish blocked</div>
          <div className="mt-0.5">Fix these hard fails before publishing. They&apos;d be rejected by eBay anyway.</div>
        </div>
      </div>
      <ul className="space-y-1.5">
        {hardFails.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-xs px-2.5 py-2 rounded border border-rose-100 dark:border-rose-900/40">
            <XCircle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium text-slate-800 dark:text-slate-200">{f.label}</div>
              {f.hint && <div className="text-[10.5px] text-slate-500 mt-0.5">{f.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
      <div className="pt-2 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Close
        </button>
      </div>
    </div>
  )
}

// ── Confirm ────────────────────────────────────────────────────────────
function ConfirmView({
  summary, marketName, onStart, onCancel,
}: {
  summary: Props['summary']
  marketName: string
  onStart: () => void
  onCancel: () => void
}) {
  const formatPrice = summary.price != null
    ? `${summary.currency} ${summary.price.toFixed(2)}`
    : '—'
  return (
    <div className="space-y-4">
      <div className="text-xs text-slate-600 dark:text-slate-400">
        About to publish to <span className="font-medium text-slate-800 dark:text-slate-200">eBay {marketName}</span>:
      </div>
      <div className="rounded border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
        <SummaryRow label="Title" value={summary.title || <em className="not-italic text-slate-400">empty</em>} mono />
        <SummaryRow label="Category" value={summary.categoryName ?? <em className="not-italic text-slate-400">missing</em>} />
        <SummaryRow label="Price" value={formatPrice} />
        <SummaryRow label="Quantity" value={summary.quantity ?? '—'} />
        <SummaryRow label="Images" value={`${summary.imageCount} attached`} />
        <SummaryRow label="Aspects" value={`${summary.aspectCount} filled`} />
      </div>
      <div className="text-[10.5px] text-slate-400 italic">
        A pre-publish snapshot will be captured automatically so you
        can roll back in one click if anything looks off post-publish.
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onStart}
          className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white inline-flex items-center gap-1.5"
        >
          <Send className="w-3 h-3" /> Publish to {marketName}
        </button>
      </div>
    </div>
  )
}

function SummaryRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="px-3 py-2 flex items-baseline justify-between gap-3">
      <span className="text-[10.5px] uppercase tracking-wide text-slate-400 font-medium">{label}</span>
      <span className={cn('text-xs text-slate-800 dark:text-slate-200 text-right truncate', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

// ── Progress ───────────────────────────────────────────────────────────
function ProgressView({ stepStatus }: { stepStatus: Record<Step, StepStatus> }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-600 dark:text-slate-400">
        Walking through the three-step Inventory API flow. Don&apos;t close this drawer until it finishes.
      </div>
      <ol className="space-y-2">
        {ALL_STEPS.map((s) => (
          <StepRow key={s} step={s} status={stepStatus[s]} />
        ))}
      </ol>
    </div>
  )
}

function StepRow({ step, status }: { step: Step; status: StepStatus }) {
  const Icon = status === 'done' ? CheckCircle2
    : status === 'failed' ? XCircle
    : status === 'running' ? Loader2
    : status === 'skipped' ? Ban
    : CheckCircle2
  const tone = status === 'done' ? 'text-emerald-500'
    : status === 'failed' ? 'text-rose-500'
    : status === 'running' ? 'text-blue-500'
    : status === 'skipped' ? 'text-slate-300'
    : 'text-slate-300'
  return (
    <li className="flex items-center gap-2 text-xs">
      <Icon className={cn('w-4 h-4 flex-shrink-0', tone, status === 'running' && 'animate-spin')} />
      <span className={cn(
        'flex-1',
        status === 'pending' || status === 'skipped' ? 'text-slate-400' : 'text-slate-800 dark:text-slate-200',
      )}>
        {STEP_LABEL[step]}
      </span>
      <span className="text-[10.5px] text-slate-400 uppercase tracking-wide">
        {status}
      </span>
    </li>
  )
}

// ── Success ────────────────────────────────────────────────────────────
function SuccessView({
  result, marketName, onClose,
}: { result: PublishResult; marketName: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <div className="px-3 py-3 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
          <CheckCircle2 className="w-5 h-5" />
          Published to eBay {marketName}
        </div>
        <div className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-1">
          The listing is now live. SP-API may take a minute to surface
          search visibility — eBay&apos;s indexer is eventually consistent.
        </div>
      </div>
      <div className="rounded border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
        {result.listingId && <SummaryRow label="Item ID" value={result.listingId} mono />}
        {result.offerId && <SummaryRow label="Offer ID" value={result.offerId} mono />}
        {result.sku && <SummaryRow label="SKU" value={result.sku} mono />}
      </div>
      <div className="flex items-center justify-end gap-2">
        {result.listingUrl && (
          <a
            href={result.listingUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
          >
            Open on eBay <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white"
        >
          Done
        </button>
      </div>
    </div>
  )
}

// ── Failure ────────────────────────────────────────────────────────────
function FailureView({
  result, stepStatus, onRetry, onRestore, restoring, onClose,
}: {
  result: PublishResult
  stepStatus: Record<Step, StepStatus>
  onRetry: () => void
  onRestore: (() => void) | null
  restoring: boolean
  onClose: () => void
}) {
  const failedStep = (result.failedStep ?? 'createInventory') as Step
  return (
    <div className="space-y-3">
      <div className="px-3 py-3 rounded border border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/30">
        <div className="flex items-center gap-2 text-sm font-semibold text-rose-800 dark:text-rose-200">
          <XCircle className="w-5 h-5" /> Publish failed at {STEP_LABEL[failedStep]}
        </div>
        <div className="text-[11px] text-rose-700 dark:text-rose-300 mt-1 whitespace-pre-wrap break-words">
          {result.error ?? 'Unknown error'}
        </div>
      </div>
      <ol className="space-y-2">
        {ALL_STEPS.map((s) => (
          <StepRow key={s} step={s} status={stepStatus[s]} />
        ))}
      </ol>
      {onRestore && (
        <div className="text-[10.5px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 pt-1">
          <ShieldAlert className="w-3 h-3" />
          A pre-publish snapshot was captured. If the partial publish left
          the listing in a weird state, restore it below.
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-2">
        {onRestore && (
          <button
            type="button"
            onClick={onRestore}
            disabled={restoring}
            className="px-3 py-1.5 text-xs font-medium rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {restoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Restore pre-publish snapshot
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white"
        >
          Retry
        </button>
      </div>
    </div>
  )
}
