import { describe, expect, it } from 'vitest'
import { alreadyAppliedRefusal, isOpenRenewal, RENEWAL_REFUSALS } from '../compliance/renewals/rules'
import { KIND_RULES, ATTENTION_KINDS } from '../insights/attention'
import { EN_TEMPLATES, ncrDecisionWords, whyKey } from '../insights/words'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { complaintNumbersIn, COMPLAINT_LINK_TYPES, LINK_FIELDS } from './complaints/rules'
import { dueProblem, inspectionOverdue } from './final/rules'
import { holdLabel, isHoldRuleLoosening, placerMayReleaseInForce, releasable, releaseChecks } from './holds/rules'
import { containmentHoursInForce, containmentHoursProblem, DEFAULT_CONTAINMENT_HOURS, NCR_TITLE_KEYS } from './ncr/rules'

/**
 * B-W2b-17 quality follow-ups, the pure rules: who releases a hold (placer may release), hold labels, the containment
 * time, inspection due times, complaint numbers in a mail's subject and the link types, the NCR decision kind of Today,
 * renewals as rows, the two new events.
 */

const facts = { status: 'ACTIVE' as const, subjectType: 'Lot' as const, madeBy: null, makersUnnamed: false, notMakerStatement: false, crViOpen: null, reinspectionOpen: null }

describe('who releases a hold (Z5:01)', () => {
  it('the placer releases only when the company lets them', () => {
    const strict = releaseChecks({ ...facts, placedByReleaser: true })
    expect(releasable(strict)).toBe(false)
    expect(strict.find((check) => check.key === 'NOT_PLACER')?.words).toMatch(/another person must release/)
    const loose = releaseChecks({ ...facts, placedByReleaser: true, placerMayRelease: true })
    expect(releasable(loose)).toBe(true)
    expect(loose.find((check) => check.key === 'NOT_PLACER')?.words).toMatch(/rule lets the person who placed it release/)
    expect(releasable(releaseChecks({ ...facts, placedByReleaser: false, placerMayRelease: false }))).toBe(true)
  })

  it('the rule in force: company, else tenant, else false; letting the placer is the looser rule', () => {
    expect(placerMayReleaseInForce(null, null)).toEqual({ placerMayRelease: false, source: 'DEFAULT' })
    expect(placerMayReleaseInForce(undefined, true)).toEqual({ placerMayRelease: true, source: 'TENANT' })
    expect(placerMayReleaseInForce(false, true)).toEqual({ placerMayRelease: false, source: 'COMPANY' })
    expect(isHoldRuleLoosening(false, true)).toBe(true)
    expect(isHoldRuleLoosening(true, false)).toBe(false)
    expect(holdLabel({ number: 'HLD-2026-0001', id: 'x' })).toBe('HLD-2026-0001')
    expect(holdLabel({ number: null, id: '0123456789' })).toBe('hold 01234567')
  })
})

describe('the containment time (Z5:02) and NCR titles (Z5:05)', () => {
  it('company, else tenant, else 24 hours; 1 to 720 whole hours', () => {
    expect(containmentHoursInForce(null, null)).toEqual({ hours: DEFAULT_CONTAINMENT_HOURS, source: 'DEFAULT' })
    expect(containmentHoursInForce(null, 48)).toEqual({ hours: 48, source: 'TENANT' })
    expect(containmentHoursInForce(4, 48)).toEqual({ hours: 4, source: 'COMPANY' })
    expect(containmentHoursProblem(null)).toBeNull()
    expect(containmentHoursProblem(1)).toBeNull()
    expect(containmentHoursProblem(720)).toBeNull()
    expect(containmentHoursProblem(0)?.path).toBe('body/defaultContainmentHours')
    expect(containmentHoursProblem(721)).not.toBeNull()
    expect(containmentHoursProblem(1.5)).not.toBeNull()
  })

  it('every title key is a stable code', () => {
    expect(new Set(NCR_TITLE_KEYS).size).toBe(NCR_TITLE_KEYS.length)
    for (const key of NCR_TITLE_KEYS) expect(key).toMatch(/^[A-Z_]+$/)
  })
})

describe('inspection due times (Z5:03)', () => {
  const now = new Date('2026-11-20T10:00:00.000Z')
  it('later than now, at most a year ahead; overdue only while open', () => {
    expect(dueProblem(null, now)).toBeNull()
    expect(dueProblem(new Date('2026-11-20T12:00:00.000Z'), now)).toBeNull()
    expect(dueProblem(new Date('2026-11-20T09:00:00.000Z'), now)?.message).toMatch(/later than now/)
    expect(dueProblem(new Date('2028-01-01T00:00:00.000Z'), now)?.message).toMatch(/a year/)
    expect(inspectionOverdue({ status: 'OPEN', dueAt: new Date('2026-11-20T09:00:00.000Z') }, now)).toBe(true)
    expect(inspectionOverdue({ status: 'PASSED', dueAt: new Date('2026-11-20T09:00:00.000Z') }, now)).toBe(false)
    expect(inspectionOverdue({ status: 'OPEN', dueAt: null }, now)).toBe(false)
  })
})

describe('complaints: links and mail in (Z5:09)', () => {
  it('a subject names complaint numbers on word boundaries, first one first', () => {
    const numbers = ['CMP-2026-0012', 'CMP-2026-0001', 'CMP-2026-00121']
    expect(complaintNumbersIn('Re: cmp-2026-0012 giacca strappata', numbers)).toEqual(['CMP-2026-0012'])
    expect(complaintNumbersIn('CMP-2026-00121 and CMP-2026-0001', numbers)).toEqual(['CMP-2026-00121', 'CMP-2026-0001'])
    expect(complaintNumbersIn('XCMP-2026-0012', numbers)).toEqual([])
    expect(complaintNumbersIn('CMP-2026-0012/2', numbers)).toEqual([])
    expect(complaintNumbersIn(null, numbers)).toEqual([])
  })

  it('every fact link names one column of the complaint; the NCR link lives on the NCR', () => {
    expect([...COMPLAINT_LINK_TYPES].sort()).toEqual(['GarmentSerial', 'Nonconformance', 'ReturnAuthorisation', 'SalesOrder', 'Shipment'])
    expect(Object.values(LINK_FIELDS).sort()).toEqual(['returnId', 'salesOrderId', 'serial', 'shipmentId'])
  })
})

describe('NCR decisions in Home › Approvals (Z5:07)', () => {
  it('an approval kind with its words and why', () => {
    expect(ATTENTION_KINDS).toContain('NCR_DECISION')
    expect(KIND_RULES.NCR_DECISION).toMatchObject({ category: 'APPROVAL', view: 'quality.ncr.view', act: ['quality.ncr.approve'], decide: 'OPEN' })
    const words = ncrDecisionWords({ number: 'NCR-2026-0001', code: 'SCRAP', quantity: '5 PCS' })
    expect(words.sentence.text).toBe('NCR NCR-2026-0001 waits for the approval of its decision SCRAP for 5 PCS.')
    expect(EN_TEMPLATES[whyKey('NCR_DECISION', 'quality.ncr.approve')]).toBeTruthy()
    expect(EN_TEMPLATES['NCR_DECISION.blocks']).toBeTruthy()
  })
})

describe('renewals as rows (Z5:10) and the events', () => {
  it('open renewals; an application is recorded once', () => {
    expect(isOpenRenewal('STARTED')).toBe(true)
    expect(isOpenRenewal('APPLIED')).toBe(true)
    expect(isOpenRenewal('RENEWED')).toBe(false)
    expect(alreadyAppliedRefusal({ number: 'C-1' }, null)).toBeNull()
    expect(alreadyAppliedRefusal({ number: 'C-1' }, '2026-11-02')?.code).toBe('ALREADY_APPLIED')
    expect(RENEWAL_REFUSALS).toContain('ALREADY_APPLIED')
  })

  it('the settings events are declared with their live permission', () => {
    expect(EVENT_CATALOGUE.get('quality.hold_rule_changed', 1)?.live?.permission).toBe('quality.holds.view')
    expect(EVENT_CATALOGUE.get('ncr.settings_changed', 1)?.live?.permission).toBe('quality.ncr.view')
  })
})
