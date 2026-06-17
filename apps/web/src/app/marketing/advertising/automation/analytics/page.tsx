import type { Metadata } from 'next'
import Link from 'next/link'
import { BarChart3, ChevronLeft } from 'lucide-react'
import { AdvertisingNav } from '../../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Amazon Ads · Automation Analytics' }
export const dynamic = 'force-dynamic'

interface RuleAnalytics {
  name: string; runs: number; termsNegated: number; bidsAdjusted: number
  campaignsGuarded: number; lastRun: string
}
interface AnalyticsData { windowDays: number; totalRuns: number; rules: RuleAnalytics[] }

async function fetchAnalytics(days: number): Promise<AnalyticsData | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/advertising/automation-analytics?windowDays=${days}`, { cache: 'no-store' })
    return res.ok ? (await res.json()) as AnalyticsData : null
  } catch { return null }
}

export default async function AutomationAnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysParam } = await searchParams
  const days = Math.max(7, Math.min(90, Number(daysParam) || 30))
  const data = await fetchAnalytics(days)

  return (
    <div className="px-4 py-4 max-w-[900px]">
      <AdvertisingNav />
      <div className="flex items-center gap-2 mt-1 mb-3">
        <Link href="/marketing/advertising/automation" className="text-tertiary hover:text-slate-600 dark:hover:text-slate-200"><ChevronLeft className="h-4 w-4" /></Link>
        <BarChart3 className="h-5 w-5 text-blue-500" />
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Automation Analytics</h1>
        <div className="ml-auto flex gap-1.5">
          {[7, 14, 30, 60].map((d) => (
            <Link key={d} href={`?days=${d}`} className={`px-2.5 py-1 text-xs rounded-md border transition ${days === d ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-default dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
              {d}d
            </Link>
          ))}
        </div>
      </div>

      {!data ? (
        <div className="text-sm text-tertiary py-8 text-center">No data yet — enable automation rules to see impact here.</div>
      ) : data.totalRuns === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-10 text-center">
          <div className="text-sm font-medium text-slate-500">No live automation runs in the last {days} days.</div>
          <div className="text-xs text-tertiary mt-1">Enable rules and flip dry-run off to start building history.</div>
          <Link href="/marketing/advertising/automation" className="mt-3 inline-block px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">← Back to automation</Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Total runs', value: data.totalRuns, color: 'text-blue-600 dark:text-blue-400' },
              { label: 'Terms negated', value: data.rules.reduce((s, r) => s + r.termsNegated, 0), color: 'text-rose-600 dark:text-rose-400' },
              { label: 'Bids adjusted', value: data.rules.reduce((s, r) => s + r.bidsAdjusted, 0), color: 'text-violet-600 dark:text-violet-400' },
              { label: 'Campaigns guarded', value: data.rules.reduce((s, r) => s + r.campaignsGuarded, 0), color: 'text-emerald-600 dark:text-emerald-400' },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5">
                <div className="text-[10px] text-tertiary uppercase tracking-wider">{m.label}</div>
                <div className={`text-xl font-semibold tabular-nums ${m.color}`}>{m.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
            <div className="px-3 py-2 border-b border-subtle dark:border-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">Per-rule breakdown</div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 text-[11px]">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Rule</th>
                  <th className="text-right px-3 py-2 font-medium">Runs</th>
                  <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Negated</th>
                  <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Bids adj.</th>
                  <th className="text-right px-3 py-2 font-medium hidden md:table-cell">Guarded</th>
                  <th className="text-right px-3 py-2 font-medium">Last run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.rules.map((r) => (
                  <tr key={r.name} className="hover:bg-slate-50/60 dark:hover:bg-slate-900/30">
                    <td className="px-3 py-2 text-slate-800 dark:text-slate-100 max-w-[200px] truncate">{r.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-blue-600 dark:text-blue-400">{r.runs}</td>
                    <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell text-rose-600">{r.termsNegated || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell text-violet-600">{r.bidsAdjusted || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell text-emerald-600">{r.campaignsGuarded || '—'}</td>
                    <td className="px-3 py-2 text-right text-tertiary text-[10px]">{r.lastRun ? new Date(r.lastRun).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
