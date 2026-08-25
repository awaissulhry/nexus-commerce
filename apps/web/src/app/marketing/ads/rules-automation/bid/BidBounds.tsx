'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: "Bounds — the band, at four grains": min/max bid coverage per market · line · portfolio · campaign.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: Analytics; the editable band itself already lives on Apply Rules (AR.S1).
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S5 — bounds as a first-class control: the band, at four grains.
 *
 * The gate resolves each SIDE most-specific-first: the Campaign columns (min/maxBidCents — the
 * strongest word, edited here per campaign via the same guardrails PATCH the Ad Manager uses) ??
 * LINE ?? PORTFOLIO ?? MARKET (`AdBidPolicy`). A denial NAMES its source, so a refused write
 * tells the operator which bound to look at. Everything here is inert until a value is set —
 * measured when S2 shipped: minBidCents on 0 of 220, maxBidCents on 82, and 14 of 15 targets in
 * one campaign sat ABOVE their own ceiling because the gate refuses new writes and never pulls
 * an existing bid in. That last fact is the panel's warning, not its secret.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { AlertTriangle, Check, Ruler, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

import type { BidSlotProps } from './slot-contract'
import { emitAdsChange } from '../_shared/adsBus'
import { Listbox } from '@/design-system/components'

interface BidPolicy {
  id: string
  grain: 'LINE' | 'PORTFOLIO' | 'MARKET'
  scopeId: string
  label: string
  minBidCents: number | null
  maxBidCents: number | null
  enabled: boolean
}

const GRAIN_WORD: Record<BidPolicy['grain'], string> = { MARKET: 'Market', PORTFOLIO: 'Portfolio', LINE: 'Product line' }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

export function BidBounds({ options, campaigns, reload }: BidSlotProps) {
  const [policies, setPolicies] = useState<BidPolicy[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the policy add form
  const [grain, setGrain] = useState<BidPolicy['grain']>('MARKET')
  const [scopeId, setScopeId] = useState('')
  const [minEur, setMinEur] = useState('')
  const [maxEur, setMaxEur] = useState('')
  // the per-campaign band editor
  const [campId, setCampId] = useState('')
  const [cMin, setCMin] = useState('')
  const [cMax, setCMax] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/bid-policies`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load bid policies (${r.status})`)
      const j = await r.json()
      setPolicies(Array.isArray(j?.policies) ? j.policies : [])
      setErr(null)
    } catch (e) { setErr((e as Error).message); setPolicies(null) }
  }, [])
  useEffect(() => { void load() }, [load])

  const scopeOpts = useMemo(() => {
    if (grain === 'MARKET') {
      const mkts = [...new Set((options?.campaigns ?? []).map((c) => c.marketplace).filter(Boolean))] as string[]
      return mkts.map((m) => ({ value: m, label: `the ${m} market` }))
    }
    if (grain === 'PORTFOLIO') return (options?.portfolios ?? []).map((p) => ({ value: p.externalPortfolioId, label: `the ${p.name} portfolio` }))
    return (options?.productLines ?? []).map((p) => ({ value: p.id, label: `the ${p.name || p.sku} line` }))
  }, [grain, options])

  const savePolicy = async () => {
    const opt = scopeOpts.find((o) => o.value === scopeId)
    if (!opt) return
    setBusy(true); setErr(null); setNote(null)
    try {
      const toCents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100))
      const r = await fetch(`${getBackendUrl()}/api/advertising/bid-policies`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grain, scopeId, label: opt.label, minBidCents: toCents(minEur), maxBidCents: toCents(maxEur) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? `Save failed (${r.status})`)
      setNote(`Bound saved for ${opt.label}. It binds every NEW write at the gate; existing bids outside it stay where they are until something moves them.`)
      setScopeId(''); setMinEur(''); setMaxEur('')
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const removePolicy = async (p: BidPolicy) => {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/bid-policies?grain=${encodeURIComponent(p.grain)}&scopeId=${encodeURIComponent(p.scopeId)}`, { method: 'DELETE' })
      await load()
    } finally { setBusy(false) }
  }

  const selectedCamp = campaigns.find((c) => c.id === campId) ?? null
  const openCamp = (id: string) => {
    const c = campaigns.find((x) => x.id === id)
    setCampId(id)
    setCMin(c?.minBidCents != null ? (c.minBidCents / 100).toFixed(2) : '')
    setCMax(c?.maxBidCents != null ? (c.maxBidCents / 100).toFixed(2) : '')
  }
  const saveCamp = async () => {
    if (!selectedCamp) return
    setBusy(true); setErr(null); setNote(null)
    try {
      const toCents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100))
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${selectedCamp.id}/guardrails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minBidCents: toCents(cMin), maxBidCents: toCents(cMax) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `Save failed (${r.status})`)
      setNote(`Band saved for “${selectedCamp.name}” — the campaign grain overrides every policy below it.`)
      setCampId('')
      reload()
      // RT.1 — a bound is enforced at the write gate, so Apply Rules renders it too.
      emitAdsChange('ads.guardrail.changed')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <section id="bid-bounds" className="h10-bd5">
      <h3><Ruler size={14} aria-hidden /> Bounds — the band, at four grains</h3>
      <p className="h10-bd5-sub">
        A floor or ceiling is <b>denied at the write gate</b>, for every engine and rule at once, and the
        refusal names which bound refused it. Most specific wins per side: campaign ?? line ?? portfolio ??
        market. ⚠ A bound binds <b>new writes only</b> — an existing bid outside it stays where it is until
        something tries to move it (measured: one campaign holds 14 of 15 targets above its own ceiling).
      </p>

      {err && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}
      {note && <p className="h10-bud2-ok" role="status"><Check size={13} aria-hidden /> {note}</p>}

      {policies && policies.length > 0 && (
        <table className="h10-au-limittbl">
          <thead><tr><th>Scope</th><th>Grain</th><th>Floor</th><th>Ceiling</th><th aria-label="actions" /></tr></thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id} className={p.enabled ? '' : 'off'}>
                <td>{p.label}</td>
                <td>{GRAIN_WORD[p.grain]}</td>
                <td>{p.minBidCents != null ? eur(p.minBidCents) : '—'}</td>
                <td>{p.maxBidCents != null ? eur(p.maxBidCents) : '—'}</td>
                <td><button type="button" className="h10-au-limitdel" disabled={busy} onClick={() => void removePolicy(p)} aria-label={`Delete the bound for ${p.label}`}><Trash2 size={13} aria-hidden /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {policies && policies.length === 0 && (
        <p className="h10-au-limitempty">No broad-grain bounds exist yet — only per-campaign bands (set below) bind.</p>
      )}

      <div className="h10-bud2-row">
        <Listbox width={150} options={(['MARKET', 'PORTFOLIO', 'LINE'] as const).map((g) => ({ value: g, label: GRAIN_WORD[g] }))} value={grain} onChange={(v) => { setGrain(v as BidPolicy['grain']); setScopeId('') }} ariaLabel="Bound grain" />
        <Listbox width={280} options={[{ value: '', label: 'Choose a scope…' }, ...scopeOpts]} value={scopeId} onChange={setScopeId} ariaLabel="Bound scope" searchable />
        <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Floor" value={minEur} onChange={(e) => setMinEur(e.target.value)} aria-label="Bid floor in euros" /></span>
        <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Ceiling" value={maxEur} onChange={(e) => setMaxEur(e.target.value)} aria-label="Bid ceiling in euros" /></span>
    <Button variant="primary" disabled={busy || !scopeId || (!minEur.trim() && !maxEur.trim())} onClick={() => void savePolicy()}>Save bound</Button>
      </div>

      <div className="h10-bud2-row">
        <Listbox
          width={320}
          options={[{ value: '', label: 'Set one campaign’s band…' }, ...campaigns.map((c) => ({ value: c.id, label: `${c.name}${c.minBidCents != null || c.maxBidCents != null ? ` (${c.minBidCents != null ? eur(c.minBidCents) : '—'}–${c.maxBidCents != null ? eur(c.maxBidCents) : '—'})` : ''}` }))]}
          value={campId}
          onChange={openCamp}
          ariaLabel="Campaign band to edit"
          searchable
        />
        {selectedCamp && (
          <>
            <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Floor" value={cMin} onChange={(e) => setCMin(e.target.value)} aria-label="Campaign bid floor" /></span>
            <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Ceiling" value={cMax} onChange={(e) => setCMax(e.target.value)} aria-label="Campaign bid ceiling" /></span>
      <Button variant="primary" disabled={busy} onClick={() => void saveCamp()}>Save band</Button>
      <Button onClick={() => setCampId('')}>Cancel</Button>
          </>
        )}
      </div>
    </section>
  )
}
