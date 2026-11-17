import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../../packages/factory-db/seed/shipping'
import { seed as seedCapa } from '../../../../../../../packages/factory-db/seed/capa'
import { seed as seedReasons } from '../../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../../core/command'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers } from '../../../../golden-flow/portal/testing/two-brands'
import { pdfFlatText } from '../../../../platform/documents/testing/pdf-text'
import { applySystemRoleChanges, systemRoleChanges } from '../../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../../testing/timeouts'
import { editCapa } from '../../capa/capa'
import { makeReport } from '../../capa/report'
import { addSources, removeSource } from '../../capa/sources'
import { logComplaint } from '../log'
import { shareEightD } from './publish'

/**
 * B-TH-031 (threads plan TH-2, WALL-G06, wall test T15; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand"): an 8D goes to a customer only with that customer's complaints. "Share with the customer" of the
 * CAPA's 8D is refused when the CAPA is written for another customer (OTHER_CUSTOMER), when an internal CAPA answers a complaint
 * of another customer too (OTHER_CUSTOMERS_COMPLAINTS), or when the kept report was made while such a complaint was a source
 * (REPORT_OUTDATED); an 8D written for the customer prints that customer's complaints only, so it goes even with another
 * customer's complaint linked to the CAPA. Each shared PDF is scanned for brand B's names and complaint number.
 *
 * The seeds up to the CAPA wave: SEED-CMP-0001, a complaint of P1 (here Brand Alpha, brand A) with SEED-8D-0001 written for it;
 * P3 is Brand Beta (brand B), whose complaint the office logs here. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/complaints/portal`.
 */

let h: Harness
const NS = 'eight-d-wall'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const alpha = seedUuid(NS, 'party:P1')
const beta = seedUuid(NS, 'party:P3')
const CMP1 = seedUuid(NS, 'returns:CMP-0001')
const EIGHT_D = seedUuid(NS, 'capa:capa:8D-0001')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const OFFICE: Permission[] = ['quality.complaints.view', 'quality.complaints.log', 'quality.complaints.manage', 'quality.capa.view', 'quality.capa.manage', 'files.read', 'files.manage', 'files.upload']
let officeId = ''
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions: OFFICE, companies: 'all', sites: 'all', parties: 'all' }] })
const version = async (): Promise<number> => (await one<{ version: number }>('SELECT version FROM "Capa" WHERE id = $1', [EIGHT_D])).version

/** The share's refusal: its `held/<CODE>` (null: it went). */
async function shareHeld(): Promise<string | null> {
  try {
    await shareEightD(h.files, office(), CMP1, {})
    return null
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    return (error.issues?.[0]?.path ?? '').replace('held/', '')
  }
}

/** The text of a stored PDF. */
async function fileText(fileId: string): Promise<string> {
  const row = await one<{ storeAccountId: string; storageKey: string; sizeBytes: number }>('SELECT "storeAccountId", "storageKey", "sizeBytes" FROM "StoredFile" WHERE id = $1', [fileId])
  return pdfFlatText((await h.files.storage.read(callerFor(h.database, systemContext(T, newId())), row.storeAccountId, row.storageKey, row.sizeBytes))!)
}

let betaComplaint: { id: string; number: string }

beforeAll(async () => {
  h = await startHarness('eight_d_wall')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedCapa({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // The letterhead the 8D report needs (c.c. art. 2250), made up.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  // The two brands of the harness, by name.
  for (const [party, brand] of [[alpha, BRAND_ALPHA], [beta, BRAND_BETA]] as const) {
    await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [party, brand.legalName, brand.tradeName, brand.code])
  }
  expect((await one<{ roles: string[] }>('SELECT roles::text[] AS roles FROM "Party" WHERE id = $1', [beta])).roles).toContain('CUSTOMER')
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'quality-desk-th031', 'Quality desk (test)', $3, false)`, [newId(), T, ['home.view', ...OFFICE]])
  officeId = (await addUser(h, tenant, { email: 'quinn.quality.th031@example.com', role: 'quality-desk-th031' })).id
  // Brand Beta's own complaint, logged by the office.
  const logged = await logComplaint(office(), { companyId: companyA, partyId: beta, channel: 'EMAIL', description: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef })
  betaComplaint = { id: logged.complaint.id, number: logged.complaint.number }
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('T15: an 8D goes to a customer only with that customer’s complaints (B-TH-031, WALL-G06)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const betaMarkers = () => [...fixtureMarkers(BRAND_BETA), { label: 'complaint', text: betaComplaint.number }]

  it('an 8D written for brand B is not shared on brand A’s complaint', async () => {
    await editCapa(office(), EIGHT_D, { version: await version(), customerId: beta })
    await makeReport(h.files, office(), EIGHT_D, { language: 'en' })
    expect(await shareHeld()).toBe('OTHER_CUSTOMER')
    expect(await admin('SELECT id FROM "StoredFile" WHERE "recordType" = $1 AND "recordId" = $2 AND "sourceFileId" IS NOT NULL', ['Complaint', CMP1])).toEqual([])
  })

  it('an internal 8D that also answers a brand B complaint is not shared; taken off, its older report is not either', async () => {
    await editCapa(office(), EIGHT_D, { version: await version(), customerId: null })
    await addSources(office(), EIGHT_D, { version: await version(), sources: [{ recordType: 'Complaint', recordId: betaComplaint.id }] })
    await makeReport(h.files, office(), EIGHT_D, { language: 'en' })
    expect(await shareHeld()).toBe('OTHER_CUSTOMERS_COMPLAINTS')
    const source = await one<{ id: string }>('SELECT id FROM "CapaSource" WHERE "capaId" = $1 AND "recordId" = $2', [EIGHT_D, betaComplaint.id])
    await removeSource(office(), EIGHT_D, source.id, { version: await version() })
    // The kept version still prints brand B's complaint number.
    expect(await shareHeld()).toBe('REPORT_OUTDATED')
    // A new version: only brand A's complaint, so it goes — and the shared PDF holds nothing of brand B.
    await makeReport(h.files, office(), EIGHT_D, { language: 'en' })
    const shared = await shareEightD(h.files, office(), CMP1, {})
    expect(shared.shared.made).toBe(true)
    const text = await fileText(shared.shared.fileId)
    expect(text).toContain('SEED-CMP-0001')
    expect(findMarkers(text, betaMarkers())).toEqual([])
  })

  it('an 8D written for brand A prints brand A’s complaints only, even with a brand B complaint linked to the CAPA', async () => {
    await editCapa(office(), EIGHT_D, { version: await version(), customerId: alpha })
    await addSources(office(), EIGHT_D, { version: await version(), sources: [{ recordType: 'Complaint', recordId: betaComplaint.id }] })
    await makeReport(h.files, office(), EIGHT_D, { language: 'en' })
    const shared = await shareEightD(h.files, office(), CMP1, {})
    expect(shared.shared.made).toBe(true)
    const text = await fileText(shared.shared.fileId)
    expect(text).toContain('SEED-CMP-0001')
    expect(text).toContain(BRAND_ALPHA.legalName)
    expect(findMarkers(text, betaMarkers())).toEqual([])
    // The office keeps seeing both on the CAPA itself.
    expect((await admin('SELECT "recordId" FROM "CapaSource" WHERE "capaId" = $1 AND "recordType" = $2 ORDER BY "recordId"', [EIGHT_D, 'Complaint'])).length).toBe(2)
  })
})
