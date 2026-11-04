import { describe, expect, it } from 'vitest'
import { shadeFeasibility, sizesText, splitByGarment, type FeasibilityLot } from './feasibility'
import { LOSS_MIN_CUTS, lossOfWastage, lossOfYield, lossProblem, lossProposal, MAX_LOSS_PCT, plannedLossOf, proposalStands, wastageOfLoss, yieldOfLoss, dismissReasonProblem } from './loss'
import { protectorState, substituteRefusal, withoutValidCertificate } from './protectors'

const lot = (key: string, total: string, ordersOwn = false): FeasibilityLot => ({ key, lotId: key, lotCode: `L-${key}`, shadeLabel: `shade ${key}`, total, count: 3, ordersOwn })
const sizes = (...pairs: [string, string][]) => pairs.map(([size, area]) => ({ size, area }))

describe('the cutting loss (PLN-109)', () => {
  it('keeps the planned yield and the leather wastage in step', () => {
    expect(lossOfWastage('15')).toBe('13.04')
    expect(wastageOfLoss('14')).toBe('16.2791')
    expect(lossOfWastage(wastageOfLoss('14'))).toBe('14.00')
    expect(yieldOfLoss('14')).toBe('86.0000')
    expect(lossOfYield('88')).toBe('12.00')
    expect(MAX_LOSS_PCT).toBe('37.50')
  })

  it('reads a revision’s planned loss from its planned yield, else its leather lines when they agree', () => {
    expect(plannedLossOf({ plannedHideYieldPct: '88', leatherWastages: ['20'] })).toEqual({ lossPct: '12.00', source: 'STYLE' })
    expect(plannedLossOf({ plannedHideYieldPct: null, leatherWastages: ['15', '15.0000'] })).toEqual({ lossPct: '13.04', source: 'BOM' })
    expect(plannedLossOf({ plannedHideYieldPct: null, leatherWastages: ['15', '18'] })).toEqual({ lossPct: null, source: null })
    expect(plannedLossOf({ plannedHideYieldPct: null, leatherWastages: [] })).toEqual({ lossPct: null, source: null })
  })

  it('proposes only from enough cuts and a real drift, rounded to a whole percent', () => {
    expect(lossProposal({ cuts: LOSS_MIN_CUTS - 1, actualLossPct: '14.2', plannedLossPct: '12', last: null })).toMatchObject({ state: 'TOO_FEW', toPct: null })
    expect(lossProposal({ cuts: 9, actualLossPct: '12.40', plannedLossPct: '12', last: null })).toMatchObject({ state: 'IN_LINE' })
    expect(lossProposal({ cuts: 9, actualLossPct: '14.20', plannedLossPct: '12', last: null })).toEqual({ state: 'PROPOSED', fromPct: '12.00', toPct: '14.00', cuts: 9 })
    expect(lossProposal({ cuts: 9, actualLossPct: '9.6', plannedLossPct: null, last: null })).toEqual({ state: 'PROPOSED', fromPct: null, toPct: '10.00', cuts: 9 })
    expect(lossProposal({ cuts: 9, actualLossPct: '48', plannedLossPct: '12', last: null }).toPct).toBe('37.50')
  })

  it('stays quiet after a decision until the proposal changes or enough new cuts came in', () => {
    const base = { actualLossPct: '14.20', plannedLossPct: '12' }
    expect(lossProposal({ ...base, cuts: 9, last: { decision: 'ACCEPTED', toPct: '14.00', cuts: 9 } }).state).toBe('ACCEPTED')
    expect(lossProposal({ ...base, cuts: 12, last: { decision: 'DISMISSED', toPct: '14.00', cuts: 9 } }).state).toBe('DISMISSED')
    expect(lossProposal({ ...base, cuts: 14, last: { decision: 'DISMISSED', toPct: '14.00', cuts: 9 } }).state).toBe('PROPOSED')
    expect(lossProposal({ ...base, cuts: 10, last: { decision: 'DISMISSED', toPct: '15.00', cuts: 9 } }).state).toBe('PROPOSED')
    const proposal = lossProposal({ ...base, cuts: 9, last: null })
    expect(proposalStands(proposal, { toPct: '14.00', cuts: 9 })).toBe(true)
    expect(proposalStands(proposal, { toPct: '14', cuts: 8 })).toBe(false)
    expect(proposalStands(lossProposal({ ...base, cuts: 2, last: null }), { toPct: '14.00', cuts: 2 })).toBe(false)
  })

  it('checks a loss and a dismissal’s reason in words', () => {
    expect(lossProblem('14')).toBeNull()
    expect(lossProblem('14.255')).toMatch(/two decimals/)
    expect(lossProblem('40')).toMatch(/0 to 37.50 %/)
    expect(dismissReasonProblem(' ok ')).toMatch(/3 characters/)
    expect(dismissReasonProblem('A new die since week 44 (made up).')).toBeNull()
  })
})

describe('one shade per order (PLN-108)', () => {
  it('fits one lot, the order’s own first', () => {
    expect(shadeFeasibility({ rule: 'ORDER', toFind: '120', reserved: '0', sizes: sizes(['48', '60'], ['50', '60']), lots: [lot('a', '150'), lot('b', '400')], held: 0 })).toMatchObject({ status: 'FITS', best: { key: 'a' }, buy: null })
    const own = shadeFeasibility({ rule: 'ORDER', toFind: '120', reserved: '40', sizes: sizes(['48', '80'], ['50', '80']), lots: [lot('a', '100', true), lot('b', '400')], held: 1 })
    expect(own.status).toBe('SPLIT')
    expect(own.best?.key).toBe('a')
    expect(own.split?.map((part) => [part.lotKey, part.sizes])).toEqual([
      ['a', ['48']],
      ['b', ['50']],
    ])
    expect(own.buy).toEqual({ area: '20.0000', lotCode: 'L-a', shadeLabel: 'shade a' })
  })

  it('splits whole sizes over lots, else says what to buy', () => {
    const split = shadeFeasibility({ rule: 'ORDER', toFind: '300', reserved: '0', sizes: sizes(['46', '100'], ['48', '100'], ['50', '100']), lots: [lot('a', '210'), lot('b', '120')], held: 0 })
    expect(split.status).toBe('SPLIT')
    expect(split.split?.map((part) => part.sizes)).toEqual([['46', '48'], ['50']])
    expect(split.buy).toEqual({ area: '90.0000', lotCode: 'L-a', shadeLabel: 'shade a' })
    const buy = shadeFeasibility({ rule: 'ORDER', toFind: '300', reserved: '0', sizes: sizes(['46', '150'], ['48', '150']), lots: [lot('a', '120'), lot('b', '100')], held: 0 })
    expect(buy).toMatchObject({ status: 'MUST_BUY', split: null, buy: { area: '180.0000', lotCode: 'L-a' } })
    expect(shadeFeasibility({ rule: 'ORDER', toFind: '50', reserved: '0', sizes: sizes(['46', '50']), lots: [], held: 0 })).toMatchObject({ status: 'MUST_BUY', best: null, buy: { area: '50.0000', lotCode: null } })
  })

  it('splits an order whose own lot has nothing left when another lot takes every size left', () => {
    const answer = shadeFeasibility({ rule: 'ORDER', toFind: '100', reserved: '0', sizes: sizes(['50', '0'], ['52', '60'], ['54', '40']), lots: [lot('b', '300')], held: 1 })
    expect(answer.status).toBe('SPLIT')
    expect(answer.split?.map((part) => [part.lotKey, part.sizes])).toEqual([['b', ['52', '54']]])
    expect(answer.buy).toEqual({ area: '100.0000', lotCode: null, shadeLabel: null })
    expect(shadeFeasibility({ rule: 'ORDER', toFind: '100', reserved: '0', sizes: sizes(['52', '100']), lots: [lot('b', '300')], held: 0 }).status).toBe('FITS')
  })

  it('asks the customer once the order holds two shade lots; nothing to find is covered', () => {
    expect(shadeFeasibility({ rule: 'ORDER', toFind: '40', reserved: '0', sizes: sizes(['46', '40']), lots: [lot('a', '400', true)], held: 2 }).status).toBe('ASK_CUSTOMER')
    expect(shadeFeasibility({ rule: 'ORDER', toFind: '0', reserved: '60', sizes: sizes(['46', '60']), lots: [lot('a', '10', true)], held: 1 }).status).toBe('COVERED')
  })

  it('asks no shade under the rule OFF', () => {
    expect(shadeFeasibility({ rule: 'OFF', toFind: '300', reserved: '0', sizes: [], lots: [lot('a', '200'), lot('b', '120')], held: 2 }).status).toBe('FITS')
    expect(shadeFeasibility({ rule: 'OFF', toFind: '400', reserved: '0', sizes: [], lots: [lot('a', '200'), lot('b', '120')], held: 0 })).toMatchObject({ status: 'MUST_BUY', buy: { area: '80.0000' } })
  })

  it('never splits a size that fits no lot, and says sizes as a range', () => {
    expect(splitByGarment({ reserved: '0', sizes: sizes(['46', '90'], ['48', '300']), lots: [lot('a', '200'), lot('b', '150')] })).toBeNull()
    expect(sizesText(['46', '48', '50'], ['44', '46', '48', '50', '52'])).toBe('46–50')
    expect(sizesText(['46', '50'], ['44', '46', '48', '50', '52'])).toBe('46, 50')
  })
})

describe('certified protectors (PLN-114)', () => {
  it('plans only certified parts, in date for the order, with enough in stock', () => {
    expect(protectorState({ certificate: null, dueDate: '2026-12-01', needed: '20', available: '100' })).toBe('NO_CERTIFICATE')
    expect(protectorState({ certificate: { validTo: '2026-11-20' }, dueDate: '2026-12-01', needed: '20', available: '100' })).toBe('EXPIRES_BEFORE_DUE')
    expect(protectorState({ certificate: { validTo: '2027-06-30' }, dueDate: '2026-12-01', needed: '20', available: '12' })).toBe('SHORT')
    expect(protectorState({ certificate: { validTo: '2027-06-30' }, dueDate: null, needed: '20', available: '20' })).toBe('OK')
    expect(withoutValidCertificate('EXPIRES_BEFORE_DUE')).toBe(true)
    expect(withoutValidCertificate('SHORT')).toBe(false)
    expect(substituteRefusal('JKT-01')).toBe('Not certified for style JKT-01 — the DoC would be wrong.')
  })
})
