/**
 * 🔴 (2026-10-26) — "Save Changes" on a running hourly bid plan switched it off: on edit the Control radio stayed on
 * its Manual default and every save sent `enabled`. Here the radio opens on what the plan IS, the builder cannot save
 * while that is not known, and an edit sends on/off only when the person changed Control.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { controlForPlan, enabledToSend } from './planControl'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const builder = read('./RankGoalBuilder.tsx')
const body = read('./RankPlanBody.tsx')

describe('the premise', () => {
  it('a save sends enabled only when it is said — absent, the API keeps the plan as it is', () => {
    expect(body).not.toMatch(/targetOverrides: perCamp, enabled, timezone/)
    expect(body).toContain("...(typeof enabled === 'boolean' ? { enabled } : {})")
    expect(body).toContain('save: (enabled?: boolean) => Promise<boolean | undefined>')
  })
})

describe('controlForPlan — what Control shows for a saved plan', () => {
  it('on is Automate, off is Manual', () => {
    expect(controlForPlan({ enabled: true })).toBe('automate')
    expect(controlForPlan({ enabled: false })).toBe('manual')
  })
  it('a legacy AdSchedule row reads the same way', () => {
    expect(controlForPlan({ id: 's1', campaignId: 'c1', enabled: true })).toBe('automate')
  })
  it('🔴 nothing is guessed: no row, an error body or a non-boolean enabled is null', () => {
    expect(controlForPlan(null)).toBeNull()
    expect(controlForPlan(undefined)).toBeNull()
    expect(controlForPlan({ error: 'not found' })).toBeNull()
    expect(controlForPlan({ enabled: 'true' })).toBeNull()
    expect(controlForPlan([])).toBeNull()
  })
})

describe('enabledToSend — on/off goes out only when the person said it', () => {
  it('🔴 an edit with Control as it was read sends nothing: a plan switched on elsewhere stays on', () => {
    expect(enabledToSend(true, 'manual', 'manual')).toBeUndefined()
    expect(enabledToSend(true, 'automate', 'automate')).toBeUndefined()
  })
  it('an edit where the person changed Control sends their choice', () => {
    expect(enabledToSend(true, 'automate', 'manual')).toBe(true)
    expect(enabledToSend(true, 'manual', 'automate')).toBe(false)
    // the read failed and the person picked one themselves
    expect(enabledToSend(true, 'manual', null)).toBe(false)
  })
  it('a create always says it', () => {
    expect(enabledToSend(false, 'manual', null)).toBe(false)
    expect(enabledToSend(false, 'automate', null)).toBe(true)
    expect(enabledToSend(false, 'manual', 'manual')).toBe(false)
  })
  it('no Control, nothing to send', () => {
    expect(enabledToSend(true, null, 'automate')).toBeUndefined()
    expect(enabledToSend(false, null, null)).toBeUndefined()
  })
})

describe('RankGoalBuilder uses it', () => {
  it('🔴 on edit Control opens unread, never on the Manual default', () => {
    expect(builder).not.toMatch(/useState<'manual' \| 'automate'>\('manual'\)/)
    expect(builder).toContain("useState<PlanControl | null>(isEdit ? null : 'manual')")
  })
  it('both loaders read the plan state and keep a radio picked while it loaded', () => {
    expect(builder).toContain('controlForPlan(g)')
    expect(builder).toContain('controlForPlan(sched)')
    expect(builder.match(/setControl\(\(cur\) => cur \?\? ctl\)/g)?.length).toBe(2)
    expect(builder.match(/setControlRead\(ctl\)/g)?.length).toBe(2)
    expect(builder).toContain("if (!sched) { setControl((cur) => cur ?? 'manual'); return }")
  })
  it('🔴 no save while Control is unread: both Save buttons wait for it', () => {
    expect(builder).toContain('const canSave = planStatus.valid && !planStatus.busy && !!control')
    expect(builder.match(/disabled=\{!canSave\}/g)?.length).toBe(2)
    expect(builder).not.toContain('disabled={!planStatus.valid || planStatus.busy}')
  })
  it('🔴 create sends on/off only when said (a ?scheduleId save is a create), then holds the state the save left', () => {
    expect(builder).toContain('if (!control) return')
    expect(builder).toContain('planRef.current?.save(enabledToSend(!!groupId, control, controlRead))')
    expect(builder).not.toContain("planRef.current?.save(control === 'automate')")
    expect(builder).toMatch(/if \(typeof on === 'boolean'\) \{ const c = on \? 'automate' : 'manual'; setControl\(c\); setControlRead\(c\) \}/)
  })
  it('a note under Control says why the save waits', () => {
    expect(builder).toContain('{controlUnread ? CONTROL_UNREAD : CONTROL_READING}')
  })
})

describe('6a — Sponsored Products only on the builder', () => {
  it('the picker offers Sponsored Products only (it tags its list and flags older picks)', () => {
    expect(builder).toContain("const PLAN_AD_PRODUCTS = ['SP'] as const")
    expect(builder).toMatch(/<CampaignSection [^>]*adProducts=\{PLAN_AD_PRODUCTS\}/)
  })
  it('a portfolio scope adds only its Sponsored Products campaigns, and its hint says so', () => {
    expect(builder).toContain('allCamps.filter((c) => c.portfolioId === pid && campaignInScope(c, { adProducts: PLAN_AD_PRODUCTS }))')
    expect(builder).toContain('Covers every Sponsored Products campaign in this portfolio')
    expect(builder).not.toContain('Covers every campaign in this portfolio')
  })
  it('🔴 the picker\'s warning says a save leaves them out, and a save drops them from the picks', () => {
    expect(builder).toMatch(/<CampaignSection [^>]*holder="hourlyPlan"/)
    expect(builder).toContain('setSelCampaigns((cur) => cur.filter((c) => !ids.includes(c.id)))')
    expect(builder).toMatch(/<RankPlanBody [^>]*onLeftOut=\{dropLeftOut\}/)
    expect(body).toContain('if (r.leftOut.length) onLeftOut?.(r.leftOut.map(c => c.id))')
  })
})
