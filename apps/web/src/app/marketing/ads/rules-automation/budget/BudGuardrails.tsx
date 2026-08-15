'use client'

/**
 * BUD.2 — guardrails & the baseline: where the ratchet stops.
 *
 * The mechanism, in one sentence each:
 *   · a BASELINE anchors every relative budget rule — −20% of a €100 baseline is €80 on every
 *     tick, so the rule that walked GALE EXACT DE €100 → €1 in 39 writes becomes idempotent
 *     without touching the rule;
 *   · a FLOOR / CEILING is denied at the write gate — every engine, every rule, every future
 *     feature, because the gate is the only way to Amazon.
 *
 * Nothing here changes until the operator acts: a null baseline keeps the old behaviour, and
 * capture deliberately SKIPS campaigns that already carry one — 58 campaigns sit at €1 today,
 * and re-anchoring to a ratcheted value would enshrine the damage. Those 58 need a hand-set
 * baseline (the editor below), which is a judgement about what their budget SHOULD be, and no
 * default can make it.
 *
 * This is the first section that writes, so it replaces `NO_WRITE_ACTIONS` in the slot contract
 * rather than quietly stopping to pass it — the read-only property was stated, and its end is too.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Anchor, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { H10Select } from '../../campaigns/FilterDropdown'
import type { BudSlotProps } from './slot-contract'
import { emitAdsChange } from '../_shared/adsBus'

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

export function BudGuardrails({ campaigns, loading, reload }: BudSlotProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  // the per-campaign editor
  const [editId, setEditId] = useState('')
  const [minEur, setMinEur] = useState('')
  const [maxEur, setMaxEur] = useState('')
  const [baseEur, setBaseEur] = useState('')

  const census = useMemo(() => {
    const withBaseline = campaigns.filter((c) => c.budgetBaselineCents != null).length
    const withBounds = campaigns.filter((c) => c.minBudgetCents != null || c.maxBudgetCents != null).length
    const atFloor = campaigns.filter((c) => c.atFloor).length
    const capturable = campaigns.filter((c) => c.budgetBaselineCents == null && !c.atFloor).length
    return { total: campaigns.length, withBaseline, withBounds, atFloor, capturable }
  }, [campaigns])

  const capture = async () => {
    setBusy(true); setErr(null); setNote(null)
    try {
      // Deliberately excludes at-floor campaigns even with overwrite: capturing €1 as an anchor
      // is the one capture that must never happen by button.
      const ids = campaigns.filter((c) => !c.atFloor && (overwrite || c.budgetBaselineCents == null)).map((c) => c.id)
      if (ids.length === 0) { setNote('Nothing to capture — every campaign in scope either has a baseline or sits at the €1 floor.'); return }
      const r = await fetch(`${getBackendUrl()}/api/advertising/budget-baselines/capture`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignIds: ids, overwrite }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? `Capture failed (${r.status})`)
      setNote(`Captured ${j.captured} baseline${j.captured === 1 ? '' : 's'} from current budgets${j.skipped ? ` · ${j.skipped} skipped` : ''}. Relative rules on those campaigns now anchor here instead of compounding.`)
      reload()
      // RT.1 — baselines and bounds are what every relative budget rule anchors to.
      emitAdsChange('ads.budget.changed')
      emitAdsChange('ads.guardrail.changed')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const selected = campaigns.find((c) => c.id === editId) ?? null
  const openEditor = (id: string) => {
    const c = campaigns.find((x) => x.id === id)
    setEditId(id)
    setMinEur(c?.minBudgetCents != null ? (c.minBudgetCents / 100).toFixed(2) : '')
    setMaxEur(c?.maxBudgetCents != null ? (c.maxBudgetCents / 100).toFixed(2) : '')
    setBaseEur(c?.budgetBaselineCents != null ? (c.budgetBaselineCents / 100).toFixed(2) : '')
  }

  const saveOne = async () => {
    if (!selected) return
    setBusy(true); setErr(null); setNote(null)
    try {
      const toCents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100))
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${selected.id}/guardrails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minBudgetCents: toCents(minEur), maxBudgetCents: toCents(maxEur), budgetBaselineCents: toCents(baseEur) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `Save failed (${r.status})`)
      setNote(`Guardrails saved for “${selected.name}”. Bounds are enforced at the write gate from the next write.`)
      setEditId('')
      reload()
      // RT.1 — baselines and bounds are what every relative budget rule anchors to.
      emitAdsChange('ads.budget.changed')
      emitAdsChange('ads.guardrail.changed')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  if (loading && campaigns.length === 0) return null

  return (
    <section id="bud-guardrails" className="h10-bud2">
      <h3><Anchor size={14} aria-hidden /> Guardrails &amp; the baseline</h3>
      <p className="h10-bud2-sub">
        A relative rule (−20%, +€2) anchored to a <b>baseline</b> targets the same number on every tick —
        the compounding that walked budgets to €1 is arithmetic on the <i>current</i> value.
        A <b>floor or ceiling</b> is denied at the write gate, for every engine at once.
        Nothing changes until you capture or set one.
      </p>

      <div className="h10-bud2-census">
        <span><b>{census.withBaseline}</b> of {census.total} in scope carry a baseline</span>
        <span><b>{census.withBounds}</b> carry a floor or ceiling</span>
        {census.atFloor > 0 && (
          <span className="warn" title="Capture never anchors these by button — a €1 baseline would enshrine the ratchet's damage. Set their baselines by hand below, at the value each budget SHOULD be.">
            <AlertTriangle size={12} aria-hidden /> {census.atFloor} at the €1 floor are excluded from capture
          </span>
        )}
      </div>

      {err && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}
      {note && <p className="h10-bud2-ok" role="status"><Check size={13} aria-hidden /> {note}</p>}

      <div className="h10-bud2-row">
        <button type="button" className="h10-am-btn primary" disabled={busy} onClick={() => void capture()}>
          <Anchor size={13} aria-hidden /> Capture baselines for {census.capturable + (overwrite ? census.withBaseline : 0)} campaign{(census.capturable + (overwrite ? census.withBaseline : 0)) === 1 ? '' : 's'} in scope
        </button>
        <label className="h10-bud2-chk" title="Re-capture campaigns that already carry a baseline, from their CURRENT budget. Only do this if the current budgets are the ones you want anchored.">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> overwrite existing baselines
        </label>
      </div>

      <div className="h10-bud2-row">
        <H10Select
          width={320}
          options={[{ value: '', label: 'Edit one campaign…' }, ...campaigns.map((c) => ({ value: c.id, label: `${c.name} (${eur(c.dailyBudgetCents)}${c.budgetBaselineCents != null ? ` · base ${eur(c.budgetBaselineCents)}` : ''})` }))]}
          value={editId}
          onChange={openEditor}
          ariaLabel="Campaign to edit"
          searchable
        />
        {selected && (
          <>
            <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Floor" value={minEur} onChange={(e) => setMinEur(e.target.value)} aria-label="Budget floor in euros" /></span>
            <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Ceiling" value={maxEur} onChange={(e) => setMaxEur(e.target.value)} aria-label="Budget ceiling in euros" /></span>
            <span className="h10-au-limitcap"><span className="pf">€</span><input inputMode="decimal" placeholder="Baseline" value={baseEur} onChange={(e) => setBaseEur(e.target.value)} aria-label="Budget baseline in euros" /></span>
            <button type="button" className="h10-am-btn primary" disabled={busy} onClick={() => void saveOne()}>Save</button>
            <button type="button" className="h10-am-btn" onClick={() => setEditId('')}>Cancel</button>
          </>
        )}
      </div>
    </section>
  )
}
