'use client'

/**
 * ACR.1.3b — the bounds grid: the rows behind the Guardrails counts.
 *
 * The counts above this were true and unusable. "0 of 216 campaigns have a minimum bid"
 * tells an operator there is work to do and gives them nowhere to do it; the only place a
 * bound could actually be set was the Ad Manager, one campaign at a time, on a grid built
 * for metrics. This is the same numbers with an edit box beside each one.
 *
 * Every write here goes to an endpoint that already existed:
 *   · min / max bid  → PATCH /advertising/campaigns/:id/guardrails  (validates the PAIR —
 *     it refuses a one-sided edit that would leave min > max, which is a campaign nothing
 *     can write to at all)
 *   · authority pins → PATCH /advertising/campaigns/:id/pins        (ACR.1.2b)
 *   · managed        → PATCH /advertising/campaigns/:id/live-writes
 *
 * The pins are the reason this grid is worth having rather than just the bounds. A bound
 * says how far automation may move a number; a pin says whether it may touch it at all, and
 * it is enforced at the write gate — the same door the allowlist and the bounds bind at.
 *
 * Deliberately NOT the shared DataGrid, matching the four tabs already shipped on this page:
 * the DS stylesheets carry `.dark` rules and `.h10-shell` pins this console light, which is
 * the dark-cards-in-a-light-shell defect the ACR design notes decided against. Own classes,
 * own stylesheet, light only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search, Pin, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Dim = 'placement' | 'bids' | 'budget'

interface Row {
  id: string
  name: string
  marketplace: string | null
  status: string
  portfolioName: string | null
  managed: boolean
  minBidCents: number | null
  maxBidCents: number | null
  dailyBudgetCents: number | null
  targetAcosPct: number | null
  suppressedAt: string | null
  suppressedBy: string | null
  pins: { placement: boolean; bids: boolean; budget: boolean }
  pinNote: string | null
  pinnedBy: string | null
  boundRules: Array<{ id: string; name: string; level: string; enabled: boolean }>
}
interface Grid {
  rows: Row[]
  accountWideRules: number
  totals: { campaigns: number; managed: number; withMinBid: number; withMaxBid: number; pinned: number; suppressed: number }
}

const cents = (v: number | null) => (v == null ? '' : (v / 100).toFixed(2))
const eur = (v: number | null) => (v == null ? '—' : `€${(v / 100).toFixed(2)}`)

const DIMS: Array<{ key: Dim; field: 'pinPlacement' | 'pinBids' | 'pinBudget'; short: string; hint: string }> = [
  { key: 'placement', field: 'pinPlacement', short: 'Plc', hint: 'Hands off placement multipliers — the rank engine\'s main actuator.' },
  { key: 'bids', field: 'pinBids', short: 'Bid', hint: 'Hands off bids. Deliberate suppression (retail guard, budget cap, Min-bid windows) is still allowed — a pin must never freeze bids high.' },
  { key: 'budget', field: 'pinBudget', short: 'Bgt', hint: 'Hands off daily budget. Budget pacing will be refused at the gate.' },
]

export function GuardrailGrid() {
  const [g, setG] = useState<Grid | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [market, setMarket] = useState('')
  const [managedOnly, setManagedOnly] = useState(true)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Which cell is being typed in, so a re-render mid-edit cannot yank the value away.
  const [draft, setDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (market) qs.set('marketplace', market)
      if (managedOnly) qs.set('managedOnly', '1')
      if (search.trim()) qs.set('search', search.trim())
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/guardrail-grid?${qs}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`guardrail-grid: ${r.status}`)
      setG((await r.json()) as Grid)
      setErr(null)
    } catch (e) { setErr((e as Error).message) }
  }, [market, managedOnly, search])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3200) }

  /**
   * Bounds are saved as a PAIR even when one box changed, because the server validates the
   * resulting pair per campaign. Sending only the edited field would let "set max to 50"
   * land on a campaign whose min is already 80 — a campaign every bid is simultaneously
   * below the floor and above the ceiling of.
   */
  const saveBounds = async (row: Row, next: { min?: number | null; max?: number | null }) => {
    const minBidCents = next.min !== undefined ? next.min : row.minBidCents
    const maxBidCents = next.max !== undefined ? next.max : row.maxBidCents
    if (minBidCents === row.minBidCents && maxBidCents === row.maxBidCents) return
    setSaving(row.id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${row.id}/guardrails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minBidCents, maxBidCents }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`)
      setG((s) => s && { ...s, rows: s.rows.map((x) => (x.id === row.id ? { ...x, minBidCents, maxBidCents } : x)) })
      say(`Bounds saved · ${row.name}`)
      // Reload for the account-wide totals above the grid, which just moved.
      void load()
    } catch (e) {
      say(`Refused · ${(e as Error).message}`)
      // Put the stored value back in the box: leaving the rejected number on screen would
      // read as saved.
      setDraft((d) => ({ ...d, [`${row.id}:min`]: cents(row.minBidCents), [`${row.id}:max`]: cents(row.maxBidCents) }))
    } finally { setSaving(null) }
  }

  const togglePin = async (row: Row, dim: typeof DIMS[number]) => {
    const nextValue = !row.pins[dim.key]
    setSaving(row.id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${row.id}/pins`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [dim.field]: nextValue }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`)
      setG((s) => s && {
        ...s,
        rows: s.rows.map((x) => (x.id === row.id ? { ...x, pins: { ...x.pins, [dim.key]: nextValue } } : x)),
        totals: s.totals,
      })
      say(`${dim.key} ${nextValue ? 'pinned' : 'unpinned'} · ${row.name}`)
      void load()
    } catch (e) { say(`Refused · ${(e as Error).message}`) } finally { setSaving(null) }
  }

  const toggleManaged = async (row: Row) => {
    const enabled = !row.managed
    setSaving(row.id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${row.id}/live-writes`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setG((s) => s && { ...s, rows: s.rows.map((x) => (x.id === row.id ? { ...x, managed: enabled } : x)) })
      say(`${enabled ? 'Managed' : 'Not managed'} · ${row.name}`)
      void load()
    } catch (e) { say(`Refused · ${(e as Error).message}`) } finally { setSaving(null) }
  }

  const markets = useMemo(
    () => [...new Set((g?.rows ?? []).map((r) => r.marketplace).filter(Boolean) as string[])].sort(),
    [g],
  )

  const box = (row: Row, which: 'min' | 'max') => {
    const key = `${row.id}:${which}`
    const stored = cents(which === 'min' ? row.minBidCents : row.maxBidCents)
    const value = draft[key] ?? stored
    const commit = () => {
      const raw = (draft[key] ?? '').trim()
      if (draft[key] === undefined) return
      const parsed = raw === '' ? null : Math.round(Number(raw) * 100)
      if (raw !== '' && !Number.isFinite(parsed)) { setDraft((d) => { const n = { ...d }; delete n[key]; return n }) ; return }
      setDraft((d) => { const n = { ...d }; delete n[key]; return n })
      void saveBounds(row, which === 'min' ? { min: parsed } : { max: parsed })
    }
    return (
      <input
        className="acr-gg-num"
        inputMode="decimal"
        placeholder="—"
        aria-label={`${which === 'min' ? 'Minimum' : 'Maximum'} bid for ${row.name}`}
        value={value}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft((d) => { const n = { ...d }; delete n[key]; return n })
        }}
      />
    )
  }

  return (
    <div className="acr-gg">
      {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}

      <div className="acr-sec-head">
        <h2>Per-campaign bounds and pins</h2>
        <span className="acr-sec-count">
          {g ? `${g.totals.withMinBid} with a min · ${g.totals.withMaxBid} with a max · ${g.totals.pinned} pinned` : ''}
        </span>
      </div>

      <div className="acr-gg-bar">
        <label className="acr-gg-search">
          <Search size={13} />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns" aria-label="Search campaigns"
          />
        </label>
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Marketplace">
          <option value="">All markets</option>
          {markets.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="acr-gg-check">
          <input type="checkbox" checked={managedOnly} onChange={(e) => setManagedOnly(e.target.checked)} />
          Managed only
        </label>
        {/* Filter state is always visible with a way back, per the console's standing rule. */}
        {(search || market || !managedOnly) && (
          <button type="button" className="acr-gg-reset" onClick={() => { setSearch(''); setMarket(''); setManagedOnly(true) }}>
            Reset
          </button>
        )}
        <span className="acr-gg-count">{g ? `${g.rows.length} shown of ${g.totals.campaigns}` : ''}</span>
      </div>

      {!g ? <div className="acr-empty">Loading…</div> : g.rows.length === 0 ? (
        <div className="acr-empty">No campaigns match these filters.</div>
      ) : (
        <div className="acr-gg-scroll">
          <table className="acr-gg-tbl">
            <thead>
              <tr>
                <th className="acr-gg-name-h">Campaign</th>
                <th>Managed</th>
                <th title="Absolute floor, in euros. Enforced on every write to Amazon.">Min bid</th>
                <th title="Absolute ceiling, in euros. Placement modifiers stack on top, so an effective CPC can still exceed it.">Max bid</th>
                <th>Budget/day</th>
                <th>Target ACoS</th>
                <th title="Hands off, per dimension. Enforced at the write gate.">Hands off</th>
                <th>Suppressed</th>
                <th title="Rules bound to this campaign by dragging one onto it.">Bound rules</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.id} className={saving === r.id ? 'saving' : undefined}>
                  <td className="acr-gg-name">
                    <span className="n" title={r.name}>{r.name}</span>
                    <span className="m">
                      {r.marketplace ?? '—'}
                      {r.portfolioName ? ` · ${r.portfolioName}` : ''}
                      {r.status !== 'ENABLED' ? ` · ${r.status.toLowerCase()}` : ''}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`acr-gg-toggle ${r.managed ? 'on' : ''}`}
                      onClick={() => void toggleManaged(r)}
                      title={r.managed
                        ? 'Automation may write to this campaign.'
                        : 'Default-deny: every automated write to this campaign is refused at the gate.'}
                    >
                      {r.managed ? 'Managed' : 'No'}
                    </button>
                  </td>
                  <td>{box(r, 'min')}</td>
                  <td>{box(r, 'max')}</td>
                  <td className="acr-gg-ro">{eur(r.dailyBudgetCents)}</td>
                  <td className="acr-gg-ro">{r.targetAcosPct != null ? `${r.targetAcosPct}%` : '—'}</td>
                  <td>
                    <div className="acr-gg-pins">
                      {DIMS.map((d) => (
                        <button
                          key={d.key}
                          type="button"
                          className={`acr-gg-pin ${r.pins[d.key] ? 'on' : ''}`}
                          onClick={() => void togglePin(r, d)}
                          title={`${d.hint}${r.pins[d.key] && r.pinnedBy ? `\nPinned by ${r.pinnedBy}` : ''}`}
                          aria-pressed={r.pins[d.key]}
                        >
                          {r.pins[d.key] && <Pin size={9} />}{d.short}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="acr-gg-ro">
                    {r.suppressedAt
                      ? <span className="acr-gg-sup" title={`Suppressed by ${r.suppressedBy ?? 'an engine that predates the owner column'}`}>
                        {r.suppressedBy?.replace('automation:', '') ?? 'unknown owner'}
                      </span>
                      : '—'}
                  </td>
                  <td className="acr-gg-ro">
                    {r.boundRules.length
                      ? <span className="acr-gg-rules" title={r.boundRules.map((x) => x.name).join('\n')}>{r.boundRules.length}</span>
                      : <span className="acr-gg-dash">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {g && (
        <p className="acr-note">
          Bounds and pins are local governance — Amazon has no concept of either, so nothing is
          pushed there. They bind at the write gate, which is the only way any engine reaches
          Amazon. {g.accountWideRules > 0 && (
            <>
              <strong>{g.accountWideRules}</strong> enabled rule{g.accountWideRules === 1 ? '' : 's'} currently
              govern every campaign because nothing narrows them; drag one onto a campaign from the
              dock to bind it, and the <em>Bound rules</em> column will count it.
            </>
          )}
        </p>
      )}

      {toast && <div className="acr-gg-toast" role="status">{saving && <Loader2 size={12} className="acr-spin" />}{toast}</div>}
    </div>
  )
}
