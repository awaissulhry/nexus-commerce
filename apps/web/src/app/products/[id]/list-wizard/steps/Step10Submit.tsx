'use client'

import { useCallback, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Rocket,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface SubmitResponse {
  wizard: {
    id: string
    status: string
    completedAt: string | null
  }
  report: {
    ready: boolean
    blockingCount: number
  }
  amazonPayload: unknown
  channelPushed: boolean
  channelPushReason: string
}

export default function Step10Submit({
  wizardId,
  channel,
  marketplace,
  product,
}: StepProps) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<SubmitResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      setResult(json as SubmitResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [wizardId])

  const goToProduct = useCallback(() => {
    router.push(`/products/${product.id}/edit`)
  }, [product.id, router])

  // ── Pre-submit state ──────────────────────────────────────────
  if (!result) {
    return (
      <div className="max-w-xl mx-auto py-12 px-6">
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 text-blue-600 mb-4">
            <Rocket className="w-6 h-6" />
          </div>
          <h2 className="text-[18px] font-semibold text-slate-900">
            Ready to submit
          </h2>
          <p className="mt-2 text-[13px] text-slate-600">
            <span className="font-mono text-slate-800">{product.sku}</span>{' '}
            will be saved as SUBMITTED and queued for{' '}
            <span className="font-mono">{channel}</span>{' '}
            <span className="font-mono">{marketplace}</span>.
          </p>

          {error && (
            <div className="mt-4 border border-rose-200 bg-rose-50 rounded px-3 py-2 text-[12px] text-rose-700 inline-flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            className={cn(
              'mt-6 inline-flex items-center gap-2 h-10 px-5 rounded-md text-[14px] font-medium',
              submitting
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700',
            )}
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Rocket className="w-4 h-4" />
            )}
            Submit listing
          </button>
        </div>
      </div>
    )
  }

  // ── Post-submit state ─────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <div className="border border-slate-200 rounded-lg bg-white px-6 py-8 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 mb-4">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <h2 className="text-[18px] font-semibold text-slate-900">
          Wizard submitted
        </h2>
        <p className="mt-2 text-[13px] text-slate-600">
          Status:{' '}
          <span className="font-mono text-slate-800">
            {result.wizard.status}
          </span>
          {result.wizard.completedAt && (
            <>
              {' · '}
              <span className="text-slate-500">
                {new Date(result.wizard.completedAt).toLocaleString()}
              </span>
            </>
          )}
        </p>

        {!result.channelPushed && (
          <div className="mt-5 text-left border border-amber-200 bg-amber-50 rounded px-3 py-2 text-[12px] text-amber-800">
            <div className="font-medium mb-1 inline-flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Channel push not yet wired
            </div>
            <div className="text-amber-700">{result.channelPushReason}</div>
          </div>
        )}

        <button
          type="button"
          onClick={goToProduct}
          className="mt-6 inline-flex items-center gap-2 h-9 px-4 rounded-md text-[13px] font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
        >
          Back to product
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
