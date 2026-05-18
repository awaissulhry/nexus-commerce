'use client'

/**
 * Phase 9 — Dry-run graduation gate for a single automation rule.
 *
 * Fetches gate-status on mount, renders an 8-check checklist, and
 * provides a "Graduate to Live" button that calls the graduate endpoint.
 * All gate logic is re-validated server-side; this component only
 * presents the result and triggers the action.
 */

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2, ShieldAlert, Zap,
} from 'lucide-react'

interface GateCheck {
  id: string
  label: string
  detail: string
  passed: boolean
}

interface GateStatus {
  gateOpen: boolean
  daysInDryRun: number
  observationDaysRequired: number
  checks: GateCheck[]
}

export function GateStatusClient({ ruleId, backendUrl }: { ruleId: string; backendUrl: string }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [status, setStatus] = useState<GateStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [graduating, setGraduating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function loadGateStatus() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${backendUrl}/api/advertising/automation-rules/${ruleId}/gate-status`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadGateStatus() }, [ruleId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGraduate() {
    if (!confirm(
      'Graduate this rule to LIVE mode?\n\nThis means the automation will submit real bid changes to Amazon Ads. You can re-enable dry-run by toggling "Dry-run" on in the rule settings.\n\nProceed?'
    )) return

    setGraduating(true)
    setError(null)
    try {
      const res = await fetch(
        `${backendUrl}/api/advertising/automation-rules/${ruleId}/graduate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      )
      const data = await res.json()
      if (!res.ok) {
        const failures = (data.failures as string[] | undefined)?.join(', ') ?? data.error
        setError(`Gate check failed: ${failures}`)
        return
      }
      setSuccess(true)
      startTransition(() => router.refresh())
    } catch (e) {
      setError(String(e))
    } finally {
      setGraduating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking gate status…
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400 py-2">
        Failed to load gate status: {error}
      </div>
    )
  }

  if (!status) return null

  if (success) {
    return (
      <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 p-4 flex items-start gap-3">
        <Zap className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            Rule graduated to live!
          </p>
          <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">
            The next cron tick will execute real Amazon Ads bid changes. Monitor the execution
            history closely for the first 48 hours.
          </p>
        </div>
      </div>
    )
  }

  const passed = status.checks.filter((c) => c.passed).length
  const total  = status.checks.length
  const pct    = Math.round((passed / total) * 100)

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <ShieldAlert
          className={`h-5 w-5 shrink-0 mt-0.5 ${status.gateOpen ? 'text-emerald-500' : 'text-amber-500'}`}
          aria-hidden
        />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Live-write graduation gate
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {status.gateOpen
              ? 'All checks passed — this rule is ready to graduate to live bid execution.'
              : `${passed} of ${total} checks passed. Resolve the remaining items before graduating.`}
          </p>
        </div>
        <span className="text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
          {pct}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${status.gateOpen ? 'bg-emerald-500' : 'bg-amber-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Checklist */}
      <ul className="space-y-2">
        {status.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2.5">
            {check.passed
              ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden />
              : <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" aria-hidden />
            }
            <div className="min-w-0">
              <p className={`text-xs font-medium ${check.passed ? 'text-slate-700 dark:text-slate-200' : 'text-slate-600 dark:text-slate-400'}`}>
                {check.label}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                {check.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {/* Warning banner */}
      {status.gateOpen && (
        <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
          <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
            <strong>Graduating is reversible</strong> — open the rule and toggle Dry-run
            on to re-enter observation mode. But the first few live executions will touch
            real Amazon bids immediately. Monitor the execution history.
          </p>
        </div>
      )}

      {/* Error feedback */}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1.5">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleGraduate}
          disabled={!status.gateOpen || graduating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"
        >
          {graduating
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Graduating…</>
            : <><Zap className="h-3.5 w-3.5" /> Graduate to Live</>
          }
        </button>
        <button
          onClick={loadGateStatus}
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
