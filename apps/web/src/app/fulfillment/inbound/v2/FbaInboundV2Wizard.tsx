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
//
// F.6.1 (2026-05-21):
//   - NewPlanButton's prompt() + PLACEHOLDER body replaced by
//     NewPlanModal: real SKU autocomplete + multi-item + source
//     address inputs + destination marketplace dropdown.
//   - Selected plan id round-trips through ?plan=<id> URL state so
//     a refresh mid-flow resumes on the right plan.
//   - CREATE step now visible in the step tracker (was previously
//     skipped, making the wizard look like it started at "pick
//     packing").

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { NewPlanModal } from './NewPlanModal'
import { PackingOptionsPicker } from './PackingOptionsPicker'
import { PlacementOptionsPicker } from './PlacementOptionsPicker'
import { TransportOptionsPicker } from './TransportOptionsPicker'
import { LabelsPicker } from './LabelsPicker'

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

// F.6.1: CREATE shows as the very first step (was previously absent
// from the visible tracker, making the wizard look like it started
// mid-flow). A plan that's past CREATE is treated as having completed it.
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
  // F.6.1: URL deep-link. ?plan=<row id> survives refresh + lets
  // operators bookmark a specific in-progress plan.
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlPlanId = searchParams?.get('plan') ?? null
  const [selectedPlanId, setSelectedPlanIdState] = useState<string | null>(urlPlanId)
  const [showNewPlanModal, setShowNewPlanModal] = useState(false)

  const setSelectedPlanId = (id: string | null) => {
    setSelectedPlanIdState(id)
    // Push the plan id to the URL so a refresh / bookmark resumes here.
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    if (id) params.set('plan', id)
    else params.delete('plan')
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  // Sync state if URL changes externally (e.g. back/forward nav).
  useEffect(() => {
    if (urlPlanId !== selectedPlanId) setSelectedPlanIdState(urlPlanId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPlanId])

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

      <NewPlanModal
        open={showNewPlanModal}
        onClose={() => setShowNewPlanModal(false)}
        onCreated={(id) => {
          setSelectedPlanId(id)
          refetch()
        }}
      />

      {/* Plans list */}
      <Card>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              Plans · {data?.count ?? '—'}
            </div>
            <button
              onClick={() => setShowNewPlanModal(true)}
              className="h-7 px-3 text-xs bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1"
            >
              <Plus size={11} />
              New plan
            </button>
          </div>
          {loading && !data ? (
            <Skeleton variant="block" height={120} />
          ) : error ? (
            <div className="text-sm text-rose-700 dark:text-rose-300">Failed to load: {error}</div>
          ) : data && data.plans.length === 0 ? (
            <EmptyText text='No plans yet. Click "New plan" to start a v2024-03-20 inbound flow.' />
          ) : (
            <div className="space-y-1.5">
              {data?.plans.map((p) => {
                const isSelected = p.id === selectedPlanId
                const tone = p.status === 'FAILED' ? 'border-rose-300 bg-rose-50/50'
                  : p.status === 'LABELS_READY' ? 'border-emerald-300 bg-emerald-50/50'
                  : 'border-slate-200 dark:border-slate-700'
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedPlanId(p.id)}
                    className={`w-full text-left border rounded p-2.5 hover:border-blue-400 transition-colors ${tone} ${isSelected ? 'ring-2 ring-blue-400' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {p.status === 'LABELS_READY' && <CheckCircle2 size={12} className="text-emerald-700 dark:text-emerald-300" />}
                        {p.status === 'FAILED' && <XCircle size={12} className="text-rose-700 dark:text-rose-300" />}
                        {p.status !== 'LABELS_READY' && p.status !== 'FAILED' && <Loader2 size={12} className="text-slate-500 dark:text-slate-400" />}
                        <span className="text-sm font-medium">{p.name ?? '(unnamed)'}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">{p.planId ?? '(no planId)'}</span>
                      </div>
                      <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">{p.status}</span>
                    </div>
                    {p.lastError && (
                      <div className="text-xs text-rose-700 dark:text-rose-300 mt-1 line-clamp-2">⚠ {p.lastError}</div>
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
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
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

function StepTracker({ plan }: { plan: Plan }) {
  // F.6.1: CREATE is treated as complete once the plan exists in our
  // DB (anything past CREATE is necessarily past CREATE). Previously
  // CREATE was missing from the tracker entirely.
  const currentIdx = STEPS.findIndex((s) => s.key === plan.currentStep)
  const planExists = Boolean(plan.planId) // server-side row created
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {STEPS.map((step, i) => {
        // F.6.1: CREATE marks done as soon as planId is persisted (the
        // FbaInboundPlanV2 row exists with a real SP-API planId), even
        // when currentStep is still 'CREATE' due to retry semantics.
        const done =
          i < currentIdx ||
          plan.status === 'LABELS_READY' ||
          (step.key === 'CREATE' && planExists)
        const active = i === currentIdx && plan.status !== 'FAILED' && !(step.key === 'CREATE' && planExists)
        const failed = i === currentIdx && plan.status === 'FAILED'
        return (
          <div key={step.key} className="flex items-center gap-1">
            <span
              className={`text-xs px-2 py-0.5 rounded border ${
                done ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 text-emerald-700 dark:text-emerald-300'
                : failed ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 text-rose-700 dark:text-rose-300'
                : active ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              {done ? <CheckCircle2 size={10} className="inline mr-1" /> : null}
              {failed ? <XCircle size={10} className="inline mr-1" /> : null}
              {active ? <Loader2 size={10} className="inline mr-1 animate-spin" /> : null}
              {step.label}
            </span>
            {i < STEPS.length - 1 && <ChevronRight size={11} className="text-slate-300 dark:text-slate-600" />}
          </div>
        )
      })}
    </div>
  )
}

function PlanActions({ plan, onAction }: { plan: Plan; onAction: () => void }) {
  const { toast } = useToast()
  // F.6.5: callApi() helper removed — every step now renders its own
  // picker component that owns its loading state. `busy` survives for
  // the FAILED-state retry button (handleRetry below).
  const [busy, setBusy] = useState(false)

  if (plan.status === 'FAILED') {
    // F.6.4: retry-on-FAIL. The service is idempotent per-step so
    // re-running clears the failed marker; if the same error recurs,
    // operator sees it again immediately rather than being stuck.
    // currentStep is set to whatever step the SP-API call failed on,
    // so the right picker mounts after status flips back to non-FAILED.
    const handleRetry = async () => {
      setBusy(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fba/inbound/v2/${plan.id}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Clear FAILED status so the appropriate picker mounts and
        // retries its own load. We do this by writing a fresh status
        // via the existing per-step routes — but those need their
        // pre-failure status. Simpler: trigger the next-step route
        // directly based on currentStep.
        const stepToUrl: Record<string, { url: string; method: 'GET' | 'POST' } | null> = {
          LIST_PACKING: { url: `/api/fba/inbound/v2/${plan.id}/packing-options`, method: 'GET' },
          LIST_PLACEMENT: { url: `/api/fba/inbound/v2/${plan.id}/placement-options`, method: 'GET' },
          GET_LABELS: { url: `/api/fba/inbound/v2/${plan.id}/labels`, method: 'GET' },
        }
        const action = stepToUrl[plan.currentStep] ?? null
        if (!action) {
          toast.error(
            `No automatic retry for step ${plan.currentStep} — re-confirm the option manually.`,
          )
          onAction()
          return
        }
        const r = await fetch(`${getBackendUrl()}${action.url}`, {
          method: action.method,
          credentials: 'include',
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
        toast.success(`Retry of ${plan.currentStep} succeeded`)
        onAction()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded p-3 text-sm text-rose-700 dark:text-rose-300 space-y-2">
        <div className="inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> Plan failed at step {plan.currentStep}
        </div>
        <div className="text-xs font-mono">{plan.lastError ?? 'no error message recorded'}</div>
        <button
          onClick={handleRetry}
          disabled={busy}
          className="h-8 px-3 text-xs border border-rose-300 dark:border-rose-700 rounded hover:bg-rose-100/50 dark:hover:bg-rose-900/40 disabled:opacity-50 inline-flex items-center gap-1.5 text-rose-700 dark:text-rose-300"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : null}
          Retry {plan.currentStep}
        </button>
      </div>
    )
  }
  // F.6.5: LABELS_READY (plan complete). Re-render the labels picker
  // with the persisted labels JSON pre-loaded so the operator can
  // re-download or re-fetch with different format/page settings
  // without losing context. Amazon's label URLs expire after ~1-2h,
  // so re-fetch is the common path on a returning visit.
  if (plan.status === 'LABELS_READY') {
    return (
      <div className="space-y-3">
        <div className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 rounded p-2.5 text-sm text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1.5">
          <CheckCircle2 size={12} /> Plan complete — labels available for {plan.shipmentIds.length} shipment{plan.shipmentIds.length === 1 ? '' : 's'}
        </div>
        <LabelsPicker
          planRowId={plan.id}
          shipmentIds={plan.shipmentIds}
          cachedLabels={plan.labels}
          onAction={onAction}
        />
      </div>
    )
  }

  // F.6.2: packing-options step renders a real card picker (replaces
  // prompt() in v1). Mounting the picker auto-loads the SP-API
  // options, which advances the LIST_PACKING → CONFIRM_PACKING
  // transition for free.
  if (plan.currentStep === 'LIST_PACKING' || plan.currentStep === 'CONFIRM_PACKING') {
    return <PackingOptionsPicker planRowId={plan.id} onConfirmed={onAction} />
  }

  // F.6.3: placement-options step. Same auto-mount pattern as packing —
  // mounting triggers GET /placement-options which advances LIST →
  // CONFIRM state transition server-side.
  if (plan.currentStep === 'LIST_PLACEMENT' || plan.currentStep === 'CONFIRM_PLACEMENT') {
    return <PlacementOptionsPicker planRowId={plan.id} onConfirmed={onAction} />
  }

  // F.6.4: transport-options step. Picker loops over ALL shipmentIds
  // (not just [0] like v1 did), letting the operator pick one
  // transport option per shipment and submit them as a single
  // confirmation call. This is the most operationally critical step
  // — the reason for the v0 → v2 migration.
  if (plan.currentStep === 'LIST_TRANSPORT' || plan.currentStep === 'CONFIRM_TRANSPORT') {
    return (
      <TransportOptionsPicker
        planRowId={plan.id}
        shipmentIds={plan.shipmentIds}
        onConfirmed={onAction}
      />
    )
  }

  // F.6.5: GET_LABELS step. Replaces the legacy "Fetch labels" button
  // (which toasted but left nothing to click) with the LabelsPicker —
  // format + page-size selectors with PDF/A4 defaults, per-shipment
  // download list with expiration countdown.
  if (plan.currentStep === 'GET_LABELS') {
    return (
      <LabelsPicker
        planRowId={plan.id}
        shipmentIds={plan.shipmentIds}
        cachedLabels={plan.labels}
        onAction={onAction}
      />
    )
  }

  // Fallback — should be unreachable, but keep a graceful empty state
  // in case a new server-side state lands before the UI knows about it.
  return (
    <div className="text-xs text-slate-500 dark:text-slate-400">
      Unknown step: {plan.currentStep}
    </div>
  )
}

function EmptyText({ text }: { text: string }) {
  return <div className="text-sm text-slate-500 dark:text-slate-400 py-3">{text}</div>
}
