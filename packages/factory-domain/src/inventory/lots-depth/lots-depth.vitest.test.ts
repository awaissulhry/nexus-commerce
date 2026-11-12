import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { attributeKeysFor, attributesProblems, changedAttributes, mergeAttributes } from './attributes'
import { DEFAULT_LIST_LIFECYCLES, ledgerFacts, lifecycleCause, lifecycleFits, lifecycleFor, type LedgerMove } from './lifecycle'
import { addDays, documentState, incomingCheck, separationCheck, type IncomingFacts } from './page'
import { childLotCodes, familyRefusal, hideMoveRefusal, proposalFromInspection, splitDraftProblems, suffixAt } from './split'
import { composeTraceReport, reportFileName, requestProblems, traceReportCsv, type ReportTrace } from './trace-report'

const move = (reason: string, quantity: string, direction: 'in' | 'out', reversalOfId: string | null = null): LedgerMove => ({
  reason,
  baseQuantity: quantity,
  reversalOfId,
  fromLocationId: direction === 'out' ? 'loc' : null,
  toLocationId: direction === 'in' ? 'loc' : null,
})

describe('the lot lifecycle (SCM-236)', () => {
  const received = [move('RECEIPT', '100', 'in')]
  it('stays in quarantine until released, whatever the ledger says', () => {
    expect(lifecycleFor('QUARANTINE', ledgerFacts(received))).toBe('QUARANTINE')
    expect(lifecycleFor('QUARANTINE', ledgerFacts([]))).toBe('QUARANTINE')
  })
  it('is RELEASED until the first issue, IN_USE after it, DEPLETED when the last unit went out', () => {
    expect(lifecycleFor('RELEASED', ledgerFacts(received))).toBe('RELEASED')
    const issued = [...received, move('ISSUE', '40', 'out')]
    expect(lifecycleFor('RELEASED', ledgerFacts(issued))).toBe('IN_USE')
    expect(lifecycleFor('RELEASED', ledgerFacts([...issued, move('ISSUE', '60', 'out')]))).toBe('DEPLETED')
    // A remnant back keeps it in use; the stock back after depletion brings it back to IN_USE.
    expect(lifecycleFor('RELEASED', ledgerFacts([...issued, move('ISSUE', '60', 'out'), move('REMNANT', '5', 'in')]))).toBe('IN_USE')
  })
  it('goes back to RELEASED when its issues are undone, and RETURNED when it went back to the supplier', () => {
    const undone = [...received, move('ISSUE', '40', 'out'), move('ISSUE', '40', 'in', 'issue-1')]
    expect(ledgerFacts(undone).issuedNet.isZero()).toBe(true)
    expect(lifecycleFor('RELEASED', ledgerFacts(undone))).toBe('RELEASED')
    expect(lifecycleFor('REJECTED', ledgerFacts([...received, move('SUPPLIER_RETURN', '100', 'out')]))).toBe('RETURNED')
    expect(lifecycleFor('REJECTED', ledgerFacts([...received, move('SCRAP', '100', 'out')]))).toBe('DEPLETED')
    expect(lifecycleFor('BLOCKED', ledgerFacts(received))).toBe('BLOCKED')
    // Issued in part, the rest sent back: depleted (some of it is in garments).
    expect(lifecycleFor('RELEASED', ledgerFacts([...received, move('ISSUE', '30', 'out'), move('SUPPLIER_RETURN', '70', 'out')]))).toBe('DEPLETED')
  })
  it('counts a split out of a lot as stock leaving it (the parent of shade lots is depleted)', () => {
    const facts = ledgerFacts([...received, move('ADJUSTMENT', '100', 'out')])
    expect(facts.onHand.isZero()).toBe(true)
    expect(lifecycleFor('RELEASED', facts)).toBe('DEPLETED')
    expect(new Dec(ledgerFacts([move('OPENING', '3', 'in')]).onHand).toString()).toBe('3')
  })
  it('fits the quality status as the database does, and names the cause of each move', () => {
    expect(lifecycleFits('QUARANTINE', 'RELEASED')).toBe(false)
    expect(lifecycleFits('REJECTED', 'RETURNED')).toBe(true)
    expect(lifecycleFits('BLOCKED', 'IN_USE')).toBe(false)
    expect(lifecycleCause('RELEASED', 'IN_USE')).toBe('FIRST_ISSUE')
    expect(lifecycleCause('IN_USE', 'DEPLETED')).toBe('LAST_UNIT_OUT')
    expect(lifecycleCause('BLOCKED', 'RETURNED')).toBe('RETURN')
    expect(lifecycleCause('DEPLETED', 'IN_USE')).toBe('STOCK_BACK')
    expect(lifecycleCause('IN_USE', 'RELEASED')).toBe('ISSUE_UNDONE')
    expect(lifecycleCause('QUARANTINE', 'RELEASED')).toBe('RELEASE')
    expect(DEFAULT_LIST_LIFECYCLES).not.toContain('DEPLETED')
  })
})

describe('lot attributes per material kind (SCM-185)', () => {
  it('takes the kind’s keys and refuses others in words', () => {
    expect(attributeKeysFor('LEATHER')).toContain('tannage')
    expect(attributeKeysFor('LINING')).toEqual(['widthCm', 'weightGsm', 'origin'])
    expect(attributeKeysFor('TRIM')).toEqual(['origin'])
    expect(attributesProblems('LEATHER', { thicknessMinMm: '1.1', thicknessMaxMm: '1.3', tannage: 'CHROME', gradeMix: { A: '60', B: '40' }, finish: 'Nappa', origin: 'IT' })).toEqual([])
    expect(attributesProblems('LINING', { tannage: 'CHROME' }).map((problem) => problem.path)).toEqual(['attributes/tannage'])
  })
  it('checks thickness, tannage, grade mix and words as the database does', () => {
    const paths = (value: unknown) => attributesProblems('LEATHER', value).map((problem) => problem.path)
    expect(paths({ thicknessMinMm: '1.4', thicknessMaxMm: '1.2' })).toEqual(['attributes/thicknessMinMm'])
    expect(paths({ thicknessMaxMm: '25' })).toEqual(['attributes/thicknessMaxMm'])
    expect(paths({ tannage: 'ALUM' })).toEqual(['attributes/tannage'])
    expect(paths({ gradeMix: { A: '70', B: '40' } })).toEqual(['attributes/gradeMix'])
    expect(paths({ gradeMix: {} })).toEqual(['attributes/gradeMix'])
    expect(paths({ origin: '' })).toEqual(['attributes/origin'])
    expect(paths([])).toEqual(['attributes'])
  })
  it('merges a change (null removes) and lists the keys that changed', () => {
    const merged = mergeAttributes({ origin: 'IT', finish: 'Nappa' }, { origin: null, tannage: 'VEGETABLE', finish: ' Nappa ' })
    expect(merged).toEqual({ finish: 'Nappa', tannage: 'VEGETABLE' })
    expect(changedAttributes({ origin: 'IT', finish: 'Nappa' }, merged)).toEqual(['origin', 'tannage'])
  })
})

describe('split into shade groups (SCM-237, LT1:01)', () => {
  it('checks the groups before any row is read', () => {
    expect(splitDraftProblems({ groups: [] })[0]!.path).toBe('groups')
    const twice = splitDraftProblems({ groups: [{ label: '1', hideIds: ['a', 'b'] }, { shadeGroupId: 'g', hideIds: ['b'] }] })
    expect(twice.map((problem) => problem.path)).toEqual(['groups/1/hideIds/0'])
    expect(splitDraftProblems({ groups: [{ hideIds: ['a'] }] }).map((problem) => problem.path)).toEqual(['groups/0/label'])
  })
  it('names child lots after the parent, skipping codes taken', () => {
    expect([suffixAt(0), suffixAt(25), suffixAt(26), suffixAt(27)]).toEqual(['A', 'Z', 'AA', 'AB'])
    expect(childLotCodes('LA-000042', ['LA-000042-A', 'la-000042-c'], 3)).toEqual(['LA-000042-B', 'LA-000042-D', 'LA-000042-E'])
  })
  it('refuses a lot that is not of hides or is held, and a hide that something still names', () => {
    expect(familyRefusal({ code: 'L1', qualityStatus: 'RELEASED', tracking: 'LOT' })).toMatch(/not counted by the hide/)
    expect(familyRefusal({ code: 'L1', qualityStatus: 'BLOCKED', tracking: 'HIDE' })).toMatch(/blocked/)
    expect(familyRefusal({ code: 'L1', qualityStatus: 'QUARANTINE', tracking: 'HIDE' })).toBeNull()
    const free = { code: 'H1', state: 'FULL', onHand: '50.0000', reserved: false, held: false, openInspection: null, openCount: null, openTask: false, openTransfer: false, openClaim: false, plannedKit: false }
    expect(hideMoveRefusal(free)).toBeNull()
    expect(hideMoveRefusal({ ...free, state: 'PARTLY_CUT' })).toMatch(/partly cut/)
    expect(hideMoveRefusal({ ...free, onHand: '0.0000' })).toMatch(/holds nothing/)
    expect(hideMoveRefusal({ ...free, reserved: true })).toMatch(/reserved/)
    expect(hideMoveRefusal({ ...free, openInspection: 'IIN-1' })).toMatch(/IIN-1/)
  })
  it('proposes one group per shade the inspection gave, rejected and to-sort hides apart', () => {
    const groups = proposalFromInspection([
      { hideId: 'h1', shadeGroupId: 'g1', shadeLabel: '1', decision: 'ACCEPTED' },
      { hideId: 'h2', shadeGroupId: 'g2', shadeLabel: '2', decision: 'ACCEPTED' },
      { hideId: 'h3', shadeGroupId: 'g1', shadeLabel: '1', decision: null },
      { hideId: 'h4', shadeGroupId: 'g1', shadeLabel: '1', decision: 'REJECTED' },
      { hideId: 'h5', shadeGroupId: null, shadeLabel: null, decision: 'ACCEPTED' },
    ])
    expect(groups).toEqual([
      { shadeGroupId: 'g1', label: '1', hideIds: ['h1', 'h3'] },
      { shadeGroupId: 'g2', label: '2', hideIds: ['h2'] },
      { shadeGroupId: null, label: 'Rejected', hideIds: ['h4'] },
    ])
  })
})

describe('the lot page facts (SCM-238)', () => {
  it('says which documents end within 30 days or ended', () => {
    expect(addDays('2026-11-11', 30)).toBe('2026-12-11')
    expect(documentState(null, '2026-11-11')).toBe('NO_END')
    expect(documentState('2026-11-10', '2026-11-11')).toBe('EXPIRED')
    expect(documentState('2026-12-11', '2026-11-11')).toBe('EXPIRING')
    expect(documentState('2026-12-12', '2026-11-11')).toBe('VALID')
  })
  const inspection = (over: Partial<IncomingFacts>): IncomingFacts => ({ number: 'IIN-1', status: 'DECIDED', computedResult: 'PASS', overrideReason: null, accepted: '12', rejected: '0', toSort: '0', decidedAt: '2026-11-02T10:00:00.000Z', createdAt: '2026-11-01T10:00:00.000Z', ...over })
  it('says whether the incoming inspection passed', () => {
    expect(incomingCheck([]).state).toBe('NOT_INSPECTED')
    expect(incomingCheck([inspection({})]).state).toBe('PASSED')
    expect(incomingCheck([inspection({ computedResult: 'FAIL', overrideReason: 'Shade within the brand’s tolerance' })]).state).toBe('PASSED')
    expect(incomingCheck([inspection({ computedResult: 'FAIL', accepted: '3', rejected: '9' })]).state).toBe('FAILED')
    expect(incomingCheck([inspection({}), inspection({ number: 'IIN-2', status: 'OPEN', createdAt: '2026-11-05T10:00:00.000Z' })])).toMatchObject({ state: 'OPEN', number: 'IIN-2' })
  })
  it('keeps the receiver from releasing (Owner answer W3)', () => {
    expect(separationCheck({ qualityStatus: 'QUARANTINE', receivedById: 'u1', decidedById: null, viewerId: 'u1' })).toMatchObject({ state: 'WAITING', viewerReceived: true })
    expect(separationCheck({ qualityStatus: 'RELEASED', receivedById: 'u1', decidedById: 'u2', viewerId: 'u3' }).state).toBe('KEPT')
    expect(separationCheck({ qualityStatus: 'RELEASED', receivedById: 'u1', decidedById: 'u1', viewerId: 'u3' }).state).toBe('NOT_KEPT')
    expect(separationCheck({ qualityStatus: 'RELEASED', receivedById: null, decidedById: 'u1', viewerId: 'u3' }).state).toBe('NOT_RECORDED')
  })
})

describe('the dated trace report (SCM-242)', () => {
  const trace: ReportTrace = {
    start: { key: 'LOT:l1', kind: 'LOT', id: 'l1', code: 'LA-000042' },
    direction: 'BOTH',
    asOf: '2026-11-11T09:00:00.000Z',
    nodes: [
      { key: 'LOT:l1', kind: 'LOT', id: 'l1', code: 'LA-000042', reach: 'EXACT', sides: [], restricted: [], holds: [], lot: { qualityStatus: 'RELEASED', item: { code: 'LEA-100', name: 'Cowhide' }, colourCode: 'BLK' } },
      { key: 'SHIPMENT:s1', kind: 'SHIPMENT', id: 's1', code: 'SH-1', reach: 'EXACT', sides: ['FORWARD'], restricted: [], holds: [], shipment: { status: 'SHIPPED', shippedAt: '2026-11-03T09:00:00.000Z', left: true, ddtNumbers: ['144/2026'] } },
      { key: 'SHIPMENT:s2', kind: 'SHIPMENT', id: 's2', code: 'SH-2', reach: 'POSSIBLE', sides: ['FORWARD'], restricted: [], holds: [], shipment: { status: 'SHIPPED', shippedAt: '2026-11-10T09:00:00.000Z', left: true, ddtNumbers: [] } },
      { key: 'CUSTOMER:c1', kind: 'CUSTOMER', id: 'c1', code: 'C1', reach: 'EXACT', sides: ['FORWARD'], restricted: [], holds: [], party: { code: 'C1', name: 'Brand One' }, received: true },
      { key: 'CUSTOMER:c2', kind: 'CUSTOMER', id: 'c2', code: null, reach: 'POSSIBLE', sides: ['FORWARD'], restricted: ['parties.view'], holds: [], party: null, received: true },
    ],
    edges: [
      { from: 'SHIPMENT:s1', to: 'CUSTOMER:c1', link: 'DELIVERED_TO' },
      { from: 'SHIPMENT:s2', to: 'CUSTOMER:c2', link: 'DELIVERED_TO' },
    ],
    levels: [
      { kind: 'LOT', exact: 1, possible: 0 },
      { kind: 'SHIPMENT', exact: 1, possible: 1 },
      { kind: 'CUSTOMER', exact: 1, possible: 1 },
    ],
    gaps: [{ code: 'BATCH_TRACKED', severity: 'COARSE', count: 1, message: 'Batch tracked.' }],
    customersReceived: { exact: 1, possible: 1 },
    restricted: [{ permission: 'parties.view', nodes: 1 }],
  }
  const request = { audience: 'AUTHORITY' as const, recipient: 'Market surveillance office', reference: 'REQ-7', requestedOn: '2026-11-09', asOf: '2026-11-05' }
  const context = { language: 'en' as const, company: { name: 'Factory One', lines: ['Via Roma 1'], legal: 'Factory One · VAT IT0' }, madeAt: new Date('2026-11-11T09:30:00.000Z'), madeBy: 'Quality Person' }

  it('checks what was asked and when', () => {
    expect(requestProblems({ ...request, recipient: ' ' }, '2026-11-11').map((problem) => problem.path)).toEqual(['recipient'])
    expect(requestProblems({ ...request, requestedOn: '2026-11-12' }, '2026-11-11').map((problem) => problem.path)).toEqual(['requestedOn'])
    expect(requestProblems({ ...request, asOf: '2026-11-12' }, '2026-11-11').map((problem) => problem.path)).toEqual(['asOf'])
    expect(requestProblems(request, '2026-11-11')).toEqual([])
  })
  it('states who asked, what, when, and counts only the customers reached by the day asked', () => {
    const report = composeTraceReport(trace, request, context, 'PDF')
    expect(report.facts.map((fact) => fact.value)).toEqual(['Market surveillance office', 'Authority', 'REQ-7', '2026-11-09', 'Lot LA-000042', 'Both ways', '2026-11-05', '2026-11-11 10:30', 'Quality Person'])
    expect(report.counts).toMatchObject({ nodes: 5, customersExact: 1, customersPossible: 1, customersByAsOfExact: 1, customersByAsOfPossible: 0, gaps: 1 })
    const byCode = new Map(report.rows.map((row) => [row.code, row]))
    expect(byCode.get('SH-1')!.byAsOf).toBe('yes')
    expect(byCode.get('SH-2')!.byAsOf).toBe('no')
    expect(byCode.get('—')!.details).toBe('not visible to the person who made the report')
    expect(report.fileName).toBe('trace-report-LA-000042-2026-11-11.pdf')
    expect(reportFileName('SEED/LOT 01', '2026-11-11', 'CSV')).toBe('trace-report-SEED-LOT-01-2026-11-11.csv')
  })
  it('writes the CSV with the request in its first line, in Italian with semicolons', () => {
    const csv = traceReportCsv(composeTraceReport(trace, request, { ...context, language: 'it' }, 'CSV'))
    const lines = csv.replace('﻿', '').split('\r\n')
    expect(lines[0]).toContain('Richiesto da: Market surveillance office')
    expect(lines[0]).toContain('Situazione al: 05/11/2026')
    expect(lines[1]).toBe('Livello;Codice;Collegamento;Lato;Dettagli;Entro la data')
    expect(lines).toHaveLength(2 + trace.nodes.length + 1)
  })
})
