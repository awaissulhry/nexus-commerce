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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X, Video } from 'lucide-react'
import { ScheduleBuilder } from '../_schedule/ScheduleBuilder'
import { CampaignSection, type SchedCampaign } from '../_schedule/CampaignSection'
import { RankPlanBody } from './RankPlanBody'

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
]

export function RankGoalBuilder() {
  const router = useRouter()
  const sp = useSearchParams()
  const scheduleId = sp.get('scheduleId')
  const isEdit = !!scheduleId
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
          {/* The rank plan owns its own Save / Publish / Discard (in the §3 plan header below). */}
        </div>
      </header>

      <div className="h10-rb-body" ref={scrollRef}>
        <nav className="h10-rb-nav" role="tablist" aria-label="Rank schedule steps">
          {STEPS.map((s) => (
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
              <CampaignSection selected={selCampaigns} onAdd={addCampaign} onAddMany={addCampaigns} onRemove={removeCampaign} onClear={clearCampaigns} />
            </section>

            <section id="rgd-plan" className="h10-rb-sec">
              <h2>Your rank goal &amp; schedule</h2>
              <p className="h10-rb-desc">Hold this rank, on this schedule — Save, Publish, or Discard.</p>
              <RankPlanBody campaigns={selCampaigns} name={name} />
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}
