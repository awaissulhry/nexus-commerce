import { describe, expect, it } from 'vitest'
import { MAX_CANDIDATES, pickList, type PickInput, type PickLot, type PickMaterial, type PickStock } from './pick-list'
import { hideStateAfterReturn, issueDecision, returnDecision, reversalRefusal, undoRefusal, type IssueFacts, type PickedMove } from './rules'

const RELEASED: PickLot = { id: 'lot-1', code: 'L-1', qualityStatus: 'RELEASED', requiresCrViTest: true, crViStatus: 'PASS', receivedAt: '2026-10-02T08:00:00.000Z', dyeBatch: '7731' }

const base: IssueFacts = {
  workOrder: { number: 'WO-00001', status: 'RELEASED' },
  label: 'LEATHER BLK',
  baseUom: 'FT2',
  line: { planned: '110', issued: '0' },
  materialPlanned: true,
  lot: RELEASED,
  hide: { code: 'H-1', state: 'FULL' },
  onHand: '53.2',
  requested: null,
  overIssueReason: null,
}

describe('issue (SCM-215): only usable stock of the work order, up to what it still needs', () => {
  it('issues a released hide whole, with what it measures on hand', () => {
    expect(issueDecision(base)).toEqual({ ok: true, baseQuantity: '53.2000', overIssue: false, toIssue: '110.0000' })
    // A hide is never cut to fit: the last hide may cover more than the need, and that is no over-issue.
    expect(issueDecision({ ...base, line: { planned: '110', issued: '100' } })).toMatchObject({ ok: true, baseQuantity: '53.2000', overIssue: false })
    expect(issueDecision({ ...base, workOrder: { number: 'WO-00001', status: 'IN_PROGRESS' } })).toMatchObject({ ok: true })
  })

  it('refuses a work order that is not released or in progress', () => {
    for (const status of ['DRAFT', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const) {
      expect(issueDecision({ ...base, workOrder: { number: 'WO-00001', status } })).toMatchObject({ ok: false, refusal: { code: 'WORK_ORDER_NOT_OPEN' } })
    }
  })

  it('refuses another colour, and a material the work order does not use', () => {
    expect(issueDecision({ ...base, line: null })).toMatchObject({ ok: false, refusal: { code: 'OTHER_COLOUR' } })
    expect(issueDecision({ ...base, line: null, materialPlanned: false })).toMatchObject({ ok: false, refusal: { code: 'NOT_IN_WORK_ORDER' } })
  })

  it('refuses held stock with its reason (REACH Annex XVII entry 47)', () => {
    const lot = (qualityStatus: PickLot['qualityStatus'], crViStatus: PickLot['crViStatus'], requiresCrViTest = true) => ({ ...RELEASED, qualityStatus, crViStatus, requiresCrViTest })
    const code = (facts: Partial<IssueFacts>) => {
      const decision = issueDecision({ ...base, ...facts })
      return decision.ok ? 'ok' : decision.refusal.code
    }
    expect(code({ lot: lot('QUARANTINE', 'PENDING') })).toBe('CR_VI_PENDING')
    expect(code({ lot: lot('BLOCKED', 'FAIL') })).toBe('CR_VI_FAILED')
    expect(code({ lot: lot('QUARANTINE', 'NOT_REQUIRED', false) })).toBe('QUALITY_HOLD')
    expect(code({ lot: lot('BLOCKED', 'PASS') })).toBe('BLOCKED')
    expect(code({ lot: lot('REJECTED', 'PASS') })).toBe('REJECTED')
    // The rule does not lean on the trigger: a RELEASED lot without its PASS is still refused.
    expect(code({ lot: lot('RELEASED', 'PENDING') })).toBe('CR_VI_PENDING')
    const refused = issueDecision({ ...base, lot: lot('QUARANTINE', 'PENDING') })
    expect(!refused.ok && refused.refusal.message).toContain('no chromium VI test result yet')
  })

  it('refuses a used-up hide and stock that is not on hand', () => {
    expect(issueDecision({ ...base, hide: { code: 'H-1', state: 'CONSUMED' } })).toMatchObject({ ok: false, refusal: { code: 'HIDE_USED_UP' } })
    expect(issueDecision({ ...base, hide: { code: 'H-1', state: 'SCRAPPED' } })).toMatchObject({ ok: false, refusal: { code: 'HIDE_USED_UP' } })
    expect(issueDecision({ ...base, onHand: '0' })).toMatchObject({ ok: false, refusal: { code: 'NOTHING_ON_HAND' } })
    // A remnant that came back is issued again, with what it measured.
    expect(issueDecision({ ...base, hide: { code: 'H-1', state: 'REMNANT' }, onHand: '8.5' })).toMatchObject({ ok: true, baseQuantity: '8.5000' })
  })

  it('defaults a lot to what the work order still needs, up to what is on hand', () => {
    const lining = { ...base, label: 'LINING GRY', baseUom: 'M', hide: null, lot: { ...RELEASED, requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const }, line: { planned: '12.5', issued: '2.5' } }
    expect(issueDecision({ ...lining, onHand: '40' })).toEqual({ ok: true, baseQuantity: '10.0000', overIssue: false, toIssue: '10.0000' })
    expect(issueDecision({ ...lining, onHand: '4' })).toMatchObject({ ok: true, baseQuantity: '4.0000', overIssue: false })
    expect(issueDecision({ ...lining, onHand: '40', requested: '3' })).toMatchObject({ ok: true, baseQuantity: '3.0000', overIssue: false })
    expect(issueDecision({ ...lining, onHand: '4', requested: '5' })).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_ON_HAND' } })
    // Untracked material: no lot.
    expect(issueDecision({ ...lining, lot: null, onHand: '40' })).toMatchObject({ ok: true, baseQuantity: '10.0000' })
  })

  it('refuses an over-issue without a reason, takes it with one', () => {
    const lining = { ...base, label: 'LINING GRY', baseUom: 'M', hide: null, lot: null, onHand: '40', line: { planned: '12.5', issued: '10' } }
    const refused = issueDecision({ ...lining, requested: '3' })
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'OVER_ISSUE' } })
    expect(!refused.ok && refused.refusal.message).toBe('Work order WO-00001 still needs 2.5000 M of LINING GRY; the issue is 3.0000. More is an over-issue: the office issues it with a reason.')
    expect(issueDecision({ ...lining, requested: '3', overIssueReason: '  ' })).toMatchObject({ ok: false, refusal: { code: 'OVER_ISSUE' } })
    expect(issueDecision({ ...lining, requested: '3', overIssueReason: 'Recut of two sleeves' })).toMatchObject({ ok: true, baseQuantity: '3.0000', overIssue: true })
    // Nothing left to issue: the default is nothing, so an over-issue names its quantity.
    const covered = { ...lining, line: { planned: '12.5', issued: '12.5' } }
    expect(issueDecision(covered)).toMatchObject({ ok: false, refusal: { code: 'OVER_ISSUE' } })
    expect(issueDecision({ ...covered, overIssueReason: 'Recut' })).toMatchObject({ ok: false, refusal: { code: 'OVER_ISSUE' } })
    // A hide when the line is covered is an over-issue too.
    expect(issueDecision({ ...base, line: { planned: '110', issued: '110' } })).toMatchObject({ ok: false, refusal: { code: 'OVER_ISSUE' } })
    expect(issueDecision({ ...base, line: { planned: '110', issued: '110' }, overIssueReason: 'Shade mismatch on a front' })).toMatchObject({ ok: true, overIssue: true })
  })
})

describe('return (SCM-216): what the work order did not use, measured', () => {
  const facts = { workOrder: { number: 'WO-00001' }, label: 'LEATHER BLK', baseUom: 'FT2', atWorkOrder: '53.2', cut: '0', hide: { code: 'H-1', state: 'FULL' as const }, baseQuantity: '53.2' }

  it('takes a hide back whole, or its remnant (then REMNANT)', () => {
    expect(returnDecision(facts)).toEqual({ ok: true, hideState: 'FULL' })
    expect(returnDecision({ ...facts, cut: '40', baseQuantity: '9.5' })).toEqual({ ok: true, hideState: 'REMNANT' })
    expect(returnDecision({ ...facts, hide: { code: 'H-1', state: 'PARTLY_CUT' }, cut: '40', baseQuantity: '13.2' })).toEqual({ ok: true, hideState: 'REMNANT' })
    expect(returnDecision({ ...facts, hide: null, label: 'LINING GRY', baseQuantity: '2' })).toEqual({ ok: true, hideState: null })
  })

  it('never more than the work order holds, less what was cut', () => {
    expect(returnDecision({ ...facts, baseQuantity: '53.3' })).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_AT_WORK_ORDER' } })
    const cut = returnDecision({ ...facts, cut: '40', baseQuantity: '13.3' })
    expect(cut).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_AT_WORK_ORDER' } })
    expect(!cut.ok && cut.refusal.message).toContain('at most 13.2000 comes back')
    expect(returnDecision({ ...facts, atWorkOrder: '0' })).toMatchObject({ ok: false, refusal: { code: 'NOTHING_AT_WORK_ORDER' } })
    expect(returnDecision({ ...facts, hide: { code: 'H-1', state: 'CONSUMED' } })).toMatchObject({ ok: false, refusal: { code: 'HIDE_USED_UP' } })
  })

  it('a hide state never goes back to FULL', () => {
    expect(hideStateAfterReturn('FULL', true)).toBe('FULL')
    expect(hideStateAfterReturn('FULL', false)).toBe('REMNANT')
    expect(hideStateAfterReturn('REMNANT', true)).toBe('REMNANT')
    expect(hideStateAfterReturn('CONSUMED', false)).toBe('CONSUMED')
  })
})

describe('undo and reversal: one mirror move per move', () => {
  const issue: PickedMove = { id: 'm-1', reason: 'ISSUE', workOrderId: 'wo', reversalOfId: null, hideId: 'h', baseQuantity: '53.2', fromLocationId: 'bin', toLocationId: null }
  const hide = { code: 'H-1', atWorkOrder: '53.2', cut: '0', baseUom: 'FT2' }

  it('reverses an issue or a return, once, never a reversal', () => {
    expect(reversalRefusal([issue], { reversed: false, workOrderNumber: 'WO-1', hide })).toBeNull()
    expect(reversalRefusal([{ ...issue, reason: 'RETURN', fromLocationId: null, toLocationId: 'bin' }], { reversed: false, workOrderNumber: 'WO-1' })).toBeNull()
    expect(reversalRefusal([issue], { reversed: true, workOrderNumber: 'WO-1', hide })).toMatchObject({ code: 'REVERSED_ALREADY' })
    expect(reversalRefusal([{ ...issue, reversalOfId: 'm-0' }], { reversed: false, workOrderNumber: 'WO-1' })).toMatchObject({ code: 'NOT_IN_WORK_ORDER' })
    expect(reversalRefusal([{ ...issue, reason: 'TRANSFER' }], { reversed: false, workOrderNumber: 'WO-1' })).toMatchObject({ code: 'NOT_IN_WORK_ORDER' })
  })

  it('never takes back the area of a hide that was cut', () => {
    expect(reversalRefusal([issue], { reversed: false, workOrderNumber: 'WO-1', hide: { ...hide, cut: '0.0001' } })).toMatchObject({ code: 'ALREADY_CUT' })
    // Issued twice (a remnant issued again): reversing the second leaves the first's area for the cut.
    expect(reversalRefusal([{ ...issue, baseQuantity: '8' }], { reversed: false, workOrderNumber: 'WO-1', hide: { ...hide, atWorkOrder: '61.2', cut: '40' } })).toBeNull()
  })

  it('undoes only the last issue', () => {
    expect(undoRefusal([issue], 'm-1')).toBeNull()
    expect(undoRefusal([issue], 'm-2')).toMatchObject({ code: 'NOT_LAST_ACTION' })
    expect(undoRefusal([issue], null)).toMatchObject({ code: 'NOT_LAST_ACTION' })
    expect(undoRefusal([{ ...issue, reason: 'RETURN' }], 'm-1')).toMatchObject({ code: 'NOT_IN_WORK_ORDER' })
  })
})

describe('the pick list (SCR-093): need, issued, usable oldest first, held with its reason', () => {
  const material = (id: string, seq: number, cell: number, size: string, quantity: string, colour: string | null = 'blk'): PickMaterial => ({
    id,
    bomLineId: `bom-${seq}`,
    bomSeq: seq,
    placement: null,
    itemId: seq === 10 ? 'leather' : 'lining',
    itemColourId: seq === 10 ? colour : 'gry',
    workOrderSizeId: `cell-${cell}`,
    cellOrder: cell,
    colourwayCode: 'BLK',
    size,
    baseQuantity: quantity,
  })
  const stock = (lotId: string | null, hideId: string | null, onHand: string, extra: Partial<PickStock> = {}): PickStock => ({ locationId: 'bin', locationCode: 'BIN-01', itemId: 'leather', itemColourId: 'blk', lotId, hideId, onHand, ...extra })
  const input: PickInput = {
    materials: [material('m3', 20, 1, '50', '3'), material('m2', 10, 2, '52', '60'), material('m1', 10, 1, '50', '50')],
    items: new Map([
      ['leather', { id: 'leather', code: 'LEATHER', name: 'Nappa', baseUom: 'FT2', tracking: 'HIDE' as const }],
      ['lining', { id: 'lining', code: 'LINING', name: 'Lining', baseUom: 'M', tracking: 'LOT' as const }],
    ]),
    colours: new Map([['blk', { id: 'blk', code: 'BLK', name: 'Black' }]]),
    stock: [
      stock('new', 'h-new', '51.8'),
      stock('old', 'h-old-2', '49'),
      stock('old', 'h-old-1', '53.2', { locationId: 'cut', locationCode: 'CUT' }),
      stock('held', 'h-held', '40'),
      stock('old', 'h-red', '45', { itemColourId: 'red' }),
    ],
    lots: new Map<string, PickLot>([
      ['old', { ...RELEASED, id: 'old', code: 'L-OLD', receivedAt: '2026-09-01T08:00:00.000Z' }],
      ['new', { ...RELEASED, id: 'new', code: 'L-NEW', receivedAt: '2026-10-01T08:00:00.000Z' }],
      ['held', { ...RELEASED, id: 'held', code: 'L-HELD', qualityStatus: 'QUARANTINE', crViStatus: 'PENDING' }],
    ]),
    hides: new Map([
      ['h-old-1', { id: 'h-old-1', code: 'H-OLD-1', state: 'FULL' as const, grade: 'A' }],
      ['h-old-2', { id: 'h-old-2', code: 'H-OLD-2', state: 'FULL' as const, grade: 'B' }],
      ['h-new', { id: 'h-new', code: 'H-NEW', state: 'FULL' as const, grade: 'A' }],
      ['h-held', { id: 'h-held', code: 'H-HELD', state: 'FULL' as const, grade: null }],
      ['h-done', { id: 'h-done', code: 'H-DONE', state: 'PARTLY_CUT' as const, grade: null }],
    ]),
    atWorkOrder: [{ itemId: 'leather', itemColourId: 'blk', lotId: 'old', hideId: 'h-done', quantity: '55' }],
    cuts: new Map([['h-done', '30']]),
  }

  it('lists each material and colour in BOM order, issued shared over its rows', () => {
    const [leather, lining] = pickList(input)
    expect(leather).toMatchObject({ itemCode: 'LEATHER', colourCode: 'BLK', planned: '110.0000', issued: '55.0000', toIssue: '55.0000', over: '0.0000', covered: false })
    expect(leather!.rows.map((row) => [row.materialId, row.planned, row.issued, row.toIssue])).toEqual([
      ['m1', '50.0000', '50.0000', '0.0000'],
      ['m2', '60.0000', '5.0000', '55.0000'],
    ])
    expect(lining).toMatchObject({ itemCode: 'LINING', planned: '3.0000', issued: '0.0000', toIssue: '3.0000', covered: false, usable: { onHand: '0.0000', candidates: [], more: 0 } })
  })

  it('offers usable stock of the same colour oldest first, and names the held stock with its reason', () => {
    const [leather] = pickList(input)
    expect(leather!.usable.onHand).toBe('154.0000')
    expect(leather!.usable.candidates.map((candidate) => [candidate.hideCode, candidate.locationCode])).toEqual([
      ['H-OLD-1', 'CUT'],
      ['H-OLD-2', 'BIN-01'],
      ['H-NEW', 'BIN-01'],
    ])
    expect(leather!.held).toEqual([{ reason: 'CR_VI_PENDING', words: 'no chromium VI test result yet', lotId: 'held', lotCode: 'L-HELD', onHand: '40.0000', hides: 1 }])
    expect(leather!.atWorkOrder).toEqual([{ lotId: 'old', lotCode: 'L-OLD', hideId: 'h-done', hideCode: 'H-DONE', quantity: '55.0000', cut: '30.0000', returnable: '25.0000' }])
  })

  it('counts an over-issue and caps the candidates', () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, index) => stock('old', `x-${String(index).padStart(3, '0')}`, '1'))
    const [leather] = pickList({ ...input, stock: many, atWorkOrder: [{ itemId: 'leather', itemColourId: 'blk', lotId: 'old', hideId: 'h-done', quantity: '120' }] })
    expect(leather).toMatchObject({ issued: '120.0000', toIssue: '0.0000', over: '10.0000', covered: true })
    expect(leather!.usable.candidates).toHaveLength(MAX_CANDIDATES)
    expect(leather!.usable.more).toBe(3)
  })
})
