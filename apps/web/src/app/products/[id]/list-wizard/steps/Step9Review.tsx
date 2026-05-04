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

interface ChannelValidationReport {
  channelKey: string
  platform: string
  marketplace: string
  ready: boolean
  blockingCount: number
  items: ValidationItem[]
  warnings: string[]
}

interface MultiChannelValidation {
  channels: ChannelValidationReport[]
  allReady: boolean
  blockingChannels: string[]
}

interface ChannelPayloadEntry {
  channelKey: string
  platform: string
  marketplace: string
  payload?: any
  unsupported?: boolean
  reason?: string
}

interface ReviewResponse {
  wizard: {
    id: string
    channels: any
    status: string
    currentStep: number
  }
  validation: MultiChannelValidation
  payloads: ChannelPayloadEntry[]
}

export default function Step9Review({
  wizardId,
  updateWizardState,
}: StepProps) {
  const [data, setData] = useState<ReviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [expandedPayloads, setExpandedPayloads] = useState<Set<string>>(
    new Set(),
  )
  const [expandedChecklists, setExpandedChecklists] = useState<Set<string>>(
    new Set(),
  )

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

  const togglePayload = useCallback((channelKey: string) => {
    setExpandedPayloads((prev) => {
      const next = new Set(prev)
      if (next.has(channelKey)) next.delete(channelKey)
      else next.add(channelKey)
      return next
    })
  }, [])
  const toggleChecklist = useCallback((channelKey: string) => {
    setExpandedChecklists((prev) => {
      const next = new Set(prev)
      if (next.has(channelKey)) next.delete(channelKey)
      else next.add(channelKey)
      return next
    })
  }, [])

  const onContinue = useCallback(async () => {
    if (!data?.validation.allReady) return
    await updateWizardState({}, { advance: true })
  }, [data?.validation.allReady, updateWizardState])

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            Review &amp; Verify
          </h2>
          <p className="text-[13px] text-slate-600 mt-1">
            Per-channel pre-submit checklist. Expand any card to see its
            full step-by-step status or the prepared channel payload.
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
          {/* Top summary */}
          <div className="mb-4 border border-slate-200 rounded-lg bg-white px-4 py-3 flex items-center justify-between">
            <div className="text-[13px] text-slate-700">
              <span className="font-semibold">
                {data.validation.channels.length}
              </span>{' '}
              channel{data.validation.channels.length === 1 ? '' : 's'} ·{' '}
              <span
                className={cn(
                  'font-semibold',
                  data.validation.blockingChannels.length === 0
                    ? 'text-emerald-700'
                    : 'text-amber-700',
                )}
              >
                {data.validation.blockingChannels.length === 0
                  ? 'All ready'
                  : `${data.validation.blockingChannels.length} blocking`}
              </span>
            </div>
            <ReadyBadge allReady={data.validation.allReady} />
          </div>

          {/* Per-channel cards */}
          <div className="space-y-3">
            {data.validation.channels.map((report) => {
              const payload = data.payloads.find(
                (p) => p.channelKey === report.channelKey,
              )
              return (
                <ChannelCard
                  key={report.channelKey}
                  report={report}
                  payload={payload}
                  checklistExpanded={expandedChecklists.has(report.channelKey)}
                  payloadExpanded={expandedPayloads.has(report.channelKey)}
                  onToggleChecklist={() => toggleChecklist(report.channelKey)}
                  onTogglePayload={() => togglePayload(report.channelKey)}
                />
              )
            })}
          </div>

          {/* Continue */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <span className="text-[12px] text-slate-600">
              {data.validation.allReady
                ? 'All channels complete — proceed to submit.'
                : `${data.validation.blockingChannels.length} channel${
                    data.validation.blockingChannels.length === 1 ? '' : 's'
                  } blocking`}
            </span>
            <button
              type="button"
              onClick={onContinue}
              disabled={!data.validation.allReady}
              className={cn(
                'h-8 px-4 rounded-md text-[13px] font-medium',
                !data.validation.allReady
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

function ChannelCard({
  report,
  payload,
  checklistExpanded,
  payloadExpanded,
  onToggleChecklist,
  onTogglePayload,
}: {
  report: ChannelValidationReport
  payload: ChannelPayloadEntry | undefined
  checklistExpanded: boolean
  payloadExpanded: boolean
  onToggleChecklist: () => void
  onTogglePayload: () => void
}) {
  const tone = report.ready
    ? 'border-slate-200'
    : 'border-amber-200 bg-amber-50/30'
  const incomplete = report.items.filter((i) => i.status === 'incomplete')
  return (
    <div className={cn('border rounded-lg bg-white', tone)}>
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-0">
          {report.ready ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-mono text-[13px] text-slate-900 font-medium truncate">
              {report.channelKey}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {report.platform} · {report.marketplace}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {report.ready ? (
            <span className="text-[10px] uppercase tracking-wide font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
              Ready
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-wide font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              {report.blockingCount} blocking
            </span>
          )}
          {payload?.unsupported && (
            <span
              className="text-[10px] uppercase tracking-wide font-medium text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded"
              title={payload.reason}
            >
              Adapter not wired
            </span>
          )}
        </div>
      </div>

      {/* Always-visible blocking items + warnings */}
      {(incomplete.length > 0 || report.warnings.length > 0) && (
        <div className="px-4 py-2 space-y-1 border-b border-slate-100">
          {incomplete.map((it, i) => (
            <div
              key={`i-${i}`}
              className="text-[12px] text-amber-700 inline-flex items-start gap-1.5"
            >
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                Step {it.step} ({it.title}){it.message ? ` — ${it.message}` : ''}
              </span>
            </div>
          ))}
          {report.warnings.map((w, i) => (
            <div
              key={`w-${i}`}
              className="text-[12px] text-slate-600 inline-flex items-start gap-1.5"
            >
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Toggle: full checklist */}
      <button
        type="button"
        onClick={onToggleChecklist}
        className="w-full flex items-center justify-between gap-2 px-4 py-2 text-[12px] text-slate-700 hover:bg-slate-50"
      >
        <span className="inline-flex items-center gap-1.5">
          {checklistExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          {checklistExpanded ? 'Hide' : 'Show'} full step checklist
        </span>
        <span className="text-[10px] text-slate-400 font-mono">
          {report.items.filter((i) => i.status === 'complete').length}/
          {report.items.length}
        </span>
      </button>
      {checklistExpanded && (
        <div className="px-4 py-2 border-t border-slate-100 space-y-1">
          {report.items.map((it) => (
            <div
              key={it.step}
              className="flex items-center gap-2 text-[12px]"
            >
              <StatusIcon status={it.status} />
              <span className="font-mono text-slate-500 w-12 text-[11px]">
                Step {it.step}
              </span>
              <span className="text-slate-700">{it.title}</span>
              {it.message && (
                <span className="text-slate-500 text-[11px] truncate">
                  · {it.message}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Toggle: prepared payload */}
      {payload && !payload.unsupported && (
        <>
          <button
            type="button"
            onClick={onTogglePayload}
            className="w-full flex items-center justify-between gap-2 px-4 py-2 text-[12px] text-slate-700 border-t border-slate-100 hover:bg-slate-50"
          >
            <span className="inline-flex items-center gap-1.5">
              {payloadExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              {payloadExpanded ? 'Hide' : 'Show'} prepared payload
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              {payload.platform}
            </span>
          </button>
          {payloadExpanded && (
            <pre className="px-4 py-3 text-[11px] font-mono text-slate-700 bg-slate-50 max-h-[360px] overflow-auto border-t border-slate-100">
              {JSON.stringify(payload.payload, null, 2)}
            </pre>
          )}
        </>
      )}
      {payload?.unsupported && (
        <div className="px-4 py-2 border-t border-slate-100 text-[12px] text-slate-500">
          {payload.reason}
        </div>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: SliceStatus }) {
  if (status === 'complete')
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
  if (status === 'incomplete')
    return <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
  if (status === 'skipped')
    return <MinusCircle className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
  return <Circle className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />
}

function ReadyBadge({ allReady }: { allReady: boolean }) {
  if (allReady) {
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
