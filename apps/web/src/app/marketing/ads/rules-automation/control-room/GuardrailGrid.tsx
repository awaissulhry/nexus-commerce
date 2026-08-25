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
import { Checkbox, Input, Select } from '@/design-system/primitives'

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
  /**
   * ADX — a multiple of the target's HISTORICAL CPC, not an absolute cap. It is the third
   * bid guardrail and the one that does nothing for a keyword with no history, which is why
   * the absolute min/max columns exist beside it rather than instead of it.
   */
  cpcCeiling: { enabled: boolean; multiple: number } | null
  suppressedAt: string | null
  suppressedBy: string | null
  pins: { placement: boolean; bids: boolean; budget: boolean }
  /** Server-ordered list of the pinned dimensions — the same order the API renders them in. */
  pinnedDimensions: Dim[]
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
  // ACR.1.3c — bulk selection. 0 of 216 campaigns have a minimum bid; setting them one at
  // a time across the 82 managed ones is the job this grid exists for and could not do.
  /**
   * ACR.1.3d — the gap filter.
   *
   * This grid exists because 0 of 216 campaigns have a minimum bid, and until now it could
   * show that number but not the rows behind it: an operator had to scan 82 rows for blank
   * boxes. Client-side on purpose — the server already returns the whole managed set, and a
   * round trip to answer "which of these are blank" would be slower and could disagree with
   * what is on screen.
   */
  const [gap, setGap] = useState<'' | 'no-min' | 'no-max' | 'no-bounds' | 'pinned' | 'suppressed'>('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [bulkMin, setBulkMin] = useState('')
  const [bulkMax, setBulkMax] = useState('')
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)

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

  /**
   * The CPC ceiling through its own long-standing endpoint. Empty box = disabled, which is
   * why this sends `enabled:false` rather than omitting the field: the stored shape is
   * `{enabled, multiple}` and leaving `enabled` true with no multiple would keep a ceiling
   * running at the server's 1.5 default that the operator believes they just cleared.
   */
  const saveCpcCeiling = async (row: Row, multiple: number | null) => {
    const cur = row.cpcCeiling
    if ((cur?.enabled ? cur.multiple : null) === multiple) return
    setSaving(row.id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${row.id}/cpc-ceiling`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(multiple == null ? { enabled: false } : { enabled: true, multiple }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`)
      setG((s) => s && {
        ...s,
        rows: s.rows.map((x) => (x.id === row.id
          ? { ...x, cpcCeiling: multiple == null ? null : { enabled: true, multiple } }
          : x)),
      })
      say(multiple == null ? `CPC ceiling cleared · ${row.name}` : `CPC ceiling → ${multiple}× · ${row.name}`)
    } catch (e) {
      say(`Refused · ${(e as Error).message}`)
      setDraft((d) => ({ ...d, [`${row.id}:cpc`]: cur?.enabled ? String(cur.multiple) : '' }))
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

  const shown = useMemo(() => {
    const rows = g?.rows ?? []
    switch (gap) {
      case 'no-min': return rows.filter((r) => r.minBidCents == null)
      case 'no-max': return rows.filter((r) => r.maxBidCents == null)
      case 'no-bounds': return rows.filter((r) => r.minBidCents == null && r.maxBidCents == null)
      case 'pinned': return rows.filter((r) => r.pinnedDimensions.length > 0)
      case 'suppressed': return rows.filter((r) => r.suppressedAt)
      default: return rows
    }
  }, [g, gap])

  // Selection follows what is VISIBLE. A row filtered out of view must not stay silently
  // selected and then receive a bulk write the operator can no longer see.
  const selectedRows = useMemo(() => shown.filter((r) => sel.has(r.id)), [shown, sel])

  /**
   * Run one PATCH per selected campaign against the endpoints that already exist, rather
   * than inventing a bulk route.
   *
   * SEQUENTIAL and per-campaign on purpose. `validateGuardrails` judges the RESULTING PAIR
   * for each campaign separately, so "set max to 50" legitimately succeeds on most of a
   * selection and is refused on the ones whose min is already 80 — a campaign nothing could
   * write to afterwards. A bulk endpoint would have to choose between failing all of them
   * or hiding the partial result; doing it here lets the bar report exactly what happened,
   * and every write still lands its own audit row.
   */
  const runBulk = async (
    label: string,
    body: (row: Row) => Record<string, unknown> | null,
    path: (row: Row) => string,
  ) => {
    if (bulkBusy || !selectedRows.length) return
    setBulkBusy(label)
    let ok = 0
    const refused: Array<{ name: string; why: string }> = []
    for (const row of selectedRows) {
      const b = body(row)
      if (!b) continue
      try {
        const r = await fetch(`${getBackendUrl()}${path(row)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
        })
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!r.ok || j.ok === false) refused.push({ name: row.name, why: j.error ?? `HTTP ${r.status}` })
        else ok++
      } catch (e) { refused.push({ name: row.name, why: (e as Error).message }) }
    }
    setBulkBusy(null)
    await load()
    // Name the first refusal rather than only counting them: "2 refused" sends an operator
    // hunting, and the reason is almost always the same one for every row in the batch.
    say(refused.length
      ? `${ok} saved · ${refused.length} refused — ${refused[0].name}: ${refused[0].why}`
      : `${label}: ${ok} campaign${ok === 1 ? '' : 's'} saved`)
  }

  /**
   * Clearing is a SEPARATE action from setting, not an empty box.
   *
   * An empty field has to keep meaning "leave this alone", because the alternative — empty
   * means clear — turns "set a max on these 40 campaigns" into "set a max and wipe every
   * min" for anyone who did not fill both boxes. Pins already have an explicit ✕; bounds
   * now have the same, so neither destructive action can be reached by leaving something
   * blank.
   */
  const clearBulkBounds = (which: 'min' | 'max' | 'both') => runBulk(
    which === 'both' ? 'Bounds cleared' : `${which === 'min' ? 'Min' : 'Max'} cleared`,
    () => (which === 'both'
      ? { minBidCents: null, maxBidCents: null }
      : which === 'min' ? { minBidCents: null } : { maxBidCents: null }),
    (row) => `/api/advertising/campaigns/${row.id}/guardrails`,
  )

  const applyBulkBounds = async () => {
    const min = bulkMin.trim()
    const max = bulkMax.trim()
    if (min === '' && max === '') { say('Enter a min, a max, or both — or use ✕ to clear'); return }
    const toCents = (s: string) => (s === '' ? undefined : Math.round(Number(s) * 100))
    if ((min !== '' && !Number.isFinite(toCents(min))) || (max !== '' && !Number.isFinite(toCents(max)))) {
      say('Bounds must be numbers'); return
    }
    await runBulk(
      'Bounds',
      () => {
        const b: Record<string, unknown> = {}
        // Only send what was typed. Sending an untouched field as null would CLEAR the
        // other bound on every selected campaign — a silent mass-erase behind a save.
        if (min !== '') b.minBidCents = toCents(min)
        if (max !== '') b.maxBidCents = toCents(max)
        return b
      },
      (row) => `/api/advertising/campaigns/${row.id}/guardrails`,
    )
    setBulkMin(''); setBulkMax('')
  }

  const applyBulkPin = (dim: typeof DIMS[number], value: boolean) => runBulk(
    `${dim.key} ${value ? 'pinned' : 'unpinned'}`,
    () => ({ [dim.field]: value }),
    (row) => `/api/advertising/campaigns/${row.id}/pins`,
  )

  const applyBulkManaged = (enabled: boolean) => runBulk(
    enabled ? 'Managed' : 'Off-limits',
    () => ({ enabled }),
    (row) => `/api/advertising/campaigns/${row.id}/live-writes`,
  )

  const allShownSelected = shown.length > 0 && shown.every((r) => sel.has(r.id))
  const toggleAll = () => setSel(allShownSelected ? new Set() : new Set(shown.map((r) => r.id)))
  const toggleOne = (id: string) => setSel((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

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

  /** Same commit-on-blur contract as the bid boxes; the server clamps to 1–10. */
  const cpcBox = (row: Row) => {
    const key = `${row.id}:cpc`
    const stored = row.cpcCeiling?.enabled ? String(row.cpcCeiling.multiple) : ''
    const value = draft[key] ?? stored
    const commit = () => {
      if (draft[key] === undefined) return
      const raw = (draft[key] ?? '').trim()
      setDraft((d) => { const n = { ...d }; delete n[key]; return n })
      if (raw === '') { void saveCpcCeiling(row, null); return }
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      void saveCpcCeiling(row, Math.max(1, Math.min(10, n)))
    }
    return (
      <span className="acr-gg-cpc">
        <input
          className="acr-gg-num narrow"
          inputMode="decimal"
          placeholder="—"
          aria-label={`CPC ceiling multiple for ${row.name}`}
          value={value}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setDraft((d) => { const n = { ...d }; delete n[key]; return n })
          }}
        />
        {(draft[key] ?? stored) !== '' && <span className="x">×</span>}
      </span>
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
        <Input
          fieldClassName="acr-gg-search"
          leadingIcon={<Search size={13} />}
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search campaigns" aria-label="Search campaigns"
        />
        <Select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Marketplace">
          <option value="">All markets</option>
          {markets.map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
        <Checkbox
          className="acr-gg-check" label="Managed only"
          checked={managedOnly} onChange={(e) => setManagedOnly(e.target.checked)}
        />
        {/* The grid's actual job, as a filter. Counts are live so the option itself says how
            much work each one represents. */}
        <Select value={gap} onChange={(e) => setGap(e.target.value as typeof gap)} aria-label="Show only campaigns with a gap">
          <option value="">Any bounds state</option>
          <option value="no-min">No min bid ({(g?.rows ?? []).filter((r) => r.minBidCents == null).length})</option>
          <option value="no-max">No max bid ({(g?.rows ?? []).filter((r) => r.maxBidCents == null).length})</option>
          <option value="no-bounds">No bounds at all ({(g?.rows ?? []).filter((r) => r.minBidCents == null && r.maxBidCents == null).length})</option>
          <option value="pinned">Pinned ({(g?.rows ?? []).filter((r) => r.pinnedDimensions.length > 0).length})</option>
          <option value="suppressed">Suppressed ({(g?.rows ?? []).filter((r) => r.suppressedAt).length})</option>
        </Select>
        {/* Filter state is always visible with a way back, per the console's standing rule. */}
        {(search || market || !managedOnly || gap) && (
          <button type="button" className="acr-gg-reset" onClick={() => { setSearch(''); setMarket(''); setManagedOnly(true); setGap('') }}>
            Reset
          </button>
        )}
        <span className="acr-gg-count">{g ? `${shown.length} shown of ${g.totals.campaigns}` : ''}</span>
      </div>

      {/* ACR.1.3c — the bulk bar. Appears only with a selection, so it never occupies space
          while you are reading. Every control writes through the same per-campaign endpoint
          the inline edits use. */}
      {selectedRows.length > 0 && (
        <div className="acr-gg-bulk" role="region" aria-label="Bulk edit">
          <strong>{selectedRows.length} selected</strong>

          <span className="acr-gg-bulk-grp">
            <label>
              Min €
              <input
                className="acr-gg-num" inputMode="decimal" value={bulkMin} placeholder="—"
                onChange={(e) => setBulkMin(e.target.value)} aria-label="Bulk minimum bid"
              />
            </label>
            <label>
              Max €
              <input
                className="acr-gg-num" inputMode="decimal" value={bulkMax} placeholder="—"
                onChange={(e) => setBulkMax(e.target.value)} aria-label="Bulk maximum bid"
              />
            </label>
            <button type="button" className="acr-btn go" disabled={!!bulkBusy} onClick={() => void applyBulkBounds()}>
              {bulkBusy === 'Bounds' ? <Loader2 size={13} className="acr-spin" /> : null}
              Set bounds
            </button>
            {/* Explicit, because an empty box must keep meaning "leave alone". */}
            <span className="acr-gg-bulk-pin">
              <button type="button" disabled={!!bulkBusy} className="off"
                title="Clear the MINIMUM bid on the selection" onClick={() => void clearBulkBounds('min')}>✕ min</button>
              <button type="button" disabled={!!bulkBusy} className="off"
                title="Clear the MAXIMUM bid on the selection" onClick={() => void clearBulkBounds('max')}>✕ max</button>
            </span>
          </span>

          <span className="acr-gg-bulk-grp">
            <span className="acr-gg-bulk-lbl">Hands off</span>
            {DIMS.map((d) => (
              <span key={d.key} className="acr-gg-bulk-pin">
                <button type="button" disabled={!!bulkBusy} title={`Pin ${d.key} on the selection. ${d.hint}`}
                  onClick={() => void applyBulkPin(d, true)}>{d.short}</button>
                <button type="button" disabled={!!bulkBusy} className="off" title={`Clear the ${d.key} pin on the selection`}
                  onClick={() => void applyBulkPin(d, false)}>✕</button>
              </span>
            ))}
          </span>

          <span className="acr-gg-bulk-grp">
            <span className="acr-gg-bulk-lbl">Automation</span>
            <button type="button" className="acr-gg-toggle on" disabled={!!bulkBusy} onClick={() => void applyBulkManaged(true)}>Managed</button>
            <button type="button" className="acr-gg-toggle" disabled={!!bulkBusy} onClick={() => void applyBulkManaged(false)}>Off-limits</button>
          </span>

          <button type="button" className="acr-gg-reset" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {!g ? <div className="acr-empty">Loading…</div> : shown.length === 0 ? (
        <div className="acr-empty">No campaigns match these filters.</div>
      ) : (
        <div className="acr-gg-scroll">
          <table className="acr-gg-tbl">
            <thead>
              <tr>
                <th className="acr-gg-selh">
                  <Checkbox
                    checked={allShownSelected} onChange={toggleAll}
                    aria-label={allShownSelected ? 'Clear selection' : 'Select every campaign shown'}
                    // Says what it will actually do: it selects the FILTERED rows, not the
                    // account. With "Managed only" on, that is 82 of 216.
                    title={`Select the ${shown.length} campaigns currently shown`}
                  />
                </th>
                <th className="acr-gg-name-h">Campaign</th>
                <th>Managed</th>
                <th title="Absolute floor, in euros. Enforced on every write to Amazon.">Min bid</th>
                <th title="Absolute ceiling, in euros. Placement modifiers stack on top, so an effective CPC can still exceed it.">Max bid</th>
                <th>Budget/day</th>
                <th>Target ACoS</th>
                <th title="A multiple of the target's HISTORICAL CPC — so it caps nothing on a keyword with no history, which is why the absolute Min/Max bid columns exist beside it. Blank = off. Clamped 1–10.">CPC ceiling</th>
                <th title="Hands off, per dimension. Enforced at the write gate.">Hands off</th>
                <th>Suppressed</th>
                <th title="Rules bound to this campaign by dragging one onto it.">Bound rules</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={`${saving === r.id ? 'saving' : ''} ${sel.has(r.id) ? 'sel' : ''}`.trim() || undefined}>
                  <td className="acr-gg-sel">
                    <Checkbox
                      checked={sel.has(r.id)} onChange={() => toggleOne(r.id)}
                      aria-label={`Select ${r.name}`}
                    />
                  </td>
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
                  <td>{cpcBox(r)}</td>
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
