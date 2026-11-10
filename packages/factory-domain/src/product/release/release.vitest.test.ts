import { describe, expect, it } from 'vitest'
import { completenessOf, effectsOf, releaseGate, type GateFacts, type GateItem } from './gate'
import { inScope, orderedScope, scopeProblems, scopeWithout, scopeWords, sizeWords, waitingWords, WHOLE_SCOPE, widenProblems, type ScopeStyle } from './scope'
import { scopedCellsCheck } from './work-orders'

/** The release gate and the release scope (B-W2b-231; PRD-190, PRD-191, PRD-197, PRD-232), pure. Codes and ids are made up. */

const BLK = '00000000-0000-4000-8000-000000000001'
const RED = '00000000-0000-4000-8000-000000000002'
const OLD = '00000000-0000-4000-8000-000000000003'
const STYLE: ScopeStyle = {
  colourways: [
    { id: BLK, code: 'BLK', status: 'ACTIVE' },
    { id: RED, code: 'RED', status: 'ACTIVE' },
    { id: OLD, code: 'OLD', status: 'ARCHIVED' },
  ],
  sizes: ['48', '50', '52', '54', '56'],
}

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  revision: { revision: 4, status: 'DRAFT' },
  styleStatus: 'ACTIVE',
  check: { blockers: [], warnings: [] },
  steps: [{ stepId: 's1', seq: 10, code: 'SEW', name: 'Sewing', operationId: 'o1', standardMinutes: '12.5', governed: false, library: { standardMinutes: '12.5', versionNumber: null }, waiting: null }],
  lines: [{ lineId: 'l1', seq: 10, itemId: 'i1', code: 'LEA-1', approval: 'APPROVED', customerSupplied: false, hasStandardCost: true }],
  label: { named: true, template: { id: 't1', code: 'LBL-1', revision: 1, status: 'ACTIVE' } },
  certificate: { required: true, notRequiredMessage: null, cells: [{ colourwayId: BLK, size: '50', label: 'BLK 50', status: 'COVERED', message: 'Covered.' }] },
  spec: { id: 'sp1', status: 'APPROVED' },
  attributes: { typeCode: 'PT-1', required: 1, missing: [] },
  changeOrders: { proposing: null, others: [] },
  scope: { asked: WHOLE_SCOPE, problems: [], words: 'every colourway and size', waiting: null, style: STYLE },
  drift: null,
  storedCompletenessPct: null,
  ...over,
})

const stateOf = (items: readonly GateItem[], code: GateItem['code']) => items.find((item) => item.code === code)!.state

describe('the release scope (PRD-191)', () => {
  it('releases every cell when empty, else only its colourways and sizes, each list on its own', () => {
    expect(inScope(WHOLE_SCOPE, RED, '56')).toBe(true)
    expect(inScope({ colourwayIds: [BLK], sizes: [] }, BLK, '56')).toBe(true)
    expect(inScope({ colourwayIds: [BLK], sizes: [] }, RED, '50')).toBe(false)
    expect(inScope({ colourwayIds: [], sizes: ['50', '52'] }, RED, '52')).toBe(true)
    expect(inScope({ colourwayIds: [], sizes: ['50', '52'] }, RED, '54')).toBe(false)
  })

  it('says what it takes and what waits, in the range order', () => {
    expect(sizeWords(['54', '50', '52'], STYLE.sizes)).toBe('50–54')
    expect(sizeWords(['48', '52', '54', '56'], STYLE.sizes)).toBe('48, 52–56')
    expect(scopeWords({ colourwayIds: [RED, BLK], sizes: [] }, STYLE)).toBe('RED, BLK in every size')
    expect(scopeWords(orderedScope({ colourwayIds: [RED, BLK], sizes: ['52', '50'] }, STYLE), STYLE)).toBe('BLK, RED in 50, 52')
    expect(waitingWords({ colourwayIds: [BLK], sizes: ['50', '52'] }, STYLE)).toBe('RED and sizes 48, 54, 56')
    expect(waitingWords(WHOLE_SCOPE, STYLE)).toBeNull()
  })

  it('refuses in words what the database refuses, and what it cannot know: an archived colourway, a size off the range, nothing to make', () => {
    expect(scopeProblems({ colourwayIds: [BLK, BLK, OLD, '00000000-0000-4000-8000-000000000009'], sizes: ['50', '58', '50'] }, STYLE).map((problem) => [problem.code, problem.path])).toEqual([
      ['SCOPE_REPEATED', 'colourwayIds/1'],
      ['SCOPE_COLOURWAY_ARCHIVED', 'colourwayIds/2'],
      ['SCOPE_COLOURWAY_UNKNOWN', 'colourwayIds/3'],
      ['SCOPE_SIZE_OUTSIDE', 'sizes/1'],
      ['SCOPE_REPEATED', 'sizes/2'],
    ])
    expect(scopeProblems({ colourwayIds: [], sizes: [] }, { ...STYLE, sizes: [] }).map((problem) => problem.code)).toEqual(['SCOPE_EMPTY'])
    expect(scopeProblems({ colourwayIds: [BLK], sizes: ['50'] }, STYLE)).toEqual([])
  })

  it('a later release only widens, and adds something', () => {
    const released = { colourwayIds: [BLK], sizes: ['50', '52'] }
    expect(widenProblems(released, { colourwayIds: [BLK, RED], sizes: ['50', '52', '54'] }, STYLE, 4)).toEqual([])
    expect(widenProblems(released, { colourwayIds: [], sizes: [] }, STYLE, 4)).toEqual([])
    expect(widenProblems(released, { colourwayIds: [RED], sizes: ['50', '52'] }, STYLE, 4).map((problem) => problem.message)).toEqual([
      'Revision 4 is released for BLK in 50, 52: a later release only adds colourways or sizes, so BLK stays released.',
    ])
    expect(widenProblems(WHOLE_SCOPE, { colourwayIds: [], sizes: ['50'] }, STYLE, 4).map((problem) => problem.code)).toEqual(['SCOPE_NARROWS'])
    expect(widenProblems(released, { colourwayIds: [BLK], sizes: ['52', '50'] }, STYLE, 4).map((problem) => problem.code)).toEqual(['SCOPE_NOT_WIDER'])
  })

  it('suggests the scope that leaves out the cells no certificate covers, keeping the most cells', () => {
    expect(scopeWithout(WHOLE_SCOPE, STYLE, [{ colourwayId: BLK, size: '56' }, { colourwayId: RED, size: '56' }])).toEqual({ colourwayIds: [], sizes: ['48', '50', '52', '54'] })
    expect(scopeWithout(WHOLE_SCOPE, STYLE, [{ colourwayId: RED, size: '48' }, { colourwayId: RED, size: '56' }])).toEqual({ colourwayIds: [], sizes: ['50', '52', '54'] })
    expect(scopeWithout(WHOLE_SCOPE, STYLE, [{ colourwayId: RED, size: '48' }, { colourwayId: RED, size: '52' }, { colourwayId: RED, size: '56' }])).toEqual({ colourwayIds: [BLK], sizes: [] })
    expect(scopeWithout(WHOLE_SCOPE, STYLE, [])).toBeNull()
  })

  it('the work-order release refuses a cell outside the released scope, in its CELLS check', () => {
    const ok = { code: 'CELLS' as const, state: 'OK' as const, message: '2 cell(s) to make.', problems: [] }
    const cells = [
      { id: 'c1', label: 'BLK 50', colourwayId: BLK, size: '50' },
      { id: 'c2', label: 'RED 54', colourwayId: RED, size: '54' },
    ]
    expect(scopedCellsCheck(ok, null, cells)).toBe(ok)
    const refused = scopedCellsCheck(ok, { revision: 4, scope: { colourwayIds: [BLK], sizes: [] }, words: 'BLK in every size' }, cells)
    expect(refused).toMatchObject({ state: 'BLOCKED', message: expect.stringContaining('RED 54 is not released yet: revision 4 is released for BLK in every size only.') })
    expect(refused.problems.map((problem) => problem.path)).toEqual(['cells/c2/scope'])
  })
})

describe('the release gate (PRD-190) and its completeness score (PRD-232)', () => {
  it('passes a complete draft at 100 % with every item OK or not required', () => {
    const gate = releaseGate(facts())
    expect(gate).toMatchObject({ checked: true, releasable: true, heldBy: null, completenessPct: '100', blockers: [], warnings: [] })
    expect(gate.items.map((item) => item.code)).toEqual(['BOM', 'ROUTING', 'SMV', 'MATERIALS', 'PRICES', 'LABEL', 'CERTIFICATE', 'MEASUREMENTS', 'ATTRIBUTES', 'CHANGE_ORDERS', 'SCOPE', 'DRIFT'])
    expect(stateOf(gate.items, 'DRIFT')).toBe('NOT_REQUIRED')
  })

  it('warns, never blocks, what a person may release over; the score counts only what applies', () => {
    const gate = releaseGate(
      facts({
        steps: [{ stepId: 's1', seq: 10, code: 'SEW', name: 'Sewing', operationId: 'o1', standardMinutes: '12.5', governed: true, library: { standardMinutes: '13', versionNumber: 2 }, waiting: { number: 3, standardMinutes: '14' } }],
        lines: [{ lineId: 'l1', seq: 10, itemId: 'i1', code: 'LEA-1', approval: 'PENDING', customerSupplied: false, hasStandardCost: false }],
        label: { named: false, template: null },
        certificate: { required: true, notRequiredMessage: null, cells: [{ colourwayId: BLK, size: '56', label: 'BLK 56', status: 'NOT_COVERED', message: 'No certificate covers BLK 56.' }] },
        spec: null,
        attributes: { typeCode: 'PT-1', required: 2, missing: ['hsCode'] },
      }),
    )
    expect(gate.releasable).toBe(true)
    expect(gate.blockers).toEqual([])
    expect(['SMV', 'MATERIALS', 'PRICES', 'LABEL', 'CERTIFICATE', 'MEASUREMENTS', 'ATTRIBUTES'].map((code) => stateOf(gate.items, code as GateItem['code']))).toEqual(Array(7).fill('WARNING'))
    // 3 of 10 scored items OK (BOM, ROUTING, CHANGE_ORDERS).
    expect(gate.completenessPct).toBe('30')
    expect(gate.warnings.map((warning) => warning.code)).toEqual(['SMV_NOT_APPROVED', 'SMV_CHANGE_WAITING', 'MATERIAL_PENDING', 'MATERIAL_NO_STANDARD_COST', 'LABEL_MISSING', 'CELL_NOT_COVERED', 'SPEC_MISSING', 'ATTRIBUTE_MISSING'])
    expect(gate.warnings[0]!.message).toBe('Step 10 SEW (Sewing) takes 12.5 min here; the approved SMV of SEW is 13 min (version 2). Use the library value in Routing › Times, or keep it on purpose.')
  })

  it('blocks a BOM blocker, a change order not yet approved and a scope that cannot be made, held with the first reason', () => {
    const gate = releaseGate(
      facts({
        check: {
          blockers: [{ code: 'NO_SCAN_POINT', severity: 'BLOCKER', message: 'No step is scanned.', cell: { lineId: null, column: 'routing', size: null, colourwayId: null, alternateId: null, stepId: null } }],
          warnings: [{ code: 'PPE_MATERIAL_NOT_APPROVED', severity: 'WARNING', message: 'Line 10: PPE material pending.', cell: { lineId: 'l1', column: 'itemId', size: null, colourwayId: null, alternateId: null, stepId: null } }],
        },
        lines: [{ lineId: 'l1', seq: 10, itemId: 'i1', code: 'LEA-1', approval: 'PENDING', customerSupplied: true, hasStandardCost: false }],
        changeOrders: { proposing: { id: 'co1', number: 'ECO-1', status: 'SUBMITTED', toRevision: 4, refusal: { code: 'NOT_APPROVED', message: 'Change order ECO-1 is submitted: its revision is released once the change order is approved.' } }, others: [] },
        scope: { asked: { colourwayIds: [OLD], sizes: [] }, problems: scopeProblems({ colourwayIds: [OLD], sizes: [] }, STYLE), words: 'OLD in every size', waiting: null, style: STYLE },
      }),
    )
    expect(gate.releasable).toBe(false)
    expect(gate.heldBy).toBe('No step is scanned.')
    expect(gate.blockers.map((blocker) => blocker.code)).toEqual(['NO_SCAN_POINT', 'CHANGE_ORDER_NOT_APPROVED', 'SCOPE_COLOURWAY_ARCHIVED'])
    expect([stateOf(gate.items, 'ROUTING'), stateOf(gate.items, 'MATERIALS'), stateOf(gate.items, 'PRICES'), stateOf(gate.items, 'CHANGE_ORDERS'), stateOf(gate.items, 'SCOPE')]).toEqual(['BLOCKED', 'WARNING', 'NOT_REQUIRED', 'BLOCKED', 'BLOCKED'])
    // The BOM check's PPE finding stays the MATERIALS finding for its line (no second one).
    expect(gate.items.find((item) => item.code === 'MATERIALS')!.findings.map((finding) => finding.code)).toEqual(['PPE_MATERIAL_NOT_APPROVED'])
  })

  it('a frozen revision shows its stored score, its scope and the coverage of the cells asked; it is not checked again', () => {
    const gate = releaseGate(facts({ revision: { revision: 4, status: 'RELEASED' }, check: null, storedCompletenessPct: '87.5' }))
    expect(gate).toMatchObject({ checked: false, releasable: false, completenessPct: '87.5' })
    expect(gate.items.map((item) => item.code)).toEqual(['SCOPE', 'CERTIFICATE'])
  })

  it('rounds the score half up to two decimals', () => {
    const items = (ok: number, of: number): GateItem[] =>
      Array.from({ length: of }, (_, index) => ({ code: 'BOM', state: index < ok ? 'OK' : 'WARNING', scored: true, fix: 'bom', message: '', findings: [] }) as GateItem)
    expect(completenessOf(items(2, 3))).toBe('66.67')
    expect(completenessOf(items(1, 3))).toBe('33.33')
    expect(completenessOf(items(7, 8))).toBe('87.5')
    expect(completenessOf(items(1, 6))).toBe('16.67')
    expect(completenessOf([])).toBeNull()
  })

  it('says what happens, in words', () => {
    expect(effectsOf(facts({ styleStatus: 'DRAFT' }))).toEqual(["Revision 4 becomes the style's current revision: every new work order uses it.", 'The style becomes active: it can be sold.'])
    expect(
      effectsOf(
        facts({
          drift: { previous: 3, workOrdersInProgress: 1, draftWorkOrders: 0, openQuotes: 2, openOrders: null },
          scope: { asked: { colourwayIds: [BLK], sizes: [] }, problems: [], words: 'BLK in every size', waiting: 'RED', style: STYLE },
        }),
      ),
    ).toEqual([
      'Revision 4 becomes the one every new work order uses. Revision 3 becomes obsolete.',
      '1 work order in progress keeps revision 3.',
      '2 open quotes were costed from revision 3 and keep their price.',
      'It is released for BLK in every size; RED wait for a later release of revision 4.',
    ])
  })
})
