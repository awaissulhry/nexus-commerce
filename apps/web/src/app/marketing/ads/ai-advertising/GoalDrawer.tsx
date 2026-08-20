'use client'

/**
 * AIAD.3 — the goal drawer: what this goal is, the campaigns the AI built for it, and the
 * live decision feed of what the AI has actually done — the transparency H10/Perpetua hide
 * behind their lockout. Autonomy control is deliberately Off ↔ Propose only: AUTO is earned
 * through the Control Room's evidence-based graduation path, never flipped on from a drawer.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Rocket } from 'lucide-react'
import { Drawer } from '@/design-system/components/Drawer'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Toggle } from '@/design-system/primitives/Toggle'
import { Spinner } from '@/design-system/primitives/Spinner'
import { MetricChart, type ChartMetric } from '../_shared/MetricChart'
import { getBackendUrl } from '@/lib/backend-url'

const DRAWER_METRICS: ChartMetric[] = [
  { key: 'spend', label: 'Spend', unit: 'eur' },
  { key: 'sales', label: 'Sales', unit: 'eur' },
  { key: 'acos', label: 'ACoS', unit: 'pct' },
  { key: 'orders', label: 'Orders', unit: 'count' },
]

interface DrawerCampaign {
  id: string; role: string; name: string; status: string
  dailyBudgetCents: number; marketplace: string | null; live: boolean; onAmazon: boolean
  perf: { spendCents: number; salesCents: number; orders: number; clicks: number; acosPct: number | null } | null
}
interface DrawerPlan { id: string; goal: string; autonomy: string; enabled: boolean; stage: string; lastEvaluatedAt: string | null; lastDecisionAt: string | null }
interface DrawerGoal {
  id: string; name: string; aiTarget: string; budgetMode: string; status: string
  marketplace: string | null; portfolioId: string | null; totalBudgetCents: number | null
  products: Array<{ asin?: string; sku?: string; name?: string; budgetCents?: number | null }>
  seedKeywords: string[]; excludeKeywords: string[]
  materializedAt: string | null; createdAt: string
}
interface Detail {
  goal: DrawerGoal; campaigns: DrawerCampaign[]; plan: DrawerPlan | null; pendingProposals: number
  series: Array<{ date: string; spendCents: number; salesCents: number; orders: number; acosPct: number | null }>
}
interface Decision { id: string; at: string; cycle: string; module: string; action: string; reason: string; status: string; source: string }

const ROLE_TONE: Record<string, TagTone> = { AUTO: 'info', RESEARCH: 'neutral', PERF: 'positive', PAT: 'warning' }
const ROLE_LABEL: Record<string, string> = { AUTO: 'Auto', RESEARCH: 'Research', PERF: 'Performance', PAT: 'Products' }
const TARGET_LABEL: Record<string, string> = { IMPRESSION: 'Impression & Click', SALES: 'Sales', ROAS: 'ROAS', LIQUIDATE: 'Liquidate', RANK: 'Defend Rank' }
const MODE_LABEL: Record<string, string> = { STRICT: 'Strict Control', SHARED: 'Shared Budget' }
const STATUS_TONE: Record<string, TagTone> = { PROPOSED: 'info', APPLIED: 'positive', DENIED: 'danger', SKIPPED: 'neutral', ROLLED_BACK: 'warning' }

const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function GoalDrawer({ goalId, onClose, onMutated, onLaunch, launching }: {
  goalId: string | null
  onClose: () => void
  onMutated: () => void
  onLaunch: (id: string) => void
  launching: boolean
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [live, setLive] = useState(false)
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [chartSel, setChartSel] = useState<string[]>(['spend', 'sales'])

  useEffect(() => {
    setDetail(null); setDecisions([]); setNote(null)
    if (!goalId) return
    let alive = true
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/ai-goals/${goalId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((j) => { if (alive) setDetail(j as Detail) })
      .catch(() => { if (alive) setNote({ text: 'Could not load this goal.', err: true }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [goalId])

  // initial decisions + real-time SSE for the goal's plan (same pattern as the Autopilot map).
  const planId = detail?.plan?.id ?? null
  useEffect(() => {
    if (!planId) return
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/autopilot-plans/${planId}/decisions?limit=50`)
      .then((r) => r.json())
      .then((j) => { if (alive) setDecisions((j?.items ?? []) as Decision[]) })
      .catch(() => {})
    const es = new EventSource(`${getBackendUrl()}/api/advertising/autopilot-plans/${planId}/decisions/stream`)
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.onmessage = (e) => {
      try { const d = JSON.parse(e.data) as Decision; setDecisions((cur) => [d, ...cur.filter((x) => x.id !== d.id)].slice(0, 100)) } catch { /* heartbeat */ }
    }
    return () => { alive = false; es.close(); setLive(false) }
  }, [planId])

  const g = detail?.goal
  const plan = detail?.plan ?? null
  const proposing = !!plan && plan.enabled && plan.autonomy !== 'OFF'

  const toggleAutonomy = async (next: boolean) => {
    if (!plan || saving || plan.autonomy === 'AUTO') return
    setSaving(true); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autopilot-plans/${plan.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autonomy: next ? 'SUGGEST' : 'OFF', enabled: true }),
      })
      if (!r.ok) throw new Error('save failed')
      setDetail((d) => (d && d.plan ? { ...d, plan: { ...d.plan, autonomy: next ? 'SUGGEST' : 'OFF', enabled: true } } : d))
      onMutated()
    } catch { setNote({ text: 'Could not change the AI state — try again.', err: true }) } finally { setSaving(false) }
  }

  const dailyBudgetCents = g
    ? (g.budgetMode === 'SHARED' ? (g.totalBudgetCents ?? 0) : (g.products ?? []).reduce((n, p) => n + (Number(p.budgetCents) || 0), 0))
    : 0

  return (
    <Drawer open={!!goalId} onClose={onClose} title={g?.name ?? 'Goal'} subtitle={g ? `${(g.products ?? []).length} product${(g.products ?? []).length === 1 ? '' : 's'} · created ${when(g.createdAt)}` : undefined} width={470}>
      {loading && <div className="aiad-feed-empty"><Spinner /> Loading…</div>}
      {note && <div className={`aiad-dw-note${note.err ? ' err' : ''}`}>{note.text}</div>}
      {g && (
        <div className="aiad-dw">
          <section>
            <h4>Goal</h4>
            <div className="aiad-dw-facts">
              <div className="f"><span className="k">AI Target</span><span className="v">{TARGET_LABEL[g.aiTarget] ?? g.aiTarget}</span></div>
              <div className="f"><span className="k">Budget Mode</span><span className="v">{MODE_LABEL[g.budgetMode] ?? g.budgetMode}</span></div>
              <div className="f"><span className="k">Daily Budget</span><span className="v">{eur(dailyBudgetCents)}</span></div>
              <div className="f"><span className="k">Marketplace</span><span className="v">{g.marketplace ?? '—'}</span></div>
              {plan && <div className="f"><span className="k">Strategy Preset</span><span className="v">{plan.goal}</span></div>}
              {plan && <div className="f"><span className="k">Life Stage</span><span className="v">{plan.stage}</span></div>}
            </div>
          </section>

          {!g.materializedAt ? (
            <section>
              <div className="aiad-auto">
                <div className="t">
                  <b>Not launched yet</b>
                  <span>Launching builds the campaign scaffold and starts the AI in propose-only mode.</span>
                </div>
                <button type="button" className="h10-am-btn primary" disabled={launching} onClick={() => onLaunch(g.id)}>
                  <Rocket size={13} /> {launching ? 'Launching…' : 'Launch'}
                </button>
              </div>
            </section>
          ) : plan && (
            <section>
              <div className="aiad-auto">
                <div className="t">
                  <b>AI optimization {plan.autonomy === 'AUTO' ? '— Auto (governed in Control Room)' : proposing ? '— proposing' : '— paused'}</b>
                  <span>
                    {plan.autonomy === 'AUTO'
                      ? 'Applying within guardrails. Graduation is managed on the Control Room.'
                      : proposing
                        ? 'Every decision lands as a proposal for your approval — nothing applies on its own.'
                        : 'The AI is paused for this goal: no proposals, no changes.'}
                    {plan.lastEvaluatedAt ? ` Last evaluated ${when(plan.lastEvaluatedAt)}.` : ''}
                  </span>
                </div>
                {plan.autonomy !== 'AUTO' && <Toggle checked={proposing} disabled={saving} onChange={toggleAutonomy} aria-label="AI proposing on/off" />}
              </div>
            </section>
          )}

          {g.materializedAt && (detail?.series?.length ?? 0) > 0 && (
            <section>
              <MetricChart
                title="Last 30 days"
                data={(detail?.series ?? []).map((s) => ({ date: s.date, spend: s.spendCents / 100, sales: s.salesCents / 100, acos: s.acosPct != null ? s.acosPct / 100 : null, orders: s.orders }))}
                metrics={DRAWER_METRICS}
                selected={chartSel}
                onSelectedChange={setChartSel}
                emptyLabel="No performance data yet."
              />
            </section>
          )}

          {g.materializedAt && (
            <section>
              <h4>Campaigns the AI built</h4>
              {(detail?.campaigns ?? []).length === 0 && <div className="aiad-feed-empty">No campaigns linked.</div>}
              {(detail?.campaigns ?? []).map((c) => (
                <div className="aiad-dw-camp" key={c.id}>
                  <Tag tone={ROLE_TONE[c.role] ?? 'neutral'}>{ROLE_LABEL[c.role] ?? c.role}</Tag>
                  <span className="mid">
                    <Link className="nm" href={`/marketing/ads/campaigns/${c.id}`} title={c.name}>{c.name}</Link>
                    <span className="perf">
                      {c.perf
                        ? <>{eur(c.perf.spendCents)} spend · {eur(c.perf.salesCents)} sales · {c.perf.acosPct == null ? '— ACoS' : `${c.perf.acosPct.toFixed(1)}% ACoS`}</>
                        : 'no data yet'}
                    </span>
                  </span>
                  <span className="bud">{eur(c.dailyBudgetCents)}/day</span>
                  <span className={`sync${c.onAmazon ? ' on' : ''}`}>{c.onAmazon ? 'on Amazon' : 'local'}</span>
                </div>
              ))}
            </section>
          )}

          {g.materializedAt && (
            <section>
              <div className="aiad-dw-head">
                <h4>AI decision feed</h4>
                <span className={`aiad-live${live ? ' on' : ''}`}>{live ? 'live' : 'offline'}</span>
              </div>
              {detail != null && detail.pendingProposals > 0 && (
                <div className="aiad-dw-note" style={{ marginBottom: 8 }}>
                  {detail.pendingProposals} pending proposal{detail.pendingProposals === 1 ? '' : 's'} — <Link className="aiad-metric-link" href="/marketing/ads/suggestions">review in Suggestions</Link>
                </div>
              )}
              <div className="aiad-feed">
                {decisions.length === 0
                  ? <div className="aiad-feed-empty">No decisions yet — the AI evaluates every 15 minutes and starts proposing once click data arrives.</div>
                  : decisions.map((d) => (
                    <div className="aiad-feed-row" key={d.id}>
                      <span className="when">{when(d.at)}</span>
                      <div className="what">
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                          <Tag tone="neutral">{d.module}</Tag>
                          <Tag tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status.toLowerCase()}</Tag>
                        </div>
                        <div className="rsn">{d.reason}</div>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}
