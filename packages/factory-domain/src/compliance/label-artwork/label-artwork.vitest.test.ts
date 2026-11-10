import { describe, expect, it } from 'vitest'
import {
  allocateSpoil,
  approvedNow,
  artworkRefusal,
  inForceAt,
  lineRules,
  nextVersionNo,
  packagingRulesOf,
  planChanges,
  planLabelLines,
  reconcile,
  reconciliationWords,
  spoilProblems,
  type ArtworkFact,
  type RuleMaterial,
} from './rules'

const at = (text: string) => new Date(`2026-11-${text}T09:00:00.000Z`)
const version = (versionNo: number, extra: Partial<ArtworkFact> = {}): ArtworkFact => ({ id: `a${versionNo}`, versionNo, status: 'DRAFT', authorId: 'author', approvedAt: null, approvedById: null, retiredAt: null, ...extra })

describe('artwork versions (PRD-347)', () => {
  it('numbers the next version, finds the approved one and the one in force at a moment', () => {
    const v1 = version(1, { status: 'RETIRED', approvedAt: at('01'), approvedById: 'b', retiredAt: at('05') })
    const v2 = version(2, { status: 'APPROVED', approvedAt: at('05'), approvedById: 'b' })
    const v3 = version(3)
    expect(nextVersionNo([v1, v2, v3])).toBe(4)
    expect(nextVersionNo([])).toBe(1)
    expect(approvedNow([v1, v2, v3])?.versionNo).toBe(2)
    expect(inForceAt([v1, v2, v3], at('03'))?.versionNo).toBe(1)
    expect(inForceAt([v1, v2, v3], at('06'))?.versionNo).toBe(2)
    expect(inForceAt([v3], at('06'))).toBeNull()
  })

  it('is approved only as a draft, by someone other than its author, on a label that is not retired', () => {
    expect(artworkRefusal('APPROVE', version(3), { actorId: 'author', templateRetired: false })).toContain('second person')
    expect(artworkRefusal('APPROVE', version(3), { actorId: 'other', templateRetired: false })).toBeNull()
    expect(artworkRefusal('APPROVE', version(3, { authorId: null }), { actorId: 'other', templateRetired: false })).toContain('no known author')
    expect(artworkRefusal('APPROVE', version(3), { actorId: 'other', templateRetired: true })).toContain('retired')
    expect(artworkRefusal('APPROVE', version(2, { status: 'APPROVED' }), { actorId: 'other', templateRetired: false })).toContain('only a draft')
    expect(artworkRefusal('REMOVE', version(2, { status: 'APPROVED' }), { actorId: 'other', templateRetired: false })).toContain('never removed')
    expect(artworkRefusal('REMOVE', version(3), { actorId: 'other', templateRetired: false })).toBeNull()
    expect(artworkRefusal('RETIRE', version(1, { status: 'RETIRED' }), { actorId: 'other', templateRetired: false })).toContain('retired already')
  })
})

const material = (id: string, extra: Partial<RuleMaterial> = {}): RuleMaterial => ({ id, code: id.toUpperCase(), name: id, kind: 'PACKAGING', status: 'ACTIVE', approval: 'APPROVED', companyId: null, consumptionUom: 'PCS', ...extra })

describe('label and packaging lines from the rules (PRD-088)', () => {
  const labels = [{ id: 't1', code: 'LBL-1', revision: 2, kind: 'PPE_GARMENT', name: 'Garment label' }]
  const packaging = packagingRulesOf([
    { key: 'polybag', text: 'One garment per polybag', itemId: 'bag', quantity: '1', per: 'GARMENT' },
    { key: 'hang-tag', text: 'Hang tag on the zip' },
    { key: 'carton', text: 'Ten per carton', itemId: 'box', quantity: '0.1', per: 'CARTON' },
    { key: 'Bad Key', text: 'not a rule' },
  ])

  it('reads the labels, the leaflet of a PPE style and the per-garment packaging rules; the rest in words', () => {
    const { rules, inWords } = lineRules({ labels, ppe: true, packaging })
    expect(rules.map((rule) => [rule.sourceKey, rule.section, rule.itemId, rule.qty])).toEqual([
      ['compliance:label:LBL-1', 'LABELS', null, '1'],
      ['compliance:user-information', 'PACKAGING', null, '1'],
      ['branding:polybag', 'PACKAGING', 'bag', '1'],
    ])
    expect(inWords.map((entry) => [entry.sourceKey, entry.why])).toEqual([
      ['branding:hang-tag', 'NO_MATERIAL'],
      ['branding:carton', 'PER_CARTON'],
    ])
    expect(lineRules({ labels: [], ppe: false, packaging: [] }).rules).toEqual([])
  })

  it('adds, keeps, changes and removes the lines rules made; never touches a line typed by a person', () => {
    const { rules } = lineRules({ labels, ppe: true, packaging })
    const materials = new Map([['bag', material('bag')], ['woven', material('woven', { kind: 'LABEL' })], ['leaflet', material('leaflet')], ['ribbon', material('ribbon', { kind: 'LABEL', consumptionUom: 'M' })]])
    const lines = [
      { id: 'l1', seq: 10, sourceKey: 'compliance:label:LBL-1', itemId: 'woven', qty: '1', uom: 'PCS' as const, section: 'LABELS' },
      { id: 'l2', seq: 20, sourceKey: 'branding:polybag', itemId: 'bag', qty: '2', uom: 'PCS' as const, section: 'PACKAGING' },
      { id: 'l3', seq: 30, sourceKey: 'branding:brand-label', itemId: 'woven', qty: '1', uom: 'PCS' as const, section: 'LABELS' },
      { id: 'l4', seq: 40, sourceKey: 'branding:polybag', itemId: 'bag', qty: '1', uom: 'PCS' as const, section: 'PACKAGING' },
      { id: 'l5', seq: 50, sourceKey: 'other:thing', itemId: 'bag', qty: '1', uom: 'PCS' as const, section: null },
    ]
    const plan = planLabelLines({ rules, lines, picked: {}, materials, companyId: 'c1' })
    expect(plan.map((entry) => [entry.action, entry.sourceKey, entry.line?.id ?? null, entry.why])).toEqual([
      ['KEEP', 'compliance:label:LBL-1', 'l1', null],
      ['NEEDS_MATERIAL', 'compliance:user-information', null, null],
      ['UPDATE', 'branding:polybag', 'l2', null],
      ['REMOVE', 'branding:polybag', 'l4', 'DUPLICATE'],
      ['REMOVE', 'branding:brand-label', 'l3', 'RULE_GONE'],
    ])
    expect(plan[2]!.changes).toEqual(['qty'])
    expect(planChanges(plan).map((entry) => entry.line?.id)).toEqual(['l2', 'l4', 'l3'])
    // The leaflet's material, picked: added; a ribbon counted in metres cannot be a per-garment label.
    const picked = planLabelLines({ rules, lines: [], picked: { 'compliance:user-information': 'leaflet', 'compliance:label:LBL-1': 'ribbon' }, materials, companyId: 'c1' })
    expect(picked.find((entry) => entry.sourceKey === 'compliance:user-information')).toMatchObject({ action: 'ADD', held: null, next: { itemId: 'leaflet', qty: '1', uom: 'PCS', section: 'PACKAGING' } })
    expect(picked.find((entry) => entry.sourceKey === 'compliance:label:LBL-1')!.held).toContain('counted in M')
    // A blocked, archived or other company's material is held, not added.
    const held = (extra: Partial<RuleMaterial>) => planLabelLines({ rules, lines: [], picked: {}, materials: new Map([['bag', material('bag', extra)]]), companyId: 'c1' }).find((entry) => entry.sourceKey === 'branding:polybag')!.held
    expect(held({ approval: 'BLOCKED' })).toContain('blocked')
    expect(held({ status: 'ARCHIVED' })).toContain('archived')
    expect(held({ companyId: 'c2' })).toContain('another company')
    expect(held({})).toBeNull()
  })
})

describe('the label reconciliation (MES-140)', () => {
  const cells = [
    { cellId: 'c52', colourwayCode: 'BLK', size: '52', finished: 20, labelled: 20 },
    { cellId: 'c54', colourwayCode: 'BLK', size: '54', finished: 4, labelled: 5 },
  ]
  const prints = [
    { id: 'p1', cellId: 'c52', kind: 'PRINT' as const, quantity: 20, at: at('01') },
    { id: 'p2', cellId: 'c52', kind: 'REPRINT' as const, quantity: 2, at: at('02') },
    { id: 'p3', cellId: 'c54', kind: 'PRINT' as const, quantity: 5, at: at('01') },
  ]

  it('counts printed = used + spoiled + returned per size and in total; a difference either way does not balance', () => {
    const open = reconcile(cells, prints, [])
    expect(open.cells.map((row) => [row.size, row.printed, row.used, row.difference])).toEqual([
      ['52', 22, 20, 2],
      ['54', 5, 4, 1],
    ])
    expect(open.balanced).toBe(false)
    expect(reconciliationWords(open.cells[0]!)).toContain('2 labels are not accounted for')
    const done = reconcile(cells, prints, [{ printId: 'p1', kind: 'SPOILED', quantity: 2 }, { printId: 'p3', kind: 'RETURNED', quantity: 1 }])
    expect(done.balanced).toBe(true)
    expect(done.total).toEqual({ printed: 27, used: 24, spoiled: 2, returned: 1, difference: 0 })
    expect(reconciliationWords(done.cells[0]!)).toContain('balance')
    const over = reconcile(cells, prints, [{ printId: 'p1', kind: 'SPOILED', quantity: 4 }])
    expect(over.cells[0]!.difference).toBe(-2)
    expect(reconciliationWords(over.cells[0]!)).toContain('Reprint')
    // No final operation scanned: nothing is used yet.
    expect(reconcile([{ ...cells[0]!, finished: null }], prints, []).cells[0]!.used).toBe(0)
  })

  it("logs on the size's prints newest first, never more than a print gave", () => {
    expect(allocateSpoil(prints, [], 'c52', 3)).toEqual({ rows: [{ printId: 'p2', quantity: 2 }, { printId: 'p1', quantity: 1 }] })
    expect(allocateSpoil(prints, [{ printId: 'p2', kind: 'SPOILED', quantity: 2 }], 'c52', 1)).toEqual({ rows: [{ printId: 'p1', quantity: 1 }] })
    expect(allocateSpoil(prints, [], 'c54', 6)).toEqual({ rows: null, room: 5 })
    expect(allocateSpoil(prints, [], 'c56', 1)).toEqual({ rows: null, room: 0 })
  })

  it('asks why for spoiled labels and a count from 1', () => {
    expect(spoilProblems({ cellId: 'c52', kind: 'SPOILED', quantity: 1, reason: null }).map((issue) => issue.path)).toEqual(['body/reason'])
    expect(spoilProblems({ cellId: 'c52', kind: 'RETURNED', quantity: 0, reason: null }).map((issue) => issue.path)).toEqual(['body/quantity'])
    expect(spoilProblems({ cellId: 'c52', kind: 'SPOILED', quantity: 2, reason: 'Printer jammed' })).toEqual([])
  })
})
