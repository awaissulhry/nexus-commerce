import { describe, expect, it } from 'vitest'
import { ADDED_STAGES, addMonths, appliedRefusal, BUILT_IN_STAGE, renewalNextStep, renewalTask, renewalWindowOf, RENEWAL_STAGES, stageDay, startRefusal, successorRefusal, windowPhase, type RenewalCertificate } from './rules'

const cert = (overrides: Partial<RenewalCertificate> = {}): RenewalCertificate => ({
  id: 'a',
  number: 'CERT-A',
  status: 'VALID',
  companyId: 'c1',
  holderPartyId: null,
  validFrom: '2022-03-12',
  validTo: '2027-03-11',
  successorId: null,
  ...overrides,
})

describe('certificate renewals (B-W2a-66; QHS-105, PRD-283)', () => {
  it('alerts at 180, 90 and 30 days; the renewal step adds 180 and 90 to the built-in 30', () => {
    expect(RENEWAL_STAGES).toEqual([180, 90, 30])
    expect(BUILT_IN_STAGE).toBe(30)
    expect(ADDED_STAGES.map((stage) => stage.daysBefore)).toEqual([180, 90])
    expect(stageDay('2027-03-11', 180)).toBe('2026-09-12')
    expect(stageDay('2027-03-11', 30)).toBe('2027-02-09')
  })

  it('adds months like PostgreSQL: the 31st becomes the month’s last day, across years both ways', () => {
    expect(addMonths('2027-03-31', -1)).toBe('2027-02-28')
    expect(addMonths('2028-03-31', -1)).toBe('2028-02-29')
    expect(addMonths('2027-01-15', -12)).toBe('2026-01-15')
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
    expect(() => addMonths('11/03/2027', 1)).toThrow(RangeError)
  })

  it('the window opens 12 and closes 6 months before the last valid day; today is placed in it', () => {
    expect(renewalWindowOf('2027-03-11')).toEqual({ opens: '2026-03-11', closes: '2026-09-11' })
    expect(windowPhase('2027-03-11', '2026-03-10')).toBe('BEFORE')
    expect(windowPhase('2027-03-11', '2026-03-11')).toBe('OPEN')
    expect(windowPhase('2027-03-11', '2026-09-11')).toBe('OPEN')
    expect(windowPhase('2027-03-11', '2026-09-12')).toBe('CLOSED')
    expect(windowPhase('2027-03-11', '2027-03-11')).toBe('CLOSED')
    expect(windowPhase('2027-03-11', '2027-03-12')).toBe('ENDED')
  })

  it('starts a renewal only for a registered, counting certificate, not renewed, with no open task', () => {
    expect(startRefusal(cert(), false)).toBeNull()
    expect(startRefusal(cert({ status: 'SUSPENDED' }), false)).toBeNull()
    expect(startRefusal(cert({ status: 'DRAFT' }), false)?.code).toBe('NOT_RENEWABLE')
    expect(startRefusal(cert({ status: 'EXPIRED' }), false)?.code).toBe('NOT_RENEWABLE')
    expect(startRefusal(cert({ status: 'WITHDRAWN' }), false)?.code).toBe('NOT_RENEWABLE')
    expect(startRefusal(cert({ successorId: 'b' }), false)?.code).toBe('ALREADY_RENEWED')
    expect(startRefusal(cert(), true)?.code).toBe('ALREADY_STARTED')
  })

  it('records an application on a day that has come; a late one is recorded too (the notified body decides)', () => {
    expect(appliedRefusal(cert(), '2026-10-01', '2026-10-30')).toBeNull()
    expect(appliedRefusal(cert(), '2026-10-31', '2026-10-30')?.code).toBe('APPLIED_IN_FUTURE')
    expect(appliedRefusal(cert({ status: 'EXPIRED' }), '2027-04-01', '2027-04-02')).toBeNull()
    expect(appliedRefusal(cert({ status: 'WITHDRAWN' }), '2026-10-01', '2026-10-30')?.code).toBe('NOT_RENEWABLE')
    expect(appliedRefusal(cert({ successorId: 'b' }), '2026-10-01', '2026-10-30')?.code).toBe('ALREADY_RENEWED')
  })

  it('links a successor: registered, another, same holder, valid from a later day, renewing nothing else', () => {
    const next = cert({ id: 'b', number: 'CERT-B', validFrom: '2027-02-01', validTo: '2032-01-31' })
    expect(successorRefusal(cert(), next, null)).toBeNull()
    expect(successorRefusal(cert({ status: 'EXPIRED' }), next, null)).toBeNull()
    expect(successorRefusal(cert(), next, 'a')).toBeNull()
    expect(successorRefusal(cert({ successorId: 'x' }), next, null)?.code).toBe('ALREADY_RENEWED')
    expect(successorRefusal(cert({ status: 'DRAFT' }), next, null)?.code).toBe('NOT_LINKABLE')
    expect(successorRefusal(cert({ status: 'WITHDRAWN' }), next, null)?.code).toBe('NOT_LINKABLE')
    expect(successorRefusal(cert(), cert(), null)?.code).toBe('SUCCESSOR_SELF')
    expect(successorRefusal(cert(), { ...next, companyId: 'c2' }, null)?.code).toBe('SUCCESSOR_HOLDER')
    expect(successorRefusal(cert(), { ...next, holderPartyId: 'brand' }, null)?.code).toBe('SUCCESSOR_HOLDER')
    expect(successorRefusal(cert(), { ...next, validFrom: '2022-03-12' }, null)?.code).toBe('SUCCESSOR_NOT_LATER')
    expect(successorRefusal(cert(), { ...next, status: 'DRAFT' }, null)?.code).toBe('SUCCESSOR_NOT_REGISTERED')
    expect(successorRefusal(cert(), next, 'other')?.code).toBe('SUCCESSOR_TAKEN')
  })

  it('writes the renewal task in either language: due the window’s last day, the notified body’s own list wins', () => {
    const facts = { number: 'CERT-A', notifiedBodyNumber: '0000', notifiedBodyName: 'Demo body', validTo: '2027-03-11' }
    const en = renewalTask(facts, 'en')
    const it = renewalTask(facts, 'it')
    expect(en.dueDate).toBe('2026-09-11')
    expect(en.title).toBe('Renew certificate CERT-A')
    expect(en.description).toContain('between 2026-03-11 and 2026-09-11')
    expect(en.description).toContain("the notified body's own list wins")
    expect(it.title).toBe('Rinnovare il certificato CERT-A')
    expect(it.checklist).toHaveLength(en.checklist.length)
    expect(it.checklist[1]).toContain('Demo body (0000)')
    for (const text of [...en.checklist, ...it.checklist]) expect(text.length).toBeLessThanOrEqual(200)
  })

  it('says the next step: start, apply, link, renewed, or nothing for a certificate that no longer counts', () => {
    expect(renewalNextStep({ status: 'VALID', successorId: null, started: false, appliedOn: null })).toBe('START')
    expect(renewalNextStep({ status: 'VALID', successorId: null, started: true, appliedOn: null })).toBe('APPLY')
    expect(renewalNextStep({ status: 'VALID', successorId: null, started: true, appliedOn: '2026-09-01' })).toBe('LINK')
    expect(renewalNextStep({ status: 'EXPIRED', successorId: null, started: false, appliedOn: null })).toBe('LINK')
    expect(renewalNextStep({ status: 'VALID', successorId: 'b', started: true, appliedOn: '2026-09-01' })).toBe('RENEWED')
    expect(renewalNextStep({ status: 'WITHDRAWN', successorId: null, started: false, appliedOn: null })).toBe('NONE')
  })
})
