import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import type { PostalAddress } from '@nexus/factory-domain/documents/model'
import { sellerOf } from '@nexus/factory-domain/invoicing/document'
import { destinationClassOf } from '@nexus/factory-domain/shipping/customs/rules'
import { isValidPartitaIva } from '@nexus/factory-domain/tax/tax-ids'
import { openFactoryDatabase, type FactoryDatabase } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedFileKeyProblem, seedFileSha256 } from './seed-files'
import { seedUuid, type SeedContext } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { SEED_DIR } from './tools'

/**
 * The seed is complete for testing (B-W2b-F59), on a database built from the migrations and seeded twice (every seed file, in
 * name order, as the CLI runs them) through the real login and the scoped client:
 *   - every seeded file's row names the hash of the bytes the seed makes for it (seed-files.ts; a copy its source's) and a
 *     key the files platform's rule makes for it (company or tenant, legal/ for the fiscal archive, the upload's year);
 *   - every seed company can issue an e-invoice and print a document: FatturaPA's seller data (sellerOf), the c.c. art. 2250
 *     lines (legalProblems), a PEC to receive at, an EORI; a made-up Partita IVA with a valid check digit;
 *   - the export: SEED-SH-0003 of SEED-SO-0002 to Switzerland, packed and weighed, its garment released, the style's customs
 *     facts, the broker's contact with an e-mail, and the broker pack still OFF at every site (the Owner's rule of 11-13).
 */

const NS = 'w2b-f59-seed'
const key = (name: string): string => seedUuid(NS, name)
const T = { tenant: key('tenant'), companyA: key('company:A'), companyB: key('company:B'), siteA1: key('site:A1') }

let db: MigratedDatabase
let factory: FactoryDatabase

type Row = Record<string, any>
const admin = async (text: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(text, values)).rows as Row[]

async function seedAll(): Promise<void> {
  const context: SeedContext = { db: factory, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
}

beforeAll(async () => {
  db = await migratedDatabase('seedcompletew2bf59')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await seedAll()
  // Run twice: every seed is idempotent, the changed ones too.
  await seedAll()
}, 600_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seeded files (B-W2b-F59)', () => {
  it('name the hash of the bytes the seed makes for them, and a key the files platform makes for them', async () => {
    const rows = await admin(
      `SELECT id, "companyId", kind::text AS kind, status::text AS status, "originalName", "contentType", "sizeBytes", sha256, "storageKey", "createdAt", "sourceFileId" FROM "StoredFile" WHERE "tenantId" = $1 ORDER BY id`,
      [T.tenant],
    )
    expect(rows.length).toBeGreaterThan(100)
    const byId = new Map(rows.map((row) => [row.id as string, row]))
    const problems: string[] = []
    for (const row of rows) {
      const keyProblem = seedFileKeyProblem(T.tenant, row as never)
      if (keyProblem) problems.push(keyProblem)
      if (row.status !== 'AVAILABLE') continue
      const source = row.sourceFileId ? byId.get(row.sourceFileId)! : row
      if (seedFileSha256({ id: source.id, originalName: source.originalName, contentType: source.contentType, sizeBytes: Number(source.sizeBytes) }) !== row.sha256) {
        problems.push(`${row.originalName} (${row.id}): its sha256 is not the seed's bytes`)
      }
    }
    expect(problems).toEqual([])
    // The floor's data sheets and the safety files were under …/health/ and …/safety/: keys no upload makes.
    expect(rows.filter((row) => /\/(health|safety)\//.test(row.storageKey))).toEqual([])
  })
})

describe('the seed companies (B-W2b-F59)', () => {
  it('can issue an e-invoice and print a document: seller data, the art. 2250 lines, a PEC, an EORI; made-up valid Partite IVA', async () => {
    const companies = await admin(
      `SELECT code, "legalName", "vatNumber", "fiscalCode", "regimeFiscale", "reaOffice", "reaNumber", "shareCapital"::text AS "shareCapital", "soleShareholder", "inLiquidation", address, pec, "sdiReceiverCode", eori, currency FROM "Company" WHERE "tenantId" = $1 ORDER BY code`,
      [T.tenant],
    )
    expect(companies.map((company) => [company.code, company.vatNumber, company.eori])).toEqual([
      ['SCA', 'IT00000003038', 'IT00000003038'],
      ['SCB', 'IT00000004044', 'IT00000004044'],
    ])
    for (const company of companies) {
      const address = company.address as PostalAddress
      expect(sellerOf({ ...company, address } as never).issues, company.code).toEqual([])
      expect(legalProblems({ ...company, address } as never), company.code).toEqual([])
      expect(company.pec ?? company.sdiReceiverCode, company.code).toMatch(/@pec\.example\.com$/)
      expect(isValidPartitaIva(company.vatNumber.slice(2)), company.code).toBe(true)
      expect(company.fiscalCode).toBe(company.vatNumber.slice(2))
      expect(address).toMatchObject({ province: 'MI', postalCode: '00000', country: 'IT' })
    }
  })

  it('hold a draft that issues on any day: an immediate TD01 of company A with no date until its issue and no DDT', async () => {
    const drafts = await admin(
      `SELECT i."docType"::text AS "docType", i.status::text AS status, i.number, i."issuedAt", (SELECT count(*)::int FROM "InvoiceLine" l WHERE l."invoiceId" = i.id AND l."ddtId" IS NOT NULL) AS "ddtLines" FROM "Invoice" i WHERE i.id = $1`,
      [`ffffffff${key('invoice-draft:TD01:P1:embroidery').slice(8)}`],
    )
    expect(drafts).toEqual([{ docType: 'TD01', status: 'DRAFT', number: null, issuedAt: null, ddtLines: 0 }])
  })
})

describe('the export to Switzerland (B-W2b-F59)', () => {
  it('is SEED-SH-0003 of SEED-SO-0002: PACKED to a Swiss address, one released garment in a weighed parcel', async () => {
    const [shipment] = await admin(
      `SELECT s.id, s.status::text AS status, s."shipTo", s."dutyPayer"::text AS "dutyPayer", o.number AS "orderNumber", p.code AS party FROM "Shipment" s JOIN "SalesOrder" o ON o.id = s."salesOrderId" JOIN "Party" p ON p.id = s."partyId" WHERE s."tenantId" = $1 AND s.number = 'SEED-SH-0003'`,
      [T.tenant],
    )
    expect(shipment).toMatchObject({ status: 'PACKED', dutyPayer: 'RECEIVER', orderNumber: 'SEED-SO-0002', shipTo: { country: 'CH', city: 'Seedwil' } })
    expect(destinationClassOf(shipment!.shipTo.country)).toBe('EXPORT')
    const lines = await admin(`SELECT l.size, l.quantity, p."grossWeightKg"::text AS weight FROM "ShipmentLine" l JOIN "Parcel" p ON p.id = l."parcelId" WHERE l."shipmentId" = $1`, [shipment!.id])
    expect(lines).toEqual([{ size: '50', quantity: 1, weight: '2.4000' }])
    expect(await admin(`SELECT r.quantity, w.number AS "workOrder" FROM "QualityRelease" r JOIN "WorkOrder" w ON w.id = r."workOrderId" WHERE r."tenantId" = $1 AND r.number = 'SEED-REL-0006'`, [T.tenant])).toEqual([{ quantity: 1, workOrder: 'SEED-WO-0001' }])
  })

  it('has what the customs papers and the broker pack need: the style’s customs facts, the broker’s e-mail; the pack switch stays OFF', async () => {
    const [style] = await admin(`SELECT "hsCode", "originCountry", "netMassKg"::text AS "netMassKg" FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [T.tenant])
    expect(style).toEqual({ hsCode: '42031000', originCountry: 'IT', netMassKg: '1.850' })
    const contacts = await admin(`SELECT c.email, c.status::text AS status FROM "PartyContact" c JOIN "Party" p ON p.id = c."partyId" WHERE p."tenantId" = $1 AND p.code = 'SEED-BROKER'`, [T.tenant])
    expect(contacts).toEqual([{ email: 'customs-desk@seed-broker.example.com', status: 'ACTIVE' }])
    expect(await admin(`SELECT "brokerPackOn" FROM "ShippingSettings" WHERE "tenantId" = $1 AND "brokerPackOn"`, [T.tenant])).toEqual([])
  })
})
