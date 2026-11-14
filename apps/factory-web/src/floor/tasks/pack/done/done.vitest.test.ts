import { describe, expect, it } from 'vitest'
import { packedSummary } from './model'

/** Packed's summary (B-W2b-387): what the bench says when a shipment is done, from what really happened. */

describe("Packed's summary (design floor.pack \"Packed\")", () => {
  const documents = (labels: 'officeBuys' | 'noPrinter' | 'noRight' | 'notNeeded' | null, ddt: 'officeIssues' | 'noPrinter' | 'pdfMissing' | null) => ({ labels: { held: labels, labelled: 2, total: 2 }, documents: { held: ddt, ddtNumber: 'DDT-1', ddtDate: null, packingList: true } })
  it('labels printed when every label job printed; on their way, failed, or not printed yet', () => {
    const facts = { number: 'SH-1', cartons: 4, marksDue: false, transportBy: 'CARRIER' as const, documents: documents(null, null) }
    expect(packedSummary({ ...facts, jobs: [{ what: 'LABEL', status: 'PRINTED' }, { what: 'DDT', status: 'PRINTED' }] })).toEqual({ number: 'SH-1', cartons: 4, marks: 'printed', transportBy: 'CARRIER', labels: 'printed', documents: 'printed' })
    expect(packedSummary({ ...facts, jobs: [{ what: 'LABEL', status: 'SENT' }, { what: 'PACKING_LIST', status: 'FAILED' }] })).toMatchObject({ labels: 'printing', documents: 'failed' })
    expect(packedSummary({ ...facts, jobs: [] })).toMatchObject({ labels: 'ready', documents: 'ready' })
  })
  it('why they wait: the office, no printer, the role; no carrier label for our van; marks to print again', () => {
    expect(packedSummary({ number: 'SH-1', cartons: 1, marksDue: true, transportBy: 'CARRIER', documents: documents('officeBuys', 'officeIssues'), jobs: [] })).toMatchObject({ marks: 'due', labels: 'office', documents: 'office' })
    expect(packedSummary({ number: 'SH-1', cartons: 1, marksDue: false, transportBy: 'CARRIER', documents: documents('noPrinter', 'pdfMissing'), jobs: [] })).toMatchObject({ labels: 'noPrinter', documents: 'pdfMissing' })
    expect(packedSummary({ number: 'SH-1', cartons: 1, marksDue: false, transportBy: 'CARRIER', documents: documents('noRight', 'noPrinter'), jobs: [] })).toMatchObject({ labels: 'noRight', documents: 'noPrinter' })
    expect(packedSummary({ number: 'SH-1', cartons: 1, marksDue: false, transportBy: 'SENDER', documents: documents('notNeeded', null), jobs: [{ what: 'LABEL', status: 'PRINTED' }] })).toMatchObject({ labels: 'notNeeded' })
  })
})
