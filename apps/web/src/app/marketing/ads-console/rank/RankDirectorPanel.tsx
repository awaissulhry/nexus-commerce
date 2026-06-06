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

import { useEffect, useMemo, useState } from 'react'
import { Crosshair, Plus, Trash2, Save, Undo2, Wand2, Package, ShieldCheck } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { DemandHeatmap, type HeatCell } from '../automation/DemandHeatmap'

interface RankTarget { id: string; key: string; name: string; targetISPct: number | null; acosCapPct: number | null; pause: boolean; allOut: boolean; color: string | null }
interface Win { days: number[]; startHour: number; endHour: number; targetKey?: string }
interface Plan { id: string; productId: string; parentAsin: string | null; marketplace: string; windows: Win[]; defaultTargetKey: string | null; familyDailyBudgetCents: number | null; familyAcosCapPct: number | null; maxCampaigns: number | null; leadTimeMinutes: number; enabled: boolean; manualOnly: boolean }
interface Product { productId: string; name: string; parentAsin?: string | null; campaignCount?: number }
interface Fam { parentName: string | null; campaignCount: number; demand: { grid: HeatCell[][]; hasData: boolean; familyOrders: number }; recommended: { windows: Win[]; baselineTargetKey: string; peakHours: number[] } }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`

export function RankDirectorPanel({ market, productId, onPickProduct }: { market: string; productId: string; onPickProduct: (id: string) => void }) {
  const [products, setProducts] = useState<Product[]>([])
  const [targets, setTargets] = useState<RankTarget[]>([])
  const [fam, setFam] = useState<Fam | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loadingFam, setLoadingFam] = useState(false)
  // working draft
  const [baseline, setBaseline] = useState('')
  const [windows, setWindows] = useState<Win[]>([])
  const [budget, setBudget] = useState('')   // euros (familyDailyBudgetCents/100)
  const [acosCap, setAcosCap] = useState('')
  const [maxCamp, setMaxCamp] = useState('')
  const [lead, setLead] = useState('15')
  // server snapshot for dirty tracking
  const [srv, setSrv] = useState<{ baseline: string; windows: Win[]; budget: string; acosCap: string; maxCamp: string; lead: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // product list + rank targets (once per market)
  useEffect(() => {
    fetch(api(`/by-product?marketplace=${market}`), { cache: 'no-store' }).then(r => r.json())
      .then(j => setProducts((j.rows || j.items || []).map((r: Record<string, unknown>) => ({ productId: (r.productId || r.id) as string, name: (r.name || r.title || '') as string, parentAsin: r.parentAsin as string, campaignCount: r.campaignCount as number }))))
      .catch(() => {})
    fetch(api('/rank-targets'), { cache: 'no-store' }).then(r => r.json()).then(j => setTargets(j.items || [])).catch(() => {})
  }, [market])

  // on product change: family dayparting + existing plan
  useEffect(() => {
    if (!productId) { setFam(null); setPlan(null); setSrv(null); return }
    setLoadingFam(true)
    fetch(api(`/by-product/family-dayparting?productId=${productId}&marketplace=${market}`), { cache: 'no-store' }).then(r => r.json()).then(setFam).catch(() => setFam(null)).finally(() => setLoadingFam(false))
    fetch(api(`/rank-plans?marketplace=${market}`), { cache: 'no-store' }).then(r => r.json()).then(j => {
      const p: Plan | null = (j.items || []).find((x: Plan) => x.productId === productId) || null
      setPlan(p)
      const b = p?.defaultTargetKey || '', w = (p?.windows || []).filter((x: Win) => x.targetKey)
      const bud = p?.familyDailyBudgetCents != null ? String(p.familyDailyBudgetCents / 100) : ''
      const ac = p?.familyAcosCapPct != null ? String(p.familyAcosCapPct) : ''
      const mc = p?.maxCampaigns != null ? String(p.maxCampaigns) : ''
      const ld = p?.leadTimeMinutes != null ? String(p.leadTimeMinutes) : '15'
      setBaseline(b); setWindows(w); setBudget(bud); setAcosCap(ac); setMaxCamp(mc); setLead(ld)
      setSrv({ baseline: b, windows: w, budget: bud, acosCap: ac, maxCamp: mc, lead: ld })
    }).catch(() => {})
  }, [productId, market])

  const dirty = srv ? (baseline !== srv.baseline || JSON.stringify(windows) !== JSON.stringify(srv.windows) || budget !== srv.budget || acosCap !== srv.acosCap || maxCamp !== srv.maxCamp || lead !== srv.lead) : (!!baseline || windows.length > 0)

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
    }
    try {
      const sel = products.find(p => p.productId === productId)
      const r = plan
        ? await fetch(api(`/rank-plans/${plan.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
        : await fetch(api('/rank-plans'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, marketplace: market, parentAsin: sel?.parentAsin ?? null, ...body }) }).then(x => x.json())
      if (r?.id) { setPlan(r); setSrv({ baseline, windows, budget, acosCap, maxCamp, lead }); setMsg('Saved — the rank plan is stored. Arm it (next) to let the loop hold rank across all family campaigns automatically.') }
      else setMsg('Could not save — try again.')
    } finally { setBusy(false) }
  }
  const discard = () => { if (!srv) return; setBaseline(srv.baseline); setWindows(srv.windows.map(w => ({ ...w }))); setBudget(srv.budget); setAcosCap(srv.acosCap); setMaxCamp(srv.maxCamp); setLead(srv.lead) }

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
            <span className="sub">{fam?.campaignCount ?? 0} campaigns · {fam?.demand.familyOrders ?? 0} family orders</span>
            <span className="grow" />
            <button type="button" className="az-btn" onClick={useRecommended} disabled={!fam?.recommended?.windows?.length}><Wand2 size={13} /> Use recommended windows</button>
          </div>
          {fam?.demand?.hasData ? <DemandHeatmap grid={fam.demand.grid} /> : <div className="az-rd-empty">Not enough order history to show a demand shape yet.</div>}

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
            <div className="az-rp-lbl">During these windows, hold a different rank: <button type="button" className="az-link" onClick={addWindow}><Plus size={12} /> Add window</button></div>
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
            <span className="grow" />
            <button type="button" className="az-btn" disabled={!dirty || busy} onClick={discard}><Undo2 size={13} /> Discard</button>
            <button type="button" className="az-btn dark" disabled={!dirty || busy} onClick={() => void save()}><Save size={13} /> {busy ? 'Saving…' : plan ? 'Save plan' : 'Create plan'}</button>
          </div>
          {msg && <div className="az-rp-msg">{msg}</div>}
          <div className="az-rp-note">Saving stores the plan in Nexus. One plan drives every campaign advertising this product family — winners hold the slot during your windows, redundant campaigns fall to the baseline (no self-competition), and OOS / over-budget / over-ACOS are guarded automatically. Real Amazon pushes still honour the write-gate.</div>
        </>
      )}
    </div>
  )
}
