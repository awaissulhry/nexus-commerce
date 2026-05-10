'use client'

/**
 * AI-4.8 — operator-facing UI for the bulk orchestrator. Single
 * button + state-machine modal that exposes /ai-complete-all/estimate
 * and /ai-complete-all to the operator. v1 ships estimate → confirm
 * → run → result; auto-applying the AI output to wizardState is
 * deferred to AI-4.9 (diff-view review checkpoint) so the operator
 * can audit the AI output before any state mutation.
 *
 * State machine:
 *   idle        — button rendered, modal closed
 *   estimating  — modal open, /estimate POST in flight
 *   ready       — modal showing estimate + budget posture; Confirm
 *                 enabled unless wouldRefuse=true
 *   running     — modal showing spinner; /ai-complete-all in flight
 *   result      — modal showing per-step report + cost + redactions
 *   error       — modal showing error; Close button only
 *
 * Cost-safety: every backend call inherits AI-1.2 kill switch +
 * AI-1.3 budget gate. The kill-switch banner here is a UX shortcut
 * — the request would still 503 / 402 if the user clicked through.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface BudgetSnapshot {
  limits: {
    perCallUSD: number
    perWizardUSD: number
    perDayUSD: number
    perMonthUSD: number
  }
  current: { perDay: number; perMonth: number; perWizard: number }
  projected: { perDay: number; perMonth: number; perWizard: number }
  wouldRefuse: boolean
}

interface EstimateResponse {
  steps: Array<{
    stepId: number
    action: string
    wired: boolean
    estimatedCostUSD: number
    estimatedAiCalls: number
  }>
  totals: { estimatedCostUSD: number; estimatedAiCalls: number }
  budget: BudgetSnapshot
}

// AI-4.9 — per-group AI content the orchestrator returns inside
// the Step 5 entry's details.groups[]. Frontend reads this to drive
// the Apply button + preview.
interface OrchestratorGroupResult {
  groupKey: string
  platform: string
  language: string
  marketplaces: string[]
  channelKeys: string[]
  ok: boolean
  costUSD?: number
  aiCalls?: number
  redactionTotal?: number
  error?: string
  content?: {
    title?: string
    bullets?: string
    description?: string
    keywords?: string
  }
}

interface RunStepEntry {
  stepId: number
  action: string
  status: 'success' | 'partial' | 'skipped' | 'failed'
  durationMs: number
  aiCalls: number
  costUSD: number
  redactionTotal: number
  details?: { groups?: OrchestratorGroupResult[] }
  error?: string
}

interface RunResponse {
  steps: RunStepEntry[]
  totals: {
    aiCalls: number
    costUSD: number
    redactionTotal: number
    durationMs: number
  }
  budgetWarn?: 'per_wizard' | 'per_day' | 'per_month'
}

type Phase =
  | 'idle'
  | 'estimating'
  | 'ready'
  | 'running'
  | 'result'
  | 'applying'
  | 'applied'
  | 'error'

const fmtUSD = (n: number): string =>
  n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`

interface Props {
  wizardId: string
  /** Whether the wizard has any channels picked. AI orchestrator
   *  refuses with 409 when channels=[], so we disable the button up
   *  front rather than letting the user discover that mid-flow. */
  channelsPicked: boolean
}

export default function AiCompleteWizardButton({
  wizardId,
  channelsPicked,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null)
  const [killSwitch, setKillSwitch] = useState(false)
  const [result, setResult] = useState<RunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setPhase('idle')
    setEstimate(null)
    setResult(null)
    setError(null)
  }, [])

  // Pull the estimate as soon as the modal opens so the operator
  // sees the number without an extra click. Kill-switch is read
  // off /ai/providers in the same fetch burst.
  useEffect(() => {
    if (!open) return
    if (phase !== 'idle' && phase !== 'estimating') return
    let cancelled = false
    setPhase('estimating')
    setError(null)
    const backend = getBackendUrl()
    Promise.all([
      fetch(`${backend}/api/ai/providers`, { cache: 'no-store' }),
      fetch(
        `${backend}/api/listing-wizard/${wizardId}/ai-complete-all/estimate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      ),
    ])
      .then(async ([provRes, estRes]) => {
        if (cancelled) return
        const provJson = provRes.ok ? await provRes.json() : null
        if (provJson?.killSwitch === true) {
          setKillSwitch(true)
        }
        if (!estRes.ok) {
          const errBody = await estRes.json().catch(() => ({}))
          throw new Error(errBody.error ?? `HTTP ${estRes.status}`)
        }
        const json = (await estRes.json()) as EstimateResponse
        setEstimate(json)
        setPhase('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [open, phase, wizardId])

  const onClose = useCallback(() => {
    // AI-4.8/4.9 — block close during the heavy phases. running =
    // orchestrator firing AI; applying = PATCHing wizard state.
    // applied = reload pending, ignore close.
    if (phase === 'running' || phase === 'applying' || phase === 'applied') return
    setOpen(false)
    // Defer reset until after Modal animates out.
    window.setTimeout(reset, 250)
  }, [phase, reset])

  // PR.2 — soft helper to navigate-then-reload to Step 5. Used by
  // both the "no patch needed" and the post-PATCH branches below
  // so the operator always lands on the step where AI just filled
  // content. Builds the URL preserving any other existing
  // searchParams (e.g. ?channel= legacy deep-links from /products/
  // [id]/edit) instead of clobbering them.
  const navigateToStep5 = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('step', '5')
    window.location.href = url.toString()
  }, [])

  // AI-4.9 — apply all AI content to the wizard. Walks the
  // orchestrator's per-group results, builds a channelStates patch
  // (one entry per channelKey, attributes filled from the group's
  // AI content), PATCHes /listing-wizard/:id, and reloads the page
  // so ListWizardClient picks up the new initialWizard. Reload is
  // brutal but reliable; soft-refresh via cross-tab event lands in
  // a follow-up.
  const onApplyAll = useCallback(async () => {
    if (!result) return
    setPhase('applying')
    setError(null)
    try {
      // Per-channel attributes patch built from every successful
      // group's content. Field name mapping mirrors what the wizard
      // stores in channelStates[ck].attributes today (see Step 4
      // Attributes overrides).
      const channelStatesPatch: Record<
        string,
        { attributes: Record<string, string> }
      > = {}
      for (const step of result.steps) {
        if (step.stepId !== 5) continue
        const groups = step.details?.groups ?? []
        for (const g of groups) {
          if (!g.ok || !g.content) continue
          const attrs: Record<string, string> = {}
          if (g.content.title) attrs.item_name = g.content.title
          if (g.content.bullets) attrs.bullet_point = g.content.bullets
          if (g.content.description)
            attrs.product_description = g.content.description
          if (g.content.keywords) attrs.generic_keyword = g.content.keywords
          if (Object.keys(attrs).length === 0) continue
          for (const channelKey of g.channelKeys) {
            // Merge with anything already accumulated for this
            // channelKey from a sibling group (shouldn't happen
            // since groups dedupe by language:platform but be safe).
            const existing = channelStatesPatch[channelKey]?.attributes ?? {}
            channelStatesPatch[channelKey] = {
              attributes: { ...existing, ...attrs },
            }
          }
        }
      }
      if (Object.keys(channelStatesPatch).length === 0) {
        // Nothing to apply (every group failed or no content).
        // Surface as applied=true so the operator can dismiss; the
        // result-view already shows the failed status.
        setPhase('applied')
        window.setTimeout(() => navigateToStep5(), 800)
        return
      }
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelStates: channelStatesPatch }),
        },
      )
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error ?? `HTTP ${res.status}`)
      }
      setPhase('applied')
      toast({
        tone: 'success',
        title: t('listWizard.aiComplete.applied'),
        durationMs: 4000,
      })
      // PR.2 — reload via location with ?step=5 so the operator
      // lands ON Step 5 (Attributes) where the AI just filled the
      // fields, ready to review/tweak. Without the deep-link the
      // reload would put them back wherever currentStep was before
      // the bulk run — usually pre-Step-5 since the bulk button
      // sits in the WizardHeader. Reload (vs router.push) is still
      // load-bearing here: ListWizardClient's local state derives
      // from initialWizard at first paint, so a soft navigation
      // wouldn't pick up the freshly-patched channelStates.
      window.setTimeout(() => navigateToStep5(), 600)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
      toast({
        tone: 'error',
        title: t('listWizard.aiComplete.applyError'),
        description: err instanceof Error ? err.message : String(err),
        durationMs: 8000,
      })
    }
  }, [result, wizardId, t, toast])

  const onConfirm = useCallback(async () => {
    if (phase !== 'ready' || !estimate) return
    setPhase('running')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/ai-complete-all`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        // 402 budget refusals carry a structured budget block; show
        // the specific reason so the operator knows whether to wait
        // or ask an admin to bump caps.
        if (res.status === 402 && json?.budget?.reason) {
          throw new Error(
            t('listWizard.aiComplete.budgetRefused', {
              reason: json.budget.reason,
            }),
          )
        }
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      const ok = json as RunResponse
      setResult(ok)
      setPhase('result')
      toast({
        tone:
          ok.steps.every((s) => s.status === 'success' || s.status === 'skipped')
            ? 'success'
            : 'warning',
        title: t('listWizard.aiComplete.toastSuccess', {
          cost: fmtUSD(ok.totals.costUSD),
          calls: ok.totals.aiCalls,
        }),
        description: t('listWizard.aiComplete.toastReviewHint'),
        durationMs: 8000,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
      toast({
        tone: 'error',
        title: t('listWizard.aiComplete.toastFailed'),
        description: err instanceof Error ? err.message : String(err),
        durationMs: 8000,
      })
    }
  }, [phase, estimate, wizardId, t, toast])

  // Disable the trigger when no channels picked yet — orchestrator
  // 409s and the modal would only show an error anyway.
  const buttonDisabled = !channelsPicked
  const buttonTitle = buttonDisabled
    ? t('listWizard.client.needsChannelsTitle')
    : t('listWizard.aiComplete.button')

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={buttonDisabled}
        title={buttonTitle}
        className="inline-flex items-center gap-1.5"
      >
        <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
        <span className="hidden md:inline">
          {t('listWizard.aiComplete.button')}
        </span>
        <span className="md:hidden">
          {t('listWizard.aiComplete.buttonShort')}
        </span>
      </Button>

      <Modal
        open={open}
        onClose={onClose}
        title={t('listWizard.aiComplete.modalTitle')}
        description={t('listWizard.aiComplete.modalDesc')}
        size="lg"
        // Block dismiss-on-backdrop while the orchestrator is in
        // flight so an accidental click can't strand a running call.
        dismissOnBackdrop={phase !== 'running'}
        dismissOnEscape={phase !== 'running'}
      >
        <ModalBody>
          {killSwitch && (
            <div
              role="alert"
              className="border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 mb-3 inline-flex items-start gap-2 text-base text-rose-900 dark:text-rose-100"
            >
              <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
              <span>{t('listWizard.aiComplete.killSwitch')}</span>
            </div>
          )}

          {phase === 'estimating' && (
            <div className="flex items-center gap-2 text-base text-slate-600 dark:text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('listWizard.aiComplete.estimating')}
            </div>
          )}

          {phase === 'ready' && estimate && (
            <EstimateView estimate={estimate} t={t} />
          )}

          {phase === 'running' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-md font-medium text-slate-900 dark:text-slate-100">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" />
                {t('listWizard.aiComplete.running')}
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('listWizard.aiComplete.runningHint', {
                  calls: estimate?.totals.estimatedAiCalls ?? '?',
                })}
              </p>
            </div>
          )}

          {phase === 'result' && result && <ResultView result={result} t={t} />}

          {phase === 'applying' && (
            <div className="flex items-center gap-2 text-base text-slate-700 dark:text-slate-300">
              <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" />
              {t('listWizard.aiComplete.applying')}
            </div>
          )}

          {phase === 'applied' && (
            <div className="flex items-center gap-2 text-base text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4" />
              {t('listWizard.aiComplete.applied')}
            </div>
          )}

          {phase === 'error' && (
            <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 inline-flex items-start gap-2 text-base text-rose-800 dark:text-rose-200">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">
                  {t('listWizard.aiComplete.runError')}
                </div>
                {error && (
                  <div className="text-sm mt-0.5 opacity-90">{error}</div>
                )}
              </div>
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={
              phase === 'running' ||
              phase === 'applying' ||
              phase === 'applied'
            }
          >
            {phase === 'result' || phase === 'error'
              ? t('listWizard.aiComplete.close')
              : t('listWizard.aiComplete.cancel')}
          </Button>
          {phase === 'ready' && estimate && (
            <Button
              variant="primary"
              size="sm"
              onClick={onConfirm}
              disabled={estimate.budget.wouldRefuse || killSwitch}
              title={
                estimate.budget.wouldRefuse
                  ? t('listWizard.aiComplete.wouldRefuse')
                  : undefined
              }
            >
              <Sparkles className="w-3 h-3" />
              {t('listWizard.aiComplete.confirmButton', {
                cost: fmtUSD(estimate.totals.estimatedCostUSD),
              })}
            </Button>
          )}
          {/* AI-4.9 — Apply only enabled when the orchestrator
              actually produced content for at least one group. The
              button is hidden in error / running / applying / applied
              phases since it'd either be a no-op or unsafe. */}
          {phase === 'result' && hasApplicableContent(result) && (
            <Button variant="primary" size="sm" onClick={onApplyAll}>
              <Sparkles className="w-3 h-3" />
              {t('listWizard.aiComplete.applyAll')}
            </Button>
          )}
        </ModalFooter>
      </Modal>
    </>
  )
}

function hasApplicableContent(result: RunResponse | null): boolean {
  if (!result) return false
  for (const step of result.steps) {
    if (step.stepId !== 5) continue
    const groups = step.details?.groups ?? []
    for (const g of groups) {
      if (g.ok && g.content && Object.values(g.content).some((v) => v)) {
        return true
      }
    }
  }
  return false
}

function EstimateView({
  estimate,
  t,
}: {
  estimate: EstimateResponse
  t: ReturnType<typeof useTranslations>['t']
}) {
  const limits = estimate.budget.limits
  const day = estimate.budget.projected.perDay
  const dayLimit = limits.perDayUSD
  const dayPct =
    dayLimit > 0 ? Math.min(100, (day / dayLimit) * 100) : 0
  const wizard = estimate.budget.projected.perWizard
  const wizardLimit = limits.perWizardUSD
  const wizardPct =
    wizardLimit > 0 ? Math.min(100, (wizard / wizardLimit) * 100) : 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label={t('listWizard.aiComplete.estimateLabel')}
          value={fmtUSD(estimate.totals.estimatedCostUSD)}
          accent="primary"
        />
        <Stat
          label={t('listWizard.aiComplete.callsLabel')}
          value={String(estimate.totals.estimatedAiCalls)}
        />
      </div>

      {dayLimit > 0 && (
        <BudgetBar
          label={t('listWizard.aiComplete.budgetTodayLabel')}
          spent={day}
          limit={dayLimit}
          pct={dayPct}
        />
      )}
      {wizardLimit > 0 && (
        <BudgetBar
          label={t('listWizard.aiComplete.budgetWizardLabel')}
          spent={wizard}
          limit={wizardLimit}
          pct={wizardPct}
        />
      )}

      {estimate.budget.wouldRefuse && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 inline-flex items-start gap-2 text-base text-rose-800 dark:text-rose-200">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {t('listWizard.aiComplete.wouldRefuse')}
        </div>
      )}
    </div>
  )
}

function ResultView({
  result,
  t,
}: {
  result: RunResponse
  t: ReturnType<typeof useTranslations>['t']
}) {
  return (
    <div className="space-y-3">
      <div className="text-md text-slate-900 dark:text-slate-100">
        {t('listWizard.aiComplete.resultSummary', {
          calls: result.totals.aiCalls,
          cost: fmtUSD(result.totals.costUSD),
          redactions: result.totals.redactionTotal,
        })}
      </div>
      <ul className="space-y-1.5 text-base">
        {result.steps.map((s) => {
          const Icon =
            s.status === 'success'
              ? CheckCircle2
              : s.status === 'failed'
                ? XCircle
                : AlertCircle
          const tone =
            s.status === 'success'
              ? 'text-emerald-600 dark:text-emerald-400'
              : s.status === 'failed'
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-slate-400 dark:text-slate-500'
          return (
            <li
              key={s.stepId}
              className="flex items-start gap-2"
              title={s.error ?? undefined}
            >
              <Icon className={cn('w-4 h-4 flex-shrink-0 mt-0.5', tone)} />
              <span className="text-slate-700 dark:text-slate-300">
                {s.status === 'skipped'
                  ? t('listWizard.aiComplete.resultStepSkipped', {
                      n: s.stepId,
                    })
                  : t('listWizard.aiComplete.resultStepWired', {
                      n: s.stepId,
                      action: s.action,
                      status: s.status,
                    })}
                {s.aiCalls > 0 && (
                  <span className="ml-2 text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                    · {s.aiCalls} call{s.aiCalls === 1 ? '' : 's'} ·{' '}
                    {fmtUSD(s.costUSD)}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: 'primary'
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-md px-3 py-2 bg-white dark:bg-slate-900">
      <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
        {label}
      </div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums mt-0.5',
          accent === 'primary'
            ? 'text-blue-700 dark:text-blue-300'
            : 'text-slate-900 dark:text-slate-100',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function BudgetBar({
  label,
  spent,
  limit,
  pct,
}: {
  label: string
  spent: number
  limit: number
  pct: number
}) {
  const tone =
    pct >= 100
      ? 'bg-rose-500'
      : pct >= 90
        ? 'bg-amber-500'
        : 'bg-emerald-500'
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-slate-600 dark:text-slate-400">{label}</span>
        <span className="text-slate-700 dark:text-slate-300 tabular-nums">
          {fmtUSD(spent)} / {fmtUSD(limit)}
        </span>
      </div>
      <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
        <div
          className={cn('h-full transition-all', tone)}
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      </div>
    </div>
  )
}
