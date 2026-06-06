'use client'

/**
 * RD.9 / RD.10 — Rank Director: product-FAMILY rank + dayparting authoring.
 *
 * Pick a PRODUCT → see the whole variation family's by-hour demand (per market,
 * even from a one-ASIN campaign) → assign rank targets to time windows (dayparting
 * + rank goals FUSED) → ONE plan drives EVERY campaign advertising the family.
 * Save persists the plan; the defend loop actuates it across all family campaigns
 * (gated). RD.10 adds the live preview, the family campaign list, and the arm /
 * apply-now / revert controls.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crosshair, Plus, Trash2, Save, Undo2, Wand2, Package, ShieldCheck, Power, Play, RotateCcw, Info, Copy } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { DemandReadout, type DemandProfile, type DemandCell } from './DemandReadout'
import { RankTimeGrid } from './RankTimeGrid'
import { RankTargetEditor } from './RankTargetEditor'

interface RankTarget { id: string; key: string; name: string; targetISPct: number | null; acosCapPct: number | null; pause: boolean; allOut: boolean; color: string | null }
interface Win { days: number[]; startHour: number; endHour: number; targetKey?: string }
interface Plan { id: string; productId: string; parentAsin: string | null; marketplace: string; windows: Win[]; defaultTargetKey: string | null; familyDailyBudgetCents: number | null; familyAcosCapPct: number | null; maxCampaigns: number | null; leadTimeMinutes: number; excludeCampaignIds?: string[]; targetOverrides?: Record<string, { biasPct?: number; targetISPct?: number; acosCapPct?: number; maxCpcCents?: number }>; enabled: boolean; manualOnly: boolean }
interface Product { productId: string; name: string; parentAsin?: string | null; campaignCount?: number }
interface Fam { parentName: string | null; campaignCount: number; demand: { grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[]; hasData: boolean; familyOrders: number }; smoothed?: { grid: DemandCell[][]; hourProfile: DemandProfile[]; weekdayProfile: DemandProfile[] }; recommended: { windows: Win[]; baselineTargetKey: string; peakHours: number[] } }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`
// RD.12 — delivery recency helpers (distinguish "running recently" from "paused long ago").
const recentlyDelivered = (iso: string | null | undefined, days: number) => { if (!iso) return false; return Date.now() - new Date(iso).getTime() <= days * 86400000 }
const recencyLabel = (iso: string | null | undefined, cents?: number) => {
  if (!iso) return 'no recent delivery'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  const when = d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`
  return cents && cents > 0 ? `ran ${when} · €${(cents / 100).toFixed(0)}/30d` : `ran ${when}`
}

export function RankDirectorPanel({ market, productId, onPickProduct }: { market: string; productId: string; onPickProduct: (id: string) => void }) {
  const [products, setProducts] = useState<Product[]>([])
  const [targets, setTargets] = useState<RankTarget[]>([])
  const [fam, setFam] = useState<Fam | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loadingFam, setLoadingFam] = useState(false)
  const [demandDays, setDemandDays] = useState(180) // chosen timeframe for the heatmap data
  const [smooth, setSmooth] = useState(false) // false = RAW actual sales (default); true = market-smoothed
  // working draft
  const [baseline, setBaseline] = useState('')
  const [windows, setWindows] = useState<Win[]>([])
  const [winView, setWinView] = useState<'grid' | 'list'>('grid') // RG.3 — paint grid (default) vs precise list
  const [budget, setBudget] = useState('')   // euros (familyDailyBudgetCents/100)
  const [acosCap, setAcosCap] = useState('')
  const [maxCamp, setMaxCamp] = useState('')
  const [lead, setLead] = useState('15')
  const [excludeIds, setExcludeIds] = useState<Set<string>>(() => new Set()) // RD.12 — campaigns excluded from this plan
  // server snapshot for dirty tracking
  const [srv, setSrv] = useState<{ baseline: string; windows: Win[]; budget: string; acosCap: string; maxCamp: string; lead: string; exclude: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // RD.10 — live preview + family detail + arm/apply controls (once a plan exists)
  const [preview, setPreview] = useState<{ decisions: Array<{ campaignId: string; action: string; nextPct: number }>; selfCompetition?: Array<{ on: string; demoted: string[] }> } | null>(null)
  const [famDetail, setFamDetail] = useState<{ campaigns: Array<{ id: string; name: string; status: string; attributionPct: number | null; readiness: { verdict: string } | null; excluded?: boolean; lastDeliveredAt?: string | null; recentSpendCents?: number }>; attribution: { overallPct: number | null } } | null>(null)
  const [arming, setArming] = useState(false)
  const [armMsg, setArmMsg] = useState('')
  // RG.4 — copy this painted schedule onto other products' plans (bulk across products)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copySel, setCopySel] = useState<Set<string>>(() => new Set())
  const [copyBusy, setCopyBusy] = useState(false)
  const [copyMsg, setCopyMsg] = useState('')
  const doCopy = async () => {
    const toProductIds = [...copySel]
    if (!toProductIds.length) return
    setCopyBusy(true); setCopyMsg('')
    try {
      const r = await fetch(api('/rank-plans/copy-schedule'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows, defaultTargetKey: baseline || null, toProductIds, marketplace: market }) }).then(x => x.json())
      if (r?.ok) { setCopyMsg(`Applied to ${r.applied} product(s) — ${r.created} new, ${r.updated} updated. Saved but not armed.`); setCopySel(new Set()) }
      else setCopyMsg(r?.error || 'Copy failed')
    } catch { setCopyMsg('Copy failed') } finally { setCopyBusy(false) }
  }

  // product list (once per market)
  useEffect(() => {
    fetch(api(`/by-product?marketplace=${market}`), { cache: 'no-store' }).then(r => r.json())
      .then(j => setProducts((j.rows || j.items || []).map((r: Record<string, unknown>) => ({ productId: (r.productId || r.id) as string, name: (r.name || r.title || '') as string, parentAsin: r.parentAsin as string, campaignCount: r.campaignCount as number }))))
      .catch(() => {})
  }, [market])
  // RTC — rank targets, scope-aware (global ∪ this product's custom swatches); refetchable.
  const loadTargets = useCallback(() => {
    fetch(api(`/rank-targets${productId ? `?productId=${productId}` : ''}`), { cache: 'no-store' }).then(r => r.json()).then(j => setTargets(j.items || [])).catch(() => {})
  }, [productId])
  useEffect(() => { loadTargets() }, [loadTargets])
  const [editorOpen, setEditorOpen] = useState(false)

  // RD.10c — family demand over the chosen timeframe (separate effect so changing
  // the timeframe doesn't reload the plan / reset unsaved edits).
  useEffect(() => {
    if (!productId) { setFam(null); return }
    setLoadingFam(true)
    fetch(api(`/by-product/family-dayparting?productId=${productId}&marketplace=${market}&windowDays=${demandDays}`), { cache: 'no-store' }).then(r => r.json()).then(setFam).catch(() => setFam(null)).finally(() => setLoadingFam(false))
  }, [productId, market, demandDays])

  // on product change: existing plan + draft
  useEffect(() => {
    if (!productId) { setPlan(null); setSrv(null); return }
    fetch(api(`/rank-plans?marketplace=${market}`), { cache: 'no-store' }).then(r => r.json()).then(j => {
      const p: Plan | null = (j.items || []).find((x: Plan) => x.productId === productId) || null
      setPlan(p)
      const b = p?.defaultTargetKey || '', w = (p?.windows || []).filter((x: Win) => x.targetKey)
      const bud = p?.familyDailyBudgetCents != null ? String(p.familyDailyBudgetCents / 100) : ''
      const ac = p?.familyAcosCapPct != null ? String(p.familyAcosCapPct) : ''
      const mc = p?.maxCampaigns != null ? String(p.maxCampaigns) : ''
      const ld = p?.leadTimeMinutes != null ? String(p.leadTimeMinutes) : '15'
      const ex = Array.isArray(p?.excludeCampaignIds) ? (p!.excludeCampaignIds as string[]) : []
      setBaseline(b); setWindows(w); setBudget(bud); setAcosCap(ac); setMaxCamp(mc); setLead(ld); setExcludeIds(new Set(ex))
      setSrv({ baseline: b, windows: w, budget: bud, acosCap: ac, maxCamp: mc, lead: ld, exclude: JSON.stringify([...ex].sort()) })
    }).catch(() => {})
  }, [productId, market])

  // RD.10 — live preview (what the loop would do now) + family detail (attribution
  // health + readiness), refreshed whenever the saved plan changes.
  const reloadLive = useCallback(() => {
    if (!plan?.id) { setPreview(null); setFamDetail(null); return }
    fetch(api(`/rank-plans/${plan.id}/run-now?dryRun=1`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json()).then(j => setPreview((j.plans || [])[0] ?? null)).catch(() => {})
    fetch(api(`/rank-plans/${plan.id}/family`), { cache: 'no-store' }).then(r => r.json()).then(setFamDetail).catch(() => {})
  }, [plan?.id])
  useEffect(() => { reloadLive() }, [reloadLive])

  const excludeKey = JSON.stringify([...excludeIds].sort())
  const dirty = srv ? (baseline !== srv.baseline || JSON.stringify(windows) !== JSON.stringify(srv.windows) || budget !== srv.budget || acosCap !== srv.acosCap || maxCamp !== srv.maxCamp || lead !== srv.lead || excludeKey !== srv.exclude) : (!!baseline || windows.length > 0)

  const addWindow = () => setWindows(w => [...w, { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: targets.find(t => !t.pause)?.key }])
  const setWin = (i: number, patch: Partial<Win>) => setWindows(w => w.map((x, j) => j === i ? { ...x, ...patch } : x))
  const toggleDay = (i: number, d: number) => setWindows(w => w.map((x, j) => j === i ? { ...x, days: x.days.includes(d) ? x.days.filter(y => y !== d) : [...x.days, d].sort() } : x))
  const removeWin = (i: number) => setWindows(w => w.filter((_, j) => j !== i))
  const useRecommended = () => { if (!fam) return; setWindows(fam.recommended.windows.map(w => ({ ...w }))); if (fam.recommended.baselineTargetKey) setBaseline(fam.recommended.baselineTargetKey) }

  const save = async () => {
    if (!productId) return
    setBusy(true); setMsg('')
    const body = {
      windows, defaultTargetKey: baseline || null,
      familyDailyBudgetCents: budget ? Math.round(Number(budget) * 100) : null,
      familyAcosCapPct: acosCap ? Number(acosCap) : null,
      maxCampaigns: maxCamp ? Number(maxCamp) : null,
      leadTimeMinutes: lead ? Number(lead) : 0,
      excludeCampaignIds: [...excludeIds],
    }
    try {
      const sel = products.find(p => p.productId === productId)
      const r = plan
        ? await fetch(api(`/rank-plans/${plan.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
        : await fetch(api('/rank-plans'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, marketplace: market, parentAsin: sel?.parentAsin ?? null, ...body }) }).then(x => x.json())
      if (r?.id) { setPlan(r); setSrv({ baseline, windows, budget, acosCap, maxCamp, lead, exclude: JSON.stringify([...excludeIds].sort()) }); setMsg('Saved — the rank plan is stored. Arm it (next) to let the loop hold rank across all family campaigns automatically.') }
      else setMsg('Could not save — try again.')
    } finally { setBusy(false) }
  }
  const discard = () => { if (!srv) return; setBaseline(srv.baseline); setWindows(srv.windows.map(w => ({ ...w }))); setBudget(srv.budget); setAcosCap(srv.acosCap); setMaxCamp(srv.maxCamp); setLead(srv.lead); setExcludeIds(new Set(JSON.parse(srv.exclude) as string[])) }

  // RD.10 — arm / manual / apply-now / revert. Apply-now + revert are real (gated)
  // pushes across the family; the loop also runs them automatically once armed.
  const setManual = async (v: boolean) => { if (!plan) return; const r = await fetch(api(`/rank-plans/${plan.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualOnly: v }) }).then(x => x.json()); setPlan(r) }
  const armToggle = async () => { if (!plan) return; setArming(true); setArmMsg(''); try { const r = await fetch(api(`/rank-plans/${plan.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !plan.enabled }) }).then(x => x.json()); setPlan(r); setArmMsg(r.enabled ? 'Armed — the loop now holds rank automatically across the family (gated).' : 'Disarmed — the loop no longer acts on this plan.') } finally { setArming(false) } }
  const applyNow = async () => { if (!plan) return; setArming(true); setArmMsg(''); try { const r = await fetch(api(`/rank-plans/${plan.id}/run-now`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json()); setArmMsg(`Applied now — ${r.applied ?? 0} change(s) pushed (write-gate honoured).`); reloadLive() } finally { setArming(false) } }
  const revertAll = async () => { if (!plan) return; setArming(true); setArmMsg(''); try { const r = await fetch(api(`/rank-plans/${plan.id}/revert`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json()); setArmMsg(`Reverted ${r.reverted ?? 0} campaign(s) to baseline.`); reloadLive() } finally { setArming(false) } }

  const selName = useMemo(() => products.find(p => p.productId === productId)?.name ?? '', [products, productId])

  return (
    <div className="az-rd">
      {/* Step 1 — pick a product */}
      <div className="az-rd-pick">
        <span className="lbl"><Package size={14} /> Product</span>
        <select value={productId} onChange={e => onPickProduct(e.target.value)} aria-label="Pick a product">
          <option value="">Select a product…</option>
          {products.map(p => <option key={p.productId} value={p.productId}>{p.name.slice(0, 60)}{p.campaignCount ? ` · ${p.campaignCount} campaigns` : ''}</option>)}
        </select>
        {plan && <span className="az-rd-haveplan"><ShieldCheck size={12} /> has a plan</span>}
      </div>

      {!productId ? (
        <div className="az-rd-empty">Pick a product to manage rank across <b>all its campaigns</b> at once. You&apos;ll see when the whole variation family actually sells, then hold the top slot during those hours.</div>
      ) : loadingFam ? (
        <div className="az-rd-empty">Loading the family&apos;s demand…</div>
      ) : (
        <>
          {/* Family + demand heatmap */}
          <div className="az-rd-fam">
            <span className="t"><Crosshair size={14} /> {fam?.parentName?.slice(0, 48) ?? selName.slice(0, 48)}</span>
            <span className="sub">{fam?.campaignCount ?? 0} campaigns · <b>{fam?.demand.familyOrders ?? 0} actual orders</b> · {demandDays}d</span>
            <span className="grow" />
            {fam?.smoothed && <label className="az-rp-smooth" title="Sparse product? Smooth toward the market's overall pattern. Off = your real sales."><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)} /> smooth</label>}
            <select className="az-rp-tf" value={demandDays} onChange={e => setDemandDays(Number(e.target.value))} aria-label="Demand timeframe" title="Timeframe for the demand data">{[7, 14, 30, 60, 90, 180].map(d => <option key={d} value={d}>last {d}d</option>)}</select>
            <button type="button" className="az-btn" onClick={useRecommended} disabled={!fam?.recommended?.windows?.length}><Wand2 size={13} /> Use recommended windows</button>
          </div>
          {fam?.demand?.hasData ? (() => { const dv = smooth && fam.smoothed ? fam.smoothed : fam.demand; return <DemandReadout grid={dv.grid} hourProfile={dv.hourProfile} weekdayProfile={dv.weekdayProfile} /> })() : <div className="az-rd-empty">Not enough order history to show a demand shape yet.</div>}

          {/* Baseline */}
          <div className="az-rp-sec">
            <div className="az-rp-lbl">Baseline — the rest of the week, hold:</div>
            <div className="az-rp-chips">
              {targets.map(t => <button key={t.key} type="button" className={`az-rp-chip ${baseline === t.key ? 'on' : ''}`} style={baseline === t.key && t.color ? { borderColor: t.color, boxShadow: `0 0 0 1px ${t.color} inset` } : undefined} onClick={() => setBaseline(baseline === t.key ? '' : t.key)}>
                <span className="sw" style={{ background: t.color ?? '#999' }} />{t.name}{t.allOut && <span className="ao">ALL-OUT</span>}
              </button>)}
            </div>
          </div>

          {/* Windows */}
          <div className="az-rp-sec">
            <div className="az-rp-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>During these windows, hold a different rank:<span className="grow" />
              <span className="az-mode-seg az-scope-seg" role="tablist" aria-label="Window editor view" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                <button type="button" role="tab" aria-selected={winView === 'grid'} className={winView === 'grid' ? 'on' : ''} onClick={() => setWinView('grid')}>Grid</button>
                <button type="button" role="tab" aria-selected={winView === 'list'} className={winView === 'list' ? 'on' : ''} onClick={() => setWinView('list')}>List</button>
              </span>
              {winView === 'list' && <button type="button" className="az-link" onClick={addWindow}><Plus size={12} /> Add window</button>}
            </div>
            {winView === 'grid' ? (
              <RankTimeGrid windows={windows} onWindowsChange={setWindows} targets={targets} baselineKey={baseline} demandGrid={(smooth && fam?.smoothed ? fam.smoothed : fam?.demand)?.grid ?? null} onUseDemandPeaks={fam?.recommended?.windows?.length ? useRecommended : undefined} onEditTargets={() => setEditorOpen(true)} />
            ) : (<>
              {windows.length === 0 && <div className="az-rp-empty">No windows — the baseline holds all week. Add one (or use the recommended) to push the top slot during peak hours.</div>}
              {windows.map((w, i) => (
                <div key={i} className="az-rp-win">
                  <div className="days">{DAYS.map((d, di) => <button key={di} type="button" className={w.days.includes(di) ? 'on' : ''} onClick={() => toggleDay(i, di)}>{d[0]}</button>)}</div>
                  <select value={w.startHour} onChange={e => setWin(i, { startHour: Number(e.target.value) })} aria-label="Start hour">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</select>
                  <span className="to">to</span>
                  <select value={w.endHour} onChange={e => setWin(i, { endHour: Number(e.target.value) })} aria-label="End hour">{Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hh(h % 24)}{h === 24 ? ' (24)' : ''}</option>)}</select>
                  <span className="arrow">→</span>
                  <select value={w.targetKey ?? ''} onChange={e => setWin(i, { targetKey: e.target.value })} aria-label="Rank target">{targets.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select>
                  <span className="grow" />
                  <button type="button" className="az-kebab" onClick={() => removeWin(i)} style={{ color: '#cc1100' }} aria-label="Remove window"><Trash2 size={13} /></button>
                </div>
              ))}
            </>)}
          </div>

          {/* Family guardrails */}
          <div className="az-rp-sec">
            <div className="az-rp-lbl">Family guardrails (shared across all {fam?.campaignCount ?? 0} campaigns):</div>
            <div className="az-rd-guards">
              <label>Daily budget cap <span>€</span><input type="number" min="0" value={budget} onChange={e => setBudget(e.target.value)} placeholder="none" /></label>
              <label>ACOS cap <input type="number" min="0" value={acosCap} onChange={e => setAcosCap(e.target.value)} placeholder="none" /><span>%</span></label>
              <label>Max campaigns <input type="number" min="1" value={maxCamp} onChange={e => setMaxCamp(e.target.value)} placeholder="none" /></label>
              <label>Lead-time <input type="number" min="0" value={lead} onChange={e => setLead(e.target.value)} /><span>min</span></label>
            </div>
          </div>

          {/* Save / Discard */}
          <div className="az-rd-foot">
            {dirty && <span className="az-rp-dirty">Unsaved</span>}
            <button type="button" className="az-btn" disabled={!windows.length} onClick={() => { setCopyMsg(''); setCopySel(new Set()); setCopyOpen(true) }} title="Copy this week's rank schedule onto other products' plans"><Copy size={13} /> Copy to products…</button>
            <span className="grow" />
            <button type="button" className="az-btn" disabled={!dirty || busy} onClick={discard}><Undo2 size={13} /> Discard</button>
            <button type="button" className="az-btn dark" disabled={!dirty || busy} onClick={() => void save()}><Save size={13} /> {busy ? 'Saving…' : plan ? 'Save plan' : 'Create plan'}</button>
          </div>
          {msg && <div className="az-rp-msg">{msg}</div>}
          <div className="az-rp-note">Saving stores the plan in Nexus. One plan drives every campaign advertising this product family — winners hold the slot during your windows, redundant campaigns fall to the baseline (no self-competition), and OOS / over-budget / over-ACOS are guarded automatically. Real Amazon pushes still honour the write-gate.</div>

          {/* RD.10 — live preview + family campaign list + arm / apply controls */}
          {plan && (
            <div className="az-rp-sec az-rd-live">
              <div className="az-rp-lbl">This plan controls {(famDetail?.campaigns ?? []).filter(c => !excludeIds.has(c.id)).length} of {famDetail?.campaigns?.length ?? fam?.campaignCount ?? 0} campaigns{famDetail?.attribution?.overallPct != null ? ` · ${famDetail.attribution.overallPct}% attribution health` : ''}:</div>
              <div className="az-rd-arm">
                <button type="button" className={`az-rp-defend ${plan.enabled ? 'on' : ''}`} onClick={() => void armToggle()} disabled={arming} title="When ON, the loop continuously holds this plan across the family on its cadence"><Power size={12} /> Fully automatic {plan.enabled ? 'ON' : 'OFF'}</button>
                <label className="az-rd-manual"><input type="checkbox" checked={plan.manualOnly} onChange={e => void setManual(e.target.checked)} /> Manual only</label>
                <span className="grow" />
                <button type="button" className="az-btn" onClick={() => void applyNow()} disabled={arming}><Play size={12} /> Apply now</button>
                <button type="button" className="az-btn" onClick={() => void revertAll()} disabled={arming}><RotateCcw size={12} /> Revert all</button>
              </div>
              {armMsg && <div className="az-rp-msg">{armMsg}</div>}
              {preview?.selfCompetition && preview.selfCompetition.length > 0 && (
                <div className="az-cr-note"><Info size={12} /> {preview.selfCompetition.length} self-competition contest(s) found — redundant campaigns are auto-demoted to the baseline so you don&apos;t outbid yourself.</div>
              )}
              {famDetail && famDetail.campaigns.length > 0 && (<>
                <div className="az-rd-scopebar">
                  <span className="lbl">Untick a campaign to exclude it from this plan:</span>
                  <span className="grow" />
                  <button type="button" className="az-tr-mini" onClick={() => setExcludeIds(new Set())} title="Control every campaign in the family">Include all</button>
                  <button type="button" className="az-tr-mini" onClick={() => setExcludeIds(new Set(famDetail.campaigns.filter(c => c.status !== 'ENABLED').map(c => c.id)))} title="Exclude every paused / archived campaign">Active only</button>
                  <button type="button" className="az-tr-mini" onClick={() => setExcludeIds(new Set(famDetail.campaigns.filter(c => !recentlyDelivered(c.lastDeliveredAt, 7)).map(c => c.id)))} title="Keep only campaigns that delivered in the last 7 days">Delivered ≤7d</button>
                  {dirty && <button type="button" className="az-btn dark sm" disabled={busy} onClick={() => void save()}><Save size={12} /> {busy ? 'Saving…' : 'Save scope'}</button>}
                </div>
                <div className="az-rd-camps" style={{ maxHeight: 360, overflowY: 'auto' }}>
                  {famDetail.campaigns.map(c => {
                    const dec = preview?.decisions.find(d => d.campaignId === c.id)
                    const inc = !excludeIds.has(c.id)
                    return (
                      <label key={c.id} className={`az-rd-camp scope ${inc ? '' : 'excl'}`}>
                        <input type="checkbox" checked={inc} onChange={() => setExcludeIds(s => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })} />
                        <span className="st" style={{ color: c.status === 'ENABLED' ? undefined : '#94a3b8' }}>{c.status === 'ENABLED' ? '●' : '○'}</span>
                        <span className="nm" title={c.name}>{c.name}</span>
                        <span className="rec">{recencyLabel(c.lastDeliveredAt, c.recentSpendCents)}</span>
                        <span className="grow" />
                        {c.readiness && c.readiness.verdict !== 'ok' && <span className={`vd ${c.readiness.verdict}`}>{c.readiness.verdict}</span>}
                        {inc && dec && <span className="dec">{dec.action === 'pause' ? 'Min bid' : dec.action}{dec.action === 'raise' || dec.action === 'lower' ? ` → ${dec.nextPct}%` : ''}</span>}
                      </label>
                    )
                  })}
                </div>
                <div className="az-rp-note" style={{ marginTop: 6 }}>Unticked campaigns are left alone by this plan — never held, counted, or reverted. New campaigns for this family are auto-included.</div>
              </>)}
            </div>
          )}
        </>
      )}

      {copyOpen && (
        <div className="az-rd-copymodal" role="dialog" aria-modal="true" aria-label="Copy schedule to other products" onClick={() => setCopyOpen(false)}>
          <div className="box" onClick={e => e.stopPropagation()}>
            <div className="hd"><Copy size={14} /> Copy this schedule to other products<span className="grow" /><button type="button" className="az-kebab" onClick={() => setCopyOpen(false)} aria-label="Close">✕</button></div>
            <div className="sub">Applies the painted windows + baseline to each selected product&apos;s plan in {market} (creates a disabled plan where none exists). Guardrails and armed state are left untouched.</div>
            <div className="list">
              {products.filter(p => p.productId !== productId).map(p => {
                const on = copySel.has(p.productId)
                return (
                  <label key={p.productId} className={`row ${on ? 'on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => setCopySel(s => { const n = new Set(s); if (n.has(p.productId)) n.delete(p.productId); else n.add(p.productId); return n })} />
                    <span className="nm" title={p.name}>{p.name || p.parentAsin || p.productId}</span>
                    <span className="cc">{p.campaignCount ?? 0} camp</span>
                  </label>
                )
              })}
              {products.filter(p => p.productId !== productId).length === 0 && <div className="az-rp-empty">No other products in {market}.</div>}
            </div>
            {copyMsg && <div className="az-rp-msg" style={{ margin: '0 15px' }}>{copyMsg}</div>}
            <div className="ft">
              <span className="cnt">{copySel.size} selected</span>
              <span className="grow" />
              <button type="button" className="az-btn" onClick={() => setCopyOpen(false)}>Close</button>
              <button type="button" className="az-btn dark" disabled={!copySel.size || copyBusy} onClick={() => void doCopy()}>{copyBusy ? 'Copying…' : `Copy to ${copySel.size || 0} product${copySel.size === 1 ? '' : 's'}`}</button>
            </div>
          </div>
        </div>
      )}

      <RankTargetEditor
        open={editorOpen}
        onClose={(c) => { setEditorOpen(false); if (c) { loadTargets(); reloadLive() } }}
        scopeKind="product"
        scopeLabel={selName || 'this product'}
        scopeOverrides={(plan?.targetOverrides as Record<string, { biasPct?: number; targetISPct?: number; acosCapPct?: number; maxCpcCents?: number }>) ?? {}}
        onSaveScopeOverrides={plan ? async (map) => { const r = await fetch(api(`/rank-plans/${plan.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetOverrides: map }) }).then(x => x.json()); setPlan(r) } : undefined}
        productId={productId}
      />
    </div>
  )
}
