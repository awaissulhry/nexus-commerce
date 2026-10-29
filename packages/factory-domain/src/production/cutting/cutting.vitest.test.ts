import { describe, expect, it } from 'vitest'
import { floorPrivacyStatus, floorReadiness, NO_DPIA_NOTE } from '../../privacy/readiness'
import { floorRulesStatus } from '../settings/monitoring'
import {
  cellProgress,
  closesHide,
  correctionRefusal,
  cutDecision,
  entryPattern,
  floorReadyRefusal,
  hideArea,
  partOf,
  partsOf,
  perGarmentOf,
  setsCut,
  setsNeed,
  stateAfterReversal,
  undoRefusal,
  type CutCell,
  type CutFacts,
  type PlannedPart,
  type ReversalFacts,
} from './rules'

// Figures by hand. Cell BLK 50 makes 2 jackets: its black leather is the outer shell (43 ft² × 1.12 wastage × 2 =
// 96.32 ft²) and a collar (2 ft² × 2 = 4 ft²), so one garment set needs (96.32 + 4) / 2 = 50.16 ft². Cell BLK 52
// makes 1: shell 45 × 1.12 = 50.4 ft² and the collar 2 ft². Its lining is no leather (not a part cut from hides).
const BLK = { itemId: 'leather', itemColourId: 'blk' }
const planned: PlannedPart[] = [
  { cellId: 'c50', ...BLK, part: 'Outer shell', baseQuantity: '96.3200' },
  { cellId: 'c50', ...BLK, part: 'Collar', baseQuantity: '4.0000' },
  { cellId: 'c52', ...BLK, part: 'Outer shell', baseQuantity: '50.4000' },
  { cellId: 'c52', ...BLK, part: 'Collar', baseQuantity: '2.0000' },
]

const cell50: CutCell = { id: 'c50', label: 'BLK 50', quantity: 2, parts: ['Collar', 'Outer shell'], need: '100.3200', cut: new Map() }
const cell52: CutCell = { id: 'c52', label: 'BLK 52', quantity: 1, parts: ['Collar', 'Outer shell'], need: '52.4000', cut: new Map() }

const base: CutFacts = {
  workOrder: { number: 'WO-00001', status: 'IN_PROGRESS' },
  hide: { code: 'H-1', state: 'FULL' },
  lot: { code: 'L-1', qualityStatus: 'RELEASED', requiresCrViTest: true, crViStatus: 'PASS' },
  baseUom: 'FT2',
  atWorkOrder: '120.0000',
  cut: '0',
  cells: new Map([
    ['c50', cell50],
    ['c52', cell52],
  ]),
  lines: [{ cellId: 'c50', sets: 1 }],
  area: null,
  done: null,
  elsewhere: '0',
}

describe('the parts of a cell and its cut count (MES-056)', () => {
  it('names a part by its BOM place, else by the material, and needs per garment what the frozen materials say', () => {
    expect(partOf(' Outer shell ', 'PL-01')).toBe('Outer shell')
    expect(partOf(null, 'PL-01')).toBe('PL-01')
    expect(partOf('  ', 'PL-01')).toBe('PL-01')
    expect(partsOf(planned, 'c50')).toEqual(['Collar', 'Outer shell'])
    expect(partsOf(planned, 'c50', { itemId: 'leather', itemColourId: 'red' })).toEqual([])
    expect(perGarmentOf(planned, { id: 'c50', quantity: 2 }, BLK)?.toFixed(4)).toBe('50.1600')
    expect(perGarmentOf(planned, { id: 'c50', quantity: 2 }, { itemId: 'lining', itemColourId: null })).toBeNull()
    // 100.32 × 1 / 2 = 50.16; a third of 100 is rounded half up to four places.
    expect(setsNeed(planned, { id: 'c50', quantity: 2 }, BLK, 1).toFixed(4)).toBe('50.1600')
    expect(setsNeed([{ cellId: 'x', ...BLK, part: 'P', baseQuantity: '100' }], { id: 'x', quantity: 3 }, BLK, 1).toFixed(4)).toBe('33.3333')
    expect(setsNeed([{ cellId: 'x', ...BLK, part: 'P', baseQuantity: '100' }], { id: 'x', quantity: 3 }, BLK, 2).toFixed(4)).toBe('66.6667')
  })

  it('counts a garment cut once every part of it is cut, and lists parts cut under another name apart', () => {
    expect(setsCut([], new Map())).toBeNull()
    expect(setsCut(['Collar', 'Outer shell'], new Map([['Outer shell', 2]]))).toBe(0)
    const pieces = [
      { cutLogId: 'e1', cellId: 'c50', part: 'Outer shell', pieces: 2 },
      { cutLogId: 'e1', cellId: 'c50', part: 'Collar', pieces: 1 },
      { cutLogId: 'e2', cellId: 'c50', part: 'sleeve', pieces: 2 },
    ]
    const cells = [
      { id: 'c50', quantity: 2 },
      { id: 'c52', quantity: 1 },
      { id: 'lining-only', quantity: 4 },
    ]
    expect(cellProgress(cells, planned, pieces)).toEqual([
      {
        cellId: 'c50',
        quantity: 2,
        cut: 1,
        toCut: 1,
        parts: [
          { part: 'Collar', pieces: 1, planned: true },
          { part: 'Outer shell', pieces: 2, planned: true },
          { part: 'sleeve', pieces: 2, planned: false },
        ],
      },
      { cellId: 'c52', quantity: 1, cut: 0, toCut: 1, parts: [{ part: 'Collar', pieces: 0, planned: true }, { part: 'Outer shell', pieces: 0, planned: true }] },
      // A cell with nothing cut from hides is not counted here: null, never a made-up 0.
      { cellId: 'lining-only', quantity: 4, cut: null, toCut: null, parts: [] },
    ])
  })
})

describe('a cut (MES-056, SCM-194): the pieces per cell, the area from the BOM, never more than the hide has left', () => {
  it('logs one set of every part of the cell, using the BOM need, and leaves the hide partly cut', () => {
    expect(cutDecision(base)).toEqual({
      ok: true,
      entry: {
        areaUsed: '50.1600',
        remnant: '0.0000',
        pattern: '50.1600',
        pieces: [
          { cellId: 'c50', part: 'Collar', pieces: 1 },
          { cellId: 'c50', part: 'Outer shell', pieces: 1 },
        ],
      },
      remnant: '0.0000',
      hideState: 'PARTLY_CUT',
      closes: false,
      left: '69.8400',
    })
    // Two sizes from one hide: 50.16 + 52.4 = 102.56.
    const two = cutDecision({ ...base, lines: [{ cellId: 'c50', sets: 1 }, { cellId: 'c52', sets: 1 }] })
    expect(two).toMatchObject({ ok: true, entry: { areaUsed: '102.5600' }, left: '17.4400' })
  })

  it('refuses a work order not open, a held lot, a used-up hide and a hide the work order does not hold', () => {
    for (const status of ['DRAFT', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const) {
      expect(cutDecision({ ...base, workOrder: { number: 'WO-00001', status } })).toMatchObject({ ok: false, refusal: { code: 'WORK_ORDER_NOT_OPEN' } })
    }
    const pending = cutDecision({ ...base, lot: { code: 'L-2', qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'PENDING' } })
    expect(pending).toEqual({ ok: false, refusal: { code: 'CR_VI_PENDING', message: 'Lot L-2: no chromium VI test result yet. Do not cut this hide; only released leather is cut (REACH Annex XVII entry 47: chromium VI).' } })
    expect(cutDecision({ ...base, lot: { code: 'L-3', qualityStatus: 'BLOCKED', requiresCrViTest: true, crViStatus: 'PASS' } })).toMatchObject({ refusal: { code: 'BLOCKED' } })
    expect(cutDecision({ ...base, hide: { code: 'H-1', state: 'CONSUMED' } })).toMatchObject({ refusal: { code: 'HIDE_USED_UP', message: 'Hide H-1 is used up; it is not cut.' } })
    expect(cutDecision({ ...base, hide: { code: 'H-1', state: 'SCRAPPED' } })).toMatchObject({ refusal: { code: 'HIDE_USED_UP' } })
    expect(cutDecision({ ...base, atWorkOrder: '0' })).toMatchObject({ refusal: { code: 'NOT_AT_WORK_ORDER' } })
    expect(cutDecision({ ...base, cut: '120' })).toMatchObject({ refusal: { code: 'NOTHING_LEFT' } })
  })

  it('refuses a cut bigger than what is left (the area cap), in words with both figures', () => {
    expect(cutDecision({ ...base, cut: '80.0000' })).toEqual({
      ok: false,
      refusal: { code: 'AREA_EXCEEDED', message: 'Hide H-1 has 40.0000 FT2 left for work order WO-00001; these pieces need 50.1600 (the BOM). Log fewer pieces, or close the hide with Hide done.' },
    })
    // Exactly what is left fits.
    expect(cutDecision({ ...base, cut: '69.8400' })).toMatchObject({ ok: true, entry: { areaUsed: '50.1600' }, left: '0.0000' })
    // A typed area is held to the same cap.
    expect(cutDecision({ ...base, cut: '110', lines: [{ cellId: 'c50', parts: [{ part: 'Collar', pieces: 1 }] }], area: '10.0001' })).toMatchObject({ refusal: { code: 'AREA_EXCEEDED' } })
  })

  it('holds a size that is all cut, also across two lines of one cell, and a cell that does not use the leather', () => {
    const cut = new Map([
      ['Outer shell', 2],
      ['Collar', 2],
    ])
    const allCut = cutDecision({ ...base, cells: new Map([['c50', { ...cell50, cut }]]) })
    expect(allCut).toEqual({ ok: false, refusal: { code: 'CELL_ALL_CUT', message: 'BLK 50 is all cut (2 garments).' } })
    expect(cutDecision({ ...base, lines: [{ cellId: 'c50', sets: 3 }] })).toMatchObject({ refusal: { code: 'CELL_ALL_CUT', message: 'BLK 50 has 2 garments to cut; this logs 3 sets.' } })
    expect(cutDecision({ ...base, lines: [{ cellId: 'c50', sets: 1 }, { cellId: 'c50', sets: 2 }] })).toMatchObject({ refusal: { code: 'CELL_ALL_CUT' } })
    // A recut part of a size that is all cut is still logged (by name, with its area).
    expect(cutDecision({ ...base, cells: new Map([['c50', { ...cell50, cut }]]), lines: [{ cellId: 'c50', parts: [{ part: 'Collar', pieces: 1 }] }], area: '2.5' })).toMatchObject({
      ok: true,
      entry: { areaUsed: '2.5000', pattern: '0.0000', pieces: [{ cellId: 'c50', part: 'Collar', pieces: 1 }] },
    })
    const lining: CutCell = { id: 'c54', label: 'RED 54', quantity: 1, parts: [], need: '0', cut: new Map() }
    expect(cutDecision({ ...base, cells: new Map([['c54', lining]]), lines: [{ cellId: 'c54', sets: 1 }] })).toMatchObject({ refusal: { code: 'NOT_FOR_CELL', message: "Work order WO-00001 RED 54 does not use this hide's leather." } })
    expect(cutDecision({ ...base, lines: [{ cellId: 'nope', sets: 1 }] })).toMatchObject({ refusal: { code: 'NOT_FOR_CELL' } })
  })

  it('needs pieces, and a typed area for single parts (the BOM has none for them)', () => {
    expect(cutDecision({ ...base, lines: [] })).toMatchObject({ refusal: { code: 'NO_PIECES' } })
    expect(cutDecision({ ...base, lines: [{ cellId: 'c50', sets: 0, parts: [] }] })).toMatchObject({ refusal: { code: 'NO_PIECES' } })
    expect(cutDecision({ ...base, lines: [{ cellId: 'c50', parts: [{ part: 'Collar', pieces: 1 }] }] })).toMatchObject({ refusal: { code: 'AREA_UNKNOWN' } })
    // Single parts merge with the sets' parts of the same name.
    expect(cutDecision({ ...base, lines: [{ cellId: 'c50', sets: 1, parts: [{ part: ' Collar ', pieces: 1 }] }], area: '53' })).toMatchObject({
      ok: true,
      entry: { areaUsed: '53.0000', pattern: '50.1600', pieces: [{ cellId: 'c50', part: 'Collar', pieces: 2 }, { cellId: 'c50', part: 'Outer shell', pieces: 1 }] },
    })
  })
})

describe('Hide done (MES-058, SCM-253): the rest is used, the remnant goes back, or the hide is used up', () => {
  it('uses what is left minus the remnant, shown, not typed, and the hide becomes a remnant', () => {
    expect(cutDecision({ ...base, cut: '50.16', lines: [{ cellId: 'c52', sets: 1 }], done: { remnant: '12.5' } })).toEqual({
      ok: true,
      // 120 − 50.16 − 12.5 = 57.34 used: the pattern 52.4 and 4.94 of waste.
      entry: { areaUsed: '57.3400', remnant: '12.5000', pattern: '52.4000', pieces: [{ cellId: 'c52', part: 'Collar', pieces: 1 }, { cellId: 'c52', part: 'Outer shell', pieces: 1 }] },
      remnant: '12.5000',
      hideState: 'REMNANT',
      closes: true,
      left: '0.0000',
    })
  })

  it('without a remnant the hide is used up, unless some of it is still in stock or at another work order', () => {
    expect(cutDecision({ ...base, cut: '100', lines: [], done: { remnant: '0' } })).toMatchObject({ ok: true, entry: { areaUsed: '20.0000', pattern: '0.0000', pieces: [] }, hideState: 'CONSUMED' })
    expect(cutDecision({ ...base, cut: '100', lines: [], done: { remnant: '0' }, elsewhere: '8' })).toMatchObject({ ok: true, hideState: 'PARTLY_CUT' })
    expect(cutDecision({ ...base, hide: { code: 'H-1', state: 'REMNANT' }, cut: '100', lines: [], done: { remnant: '0' }, elsewhere: '8' })).toMatchObject({ ok: true, hideState: 'REMNANT' })
    // All of it cut already: closing writes no entry, the hide is used up.
    expect(cutDecision({ ...base, cut: '120', lines: [], done: { remnant: '0' } })).toEqual({ ok: true, entry: null, remnant: '0.0000', hideState: 'CONSUMED', closes: true, left: '0.0000' })
    // The remnant is all that is left: only the remnant goes back.
    expect(cutDecision({ ...base, cut: '100', lines: [], done: { remnant: '20' } })).toMatchObject({ ok: true, entry: null, remnant: '20.0000', hideState: 'REMNANT' })
  })

  it('refuses a remnant larger than what is left, and one that leaves nothing for the pieces', () => {
    expect(cutDecision({ ...base, cut: '100', lines: [], done: { remnant: '20.0001' } })).toEqual({
      ok: false,
      refusal: { code: 'REMNANT_TOO_LARGE', message: 'Hide H-1 has 20.0000 FT2 left for work order WO-00001; the remnant is at most 20.0000.' },
    })
    expect(cutDecision({ ...base, cut: '100', done: { remnant: '20' } })).toMatchObject({ refusal: { code: 'REMNANT_TOO_LARGE', message: expect.stringContaining('less than 20.0000') } })
    expect(cutDecision({ ...base, done: { remnant: '-1' } })).toMatchObject({ refusal: { code: 'REMNANT_TOO_LARGE' } })
  })
})

describe('undo and correction: a mirror entry, once, while the hide can still be cut', () => {
  const facts: ReversalFacts = { entry: { id: 'e1', reversalOfId: null, reversed: false }, workOrder: { number: 'WO-00001', status: 'IN_PROGRESS' }, hide: { code: 'H-1', state: 'PARTLY_CUT', closingCutLogId: null }, bundles: [] }
  /** H-1 used up by entry e1 (its closing entry), or by another entry e9. */
  const usedUpBy = (closingCutLogId: string | null) => ({ ...facts, hide: { code: 'H-1', state: 'CONSUMED' as const, closingCutLogId } })

  it('lets the office correct any live entry of an open work order', () => {
    expect(correctionRefusal(facts)).toBeNull()
    expect(correctionRefusal({ ...facts, entry: { id: 'e1', reversalOfId: 'e0', reversed: false } })).toMatchObject({ code: 'NOT_A_CUT' })
    expect(correctionRefusal({ ...facts, entry: { id: 'e1', reversalOfId: null, reversed: true } })).toMatchObject({ code: 'REVERSED_ALREADY' })
    expect(correctionRefusal({ ...facts, workOrder: { number: 'WO-00001', status: 'COMPLETED' } })).toMatchObject({ code: 'WORK_ORDER_NOT_OPEN' })
    expect(correctionRefusal({ ...facts, hide: { code: 'H-1', state: 'SCRAPPED', closingCutLogId: null } })).toMatchObject({ code: 'HIDE_USED_UP', message: expect.stringContaining('Hide H-1 is scrapped') })
    expect(correctionRefusal({ ...facts, bundles: ['BN-1', 'BN-2'] })).toEqual({ code: 'IN_BUNDLE', message: 'The pieces of this cut travel in bundles BN-1, BN-2: void them first.' })
  })

  it("a used-up hide's cuts are final, but its closing cut: correcting that one opens the hide again", () => {
    expect(correctionRefusal(usedUpBy('e9'))).toEqual({
      code: 'HIDE_USED_UP',
      message: 'Hide H-1 is used up: its cuts are final but its closing cut. Correct the closing cut first (that opens the hide again), then this one.',
    })
    expect(correctionRefusal(usedUpBy(null))).toMatchObject({ code: 'HIDE_USED_UP' })
    expect(correctionRefusal(usedUpBy('e1'))).toBeNull()
    expect(closesHide(usedUpBy('e1'))).toBe(true)
    expect(closesHide(usedUpBy('e9'))).toBe(false)
    expect(closesHide({ ...facts, hide: { code: 'H-1', state: 'PARTLY_CUT', closingCutLogId: 'e1' } })).toBe(false)
    // The closing cut's pieces in a bundle: void it first, as for any cut.
    expect(correctionRefusal({ ...usedUpBy('e1'), bundles: ['BN-1'] })).toMatchObject({ code: 'IN_BUNDLE' })
    // A reversal of it opens the hide; a remnant whose return the undo took back is cut on; else the state stays.
    expect(stateAfterReversal({ state: 'CONSUMED', reopens: true, remnantReturnReversed: false })).toBe('PARTLY_CUT')
    expect(stateAfterReversal({ state: 'CONSUMED', reopens: false, remnantReturnReversed: false })).toBe('CONSUMED')
    expect(stateAfterReversal({ state: 'REMNANT', reopens: false, remnantReturnReversed: true })).toBe('PARTLY_CUT')
    expect(stateAfterReversal({ state: 'REMNANT', reopens: false, remnantReturnReversed: false })).toBe('REMNANT')
    expect(stateAfterReversal({ state: 'PARTLY_CUT', reopens: false, remnantReturnReversed: false })).toBe('PARTLY_CUT')
  })

  it("lets the cutter undo only their own last entry on the tablet", () => {
    expect(undoRefusal({ ...facts, own: true, latest: true })).toBeNull()
    expect(undoRefusal({ ...facts, own: false, latest: true })).toMatchObject({ code: 'NOT_LAST_ACTION' })
    expect(undoRefusal({ ...facts, own: true, latest: false })).toMatchObject({ code: 'NOT_LAST_ACTION' })
    expect(undoRefusal({ ...facts, own: true, latest: true, entry: { id: 'e1', reversalOfId: null, reversed: true } })).toMatchObject({ code: 'REVERSED_ALREADY' })
    expect(undoRefusal({ ...usedUpBy('e9'), own: true, latest: true })).toMatchObject({ code: 'HIDE_USED_UP' })
    // The closing cut (a Hide done tapped by mistake) is the cutter's to undo, like any last entry.
    expect(undoRefusal({ ...usedUpBy('e1'), own: true, latest: true })).toBeNull()
    expect(undoRefusal({ ...usedUpBy('e1'), own: true, latest: false })).toMatchObject({ code: 'NOT_LAST_ACTION' })
    expect(undoRefusal({ ...facts, own: true, latest: true, bundles: ['BN-1'] })).toMatchObject({ code: 'IN_BUNDLE' })
  })
})

describe("a hide's area for a work order (MES-057): cut + waste + returned + left = issued", () => {
  const cells = new Map([
    ['c50', { parts: ['Collar', 'Outer shell'], need: '100.3200', quantity: 2 }],
    ['c52', { parts: ['Collar', 'Outer shell'], need: '52.4000', quantity: 1 }],
  ])

  it('gives an entry of whole sets the BOM need, one of single parts no pattern, and one without pieces none', () => {
    expect(entryPattern([{ cellId: 'c50', part: 'Collar', pieces: 1 }, { cellId: 'c50', part: 'Outer shell', pieces: 1 }], cells)?.toFixed(4)).toBe('50.1600')
    expect(entryPattern([{ cellId: 'c50', part: 'Collar', pieces: 2 }, { cellId: 'c50', part: 'Outer shell', pieces: 1 }], cells)).toBeNull()
    expect(entryPattern([{ cellId: 'c50', part: 'sleeve', pieces: 2 }], cells)).toBeNull()
    expect(entryPattern([], cells)?.toFixed(4)).toBe('0.0000')
  })

  it('splits the area: the pattern is cut, the rest of an entry is waste, the remnant returned, the rest left', () => {
    // 120 issued: a set (50.16), Hide done with a remnant of 12.5 → the last entry used 57.34 for a 52.4 set.
    expect(hideArea({ issued: '120', returned: '12.5', entries: [{ areaUsed: '50.16', pattern: '50.16' }, { areaUsed: '57.34', pattern: '52.4' }] })).toEqual({
      issued: '120.0000',
      cut: '102.5600',
      waste: '4.9400',
      returned: '12.5000',
      left: '0.0000',
    })
    // An open hide: one set and a recut part with its typed area.
    expect(hideArea({ issued: '120', returned: '0', entries: [{ areaUsed: '50.16', pattern: '50.16' }, { areaUsed: '2.5', pattern: null }] })).toEqual({
      issued: '120.0000',
      cut: '52.6600',
      waste: '0.0000',
      returned: '0.0000',
      left: '67.3400',
    })
  })
})

describe("the floor's readiness (B-W1-36, B-W1-37): no cut is logged before the site's floor is ready", () => {
  const privacy = (dpia: boolean, notice: boolean) =>
    floorPrivacyStatus({ dpia: dpia ? { versionNo: 1, reviewDueOn: null } : null, workerNotice: notice ? { label: '2026-10' } : null, today: '2026-11-20' })
  const rules = (basis: boolean) => floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: basis })

  it('lets a ready floor cut, and refuses one without a DPIA, a worker notice or a legal basis, in the gate\'s words', () => {
    expect(floorReadyRefusal(floorReadiness(privacy(true, true), rules(true)))).toBeNull()
    expect(floorReadyRefusal(floorReadiness(privacy(false, true), rules(true)))).toEqual({ code: 'FLOOR_NOT_READY', message: `Cutting is held at this site until its floor is ready: ${NO_DPIA_NOTE}` })
    const noNotice = floorReadyRefusal(floorReadiness(privacy(true, false), rules(true)))
    expect(noNotice).toMatchObject({ code: 'FLOOR_NOT_READY', message: expect.stringContaining('No worker notice is published') })
    const noBasis = floorReadyRefusal(floorReadiness(privacy(true, true), rules(false)))
    expect(noBasis).toMatchObject({ code: 'FLOOR_NOT_READY', message: expect.stringContaining('no legal basis is on record') })
    expect(noBasis!.message).not.toContain('is in force')
    expect(floorReadyRefusal(null)).toMatchObject({ code: 'FLOOR_NOT_READY' })
  })
})
