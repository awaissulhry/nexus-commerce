'use client'

/**
 * UM-series — campaign detail client. Header + KPIs, channel-specific
 * detail block, per-market links, targets, and the action audit trail.
 * Inline pause/resume + budget edit (sandbox-gated). Live via SSE.
 */

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Play, Pause, Check, Rocket } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

export interface CampaignDetail {
  id: string; name: string; channel: string; surface: string; objective: string; status: string
  marketplaces: string[]; primaryMarketplace: string | null; budgetScope: string
  budgetCents: number | null; budgetKind: string | null; currency: string
  spendCents: number; salesCents: number; acos: string | null; roas: string | null
  deliveryStatus: string | null; deliveryReasons: string[]; startDate: string; endDate: string | null
  links: Array<{ id: string; marketplace: string; externalId: string | null; status: string; currency: string; deliveryStatus: string | null }>
  targets: Array<{ id: string; kind: string; expressionType: string | null; expressionValue: string; bidCents: number | null; spendCents: number; salesCents: number; status: string }>
  amazonAds: { adProduct: string; profileId: string | null; portfolioId: string | null } | null
  ebayPromoted: { fundingStrategy: string; bidPercentage: string | null } | null
  discount: { discountType: string; discountPercent: string | null; appliesTo: string } | null
  externalAds: { platform: string; objectiveNative: string | null } | null
  contentPush: { contentType: string; targetRefs: string[] } | null
  outreach: { mode: string; segmentId: string | null } | null
}
export interface ActionsBundle {
  actions: Array<{ id: string; actionType: string; entityType: string; channelResponseStatus: string | null; rolledBackAt: string | null; createdAt: string; userId: string | null }>
  metrics: Array<{ date: string; impressions: number; clicks: number; costEurCents: string | null; sales7dCents: number | null; currencyCode: string }>
}

const eur = (c: number | null | undefined, cur = 'EUR') => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur }).format(c / 100))

export function CampaignDetailClient({ campaign, initialActions }: { campaign: CampaignDetail; initialActions: ActionsBundle }) {
  const [c, setC] = useState(campaign)
  const [actions, setActions] = useState(initialActions)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [budgetVal, setBudgetVal] = useState(c.budgetCents != null ? (c.budgetCents / 100).toFixed(2) : '0')

  const reload = useCallback(async () => {
    const base = getBackendUrl()
    const [cR, aR] = await Promise.all([
      fetch(`${base}/api/marketing/os/campaigns/${c.id}`, { cache: 'no-store' }),
      fetch(`${base}/api/marketing/os/campaigns/${c.id}/actions`, { cache: 'no-store' }),
    ])
    if (cR.ok) setC(await cR.json())
    if (aR.ok) setActions(await aR.json())
  }, [c.id])
  useMarketingEvents(useCallback(() => void reload(), [reload]))

  const mutate = async (body: Record<string, unknown>) => {
    setBusy(true)
    try { await fetch(`${getBackendUrl()}/api/marketing/os/campaigns/${c.id}/mutate`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) } finally { setBusy(false); void reload() }
  }
  const launch = async () => { setBusy(true); try { await fetch(`${getBackendUrl()}/api/marketing/os/campaigns/${c.id}/launch`, { method: 'POST' }) } finally { setBusy(false); void reload() } }

  const detailBlock = (() => {
    if (c.amazonAds) return [['Ad product', c.amazonAds.adProduct], ['Profile', c.amazonAds.profileId ?? '—'], ['Portfolio', c.amazonAds.portfolioId ?? '—']]
    if (c.ebayPromoted) return [['Funding', c.ebayPromoted.fundingStrategy], ['Bid %', c.ebayPromoted.bidPercentage ?? '—']]
    if (c.discount) return [['Discount type', c.discount.discountType], ['Percent', c.discount.discountPercent ?? '—'], ['Applies to', c.discount.appliesTo]]
    if (c.externalAds) return [['Platform', c.externalAds.platform], ['Objective', c.externalAds.objectiveNative ?? '—']]
    if (c.contentPush) return [['Content', c.contentPush.contentType], ['Targets', c.contentPush.targetRefs.join(', ') || '—']]
    if (c.outreach) return [['Mode', c.outreach.mode], ['Segment', c.outreach.segmentId ?? '—']]
    return []
  })()

  return (
    <div className="p-4 sm:p-6 max-w-[1100px] mx-auto">
      <Link href="/marketing/campaigns" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"><ArrowLeft size={14} /> Campaigns</Link>

      <header className="flex flex-wrap items-start gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{c.name}</h1>
          <div className="text-sm text-slate-500 mt-0.5">{c.channel} · {c.surface} · {c.objective} · {c.status}{c.budgetScope === 'MULTI_MARKET' ? ' · multi-market' : ''}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {(c.status === 'ACTIVE' || c.status === 'PAUSED') && (
            <button disabled={busy} onClick={() => void mutate({ status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40">
              {c.status === 'ACTIVE' ? <><Pause size={14} className="text-amber-600" /> Pause</> : <><Play size={14} className="text-emerald-600" /> Resume</>}
            </button>
          )}
          {c.channel === 'INTERNAL' && <button disabled={busy} onClick={launch} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"><Rocket size={14} /> Launch</button>}
        </div>
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        {[
          ['Budget', editing ? null : `${eur(c.budgetCents, c.currency)}${c.budgetKind === 'DAILY' ? '/d' : ''}`],
          ['Spend', eur(c.spendCents, c.currency)],
          ['Sales', eur(c.salesCents, c.currency)],
          ['ACOS', c.acos ? `${(Number(c.acos) * 100).toFixed(1)}%` : '—'],
          ['ROAS', c.roas ? Number(c.roas).toFixed(2) : '—'],
        ].map(([label, val]) => (
          <div key={label as string} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase text-slate-400">{label}</div>
            {label === 'Budget' && editing ? (
              <div className="flex items-center gap-1 mt-0.5">
                <input autoFocus type="number" step="0.01" value={budgetVal} onChange={(e) => setBudgetVal(e.target.value)} className="w-20 px-1 py-0.5 text-sm rounded border border-blue-400 bg-white dark:bg-slate-900" />
                <button onClick={() => { void mutate({ budgetCents: Math.round(parseFloat(budgetVal || '0') * 100) }); setEditing(false) }} className="text-blue-600"><Check size={14} /></button>
              </div>
            ) : (
              <button onClick={() => label === 'Budget' && setEditing(true)} className={`text-base font-semibold text-slate-800 dark:text-slate-100 ${label === 'Budget' ? 'hover:underline decoration-dotted' : 'cursor-default'}`}>{val}</button>
            )}
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Channel detail */}
        {detailBlock.length > 0 && (
          <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <h2 className="text-xs uppercase text-slate-400 mb-2">Channel detail</h2>
            <dl className="space-y-1 text-sm">{detailBlock.map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-slate-500">{k}</dt><dd className="text-slate-800 dark:text-slate-200">{v}</dd></div>)}</dl>
          </section>
        )}
        {/* Markets / links */}
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
          <h2 className="text-xs uppercase text-slate-400 mb-2">Markets ({c.links.length})</h2>
          <div className="space-y-1 text-sm">{c.links.map((l) => <div key={l.id} className="flex justify-between"><span className="text-slate-700 dark:text-slate-200">{l.marketplace}</span><span className="text-xs text-slate-400">{l.externalId ?? 'no ext id'} · {l.status}</span></div>)}{c.links.length === 0 && <span className="text-xs text-slate-400">No market links.</span>}</div>
        </section>
      </div>

      {/* Targets */}
      {c.targets.length > 0 && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 mt-4 overflow-hidden">
          <h2 className="text-xs uppercase text-slate-400 px-3 py-2 bg-slate-50 dark:bg-slate-900/60">Targets ({c.targets.length})</h2>
          <table className="w-full text-sm"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {c.targets.slice(0, 30).map((t) => <tr key={t.id}><td className="px-3 py-1.5">{t.kind} <span className="text-slate-400 text-xs">{t.expressionType}</span> {t.expressionValue}</td><td className="px-3 py-1.5 text-right text-slate-500">{t.bidCents != null ? eur(t.bidCents) : '—'}</td><td className="px-3 py-1.5 text-right text-slate-500">{eur(t.spendCents)}</td></tr>)}
          </tbody></table>
        </section>
      )}

      {/* Action audit */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 mt-4 overflow-hidden">
        <h2 className="text-xs uppercase text-slate-400 px-3 py-2 bg-slate-50 dark:bg-slate-900/60">Action history ({actions.actions.length})</h2>
        <table className="w-full text-sm"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {actions.actions.length === 0 && <tr><td className="px-3 py-3 text-xs text-slate-400">No actions yet.</td></tr>}
          {actions.actions.map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-1.5 text-slate-700 dark:text-slate-200">{a.actionType}</td>
              <td className="px-3 py-1.5"><span className={`text-xs px-1.5 py-0.5 rounded ${a.channelResponseStatus === 'SUCCESS' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : a.channelResponseStatus === 'FAILED' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>{a.channelResponseStatus ?? 'PENDING'}{a.rolledBackAt ? ' · rolled back' : ''}</span></td>
              <td className="px-3 py-1.5 text-xs text-slate-400">{a.userId ?? 'system'}</td>
              <td className="px-3 py-1.5 text-right text-xs text-slate-400">{new Date(a.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody></table>
      </section>
    </div>
  )
}
