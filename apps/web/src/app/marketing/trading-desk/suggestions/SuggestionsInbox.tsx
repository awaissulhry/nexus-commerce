'use client'

/**
 * Trading Desk — Suggestions inbox (P3). The trust layer: every optimizer
 * (bid / keyword graduation / negative / budget / retail-pause / competitive)
 * proposes here. Approve/dismiss manually, or flip a category to Auto-apply.
 *
 * Data: /api/advertising/recommendations (ranked, with apply:{kind,payload}).
 * Approve → POST /recommendations/apply → the existing audited + gated paths
 * (sandbox = DB-only + audit log; live = 5-min grace/undo + write-gate). So
 * auto-apply is safe to run now and stays safe at go-live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Coins, GraduationCap, MinusCircle, Wallet, PackageX, Crosshair, Check, RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

type Cat = 'bid' | 'graduate' | 'negative' | 'budget' | 'retail' | 'sov'
interface RecMetrics { impressions?: number; clicks?: number; ctr?: number | null; spendCents?: number; salesCents?: number; orders?: number; acos?: number | null; roas?: number | null; cvr?: number | null }
interface Rec { id: string; category: Cat; severity: 'high' | 'medium' | 'low'; title: string; detail: string; estImpactCents: number; apply: { kind: string; payload: unknown } | null; metrics?: RecMetrics }
interface RecResult { generatedAt?: string; windowDays?: number; potentialMonthlyImpactCents?: number; recommendations?: Rec[] }

const CATS: Array<{ key: Cat; label: string; icon: LucideIcon }> = [
  { key: 'bid', label: 'Bid changes', icon: Coins },
  { key: 'graduate', label: 'Match-type graduations', icon: GraduationCap },
  { key: 'negative', label: 'Negatives', icon: MinusCircle },
  { key: 'budget', label: 'Budget', icon: Wallet },
  { key: 'retail', label: 'Retail-pause', icon: PackageX },
  { key: 'sov', label: 'Competitive', icon: Crosshair },
]
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const eur2 = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const pctF = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)
const lsGet = (k: string, d: string[]) => { try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as string[]) : d } catch { return d } }
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } }

export function SuggestionsInbox({ initial, brief }: { initial: RecResult; brief: { tldr: string; modelUsed: string } }) {
  const [recs, setRecs] = useState<Rec[]>(initial.recommendations ?? [])
  const [potential, setPotential] = useState<number>(initial.potentialMonthlyImpactCents ?? 0)
  const [active, setActive] = useState<Cat>('bid')
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(typeof window !== 'undefined' ? lsGet('td.sug.dismissed', []) : []))
  const [autoApply, setAutoApply] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [autoMsg, setAutoMsg] = useState('')
  const autoFired = useRef<Set<string>>(new Set())

  useEffect(() => {
    try { setAutoApply(JSON.parse(localStorage.getItem('td.sug.autoapply') || '{}')) } catch { /* ignore */ }
  }, [])

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/recommendations?windowDays=30`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
      if (r?.recommendations) { setRecs(r.recommendations as Rec[]); setPotential(r.potentialMonthlyImpactCents ?? 0) }
    } finally { setLoading(false) }
  }, [])
  useMarketingEvents(useCallback(() => { void refetch() }, [refetch]))

  const visible = useMemo(() => recs.filter((r) => !applied.has(r.id) && !dismissed.has(r.id)), [recs, applied, dismissed])
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const r of visible) c[r.category] = (c[r.category] ?? 0) + 1; return c }, [visible])
  const inCat = useMemo(() => visible.filter((r) => r.category === active), [visible, active])

  const apply = useCallback(async (rec: Rec) => {
    if (!rec.apply) return
    setBusy((s) => new Set(s).add(rec.id))
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/recommendations/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec.apply) })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j?.ok !== false) setApplied((a) => new Set(a).add(rec.id))
    } finally { setBusy((s) => { const n = new Set(s); n.delete(rec.id); return n }) }
  }, [])

  const dismiss = (rec: Rec) => setDismissed((d) => { const n = new Set(d); n.add(rec.id); lsSet('td.sug.dismissed', [...n]); return n })

  // Auto-apply: when a category is toggled on (persisted), fire its pending,
  // safe (apply != null) suggestions — once per id per session.
  useEffect(() => {
    let fired = 0
    for (const cat of CATS) {
      if (!autoApply[cat.key]) continue
      for (const r of recs) {
        if (r.category !== cat.key || !r.apply) continue
        if (applied.has(r.id) || dismissed.has(r.id) || autoFired.current.has(r.id)) continue
        autoFired.current.add(r.id); void apply(r); fired++
      }
    }
    if (fired > 0) { setAutoMsg(`Auto-applying ${fired} suggestion${fired > 1 ? 's' : ''}…`); const t = setTimeout(() => setAutoMsg(''), 3500); return () => clearTimeout(t) }
  }, [recs, autoApply, applied, dismissed, apply])

  const toggleAuto = (cat: Cat) => setAutoApply((m) => { const n = { ...m, [cat]: !m[cat] }; lsSet('td.sug.autoapply', n); return n })

  const safeInCat = inCat.filter((r) => r.apply && r.severity !== 'low')
  const approveAllSafe = async () => { for (const r of safeInCat) await apply(r) }

  const sevDot = (s: Rec['severity']) => <span className={`sev ${s}`} title={s} />
  const metaChips = (m?: RecMetrics) => {
    if (!m) return null
    const chips: Array<[string, string]> = []
    if (m.spendCents != null) chips.push(['Spend', eur2(m.spendCents)])
    if (m.salesCents != null) chips.push(['Sales', eur2(m.salesCents)])
    if (m.acos != null) chips.push(['ACOS', pctF(m.acos)])
    if (m.orders != null) chips.push(['Orders', String(m.orders)])
    if (m.clicks != null && m.spendCents == null) chips.push(['Clicks', String(m.clicks)])
    return chips.map(([k, v]) => <span key={k} className="metachip">{k} <b>{v}</b></span>)
  }

  const totalSafe = visible.filter((r) => r.apply && r.severity !== 'low').length

  return (
    <>
      <div className="top">
        <div><h1>Suggestions</h1><div className="sub">{visible.length} pending · est. {eur(potential)}/mo at stake</div></div>
        <span className="spacer" />
        <button className="ctl" onClick={() => void refetch()} title="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
      </div>

      <div className="scroll">
        <div className="ai-banner">
          <div className="sp"><Sparkles size={16} /></div>
          <div className="tl">
            <div style={{ fontWeight: 700 }}>{visible.length} suggestions ready · est. <span style={{ color: 'var(--green)' }}>{eur(potential)}/mo</span></div>
            <div className="note">{brief?.tldr || 'Every optimizer, harvester and guardrail proposes here. Approve manually, or flip a category to auto-apply once you trust it.'}{brief?.modelUsed === 'anthropic' && <span style={{ marginLeft: 6, color: 'var(--brand)' }}>· AI brief</span>}</div>
          </div>
          <button className="btn ok" disabled={totalSafe === 0} onClick={() => void approveAllSafe()}><Check size={14} />Approve all safe ({safeInCat.length})</button>
        </div>

        <div className="sugtabs">
          {CATS.map((c) => {
            const Icon = c.icon
            return (
              <button key={c.key} className={`sugtab ${active === c.key ? 'on' : ''}`} onClick={() => setActive(c.key)}>
                <Icon size={15} />{c.label}<span className="n">{counts[c.key] ?? 0}</span>
              </button>
            )
          })}
        </div>

        <div className="card">
          <div className="hd" style={{ justifyContent: 'space-between' }}>
            <span>{CATS.find((c) => c.key === active)?.label}{autoMsg && <span style={{ color: 'var(--green)', fontWeight: 600, marginLeft: 10 }}>{autoMsg}</span>}</span>
            <button className={`toggle ${autoApply[active] ? 'on' : ''}`} onClick={() => toggleAuto(active)} title="Auto-apply new suggestions in this category (sandbox: DB-only + audited; live: 5-min undo)">
              <span className="sw"><i /></span>Auto-apply this category
            </button>
          </div>

          {inCat.length === 0 && <div className="empty">Nothing pending here — you're all caught up.</div>}
          {inCat.map((r) => (
            <div key={r.id} className="sugrow">
              {sevDot(r.severity)}
              <div>
                <div className="ttl">{r.title}</div>
                <div className="why">{r.detail}</div>
                <div className="meta">{metaChips(r.metrics)}</div>
              </div>
              <div className="impact">
                <div className="big">{r.estImpactCents > 0 ? eur(r.estImpactCents) : '—'}</div>
                <div className="lab">est. impact</div>
              </div>
              <div className="sugact">
                <button className="btn no sm" onClick={() => dismiss(r)}>Dismiss</button>
                {r.apply
                  ? <button className="btn ok sm" disabled={busy.has(r.id)} onClick={() => void apply(r)}><Check size={14} />{busy.has(r.id) ? 'Applying…' : 'Approve'}</button>
                  : <span className="note" style={{ alignSelf: 'center' }}>informational</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="foot-note">Approvals route through the existing audited + gated apply paths. Account is in sandbox, so applies update the DB + audit log only; at go-live they queue with a 5-min undo.</div>
      </div>
    </>
  )
}
