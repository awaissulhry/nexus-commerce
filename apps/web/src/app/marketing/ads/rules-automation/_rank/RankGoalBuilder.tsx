'use client'

/**
 * RGD.0 — Rank Goal & Schedule builder (the NEW default for the Dayparting Schedule rule type).
 *
 * `/builder/dayparting-schedule` now opens this rank-goal authoring surface by default; a segmented
 * toggle in the top bar switches to the UNCHANGED classic dayparting builder (?style=classic). The
 * rank builder is multi-campaign: pick N campaigns, then author ONE rank plan applied across them
 * (the §2 "Your rank goal & schedule" cockpit lands in RGD.1; this phase is the shell + picker).
 *
 * Re-skinned to the H10 builder chrome (h10-rb-* / cp-*) so it's seamless with the other builders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X, Video, AlertTriangle } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { ScheduleBuilder } from '../_schedule/ScheduleBuilder'
import { CampaignSection, toCampaign, type SchedCampaign } from '../_schedule/CampaignSection'
import { RankPlanBody, type RankPlanHandle, type RankPlanStatus } from './RankPlanBody'
import { detectScheduleConflicts, type MembershipMap } from './scheduleConflicts'
import { ScheduleVersionsSection } from '../dayparting/ScheduleVersions'
import { ArmPreview, type RankTargetLite } from '../dayparting/ArmPreview'
import { getBackendUrl } from '@/lib/backend-url'

// Adtomic-style atom mark — same glyph the other builders use in the top bar.
function AtomMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ic">
      <g transform="rotate(45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <g transform="rotate(-45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <circle cx="12" cy="12" r="2.5" fill="#0b1f44" />
    </svg>
  )
}

// The Rank-goal ↔ Dayparting segmented control, shown in both top bars so you can switch either way.
function StyleToggle({ value, onChange }: { value: 'rank' | 'classic'; onChange: (v: 'rank' | 'classic') => void }) {
  return (
    <span className="h10-rgd-toggle" role="tablist" aria-label="Schedule style">
      <button type="button" role="tab" aria-selected={value === 'rank'} className={value === 'rank' ? 'on' : ''} onClick={() => onChange('rank')}>Rank goal</button>
      <button type="button" role="tab" aria-selected={value === 'classic'} className={value === 'classic' ? 'on' : ''} onClick={() => onChange('classic')}>Dayparting</button>
    </span>
  )
}

const STEPS = [
  { id: 'name', label: 'Schedule Name' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'plan', label: 'Rank goal & schedule' },
  { id: 'control', label: 'Control' },
]
// HX.8 — the history step only exists once the schedule does: a schedule being created for the
// first time has nothing to show, and an empty step in the nav is worse than no step.
const HISTORY_STEP = { id: 'history', label: 'Change history' }

export function RankGoalBuilder() {
  const router = useRouter()
  const sp = useSearchParams()
  const groupId = sp.get('groupId')
  const scheduleId = sp.get('scheduleId')
  const isEdit = !!groupId || !!scheduleId
  const style: 'rank' | 'classic' = sp.get('style') === 'classic' ? 'classic' : 'rank' // rank is the new default
  const setStyle = useCallback((s: 'rank' | 'classic') => {
    const next = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : sp.toString())
    if (s === 'classic') next.set('style', 'classic'); else next.delete('style')
    router.replace(`/marketing/ads/rules-automation/builder/dayparting-schedule?${next.toString()}`, { scroll: false })
  }, [router, sp])
  const close = useCallback(() => router.push('/marketing/ads/rules-automation'), [router])

  const toggle = <StyleToggle value={style} onChange={setStyle} />

  // Classic mode renders the untouched dayparting builder, with the toggle injected into its top bar.
  // (RGD.0 keeps the classic builder byte-identical apart from receiving the toggle slot.)
  const [name, setName] = useState('')
  const [selCampaigns, setSelCampaigns] = useState<SchedCampaign[]>([])
  const addCampaign = (c: SchedCampaign) => setSelCampaigns((cur) => (cur.some((x) => x.id === c.id) ? cur : [...cur, c]))
  const addCampaigns = (cs: SchedCampaign[]) => setSelCampaigns((cur) => { const have = new Set(cur.map((x) => x.id)); return [...cur, ...cs.filter((c) => !have.has(c.id))] })
  const removeCampaign = (id: string) => setSelCampaigns((cur) => cur.filter((c) => c.id !== id))
  const clearCampaigns = () => setSelCampaigns([])

  // Phase 5 — portfolio scope. Binding the schedule to a portfolio auto-includes that portfolio's
  // campaigns (and the backend re-unions the portfolio's current campaigns on every save, so ones
  // added to the portfolio later get picked up). None = pick campaigns manually.
  const [portfolios, setPortfolios] = useState<Array<{ id: string; name: string }>>([])
  const [allCamps, setAllCamps] = useState<SchedCampaign[]>([])
  const [portfolioScope, setPortfolioScope] = useState('')
  const [memberships, setMemberships] = useState<MembershipMap>({})
  useEffect(() => {
    let alive = true
    ;(async () => {
      const [cj, pj, mj] = await Promise.all([
        fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`${getBackendUrl()}/api/advertising/portfolios`).then((r) => r.json()).catch(() => ({})),
        fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/memberships`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: {} })),
      ])
      if (!alive) return
      setMemberships((mj?.items ?? {}) as MembershipMap)
      const camps = (Array.isArray(cj?.items) ? cj.items : Array.isArray(cj) ? cj : []) as Array<Record<string, unknown>>
      setAllCamps(camps.map(toCampaign))
      // /api/advertising/portfolios returns { portfolios: [{ portfolioId, name }] } — the id key is
      // portfolioId (the Amazon external id, matching Campaign.portfolioId), not `id`.
      const praw = (pj.portfolios ?? pj.items ?? (Array.isArray(pj) ? pj : [])) as Array<{ portfolioId?: string | number; id?: string | number; name?: string }>
      setPortfolios((Array.isArray(praw) ? praw : []).map((x) => { const pid = String(x.portfolioId ?? x.id ?? ''); return { id: pid, name: String(x.name ?? pid) } }).filter((p) => p.id))
    })()
    return () => { alive = false }
  }, [])
  // Pick a portfolio → add all its campaigns (least-destructive: keeps any manual adds; the backend
  // unions the portfolio's current campaigns on save regardless). Clearing keeps the campaigns but
  // drops the binding.
  const applyPortfolioScope = (pid: string) => {
    setPortfolioScope(pid)
    if (!pid) return
    const inPf = allCamps.filter((c) => c.portfolioId === pid)
    if (inPf.length) addCampaigns(inPf)
  }

  // Phase 6 guardrail — selected campaigns already held by ANOTHER schedule. Saving moves them here
  // (one campaign → one schedule), so we surface them before the user commits.
  const conflicts = useMemo(() => {
    const raw = detectScheduleConflicts(selCampaigns.map((c) => c.id), memberships, groupId ?? undefined)
    const nameById = new Map(selCampaigns.map((c) => [c.id, c.name]))
    return raw.map((x) => ({ ...x, campaignName: nameById.get(x.campaignId) ?? x.campaignId }))
  }, [selCampaigns, memberships, groupId])

  // Edit mode: ?groupId opens an existing NAMED schedule group — load its name + ALL member campaigns
  // so the builder repopulates as one unit (was blank before, forcing you to re-add campaigns).
  // RankPlanBody then loads windows/baseline/overrides from the members. ?scheduleId is a legacy
  // single-schedule fallback for any old links.
  // DPS.1 — ids this session minted itself. When the plan body creates a group we push ?groupId= into
  // the URL so the page is shareable and refresh-safe; that would otherwise re-fire the loader below
  // and re-fetch name + members we already hold. Skipping our own id keeps the save silent.
  const [savedPlan, setSavedPlan] = useState<{ windows: unknown[]; baselineKey: string } | null>(null)
  const selfCreated = useRef<string | null>(null)
  const onGroupCreated = useCallback((id: string) => {
    selfCreated.current = id
    const next = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : sp.toString())
    next.set('groupId', id)
    router.replace(`/marketing/ads/rules-automation/builder/dayparting-schedule?${next.toString()}`, { scroll: false })
  }, [router, sp])

  useEffect(() => {
    if (!groupId && !scheduleId) return
    if (groupId && selfCreated.current === groupId) return // just created here — state is already current
    let alive = true
    ;(async () => {
      try {
        const cj = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`).then((r) => r.json()).catch(() => ({ items: [] }))
        if (!alive) return
        const camps = (Array.isArray(cj?.items) ? cj.items : Array.isArray(cj) ? cj : []) as Array<Record<string, unknown>>
        const byId = new Map(camps.map((c) => [String(c.id), c]))
        if (groupId) {
          const g = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
          if (!alive || !g?.id) return
          if (g.name) setName(String(g.name))
          // E1 — the saved plan, read from the server. The live in-editor plan belongs to
          // RankPlanBody, which is off-limits, so the preview shows what is SAVED and says so.
          setSavedPlan({ windows: Array.isArray(g.windows) ? g.windows : [], baselineKey: String(g.defaultTargetKey ?? '') })
          const ids = (Array.isArray(g.campaignIds) ? g.campaignIds : []) as unknown[]
          const sel = ids.map((cid) => byId.get(String(cid))).filter(Boolean).map((c) => toCampaign(c as Record<string, unknown>))
          if (sel.length) setSelCampaigns(sel)
          if (g.portfolioId) setPortfolioScope(String(g.portfolioId))
        } else if (scheduleId) {
          const sj = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => [])
          if (!alive) return
          const scheds = (Array.isArray(sj) ? sj : Array.isArray(sj?.items) ? sj.items : []) as Array<Record<string, unknown>>
          const sched = scheds.find((s) => String(s.id) === scheduleId)
          if (!sched) return
          if (sched.name) setName(String(sched.name))
          const camp = byId.get(String(sched.campaignId))
          if (camp) setSelCampaigns([toCampaign(camp)])
        }
      } catch { /* fail soft */ }
    })()
    return () => { alive = false }
  }, [groupId, scheduleId])

  // HX.8 — rank-target swatches for the change-history week shapes. Fetched here in the SHELL, not
  // read out of RankPlanBody: that section is off-limits, and it owns its own copy for the editor.
  const [tmeta, setTmeta] = useState<Record<string, { name: string; color: string | null }>>({})
  // E1 needs the guardrails too (ceiling, ACoS cap, max CPC), not just the swatch.
  const [targetRows, setTargetRows] = useState<RankTargetLite[]>([])
  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/rank-targets`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        const m: Record<string, { name: string; color: string | null }> = {}
        for (const t of (Array.isArray(j?.items) ? j.items : []) as Array<{ key?: string; name?: string; color?: string | null }>) {
          if (t.key) m[t.key] = { name: String(t.name ?? t.key), color: t.color ?? null }
        }
        setTmeta(m)
        setTargetRows((Array.isArray(j?.items) ? j.items : []) as RankTargetLite[])
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const palette = useMemo(() => ({
    color: (k: string) => tmeta[k]?.color ?? null,
    name: (k: string) => tmeta[k]?.name ?? k,
  }), [tmeta])

  // RGD.7 — the builder owns ONE action + a Manual/Automate Control section, matching every other
  // rule type. The rank plan body exposes save(enabled) via a ref + reports its status up.
  const [control, setControl] = useState<'manual' | 'automate'>('manual')
  const [planStatus, setPlanStatus] = useState<RankPlanStatus>({ valid: false, busy: false, dirty: false, saved: false })
  const planRef = useRef<RankPlanHandle>(null)
  const create = useCallback(async () => { await planRef.current?.save(control === 'automate') }, [control])
  const createLabel = planStatus.busy ? 'Saving…' : planStatus.saved ? 'Save Changes' : 'Create Schedule'

  // scroll-spy step nav (mirrors the other builders)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('name')
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const top = el.scrollTop + 140
      let cur = STEPS[0].id
      for (const s of STEPS) { const node = document.getElementById(`rgd-${s.id}`); if (node && node.offsetTop <= top) cur = s.id }
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  const goto = (id: string) => { const node = document.getElementById(`rgd-${id}`); const el = scrollRef.current; if (node && el) el.scrollTo({ top: node.offsetTop - 24, behavior: 'smooth' }) }

  if (style === 'classic') return <ScheduleBuilder slug="dayparting-schedule" modeToggle={toggle} />

  return (
    <div className="h10-rb h10-rgd">
      <header className="h10-rb-top">
        <div className="l">
          <button type="button" className="x" aria-label="Close" onClick={close}><X size={19} /></button>
          <AtomMark size={20} />
          <b>{isEdit ? 'Edit' : 'Create'} Rank Schedule</b>
          {toggle}
        </div>
        <div className="r">
          <button type="button" className="learn"><Video size={15} /> Learn</button>
          <button type="button" className="h10-rb-create" disabled={!planStatus.valid || planStatus.busy} onClick={() => void create()}>{createLabel}</button>
        </div>
      </header>

      <div className="h10-rb-body" ref={scrollRef}>
        <nav className="h10-rb-nav" role="tablist" aria-label="Rank schedule steps">
          {(groupId ? [...STEPS, HISTORY_STEP] : STEPS).map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={active === s.id} className={`h10-rb-step ${active === s.id ? 'on' : ''}`} onClick={() => goto(s.id)}>{s.label}</button>
          ))}
        </nav>

        <main className="h10-rb-main">
          <div className="h10-rb-wrap">
            <section id="rgd-name" className="h10-rb-sec">
              <h2>Schedule Name</h2>
              <input className="h10-rb-input rn" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter a schedule name" aria-label="Schedule name" />
            </section>

            <section id="rgd-campaigns" className="h10-rb-sec">
              <h2>Campaigns</h2>
              <p className="h10-rb-desc">Select the campaigns this rank plan should hold — one plan, applied across all of them.</p>
              <div className="h10-rb-pfscope">
                <label htmlFor="rgd-pfscope">Portfolio scope <span className="opt">(optional)</span></label>
                {/* OS.4 — was a native dropdown: no search, and an account with many portfolios made
                    this a scroll-hunt at exactly the moment you are creating a schedule. H10Select
                    brings the shared ranked search and matches the rest of the console. */}
                <H10Select
                  width={320}
                  options={[{ value: '', label: 'None — pick campaigns manually' }, ...portfolios.map((p) => ({ value: p.id, label: p.name }))]}
                  value={portfolioScope}
                  onChange={applyPortfolioScope}
                  ariaLabel="Portfolio scope"
                  searchable
                  searchPlaceholder="Search portfolios…"
                />
                {portfolioScope && <span className="hint">Covers every campaign in this portfolio — campaigns added to it later are included on save.</span>}
              </div>
              <CampaignSection selected={selCampaigns} onAdd={addCampaign} onAddMany={addCampaigns} onRemove={removeCampaign} onClear={clearCampaigns} />
              {conflicts.length > 0 && (
                <div className="h10-rb-conflict" role="alert">
                  <AlertTriangle size={15} />
                  <div className="body">
                    <b>{conflicts.length} campaign{conflicts.length === 1 ? '' : 's'} already held by another schedule.</b>
                    <span> Saving moves {conflicts.length === 1 ? 'it' : 'them'} here — {conflicts.length === 1 ? 'it leaves' : 'they leave'} the other schedule (one campaign runs in one schedule).</span>
                    <ul>
                      {conflicts.slice(0, 6).map((c) => <li key={c.campaignId}><span className="cn">{c.campaignName}</span> → <span className="gn">{c.groupName}</span></li>)}
                      {conflicts.length > 6 && <li>+{conflicts.length - 6} more</li>}
                    </ul>
                  </div>
                </div>
              )}
            </section>

            <section id="rgd-plan" className="h10-rb-sec">
              <h2>Your rank goal &amp; schedule</h2>
              <p className="h10-rb-desc">Hold this rank, on this schedule.</p>
              <RankPlanBody ref={planRef} campaigns={selCampaigns} name={name} groupId={groupId ?? undefined} portfolioId={portfolioScope || undefined} onStatus={setPlanStatus} onGroupCreated={onGroupCreated} />
            </section>

            <section id="rgd-control" className="h10-rb-sec">
              <h2>Control</h2>
              <p className="h10-rb-desc">Choose how this rank plan runs once you create it.</p>
              <div className="h10-rb-card control">
                <label className={`h10-rb-ctrl ${control === 'manual' ? 'on' : ''}`}>
                  <input type="radio" name="rgdcontrol" checked={control === 'manual'} onChange={() => setControl('manual')} />
                  <span className="b"><span className="t">Manual</span><span className="d">Save the plan but don&apos;t run it — nothing changes on Amazon until you switch it to Automate.</span></span>
                </label>
                <label className={`h10-rb-ctrl ${control === 'automate' ? 'on' : ''}`}>
                  <input type="radio" name="rgdcontrol" checked={control === 'automate'} onChange={() => setControl('automate')} />
                  <span className="b"><span className="t">Automate</span><span className="d">Have the engine hold this rank automatically on its cadence (real Amazon pushes still honour each campaign&apos;s write-gate).</span></span>
                </label>
              </div>
              {/* E1/E3 — what arming this actually does, at the point the choice is made. */}
              <ArmPreview
                groupId={groupId ?? undefined}
                campaignIds={selCampaigns.map((c) => c.id)}
                windows={savedPlan?.windows ?? []}
                baselineKey={savedPlan?.baselineKey ?? ''}
                targets={targetRows}
                showSchedule={!!savedPlan}
              />
              <p className="h10-rb-hint-note">Removing a campaign here, or deleting the schedule, stops the engine holding that rank — current Amazon bids stay as last set (nothing is reverted).</p>
            </section>

            {/* HX.8 — what the OPERATOR changed, right where the plan is edited. Distinct from the
                list page's Activity drawer, which shows what the ENGINE did to Amazon. */}
            {groupId && <ScheduleVersionsSection groupId={groupId} palette={palette} />}

            <div className="h10-rb-foot">
              <button type="button" className="h10-rb-btn ghost" onClick={close}>Cancel</button>
              <span className="grow" />
              <button type="button" className="h10-rb-create" disabled={!planStatus.valid || planStatus.busy} onClick={() => void create()}>{createLabel}</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
