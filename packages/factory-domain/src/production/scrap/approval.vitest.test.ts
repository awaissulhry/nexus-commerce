import { describe, expect, it } from 'vitest'
import { REASON_COLOURS, REASON_ICONS } from '../../reasons/rules'
import { approvalStateOf, decisionRefusal, decisionWords, isFloorReport, overLimitOf, postingHeldWords, refusalReasonText, SCRAP_REFUSAL_TILES, type DecisionFacts } from './approval'
import { askRefusal, type AskFacts } from './rules'

/** Scrap above the site's limit waits for the team leader's approval (B-W2b-53; MES-128), pure. */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 9, minute))
const report = { kind: 'REPORT', scrapQuantity: 6, serverTime: at(20), deviceId: 'device-1', subcontractReceiptLineId: null }

describe('which scans wait', () => {
  it('a floor REPORT above the limit in force when it was taken; never a correction or an outside operation', () => {
    const history = [{ at: at(10), before: null, after: 5 }]
    expect(overLimitOf(report, history, 5)).toEqual({ limit: 5, over: true })
    expect(overLimitOf({ ...report, serverTime: at(5) }, history, 5)).toEqual({ limit: null, over: false })
    expect(overLimitOf({ ...report, scrapQuantity: 5 }, history, 5)).toEqual({ limit: 5, over: false })
    expect(overLimitOf({ ...report, kind: 'CORRECTION' }, history, 5).over).toBe(false)
    expect(overLimitOf({ ...report, deviceId: null }, history, 5).over).toBe(false)
    expect(isFloorReport({ ...report, subcontractReceiptLineId: 'line-1' })).toBe(false)
  })

  it('WAITING until decided; a decision stays; a voided scan that waited for nothing needs nothing', () => {
    expect(approvalStateOf({ over: true, standing: true, decision: null })).toBe('WAITING')
    expect(approvalStateOf({ over: true, standing: true, decision: 'APPROVED' })).toBe('APPROVED')
    expect(approvalStateOf({ over: true, standing: false, decision: 'REFUSED' })).toBe('REFUSED')
    expect(approvalStateOf({ over: true, standing: false, decision: null })).toBeNull()
    expect(approvalStateOf({ over: false, standing: true, decision: null })).toBeNull()
  })

  it('waiting or refused scrap holds its posting, in words', () => {
    expect(postingHeldWords('WAITING', 6, 5)).toBe("6 pieces scrapped in one scan is above this site's limit of 5: it waits for the team leader's approval before it posts.")
    expect(postingHeldWords('REFUSED', 6, 5)).toMatch(/^The team leader refused this scan's scrap: it does not post/)
    expect(postingHeldWords('APPROVED', 6, 5)).toBeNull()
    expect(postingHeldWords(null, 6, 5)).toBeNull()
  })
})

describe('the decision', () => {
  const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
    decision: 'APPROVED',
    scan: { ...report, bundleCode: 'BN-0001' },
    limit: 5,
    over: true,
    standing: true,
    workOrder: { number: 'WO-26-0001', status: 'IN_PROGRESS' },
    decidedAlready: null,
    selfDecision: false,
    reason: null,
    note: null,
    ...over,
  })

  it('is taken once, by someone else than who took the scan, on a standing scan above the limit of an open work order', () => {
    expect(decisionRefusal(facts())).toBeNull()
    expect(decisionRefusal(facts({ decidedAlready: 'APPROVED' }))).toMatchObject({ code: 'DECIDED_ALREADY', message: 'The scrap of bundle BN-0001 was approved already.' })
    expect(decisionRefusal(facts({ selfDecision: true }))).toMatchObject({ code: 'SELF_DECISION' })
    expect(decisionRefusal(facts({ standing: false }))).toMatchObject({ code: 'SCAN_VOIDED' })
    expect(decisionRefusal(facts({ over: false }))).toMatchObject({ code: 'NOT_OVER_LIMIT', message: '6 pieces is not above the limit of 5 in force when the scan was taken: no approval is needed.' })
    expect(decisionRefusal(facts({ over: false, limit: null }))).toMatchObject({ code: 'NOT_OVER_LIMIT' })
    expect(decisionRefusal(facts({ workOrder: { number: 'WO-26-0001', status: 'CLOSED' } }))).toMatchObject({ code: 'WORK_ORDER_CLOSED' })
    expect(decisionRefusal(facts({ scan: { ...report, kind: 'CORRECTION', bundleCode: 'BN-0001' } }))).toMatchObject({ code: 'NOT_A_FLOOR_REPORT' })
  })

  it('a refusal picks a reason tile; OTHER also says why', () => {
    expect(decisionRefusal(facts({ decision: 'REFUSED' }))).toMatchObject({ code: 'NOTE_NEEDED', message: 'Pick why the scrap is refused.' })
    expect(decisionRefusal(facts({ decision: 'REFUSED', reason: 'REWORK_INSTEAD' }))).toBeNull()
    expect(decisionRefusal(facts({ decision: 'REFUSED', reason: 'OTHER' }))).toMatchObject({ code: 'NOTE_NEEDED' })
    expect(decisionRefusal(facts({ decision: 'REFUSED', reason: 'OTHER', note: 'Seen by quality' }))).toBeNull()
    expect(refusalReasonText('OTHER', 'Seen by quality')).toBe('Other: Seen by quality')
    expect(refusalReasonText('WRONG_COUNT', null)).toBe('Wrong count')
    expect(decisionWords('APPROVED', 6, 'BN-0001')).toBe('6 pieces of bundle BN-0001 approved as scrap: it posts now (replacement, scrap of stock, cost).')
  })

  it('the reason tiles use the design system’s icons and swatches, Italian and English words', () => {
    for (const tile of SCRAP_REFUSAL_TILES) {
      expect(REASON_ICONS as readonly string[]).toContain(tile.icon)
      expect(REASON_COLOURS as readonly string[]).toContain(tile.colour)
      expect(tile.labelIt.length).toBeGreaterThan(2)
    }
  })
})

describe('a replacement of held scrap (MES-128 with MES-130)', () => {
  const ask = (heldBy: NonNullable<AskFacts['source']>['heldBy']): AskFacts => ({
    workOrder: { number: 'WO-26-0001', status: 'IN_PROGRESS' },
    cell: { label: 'BLK 50', quantity: 10, parts: [] },
    kind: 'RECUT',
    quantity: 2,
    part: null,
    source: { what: 'The scan of bundle BN-0001', scrapped: 6, replaced: 0, heldBy },
  })

  it('is refused while the scrap waits or after it was refused; asked once it is approved', () => {
    expect(askRefusal(ask({ state: 'WAITING', words: 'It waits.' }))).toEqual({ code: 'SCRAP_WAITS_APPROVAL', message: 'It waits.' })
    expect(askRefusal(ask({ state: 'REFUSED', words: 'Refused.' }))).toEqual({ code: 'SCRAP_REFUSED', message: 'Refused.' })
    expect(askRefusal(ask(null))).toBeNull()
  })
})
