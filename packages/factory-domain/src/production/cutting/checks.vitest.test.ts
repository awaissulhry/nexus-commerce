import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import type { ShadeFacts } from '../../inventory/reservations/shade'
import {
  CUT_WARNING_KINDS,
  cutOverrideReasonText,
  cutOverrideRefusal,
  garmentShadeWarning,
  gradeWarning,
  kindsOf,
  measuredThicknessProblem,
  orderShadeWarning,
  piecesOfCut,
  standingWarnings,
  thicknessCheck,
  thicknessWarning,
  warningsRefusal,
  wrongHideWarning,
  type CutWarning,
  type GradeRef,
  type HideIdentity,
  type PieceRef,
  type PlannedLine,
  type ReservedLeather,
} from './checks'
import { CUT_REFUSALS } from './rules'

// Made-up hides of two lots: LA-1 shade 2 (a group) and LA-2 shade 3; HD-9 of LA-1 is out of shade.
const shade = (hideId: string, lotId: string, label: string | null, extra: Partial<ShadeFacts> = {}): ShadeFacts => ({
  hideId,
  hideCode: hideId.toUpperCase(),
  lotId,
  lotCode: lotId.toUpperCase(),
  shadeGroupId: label ? `g-${lotId}-${label}` : null,
  shadeLabel: label,
  outOfShade: false,
  ...extra,
})
const hd1 = shade('hd-1', 'la-1', '2')
const hd2 = shade('hd-2', 'la-1', '2')
const hd3 = shade('hd-3', 'la-2', '3')

describe('SHADE (MES-053): one shade lot per order, as the pick rules it; the table warns', () => {
  it('passes the first hide, a hide of the same shade lot, and every hide under GARMENT or OFF', () => {
    expect(orderShadeWarning('ORDER', 'WO-1', [], hd1)).toBeNull()
    expect(orderShadeWarning('ORDER', 'WO-1', [hd1], hd1)).toBeNull()
    expect(orderShadeWarning('ORDER', 'WO-1', [hd1], hd2)).toBeNull()
    expect(orderShadeWarning('GARMENT', 'WO-1', [hd1], hd3)).toBeNull()
    expect(orderShadeWarning('OFF', 'WO-1', [hd1], hd3)).toBeNull()
  })

  it('warns about another shade lot, naming both in words and facts', () => {
    const warning = orderShadeWarning('ORDER', 'WO-1', [hd1, hd2], hd3)!
    expect(warning).toMatchObject({ kind: 'SHADE', code: 'SHADE_LOT', shade: { rule: 'ORDER', cutFrom: [{ lotCode: 'LA-1', shadeLabel: '2' }], hide: { lotCode: 'LA-2', shadeLabel: '3', outOfShade: false }, cell: null } })
    expect(warning.message).toBe('Work order WO-1 is cut from lot LA-1, shade 2; hide HD-3 is lot LA-2, shade 3. One shade lot per order: take a hide of the same shade lot, or a lead lets it be cut anyway with their PIN and a reason.')
  })

  it('warns about an out-of-shade hide even as the first one', () => {
    const out = shade('hd-9', 'la-1', 'X', { outOfShade: true })
    expect(orderShadeWarning('ORDER', 'WO-1', [], out)).toMatchObject({ kind: 'SHADE', code: 'OUT_OF_SHADE', shade: { hide: { outOfShade: true } } })
  })

  it('GARMENT: a part that completes a garment matches the shade lot its other parts came from', () => {
    const cells = new Map([['c52', { label: 'BLK 52', parts: ['Collar', 'Outer shell'] }]])
    // One whole set from HD-1, then the shell of a second garment from HD-1: its collar is still to cut.
    const live = [
      { cellId: 'c52', part: 'Collar', pieces: 1, shade: hd1 },
      { cellId: 'c52', part: 'Outer shell', pieces: 1, shade: hd1 },
      { cellId: 'c52', part: 'Outer shell', pieces: 1, shade: hd1 },
    ]
    const warning = garmentShadeWarning('GARMENT', cells, live, [{ cellId: 'c52', part: 'Collar' }], hd3)!
    expect(warning).toMatchObject({ kind: 'SHADE', code: 'GARMENT_SHADE', shade: { rule: 'GARMENT', cutFrom: [{ lotCode: 'LA-1', shadeLabel: '2' }], cell: 'BLK 52' } })
    expect(warning.message).toContain('Garment BLK 52: its Outer shell is from lot LA-1, shade 2; hide HD-3 is lot LA-2, shade 3.')
    // The same shade lot, a part that starts a new garment, or another rule: nothing to say.
    expect(garmentShadeWarning('GARMENT', cells, live, [{ cellId: 'c52', part: 'Collar' }], hd2)).toBeNull()
    expect(garmentShadeWarning('GARMENT', cells, live, [{ cellId: 'c52', part: 'Outer shell' }], hd3)).toBeNull()
    expect(garmentShadeWarning('ORDER', cells, live, [{ cellId: 'c52', part: 'Collar' }], hd3)).toBeNull()
  })
})

describe('WRONG_HIDE (MES-063): the hide against the work order’s own waiting reservations', () => {
  const hide: HideIdentity = { id: 'hd-3', code: 'HD-3', lotId: 'la-2', lotCode: 'LA-2', itemColourId: 'blk', grade: 'C' }
  const byName = (id: string, lot: string, grade: string | null): ReservedLeather => ({ kind: 'HIDE', hideId: id, hideCode: id.toUpperCase(), lotId: lot, lotCode: lot.toUpperCase(), itemColourId: 'blk', grade })
  const area = (lot: string | null, colour = 'blk'): ReservedLeather => ({ kind: 'AREA', hideId: null, hideCode: null, lotId: lot, lotCode: lot ? lot.toUpperCase() : null, itemColourId: colour, grade: null })

  it('says nothing without a reservation, for its own hide, or for an area it fits', () => {
    expect(wrongHideWarning('WO-1', [], hide)).toBeNull()
    expect(wrongHideWarning('WO-1', [byName('hd-3', 'la-2', 'C')], hide)).toBeNull()
    expect(wrongHideWarning('WO-1', [byName('hd-1', 'la-1', 'A'), area(null)], hide)).toBeNull()
    expect(wrongHideWarning('WO-1', [area('la-2')], hide)).toBeNull()
  })

  it('names the reserved hides and what differs (lot, grade)', () => {
    const warning = wrongHideWarning('WO-1', [byName('hd-2', 'la-1', 'A'), byName('hd-1', 'la-1', 'A')], hide)!
    expect(warning).toMatchObject({
      kind: 'WRONG_HIDE',
      code: 'NOT_RESERVED',
      wrongHide: { reservedHides: [{ code: 'HD-1', lotCode: 'LA-1', grade: 'A' }, { code: 'HD-2', lotCode: 'LA-1', grade: 'A' }], reservedLots: ['LA-1'], differs: ['LOT', 'GRADE'], hide: { lotCode: 'LA-2', grade: 'C' } },
    })
    expect(warning.message).toBe('Work order WO-1 has 2 hides reserved for it (HD-1, HD-2); hide HD-3 is not one of them (lot LA-2, not LA-1; grade C, not A). Take a reserved hide, or a lead lets it be cut anyway with their PIN and a reason.')
  })

  it('names the reserved lot of an area, and another colour', () => {
    expect(wrongHideWarning('WO-1', [area('la-1')], hide)).toMatchObject({ code: 'RESERVED_LOT', wrongHide: { reservedHides: [], reservedLots: ['LA-1'], differs: ['LOT'] } })
    expect(wrongHideWarning('WO-1', [area('la-1', 'red')], hide)).toMatchObject({ code: 'RESERVED_LOT', wrongHide: { differs: ['COLOUR', 'LOT'] } })
  })
})

describe('THICKNESS (MES-064): the table’s measure, else the hide’s record, against the leather’s range', () => {
  const spec = { minMm: '1.10', maxMm: '1.30' }
  it('reads the table first, and says when it cannot tell', () => {
    expect(thicknessCheck({ minMm: null, maxMm: null, recordedMm: '1.20', measuredMm: null }).verdict).toBe('NO_SPEC')
    expect(thicknessCheck({ ...spec, recordedMm: null, measuredMm: null })).toEqual({ verdict: 'UNKNOWN', valueMm: null, source: null, minMm: '1.10', maxMm: '1.30' })
    expect(thicknessCheck({ ...spec, recordedMm: '1.2', measuredMm: null })).toEqual({ verdict: 'OK', valueMm: '1.20', source: 'HIDE', minMm: '1.10', maxMm: '1.30' })
    expect(thicknessCheck({ ...spec, recordedMm: '1.2', measuredMm: '1.05' })).toMatchObject({ verdict: 'THIN', valueMm: '1.05', source: 'TABLE' })
    expect(thicknessCheck({ ...spec, recordedMm: '1.31', measuredMm: null }).verdict).toBe('THICK')
    expect(thicknessCheck({ minMm: '1.10', maxMm: null, recordedMm: '1.10', measuredMm: null }).verdict).toBe('OK')
  })

  it('warns outside the range only, and asks a measure at the table for a recorded thickness', () => {
    expect(thicknessWarning(thicknessCheck({ ...spec, recordedMm: '1.2', measuredMm: null }), 'HD-1', 'LEA-100')).toBeNull()
    const recorded = thicknessWarning(thicknessCheck({ ...spec, recordedMm: '0.95', measuredMm: null }), 'HD-1', 'LEA-100')!
    expect(recorded).toMatchObject({ kind: 'THICKNESS', code: 'THIN', thickness: { valueMm: '0.95', source: 'HIDE', minMm: '1.10', maxMm: '1.30' } })
    expect(recorded.message).toBe('Hide HD-1 is 0.95 mm (as recorded on the hide); leather LEA-100 is specified 1.10–1.30 mm. Take another hide, or a lead lets it be cut anyway with their PIN and a reason once the thickness is measured at the table.')
    expect(thicknessWarning(thicknessCheck({ ...spec, recordedMm: null, measuredMm: '1.45' }), 'HD-1', 'LEA-100')!.message).toContain('1.45 mm (measured at the table)')
  })

  it('takes a typed thickness above 0, below 100, two decimals at most', () => {
    expect(measuredThicknessProblem(undefined)).toBeNull()
    expect(measuredThicknessProblem('1.25')).toBeNull()
    expect(measuredThicknessProblem('1.255')).not.toBeNull()
    expect(measuredThicknessProblem('0')).not.toBeNull()
    expect(measuredThicknessProblem('1,2')).not.toBeNull()
  })
})

describe('GRADE (MES-055): the pieces a cut makes against the hide’s grade', () => {
  const A: GradeRef = { id: 'a', code: 'A', sortOrder: 1 }
  const B: GradeRef = { id: 'b', code: 'B', sortOrder: 2 }
  const C: GradeRef = { id: 'c', code: 'C', sortOrder: 3 }
  const pieces: PieceRef[] = [
    { name: 'Front left', bomLineId: 'shell', minGrade: B, sizes: [] },
    { name: 'Sleeve', bomLineId: 'shell', minGrade: C, sizes: ['52', '54'] },
    { name: 'Collar', bomLineId: null, minGrade: A, sizes: [] },
    { name: 'Pocket bag', bomLineId: 'lining', minGrade: null, sizes: [] },
  ]
  const planned: PlannedLine[] = [
    { cellId: 'c50', bomLineId: 'shell', part: 'Outer shell' },
    { cellId: 'c50', bomLineId: 'collar', part: 'collar' },
    { cellId: 'c52', bomLineId: 'shell', part: 'Outer shell' },
  ]

  it('finds the pieces of each part by BOM line or by name, in the cell’s size', () => {
    expect(piecesOfCut(pieces, planned, [{ cellId: 'c50', size: '50', parts: ['Outer shell', 'collar'] }]).map((piece) => piece.name)).toEqual(['Collar', 'Front left'])
    expect(piecesOfCut(pieces, planned, [{ cellId: 'c52', size: '52', parts: ['Outer shell'] }]).map((piece) => piece.name)).toEqual(['Front left', 'Sleeve'])
    expect(piecesOfCut(pieces, planned, [{ cellId: 'c52', size: '52', parts: ['sleeve'] }]).map((piece) => piece.name)).toEqual(['Sleeve'])
  })

  it('warns about pieces below the hide’s grade, and about a hide with no grade', () => {
    const cut = piecesOfCut(pieces, planned, [{ cellId: 'c52', size: '52', parts: ['Outer shell'] }])
    expect(gradeWarning('HD-1', A, cut)).toBeNull()
    expect(gradeWarning('HD-1', B, cut)).toBeNull()
    const below = gradeWarning('HD-1', C, cut)!
    expect(below).toMatchObject({ kind: 'GRADE', code: 'BELOW', grade: { hideGrade: 'C', pieces: [{ name: 'Front left', minGrade: 'B' }] } })
    expect(below.message).toBe('Hide HD-1 is grade C; Front left asks B or better. Cut other pieces from it, or a lead lets it be cut anyway with their PIN and a reason.')
    expect(gradeWarning('HD-1', null, cut)).toMatchObject({ code: 'UNGRADED', grade: { hideGrade: null, pieces: [{ name: 'Front left', minGrade: 'B' }, { name: 'Sleeve', minGrade: 'C' }] } })
    expect(gradeWarning('HD-1', null, [pieces[3]!])).toBeNull()
  })
})

describe('"Cut anyway": what stands, the lead, the reason', () => {
  const w = (kind: CutWarning['kind'], code: CutWarning['code']): CutWarning => ({ kind, code, message: `${kind} words.` })

  it('drops what a lead passed for this hide; records the kinds in the database order; refuses in one sentence', () => {
    const warnings = [w('GRADE', 'BELOW'), w('SHADE', 'SHADE_LOT'), w('THICKNESS', 'THIN')]
    expect(standingWarnings(warnings, ['SHADE']).map((warning) => warning.kind)).toEqual(['GRADE', 'THICKNESS'])
    expect(kindsOf(warnings)).toEqual(['SHADE', 'THICKNESS', 'GRADE'])
    expect(CUT_WARNING_KINDS).toEqual(['SHADE', 'WRONG_HIDE', 'THICKNESS', 'GRADE'])
    const refusal = warningsRefusal([warnings[1]!], null)
    expect(refusal).toMatchObject({ code: 'CUT_WARNING', message: 'This hide has warnings: SHADE words.', final: true })
    expect(CUT_REFUSALS).toContain(refusal.code)
    expect(warningsRefusal([warnings[0]!], ['SHADE']).message).toBe('The lead signed for other warnings than stand now: GRADE words.')
  })

  it('takes a lead other than the cutter, with the right, and a note with Other', () => {
    const facts = { leadId: 'lead', cutterId: 'cutter', mayOverride: true, reasonCode: 'CHECKED_BY_EYE' as const, note: null }
    expect(cutOverrideRefusal(facts)).toBeNull()
    expect(cutOverrideRefusal({ ...facts, leadId: 'cutter' })?.code).toBe('LEAD_IS_CUTTER')
    expect(cutOverrideRefusal({ ...facts, mayOverride: false })?.code).toBe('NOT_A_LEAD')
    expect(cutOverrideRefusal({ ...facts, reasonCode: 'OTHER' })?.code).toBe('LEAD_NOTE_MISSING')
    expect(cutOverrideReasonText('OTHER', 'customer sample')).toBe('Other (say why): customer sample')
    expect(cutOverrideReasonText('NO_OTHER_HIDE', null)).toBe('No other hide available')
  })
})

describe('the lead’s right (production.cut.override)', () => {
  it('is a floor-shared write right of the team leader (and the owner), never the cutter’s', () => {
    expect(FACTORY_PERMISSIONS.get('production.cut.override')).toMatchObject({ area: 'production', risk: 'write' })
    expect(FLOOR_SHARED_PERMISSIONS).toContain('production.cut.override')
    expect(templateOf('team_leader')?.permissions).toContain('production.cut.override')
    expect(templateOf('owner')?.permissions).toContain('production.cut.override')
    for (const key of ['operator', 'cutting_operator', 'floor_inspector', 'production_manager', 'read_only']) expect(templateOf(key)?.permissions ?? []).not.toContain('production.cut.override')
  })
})
