/**
 * AU.7 — Advertising Automation Command Center.
 * The 24/7 account manager — things Amazon's console can't do.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { Bot, Zap, TrendingDown, ShieldCheck, Target, Clock, DollarSign, Plus } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationActionsClient } from './AutomationActionsClient'
import { RuleCardClient } from './RuleCardClient'

export const metadata: Metadata = { title: 'Amazon Ads · Automation' }
export const dynamic = 'force-dynamic'

interface AutomationRule {
  id: string; name: string; description: string | null; trigger: string
  enabled: boolean; dryRun: boolean; scopeMarketplace: string | null
  maxExecutionsPerDay: number | null; maxDailyAdSpendCentsEur: number | null
  evaluationCount: number; matchCount: number; executionCount: number
  lastExecutedAt: string | null
}
interface Impact {
  windowDays: number; liveRuns: number; dryRuns: number
  termsNegated: number; termsGraduated: number; campaignsPaused: number
  campaignsGuarded: number; bidsAdjusted: number; budgetChanges: number
}

async function fetchRules(): Promise<AutomationRule[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
    if (!res.ok) return []
    return ((await res.json()) as { items: AutomationRule[] }).items
  } catch { return [] }
}
async function fetchImpact(): Promise<Impact | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/advertising/automation-impact?windowDays=7`, { cache: 'no-store' })
    return res.ok ? (await res.json()) as Impact : null
  } catch { return null }
}

const TRIGGER_LABEL: Record<string, string> = {
  SCHEDULE: '⏱ Scheduled',
  FBA_AGE_THRESHOLD_REACHED: 'FBA Aged Stock',
  AD_SPEND_PROFITABILITY_BREACH: 'Spend > Profit',
  CAC_SPIKE: 'ACOS Spike',
  AD_TARGET_UNDERPERFORMING: 'Underperforming',
  CAMPAIGN_PERFORMANCE_BUDGET: 'Budget',
}

export default async function AutomationPage() {
  const [rules, impact] = await Promise.all([fetchRules(), fetchImpact()])
  const live = rules.filter((r) => r.enabled && !r.dryRun).length
  const dryRun = rules.filter((r) => r.enabled && r.dryRun).length
  const disabled = rules.filter((r) => !r.enabled).length
  const scheduleRules = rules.filter((r) => r.trigger === 'SCHEDULE')
  const eventRules = rules.filter((r) => r.trigger !== 'SCHEDULE')

  return (
    <div className="px-4 py-4 max-w-[1100px]">
      <AdvertisingNav />

      {/* Header */}
      <div className="flex items-center justify-between mb-4 mt-1">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-blue-500" />
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Automation</h1>
          <span className="text-xs text-slate-400 hidden sm:inline">— things Amazon&apos;s console can&apos;t do</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/marketing/advertising/automation/new" className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="h-3.5 w-3.5" /> New rule
          </Link>
          <Link href="/marketing/advertising/automation/library" className="px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300">Library</Link>
          <Link href="/marketing/advertising/automation/executions" className="px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300">History</Link>
        </div>
      </div>

      {/* Impact strip */}
      {impact && (impact.liveRuns + impact.dryRuns) > 0 && (
        <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">Last 7 days — automation impact</span>
            <span className="text-[11px] text-slate-400">{impact.liveRuns} live · {impact.dryRuns} dry-run</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-slate-100 dark:divide-slate-800">
            {[
              { icon: <TrendingDown className="h-3.5 w-3.5 text-rose-500" />, val: impact.termsNegated, label: 'Negated' },
              { icon: <Target className="h-3.5 w-3.5 text-emerald-500" />, val: impact.termsGraduated, label: 'Graduated' },
              { icon: <ShieldCheck className="h-3.5 w-3.5 text-blue-500" />, val: impact.campaignsGuarded, label: 'Guarded' },
              { icon: <Bot className="h-3.5 w-3.5 text-violet-500" />, val: impact.bidsAdjusted, label: 'Bids tuned' },
              { icon: <DollarSign className="h-3.5 w-3.5 text-amber-500" />, val: impact.budgetChanges, label: 'Budgets' },
              { icon: <Clock className="h-3.5 w-3.5 text-slate-400" />, val: impact.campaignsPaused, label: 'Paused' },
            ].map((m) => (
              <div key={m.label} className="px-2 py-2.5 text-center">
                <div className="flex items-center justify-center gap-1 mb-0.5">{m.icon}<span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">{m.val}</span></div>
                <div className="text-[10px] text-slate-500 leading-tight">{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status + actions */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="flex items-center gap-1.5 text-sm"><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />{live} live</span>
        <span className="flex items-center gap-1.5 text-sm"><span className="h-2 w-2 rounded-full bg-amber-400 inline-block" />{dryRun} dry-run</span>
        <span className="flex items-center gap-1.5 text-sm text-slate-400"><span className="h-2 w-2 rounded-full bg-slate-300 inline-block" />{disabled} off</span>
        <div className="ml-auto"><AutomationActionsClient hasRules={rules.length > 0} /></div>
      </div>

      {/* Quick-start playbooks (shown when nothing is live yet) */}
      {live === 0 && rules.length > 0 && (
        <div className="mb-5">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Quick-start playbooks</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { icon: <ShieldCheck className="h-4 w-4 text-blue-500" />, label: 'Safety Net', blurb: 'Retail guard + budget cap. Stop wasting money on OOS products and cap monthly spend.', names: ['🛡 Retail guard', '⛔ Monthly budget cap'] },
              { icon: <Zap className="h-4 w-4 text-violet-500" />, label: 'Launch Mode', blurb: 'Retail guard + keyword harvest. Protect spend while your listing collects conversion data.', names: ['🛡 Retail guard', '🌾 Auto harvest & negate'] },
              { icon: <Target className="h-4 w-4 text-emerald-500" />, label: 'Full Autopilot', blurb: 'Bid optimization + harvest + retail guard. The complete 24/7 account manager.', names: ['🎯 Bid optimization (profit-native)', '🌾 Auto harvest & negate', '🛡 Retail guard'] },
            ].map((p) => (
              <div key={p.label} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
                <div className="flex items-center gap-2 mb-1">{p.icon}<span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{p.label}</span></div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{p.blurb}</p>
                <div className="text-[10px] text-slate-400 mb-2.5 space-y-0.5">{p.names.map((n) => <div key={n}>• {n}</div>)}</div>
                <Link href="/marketing/advertising/automation/library" className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700">Enable in library →</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scheduled automations */}
      {scheduleRules.length > 0 && (
        <section className="mb-4">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500 inline-block" />
            Scheduled — run on a timer
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
            {scheduleRules.map((r) => <RuleCardClient key={r.id} rule={r} triggerLabel={TRIGGER_LABEL[r.trigger] ?? r.trigger} />)}
          </div>
        </section>
      )}

      {/* Event-triggered rules */}
      {eventRules.length > 0 && (
        <section className="mb-4">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 inline-block" />
            Event-triggered — fire on conditions
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
            {eventRules.map((r) => <RuleCardClient key={r.id} rule={r} triggerLabel={TRIGGER_LABEL[r.trigger] ?? r.trigger} />)}
          </div>
        </section>
      )}

      {rules.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-12 text-center">
          <Bot className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
          <div className="text-sm font-medium text-slate-500">No automation rules yet</div>
          <div className="text-xs text-slate-400 mt-1 mb-4">Click <strong>Load templates</strong> to seed 10 starter rules (all dry-run by default — nothing writes until you enable it).</div>
          <AutomationActionsClient hasRules={false} />
        </div>
      )}

      <div className="mt-4 rounded-md bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
        All rules start <strong>dry-run</strong> — they propose changes but don&apos;t write to Amazon. Toggle dry-run off per-rule to go live. Global kill-switch: set <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">NEXUS_ADS_AUTOMATION_KILL=1</code> to halt everything instantly.
      </div>
    </div>
  )
}
