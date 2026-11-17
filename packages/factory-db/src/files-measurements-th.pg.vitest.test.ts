import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedParties } from '../seed/parties'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Measurement sheets and design files (TH-7, threads schema wave 6/9, B-TH-082; gaps N11, G12; …_files_measurements_th_guards
 * and the generated policy migration), on a database built from the migrations and seeded twice, through the real login and
 * the scoped client:
 *   - the wall (W01, W25): a MEASUREMENTS file is read by a portal only when shared with its record's own party (the WALL-G02
 *     guard refuses any other party); another customer reads none of it; an unshared sheet reaches no portal; never a floor;
 *   - a measurement sheet is a document, an attachment or a photo of one;
 *   - a design file (Illustrator, EPS, Photoshop, ZIP) is download-only: an attachment or a document, never a photo, never a
 *     thumbnail; the type is compared as the files platform does (lower case, without parameters);
 *   - no file is of a type a browser runs or renders as a page (HTML, SVG, scripts).
 * The refusals are check_violation (23514), the wall's permission denied or simply no row.
 */

const NS = 'th-082-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  P3: key('party:P3'),
  officeFile: key('files:office'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const COPY = `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(r) || $1::jsonb FROM "StoredFile" r WHERE r.id = $2::uuid))`

/** A file of party P1's record (a copy of the seeded office document, AVAILABLE) with `extra` columns; answers its id. */
async function newFile(extra: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  const row = { id, recordType: 'Party', recordId: A.P1, storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`, ...extra }
  expect(await run(office(), COPY, JSON.stringify(row), A.officeFile)).toBe(1)
  return id
}
const shareWith = (id: string, partyId: string) =>
  run(office(), `UPDATE "StoredFile" SET visibility = ARRAY['OFFICE', 'PARTNER']::"FileAudience"[], "partyId" = $2::uuid WHERE id = $1::uuid`, id, partyId)
const reads = async (scope: FactoryScope, id: string) => (await sql(scope, `SELECT id FROM "StoredFile" WHERE id = $1::uuid`, id)).length === 1

beforeAll(async () => {
  db = await migratedDatabase('filesmeasurementsth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the wall (W01, W25)', () => {
  it("a measurement sheet reaches only its record's own party, only when shared; another customer never; a floor never", async () => {
    const sheet = await newFile({ category: 'MEASUREMENTS', originalName: 'Seed measurements.pdf' })
    // Not shared: no portal reads it; the office does.
    expect(await reads(office(), sheet)).toBe(true)
    expect(await reads(partner(A.P1), sheet)).toBe(false)
    // Shared with its record's own party (P1): P1 reads it; P3, another customer, reads nothing.
    expect(await shareWith(sheet, A.P1)).toBe(1)
    expect(await reads(partner(A.P1), sheet)).toBe(true)
    expect(await reads(partner(A.P3), sheet)).toBe(false)
    expect((await sql(partner(A.P3), `SELECT id FROM "StoredFile" WHERE category = 'MEASUREMENTS'`)).length).toBe(0)
    // Shared with another customer: refused, at upload and afterwards (the WALL-G02 guard).
    await expect(newFile({ category: 'MEASUREMENTS', visibility: ['OFFICE', 'PARTNER'], partyId: A.P3 })).rejects.toThrow(/never with another/)
    const other = await newFile({ category: 'MEASUREMENTS' })
    await expect(shareWith(other, A.P3)).rejects.toThrow(/never with another/)
    // Never a floor: not shared with one, and the floor role reads none.
    await expect(newFile({ category: 'MEASUREMENTS', companyId: A.companyA, visibility: ['OFFICE', 'FLOOR'], floorSiteId: a.sites[0]!.id })).rejects.toThrow(/never shared with a floor/)
    await expect(run(office(), `UPDATE "StoredFile" SET visibility = ARRAY['OFFICE', 'FLOOR']::"FileAudience"[], "floorSiteId" = $2::uuid WHERE id = $1::uuid`, other, a.sites[0]!.id)).rejects.toThrow(/never shared with a floor/)
    expect(await reads(floor(), sheet)).toBe(false)
    // A file already shared with a floor is not tagged a sheet while it is.
    const floorFile = await newFile({ companyId: A.companyA, visibility: ['OFFICE', 'FLOOR'], floorSiteId: a.sites[0]!.id })
    expect(await reads(floor(), floorFile)).toBe(true)
    await expect(run(office(), `UPDATE "StoredFile" SET category = 'MEASUREMENTS' WHERE id = $1::uuid`, floorFile)).rejects.toThrow(/never shared with a floor/)
  })
})

describe('a measurement sheet (N11)', () => {
  it('is a document, an attachment or a photo of one', async () => {
    expect(await newFile({ category: 'MEASUREMENTS', kind: 'ATTACHMENT' })).toBeTruthy()
    expect(await newFile({ category: 'MEASUREMENTS', kind: 'PHOTO', contentType: 'image/jpeg', originalName: 'Seed sheet photo.jpg' })).toBeTruthy()
    await expect(newFile({ category: 'MEASUREMENTS', kind: 'CERTIFICATE' })).rejects.toThrow(/is a measurement sheet: a document, an attachment or a photo of one, not a CERTIFICATE/)
    await expect(newFile({ category: 'MEASUREMENTS', kind: 'AUDIO', contentType: 'audio/webm' })).rejects.toThrow(/not a AUDIO/)
    // Tagged later, the same rule.
    const certificate = await newFile({ kind: 'CERTIFICATE' })
    await expect(run(office(), `UPDATE "StoredFile" SET category = 'MEASUREMENTS' WHERE id = $1::uuid`, certificate)).rejects.toThrow(/measurement sheet/)
  })
})

describe('design files (G12)', () => {
  it('are download-only: an attachment or a document, never a photo, never a thumbnail', async () => {
    for (const type of ['application/postscript', 'image/vnd.adobe.photoshop', 'application/zip', 'application/illustrator']) {
      expect(await newFile({ kind: 'DOCUMENT', contentType: type, originalName: 'Seed artwork' })).toBeTruthy()
      expect(await newFile({ kind: 'ATTACHMENT', contentType: type, originalName: 'Seed artwork' })).toBeTruthy()
    }
    await expect(newFile({ kind: 'PHOTO', contentType: 'image/vnd.adobe.photoshop', originalName: 'Seed artwork.psd' })).rejects.toThrow(/design file .* never a PHOTO/)
    // Compared as the files platform does: lower case, without parameters.
    await expect(newFile({ kind: 'PHOTO', contentType: 'Image/X-EPS; version=3', originalName: 'Seed artwork.eps' })).rejects.toThrow(/design file/)
    const artwork = await newFile({ kind: 'ATTACHMENT', contentType: 'application/postscript', originalName: 'Seed artwork.ai' })
    await expect(run(office(), `UPDATE "StoredFile" SET "thumbnailKey" = $2, "exifStrippedAt" = now() WHERE id = $1::uuid`, artwork, `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}-thumb`)).rejects.toThrow(/never previewed/)
    // Not vacuous: a photo still takes its thumbnail.
    const photo = await newFile({ kind: 'PHOTO', contentType: 'image/png', originalName: 'Seed photo.png' })
    expect(await run(office(), `UPDATE "StoredFile" SET "thumbnailKey" = $2, "exifStrippedAt" = now() WHERE id = $1::uuid`, photo, `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}-thumb`)).toBe(1)
  })
})

describe('page types', () => {
  it('no file is of a type a browser runs or renders as a page (HTML, SVG, scripts)', async () => {
    for (const [kind, type] of [
      ['ATTACHMENT', 'image/svg+xml'],
      ['PHOTO', 'Image/SVG+XML; charset=utf-8'],
      ['DOCUMENT', 'text/html'],
      ['ATTACHMENT', 'application/xhtml+xml'],
      ['ATTACHMENT', 'application/javascript'],
    ] as const) {
      await expect(newFile({ kind, contentType: type, originalName: 'Seed page' })).rejects.toThrow(/a browser runs or renders as a page/)
    }
    // Not vacuous: an ordinary type is stored.
    expect(await newFile({ kind: 'DOCUMENT', contentType: 'text/csv', originalName: 'Seed list.csv' })).toBeTruthy()
  })
})
