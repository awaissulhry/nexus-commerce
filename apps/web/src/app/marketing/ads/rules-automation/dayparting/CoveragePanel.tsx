'use client'

/**
 * RDX/C1 — what this account is NOT covering.
 *
 * The list below answers "what do my schedules do". This answers the more expensive question:
 * which campaigns are spending with no rank control at all. An uncovered campaign isn't idle —
 * it runs on whatever bid it was last left on, with nothing holding it in peak hours and nothing
 * easing it off at 3am.
 *
 * Collapsed by default to a single honest line, because on a healthy account this should be
 * boring. It expands to the uncovered campaigns ranked by spend, so the first thing you see is
 * the money at stake rather than an alphabetical list of names.
 *
 * "Governed" is counted separately from "covered": a campaign run by a Rank Director family plan
 * is deliberately controlled, just not by a schedule. Folding it into the gap would manufacture
 * work that doesn't exist.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { ChevronDown, ShieldCheck, Plus } from 'lucide-react'

import { getBackendUrl } from '@/lib/backend-url'
import { Listbox } from '@/design-system/components'

interface OpenCampaign { id: string; name: string; marketplace: string | null; status: string; spendCents: number; impressions: number; clicks: number }
interface Coverage {
  total: number; covered: number; governed: number; uncovered: number
  windowDays: number; uncoveredSpendCents: number; truncated: number; items: OpenCampaign[]
}
export interface ScheduleOption { value: string; label: string }

/**
 * C2 — structural integrity, folded into the coverage strip rather than given a panel of its own.
 * Coverage answers "what is not managed"; this answers "what is managed but broken". Same question
 * shape, same place to look.
 *
 * Each finding is something that should be impossible, so a non-empty result is a bug in the data
 * rather than an opinion about it — which is why a clean result says so in one word instead of
 * being silent. A check you cannot see is a check you stop trusting.
 */
interface Integrity {
  clean: boolean; issues: number
  checked: { groups: number; schedules: number }
  emptyGroups: Array<{ id: string; name: string }>
  doubleHeld: Array<{ campaignId: string; schedules: number }>
  ungrouped: Array<{ id: string; campaignId: string; enabled: boolean }>
  archivedHolding: Array<{ scheduleId: string; campaignId: string; campaignName: string | null }>
  missingCampaign: Array<{ scheduleId: string; campaignId: string }>
}

const eur = (cents: number) => `€${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export function CoveragePanel({ market, schedules, onChanged, days = 30 }: {
  market: string
  /**
   * FB.3d — the spend window, in days, from the page's shared header range (was a hardcoded 30).
   * The server clamps 1–90; the caller passes `min(90, rangeDays)` so "€X spent in N days" is the
   * N the operator actually picked, not a number that ignores the control beside it.
   */
  days?: number
  /** Schedules a campaign can be added to (id → name). */
  schedules: ScheduleOption[]
  /** Fired after a successful add so the list above can refresh its member counts. */
  onChanged?: () => void
}) {
  const [data, setData] = useState<Coverage | null>(null)
  const [integrity, setIntegrity] = useState<Integrity | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({ days: String(Math.max(1, Math.min(90, Math.round(days)))), limit: '50' })
    if (market && market !== 'all') qs.set('marketplace', market)
    return fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/coverage?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setData(j && typeof j.total === 'number' ? j : null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [market, days])

  useEffect(() => { void load(); setSel(new Set()); setMsg('') }, [load])

  // Independent of the market filter: a structural fault is a fault regardless of which market you
  // happen to be looking at.
  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/integrity`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setIntegrity(typeof j?.issues === 'number' ? j : null) })
      .catch(() => { if (alive) setIntegrity(null) })
    return () => { alive = false }
  }, [])

  const pct = useMemo(() => {
    if (!data || data.total === 0) return 0
    return Math.round(((data.covered + data.governed) / data.total) * 100)
  }, [data])

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const addToSchedule = async () => {
    if (!target || !sel.size || busy) return
    setBusy(true); setMsg('')
    try {
      // A dedicated endpoint, not a PATCH: sending campaignIds alone through the group PATCH would
      // wipe the schedule's windows and baseline (see the route's comment).
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${target}/campaigns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignIds: [...sel] }),
      })
      if (!r.ok) { setMsg('Could not add those campaigns — please retry.'); return }
      const name = schedules.find((s) => s.value === target)?.label ?? 'the schedule'
      setMsg(`Added ${sel.size} campaign${sel.size === 1 ? '' : 's'} to ${name}. They inherit its windows and baseline, and its enabled state — so a paused schedule still runs nothing.`)
      setSel(new Set())
      await load()
      onChanged?.()
    } catch { setMsg('Request failed — please retry.') }
    finally { setBusy(false) }
  }

  if (loading && !data) return null
  if (!data || data.total === 0) return null

  const clean = data.uncovered === 0

  return (
    <div className={`h10-cov ${clean ? 'ok' : ''}`}>
      <Button variant="quiet" inline className="h10-cov-hd" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {clean ? <ShieldCheck size={15} className="ic" /> : <span className="dot" aria-hidden="true" />}
        <span className="ttl">
          <b>{data.covered + data.governed} of {data.total}</b> campaigns are under rank control
          {data.governed > 0 && <span className="sub"> · {data.governed} by a family plan</span>}
        </span>
        {!clean && (
          <span className="gap">
            {data.uncovered} uncovered
            {data.uncoveredSpendCents > 0 && <> · <b>{eur(data.uncoveredSpendCents)}</b> spent in {data.windowDays} days</>}
          </span>
        )}
        {integrity && (
          integrity.clean
            ? <span className="h10-cov-int ok" title={`No structural faults across ${integrity.checked.groups} schedules and ${integrity.checked.schedules} member rows — no empty groups, no campaign held twice, no orphaned or archived-but-enabled rows.`}>structure clean</span>
            : <span className="h10-cov-int bad" title="Structural faults — expand for detail">{integrity.issues} structural issue{integrity.issues === 1 ? '' : 's'}</span>
        )}
        <span className="grow" />
        <span className="bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        <span className="pct">{pct}%</span>
        {!clean && <ChevronDown size={15} className={`chev ${open ? 'on' : ''}`} />}
      </Button>

      {integrity && !integrity.clean && (
        <div className="h10-cov-int-list">
          {integrity.emptyGroups.length > 0 && <div><b>{integrity.emptyGroups.length} schedule{integrity.emptyGroups.length === 1 ? '' : 's'} with no campaigns</b> — cannot run: {integrity.emptyGroups.slice(0, 4).map((g) => g.name).join(', ')}</div>}
          {integrity.doubleHeld.length > 0 && <div><b>{integrity.doubleHeld.length} campaign{integrity.doubleHeld.length === 1 ? '' : 's'} held by more than one schedule</b> — the engine is competing with itself.</div>}
          {integrity.ungrouped.length > 0 && <div><b>{integrity.ungrouped.length} schedule row{integrity.ungrouped.length === 1 ? '' : 's'} with no parent</b> — invisible in this list but still read by the rank loop.</div>}
          {integrity.archivedHolding.length > 0 && <div><b>{integrity.archivedHolding.length} archived campaign{integrity.archivedHolding.length === 1 ? '' : 's'} holding an enabled schedule</b> — reads as working, can never run.</div>}
          {integrity.missingCampaign.length > 0 && <div><b>{integrity.missingCampaign.length} schedule{integrity.missingCampaign.length === 1 ? '' : 's'} pointing at a campaign that no longer exists.</b></div>}
        </div>
      )}

      {open && !clean && (
        <div className="h10-cov-b">
          <div className="h10-cov-note">
            Ranked by spend over the last {data.windowDays} days. These campaigns hold no rank schedule and
            no family plan — they run on whatever bid was last set.
          </div>

          <div className="h10-cov-list">
            {data.items.map((c) => (
              <label key={c.id} className={`h10-cov-r ${sel.has(c.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} />
                <span className="nm" title={c.name}>{c.name}</span>
                {c.marketplace && <span className="mk">{c.marketplace}</span>}
                <span className="sp">{c.spendCents > 0 ? eur(c.spendCents) : '—'}</span>
              </label>
            ))}
          </div>

          {data.truncated > 0 && (
            <div className="h10-cov-note muted">+{data.truncated} more uncovered campaign{data.truncated === 1 ? '' : 's'} below this list&rsquo;s top 50 by spend.</div>
          )}

          <div className="h10-cov-act">
            <Listbox
              width={280}
              options={[{ value: '', label: schedules.length ? 'Add selected to schedule…' : 'No schedules to add to yet' }, ...schedules]}
              value={target}
              onChange={setTarget}
              ariaLabel="Schedule to add the selected campaigns to"
              searchable
              searchPlaceholder="Search schedules…"
            />
            <Button variant="primary" disabled={!target || !sel.size || busy} onClick={() => void addToSchedule()}>
              <Plus size={13} /> {busy ? 'Adding…' : `Add ${sel.size || ''}`.trim()}
            </Button>
            {msg && <span className="h10-cov-msg">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
