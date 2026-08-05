'use client'

/**
 * ACR.6 — the Family Cockpit: one portfolio, everything that governs it, one page.
 *
 * The operator's day-one ask, verbatim: "For each portfolio, how could we automate harvesting,
 * negating, and promoting the keywords, or managing the budget of them all? I must have proper
 * control over each and everything." The Control Room answers that account-wide; this page
 * answers it for ONE family, because a family (a portfolio) is the unit the operator thinks in.
 *
 * Every control here is an endpoint that already existed:
 *   · per-campaign live-writes switch  → PATCH /advertising/campaigns/:id/live-writes
 *   · family-wide on/off               → POST  /advertising/campaigns/live-writes/bulk
 *   · campaign budget / pause          → PATCH /advertising/campaigns/:id
 * Where per-family control does not exist in an engine yet (harvest/negate rules are
 * marketplace-scoped), the page says so instead of drawing a dial that governs nothing.
 *
 * Reached from the Portfolios list — a row click, not a sidebar entry.
 * Light-only, like the rest of this console.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Crown, Info, Pause, Play, RefreshCw, X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationDock, ruleDropProps, setRuleScope } from '../../_shared/AutomationDock'
import './family-cockpit.css'

/* ── contract (mirrors ads-family-cockpit.service.ts) ─────────────────────── */
interface Campaign {
  id: string; name: string; status: string; marketplace: string | null
  dailyBudgetEur: number; liveWritesEnabled: boolean
  minBidCents: number | null; maxBidCents: number | null
  deliveryStatus: string | null; deliveryReasons: string[]
  schedules: number; spend30dCents: number; sales30dCents: number; acos30d: number | null
}
interface Product { productId: string; sku: string | null; name: string | null; asin: string | null; ads: number }
interface CoverageRow {
  term: string; marketImpressions: number; ourImpressions: number | null; share: number | null
  ourAsins: number; targets: number; marketPurchases: number; ourPurchases: number | null
}
interface Contest {
  term: string; matchType: string
  contenders: Array<{ campaignId: string; campaignName: string; targets: number; impressions30d: number; clicks30d: number; spend30dCents: number; sales30dCents: number }>
  championCampaignId: string; championReason: string
}
interface PricedProposal {
  id: string; ruleName: string | null; proposedKey: string; entityLabel: string | null
  direction: string; spendAtStakeCents: number | null; salesAtStakeCents: number | null; recoverable: boolean
}
interface CoverageSetTerm {
  id: string; term: string; leadAsin: string | null; status: string
  maxCpcCents: number | null; targetSharePct: number | null; isControl: boolean
  marketImpressions: number | null; ourImpressions: number | null; share: number | null; familyKeywords: number | null
}
interface EnginePreviewDecision {
  term: string; campaignName: string; action: string
  currentBidCents: number; nextBidCents: number; reason: string; share: number | null
}
interface EnginePreview {
  mode: string; termsEvaluated: number; controlsSkipped: number
  ups: number; downs: number; holds: number; decisions: EnginePreviewDecision[]
}
interface CoverageSet {
  id: string; name: string; enabled: boolean
  dailySpendCapCents: number | null; acosCapPct: number | null
  terms: CoverageSetTerm[]
}
interface EngineLogRow {
  at: string; term: string | null; campaignName: string | null; action: 'up' | 'down'
  fromCents: number | null; toCents: number | null; reason: string | null
  kind: 'observed' | 'applied'
}

interface Cockpit {
  portfolio: {
    externalPortfolioId: string; name: string; state: string | null; marketplace: string | null
    budgetAmountCents: number | null; budgetPolicy: string | null; inBudget: boolean | null; lastSyncedAt: string | null
  }
  campaigns: Campaign[]
  products: Product[]
  totals: { campaigns: number; enabled: number; allowlisted: number; spend30dCents: number; sales30dCents: number; acos30d: number | null; dailyBudgetEur: number }
  coverage: { week: string | null; measured: boolean; rows: CoverageRow[]; totals: { share: number | null; marketImpressions: number; ourImpressions: number | null } } | null
  contests: Contest[]
  proposals: { pending: number; priced: number; spendAtStakeCents: number; recoverableCents: number; top: PricedProposal[] } | null
  automation: { notes: string[]; schedulesEnabled: number; schedulesTotal: number }
}

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const pct = (v: number | null | undefined, dp = 2) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const intl = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-IE'))

const TABS = ['Overview', 'Coverage', 'Keywords', 'Automation'] as const
type Tab = typeof TABS[number]

export function FamilyCockpitClient() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [ck, setCk] = useState<Cockpit | null>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [budgetEdit, setBudgetEdit] = useState<Record<string, string>>({})
  const [dropMsg, setDropMsg] = useState<string | null>(null)
  const [covSet, setCovSet] = useState<CoverageSet | null>(null)
  const [covSetBusy, setCovSetBusy] = useState(false)
  const [preview, setPreview] = useState<EnginePreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [engineLog, setEngineLog] = useState<EngineLogRow[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios/${id}/cockpit`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`cockpit: ${r.status}`)
      setCk((await r.json()) as Cockpit)
      setErr(null)
    } catch (e) { setErr((e as Error).message); setCk(null) } finally { setLoading(false) }
  }, [id])
  useEffect(() => { void load() }, [load])

  const loadCovSet = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios/${id}/coverage-set`, { cache: 'no-store' })
    setCovSet(r.ok ? ((await r.json()) as CoverageSet) : null)
  }, [id])
  useEffect(() => { void loadCovSet() }, [loadCovSet])

  useEffect(() => {
    void (async () => {
      const r = await fetch(`${getBackendUrl()}/api/advertising/coverage-engine/log?days=14`, { cache: 'no-store' })
      setEngineLog(r.ok ? ((await r.json()) as { rows: EngineLogRow[] }).rows : null)
    })()
  }, [id])

  const seedCovSet = async () => {
    setCovSetBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/portfolios/${id}/coverage-set/seed`, { method: 'POST' })
      await loadCovSet()
    } finally { setCovSetBusy(false) }
  }
  const patchCovSet = async (patch: Record<string, unknown>) => {
    if (!covSet) return
    setCovSetBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/coverage-sets/${covSet.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      await loadCovSet()
    } finally { setCovSetBusy(false) }
  }
  const previewEngine = async () => {
    if (!covSet) return
    setPreviewBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/coverage-sets/${covSet.id}/preview`, { method: 'POST' })
      setPreview(r.ok ? ((await r.json()) as EnginePreview) : null)
    } finally { setPreviewBusy(false) }
  }
  const patchCovTerm = async (termId: string, patch: Record<string, unknown>) => {
    setCovSetBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/coverage-terms/${termId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      await loadCovSet()
    } finally { setCovSetBusy(false) }
  }

  /* ── the existing write paths, wired ─────────────────────────────────── */
  const toggleLiveWrites = async (c: Campaign) => {
    setBusy(c.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/live-writes`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !c.liveWritesEnabled }),
      })
      await load()
    } finally { setBusy(null) }
  }
  const bulkLiveWrites = async (enabled: boolean) => {
    if (!ck) return
    setBusy('bulk')
    try {
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/live-writes/bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignIds: ck.campaigns.map((c) => c.id), enabled }),
      })
      await load()
    } finally { setBusy(null) }
  }
  const patchCampaign = async (cid: string, body: Record<string, unknown>) => {
    setBusy(cid)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/${cid}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, reason: 'Family cockpit', applyImmediately: true }),
      })
      await load()
    } finally { setBusy(null) }
  }

  const bindRule = async (rule: { id: string; name: string }, scope: { scopePortfolioId?: string; scopeCampaignId?: string }, label: string) => {
    const ok = await setRuleScope(rule.id, scope)
    setDropMsg(ok ? `“${rule.name}” now fires only inside ${label}.` : 'Bind failed — the scope change was rejected.')
    setTimeout(() => setDropMsg(null), 5000)
  }

  if (loading && !ck) return <div className="fc-empty">Loading…</div>
  if (err) return <div className="fc-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>
  if (!ck) return <div className="fc-empty">Portfolio not found.</div>

  const cov = ck.coverage
  const covRows = cov?.rows ?? []

  return (
    <div className="fc fc--with-dock">
      <div className="fc-maincol">
      <header className="fc-head">
        <div className="fc-head-main" {...ruleDropProps((rule) => void bindRule(rule, { scopePortfolioId: ck.portfolio.externalPortfolioId }, `portfolio ${ck.portfolio.name}`))}>
          <Link href="/marketing/ads/portfolios" className="fc-back"><ArrowLeft size={14} /> Portfolios</Link>
          <h1>{ck.portfolio.name}</h1>
          <span className={`fc-state ${(ck.portfolio.state ?? '').toLowerCase()}`}>{ck.portfolio.state ?? '—'}</span>
          {ck.portfolio.marketplace && <span className="fc-mkt">{ck.portfolio.marketplace}</span>}
        </div>
        <button type="button" className="fc-btn" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {/* the family's vitals, always visible */}
      <div className="fc-vitals">
        <div><span className="k">Campaigns</span><span className="v">{ck.totals.enabled} on · {ck.totals.campaigns} total</span></div>
        <div><span className="k">Automation may write to</span><span className="v">{ck.totals.allowlisted} of {ck.totals.campaigns}</span></div>
        <div><span className="k">Daily budget (enabled)</span><span className="v">€{ck.totals.dailyBudgetEur.toFixed(2)}</span></div>
        <div><span className="k">30d spend → sales</span><span className="v">{eur(ck.totals.spend30dCents)} → {eur(ck.totals.sales30dCents)}</span></div>
        <div><span className="k">ACOS 30d</span><span className="v">{pct(ck.totals.acos30d, 0)}</span></div>
        <div><span className="k">Page-one share</span><span className="v">{cov?.measured ? pct(cov.totals.share) : '—'}</span></div>
        <div><span className="k">Portfolio cap</span><span className="v">{ck.portfolio.budgetAmountCents == null ? 'No cap' : eur(ck.portfolio.budgetAmountCents)}</span></div>
      </div>

      {dropMsg && <div className="fc-banner ok"><Check size={15} /> {dropMsg}</div>}

      <nav className="fc-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`fc-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t}
            {t === 'Keywords' && ck.contests.length > 0 && <em>{ck.contests.length}</em>}
            {t === 'Automation' && (ck.proposals?.pending ?? 0) > 0 && <em>{ck.proposals?.pending}</em>}
          </button>
        ))}
      </nav>

      {/* ══ Overview — the campaigns, with their controls inline ══ */}
      {tab === 'Overview' && (
        <>
          <div className="fc-sec-head">
            <h2>Campaigns</h2>
            <span className="fc-sec-sub">the live-writes switch is this family&rsquo;s hard automation boundary — enforced at the write gate</span>
            <span className="fc-bulk">
              <button type="button" className="fc-btn sm" disabled={busy != null} onClick={() => void bulkLiveWrites(true)}>All writable</button>
              <button type="button" className="fc-btn sm" disabled={busy != null} onClick={() => void bulkLiveWrites(false)}>All read-only</button>
            </span>
          </div>
          <div className="fc-tablewrap">
            <table className="fc-table">
              <thead><tr>
                <th className="l">Campaign</th><th>Status</th><th>Automation writes</th>
                <th>Budget/day</th><th>30d spend</th><th>30d sales</th><th>ACOS</th>
                <th>Bounds</th><th>Schedules</th><th>Delivery</th>
              </tr></thead>
              <tbody>
                {ck.campaigns.map((c) => (
                  <tr
                    key={c.id}
                    className={c.status !== 'ENABLED' ? 'off' : ''}
                    {...ruleDropProps((rule) => void bindRule(rule, { scopeCampaignId: c.id }, c.name))}
                  >
                    <td className="l" title={c.name}>{c.name}</td>
                    <td>
                      <button
                        type="button" className={`fc-status ${c.status.toLowerCase()}`}
                        disabled={busy === c.id || c.status === 'ARCHIVED'}
                        title={c.status === 'ENABLED' ? 'Pause this campaign' : c.status === 'PAUSED' ? 'Enable this campaign' : 'Archived'}
                        onClick={() => void patchCampaign(c.id, { status: c.status === 'ENABLED' ? 'PAUSED' : 'ENABLED' })}
                      >
                        {c.status === 'ENABLED' ? <><Pause size={11} /> on</> : c.status === 'PAUSED' ? <><Play size={11} /> paused</> : 'archived'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`fc-switch ${c.liveWritesEnabled ? 'on' : ''}`}
                        disabled={busy === c.id}
                        title={c.liveWritesEnabled
                          ? 'Automation may write bids/budgets to this campaign. Click to make it read-only.'
                          : 'Read-only: every engine write to this campaign is refused at the gate. Click to allow.'}
                        onClick={() => void toggleLiveWrites(c)}
                      >
                        {c.liveWritesEnabled ? <><Check size={11} /> writable</> : <><X size={11} /> read-only</>}
                      </button>
                    </td>
                    <td className="num">
                      <span className="fc-budget">
                        <input
                          value={budgetEdit[c.id] ?? c.dailyBudgetEur.toFixed(2)}
                          onChange={(e) => setBudgetEdit((m) => ({ ...m, [c.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return
                            const v = Number(budgetEdit[c.id])
                            if (Number.isFinite(v) && v > 0 && v !== c.dailyBudgetEur) void patchCampaign(c.id, { dailyBudget: v })
                          }}
                          aria-label={`Daily budget for ${c.name}`}
                        />
                      </span>
                    </td>
                    <td className="num">{eur(c.spend30dCents)}</td>
                    <td className="num">{eur(c.sales30dCents)}</td>
                    <td className="num">{pct(c.acos30d, 0)}</td>
                    <td className="num" title="min / max bid the write gate enforces">
                      {c.minBidCents != null ? `${c.minBidCents}¢` : '—'} / {c.maxBidCents != null ? `${c.maxBidCents}¢` : '—'}
                    </td>
                    <td className="num">{c.schedules || '—'}</td>
                    <td>
                      {c.deliveryStatus === 'NOT_DELIVERING'
                        ? <span className="fc-deliv bad" title={c.deliveryReasons.join(', ')}>not serving</span>
                        : c.deliveryStatus === 'DELIVERING' ? <span className="fc-deliv ok">serving</span> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fc-sec-head"><h2>Products</h2>
            <span className="fc-sec-sub">{ck.products.length} advertised in this family — the &ldquo;several products, same keywords&rdquo; this cockpit exists for</span>
          </div>
          <ul className="fc-products">
            {ck.products.slice(0, 24).map((p) => (
              <li key={p.productId || p.asin || p.sku || ''}>
                <span className="sku" title={p.name ?? undefined}>{p.sku ?? p.asin ?? '—'}</span>
                <span className="asin">{p.asin ?? ''}</span>
                <span className="ads">{p.ads} ads</span>
              </li>
            ))}
            {ck.products.length > 24 && <li className="more">… and {ck.products.length - 24} more</li>}
          </ul>
        </>
      )}

      {/* ══ Coverage — this family's share of its pages ══ */}
      {tab === 'Coverage' && (
        <>
          {/* ACR.3 — the coverage SET: what this family is deliberately trying to own. The
              scoreboard below reports what IS; this panel records INTENT, and the pilot engine
              reads intent exclusively — enabled sets only, never raw SQP. */}
          <div className="fc-sec-head">
            <h2>Coverage set</h2>
            <span className="fc-sec-sub">
              the terms this family deliberately owns — the pilot engine reads THIS, never raw data
            </span>
            <span className="fc-bulk">
              {covSet && (
                <button type="button" className="fc-btn sm" disabled={previewBusy} onClick={() => void previewEngine()}>
                  {previewBusy ? 'Previewing…' : 'Preview engine decisions'}
                </button>
              )}
              <button type="button" className="fc-btn sm" disabled={covSetBusy} onClick={() => void seedCovSet()}>
                {covSet ? 'Re-seed from evidence' : 'Seed from evidence'}
              </button>
            </span>
          </div>
          {!covSet ? (
            <div className="fc-banner warn">
              <Info size={15} />
              <span>No coverage set yet. Seeding builds a DRAFT from this family&rsquo;s measured terms — each with a proposed lead ASIN (the one already taking the most impressions). Nothing acts on a draft.</span>
            </div>
          ) : (
            <>
              <div className="fc-autorow">
                <div><span className="k">Status</span><span className="v">
                  <button type="button" className={`fc-switch ${covSet.enabled ? 'on' : ''}`} disabled={covSetBusy}
                    title={covSet.enabled ? 'The engine reads this set. Click to make it a draft again.' : 'Draft — the engine ignores it. Click to enable.'}
                    onClick={() => void patchCovSet({ enabled: !covSet.enabled })}>
                    {covSet.enabled ? <><Check size={11} /> engine reads this</> : <><X size={11} /> draft</>}
                  </button>
                </span></div>
                <div><span className="k">Terms</span><span className="v">{covSet.terms.filter((t) => t.status === 'ACTIVE').length} active · {covSet.terms.length} total</span></div>
                <div><span className="k">Daily cap</span><span className="v">
                  <span className="fc-budget"><input
                    defaultValue={covSet.dailySpendCapCents != null ? (covSet.dailySpendCapCents / 100).toFixed(2) : ''}
                    placeholder="none"
                    aria-label="Family daily spend cap (EUR)"
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      const v = Number((e.target as HTMLInputElement).value)
                      void patchCovSet({ dailySpendCapCents: Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null })
                    }} /></span>
                </span></div>
                <div><span className="k">ACOS cap %</span><span className="v">
                  <span className="fc-budget"><input
                    defaultValue={covSet.acosCapPct ?? ''}
                    placeholder="none"
                    aria-label="Family ACOS cap percent"
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      const v = Number((e.target as HTMLInputElement).value)
                      void patchCovSet({ acosCapPct: Number.isFinite(v) && v > 0 ? v : null })
                    }} /></span>
                </span></div>
              </div>
              <div className="fc-tablewrap" style={{ marginBottom: 18 }}>
                <table className="fc-table">
                  <thead><tr>
                    <th className="l">Term</th><th>Market</th><th>Share</th>
                    <th className="l" title="The family ASIN that leads this term — highest bid, ToS defense. Others support.">Lead ASIN</th>
                    <th>Max CPC ¢</th><th>Target share %</th>
                    <th title="Control terms are held out: the engine never touches them, so week-over-week share moves are attributable to the engine rather than the market.">Control</th>
                    <th>Status</th>
                  </tr></thead>
                  <tbody>
                    {covSet.terms.filter((t) => t.status !== 'RETIRED').map((t) => (
                      <tr key={t.id} className={t.status === 'PAUSED' ? 'off' : ''}>
                        <td className="l">{t.term}</td>
                        <td className="num">{intl(t.marketImpressions)}</td>
                        <td className="num strong">{pct(t.share)}</td>
                        <td className="l">
                          <select
                            value={t.leadAsin ?? ''}
                            disabled={covSetBusy}
                            aria-label={`Lead ASIN for ${t.term}`}
                            onChange={(e) => void patchCovTerm(t.id, { leadAsin: e.target.value || null })}
                            className="fc-lead-select"
                          >
                            <option value="">— none —</option>
                            {[...new Set(ck.products.map((p) => p.asin).filter(Boolean))].map((a) => (
                              <option key={a as string} value={a as string}>{a}</option>
                            ))}
                          </select>
                        </td>
                        <td className="num">
                          <span className="fc-budget"><input
                            defaultValue={t.maxCpcCents ?? ''}
                            placeholder="set"
                            aria-label={`Max CPC for ${t.term}`}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              const v = Number((e.target as HTMLInputElement).value)
                              void patchCovTerm(t.id, { maxCpcCents: Number.isFinite(v) && v > 0 ? Math.round(v) : null })
                            }} /></span>
                        </td>
                        <td className="num">
                          <span className="fc-budget"><input
                            defaultValue={t.targetSharePct ?? ''}
                            placeholder="—"
                            aria-label={`Target share for ${t.term}`}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              const v = Number((e.target as HTMLInputElement).value)
                              void patchCovTerm(t.id, { targetSharePct: Number.isFinite(v) && v > 0 ? v : null })
                            }} /></span>
                        </td>
                        <td>
                          <button type="button" className={`fc-switch ${t.isControl ? 'on' : ''}`}
                            disabled={covSetBusy}
                            title={t.isControl ? 'Held out — the engine never touches this term. Click to hand it to the engine.' : 'Engine-managed. Click to hold it out as a control.'}
                            onClick={() => void patchCovTerm(t.id, { isControl: !t.isControl })}>
                            {t.isControl ? 'control' : 'engine'}
                          </button>
                        </td>
                        <td>
                          <button type="button" className={`fc-status ${t.status === 'ACTIVE' ? 'enabled' : 'paused'}`}
                            disabled={covSetBusy}
                            title={t.status === 'ACTIVE' ? 'Pause this term in the set' : 'Reactivate'}
                            onClick={() => void patchCovTerm(t.id, { status: t.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>
                            {t.status === 'ACTIVE' ? 'active' : 'paused'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview && (
                <>
                  <div className="fc-sec-head"><h2>Engine preview</h2>
                    <span className="fc-sec-sub">
                      what the engine would do right now — {preview.termsEvaluated} evaluated · {preview.ups} up · {preview.downs} down · {preview.holds} hold
                      {preview.controlsSkipped > 0 ? ` · ${preview.controlsSkipped} control held out` : ''}
                      {' '}· preview never applies
                    </span>
                  </div>
                  {preview.decisions.filter((d) => d.action !== 'hold').length === 0 ? (
                    <div className="fc-banner ok"><Check size={15} /> No bid would move — every evaluated term is holding, capped, or awaiting a target.</div>
                  ) : (
                    <div className="fc-tablewrap" style={{ marginBottom: 18 }}>
                      <table className="fc-table">
                        <thead><tr><th className="l">Term</th><th>Move</th><th>Bid</th><th className="l">Why</th><th className="l">Campaign</th></tr></thead>
                        <tbody>
                          {preview.decisions.filter((d) => d.action !== 'hold').map((d) => (
                            <tr key={d.term}>
                              <td className="l">{d.term}</td>
                              <td className={`num ${d.action === 'up' ? 'multi' : 'none'}`}>{d.action.toUpperCase()}</td>
                              <td className="num">{d.currentBidCents}¢ → {d.nextBidCents}¢</td>
                              <td className="l">{d.reason}</td>
                              <td className="l">{d.campaignName}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              <div className="fc-sec-head"><h2>Engine log</h2>
                <span className="fc-sec-sub">
                  every move the scheduled engine recorded in the last 14 days — observed = would-do only, applied = written through the gate
                </span>
              </div>
              {!engineLog || engineLog.length === 0 ? (
                <div className="fc-banner info"><Info size={15} />
                  <span>
                    No engine runs recorded yet. The 07:10 daily run reads <strong>enabled</strong> sets only
                    {covSet && !covSet.enabled ? ' — this set is still a draft, so the engine is not looking at it' : ''}.
                    Holds are not logged; the first row appears when a run would actually move a bid.
                  </span>
                </div>
              ) : (
                <div className="fc-tablewrap" style={{ marginBottom: 18 }}>
                  <table className="fc-table">
                    <thead><tr><th className="l">When</th><th className="l">Term</th><th>Move</th><th>Bid</th><th className="l">Why</th><th className="l">Campaign</th><th>Kind</th></tr></thead>
                    <tbody>
                      {engineLog.map((r, i) => (
                        <tr key={`${r.at}-${i}`}>
                          <td className="l">{new Date(r.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                          <td className="l">{r.term ?? '—'}</td>
                          <td className={`num ${r.action === 'up' ? 'multi' : 'none'}`}>{r.action.toUpperCase()}</td>
                          <td className="num">{r.fromCents != null && r.toCents != null ? `${r.fromCents}¢ → ${r.toCents}¢` : '—'}</td>
                          <td className="l">{r.reason ?? '—'}</td>
                          <td className="l">{r.campaignName ?? '—'}</td>
                          <td><span className={`fc-badge ${r.kind}`}>{r.kind}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {!cov || covRows.length === 0 ? (
            <div className="fc-banner warn">
              <Info size={15} />
              <span>
                No Search Query Performance rows for this family&rsquo;s ASINs yet
                {cov?.week ? ` in the measured week (${cov.week})` : ''}. The weekly SQP ingest covers the
                most-advertised ASINs first — this family joins as its ASINs are requested. Nothing here
                means &ldquo;unmeasured&rdquo;, not &ldquo;invisible&rdquo;.
              </span>
            </div>
          ) : (
            <>
              <div className="fc-sec-head"><h2>Share of page one · week {cov.week}</h2>
                <span className="fc-sec-sub">market counted once per term · our side is THIS family&rsquo;s ASINs only</span>
              </div>
              <div className="fc-tablewrap">
                <table className="fc-table">
                  <thead><tr>
                    <th className="l">Search term</th><th>Market</th><th>Ours</th><th>Share</th>
                    <th title="Family ASINs that took impressions on this page">On page</th>
                    <th title="Positive keywords THIS family holds on the exact term">Family kws</th>
                  </tr></thead>
                  <tbody>
                    {covRows.map((r) => (
                      <tr key={r.term}>
                        <td className="l">{r.term}</td>
                        <td className="num">{intl(r.marketImpressions)}</td>
                        <td className="num">{intl(r.ourImpressions)}</td>
                        <td className="num strong">{pct(r.share)}</td>
                        <td className={`num ${r.ourAsins > 1 ? 'multi' : ''}`}>{r.ourAsins || '—'}</td>
                        <td className={`num ${r.targets === 0 ? 'none' : ''}`}>{r.targets || 'none'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="fc-foot">
                Account-wide coverage lives on <Link href="/marketing/ads/analytics" className="fc-link">Coverage</Link>.
                A term with volume and &ldquo;none&rdquo; under Family kws is this family&rsquo;s next keyword.
              </p>
            </>
          )}
        </>
      )}

      {/* ══ Keywords — who should own each contested term ══ */}
      {tab === 'Keywords' && (
        <>
          <div className="fc-sec-head"><h2>Contested terms</h2>
            <span className="fc-sec-sub">
              terms two or more of this family&rsquo;s campaigns bid — the champion is chosen by the SAME
              ordering the rank engine acts on, so this list can never contradict what automation does
            </span>
          </div>
          {ck.contests.length === 0 ? (
            <div className="fc-banner ok"><Check size={15} /> No term is bid by more than one campaign in this family — no internal contest.</div>
          ) : (
            <ul className="fc-contests">
              {ck.contests.map((c) => (
                <li key={`${c.term}|${c.matchType}`}>
                  <div className="fc-contest-head">
                    <strong>&ldquo;{c.term}&rdquo;</strong><span className="mt">{c.matchType}</span>
                    <span className="n">{c.contenders.length} campaigns</span>
                  </div>
                  <div className="fc-contenders">
                    {c.contenders.map((x) => {
                      const isChamp = x.campaignId === c.championCampaignId
                      return (
                        <div key={x.campaignId} className={`fc-contender ${isChamp ? 'champ' : ''}`}>
                          {isChamp && <Crown size={12} />}
                          <span className="name" title={x.campaignName}>{x.campaignName}</span>
                          <span className="stats">
                            {intl(x.impressions30d)} impr · {x.clicks30d} clicks · {eur(x.spend30dCents)} → {eur(x.sales30dCents)}
                          </span>
                          {isChamp && <span className="why">{c.championReason}</span>}
                        </div>
                      )
                    })}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="fc-foot">
            Retiring a loser is a structural change and stays a human action — dedupe lives in the
            campaign tools, and the engine already demotes losers&rsquo; bids every 15 minutes.
          </p>
        </>
      )}

      {/* ══ Automation — posture, proposals, and the honest limits ══ */}
      {tab === 'Automation' && (
        <>
          <div className="fc-sec-head"><h2>What automation may do to this family</h2></div>
          <ul className="fc-notes">
            {ck.automation.notes.map((n) => <li key={n.slice(0, 30)}><Info size={13} /> {n}</li>)}
          </ul>

          <div className="fc-autorow">
            <div><span className="k">Writable campaigns</span><span className="v">{ck.totals.allowlisted} of {ck.totals.campaigns}</span></div>
            <div><span className="k">Rank schedules</span><span className="v">{ck.automation.schedulesEnabled} enabled of {ck.automation.schedulesTotal}</span></div>
            <div><span className="k">Pending proposals</span><span className="v">{ck.proposals?.pending ?? 0}</span></div>
            <div><span className="k">Pure-waste recoverable</span><span className="v">{eur(ck.proposals?.recoverableCents ?? 0)}</span></div>
          </div>

          <div className="fc-sec-head"><h2>Proposals for this family</h2>
            <span className="fc-sec-sub">what the rules want to change here, priced by the 30-day spend each action would redirect</span>
          </div>
          {(ck.proposals?.top.length ?? 0) === 0 ? (
            <div className="fc-banner ok"><Check size={15} /> Nothing pending for this family.</div>
          ) : (
            <div className="fc-tablewrap">
              <table className="fc-table">
                <thead><tr><th className="l">Rule</th><th className="l">Action</th><th className="l">Term / entity</th><th>At stake (30d)</th><th>Sales it made</th></tr></thead>
                <tbody>
                  {ck.proposals!.top.map((p) => (
                    <tr key={p.id}>
                      <td className="l">{p.ruleName ?? '—'}</td>
                      <td className="l mono">{p.proposedKey}</td>
                      <td className="l">{p.recoverable && <span className="fc-diamond" title="This spend produced nothing — pure recovery">♦</span>}{p.entityLabel ?? '—'}</td>
                      <td className="num">{eur(p.spendAtStakeCents)}</td>
                      <td className="num">{eur(p.salesAtStakeCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="fc-foot">
            Approve or dismiss on <Link href="/marketing/ads/suggestions" className="fc-link">Suggestions</Link>.
            Engine dials and the kill switch live in the{' '}
            <Link href="/marketing/ads/rules-automation/control-room" className="fc-link">Control Room <ArrowRight size={11} /></Link>.
          </p>
        </>
      )}
      </div>
      {/* ACR.7 — drop a rule on the header to bind it to this portfolio, or on a campaign row
          to bind it to that campaign alone. */}
      <AutomationDock onChanged={() => void load()} />
    </div>
  )
}
