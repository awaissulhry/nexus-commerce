import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LABELLED_TYPES, recordLabelOf } from './labels'
import { resolveRecord, THREAD_RECORDS } from './records'

/**
 * B-TH-075 (threads plan TH-6, thread-G01, N14): every thread type has its words. Eight types had no labeller, so the bell, Today
 * and the tasks showed "SubcontractOrder 3f2a1b"; the technical file's page mounted a thread the API did not have. The labellers
 * and the resolver read through the client they are given (in the caller's scope): a stand-in client answers each model's
 * findUnique with made-up rows, so this file needs no database of its own — it runs with the PG folder of platform/threads.
 */

type Rows = Record<string, Record<string, unknown>>

/** A stand-in client: `client.<model>.findUnique({ where: { id } })` answers the row given for that id, else null. */
function clientOf(rows: Rows): never {
  return new Proxy({}, { get: (_target, model: string) => ({ findUnique: async ({ where }: { where: { id: string } }) => rows[model]?.[where.id] ?? null }) }) as never
}

const ID = {
  subcontract: '0190f0e2-7501-7000-8000-000000000001',
  supplierInvoice: '0190f0e2-7501-7000-8000-000000000002',
  hold: '0190f0e2-7501-7000-8000-000000000003',
  oldHold: '0190f0e2-7501-7000-8000-0000000a1b2c',
  rma: '0190f0e2-7501-7000-8000-000000000004',
  repair: '0190f0e2-7501-7000-8000-000000000005',
  team: '0190f0e2-7501-7000-8000-000000000006',
  approval: '0190f0e2-7501-7000-8000-000000000007',
  round: '0190f0e2-7501-7000-8000-000000000008',
  profile: '0190f0e2-7501-7000-8000-000000000009',
  techFile: '0190f0e2-7501-7000-8000-000000000010',
  company: '0190f0e2-7501-7000-8000-000000000011',
  brand: '0190f0e2-7501-7000-8000-000000000012',
  missing: '0190f0e2-7501-7000-8000-000000000099',
}

const ROWS: Rows = {
  subcontractOrder: { [ID.subcontract]: { number: 'SC-2026-0014' } },
  supplierInvoice: { [ID.supplierInvoice]: { number: '118/2026', party: { code: 'SUP-PELLI-DEMO' } } },
  qualityHold: { [ID.hold]: { number: 'HLD-2026-0091' }, [ID.oldHold]: { number: null } },
  returnAuthorisation: { [ID.rma]: { number: 'RMA-2026-0007' } },
  repairOrder: { [ID.repair]: { number: 'RIP-2026-0003' } },
  team: { [ID.team]: { code: 'TEAM-DEMO', name: 'Squadra Demo' } },
  approvalRequest: { [ID.approval]: { recordType: 'SampleRound', recordId: ID.round } },
  sampleRound: { [ID.round]: { number: 'SR-2026-0021' } },
  // The rider's name is on the row's party: the label must never carry it.
  measurementProfile: { [ID.profile]: { garmentType: 'JACKET', party: { legalName: 'Rider Esempio' } } },
  technicalFile: { [ID.techFile]: { number: 'TF-2026-0005', companyId: ID.company, style: { brandPartyId: ID.brand } } },
}

describe('B-TH-075 — every thread type has its words', () => {
  it('every record type with a thread (THREAD_RECORDS) has a labeller of its own: no "Type 3f2a1b" in the bell, Today or the tasks', () => {
    const missing = Object.keys(THREAD_RECORDS).filter((type) => !LABELLED_TYPES.has(type))
    expect(missing).toEqual([])
    for (const type of ['SubcontractOrder', 'SupplierInvoice', 'QualityHold', 'ReturnAuthorisation', 'RepairOrder', 'Team', 'ApprovalRequest', 'MeasurementProfile', 'TechnicalFile']) expect(LABELLED_TYPES.has(type), type).toBe(true)
  })

  it('the eight types that had none say their number (a supplier invoice with its supplier, a team its code and name)', async () => {
    const client = clientOf(ROWS)
    expect(await recordLabelOf(client, 'SubcontractOrder', ID.subcontract)).toBe('SC-2026-0014')
    expect(await recordLabelOf(client, 'SupplierInvoice', ID.supplierInvoice)).toBe('118/2026 · SUP-PELLI-DEMO')
    expect(await recordLabelOf(client, 'QualityHold', ID.hold)).toBe('HLD-2026-0091')
    expect(await recordLabelOf(client, 'ReturnAuthorisation', ID.rma)).toBe('RMA-2026-0007')
    expect(await recordLabelOf(client, 'RepairOrder', ID.repair)).toBe('RIP-2026-0003')
    expect(await recordLabelOf(client, 'Team', ID.team)).toBe('TEAM-DEMO Squadra Demo')
  })

  it('a hold placed before holds were numbered: "Quality hold" and the end of its id, never the type name', async () => {
    const label = await recordLabelOf(clientOf(ROWS), 'QualityHold', ID.oldHold)
    expect(label).toBe('Quality hold 0a1b2c')
    expect(label).not.toContain('QualityHold')
  })

  it('a request to approve is named by what it is about (that record’s own label)', async () => {
    expect(await recordLabelOf(clientOf(ROWS), 'ApprovalRequest', ID.approval)).toBe('Approval request · SR-2026-0021')
    const gone = clientOf({ ...ROWS, sampleRound: {} })
    expect(await recordLabelOf(gone, 'ApprovalRequest', ID.approval)).toBe('Approval request')
  })

  it('a rider’s measurements by the garment type only — never the rider’s name (body data travels to the bell and the tasks)', async () => {
    const label = await recordLabelOf(clientOf(ROWS), 'MeasurementProfile', ID.profile)
    expect(label).toBe('Measurements JACKET')
    expect(label).not.toContain('Esempio')
    const source = readFileSync(new URL('./labels.ts', import.meta.url), 'utf8')
    const block = source.slice(source.indexOf('MeasurementProfile: async'), source.indexOf('TechnicalFile: async'))
    expect(block).toContain('select: { garmentType: true }')
    expect(block).not.toMatch(/party|legalName|name/)
  })

  it('N14: the technical file is a thread record — its company and its style’s brand (as the style’s own thread), its number as label', async () => {
    const client = clientOf(ROWS)
    expect(await resolveRecord(client, 'TechnicalFile', ID.techFile)).toEqual({ companyId: ID.company, siteId: null, partyId: ID.brand })
    expect(await recordLabelOf(client, 'TechnicalFile', ID.techFile)).toBe('TF-2026-0005')
    const ownRange = clientOf({ technicalFile: { [ID.techFile]: { companyId: ID.company, style: { brandPartyId: null } } } })
    expect(await resolveRecord(ownRange, 'TechnicalFile', ID.techFile)).toEqual({ companyId: ID.company, siteId: null, partyId: null })
  })

  it('a record that is not there for the caller has no label and no thread (null), whichever new type asks', async () => {
    const client = clientOf({})
    for (const type of ['SubcontractOrder', 'SupplierInvoice', 'QualityHold', 'ReturnAuthorisation', 'RepairOrder', 'Team', 'ApprovalRequest', 'MeasurementProfile', 'TechnicalFile']) {
      expect(await recordLabelOf(client, type, ID.missing), type).toBeNull()
    }
    expect(await resolveRecord(client, 'TechnicalFile', ID.missing)).toBeNull()
  })
})
