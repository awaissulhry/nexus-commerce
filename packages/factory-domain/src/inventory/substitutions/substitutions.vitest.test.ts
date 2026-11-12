import { describe, expect, it } from 'vitest'
import type { ItemUnits } from '../../product/units/units'
import { askAnswer, issueRefusal, noApproverWords, replacesOwn, standingTotal, stillOpen, tooMuchRefusal, withdrawRefusal, type AskFacts } from './rules'

const line = { seq: 20, materialCode: 'LIN-200' }
const alternate = (allowedWhen: 'ALWAYS' | 'WHEN_SHORT' | 'WITH_APPROVAL', certificateCheck = false) => ({ priority: 1, code: 'LIN-210', allowedWhen, certificateCheck })
const facts = (extra: Partial<AskFacts>): AskFacts => ({ kind: 'ALTERNATE', line, alternate: alternate('ALWAYS'), certificateRequired: false, certificate: null, ownShort: false, ...extra })

describe('the rule with the work order facts (B-W2b-298; MES-139; PK1:01)', () => {
  it('an ALWAYS alternate needs nobody; WHEN_SHORT only while the own material is short', () => {
    expect(askAnswer(facts({}))).toEqual({ ruleAnswer: { may: true, held: [], message: 'Alternate 1 (LIN-210) may be used.' }, needsPerson: false, refusal: null })
    const notShort = askAnswer(facts({ alternate: alternate('WHEN_SHORT') }))
    expect(notShort.refusal?.code).toBe('ONLY_WHEN_SHORT')
    expect(notShort.ruleAnswer).toMatchObject({ may: false, held: ['ONLY_WHEN_SHORT'] })
    expect(askAnswer(facts({ alternate: alternate('WHEN_SHORT'), ownShort: true }))).toMatchObject({ needsPerson: false, refusal: null, ruleAnswer: { may: true } })
  })

  it('WITH_APPROVAL waits for a person; the answer is kept as given (may false, NEEDS_APPROVAL)', () => {
    const answer = askAnswer(facts({ alternate: alternate('WITH_APPROVAL'), ownShort: true }))
    expect(answer).toMatchObject({ needsPerson: true, refusal: null, ruleAnswer: { may: false, held: ['NEEDS_APPROVAL'] } })
  })

  it('a PPE component outside its certificate is refused; with a valid certificate it goes on', () => {
    const outside = askAnswer(facts({ alternate: alternate('WITH_APPROVAL', true), certificateRequired: true, certificate: null }))
    expect(outside.refusal).toMatchObject({ code: 'OUTSIDE_CERTIFICATE', message: expect.stringContaining('outside its certificate') })
    const covered = askAnswer(facts({ alternate: alternate('WITH_APPROVAL', true), certificateRequired: true, certificate: { number: 'CE-1', validTo: '2030-01-01' } }))
    expect(covered).toMatchObject({ refusal: null, needsPerson: true, ruleAnswer: { held: ['NEEDS_APPROVAL'] } })
  })

  it('another lot of the own material always asks a person', () => {
    expect(askAnswer(facts({ kind: 'OWN_MATERIAL', alternate: null }))).toMatchObject({ needsPerson: true, refusal: null, ruleAnswer: { may: false, held: ['NEEDS_APPROVAL'], message: expect.stringContaining('LIN-200') } })
    expect(noApproverWords('Alternate 1 (LIN-210)')).toContain('Approval rules')
  })
})

describe('what a substitute stands for, and how much may be asked', () => {
  const metres: ItemUnits = { baseUom: 'M', purchaseUom: 'M', purchaseFactor: '1', consumptionUom: 'M', consumptionFactor: '1' }
  const pieces: ItemUnits = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' }

  it('one for one for the own material; by the quantities per garment for an alternate', () => {
    expect(replacesOwn({ kind: 'OWN_MATERIAL', lineQty: '1.8', lineUom: 'M', ownUnits: metres, alternateQty: null, substituteUnits: metres }, '3')?.toFixed(4)).toBe('3.0000')
    // 1.8 m of the own lining per jacket, 2.0 m of the alternate: 4 m of the alternate stand for 3.6 m.
    expect(replacesOwn({ kind: 'ALTERNATE', lineQty: '1.8', lineUom: 'M', ownUnits: metres, alternateQty: '2', substituteUnits: metres }, '4')?.toFixed(4)).toBe('3.6000')
    expect(replacesOwn({ kind: 'ALTERNATE', lineQty: '1.8', lineUom: 'M', ownUnits: metres, alternateQty: null, substituteUnits: metres }, '4')?.toFixed(4)).toBe('4.0000')
    expect(replacesOwn({ kind: 'ALTERNATE', lineQty: '2', lineUom: 'M', ownUnits: metres, alternateQty: null, substituteUnits: pieces }, '4')).toBeNull()
  })

  it('what is still open (a WHEN_SHORT one only the short part) and an ask above it, in words', () => {
    expect(stillOpen({ toIssue: '10', short: '3', standing: '1', onlyShort: false }).toFixed(4)).toBe('9.0000')
    expect(stillOpen({ toIssue: '10', short: '3', standing: '1', onlyShort: true }).toFixed(4)).toBe('2.0000')
    expect(stillOpen({ toIssue: '1', short: '0', standing: '4', onlyShort: false }).toFixed(4)).toBe('0.0000')
    expect(tooMuchRefusal({ asked: '2', open: '2', ownCode: 'LIN-200', baseUom: 'M', onlyShort: true })).toBeNull()
    expect(tooMuchRefusal({ asked: '2.5', open: '2', ownCode: 'LIN-200', baseUom: 'M', onlyShort: true })).toMatchObject({ code: 'TOO_MUCH', message: expect.stringContaining('at most 2.0000 M (the short part)') })
    expect(tooMuchRefusal({ asked: '1', open: '0', ownCode: 'LIN-200', baseUom: 'M', onlyShort: false })?.message).toMatch(/^Nothing of LIN-200/)
    expect(standingTotal([{ status: 'WAITING', replaces: '1' }, { status: 'ISSUED', replaces: '2' }, { status: 'REFUSED', replaces: '5' }, { status: 'APPROVED', replaces: null }]).toFixed(4)).toBe('3.0000')
  })

  it('only an approved substitute is issued; only a waiting or approved one is withdrawn', () => {
    expect(issueRefusal('APPROVED')).toBeNull()
    for (const status of ['WAITING', 'ISSUED', 'REFUSED', 'WITHDRAWN'] as const) expect(issueRefusal(status)?.code).toBe('NOT_APPROVED')
    expect(withdrawRefusal('WAITING')).toBeNull()
    expect(withdrawRefusal('APPROVED')).toBeNull()
    expect(withdrawRefusal('ISSUED')?.message).toContain('return what is left')
    expect(withdrawRefusal('REFUSED')?.code).toBe('NOT_WAITING')
  })
})
