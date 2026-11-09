import { describe, expect, it } from 'vitest'
import {
  checkpointKindOf,
  checkpointRefusal,
  checkpointWords,
  effectiveDays,
  effectivityWords,
  endOfDays,
  minutesInSize,
  planSettings,
  planVariants,
  releaseDayRefusal,
  revisionOn,
  sameSettings,
  settingLine,
  stepsForCells,
  variantWords,
  workCentresForCells,
  type RevisionDays,
  type StepVariants,
} from './rules'

const CW = { blk: '00000000-0000-4000-8000-000000000001', red: '00000000-0000-4000-8000-000000000002', other: '00000000-0000-4000-8000-000000000003' }
const POST_BED = '00000000-0000-4000-8000-0000000000aa'
const OLD = '00000000-0000-4000-8000-0000000000bb'
const classes = new Map([
  [POST_BED, { id: POST_BED, code: 'POST_BED', active: true }],
  [OLD, { id: OLD, code: 'OLD_FLAT', active: false }],
])
const style = { sizes: ['50', '52', '54', '56'], colourwayIds: [CW.blk, CW.red] }
const every: StepVariants = { sizes: [], colourwayIds: [], optionValueIds: [] }

describe('machine and stitch settings (PRD-118)', () => {
  it('numbers the list, trims, and keeps the stitches as a decimal', () => {
    const plan = planSettings([{ machineClassId: POST_BED, stitchType: '301', needle: '134 LR, Nm 110', thread: 'Tkt 40', stitchesPerCm: '3.50' }, { notes: 'Roller foot on the cuffs' }], classes)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.settings.map((setting) => [setting.seq, setting.stitchesPerCm, setting.notes])).toEqual([
      [1, '3.5', null],
      [2, null, 'Roller foot on the cuffs'],
    ])
    expect(settingLine(plan.settings[0]!, { labelIt: 'Colonna', labelEn: 'Post-bed' }).en).toBe('Post-bed · 301 · 134 LR, Nm 110 · Tkt 40 · 3.5 per cm')
    expect(sameSettings(plan.settings, [...plan.settings])).toBe(true)
    expect(sameSettings(plan.settings, plan.settings.slice(1))).toBe(false)
  })

  it('refuses an empty setting, bad stitches, an unknown or switched-off class, too many', () => {
    const plan = planSettings([{}, { stitchesPerCm: '0' }, { stitchesPerCm: '3.555' }, { machineClassId: CW.other }, { machineClassId: OLD }], classes)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.issues.map((issue) => issue.path)).toEqual(['settings/0', 'settings/1/stitchesPerCm', 'settings/2/stitchesPerCm', 'settings/3/machineClassId', 'settings/4/machineClassId'])
    // A switched-off class the list already names may stay.
    expect(planSettings([{ machineClassId: OLD }], classes, new Set([OLD])).ok).toBe(true)
    expect(planSettings(Array.from({ length: 11 }, () => ({ notes: 'x' })), classes).ok).toBe(false)
  })
})

describe('operations only for some cells (PRD-128)', () => {
  it('plans sizes of the range and colourways of the style, in the style order; no option value yet', () => {
    const plan = planVariants({ sizes: ['56', '54'], colourwayIds: [CW.red, CW.blk], optionValueIds: [] }, style)
    expect(plan).toEqual({ ok: true, variants: { sizes: ['54', '56'], colourwayIds: [CW.blk, CW.red], optionValueIds: [] } })
    const refused = planVariants({ sizes: ['60', '54', '54'], colourwayIds: [CW.other], optionValueIds: [CW.other] }, style)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.issues.map((issue) => issue.path)).toEqual(['sizes/2', 'sizes/0', 'colourwayIds/0', 'optionValueIds'])
  })

  it('keeps the steps a cell needs and says which are left out', () => {
    const steps = [{ id: 'cut' }, { id: 'big' }, { id: 'red' }, { id: 'hood' }]
    const variants = new Map<string, StepVariants>([
      ['big', { sizes: ['56'], colourwayIds: [], optionValueIds: [] }],
      ['red', { sizes: [], colourwayIds: [CW.red], optionValueIds: [] }],
      ['hood', { sizes: [], colourwayIds: [], optionValueIds: [CW.other] }],
    ])
    const { kept, leftOut } = stepsForCells(steps, (id) => variants.get(id), [
      { colourwayId: CW.blk, size: '50' },
      { colourwayId: CW.red, size: '52' },
    ])
    expect(kept.map((step) => step.id)).toEqual(['cut', 'red'])
    expect(leftOut.map((entry) => entry.step.id)).toEqual(['big', 'hood'])
    // A cell that chose the option takes the step; a work order with no cell yet keeps every step.
    expect(stepsForCells(steps, (id) => variants.get(id), [{ colourwayId: CW.blk, size: '56', optionValueIds: [CW.other] }]).kept.map((step) => step.id)).toEqual(['cut', 'big', 'hood'])
    expect(stepsForCells(steps, (id) => variants.get(id), []).kept).toHaveLength(4)
    expect(variantWords({ sizes: ['54', '56'], colourwayIds: [CW.blk], optionValueIds: [] }, () => 'BLK')?.en).toBe('Only for sizes 54, 56 · colourway BLK')
    expect(variantWords(every, () => '')).toBeNull()
  })

  it('holds a release whose cells need no scanned step, in words', () => {
    const big = { step: { seq: 30, code: 'BIG', name: 'Gusset' }, variants: { sizes: ['56'], colourwayIds: [], optionValueIds: [] } }
    const held = workCentresForCells('A1', 2, [{ scanRequired: false }], [big], [], ['BLK 50'])
    expect(held.state).toBe('BLOCKED')
    expect(held.message).toContain('None of the routing\'s scanned steps is for this work order\'s cells (BLK 50)')
    expect(workCentresForCells('A1', 2, [{ scanRequired: true }], [big], [], ['BLK 50']).state).toBe('OK')
    expect(workCentresForCells('A1', 0, [], [], [], []).state).toBe('BLOCKED')
  })

  it('adds the size\'s extra minutes to the run', () => {
    const extras = [{ size: '54', extraMinutes: '4' }, { size: '50', extraMinutes: '-1.5' }]
    expect(minutesInSize('96.5', extras, '54')).toBe('100.5')
    expect(minutesInSize('96.5', extras, '50')).toBe('95')
    expect(minutesInSize('96.5', extras, '52')).toBe('96.5')
  })
})

describe('quality checkpoints (PRD-119)', () => {
  const company = '00000000-0000-4000-8000-0000000000c1'
  it('takes cutting, in-line and end-of-line plans of the style\'s company', () => {
    expect(checkpointRefusal({ code: 'INL-FIRST', stage: 'IN_LINE', companyId: company }, company)).toBeNull()
    expect(checkpointRefusal({ code: 'INL-FIRST', stage: 'IN_LINE', companyId: company }, null)).toBeNull()
    expect(checkpointRefusal({ code: 'FIN-JACKET', stage: 'FINAL', companyId: company }, company)).toContain('final inspection')
    expect(checkpointRefusal({ code: 'INC-LEATHER', stage: 'INCOMING', companyId: company }, company)).toContain('incoming plan')
    expect(checkpointRefusal({ code: 'INL-FIRST', stage: 'IN_LINE', companyId: company }, CW.other)).toContain('another company')
  })

  it('opens the record of the stage and frequency', () => {
    expect(checkpointKindOf('IN_LINE', 'FIRST_PIECE')).toBe('FIRST_PIECE')
    expect(checkpointKindOf('IN_LINE', null)).toBe('ROVING')
    expect(checkpointKindOf('CUTTING', 'EVERY_LOT')).toBe('CUTTING')
    expect(checkpointKindOf('END_OF_LINE', 'EVERY_NTH_BUNDLE')).toBe('END_OF_LINE')
    expect(checkpointKindOf('FINAL', 'EVERY_LOT')).toBeNull()
    const words = checkpointWords({ code: 'INL-ROVE', name: 'Roving', stage: 'IN_LINE', companyId: company, approved: { number: 2, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 3 } })
    expect(words.kind).toBe('ROVING')
    expect(words.does.en).toContain('INL-ROVE v2')
    expect(words.warning).toBeNull()
    expect(checkpointWords({ code: 'INL-NEW', name: 'New', stage: 'IN_LINE', companyId: company, approved: null }).warning?.en).toContain('no approved version')
  })
})

describe('routing versions with effectivity (PRD-124)', () => {
  const rev = (revision: number, status: RevisionDays['status'], releasedOn: string | null, effectiveFrom: string | null, effectiveTo: string | null = null): RevisionDays => ({ id: `r${revision}`, revision, status, effectiveFrom, effectiveTo, releasedOn })

  it('gives each revision its days, a revision released before W2b-4 from its release day', () => {
    const days = effectiveDays([rev(3, 'RELEASED', '2026-11-09', '2026-11-09'), rev(1, 'OBSOLETE', '2026-09-01', null), rev(2, 'OBSOLETE', '2026-10-01', '2026-10-01', '2026-11-09'), rev(4, 'DRAFT', null, null)])
    expect(days.map((entry) => [entry.revision.revision, entry.from, entry.to, entry.fromSource])).toEqual([
      [1, '2026-09-01', '2026-10-01', 'RELEASED_BEFORE'],
      [2, '2026-10-01', '2026-11-09', 'RELEASE'],
      [3, '2026-11-09', null, 'RELEASE'],
      [4, null, null, null],
    ])
    expect(revisionOn(days, '2026-09-15')?.revision.revision).toBe(1)
    expect(revisionOn(days, '2026-11-08')?.revision.revision).toBe(2)
    expect(revisionOn(days, '2026-11-09')?.revision.revision).toBe(3)
    expect(revisionOn(days, '2026-08-01')).toBeNull()
    expect(effectivityWords(revisionOn(days, '2026-11-09'), [{ revision: 2, workOrders: 3 }]).en).toBe("Revision 3 applies to new work orders since 2026-11-09. 3 work orders made before keep revision 2's routing.")
  })

  it('ends a replaced revision on the next release day, unless it began that day', () => {
    expect(endOfDays({ effectiveFrom: '2026-10-01', releasedOn: '2026-10-01', effectiveTo: null }, '2026-11-09')).toBe('2026-11-09')
    expect(endOfDays({ effectiveFrom: null, releasedOn: '2026-09-01', effectiveTo: null }, '2026-11-09')).toBe('2026-11-09')
    expect(endOfDays({ effectiveFrom: '2026-11-09', releasedOn: '2026-11-09', effectiveTo: null }, '2026-11-09')).toBeNull()
    expect(endOfDays({ effectiveFrom: '2026-10-01', releasedOn: '2026-10-01', effectiveTo: '2026-10-05' }, '2026-11-09')).toBeNull()
    // Replaced on its first day: it never applied a whole day.
    const days = effectiveDays([rev(1, 'OBSOLETE', '2026-11-09', '2026-11-09'), rev(2, 'RELEASED', '2026-11-09', '2026-11-09')])
    expect(revisionOn(days, '2026-11-09')?.revision.revision).toBe(2)
    // Withdrawn with no end recorded and no later release: it applies to nothing.
    expect(revisionOn(effectiveDays([rev(1, 'OBSOLETE', '2026-10-01', '2026-10-01')]), '2026-10-20')).toBeNull()
    // Replaced before its first day (released ahead of the clock): its days never begin, and never run backwards.
    const ahead = effectiveDays([rev(1, 'OBSOLETE', '2026-11-10', '2026-11-10'), rev(2, 'RELEASED', '2026-11-09', '2026-11-09')])
    expect(ahead.map((entry) => [entry.from, entry.to])).toEqual([
      ['2026-11-10', '2026-11-10'],
      ['2026-11-09', null],
    ])
    expect(revisionOn(ahead, '2026-11-10')?.revision.revision).toBe(2)
  })

  it('takes effect on its release day only', () => {
    expect(releaseDayRefusal(4, null, '2026-11-09')).toBeNull()
    expect(releaseDayRefusal(4, '2026-11-09', '2026-11-09')).toBeNull()
    expect(releaseDayRefusal(4, '2026-12-01', '2026-11-09')).toContain('planned to take effect on 2026-12-01')
  })
})
