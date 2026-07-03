'use client'

/**
 * E7 Stage 1 — the goal-first campaign builder (blueprint items 1,2,3,5,6,
 * 8,10,11-lite,13,22,23,24). Entry = four GOAL CARDS that derive everything;
 * the plan screen shows every decision with provenance and lets you override
 * inline; collisions (one-listing-one-General) resolve per listing
 * (include/skip/move); preflight separates blocking from advisory; a
 * Readiness meter scores the launch; success renders the "what happens
 * next" timeline. All h10 idiom.
 */
import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Shield, Rocket, Tag, Crosshair, CheckCircle2 } from 'lucide-react'
import { AdsPageHeader } from '../../../_shell/AdsPageHeader'
import { eur, pct } from '../../../campaigns/_grid/format'
import '../../ebay.css'
import { postEbayAds, useWriteMode, SandboxBanner, EBAY_MARKETS } from '../../_shared'

// ── Types mirroring the prefill/launch API ───────────────────────────────────
interface PlanListing {
  itemId: string; title: string | null; priceCents: number | null; quantity: number | null
  breakEvenPct: number | null; economicsStatus: string | null
  computedRatePct: number | null; rateSource: string
  trailingSales30dCents: number; forecastMonthlyFeeCents: number | null
  conflict: { campaignId: string; campaignName: string; currentRatePct: number | null } | null
}
interface Prefill {
  goal: string
  derived: { label: string; strategy: 'CPS' | 'CPC'; name: string; marketplace: string; goalFactor: number; endDate: string | null; rulePacks: string[]; rateMode: string; defaultBudgetCents: number | null }
  listings: PlanListing[]
  totals: { listings: number; conflicts: number; missingCost: number; forecastMonthlyFeeCents: number; trailingSales30dCents: number }
  keywordSeeds?: Array<{ text: string; source: string; matchType: string; bidCents: number }>
  budget?: { suggestedCents: number; formula: string } | null
}
interface Seed { text: string; source: string; matchType: 'PHRASE' | 'EXACT' | 'BROAD'; bidEur: string; on: boolean }
interface LaunchOut { ok: boolean; mode: string; campaignId: string; rulePacksBound: string[]; timeline: string[]; promoteResults: Array<{ key: string; ok: boolean; blocked?: string | null; error?: string | null; warning?: string | null }>; keywordResults?: Array<{ key: string; ok: boolean; blocked?: string | null; error?: string | null }> }

const GOALS = [
  { key: 'catch_all', Icon: Shield, title: 'Protect margin — promote everything', desc: 'One evergreen General campaign. Every listing at its own break-even-clamped rate; new listings enroll via automation. The always-on baseline.', chips: ['General · fixed', 'rate = break-even × 0.7', '4 rule packs'] },
  { key: 'hero', Icon: Rocket, title: 'Push hero products', desc: 'Priority (CPC) — the only strategy with access to the #1 search slot since Jan 2026. Add keywords after launch; bids clamped to break-even CPC when costs exist.', chips: ['Priority · manual', 'daily budget', '2 rule packs'] },
  { key: 'clearance', Icon: Tag, title: 'Clear stock', desc: 'Aggressive General campaign with a mandatory 30-day end date. Rate = full break-even (sell at cost-neutral) — clearance without silent loss.', chips: ['General · fixed', 'rate = break-even × 1.0', 'auto end date'] },
  { key: 'defend', Icon: Crosshair, title: 'Defend visibility', desc: 'Priority manual for specific queries you must own. Pairs with keyword rules that pause bleeders and bid down thin CTR.', chips: ['Priority · manual', 'keyword-first', '1 rule pack'] },
] as const

export function EbayCampaignBuilder() {
  const router = useRouter()
  const writeMode = useWriteMode()
  const [market, setMarket] = useState('EBAY_IT')
  const [step, setStep] = useState<'goal' | 'plan' | 'done'>('goal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<Prefill | null>(null)
  // overrides
  const [name, setName] = useState('')
  const [ratePct, setRatePct] = useState('')
  const [budgetEur, setBudgetEur] = useState('5.00')
  const [targeting, setTargeting] = useState<'MANUAL' | 'SMART'>('MANUAL')
  const [maxCpcEur, setMaxCpcEur] = useState('0.40')
  const [packs, setPacks] = useState<Set<string>>(new Set())
  const [resolutions, setResolutions] = useState<Record<string, 'include' | 'skip' | 'move'>>({})
  const [perRate, setPerRate] = useState<Record<string, string>>({})
  const [ack, setAck] = useState<Set<string>>(new Set())
  const [seeds, setSeeds] = useState<Seed[]>([])
  const [newSeed, setNewSeed] = useState('')
  const [launched, setLaunched] = useState<LaunchOut | null>(null)

  const pickGoal = useCallback(async (goal: string) => {
    setBusy(true); setError(null)
    try {
      const p = await postEbayAds<Prefill>('/builder/prefill', { goal, marketplace: market })
      setPlan(p)
      setName(p.derived.name)
      setRatePct('')
      setPacks(new Set(p.derived.rulePacks))
      setResolutions(Object.fromEntries(p.listings.filter((l) => l.conflict).map((l) => [l.itemId, 'skip' as const])))
      setPerRate({})
      setAck(new Set())
      setSeeds((p.keywordSeeds ?? []).map((s) => ({ text: s.text, source: s.source, matchType: s.matchType as Seed['matchType'], bidEur: (s.bidCents / 100).toFixed(2), on: true })))
      setNewSeed('')
      if (p.budget?.suggestedCents) setBudgetEur((p.budget.suggestedCents / 100).toFixed(2))
      setStep('plan')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [market])

  const isCps = plan?.derived.strategy === 'CPS'
  const effRate = (l: PlanListing): number | null => {
    const o = perRate[l.itemId]
    if (o != null && o !== '') return Number(o)
    if (ratePct !== '') return Number(ratePct)
    return l.computedRatePct
  }
  const included = useMemo(() => (plan?.listings ?? []).filter((l) => (resolutions[l.itemId] ?? 'include') !== 'skip'), [plan, resolutions])
  const forecast = useMemo(() => included.reduce((a, l) => { const r = effRate(l); return a + (isCps && r != null ? Math.round(l.trailingSales30dCents * (r / 100)) : 0) }, 0), [included, perRate, ratePct, isCps]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Preflight (blueprint #22) ────────────────────────────────────────────
  const blocking: string[] = []
  const advisory: Array<{ key: string; text: string }> = []
  if (plan) {
    if (!name.trim()) blocking.push('Campaign name is required')
    if (isCps && included.length === 0) blocking.push('No listings included — a General campaign cannot launch empty')
    const badRates = included.filter((l) => { const r = effRate(l); return isCps && (r == null || r < 2 || r > 100) })
    if (badRates.length) blocking.push(`${badRates.length} listing(s) have no valid rate (2–100%)`)
    if (!isCps && (Number(budgetEur) || 0) < 1) blocking.push('Daily budget must be ≥ €1.00')
    if (!isCps && targeting === 'SMART' && (Number(maxCpcEur) || 0) < 0.02) blocking.push('Smart targeting needs a max CPC ≥ €0.02')
    const badSeeds = seeds.filter((s) => s.on && (!s.text.trim() || (Number(s.bidEur) || 0) < 0.05))
    if (!isCps && targeting === 'MANUAL' && badSeeds.length) blocking.push(`${badSeeds.length} keyword(s) invalid — need text + bid ≥ €0.05`)
    const unresolved = included.filter((l) => l.conflict && (resolutions[l.itemId] ?? 'include') === 'include')
    if (unresolved.length) blocking.push(`${unresolved.length} conflicted listing(s) unresolved — choose skip or move (one listing = one General campaign)`)
    const overBe = included.filter((l) => { const r = effRate(l); return l.breakEvenPct != null && r != null && r > l.breakEvenPct })
    if (overBe.length) advisory.push({ key: 'over-be', text: `${overBe.length} listing(s) priced ABOVE break-even — every attributed sale loses margin (needs an override reason at launch)` })
    if (plan.totals.missingCost > 0) advisory.push({ key: 'missing-cost', text: `${plan.totals.missingCost} listing(s) have no cost data — rates fall back to the goal default, margin unverified` })
    if (isCps && forecast > 0) advisory.push({ key: 'forecast', text: `Projected ≈ ${eur(forecast / 100)}/month in ad fees at current trailing sales (any-click attribution)` })
  }
  const unacked = advisory.filter((a) => a.key !== 'forecast' && !ack.has(a.key))

  // ── Readiness meter (blueprint #23) ──────────────────────────────────────
  const readiness = useMemo(() => {
    if (!plan) return { score: 0, fixes: [] as string[] }
    let score = 100; const fixes: string[] = []
    const costCov = plan.totals.listings ? 1 - plan.totals.missingCost / plan.totals.listings : 0
    if (costCov < 1) { const d = Math.round((1 - costCov) * 30); score -= d; fixes.push(`+${d}: add product costs (${plan.totals.missingCost} missing) so rates clamp to break-even`) }
    if (plan.totals.conflicts > 0 && included.some((l) => l.conflict && resolutions[l.itemId] === 'include')) { score -= 20; fixes.push('+20: resolve campaign conflicts (skip or move)') }
    if (packs.size === 0) { score -= 15; fixes.push('+15: bind at least one rule pack so the campaign is born governed') }
    if (isCps && included.some((l) => { const r = effRate(l); return l.breakEvenPct != null && r != null && r > l.breakEvenPct })) { score -= 15; fixes.push('+15: bring rates back under break-even') }
    return { score: Math.max(0, score), fixes }
  }, [plan, included, resolutions, packs, perRate, ratePct, isCps]) // eslint-disable-line react-hooks/exhaustive-deps

  const launch = async () => {
    if (!plan) return
    setBusy(true); setError(null)
    try {
      const overBe = included.some((l) => { const r = effRate(l); return l.breakEvenPct != null && r != null && r > l.breakEvenPct })
      let overrideReason: string | undefined
      if (overBe) {
        overrideReason = window.prompt('Some rates exceed break-even. Enter an override reason (audited):') ?? undefined
        if (!overrideReason?.trim()) { setBusy(false); return }
      }
      const out = await postEbayAds<LaunchOut>('/builder/launch', {
        goal: plan.goal,
        name: name.trim(),
        marketplace: plan.derived.marketplace,
        ...(isCps ? { ratePct: ratePct !== '' ? Number(ratePct) : undefined } : { dailyBudgetCents: Math.round(Number(budgetEur) * 100), targetingType: targeting, ...(targeting === 'SMART' ? { maxCpcCents: Math.round(Number(maxCpcEur) * 100) } : {}) }),
        endDate: plan.derived.endDate,
        items: (plan.listings ?? []).map((l) => ({
          listingId: l.itemId,
          resolution: resolutions[l.itemId] ?? 'include',
          ...(effRate(l) != null ? { ratePct: effRate(l)! } : {}),
        })),
        rulePacks: [...packs],
        ...(!isCps && targeting === 'MANUAL' && seeds.some((s) => s.on)
          ? { keywords: seeds.filter((s) => s.on && s.text.trim()).map((s) => ({ text: s.text.trim(), matchType: s.matchType, bidCents: Math.round(Number(s.bidEur) * 100) })) }
          : {}),
        ...(overrideReason ? { override: { reason: overrideReason.trim() } } : {}),
      })
      setLaunched(out)
      setStep('done')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="h10-am">
      <AdsPageHeader
        title="New eBay campaign"
        subtitle="Pick a goal — everything else is derived from your economics, inspectable, and overridable."
        markets={EBAY_MARKETS.filter((m) => m.id !== 'all').map((m) => m.id)}
        market={market}
        onMarketChange={(m) => { setMarket(m); setStep('goal'); setPlan(null) }}
        showLearn={false} showDataSync={false} showDateRange={false}
      />
      <div style={{ display: 'flex', gap: 12 }}>
        <Link href="/marketing/ads/ebay/campaigns" className="eb-linkbtn"><ArrowLeft size={13} aria-hidden /> Back to eBay Ad Manager</Link>
      </div>
      <SandboxBanner mode={writeMode} />
      {error && <div className="h10-am-latest" role="alert"><b>Error:</b> {error}</div>}

      {step === 'goal' && (
        <div className="eb-goalgrid">
          {GOALS.map((g) => (
            <button key={g.key} type="button" className="eb-goalcard" disabled={busy || (market === 'EBAY_ES' && (g.key === 'hero' || g.key === 'defend'))} onClick={() => void pickGoal(g.key)}>
              <g.Icon size={20} aria-hidden className="ic" />
              <b>{g.title}</b>
              <p>{g.desc}</p>
              <span className="chips">{g.chips.map((c) => <span key={c} className="h10-pill arch">{c}</span>)}</span>
              {market === 'EBAY_ES' && (g.key === 'hero' || g.key === 'defend') && <span className="h10-pill warn">Priority unavailable on eBay Spain</span>}
            </button>
          ))}
        </div>
      )}

      {step === 'plan' && plan && (
        <>
          {/* Decisions panel (#3) */}
          <div className="h10-cd-card pad">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <span className="h10-pill ok">{plan.derived.label}</span>
              <span className="h10-pill arch">{plan.derived.strategy === 'CPS' ? 'General · fixed rate' : `Priority · ${targeting.toLowerCase()}`}</span>
              {plan.derived.endDate && <span className="h10-pill warn">ends {plan.derived.endDate}</span>}
              <span className="grow" style={{ flex: 1 }} />
              <span title={readiness.fixes.join('\n') || 'Ready'} style={{ fontSize: 12.5, fontWeight: 700, color: readiness.score >= 80 ? '#12855f' : readiness.score >= 50 ? '#b87503' : '#e5484d' }}>
                Launch readiness {readiness.score}/100
              </span>
            </div>
            <div className="eb-form-row">
              <div style={{ flex: 2 }}><label>Name (goal-strategy-scope-market-seq — editable)</label><input className="h10-cd-input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} /></div>
              {isCps ? (
                <div><label>Rate override — blank = per-listing computed</label><input className="h10-cd-input" style={{ width: 170 }} type="number" min={2} max={100} step={0.1} value={ratePct} onChange={(e) => setRatePct(e.target.value)} placeholder="per-listing" /></div>
              ) : (
                <>
                  <div><label>Daily budget €{plan.budget ? ' (suggested)' : ''}</label><input className="h10-cd-input" style={{ width: 100 }} type="number" min={1} step={0.5} value={budgetEur} onChange={(e) => setBudgetEur(e.target.value)} title={plan.budget?.formula} /></div>
                  <div><label>Targeting</label>
                    <select className="h10-cd-input" value={targeting} onChange={(e) => setTargeting(e.target.value as 'MANUAL' | 'SMART')}><option value="MANUAL">Manual (keywords after launch)</option><option value="SMART">Smart (eBay targets, irreversible)</option></select>
                  </div>
                  {targeting === 'SMART' && <div><label>Max CPC €</label><input className="h10-cd-input" style={{ width: 90 }} type="number" min={0.02} step={0.01} value={maxCpcEur} onChange={(e) => setMaxCpcEur(e.target.value)} /></div>}
                </>
              )}
            </div>
            {!isCps && plan.budget && <p className="eb-be-hint" style={{ marginTop: 6 }}>Budget provenance: <code>{plan.budget.formula}</code></p>}
            <div style={{ marginTop: 10 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#667085', marginBottom: 6 }}>Rule packs bound at launch (PROPOSE mode — item #10)</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {plan.derived.rulePacks.map((p) => (
                  <label key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#283441', border: '1px solid #d8dde4', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', background: packs.has(p) ? '#eef5ff' : '#fff' }}>
                    <input type="checkbox" checked={packs.has(p)} onChange={(e) => setPacks((s) => { const n = new Set(s); if (e.target.checked) n.add(p); else n.delete(p); return n })} />
                    {p}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Listings + collisions (#5, #6, #8) — CPS only */}
          {isCps && (
            <div className="h10-am-card">
              <div className="h10-am-toolbar"><span className="cnt">Will promote <b>{included.length}</b> of {plan.totals.listings} listings · trailing 30d sales {eur(plan.totals.trailingSales30dCents / 100)} · projected fees ≈ <b>{eur(forecast / 100)}</b>/month (any-click)</span></div>
              <div className="h10-am-grid" style={{ maxHeight: 420 }}>
                <table>
                  <thead><tr>
                    <th className="ed">Listing</th><th className="ed">Conflict</th><th className="num">Break-even</th><th className="num">Rate</th><th className="num">30d sales</th><th className="num">Fee forecast/mo</th>
                  </tr></thead>
                  <tbody>
                    {plan.listings.map((l) => {
                      const res = resolutions[l.itemId] ?? 'include'
                      const r = effRate(l)
                      const over = l.breakEvenPct != null && r != null && r > l.breakEvenPct
                      return (
                        <tr key={l.itemId} style={res === 'skip' ? { opacity: 0.45 } : undefined}>
                          <td className="ed"><div className="nmw"><span className="t" title={l.title ?? l.itemId}>{l.title ?? l.itemId}</span><span className="mk">{l.itemId.slice(-6)}</span></div></td>
                          <td className="ed">
                            {l.conflict ? (
                              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span className="h10-pill warn" title={`Already in "${l.conflict.campaignName}" at ${l.conflict.currentRatePct ?? '?'}%`}>in {l.conflict.campaignName.slice(0, 18)}</span>
                                <select className="h10-cd-input" value={res} onChange={(e) => setResolutions((s) => ({ ...s, [l.itemId]: e.target.value as 'include' | 'skip' | 'move' }))}>
                                  <option value="skip">skip</option><option value="move">move here</option><option value="include">include (will fail)</option>
                                </select>
                              </span>
                            ) : <span className="h10-pill ok">clear</span>}
                          </td>
                          <td className="num">{l.breakEvenPct != null ? pct(l.breakEvenPct / 100) : <span className="h10-pill warn">add cost</span>}</td>
                          <td className="num">
                            <input className="h10-cd-input" style={{ width: 74, borderColor: over ? '#e5484d' : undefined }} type="number" min={2} max={100} step={0.1}
                              value={perRate[l.itemId] ?? (ratePct !== '' ? ratePct : l.computedRatePct ?? '')}
                              title={l.rateSource}
                              onChange={(e) => setPerRate((s) => ({ ...s, [l.itemId]: e.target.value }))} />
                          </td>
                          <td className="num">{eur(l.trailingSales30dCents / 100)}</td>
                          <td className="num">{r != null ? eur(Math.round(l.trailingSales30dCents * (r / 100)) / 100) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Keyword seeds from OUR catalog data (#7) — CPC manual only */}
          {!isCps && targeting === 'MANUAL' && (
            <div className="h10-am-card">
              <div className="h10-am-toolbar">
                <span className="cnt">Keyword seeds — mined from your listing titles + item aspects (no eBay suggest API needed) · <b>{seeds.filter((s) => s.on).length}</b> selected</span>
                <span className="grow" style={{ flex: 1 }} />
                <input className="h10-cd-input" style={{ width: 220 }} placeholder="add your own keyword…" value={newSeed}
                  onChange={(e) => setNewSeed(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newSeed.trim()) { setSeeds((s) => [{ text: newSeed.trim(), source: 'MANUAL', matchType: 'PHRASE', bidEur: '0.30', on: true }, ...s]); setNewSeed('') } }} />
                <button type="button" className="h10-am-btn sm" disabled={!newSeed.trim()} onClick={() => { setSeeds((s) => [{ text: newSeed.trim(), source: 'MANUAL', matchType: 'PHRASE', bidEur: '0.30', on: true }, ...s]); setNewSeed('') }}>Add</button>
              </div>
              {seeds.length === 0 ? (
                <p className="eb-be-hint" style={{ padding: '10px 14px' }}>No seeds could be mined for this scope — add keywords above, or launch without and add them from the campaign's Keywords tab.</p>
              ) : (
                <div className="h10-am-grid" style={{ maxHeight: 300 }}>
                  <table>
                    <thead><tr><th className="ed">Keyword</th><th className="ed">Source</th><th className="ed">Match</th><th className="num">Bid €</th></tr></thead>
                    <tbody>
                      {seeds.map((s, i) => (
                        <tr key={`${s.text}-${i}`} style={s.on ? undefined : { opacity: 0.45 }}>
                          <td className="ed">
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                              <input type="checkbox" checked={s.on} onChange={(e) => setSeeds((all) => all.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                              <span className="t">{s.text}</span>
                            </label>
                          </td>
                          <td className="ed"><span className={`h10-pill ${s.source === 'MANUAL' ? 'ok' : 'arch'}`}>{s.source === 'ASPECT/FREQUENT' ? 'aspects' : s.source.toLowerCase()}</span></td>
                          <td className="ed">
                            <select className="h10-cd-input" value={s.matchType} onChange={(e) => setSeeds((all) => all.map((x, j) => (j === i ? { ...x, matchType: e.target.value as Seed['matchType'] } : x)))}>
                              <option value="PHRASE">Phrase</option><option value="EXACT">Exact</option><option value="BROAD">Broad</option>
                            </select>
                          </td>
                          <td className="num"><input className="h10-cd-input" style={{ width: 70 }} type="number" min={0.05} step={0.05} value={s.bidEur} onChange={(e) => setSeeds((all) => all.map((x, j) => (j === i ? { ...x, bidEur: e.target.value } : x)))} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Preflight (#22) */}
          <div className="h10-cd-card pad">
            {blocking.length > 0 && <ul className="eb-results">{blocking.map((b2) => <li key={b2} className="err">{b2}</li>)}</ul>}
            {advisory.length > 0 && (
              <ul className="eb-results">
                {advisory.map((a) => (
                  <li key={a.key} className="warn">
                    {a.text}{a.key !== 'forecast' && (
                      <label style={{ marginLeft: 8, fontSize: 11.5 }}>
                        <input type="checkbox" checked={ack.has(a.key)} onChange={(e) => setAck((s) => { const n = new Set(s); if (e.target.checked) n.add(a.key); else n.delete(a.key); return n })} /> acknowledge
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, color: '#5b6573' }}>
                Will create: <b>1 campaign</b>{isCps ? <>, <b>{included.length} ads</b></> : null}{!isCps && targeting === 'MANUAL' && seeds.some((s) => s.on) ? <>, <b>1 ad group + {seeds.filter((s) => s.on).length} keywords</b></> : null}, <b>{packs.size} rule binding(s)</b>
              </span>
              <span className="grow" style={{ flex: 1 }} />
              <button type="button" className="h10-am-btn" onClick={() => { setStep('goal'); setPlan(null) }}>Back</button>
              <button type="button" className="h10-am-btn primary" disabled={busy || blocking.length > 0 || unacked.length > 0} onClick={() => void launch()}>
                {busy ? 'Launching…' : 'Launch campaign'}
              </button>
            </div>
          </div>
        </>
      )}

      {step === 'done' && launched && (
        <div className="h10-cd-card pad" style={{ maxWidth: 720 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <CheckCircle2 size={18} color="#12855f" aria-hidden />
            <b style={{ fontSize: 15 }}>Campaign launched ({launched.mode})</b>
          </div>
          {launched.promoteResults?.some((r) => !r.ok) && (
            <ul className="eb-results">{launched.promoteResults.filter((r) => !r.ok).map((r, i) => <li key={i} className="err"><code>{r.key}</code> — {r.blocked ?? r.error}</li>)}</ul>
          )}
          {launched.keywordResults?.some((r) => !r.ok) && (
            <ul className="eb-results">{launched.keywordResults.filter((r) => !r.ok).map((r, i) => <li key={`kw-${i}`} className="err">keyword <code>{r.key}</code> — {r.blocked ?? r.error}</li>)}</ul>
          )}
          <p style={{ fontSize: 12, color: '#667085', margin: '8px 0 4px', fontWeight: 700, textTransform: 'uppercase' }}>What happens next</p>
          <ul className="eb-results">{launched.timeline.map((t, i) => <li key={i} className="ok">{t}</li>)}</ul>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="h10-am-btn primary" onClick={() => router.push(`/marketing/ads/ebay/campaigns/${launched.campaignId}`)}>Open campaign</button>
            <button type="button" className="h10-am-btn" onClick={() => { setStep('goal'); setPlan(null); setLaunched(null) }}>Launch another</button>
          </div>
        </div>
      )}
    </div>
  )
}
