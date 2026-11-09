import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { PRODUCT_SMV_PERMISSIONS } from './permissions'
import {
  decisionRefusal,
  inForceOn,
  isGoverned,
  leadMinutes,
  minutesBySize,
  minutesFromAllowances,
  planProposal,
  planSizeTimes,
  rejectionProblems,
  settlementOn,
  settles,
  sideMinutesOf,
  sizesBelowZero,
  smvOf,
  stepRunSourceOf,
  typedSmvRefusal,
  typedStepRefusal,
  waitingToTakeEffect,
  type VersionFacts,
} from './rules'

const minutes = { basicMinutes: '12.5', personalPct: '5', fatiguePct: '4', delayPct: '3', standardMinutes: '14' }
const version = (number: number, status: VersionFacts['status'], effectiveFrom: string, extra: Partial<VersionFacts> = {}): VersionFacts => ({
  id: `v${number}`,
  number,
  status,
  effectiveFrom,
  proposedById: 'anna',
  decided: status === 'APPROVED' || status === 'REJECTED',
  ...minutes,
  ...extra,
})

describe('the SMV from basic minutes and allowances (PRD-111)', () => {
  it('is basic × (1 + allowances / 100), to the thousandth, a half away from 0 (the database rounding)', () => {
    expect(smvOf({ basicMinutes: '12.5', personalPct: '5', fatiguePct: '4', delayPct: '3' })).toBe('14')
    expect(smvOf({ basicMinutes: '12', personalPct: '5', fatiguePct: '4', delayPct: '3' })).toBe('13.44')
    // 0.125 × 1.1 = 0.1375 → 0.138 (half away from 0), 1.111 × 1.05 = 1.16655 → 1.167
    expect(smvOf({ basicMinutes: '0.125', personalPct: '10', fatiguePct: '0', delayPct: '0' })).toBe('0.138')
    expect(smvOf({ basicMinutes: '1.111', personalPct: '2.5', fatiguePct: '2.5', delayPct: '0' })).toBe('1.167')
    expect(smvOf({ basicMinutes: '3', personalPct: '0', fatiguePct: '0', delayPct: '0' })).toBe('3')
  })

  it('checks basic minutes like a typed SMV and each allowance from 0 to below 100 with at most 4 decimals', () => {
    expect(minutesFromAllowances({ basicMinutes: '12.5000', personalPct: '5.0000', fatiguePct: '4', delayPct: '3' })).toEqual({ ok: true, minutes: { basicMinutes: '12.5', personalPct: '5', fatiguePct: '4', delayPct: '3', standardMinutes: '14' } })
    expect(minutesFromAllowances({ basicMinutes: '0.16667', personalPct: '0', fatiguePct: '0', delayPct: '0' })).toMatchObject({ ok: true, minutes: { basicMinutes: '0.167', standardMinutes: '0.167' } })
    const bad = minutesFromAllowances({ basicMinutes: '0', personalPct: '100', fatiguePct: '-1', delayPct: '1.23456' })
    expect(bad.ok).toBe(false)
    expect(bad.ok ? [] : bad.issues.map((issue) => issue.path)).toEqual(['basicMinutes', 'personalPct', 'fatiguePct', 'delayPct'])
    const tooBig = minutesFromAllowances({ basicMinutes: '9999999', personalPct: '99', fatiguePct: '0', delayPct: '0' })
    expect(tooBig.ok ? null : tooBig.issues[0]!.message).toMatch(/would be 19899998.01: at most 7 digits/)
  })
})

describe('versions in force and settling (PRD-113)', () => {
  const v1 = version(1, 'APPROVED', '2026-11-01')
  const v2 = version(2, 'APPROVED', '2026-12-01', { standardMinutes: '13.44', basicMinutes: '12' })
  const v3 = version(3, 'PROPOSED', '2026-12-15', { decided: false })

  it('the one in force on a day is the approved one with the latest first day on or before it; none: the operation keeps its own', () => {
    const versions = [v3, v2, v1]
    expect(inForceOn(versions, '2026-10-31')).toBeNull()
    expect(inForceOn(versions, '2026-11-09')?.number).toBe(1)
    expect(inForceOn(versions, '2026-12-01')?.number).toBe(2)
    expect(inForceOn(versions, '2027-01-01')?.number).toBe(2)
    // A version superseded after a decision was in force once; one replaced before any decision never was.
    expect(inForceOn([{ ...v1, status: 'SUPERSEDED' }], '2026-11-09')?.number).toBe(1)
    expect(inForceOn([{ ...v1, status: 'SUPERSEDED', decided: false }], '2026-11-09')).toBeNull()
    expect(isGoverned([v3])).toBe(false)
    expect(isGoverned([{ ...v1, status: 'REJECTED' }])).toBe(false)
    expect(isGoverned([v3, { ...v1, status: 'SUPERSEDED' }])).toBe(true)
  })

  it('settles: the operation takes the version in force, the APPROVED ones before it are superseded, a waiting one stays', () => {
    const before = settlementOn([v2, v1], '2026-11-09')
    expect(before.inForce?.number).toBe(1)
    expect(before.supersede).toEqual([])
    expect(waitingToTakeEffect([v2, v1], '2026-11-09').map((entry) => entry.number)).toEqual([2])
    const on = settlementOn([v2, v1], '2026-12-01')
    expect(on.inForce?.number).toBe(2)
    expect(on.supersede.map((entry) => entry.number)).toEqual([1])
    expect(settles([v2, v1], '2026-12-01', { ...minutes, standardMinutes: '14' })).toBe(true)
    expect(settles([v1], '2026-11-09', minutes)).toBe(false)
    // Two approved for the same day: the later number wins, the other never takes effect.
    const twin = version(4, 'APPROVED', '2026-12-01')
    const shadow = settlementOn([twin, v2, v1], '2026-11-09')
    expect(shadow.inForce?.number).toBe(1)
    expect(shadow.supersede.map((entry) => entry.number)).toEqual([2])
    expect(waitingToTakeEffect([twin, v2, v1], '2026-11-09').map((entry) => entry.number)).toEqual([4])
  })
})

describe('proposals and decisions (PRD-113)', () => {
  const today = '2026-11-09'
  const input = { basicMinutes: '12', personalPct: '5', fatiguePct: '4', delayPct: '3', source: 'TIME_STUDY' as const, effectiveFrom: '2026-11-09', reason: ' New table. ' }

  it('a proposal gives its SMV, starts today or later and not before an approved version, and says why', () => {
    expect(planProposal(input, today, [])).toEqual({ ok: true, proposal: { basicMinutes: '12', personalPct: '5', fatiguePct: '4', delayPct: '3', standardMinutes: '13.44', source: 'TIME_STUDY', effectiveFrom: '2026-11-09', reason: 'New table.' } })
    const past = planProposal({ ...input, effectiveFrom: '2026-11-08' }, today, [])
    expect(past.ok ? null : past.issues).toEqual([{ path: 'effectiveFrom', message: 'A new SMV applies from today (2026-11-09) or a later day.' }])
    const early = planProposal(input, today, [version(1, 'APPROVED', '2026-11-16')])
    expect(early.ok ? null : early.issues[0]!.message).toBe('Version 1 is approved from 2026-11-16: a new version applies from that day or later.')
    const blank = planProposal({ ...input, reason: '  ', source: 'GUESS' as never, effectiveFrom: '9 Nov' }, today, [])
    expect(blank.ok ? [] : blank.issues.map((issue) => issue.path)).toEqual(['source', 'reason', 'effectiveFrom'])
  })

  it('a decision is on a waiting proposal, by someone else, and an approval keeps the order of first days', () => {
    const waiting = version(2, 'PROPOSED', '2026-11-20', { decided: false })
    expect(decisionRefusal(waiting, 'bruno', 'APPROVE', [waiting])).toBeNull()
    expect(decisionRefusal(waiting, 'anna', 'APPROVE', [waiting])).toMatchObject({ code: 'OWN_PROPOSAL', message: 'You proposed SMV version 2: another person approves it (four eyes).' })
    expect(decisionRefusal(waiting, 'anna', 'REJECT', [waiting])?.code).toBe('OWN_PROPOSAL')
    expect(decisionRefusal(version(1, 'APPROVED', '2026-11-01'), 'bruno', 'REJECT', [])?.code).toBe('NOT_WAITING')
    const later = version(3, 'APPROVED', '2026-12-01')
    expect(decisionRefusal(waiting, 'bruno', 'APPROVE', [later, waiting])?.code).toBe('OUT_OF_ORDER')
    expect(decisionRefusal(waiting, 'bruno', 'REJECT', [later, waiting])).toBeNull()
    expect(rejectionProblems(' ')).toEqual([{ path: 'note', message: 'Say why the proposal is rejected.' }])
    expect(rejectionProblems('Too low.')).toEqual([])
  })

  it('a typed SMV is refused in words on a governed operation, one built from allowances, or while a proposal waits', () => {
    const typed = { standardMinutes: '14', basicMinutes: null, personalPct: null, fatiguePct: null, delayPct: null }
    expect(typedSmvRefusal('CUT', typed, [])).toBeNull()
    expect(typedSmvRefusal('CUT', typed, [version(1, 'APPROVED', '2026-11-01')])).toMatch(/^Operation CUT has an approved SMV: it changes only by a new version/)
    expect(typedSmvRefusal('CUT', { ...typed, basicMinutes: '12' }, [])).toMatch(/built from basic minutes and allowances/)
    expect(typedSmvRefusal('CUT', typed, [version(1, 'PROPOSED', '2026-11-20', { decided: false })])).toMatch(/SMV version 1 of operation CUT waits for approval/)
  })
})

describe("a routing step's minutes (PRD-114, PRD-126)", () => {
  it('says where the run comes from and refuses a typed SMV over a built one', () => {
    expect(stepRunSourceOf({ basicMinutes: null, timeVersionId: null })).toBe('TYPED')
    expect(stepRunSourceOf({ basicMinutes: '12', timeVersionId: null })).toBe('ALLOWANCES')
    expect(stepRunSourceOf({ basicMinutes: '12', timeVersionId: 'v1' })).toBe('VERSION')
    expect(typedStepRefusal(10, { basicMinutes: null, timeVersionId: null }, null)).toBeNull()
    expect(typedStepRefusal(10, { basicMinutes: '12.5', timeVersionId: 'v1' }, 1)).toMatch(/^The SMV of routing step 10 is copied from SMV version 1 of its operation/)
  })

  it('set-up, wait and move are minutes from 0; extra minutes per size are sizes of the range, once, not 0, the step staying above 0', () => {
    expect(sideMinutesOf('0')).toEqual({ ok: true, minutes: '0' })
    expect(sideMinutesOf('20.0004')).toEqual({ ok: true, minutes: '20' })
    expect(sideMinutesOf('-1').ok).toBe(false)
    expect(planSizeTimes([{ size: '58', extraMinutes: '6' }, { size: '50', extraMinutes: '-1.5' }], ['50', '52', '54', '56', '58'], '96.5')).toEqual({
      ok: true,
      sizeTimes: [
        { size: '50', extraMinutes: '-1.5' },
        { size: '58', extraMinutes: '6' },
      ],
    })
    const bad = planSizeTimes(
      [
        { size: '60', extraMinutes: '1' },
        { size: '52', extraMinutes: '0.0001' },
        { size: '54', extraMinutes: '-14' },
        { size: '54', extraMinutes: '1' },
      ],
      ['50', '52', '54'],
      '14',
    )
    expect(bad.ok ? [] : bad.issues.map((issue) => issue.message)).toEqual([
      "Size 60 is not in the style's range (50, 52, 54).",
      "Extra minutes are not 0 (leave the size out: it takes the step's minutes).",
      'Size 54 would take 0 minutes: a size takes more than 0 (the step takes 14).',
      'Size 54 is named twice.',
    ])
    expect(sizesBelowZero([{ size: '50', extraMinutes: '-1.5' }], '1.5')).toEqual(['50'])
  })

  it('a garment of a size takes every step with its size extra; a work order adds set-up, wait and move once', () => {
    const steps = [
      { standardMinutes: '14', setupMinutes: '20', waitMinutes: null, moveMinutes: '5', sizeTimes: [] },
      { standardMinutes: '96.5', setupMinutes: null, waitMinutes: '15', moveMinutes: null, sizeTimes: [{ size: '54', extraMinutes: '4' }, { size: '50', extraMinutes: '-1.5' }] },
      { standardMinutes: '2', setupMinutes: null, waitMinutes: null, moveMinutes: null, sizeTimes: [], appliesToSizes: ['54'] },
    ]
    expect(minutesBySize(steps, ['50', '52', '54'])).toEqual([
      { size: '50', minutes: '109' },
      { size: '52', minutes: '110.5' },
      { size: '54', minutes: '116.5' },
    ])
    expect(leadMinutes(steps, [{ size: '54', quantity: 10 }])).toEqual({ setup: '20', run: '1165', wait: '15', move: '5', total: '1205' })
    expect(leadMinutes(steps, [])).toEqual({ setup: '20', run: '0', wait: '15', move: '5', total: '40' })
  })
})

describe('the catalogues', () => {
  it('declares the two permissions, gives them to the production manager (and the owner), and the two events', () => {
    for (const name of PRODUCT_SMV_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining([...PRODUCT_SMV_PERMISSIONS]))
    expect(templateOf('owner')?.permissions).toEqual(expect.arrayContaining([...PRODUCT_SMV_PERMISSIONS]))
    expect(templateOf('planner')?.permissions).not.toContain('product.smv.approve')
    expect(EVENT_CATALOGUE.get('smv_version.changed', 1)).toBeTruthy()
    expect(EVENT_CATALOGUE.get('operation.smv_changed', 1)).toBeTruthy()
  })
})
