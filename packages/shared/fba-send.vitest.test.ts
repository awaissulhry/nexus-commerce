import { describe, expect, it } from 'vitest'
import {
  FBA_CANCELLABLE_STATUSES, FBA_CLAIMABLE_STATUSES, FBA_CLOSED_STATUSES, FBA_JOB_STATUSES, FBA_PERSON_STATUSES,
  FBA_AMAZON_STATUSES, FBA_PLAN_STATUSES, FBA_PLAN_STEPS, FBA_SEND_COPY, FBA_STEP_STATUS, MIXED_BOX_DEFAULT, MIXED_BOX_FILL,
  addressMissing, effectiveOwners, fbaAmazonPlanName, fbaInboundShown, fbaPlanCan, isFbaPlanOpen, isFbaPlanStatus, lengthCm, lineUnits,
  mixedBoxProblem, nextWorkingDay, planBoxes, sendProblems, sendSummary, unitWeightKg,
  type FbaBoxSku, type FbaSendDraft, type FbaSendSku, type FbaSendChoice,
} from './fba-send.js'

const sku = (over: Partial<FbaSendSku> & { productId: string }): FbaSendSku => ({
  sku: over.productId.toUpperCase(),
  msku: `${over.productId.toUpperCase()}-AMZ`,
  name: over.productId,
  unitsPerCase: null,
  case: null,
  unitWeightKg: 1,
  unit: { lengthCm: 10, widthCm: 10, heightCm: 5 },
  onHand: 100,
  free: 100,
  freeSealed: 0,
  freeLoose: 100,
  prepOwner: 'SELLER',
  labelOwner: 'SELLER',
  openPlanUnits: 0,
  ...over,
})

const draftOf = (skus: FbaSendSku[], over: Partial<FbaSendDraft> = {}): FbaSendDraft => ({
  from: { id: 'loc1', code: 'IT-MAIN', name: 'Main', town: 'Rimini', country: 'IT', isDefault: true },
  locations: [{ id: 'loc1', code: 'IT-MAIN', name: 'Main', town: 'Rimini', country: 'IT', isDefault: true }],
  market: 'IT',
  markets: [{ code: 'IT', marketplaceId: 'APJ6JRA9NG5V4', name: 'Amazon IT', accountId: 'acct1' }],
  readyToShipOn: '2026-10-08',
  today: '2026-10-07',
  address: { missing: [], summary: 'Via Uno 1, 47900 Rimini, IT' },
  mixedBox: { ...MIXED_BOX_DEFAULT },
  skus,
  ...over,
})

const choiceOf = (lines: FbaSendChoice['lines'], over: Partial<FbaSendChoice> = {}): FbaSendChoice =>
  ({ lines, readyToShipOn: '2026-10-08', ...over })

const mixedOnly = (r: ReturnType<typeof planBoxes>) => r.boxes.filter(b => b.kind === 'mixed')
const codes = (problems: Array<{ code: string }>) => problems.map(p => p.code)

/** Deterministic pseudo-random numbers (no Math.random in a test). */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

describe('planBoxes — whole cases', () => {
  it('sends whole cases as identical case boxes: one entry per SKU, quantity = cases', () => {
    const a = sku({ productId: 'a', unitsPerCase: 12, case: { lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 9 } })
    const r = planBoxes([{ productId: 'a', cases: 3, looseUnits: 0 }], [a], MIXED_BOX_DEFAULT)
    expect(r.boxes).toEqual([{
      kind: 'case', packingGroupId: null, quantity: 3, lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 9,
      items: [{ productId: 'a', msku: 'A-AMZ', quantity: 12 }],
    }])
    expect(r).toMatchObject({ boxCount: 3, caseBoxes: 3, mixedBoxes: 0, weightKg: 27, units: 36, problems: [] })
  })

  it('a case pack over Amazon EU\'s limits is a WARNING and the case box is still planned', () => {
    const tall = sku({ productId: 'a', unitsPerCase: 6, case: { lengthCm: 70, widthCm: 30, heightCm: 30, weightKg: 9 } })
    const heavy = sku({ productId: 'b', unitsPerCase: 6, case: { lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 24 } })
    const r = planBoxes([{ productId: 'a', cases: 1, looseUnits: 0 }, { productId: 'b', cases: 2, looseUnits: 0 }], [tall, heavy], MIXED_BOX_DEFAULT)
    expect(r.problems.map(p => [p.code, p.productId, p.blocking])).toEqual([['CASE_OVER_LIMIT', 'a', false], ['CASE_OVER_LIMIT', 'b', false]])
    expect(r.caseBoxes).toBe(3)
    // Exactly 63.5 cm and 23 kg are inside the limit.
    const edge = sku({ productId: 'c', unitsPerCase: 6, case: { lengthCm: 63.5, widthCm: 30, heightCm: 30, weightKg: 23 } })
    expect(planBoxes([{ productId: 'c', cases: 1, looseUnits: 0 }], [edge], MIXED_BOX_DEFAULT).problems).toEqual([])
  })

  it('refuses cases without a case size, or without the case\'s size and weight', () => {
    const noSize = sku({ productId: 'a' })
    const noDims = sku({ productId: 'b', unitsPerCase: 12 })
    const r = planBoxes([{ productId: 'a', cases: 1, looseUnits: 0 }, { productId: 'b', cases: 1, looseUnits: 0 }], [noSize, noDims], MIXED_BOX_DEFAULT)
    expect(r.problems.map(p => [p.code, p.productId, p.blocking])).toEqual([['NO_CASE_SIZE', 'a', true], ['NO_CASE_DIMENSIONS', 'b', true]])
    expect(r.boxes).toEqual([])
  })
})

describe('planBoxes — loose units in mixed boxes', () => {
  it('fills mixed boxes first-fit up to 23 kg INCLUDING the empty box, and folds identical boxes', () => {
    // 1 kg units; the 1.2 kg box leaves 21.8 kg → 21 units a box. 50 units → 21 + 21 + 8.
    const a = sku({ productId: 'a', unitWeightKg: 1 })
    const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 50 }], [a], MIXED_BOX_DEFAULT)
    expect(r.boxes).toEqual([
      { kind: 'mixed', packingGroupId: null, quantity: 2, lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 22.2, items: [{ productId: 'a', msku: 'A-AMZ', quantity: 21 }] },
      { kind: 'mixed', packingGroupId: null, quantity: 1, lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 9.2, items: [{ productId: 'a', msku: 'A-AMZ', quantity: 8 }] },
    ])
    expect(r).toMatchObject({ boxCount: 3, caseBoxes: 0, mixedBoxes: 3, weightKg: 53.6, units: 50, problems: [] })
  })

  it('never fills a mixed box past the box volume (× the fill share)', () => {
    // 10 cm cubes, 0.1 kg: 96 000 cm³ × 0.85 = 81 600 → 81 units a box by volume (8.1 kg — weight does not bind).
    const cube = sku({ productId: 'a', unitWeightKg: 0.1, unit: { lengthCm: 10, widthCm: 10, heightCm: 10 } })
    const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 100 }], [cube], MIXED_BOX_DEFAULT)
    expect(mixedOnly(r).map(b => b.items[0].quantity)).toEqual([81, 19])
    expect(MIXED_BOX_FILL).toBe(0.85)
  })

  it('mixes SKUs in one box, heaviest first, and opens a new box only when the first one is full', () => {
    const a = sku({ productId: 'a', unitWeightKg: 3 })
    const b = sku({ productId: 'b', unitWeightKg: 1 })
    const r = planBoxes([{ productId: 'b', cases: 0, looseUnits: 10 }, { productId: 'a', cases: 0, looseUnits: 5 }], [a, b], MIXED_BOX_DEFAULT)
    expect(mixedOnly(r).map(box => ({ w: box.weightKg, items: box.items.map(i => `${i.productId}:${i.quantity}`) }))).toEqual([
      { w: 22.2, items: ['a:5', 'b:6'] },
      { w: 5.2, items: ['b:4'] },
    ])
  })

  it('cases and loose units of one SKU: the cases go in case boxes, the loose units in mixed boxes', () => {
    const a = sku({ productId: 'a', unitsPerCase: 10, case: { lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 8 }, unitWeightKg: 0.5 })
    const r = planBoxes([{ productId: 'a', cases: 2, looseUnits: 7 }], [a], MIXED_BOX_DEFAULT)
    expect(r.boxes.map(b => [b.kind, b.quantity, b.items[0].quantity])).toEqual([['case', 2, 10], ['mixed', 1, 7]])
    expect(r.units).toBe(27)
  })

  it('NEVER builds a mixed box over 23 kg or 63.5 cm a side, whatever the mix (seeded random mixes)', () => {
    const next = lcg(20261007)
    for (let round = 0; round < 200; round++) {
      const skus: FbaBoxSku[] = []
      const lines = []
      const count = 1 + Math.floor(next() * 6)
      for (let i = 0; i < count; i++) {
        const id = `s${i}`
        const hasSize = next() > 0.2
        skus.push({
          productId: id, sku: id, msku: id, unitsPerCase: null, case: null,
          unitWeightKg: Math.round((0.05 + next() * 6) * 1000) / 1000,
          unit: hasSize ? { lengthCm: 1 + Math.round(next() * 35), widthCm: 1 + Math.round(next() * 30), heightCm: 1 + Math.round(next() * 25) } : null,
        })
        lines.push({ productId: id, cases: 0, looseUnits: 1 + Math.floor(next() * 120) })
      }
      const box = next() > 0.5 ? MIXED_BOX_DEFAULT : { lengthCm: 63.5, widthCm: 50, heightCm: 45, emptyKg: 1.5, maxKg: 23 }
      const r = planBoxes(lines, skus, box)
      const volume = box.lengthCm * box.widthCm * box.heightCm * MIXED_BOX_FILL
      const sent = new Map<string, number>()
      for (const b of mixedOnly(r)) {
        expect(b.weightKg).toBeLessThanOrEqual(23)
        expect(Math.max(b.lengthCm, b.widthCm, b.heightCm)).toBeLessThanOrEqual(63.5)
        const exact = box.emptyKg + b.items.reduce((kg, it) => kg + it.quantity * skus.find(s => s.productId === it.productId)!.unitWeightKg!, 0)
        expect(exact).toBeLessThanOrEqual(23 + 1e-6)
        const used = b.items.reduce((v, it) => {
          const u = skus.find(s => s.productId === it.productId)!.unit
          return v + (u ? it.quantity * u.lengthCm * u.widthCm * u.heightCm : 0)
        }, 0)
        expect(used).toBeLessThanOrEqual(volume + 1e-6)
        for (const it of b.items) sent.set(it.productId, (sent.get(it.productId) ?? 0) + it.quantity * b.quantity)
      }
      // Every unit that was not refused is boxed exactly once.
      const refused = new Set(r.problems.filter(p => p.blocking).map(p => p.productId))
      for (const line of lines) if (!refused.has(line.productId)) expect(sent.get(line.productId)).toBe(line.looseUnits)
    }
  })

  it('refuses loose units without a unit weight (not boxed); cases of the same SKU still go', () => {
    const a = sku({ productId: 'a', unitWeightKg: null, unitsPerCase: 4, case: { lengthCm: 30, widthCm: 20, heightCm: 20, weightKg: 4 } })
    const r = planBoxes([{ productId: 'a', cases: 1, looseUnits: 3 }], [a], MIXED_BOX_DEFAULT)
    expect(r.problems.map(p => [p.code, p.blocking])).toEqual([['NO_UNIT_WEIGHT', true]])
    expect(r.boxes.map(b => b.kind)).toEqual(['case'])
  })

  it('a unit with no size is a warning and is counted by weight only', () => {
    const a = sku({ productId: 'a', unit: null, unitWeightKg: 2 })
    const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 12 }], [a], MIXED_BOX_DEFAULT)
    expect(r.problems.map(p => [p.code, p.blocking])).toEqual([['NO_UNIT_SIZE', false]])
    expect(mixedOnly(r).map(b => b.items[0].quantity)).toEqual([10, 2])
  })

  it('refuses a unit that cannot go in an empty mixed box (too heavy, or a side too long)', () => {
    const heavy = sku({ productId: 'a', unitWeightKg: 22 })
    const long = sku({ productId: 'b', unit: { lengthCm: 61, widthCm: 5, heightCm: 5 } })
    const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 1 }, { productId: 'b', cases: 0, looseUnits: 1 }], [heavy, long], MIXED_BOX_DEFAULT)
    expect(r.problems.map(p => [p.code, p.productId, p.blocking])).toEqual([['UNIT_TOO_BIG', 'a', true], ['UNIT_TOO_BIG', 'b', true]])
    expect(r.boxes).toEqual([])
    // A 45 cm unit lies along the 60 cm side: it fits.
    const turned = sku({ productId: 'c', unit: { lengthCm: 30, widthCm: 45, heightCm: 10 } })
    expect(planBoxes([{ productId: 'c', cases: 0, looseUnits: 1 }], [turned], MIXED_BOX_DEFAULT).problems).toEqual([])
  })

  it('a mixed box over Amazon\'s limits is refused and NO mixed box is built', () => {
    const a = sku({ productId: 'a' })
    for (const box of [
      { ...MIXED_BOX_DEFAULT, lengthCm: 64 },
      { ...MIXED_BOX_DEFAULT, maxKg: 25 },
      { ...MIXED_BOX_DEFAULT, emptyKg: 23 },
      { ...MIXED_BOX_DEFAULT, heightCm: 0 },
    ]) {
      expect(mixedBoxProblem(box)).toBe(FBA_SEND_COPY.problem.boxOverLimit)
      const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 5 }], [a], box)
      expect(r.boxes).toEqual([])
      expect(r.problems.map(p => [p.code, p.productId, p.blocking])).toEqual([['BOX_OVER_LIMIT', null, true]])
    }
    expect(mixedBoxProblem(MIXED_BOX_DEFAULT)).toBeNull()
    expect(mixedBoxProblem({ lengthCm: 63.5, widthCm: 63.5, heightCm: 63.5, emptyKg: 0, maxKg: 23 })).toBeNull()
  })

  it('a lighter limit the Owner sets is kept (15 kg boxes)', () => {
    const a = sku({ productId: 'a', unitWeightKg: 1 })
    const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 30 }], [a], { ...MIXED_BOX_DEFAULT, maxKg: 15 })
    expect(mixedOnly(r).every(b => b.weightKg <= 15)).toBe(true)
    expect(mixedOnly(r).map(b => [b.quantity, b.items[0].quantity])).toEqual([[2, 13], [1, 4]])
  })

  it('with Amazon\'s packing groups, units of different groups never share a box; a SKU in no group is refused', () => {
    const a = sku({ productId: 'a', unitWeightKg: 1 })
    const b = sku({ productId: 'b', unitWeightKg: 1 })
    const c = sku({ productId: 'c', unitWeightKg: 1 })
    const r = planBoxes(
      [{ productId: 'a', cases: 0, looseUnits: 3 }, { productId: 'b', cases: 0, looseUnits: 3 }, { productId: 'c', cases: 0, looseUnits: 3 }],
      [a, b, c], MIXED_BOX_DEFAULT,
      [{ packingGroupId: 'pg1', mskus: ['A-AMZ'] }, { packingGroupId: 'pg2', mskus: ['B-AMZ'] }],
    )
    expect(r.boxes.map(box => [box.packingGroupId, box.items.map(i => i.productId).join('+')])).toEqual([['pg1', 'a'], ['pg2', 'b']])
    expect(r.problems.map(p => [p.code, p.productId, p.blocking])).toEqual([['NOT_IN_GROUP', 'c', true]])
  })

  it('odd unit weights never round a box over the limit', () => {
    const a = sku({ productId: 'a', unitWeightKg: 0.333 })
    const r = planBoxes([{ productId: 'a', cases: 0, looseUnits: 500 }], [a], MIXED_BOX_DEFAULT)
    expect(mixedOnly(r).every(b => b.weightKg <= 23)).toBe(true)
    expect(r.units).toBe(500)
  })
})

describe('sendProblems / sendSummary', () => {
  const base = [
    sku({ productId: 'a', unitsPerCase: 12, case: { lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 9 }, free: 60, freeSealed: 4, freeLoose: 12 }),
    sku({ productId: 'b', free: 20, freeLoose: 20 }),
  ]

  it('a good send: counts, boxes, weight, the primary label and no hold', () => {
    const s = sendSummary(draftOf(base), choiceOf([{ productId: 'a', cases: 2, looseUnits: 5 }, { productId: 'b', cases: 0, looseUnits: 10 }]))
    expect(s).toMatchObject({ skus: 2, units: 39, cases: 2, looseUnits: 15, caseBoxes: 2, mixedBoxes: 1, boxes: 3, held: null, problems: [] })
    expect(s.primary).toBe('Create plan · 39 units')
    expect(s.weightKg).toBe(18 + 16.2)
    expect(s.mixedLine).toBe('Loose units go in 1 mixed box · 60 × 40 × 40 cm')
  })

  it('nothing to send holds the button with "Add units to send"', () => {
    const s = sendSummary(draftOf(base), choiceOf([{ productId: 'a', cases: 0, looseUnits: 0 }]))
    expect(codes(s.problems)).toEqual(['NO_UNITS'])
    expect(s.held).toBe('Add units to send')
    expect(s.primary).toBe('Create plan · 0 units')
    expect(s.mixedLine).toBeNull()
  })

  it('refuses more units than free and more sealed cases than free', () => {
    const p = sendProblems(draftOf(base), choiceOf([{ productId: 'a', cases: 5, looseUnits: 1 }, { productId: 'b', cases: 0, looseUnits: 21 }]))
    expect(p.map(x => [x.code, x.productId])).toEqual([['OVER_FREE_CASES', 'a'], ['OVER_FREE', 'a'], ['OVER_FREE', 'b']])
    expect(p[0].message).toBe('A: 5 sealed cases asked; 4 free at IT-MAIN')
    expect(p[2].message).toBe('B: 21 units asked; 20 free at IT-MAIN')
  })

  it('refuses a SKU with no Amazon listing in the market', () => {
    const p = sendProblems(draftOf([sku({ productId: 'a', msku: null })]), choiceOf([{ productId: 'a', cases: 0, looseUnits: 1 }]))
    expect(p.map(x => [x.code, x.message, x.blocking])).toEqual([['NO_LISTING', 'A: no Amazon listing in IT', true]])
  })

  it('asks for Prep by / Labels by when a SKU has them "not set", and takes the dialog\'s answer', () => {
    const unset = [sku({ productId: 'a', prepOwner: null, labelOwner: 'SELLER' })]
    expect(codes(sendProblems(draftOf(unset), choiceOf([{ productId: 'a', cases: 0, looseUnits: 1 }])))).toEqual(['NO_OWNERS'])
    const answered = choiceOf([{ productId: 'a', cases: 0, looseUnits: 1 }], { owners: { prepOwner: 'AMAZON', labelOwner: 'AMAZON' } })
    expect(sendProblems(draftOf(unset), answered)).toEqual([])
    // The SKU's own setting wins; the answer fills only what is not set.
    expect(effectiveOwners(unset[0], answered.owners)).toEqual({ prepOwner: 'AMAZON', labelOwner: 'SELLER' })
    expect(effectiveOwners(unset[0], null)).toBeNull()
  })

  it('warns (does not refuse) when a SKU is already in an open plan', () => {
    const p = sendProblems(draftOf([sku({ productId: 'a', openPlanUnits: 24 })]), choiceOf([{ productId: 'a', cases: 0, looseUnits: 1 }]))
    expect(p.map(x => [x.code, x.message, x.blocking])).toEqual([['IN_OPEN_PLAN', 'A: 24 units are already in an open FBA plan', false]])
  })

  it('the whole-plan problems come first: From, account, address, ready day, mixed box', () => {
    const draft = draftOf(base, {
      from: null,
      market: 'DE',
      address: { missing: ['phoneNumber', 'postalCode'], summary: null },
    })
    const p = sendProblems(draft, choiceOf([{ productId: 'b', cases: 0, looseUnits: 2 }], {
      readyToShipOn: '2026-10-06', mixedBox: { ...MIXED_BOX_DEFAULT, lengthCm: 80 },
    }))
    expect(codes(p)).toEqual(['NOT_A_WAREHOUSE', 'NO_ACCOUNT', 'NO_ADDRESS', 'READY_DATE', 'BOX_OVER_LIMIT'])
    expect(p[2].message).toBe('The ship-from address needs: phone, postal code. Fill Locations and Settings › Company.')
  })

  it('names the From warehouse in the address sentence, and only the places that need filling', () => {
    const p = sendProblems(draftOf(base, { address: { missing: ['addressLine1'], summary: null } }), choiceOf([{ productId: 'b', cases: 0, looseUnits: 1 }]))
    expect(p[0].message).toBe('The ship-from address needs: street. Fill Locations › IT-MAIN.')
    const company = sendProblems(draftOf(base, { address: { missing: ['name'], summary: null } }), choiceOf([{ productId: 'b', cases: 0, looseUnits: 1 }]))
    expect(company[0].message).toBe('The ship-from address needs: company name. Fill Settings › Company.')
  })

  it('refuses a ready day that is not a real day', () => {
    for (const day of ['2026-13-01', '2026-02-30', 'tomorrow', '']) {
      expect(codes(sendProblems(draftOf(base), choiceOf([{ productId: 'b', cases: 0, looseUnits: 1 }], { readyToShipOn: day })))).toEqual(['READY_DATE'])
    }
    expect(sendProblems(draftOf(base), choiceOf([{ productId: 'b', cases: 0, looseUnits: 1 }], { readyToShipOn: '2026-10-07' }))).toEqual([])
  })

  it('refuses unknown SKUs, a SKU listed twice, fractions, negatives and more than 10000 units', () => {
    const big = sku({ productId: 'c', free: 20_000, freeLoose: 20_000, unitWeightKg: 0.01 })
    const p = sendProblems(draftOf([...base, big]), choiceOf([
      { productId: 'zzz', cases: 0, looseUnits: 1 },
      { productId: 'b', cases: 0, looseUnits: 1 },
      { productId: 'b', cases: 0, looseUnits: 2 },
      { productId: 'a', cases: 0.5, looseUnits: 0 },
      { productId: 'c', cases: 0, looseUnits: 10_001 },
    ]))
    expect(p.filter(x => x.blocking).map(x => [x.code, x.productId])).toEqual([
      ['UNKNOWN_SKU', 'zzz'], ['INVALID_QUANTITY', 'b'], ['INVALID_QUANTITY', 'a'], ['INVALID_QUANTITY', 'c'],
    ])
    expect(codes(sendProblems(draftOf(base), choiceOf([{ productId: 'b', cases: 0, looseUnits: -1 }])))).toEqual(['INVALID_QUANTITY', 'NO_UNITS'])
  })

  it('carries the box refusals and warnings of planBoxes', () => {
    const noWeight = sku({ productId: 'a', unitWeightKg: null })
    const s = sendSummary(draftOf([noWeight]), choiceOf([{ productId: 'a', cases: 0, looseUnits: 3 }]))
    expect(codes(s.blocking)).toEqual(['NO_UNIT_WEIGHT'])
    expect(s.held).toBe(FBA_SEND_COPY.problem.noUnitWeight('A'))
  })

  it('refuses more than 200 SKUs in one plan', () => {
    const many = Array.from({ length: 201 }, (_, i) => sku({ productId: `p${i}` }))
    const p = sendProblems(draftOf(many), choiceOf(many.map(s => ({ productId: s.productId, cases: 0, looseUnits: 1 }))))
    expect(codes(p)).toEqual(['TOO_MANY_SKUS'])
  })
})

describe('states, steps and what a person may do', () => {
  it('every status belongs to exactly one of job / person / Amazon / closed', () => {
    const groups = [FBA_JOB_STATUSES, FBA_PERSON_STATUSES, FBA_AMAZON_STATUSES, FBA_CLOSED_STATUSES].flat() as string[]
    expect([...groups].sort()).toEqual([...FBA_PLAN_STATUSES].sort())
    expect(new Set(groups).size).toBe(groups.length)
  })

  it('the runner claims the job states, plus READY_TO_SHIP / SHIPPED for tracking only', () => {
    expect(FBA_CLAIMABLE_STATUSES).toEqual([...FBA_JOB_STATUSES, 'READY_TO_SHIP', 'SHIPPED'])
    expect(FBA_CLAIMABLE_STATUSES).not.toContain('WAITING_FOR_CHOICE')
  })

  it('every step but TRACKING has the status the plan shows while it runs', () => {
    expect(Object.keys(FBA_STEP_STATUS).sort()).toEqual(FBA_PLAN_STEPS.filter(s => s !== 'TRACKING').sort())
    expect(FBA_STEP_STATUS.CONFIRM).toBe('CONFIRMING')
  })

  it('open = not CLOSED / CANCELLED (and not an unknown word)', () => {
    expect(isFbaPlanOpen('READY_TO_SHIP')).toBe(true)
    expect(isFbaPlanOpen('FAILED')).toBe(true)
    expect(isFbaPlanOpen('CANCELLED')).toBe(false)
    expect(isFbaPlanOpen('CLOSED')).toBe(false)
    expect(isFbaPlanOpen('LABELS_READY')).toBe(false)
    expect(isFbaPlanStatus('LABELS_READY')).toBe(false)
  })

  it('fbaInboundShown: the "+N" is the bigger of Amazon\'s inbound and Nexus\'s shipped units, never their sum', () => {
    // Just marked shipped, Amazon has not read it yet: Nexus's count shows at once.
    expect(fbaInboundShown({ units: 0, sent: 21 })).toBe(21)
    // Amazon's read now includes the shipment: the same 21, never 42.
    expect(fbaInboundShown({ units: 21, sent: 21 })).toBe(21)
    // Amazon counts more (another shipment, or one from outside Nexus): Amazon's number.
    expect(fbaInboundShown({ units: 30, sent: 5 })).toBe(30)
    // An older server sends no `sent`; no row at all is 0.
    expect(fbaInboundShown({ units: 7 })).toBe(7)
    expect(fbaInboundShown({ units: 0 })).toBe(0)
    expect(fbaInboundShown(null)).toBe(0)
    expect(fbaInboundShown(undefined)).toBe(0)
  })

  it('fbaPlanCan: choose until the options expire, then get new ones; retry on FAILED; cancel until a shipment is shipped', () => {
    const now = '2026-10-07T10:00:00Z'
    expect(fbaPlanCan({ status: 'WAITING_FOR_CHOICE', shippedShipments: 0, optionsExpireAt: '2026-10-07T11:00:00Z', now }))
      .toEqual({ choose: true, newOptions: false, retry: false, cancel: true })
    expect(fbaPlanCan({ status: 'WAITING_FOR_CHOICE', shippedShipments: 0, optionsExpireAt: '2026-10-07T09:00:00Z', now }))
      .toEqual({ choose: false, newOptions: true, retry: false, cancel: true })
    expect(fbaPlanCan({ status: 'FAILED', shippedShipments: 0, now })).toEqual({ choose: false, newOptions: false, retry: true, cancel: true })
    expect(fbaPlanCan({ status: 'READY_TO_SHIP', shippedShipments: 1, now }).cancel).toBe(false)
    for (const status of ['SHIPPED', 'AT_AMAZON', 'CLOSED', 'CANCELLING', 'CANCELLED']) {
      expect(fbaPlanCan({ status, shippedShipments: 0, now }).cancel).toBe(false)
    }
    expect(FBA_CANCELLABLE_STATUSES).toContain('HELD')
  })
})

describe('small helpers', () => {
  it('unit weight in kg and lengths in cm, never a guess', () => {
    expect(unitWeightKg('0.5', 'kg')).toBe(0.5)
    expect(unitWeightKg(500, 'g')).toBe(0.5)
    expect(unitWeightKg(1, 'KILOGRAM')).toBe(1)
    expect(unitWeightKg(2, 'lb')).toBeCloseTo(0.907, 3)
    expect(unitWeightKg(16, 'oz')).toBeCloseTo(0.4536, 4)
    expect(unitWeightKg(1, null)).toBeNull()
    expect(unitWeightKg(1, 'stone')).toBeNull()
    expect(unitWeightKg(0, 'kg')).toBeNull()
    expect(unitWeightKg(null, 'kg')).toBeNull()
    expect(lengthCm(10, 'mm')).toBe(1)
    expect(lengthCm(1, 'in')).toBe(2.54)
    expect(lengthCm('12.5', 'CM')).toBe(12.5)
    expect(lengthCm(5, undefined)).toBeNull()
  })

  it('the next working day skips the weekend', () => {
    expect(nextWorkingDay('2026-10-07')).toBe('2026-10-08')
    expect(nextWorkingDay('2026-10-09')).toBe('2026-10-12')
    expect(nextWorkingDay('2026-10-10')).toBe('2026-10-12')
  })

  it('the plan\'s name at Amazon is frozen: market, day, last 6 of the row id', () => {
    expect(fbaAmazonPlanName('IT', '2026-10-08', 'cmxyz000a1b2c3')).toBe('Nexus IT 2026-10-08 #a1b2c3')
  })

  it('addressMissing names Amazon\'s required fields that are empty', () => {
    expect(addressMissing(null)).toEqual(['name', 'addressLine1', 'city', 'postalCode', 'countryCode', 'phoneNumber'])
    expect(addressMissing({ name: 'X', addressLine1: 'Via 1', city: 'Rimini', postalCode: '47900', countryCode: 'IT', phoneNumber: ' ' })).toEqual(['phoneNumber'])
  })

  it('lineUnits = cases × units per case + loose', () => {
    expect(lineUnits({ cases: 3, looseUnits: 5 }, 12)).toBe(41)
    expect(lineUnits({ cases: 3, looseUnits: 5 }, null)).toBe(5)
  })

  it('copy: plurals and the drawer sentences', () => {
    expect(FBA_SEND_COPY.title(1)).toBe('Send to FBA · 1 SKU')
    expect(FBA_SEND_COPY.title(6)).toBe('Send to FBA · 6 SKUs')
    expect(FBA_SEND_COPY.primary(1)).toBe('Create plan · 1 unit')
    expect(FBA_SEND_COPY.free(48, 4)).toBe('48 · 4 cases')
    expect(FBA_SEND_COPY.free(5, 0)).toBe('5')
    expect(FBA_SEND_COPY.shippedConfirm(120, 'IT-MAIN')).toBe('120 units leave IT-MAIN')
    expect(Object.keys(FBA_SEND_COPY.status).sort()).toEqual([...FBA_PLAN_STATUSES].sort())
  })
})
