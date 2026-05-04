'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { StepProps } from '../ListWizardClient'
import Step2GtinExemption from './Step2GtinExemption'

interface GtinStatus {
  needed: boolean
  reason:
    | 'has_gtin'
    | 'existing_exemption'
    | 'non_amazon_wizard'
    | 'needed'
    | 'in_progress'
  applicationId?: string | null
  identifier?: string | null
  brand?: string
  marketplaces?: string[]
  status?: string
}

const AUTO_ADVANCE_AFTER_MS = 1500

/**
 * Phase C — auto-skip wrapper around the GTIN-exemption step.
 *
 * Resolution order is server-driven (see /gtin-status). When the
 * step is not needed, this component shows a banner with the reason
 * and auto-advances after a short pause so the user sees what
 * happened. The advance also writes wizardState.gtinStatus so later
 * steps (Step 5 + Step 11 submit) know the path that was taken.
 *
 * When needed=true, the existing Step 4 form renders unchanged.
 */
export default function Step4GtinGate(props: StepProps & {
  onMarkSkipped?: () => void
  onMarkUnskipped?: () => void
}) {
  const { wizardId, updateWizardState } = props
  const [status, setStatus] = useState<GtinStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const advancedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/gtin-status`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status: code, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${code}`)
          return
        }
        setStatus(json as GtinStatus)
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
  }, [wizardId])

  // Tell ListWizardClient whether this step should appear "skipped"
  // in the stepper. Skipped state propagates while the gate decides
  // not-needed; flipped back the moment we see needed=true.
  useEffect(() => {
    if (!status) return
    if (!status.needed) {
      props.onMarkSkipped?.()
    } else {
      props.onMarkUnskipped?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.needed])

  // Auto-advance when not needed.
  useEffect(() => {
    if (!status || status.needed || advancedRef.current) return
    advancedRef.current = true
    const t = window.setTimeout(() => {
      void updateWizardState(
        { gtinStatus: { autoSkipped: true, reason: status.reason } },
        { advance: true },
      )
    }, AUTO_ADVANCE_AFTER_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.needed, status?.reason])

  if (loading) {
    return (
      <div className="max-w-xl mx-auto py-12 px-6 text-center">
        <Loader2 className="w-5 h-5 mx-auto text-slate-400 animate-spin" />
        <p className="mt-2 text-[12px] text-slate-500">
          Checking exemption status…
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto py-12 px-6">
        <div className="border border-rose-200 bg-rose-50 rounded-lg px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            <p className="mt-1 text-[12px] text-rose-600">
              GTIN status check failed — falling back to the manual form below.
            </p>
          </div>
        </div>
        <div className="mt-6">
          <Step2GtinExemption {...props} />
        </div>
      </div>
    )
  }

  if (!status) return null

  if (!status.needed) {
    return <SkippedPanel status={status} />
  }

  return <Step2GtinExemption {...props} />
}

function SkippedPanel({ status }: { status: GtinStatus }) {
  const headline = (() => {
    switch (status.reason) {
      case 'has_gtin':
        return 'GTIN already on the product'
      case 'existing_exemption':
        return 'GTIN exemption already approved'
      case 'non_amazon_wizard':
        return 'GTIN exemption is Amazon-only'
      default:
        return 'No exemption needed'
    }
  })()

  const detail = (() => {
    switch (status.reason) {
      case 'has_gtin':
        return status.identifier ? (
          <>
            The master product already has{' '}
            <span className="font-mono text-slate-900">{status.identifier}</span>{' '}
            — Amazon will accept that on the listing without an exemption.
          </>
        ) : (
          'The master product already carries a GTIN/UPC/EAN.'
        )
      case 'existing_exemption':
        return (
          <>
            <span className="font-semibold text-slate-900">{status.brand}</span>{' '}
            already has an approved exemption covering{' '}
            {status.marketplaces?.join(', ') ?? 'the selected marketplaces'}.
            New listings under this brand pass through automatically.
          </>
        )
      case 'non_amazon_wizard':
        return 'No Amazon channels in this wizard, so the exemption flow is not relevant.'
      default:
        return 'Auto-advancing to the next step.'
    }
  })()

  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <div className="border border-emerald-200 bg-emerald-50 rounded-lg px-4 py-4 text-center">
        <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto mb-2" />
        <h3 className="text-[14px] font-semibold text-emerald-900">
          {headline}
        </h3>
        <p className="mt-1 text-[12px] text-emerald-800">{detail}</p>
        <p className="mt-3 text-[11px] text-emerald-700 inline-flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          Advancing automatically…
        </p>
      </div>
    </div>
  )
}
