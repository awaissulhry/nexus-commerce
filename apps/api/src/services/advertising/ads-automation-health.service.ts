/**
 * AX3.13 — Automation Health.
 *
 * A health view over the advertising AutomationRule fleet: how many rules can
 * actually write vs are held back, recent execution volume + success rate, estimated
 * operator time saved, and the risks worth acting on (rules that never
 * graduated, recent failures, disabled rules). Read-only over AutomationRule
 * + AutomationRuleExecution (domain='advertising').
 */

import prisma from '../../db.js'
import { resolveAutonomy, levelActs } from './ads-autonomy.js'

const MINUTES_SAVED_PER_EXECUTION = 5 // heuristic: each automated action ≈ 5 manual minutes

export interface AutomationHealthResult {
  rules: { total: number; live: number; dryRun: number; disabled: number }
  executions30d: { total: number; success: number; partial: number; failed: number; dryRun: number; noMatch: number }
  matches30d: number
  successRatePct: number | null
  estTimeSavedHours: number
  risks: { stuckInDryRun: number; disabled: number; recentFailures: number; noManaging: boolean }
  recent: Array<{ id: string; ruleName: string; status: string; startedAt: string; error: string | null }>
}

export async function analyzeAutomationHealth(): Promise<AutomationHealthResult> {
  const since30 = new Date(Date.now() - 30 * 86_400_000)
  const since7 = new Date(Date.now() - 7 * 86_400_000)
  const [rules, execs, recentRows] = await Promise.all([
    prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { enabled: true, dryRun: true, autonomyLevel: true } }),
    prisma.automationRuleExecution.findMany({ where: { rule: { domain: 'advertising' }, startedAt: { gte: since30 } }, select: { status: true, startedAt: true } }),
    prisma.automationRuleExecution.findMany({ where: { rule: { domain: 'advertising' } }, orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, status: true, startedAt: true, errorMessage: true, rule: { select: { name: true } } } }),
  ])

  /**
   * ACR.6 — classify by what the ENGINE resolves, not by the `dryRun` column.
   *
   * `resolveAutonomy` reads `autonomyLevel` first and only falls back to the `dryRun` binary when
   * that column is null or 'OFF'. All 51 advertising rules on prod carry an explicit level, so
   * `dryRun` binds on none of them — it is a display field that looks like a control.
   *
   * The two agree TODAY (9 AUTO / 13 PROPOSE / 29 OFF, identical to what this function returned
   * before), so this changes no number now. It removes the way they come apart: any writer that
   * sets one column and not the other desynchronises this page silently. That is not hypothetical
   * — setting `dryRun=true` on a rule that stayed AUTO is exactly what happened here on
   * 2026-08-05, and for as long as it lasted this page would have called that rule "dry-run"
   * while the engine still let it write.
   *
   * It also fixes a latent one: an **OBSERVE** rule is `enabled` with `dryRun=false`, so the old
   * expression counted it as live and as managing the account. OBSERVE cannot write. There are
   * none today, and there will be the first time anyone uses that notch on the Control Room dial.
   *
   * `live` therefore means "can actually write" and the non-writing enabled rules (PROPOSE +
   * OBSERVE) fall into `dryRun`, whose name is kept only because the API shape is consumed by
   * Alerts & Health.
   */
  const levels = rules.map((r) => resolveAutonomy(r))
  const live = levels.filter((l) => levelActs(l)).length
  const disabled = levels.filter((l) => l === 'OFF').length
  const dryRun = levels.length - live - disabled

  const byStatus = (s: string) => execs.filter((e) => e.status === s).length
  const success = byStatus('SUCCESS'), partial = byStatus('PARTIAL'), failed = byStatus('FAILED')
  const dryRunExec = byStatus('DRY_RUN'), noMatch = byStatus('NO_MATCH')
  const acted = success + partial + dryRunExec // executions that produced/queued an action
  const decisive = success + partial + failed
  const recentFailures = execs.filter((e) => (e.status === 'FAILED' || e.status === 'PARTIAL') && e.startedAt >= since7).length

  return {
    rules: { total: rules.length, live, dryRun, disabled },
    executions30d: { total: execs.length, success, partial, failed, dryRun: dryRunExec, noMatch },
    matches30d: acted,
    successRatePct: decisive > 0 ? Math.round(((success + partial) / decisive) * 100) : null,
    estTimeSavedHours: Math.round((acted * MINUTES_SAVED_PER_EXECUTION / 60) * 10) / 10,
    risks: { stuckInDryRun: dryRun, disabled, recentFailures, noManaging: live === 0 },
    recent: recentRows.map((r) => ({ id: r.id, ruleName: r.rule?.name ?? '—', status: r.status, startedAt: r.startedAt.toISOString(), error: r.errorMessage })),
  }
}
