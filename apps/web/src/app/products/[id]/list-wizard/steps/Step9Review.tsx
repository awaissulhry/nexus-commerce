'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

type SliceStatus = 'complete' | 'incomplete' | 'skipped' | 'unknown'

interface ValidationItem {
  step: number
  title: string
  status: SliceStatus
  message?: string
}

interface ValidationReport {
  ready: boolean
  items: ValidationItem[]
  blockingCount: number
}

interface ReviewResponse {
  wizard: {
    id: string
    channel: string
    marketplace: string
    status: string
    currentStep: number
  }
  report: ValidationReport
  amazonPayload: unknown
}

export default function Step9Review({
  wizardId,
  updateWizardState,
}: StepProps) {
  const [data, setData] = useState<ReviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showPayload, setShowPayload] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/review`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          return
        }
        setData(json as ReviewResponse)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [wizardId, reloadKey])

  const onContinue = useCallback(async () => {
    if (!data?.report.ready) return
    await updateWizardState({}, { advance: true })
  }, [data?.report.ready, updateWizardState])

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            Review &amp; Verify
          </h2>
          <p className="text-[13px] text-slate-600 mt-1">
            Quick checklist before you submit. Inspect the prepared channel
            payload below if you want to see exactly what would be sent.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="text-[12px] text-blue-600 hover:underline disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading review…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          <div className="border border-slate-200 rounded-lg bg-white">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
              <div className="text-[12px] font-medium text-slate-700">
                Step checklist
              </div>
              <ReadyBadge ready={data.report.ready} />
            </div>
            {data.report.items.map((item) => (
              <ChecklistRow key={item.step} item={item} />
            ))}
          </div>

          {/* Prepared payload preview (Amazon only for now). */}
          {data.amazonPayload && (
            <div className="mt-5 border border-slate-200 rounded-lg bg-white">
              <button
                type="button"
                onClick={() => setShowPayload((s) => !s)}
                className="w-full flex items-center justify-between px-3 py-2 text-[12px] text-slate-700 hover:bg-slate-50"
              >
                <span className="font-medium">
                  {showPayload ? 'Hide' : 'Show'} prepared Amazon payload
                </span>
                {showPayload ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
              {showPayload && (
                <pre className="px-3 py-3 text-[11px] font-mono text-slate-700 bg-slate-50 max-h-[360px] overflow-auto border-t border-slate-200">
                  {JSON.stringify(data.amazonPayload, null, 2)}
                </pre>
              )}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-3">
            <span className="text-[12px] text-slate-600">
              {data.report.ready
                ? 'All steps complete — proceed to submit.'
                : `${data.report.blockingCount} step${
                    data.report.blockingCount === 1 ? '' : 's'
                  } blocking`}
            </span>
            <button
              type="button"
              onClick={onContinue}
              disabled={!data.report.ready}
              className={cn(
                'h-8 px-4 rounded-md text-[13px] font-medium',
                !data.report.ready
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ChecklistRow({ item }: { item: ValidationItem }) {
  return (
    <div className="px-3 py-2 border-b border-slate-100 last:border-b-0 flex items-center gap-3">
      <StatusIcon status={item.status} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-slate-900 truncate">
          Step {item.step} · {item.title}
        </div>
        {item.message && (
          <div className="text-[11px] text-slate-500 truncate">
            {item.message}
          </div>
        )}
      </div>
      <StatusBadge status={item.status} />
    </div>
  )
}

function StatusIcon({ status }: { status: SliceStatus }) {
  if (status === 'complete')
    return <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
  if (status === 'incomplete')
    return <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
  if (status === 'skipped')
    return <MinusCircle className="w-4 h-4 text-slate-400 flex-shrink-0" />
  return <Circle className="w-4 h-4 text-slate-300 flex-shrink-0" />
}

function StatusBadge({ status }: { status: SliceStatus }) {
  const tone =
    status === 'complete'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'incomplete'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : status === 'skipped'
      ? 'bg-slate-50 text-slate-500 border-slate-200'
      : 'bg-slate-50 text-slate-400 border-slate-200'
  return (
    <span
      className={cn(
        'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 border rounded',
        tone,
      )}
    >
      {status}
    </span>
  )
}

function ReadyBadge({ ready }: { ready: boolean }) {
  if (ready) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
        <CheckCircle2 className="w-3 h-3" /> Ready to submit
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
      <AlertCircle className="w-3 h-3" /> Not ready
    </span>
  )
}
