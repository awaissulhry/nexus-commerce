'use client'

/**
 * AUTO.A7 — Limits: the per-scope spend ceilings, the account posture, and the refusal record.
 *
 * The operator's standing ask, verbatim: a cap "for portfolios or for certain campaigns or for
 * certain markets" — never one global number — and at the cap "refuse further writes and tell
 * me". The VALUES are set here (substrate arbitration: "the values are set on Automations");
 * enforcement is one check in `ads-write-gate.ts`, the single chokepoint, and the KT apply path
 * for keyword commitments. A ceiling with a null cap is "opened but not set" — it resolves to
 * NO_CEILING and never reads as unlimited.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Toggle, ToolbarButton } from '@/design-system/primitives'
import { AlertTriangle, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

import type { ScopeOptions } from './ScopeForm'
import { Listbox } from '@/design-system/components'

interface Ceiling {
  id: string
  grain: 'CAMPAIGN' | 'LINE' | 'PORTFOLIO' | 'MARKET'
  scopeId: string
  label: string
  dailyCapCents: number | null
  enabled: boolean
  note: string | null
}

interface RefusalSummary {
  recordStarts: string
  windowDays: number
  byKind: Array<{ deniedAt: string; count: number }>
}

const GRAIN_WORD: Record<Ceiling['grain'], string> = { MARKET: 'Market', PORTFOLIO: 'Portfolio', LINE: 'Product line', CAMPAIGN: 'Campaign' }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

export function LimitsView({ scopeOptions, global }: {
  scopeOptions: ScopeOptions | null
  global: { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean } | null
}) {
  const [ceilings, setCeilings] = useState<Ceiling[] | null>(null)
  const [refusals, setRefusals] = useState<RefusalSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the add form
  const [grain, setGrain] = useState<Ceiling['grain']>('MARKET')
  const [scopeId, setScopeId] = useState('')
  const [capEur, setCapEur] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/spend-ceilings`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load ceilings (${r.status})`)
      const j = await r.json()
      setCeilings(Array.isArray(j?.ceilings) ? j.ceilings : [])
      setErr(null)
    } catch (e) { setErr((e as Error).message); setCeilings(null) }
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/write-refusals?days=7`, { cache: 'no-store' })
      setRefusals(r.ok ? await r.json() : null)
    } catch { setRefusals(null) }
  }, [])
  useEffect(() => { void load() }, [load])

  /** The scope picker's options for the chosen grain, with the label the refusal will use. */
  const scopeOpts = useMemo(() => {
    if (grain === 'MARKET') {
      const markets = [...new Set((scopeOptions?.campaigns ?? []).map((c) => c.marketplace).filter(Boolean))] as string[]
      return markets.map((m) => ({ value: m, label: `the ${m} market` }))
    }
    if (grain === 'PORTFOLIO') {
      return (scopeOptions?.portfolios ?? []).map((p) => ({ value: p.externalPortfolioId, label: `the ${p.name} portfolio` }))
    }
    if (grain === 'LINE') {
      return (scopeOptions?.productLines ?? []).map((p) => ({ value: p.id, label: `the ${p.name || p.sku} line` }))
    }
    return (scopeOptions?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))
  }, [grain, scopeOptions])

  const save = async () => {
    const opt = scopeOpts.find((o) => o.value === scopeId)
    if (!opt) return
    setBusy(true)
    try {
      const capCents = capEur.trim() ? Math.round(Number(capEur) * 100) : null
      const r = await fetch(`${getBackendUrl()}/api/advertising/spend-ceilings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grain, scopeId, label: opt.label, dailyCapCents: capCents }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Could not save (${r.status})`)
      setScopeId(''); setCapEur('')
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const toggle = async (c: Ceiling) => {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/spend-ceilings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grain: c.grain, scopeId: c.scopeId, label: c.label, dailyCapCents: c.dailyCapCents, enabled: !c.enabled }),
      })
      await load()
    } finally { setBusy(false) }
  }

  const remove = async (c: Ceiling) => {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/spend-ceilings?grain=${encodeURIComponent(c.grain)}&scopeId=${encodeURIComponent(c.scopeId)}`, { method: 'DELETE' })
      await load()
    } finally { setBusy(false) }
  }

  const refusalTotal = refusals?.byKind.reduce((s, k) => s + k.count, 0) ?? null

  return (
    <div className="h10-au-limits">
      {/* posture — read here, set on the Control Room */}
      <section className="h10-au-limitsec">
        <h3>Account posture</h3>
        {global ? (
          <p className="h10-au-posture">
            Autonomy dial: <b>{global.autonomy || '—'}</b>
            {global.halted && <em className="bad"> · HALTED — nothing writes until the halt clears</em>}
            {global.envKill && <em className="bad"> · env kill-switch is set</em>}
            {global.degraded && <em> · degraded</em>}
            <span className="sub"> The dial and the halt are set on the <a href="/marketing/ads/rules-automation/control-room">Control Room</a>; every ceiling below binds inside them.</span>
          </p>
        ) : <p className="h10-au-posture muted">Posture could not be loaded — the ceilings below are unaffected.</p>}
      </section>

      {/* the ceilings */}
      <section className="h10-au-limitsec">
        <h3>Per-scope spend ceilings</h3>
        <p className="h10-au-limitsub">
          A ceiling binds <b>budget increases</b> at the write gate (campaign ⊂ line ⊂ portfolio ⊂ market — the
          tightest one refuses and the refusal names it) and keyword-bid commitments on the Keyword Tracker&rsquo;s
          apply path. It counts <b>our own ledger of today&rsquo;s authorisations</b> — Amazon&rsquo;s spend figure lags
          ~2 days and cannot referee a refusal happening now.
        </p>
        {err && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}
        {ceilings && ceilings.length === 0 && (
          <p className="h10-au-limitempty">No ceilings exist yet — nothing is refused on spend at any scope. Add the first one below.</p>
        )}
        {ceilings && ceilings.length > 0 && (
          <table className="h10-au-limittbl">
            <thead><tr><th>Scope</th><th>Grain</th><th>Daily cap</th><th>On</th><th aria-label="actions" /></tr></thead>
            <tbody>
              {ceilings.map((c) => (
                <tr key={c.id} className={c.enabled ? '' : 'off'}>
                  <td>{c.label}</td>
                  <td>{GRAIN_WORD[c.grain]}</td>
                  <td>{c.dailyCapCents == null
                    ? <i title="Opened but not set — resolves to NO_CEILING; it does NOT mean unlimited.">not set</i>
                    : eur(c.dailyCapCents)}</td>
                  <td>
                    <Toggle checked={c.enabled} aria-label={`Ceiling for ${c.label}`} disabled={busy} onClick={() => void toggle(c)} />
                  </td>
                  <td>
                    <ToolbarButton tone="danger" size="sm" icon={<Trash2 size={13} aria-hidden />} label={`Delete ceiling for ${c.label}`} tooltip={false} disabled={busy} onClick={() => void remove(c)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="h10-au-limitadd">
          <Listbox width={150} options={(['MARKET', 'PORTFOLIO', 'LINE', 'CAMPAIGN'] as const).map((g) => ({ value: g, label: GRAIN_WORD[g] }))} value={grain} onChange={(v) => { setGrain(v as Ceiling['grain']); setScopeId('') }} ariaLabel="Ceiling grain" />
          <Listbox width={300} options={[{ value: '', label: 'Choose a scope…' }, ...scopeOpts]} value={scopeId} onChange={setScopeId} ariaLabel="Ceiling scope" searchable />
          <Input fieldClassName="h10-au-limitcap" prefix="€" suffix="/day" inputMode="decimal" placeholder="Daily cap" value={capEur} onChange={(e) => setCapEur(e.target.value)} aria-label="Daily cap in euros" />
     <Button variant="primary" disabled={busy || !scopeId} onClick={() => void save()}><Plus size={13} aria-hidden /> Ceiling</Button>
        </div>
      </section>

      {/* the refusal record */}
      <section className="h10-au-limitsec">
        <h3>Refusals</h3>
        {refusals ? (
          <p className="h10-au-refusals">
            {refusalTotal === 0
              ? <>No gate refusals recorded in the last {refusals.windowDays} days.</>
              : <>Last {refusals.windowDays} days: {refusals.byKind.map((k) => `${k.count.toLocaleString('en-IE')} × ${k.deniedAt}`).join(' · ')}.</>}
            <span className="sub"> The durable record starts {refusals.recordStarts} — earlier refusals exist only in the application log, so a zero here says nothing about before then.</span>
          </p>
        ) : (
          <p className="h10-au-refusals muted"><ShieldAlert size={13} aria-hidden /> The refusal record could not be loaded — that is not the same fact as &ldquo;no refusals&rdquo;.</p>
        )}
      </section>
    </div>
  )
}
