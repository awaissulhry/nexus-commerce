'use client'

// F.5 (TECH_DEBT #50) — v2024-03-20 FBA inbound multi-step wizard.
//
// Operator UX: pick / create a plan, then step through pack →
// placement → transport → labels. Each step lists options from
// SP-API and the operator picks one to advance. Errors land
// non-fatal so the operator can retry without losing prior steps.
//
// State is persisted server-side on FbaInboundPlanV2 — the page
// can be reloaded mid-flow and resume from the recorded step.

import { useMemo, useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Plus,
  AlertCircle,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'

interface Plan {
  id: string
  planId: string | null
  name: string | null
  status: string
  currentStep: string
  selectedPackingOptionId: string | null
  selectedPlacementOptionId: string | null
  shipmentIds: string[]
  labels: Record<string, unknown> | null
  createdAt: string
  lastError: string | null
}

interface Breadcrumb {
  label: string
  href?: string
}

const STEPS = [
  { key: 'CREATE', label: 'Create plan' },
  { key: 'LIST_PACKING', label: 'Pick packing' },
  { key: 'CONFIRM_PACKING', label: 'Confirm packing' },
  { key: 'LIST_PLACEMENT', label: 'Pick placement' },
  { key: 'CONFIRM_PLACEMENT', label: 'Confirm placement' },
  { key: 'LIST_TRANSPORT', label: 'Pick transport' },
  { key: 'CONFIRM_TRANSPORT', label: 'Confirm transport' },
  { key: 'GET_LABELS', label: 'Labels' },
]

export default function FbaInboundV2Wizard({ breadcrumbs }: { breadcrumbs?: Breadcrumb[] }) {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)

  const { data, loading, error, refetch } = usePolledList<{
    plans: Plan[]
    count: number
  }>({
    url: '/api/fba/inbound/v2?limit=20',
    intervalMs: 30_000,
  })

  const selected = useMemo(
    () => data?.plans.find((p) => p.id === selectedPlanId) ?? null,
    [data, selectedPlanId],
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="FBA inbound · v2024-03-20"
        description="Multi-step inbound plan flow (Amazon's current API after the v0 transport endpoint deprecation). Each step is an SP-API call; state persists server-side so you can resume mid-flow."
        breadcrumbs={breadcrumbs}
      />

      {/* Plans list */}
      <Card>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              Plans · {data?.count ?? '—'}
            </div>
            <NewPlanButton onCreated={(id) => { setSelectedPlanId(id); refetch() }} />
          </div>
          {loading && !data ? (
            <Skeleton variant="block" height={120} />
          ) : error ? (
            <div className="text-sm text-rose-700">Failed to load: {error}</div>
          ) : data && data.plans.length === 0 ? (
            <EmptyText text='No plans yet. Click "New plan" to start a v2024-03-20 inbound flow.' />
          ) : (
            <div className="space-y-1.5">
              {data?.plans.map((p) => {
                const isSelected = p.id === selectedPlanId
                const tone = p.status === 'FAILED' ? 'border-rose-300 bg-rose-50/50'
                  : p.status === 'LABELS_READY' ? 'border-emerald-300 bg-emerald-50/50'
                  : 'border-slate-200'
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedPlanId(p.id)}
                    className={`w-full text-left border rounded p-2.5 hover:border-blue-400 transition-colors ${tone} ${isSelected ? 'ring-2 ring-blue-400' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {p.status === 'LABELS_READY' && <CheckCircle2 size={12} className="text-emerald-700" />}
                        {p.status === 'FAILED' && <XCircle size={12} className="text-rose-700" />}
                        {p.status !== 'LABELS_READY' && p.status !== 'FAILED' && <Loader2 size={12} className="text-slate-500" />}
                        <span className="text-sm font-medium">{p.name ?? '(unnamed)'}</span>
                        <span className="text-xs text-slate-500 font-mono">{p.planId ?? '(no planId)'}</span>
                      </div>
                      <span className="text-xs text-slate-500 tabular-nums">{p.status}</span>
                    </div>
                    {p.lastError && (
                      <div className="text-xs text-rose-700 mt-1 line-clamp-2">⚠ {p.lastError}</div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Step tracker for the selected plan */}
      {selected && (
        <Card>
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              Steps — {selected.name ?? selected.planId ?? selected.id}
            </div>
            <StepTracker plan={selected} />
            <PlanActions plan={selected} onAction={() => refetch()} />
          </div>
        </Card>
      )}
    </div>
  )
}

function NewPlanButton({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const handleClick = async () => {
    const name = prompt(
      'Plan name (any short label so you can find it later)?',
      `Inbound ${new Date().toLocaleDateString()}`,
    )
    if (!name) return
    setBusy(true)
    try {
      // Minimal stub body — real wizard step would collect msku /
      // items / sourceAddress. F.5 v1 keeps this MVP so the flow is
      // testable end-to-end; full input form is a follow-up commit.
      const body = {
        spApi: {
          name,
          destinationMarketplaces: ['A1F83G8C2ARO7P'],
          msku: 'PLACEHOLDER',
          items: [{ msku: 'PLACEHOLDER', quantity: 1 }],
          sourceAddress: {
            name: 'Xavia',
            addressLine1: 'Via Esempio 1',
            city: 'Riccione',
            stateOrProvinceCode: 'RN',
            countryCode: 'IT',
            postalCode: '47838',
          },
        },
      }
      const res = await fetch(`${getBackendUrl()}/api/fba/inbound/v2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      toast.success('Plan created — listing packing options next')
      onCreated(j.planRowId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="h-7 px-3 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
      New plan
    </button>
  )
}

function StepTracker({ plan }: { plan: Plan }) {
  const currentIdx = STEPS.findIndex((s) => s.key === plan.currentStep)
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {STEPS.map((step, i) => {
        const done = i < currentIdx || plan.status === 'LABELS_READY'
        const active = i === currentIdx && plan.status !== 'FAILED'
        const failed = i === currentIdx && plan.status === 'FAILED'
        return (
          <div key={step.key} className="flex items-center gap-1">
            <span
              className={`text-xs px-2 py-0.5 rounded border ${
                done ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                : failed ? 'bg-rose-50 border-rose-300 text-rose-700'
                : active ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-slate-200 text-slate-500'
              }`}
            >
              {done ? <CheckCircle2 size={10} className="inline mr-1" /> : null}
              {failed ? <XCircle size={10} className="inline mr-1" /> : null}
              {active ? <Loader2 size={10} className="inline mr-1 animate-spin" /> : null}
              {step.label}
            </span>
            {i < STEPS.length - 1 && <ChevronRight size={11} className="text-slate-300" />}
          </div>
        )
      })}
    </div>
  )
}

function PlanActions({ plan, onAction }: { plan: Plan; onAction: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  const callApi = async (path: string, init?: RequestInit) => {
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}${path}`, init)
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      onAction()
      return j
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  if (plan.status === 'FAILED') {
    return (
      <div className="border border-rose-200 bg-rose-50 rounded p-3 text-sm text-rose-700">
        <div className="inline-flex items-center gap-1.5 mb-1">
          <AlertCircle size={12} /> Plan failed at step {plan.currentStep}
        </div>
        <div className="text-xs">{plan.lastError ?? 'no error message recorded'}</div>
      </div>
    )
  }
  if (plan.status === 'LABELS_READY') {
    return (
      <div className="border border-emerald-200 bg-emerald-50 rounded p-3 text-sm text-emerald-700">
        Plan complete. Labels: {Object.keys(plan.labels ?? {}).length} shipment(s).
      </div>
    )
  }

  // Per-step action button. The "list" steps fetch options + show a
  // picker; the "confirm" steps are auto-fired here for v1 (operator
  // would normally see the option list and pick one). For v1 simplicity
  // we surface the inspect-and-pick flow as a single "Run next step"
  // button that invokes the appropriate route.
  const nextLabel =
    plan.currentStep === 'LIST_PACKING' ? 'Inspect packing options' :
    plan.currentStep === 'CONFIRM_PACKING' ? 'Pick packing option' :
    plan.currentStep === 'LIST_PLACEMENT' ? 'Inspect placement options' :
    plan.currentStep === 'CONFIRM_PLACEMENT' ? 'Pick placement option' :
    plan.currentStep === 'LIST_TRANSPORT' ? 'Inspect transport options' :
    plan.currentStep === 'CONFIRM_TRANSPORT' ? 'Confirm transport' :
    plan.currentStep === 'GET_LABELS' ? 'Fetch labels' : 'Continue'

  const handleNext = async () => {
    if (plan.currentStep === 'LIST_PACKING') {
      const r = await callApi(`/api/fba/inbound/v2/${plan.id}/packing-options`)
      // For v1, auto-select the first option and show in toast.
      const first = r?.packingOptions?.[0]?.packingOptionId
      if (first) {
        toast.success(`Packing options listed (${r.packingOptions.length}); first: ${first}. Click "Pick" to confirm.`)
      }
    } else if (plan.currentStep === 'CONFIRM_PACKING') {
      const optId = prompt('packingOptionId to confirm?', '')
      if (!optId) return
      await callApi(`/api/fba/inbound/v2/${plan.id}/packing-options/${optId}/confirm`, { method: 'POST' })
      toast.success('Packing confirmed')
    } else if (plan.currentStep === 'LIST_PLACEMENT') {
      const r = await callApi(`/api/fba/inbound/v2/${plan.id}/placement-options`)
      toast.success(`Placement options: ${r?.placementOptions?.length ?? 0}`)
    } else if (plan.currentStep === 'CONFIRM_PLACEMENT') {
      const optId = prompt('placementOptionId to confirm?', '')
      if (!optId) return
      await callApi(`/api/fba/inbound/v2/${plan.id}/placement-options/${optId}/confirm`, { method: 'POST' })
      toast.success('Placement confirmed; shipmentIds emitted')
    } else if (plan.currentStep === 'LIST_TRANSPORT') {
      const shipmentId = plan.shipmentIds[0]
      if (!shipmentId) {
        toast.error('No shipmentIds yet')
        return
      }
      const r = await callApi(`/api/fba/inbound/v2/${plan.id}/shipments/${shipmentId}/transport-options`)
      toast.success(`Transport options: ${r?.transportationOptions?.length ?? 0}`)
    } else if (plan.currentStep === 'CONFIRM_TRANSPORT') {
      const shipmentId = plan.shipmentIds[0]
      const transportationOptionId = prompt('transportationOptionId to confirm?', '')
      if (!transportationOptionId || !shipmentId) return
      await callApi(`/api/fba/inbound/v2/${plan.id}/transport-options/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          selections: [{ shipmentId, transportationOptionId }],
        }),
      })
      toast.success('Transport confirmed')
    } else if (plan.currentStep === 'GET_LABELS') {
      const r = await callApi(`/api/fba/inbound/v2/${plan.id}/labels`)
      toast.success(`Labels fetched for ${Object.keys(r?.labels ?? {}).length} shipment(s)`)
    }
  }

  return (
    <button
      onClick={handleNext}
      disabled={busy}
      className="h-9 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
    >
      {busy && <Loader2 size={12} className="animate-spin" />}
      {nextLabel}
    </button>
  )
}

function EmptyText({ text }: { text: string }) {
  return <div className="text-sm text-slate-500 py-3">{text}</div>
}
