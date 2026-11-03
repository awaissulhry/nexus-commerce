import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { NCR_CHANGED_FIELDS } from './changes'
import { answerHeld, answerProblems, askHeld, askProblems } from './concession'
import { computePlan, costHeld, costLineProblems, costTotal, otherNeedsWords, planIsEmpty } from './cost'
import { ncrReport, ncrReportFingerprintText, zoneWordsIn, type NcrReportInput } from './report'
import { decisionProblems } from './rules'

/** B-W2b-113: the NCR's cost, concessions, report and the safety rule on decisions. */
describe('NCR cost (QHS-086)', () => {
  it('a typed line needs its kind and a whole amount from 0; OTHER says what', () => {
    expect(costLineProblems({}, true).map((issue) => issue.path)).toEqual(['body/kind', 'body/amount'])
    expect(costLineProblems({ kind: 'FREIGHT', amount: -1 }, true).map((issue) => issue.path)).toEqual(['body/amount'])
    expect(costLineProblems({ kind: 'FREIGHT', amount: 12.5 }, true).map((issue) => issue.path)).toEqual(['body/amount'])
    expect(costLineProblems({ kind: 'FREIGHT', amount: 0 }, true)).toEqual([])
    expect(costLineProblems({ amount: 100 }, false)).toEqual([])
    expect(otherNeedsWords('OTHER', '  ')?.path).toBe('body/description')
    expect(otherNeedsWords('OTHER', 'Courier back to the tannery')).toBeNull()
    expect(otherNeedsWords('LABOUR', null)).toBeNull()
  })

  it('the total is the sum; a closed or cancelled NCR keeps its cost', () => {
    expect(costTotal([{ amount: 1250 }, { amount: 0 }, { amount: 750 }])).toBe(2000)
    expect(costTotal([])).toBe(0)
    expect(costHeld('CLOSED')).toMatch(/closed/)
    expect(costHeld('CANCELLED')).toMatch(/cancelled/)
    expect(costHeld('DECIDED')).toBeNull()
  })

  it('computing again changes a line in place, adds the new records and removes the gone ones', () => {
    const stored = [
      { id: 'a', recordType: 'NcrDispositionLine', recordId: 'm1', kind: 'SCRAP_VALUE' as const, amount: 100, description: null },
      { id: 'b', recordType: 'NcrDispositionLine', recordId: 'm2', kind: 'SCRAP_VALUE' as const, amount: 200, description: null },
    ]
    const plan = computePlan(stored, [
      { kind: 'SCRAP_VALUE', recordType: 'NcrDispositionLine', recordId: 'm1', amount: 100, description: '' },
      { kind: 'SCRAP_VALUE', recordType: 'ReworkOrder', recordId: 'r1', amount: 900, description: '' },
    ])
    expect(plan.add.map((line) => line.recordId)).toEqual(['r1'])
    expect(plan.change).toEqual([])
    expect(plan.remove).toEqual(['b'])
    const changed = computePlan(stored.slice(0, 1), [{ kind: 'SCRAP_VALUE', recordType: 'NcrDispositionLine', recordId: 'm1', amount: 150, description: '' }])
    expect(changed.change.map((entry) => entry.id)).toEqual(['a'])
    expect(planIsEmpty(computePlan(stored.slice(0, 1), [{ kind: 'SCRAP_VALUE', recordType: 'NcrDispositionLine', recordId: 'm1', amount: 100, description: '' }]))).toBe(true)
  })

  it('the events name the new fields, never an amount', () => {
    for (const field of ['causeCodeId', 'cost', 'concessions', 'report']) expect(NCR_CHANGED_FIELDS).toContain(field)
  })
})

describe('concession asked of the customer (QHS-085)', () => {
  it('never on a critical NCR, nor once it is closed or cancelled', () => {
    expect(askHeld({ stage: 'OPEN', severity: 'CRITICAL' })).toMatch(/never accepted.*concession/)
    expect(askHeld({ stage: 'CLOSED', severity: 'MINOR' })).toMatch(/closed/)
    expect(askHeld({ stage: 'DECIDED', severity: 'MAJOR' })).toBeNull()
  })

  it('an ask says the deviation and what we propose', () => {
    expect(askProblems({ ask: ' ', proposal: '' }, true).map((issue) => issue.path)).toEqual(['body/ask', 'body/proposal'])
    expect(askProblems({ ask: 'Shade slightly darker', proposal: '5% discount' }, true)).toEqual([])
    expect(askProblems({ proposal: 'Delivery as they are' }, false)).toEqual([])
  })

  it('an answer once: who answered, why when refused, not before it was asked nor in the future', () => {
    const askedAt = new Date('2026-11-01T09:00:00Z')
    const now = new Date('2026-11-03T09:00:00Z')
    expect(answerProblems({ status: 'REFUSED', answer: '', answeredBy: 'M. Rossi', answeredAt: now }, askedAt, now).map((issue) => issue.path)).toEqual(['body/answer'])
    expect(answerProblems({ status: 'ACCEPTED', answeredBy: '', answeredAt: now }, askedAt, now).map((issue) => issue.path)).toEqual(['body/answeredBy'])
    expect(answerProblems({ status: 'ACCEPTED', answeredBy: 'M. Rossi', answeredAt: new Date('2026-10-01T09:00:00Z') }, askedAt, now).map((issue) => issue.path)).toEqual(['body/answeredAt'])
    expect(answerProblems({ status: 'ACCEPTED', answeredBy: 'M. Rossi', answeredAt: new Date('2026-11-04T09:00:00Z') }, askedAt, now).map((issue) => issue.path)).toEqual(['body/answeredAt'])
    expect(answerProblems({ status: 'ACCEPTED', answeredBy: 'M. Rossi', answeredAt: now }, askedAt, now)).toEqual([])
    expect(answerHeld('ASKED')).toBeNull()
    expect(answerHeld('ACCEPTED')).toMatch(/once/)
  })
})

describe('the safety rule on decisions (B-W2b-90 via B-W2b-113)', () => {
  const base = { quantity: '2', left: new Dec(5), uom: 'PCS', note: null }
  it('a critical NCR is never regraded nor used as is; a major one is regraded but never used as is', () => {
    expect(decisionProblems({ ...base, outcome: 'REGRADE', severity: 'CRITICAL' }).map((issue) => issue.path)).toEqual(['dispositionCodeId'])
    expect(decisionProblems({ ...base, outcome: 'USE_AS_IS', severity: 'CRITICAL' }).map((issue) => issue.path)).toEqual(['dispositionCodeId'])
    expect(decisionProblems({ ...base, outcome: 'REGRADE', severity: 'MAJOR' })).toEqual([])
    expect(decisionProblems({ ...base, outcome: 'USE_AS_IS', severity: 'MAJOR' }).map((issue) => issue.path)).toEqual(['dispositionCodeId'])
    expect(decisionProblems({ ...base, outcome: 'SCRAP', severity: 'CRITICAL' })).toEqual([])
  })
})

describe('the NCR report (ncr-pdf)', () => {
  const input: NcrReportInput = {
    language: 'it',
    date: '2026-11-03',
    company: { name: 'Fabbrica Esempio Srl', lines: ['Via Esempio 1, 00100 Roma'], legal: 'Fabbrica Esempio Srl - P.IVA 00000000000' },
    number: 'NCR-2026-0001',
    title: 'Cucitura aperta sulla spalla',
    stage: 'CLOSED',
    severity: 'MAJOR',
    foundAt: 'FINAL',
    foundOn: '2026-11-01',
    source: 'Ispezione INS-1',
    style: 'JK-100 Giacca',
    colourway: 'NERO',
    size: 'M',
    serial: null,
    lot: null,
    supplier: null,
    workOrder: 'WO-1',
    quantityAffected: '40.0000',
    quantitySuspect: null,
    uom: 'PCS',
    defect: 'Cucitura aperta (SEAM-OPEN)',
    zone: 'LEFT_SHOULDER',
    cause: null,
    capa: 'CAPA-2026-0001',
    owner: 'Quality Lead',
    description: 'Cucitura aperta.\nTrovata al collaudo.',
    containment: [{ kind: 'HOLD_STOCK', description: null, status: 'DONE', doneOn: '2026-11-01' }],
    decisions: [{ seq: 1, disposition: 'Rilavorazione', quantity: '40.0000', state: 'DONE', followUp: 'Rilavorazione WO-1' }],
    closedOn: '2026-11-02',
    closeNote: 'Tutto rilavorato.',
    cancelReason: null,
    sample: false,
  }

  it('prints the facts, the sections and no money in the chosen language', () => {
    const report = ncrReport(input)
    expect(report.title).toBe('Rapporto di non conformità')
    expect(report.facts.map((fact) => fact.label)).toContain('Azione correttiva')
    expect(report.sections.map((section) => section.heading)).toEqual(['1 - Descrizione', '2 - Contenimento', '3 - Decisioni per quantità', '4 - Chiusura'])
    expect(report.sections[0]!.lines).toEqual(['Cucitura aperta.', 'Trovata al collaudo.'])
    expect(report.sections[3]!.lines[0]).toMatch(/Chiusa il/)
    expect(JSON.stringify(report)).not.toMatch(/€|EUR|cost/i)
    expect(report.fileName).toBe('Rapporto-NC-NCR-2026-0001-it.pdf')
    expect(ncrReport({ ...input, language: 'en' }).title).toBe('Nonconformance report')
    expect(ncrReport({ ...input, sample: true }).sample).toMatch(/ANTEPRIMA/)
  })

  it('the fingerprint leaves out the date', () => {
    expect(ncrReportFingerprintText(ncrReport(input))).toBe(ncrReportFingerprintText(ncrReport({ ...input, date: '2026-12-01' })))
    expect(ncrReportFingerprintText(ncrReport(input))).not.toBe(ncrReportFingerprintText(ncrReport({ ...input, title: 'Altro' })))
    expect(zoneWordsIn('NOT_A_ZONE', 'en')).toBe('NOT_A_ZONE')
  })
})
