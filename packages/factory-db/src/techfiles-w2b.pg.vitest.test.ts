import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedTechfiles, type TechfilesSeed } from '../seed/techfiles'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Declarations, technical files and labels (W2b-4, schema wave 32/33, B-W2b-218, …_techfiles_labels_w2b_guards) on a database
 * built from the migrations and seeded, through the real login and the scoped client:
 *   - the rows made before the wave (W1's documents SIGNED, its label templates PPE garment labels without a QR code) and the
 *     seed;
 *   - compliance documents: a GENERATED one stays a DRAFT (GATE-PPE-TEXTS), carries its content or sections with their
 *     sources, names the brand as maker only when the brand sells the style under its own name; translations of an original
 *     in another language, CHECKED by a second person before issue; the market by its code; frozen once out of DRAFT;
 *   - label templates: the kind, GPSR contact, QR target and origin claim only while DRAFT;
 *   - batch records, recorded tests, built packs and archived files kept ten years (no removal before, for every login);
 *   - technical files (one live per style, complete only with every Annex III point reviewed or not applicable, items only
 *     while OPEN), risk assessments (signed with rows, one SIGNED per file, rows only while DRAFT), production-control tests,
 *     evidence packs (BUILDING → BUILT or FAILED, files of the pack), artwork (approved by someone other than its author, one
 *     APPROVED per template revision; the floor reads only that one), spoiled labels (append-only, at most the print);
 *   - generated documents of the four new kinds (redefined factory_generated_document_check).
 * The refusals are check_violation (23514) or restrict_violation (23001); their messages are read through raw SQL.
 */

const NS = 'w2b-218-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: TechfilesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), site: key('site:A1'), siteB: key('site:B1'), P1: key('party:P1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (siteId = A.site): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns) as `scope`; returns the new id. */
async function copy(table: string, id: string, changes: Record<string, unknown> = {}, scope: FactoryScope = office()): Promise<string> {
  const newId = (changes.id as string | undefined) ?? randomUUID()
  const count = await run(
    scope,
    `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`,
    JSON.stringify({ ...changes, id: newId }),
    id,
  )
  expect(count).toBe(1)
  return newId
}
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const sha = (): string => randomUUID().replace(/-/g, '').padEnd(64, '0')
/** A made-up stored file of record `recordType` `recordId` (company A). */
async function storedFile(recordType: string, recordId: string, companyId: string | null = A.company): Promise<string> {
  const fileId = randomUUID()
  const template = await one(`SELECT "storeAccountId"::text AS store FROM "StoredFile" WHERE "tenantId" = $1 LIMIT 1`, [a.tenantId])
  await run(
    office(),
    `INSERT INTO "StoredFile" (id, "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, "availableAt", visibility)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'DOCUMENT', 'test.pdf', 'application/pdf', 1024, $5, $6::uuid, $7, 'AVAILABLE', now(), ARRAY['OFFICE']::"FileAudience"[])`,
    fileId,
    companyId,
    recordType,
    recordId,
    sha(),
    template.store,
    `t/${a.tenantId}/test/${fileId}`,
  )
  return fileId
}

beforeAll(async () => {
  db = await migratedDatabase('techfilesw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedTechfiles({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the rows made before the wave and the seed', () => {
  it('leaves W1 documents SIGNED and W1 label templates PPE garment labels without a QR code, and seeds the wave', async () => {
    const older = await one(
      `SELECT (SELECT count(*) FROM "ComplianceDocument" WHERE "tenantId" = $1 AND number = 'SEED-DOC-0001' AND origin = 'SIGNED' AND content IS NULL AND "translationOfId" IS NULL)::int AS docs,
              (SELECT count(*) FROM "LabelTemplate" WHERE "tenantId" = $1 AND code IN ('SEED-LBL-JKT-01', 'SEED-LBL-JKT-02') AND kind = 'PPE_GARMENT' AND "qrTarget" = 'NONE')::int AS labels`,
      [a.tenantId],
    )
    expect(older).toEqual({ docs: 1, labels: 2 })
    const counts = await one(
      `SELECT (SELECT count(*) FROM "ComplianceDocument" WHERE "tenantId" = $1 AND origin = 'GENERATED' AND status = 'DRAFT')::int AS generated,
              (SELECT count(*) FROM "ComplianceDocumentBatch" WHERE "tenantId" = $1)::int AS batches,
              (SELECT string_agg(status::text, ',' ORDER BY number) FROM "TechnicalFile" WHERE "tenantId" = $1) AS files,
              (SELECT count(*) FROM "TechnicalFileItem" WHERE "tenantId" = $1)::int AS items,
              (SELECT count(*) FROM "ProductionControlTest" WHERE "tenantId" = $1 AND result IS NOT NULL)::int AS recorded,
              (SELECT string_agg(status::text, ',' ORDER BY number) FROM "EvidencePack" WHERE "tenantId" = $1) AS packs,
              (SELECT string_agg(status::text, ',' ORDER BY "versionNo") FROM "LabelArtworkVersion" WHERE "tenantId" = $1) AS artwork,
              (SELECT count(*) FROM "GarmentLabelSpoil" WHERE "tenantId" = $1)::int AS spoiled,
              (SELECT count(*) FROM "NumberSeries" WHERE "tenantId" = $1 AND kind IN ('TECHNICAL_FILE', 'EVIDENCE_PACK'))::int AS series`,
      [a.tenantId],
    )
    expect(counts).toEqual({
      generated: 3,
      batches: 4,
      files: 'ARCHIVED,OPEN,COMPLETE',
      items: 22,
      recorded: 2,
      packs: 'BUILDING,BUILT,FAILED,BUILT',
      artwork: 'RETIRED,APPROVED,DRAFT',
      spoiled: 2,
      series: 4,
    })
  })
})

describe('compliance documents', () => {
  it('keeps a generated document a DRAFT until GATE-PPE-TEXTS; it may be withdrawn', async () => {
    await expect(update(office(), 'ComplianceDocument', s.documentIds.docIt2, `status = 'ISSUED', "issuedAt" = now()`)).rejects.toThrow(/stays a DRAFT \(or is withdrawn\) until a PPE consultant has checked the generated texts \(GATE-PPE-TEXTS\)/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 90, status: 'ISSUED', issuedAt: new Date().toISOString() })).rejects.toThrow(/GATE-PPE-TEXTS/)
    await expect(update(office(), 'ComplianceDocument', s.documentIds.docDe1, `origin = 'GENERATED'`)).rejects.toThrow(/was SIGNED when made; that never changes/)
    const withdrawn = await copy('ComplianceDocument', s.documentIds.docIt2, { revision: 91 })
    expect(await update(office(), 'ComplianceDocument', withdrawn, `status = 'WITHDRAWN'`)).toBe(1)
  })

  it('keeps one generated draft beside the signed document of the same style revision, kind and language (the origin is in the key)', async () => {
    const pair = await admin(
      `SELECT origin::text AS origin, status::text AS status FROM "ComplianceDocument"
        WHERE "styleId" = (SELECT "styleId" FROM "ComplianceDocument" WHERE id = $1) AND kind = 'DECLARATION_OF_CONFORMITY' AND language = 'it' AND revision = 1
        ORDER BY origin`,
      [s.documentIds.docIt1],
    )
    expect(pair).toEqual([{ origin: 'GENERATED', status: 'DRAFT' }, { origin: 'SIGNED', status: 'ISSUED' }])
    await expect(copy('ComplianceDocument', s.documentIds.docIt2)).rejects.toThrow(/ComplianceDocument_tenantId_styleId_kind_language_revision__key|unique/i)
  })

  it('carries a generated document\'s content or sections, each value with its source, and only on its kind', async () => {
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 92, content: null })).rejects.toThrow(/carries what it was generated from/)
    await expect(copy('ComplianceDocument', s.documentIds.infoIt1, { revision: 92, sections: null })).rejects.toThrow(/carries what it was generated from/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 92, content: { points: [] } })).rejects.toThrow(/1 to 30 Annex IX points/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 92, content: { points: [{ point: '1', text: 'x' }] } })).rejects.toThrow(/where its value came from/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 92, content: { points: [{ point: '10', text: 'x', source: { kind: 'TYPED' } }] } })).rejects.toThrow(/names its point/)
    const twice = { points: [{ point: '1', text: 'a', source: { kind: 'TYPED' } }, { point: '1', text: 'b', source: { kind: 'TYPED' } }] }
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 92, content: twice })).rejects.toThrow(/point 1 is given twice/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 92, content: { points: [{ point: '1', text: 'a', source: { kind: 'CERTIFICATE', recordId: 'x' } }] } })).rejects.toThrow(/where its value came from/)
    await expect(copy('ComplianceDocument', s.documentIds.infoIt1, { revision: 92, sections: { sections: [{ key: 'Use', text: 'a', source: { kind: 'TYPED' } }] } })).rejects.toThrow(/each section names its key/)
    await expect(copy('ComplianceDocument', s.documentIds.infoIt1, { revision: 92, sections: { sections: [{ key: 'use', text: 'a', source: { kind: 'TYPED' } }], spareProtectors: [{ level: '2' }] } })).rejects.toThrow(/each spare protector names its model/)
    await expect(copy('ComplianceDocument', s.documentIds.infoIt1, { revision: 92, sections: { sections: 'none' } })).rejects.toThrow(/1 to 60 Annex II 1.4 sections/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt1, { revision: 92, status: 'DRAFT', issuedAt: null, sections: { sections: [{ key: 'use', text: 'a', source: { kind: 'TYPED' } }] } })).rejects.toThrow(/only the user information has Annex II 1.4 sections/)
    // A signed document may carry its content too (typed values); a well-formed content passes.
    expect(await copy('ComplianceDocument', s.documentIds.docIt2, { revision: 93, content: { points: [{ point: '7.1', text: 'Organismo notificato 0000', source: { kind: 'NOTIFIED_BODY', recordType: 'NotifiedBody' } }] } })).toMatch(/-/)
  })

  it('names the brand as the maker of a generated document only when the brand sells the style under its own name (Owner 11-09)', async () => {
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 94, makerPartyId: null })).rejects.toThrow(/names as its maker the brand that sells the style under its own name/)
    // The brand sells a copy of the style under OUR name: our company is the maker.
    const style = await one(`SELECT id::text AS id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [a.tenantId])
    const ours = await copy('Style', style.id as string, { code: tag('T-STY'), soldUnderOurName: true, status: 'DRAFT' })
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { styleId: ours, revision: 1, makerPartyId: A.P1 })).rejects.toThrow(/names as its maker the brand/)
    expect(await copy('ComplianceDocument', s.documentIds.docIt2, { styleId: ours, revision: 1, makerPartyId: null })).toMatch(/-/)
    // W1's signed documents keep their own maker.
    expect(await copy('ComplianceDocument', s.documentIds.docIt1, { styleId: ours, revision: 2, status: 'DRAFT', issuedAt: null, makerPartyId: A.P1 })).toMatch(/-/)
  })

  it('translates an original of the same style and kind in another language, checked by a second person before issue', async () => {
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'it', revision: 95, status: 'DRAFT', issuedAt: null })).rejects.toThrow(/translates an original \(not a translation\) of the same style and kind in another language/)
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', translationOfId: s.documentIds.docDe1, status: 'DRAFT', issuedAt: null })).rejects.toThrow(/translates an original/)
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', translationOfId: s.documentIds.infoIt1, status: 'DRAFT', issuedAt: null })).rejects.toThrow(/foreign key|translates an original/i)
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', translationStatus: null, status: 'DRAFT', issuedAt: null, translationCheckedAt: null, translationCheckedById: null })).rejects.toThrow(/a translation state exactly when it translates another document/)
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', translationCheckedAt: null })).rejects.toThrow(/CHECKED exactly with when and by whom/)
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', translationStatus: 'IN_TRANSLATION', translationCheckedAt: null, translationCheckedById: null })).rejects.toThrow(/issued only once a person has CHECKED it/)
    await expect(copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', translationCheckedById: a.actorId })).rejects.toThrow(/checked by a person other than its author/)
    // A draft French translation: checked, then its words change only with the check undone; issued once checked.
    const fr = await copy('ComplianceDocument', s.documentIds.docDe1, { language: 'fr', number: null, status: 'DRAFT', issuedAt: null, translationStatus: 'IN_TRANSLATION', translationCheckedAt: null, translationCheckedById: null, marketCode: 'FR' })
    expect(await update(office(), 'ComplianceDocument', fr, `"translationStatus" = 'CHECKED', "translationCheckedAt" = now(), "translationCheckedById" = $2::uuid`, s.checkerId)).toBe(1)
    await expect(update(office(), 'ComplianceDocument', fr, `"productIdentification" = 'Veste moto en cuir SEED-JKT-02'`)).rejects.toThrow(/is CHECKED; its words change only with its check undone/)
    expect(await update(office(), 'ComplianceDocument', fr, `"translationStatus" = 'DRAFT', "translationCheckedAt" = NULL, "translationCheckedById" = NULL, "productIdentification" = 'Veste moto en cuir SEED-JKT-02'`)).toBe(1)
    expect(await update(office(), 'ComplianceDocument', fr, `"translationStatus" = 'CHECKED', "translationCheckedAt" = now(), "translationCheckedById" = $2::uuid`, s.checkerId)).toBe(1)
    expect(await update(office(), 'ComplianceDocument', fr, `status = 'ISSUED', "issuedAt" = now()`)).toBe(1)
    await expect(update(office(), 'ComplianceDocument', fr, `"marketCode" = 'DE'`)).rejects.toThrow(/is ISSUED; its content, sections, translation and market change no more/)
    // An original with translations is not removed while they name it.
    const it2 = await copy('ComplianceDocument', s.documentIds.docIt1, { revision: 96, status: 'DRAFT', issuedAt: null, number: null })
    const de2 = await copy('ComplianceDocument', s.documentIds.docDe1, { revision: 96, translationOfId: it2, status: 'DRAFT', issuedAt: null, number: null })
    await expect(remove(office(), 'ComplianceDocument', it2)).rejects.toThrow(/permission denied|foreign key/i)
    await expect(admin(`DELETE FROM "ComplianceDocument" WHERE id = $1`, [it2])).rejects.toThrow(/foreign key/i)
    expect(de2).toMatch(/-/)
  })

  it('names a market of the tenant by its code', async () => {
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 97, marketCode: 'ZZ' })).rejects.toThrow(/names a market of the tenant by its code/)
    await expect(copy('ComplianceDocument', s.documentIds.docIt2, { revision: 97, marketCode: 'de' })).rejects.toThrow(/names a market of the tenant by its code/)
    expect(await copy('ComplianceDocument', s.documentIds.docIt2, { revision: 97, marketCode: 'ES' })).toMatch(/-/)
  })
})

describe('label templates', () => {
  it('sets the kind, GPSR contact, QR target and origin claim while DRAFT, then keeps them', async () => {
    await expect(update(office(), 'LabelTemplate', s.templateIds.jacket, `kind = 'PACKAGING'`)).rejects.toThrow(/is ACTIVE; its kind, GPSR contact, QR target and origin claim change no more/)
    await expect(update(office(), 'LabelTemplate', s.templateIds.care, `"originClaimKey" = 'made in italy'`)).rejects.toThrow(/origin claim by a phrase key/)
    await expect(update(office(), 'LabelTemplate', s.templateIds.care, `"gpsrContact" = repeat('x', 501)`)).rejects.toThrow(/GPSR contact of 1 to 500 characters/)
    expect(await update(office(), 'LabelTemplate', s.templateIds.care, `kind = 'PACKAGING', "qrTarget" = 'NONE'`)).toBe(1)
    expect(await update(office(), 'LabelTemplate', s.templateIds.care, `status = 'ACTIVE'`)).toBe(1)
    await expect(update(office(), 'LabelTemplate', s.templateIds.care, `"qrTarget" = 'STYLE_DOC'`)).rejects.toThrow(/is ACTIVE/)
    // The floor reads the new columns with the template (label print).
    const rows = await sql(floor(), `SELECT kind::text AS kind, "qrTarget"::text AS qr FROM "LabelTemplate" WHERE id = $1::uuid`, s.templateIds.glove)
    expect(rows).toEqual([{ kind: 'GLOVE_MARKING', qr: 'STYLE_DOC' }])
  })
})

describe('which revision went with which batch', () => {
  it('records an issued document with a batch once, keeps it ten years and never changes it', async () => {
    const legacy = s.batchIds.legacy
    await expect(copy('ComplianceDocumentBatch', legacy, { documentId: s.documentIds.docIt2, batchNumber: tag('T-BT') })).rejects.toThrow(/names an ISSUED document \(this one is DRAFT\)/)
    await expect(copy('ComplianceDocumentBatch', s.batchIds.made, { batchNumber: tag('T-BT') })).rejects.toThrow(/carries its work order's batch number/)
    await expect(copy('ComplianceDocumentBatch', s.batchIds.made, { siteId: null, batchNumber: tag('T-BT') })).rejects.toThrow(/a work order with its site, or neither/)
    await expect(copy('ComplianceDocumentBatch', legacy, { batchNumber: tag('T-BT'), shipmentId: randomUUID() })).rejects.toThrow(/names a shipment of its company/)
    await expect(copy('ComplianceDocumentBatch', legacy, { batchNumber: tag('T-BT'), retainUntil: '2030-01-01' })).rejects.toThrow(/kept at least ten years after it was recorded/)
    await expect(copy('ComplianceDocumentBatch', legacy, { batchNumber: '' })).rejects.toThrow(/names its batch number/)
    await expect(copy('ComplianceDocumentBatch', legacy)).rejects.toThrow(/ComplianceDocumentBatch_one_without_shipment|unique/i)
    await expect(update(office(), 'ComplianceDocumentBatch', legacy, `"batchNumber" = 'OTHER'`)).rejects.toThrow(/is written once; only its note and a later keep-until day change/)
    await expect(update(office(), 'ComplianceDocumentBatch', legacy, `"retainUntil" = "retainUntil" - 1`)).rejects.toThrow(/that day never moves earlier/)
    expect(await update(office(), 'ComplianceDocumentBatch', legacy, `"retainUntil" = "retainUntil" + 365, note = 'Test: on legal hold.'`)).toBe(1)
    await expect(remove(office(), 'ComplianceDocumentBatch', legacy)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "ComplianceDocumentBatch" WHERE id = $1`, [legacy])).rejects.toThrow(/is kept until .* it is not removed before/)
    await expect(admin(`TRUNCATE "ComplianceDocumentBatch"`)).rejects.toThrow(/TRUNCATE on "ComplianceDocumentBatch" is refused/)
    // Ten years after: the owner's purge may remove it.
    const old = await copy('ComplianceDocumentBatch', legacy, { batchNumber: tag('T-BT'), createdAt: '2010-01-04T10:00:00.000Z', retainUntil: '2020-01-04' })
    expect((await db.admin.query(`DELETE FROM "ComplianceDocumentBatch" WHERE id = $1`, [old])).rowCount).toBe(1)
  })
})

describe('technical files', () => {
  it('keeps one live file per style, names a covering certificate and keeps the number', async () => {
    await expect(copy('TechnicalFile', s.technicalFileIds.open, { number: tag('T-TF') })).rejects.toThrow(/TechnicalFile_one_live_per_style|unique/i)
    const certificateB = randomUUID()
    expect(
      await run(
        office(),
        `INSERT INTO "Certificate" (id, "companyId", standard, number, "notifiedBodyName", "notifiedBodyNumber", "validFrom", "validTo") VALUES ($1::uuid, $3::uuid, 'EN 17092-4:2020', $2, 'Test body', '0000', '2026-01-01', '2030-12-31')`,
        certificateB,
        tag('T-CERT'),
        A.company,
      ),
    ).toBe(1)
    await expect(update(office(), 'TechnicalFile', s.technicalFileIds.open, `"certificateId" = $2::uuid`, certificateB)).rejects.toThrow(/names a certificate that covers its style/)
    await expect(update(office(), 'TechnicalFile', s.technicalFileIds.open, `number = 'TF-9999'`)).rejects.toThrow(/its number .* never changes/)
    await expect(update(office(), 'TechnicalFile', s.technicalFileIds.open, `"companyId" = $2::uuid`, A.companyB)).rejects.toThrow(/the company, style and creation of technical file .* never change/)
  })

  it('completes a file only with every Annex III point reviewed or not applicable, and its items change only while OPEN', async () => {
    const open = s.technicalFileIds.open
    await expect(update(office(), 'TechnicalFile', open, `status = 'COMPLETE', "completedAt" = now(), "completedById" = $2::uuid`, a.actorId)).rejects.toThrow(/complete only when every item is reviewed or not applicable \(point B_RISK_ASSESSMENT has one LINKED\)/)
    await expect(update(office(), 'TechnicalFile', open, `status = 'COMPLETE'`)).rejects.toThrow(/COMPLETE with when and by whom/)
    // The complete file: its items are frozen until it is reopened.
    const complete = s.technicalFileIds.complete
    const item = await one(`SELECT id::text AS id FROM "TechnicalFileItem" WHERE "technicalFileId" = $1 AND point = 'A_DESCRIPTION'`, [complete])
    await expect(update(office(), 'TechnicalFileItem', item.id as string, `note = 'Test'`)).rejects.toThrow(/is COMPLETE; its evidence changes only while it is OPEN/)
    await expect(remove(office(), 'TechnicalFileItem', item.id as string)).rejects.toThrow(/is COMPLETE; its evidence changes only while it is OPEN/)
    await expect(copy('TechnicalFileItem', item.id as string, { seq: 2 })).rejects.toThrow(/is COMPLETE/)
    expect(await update(office(), 'TechnicalFile', complete, `status = 'OPEN', "completedAt" = NULL, "completedById" = NULL`)).toBe(1)
    expect(await remove(office(), 'TechnicalFileItem', item.id as string)).toBe(1)
    await expect(update(office(), 'TechnicalFile', complete, `status = 'COMPLETE', "completedAt" = now(), "completedById" = $2::uuid`, a.actorId)).rejects.toThrow(/\(12 of 13\)/)
    const restored = await copy('TechnicalFileItem', s.itemIds.description, { technicalFileId: complete, point: 'A_DESCRIPTION', seq: 1 })
    expect(restored).toMatch(/-/)
    expect(await update(office(), 'TechnicalFile', complete, `status = 'COMPLETE', "completedAt" = now(), "completedById" = $2::uuid`, a.actorId)).toBe(1)
  })

  it('checks an item\'s state and evidence', async () => {
    const base = s.itemIds.missing
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'LINKED' })).rejects.toThrow(/is LINKED \(MISSING: no evidence/)
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'REVIEWED', recordType: 'Certificate', recordId: randomUUID() })).rejects.toThrow(/is REVIEWED/)
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'LINKED', recordType: 'Certificate', recordId: randomUUID(), fileId: s.printId })).rejects.toThrow(/foreign key|is LINKED/i)
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'LINKED', recordType: 'certificate', recordId: randomUUID() })).rejects.toThrow(/by its model name/)
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'LINKED', recordType: 'Certificate' })).rejects.toThrow(/by its model name .* and id together/)
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'NOT_APPLICABLE', reviewedAt: new Date().toISOString(), reviewedById: a.actorId })).rejects.toThrow(/says why its point does not apply/)
    await expect(copy('TechnicalFileItem', base, { seq: 0 })).rejects.toThrow(/a place of 1 or more/)
    const fileB = await storedFile('TechnicalFile', s.technicalFileIds.open, A.companyB)
    await expect(copy('TechnicalFileItem', base, { seq: 2, state: 'LINKED', fileId: fileB })).rejects.toThrow(/links a file of its technical file's company/)
    await expect(update(office(), 'TechnicalFileItem', base, `point = 'C_REQUIREMENTS'`)).rejects.toThrow(/the technical file, point and creation of item .* never change/)
    expect(await update(office(), 'TechnicalFileItem', base, `state = 'LINKED', "recordType" = 'ProductionControlTest', "recordId" = $2::uuid`, s.testIds.passed)).toBe(1)
    expect(await update(office(), 'TechnicalFileItem', base, `state = 'REVIEWED', "reviewedAt" = now(), "reviewedById" = $2::uuid`, a.actorId)).toBe(1)
  })

  it('archives a file with why, keeps it ten years frozen, never removed before', async () => {
    const file = await copy('TechnicalFile', s.technicalFileIds.archived, { number: tag('T-TF'), status: 'OPEN', archivedAt: null, archivedById: null, archiveReason: null, retainUntil: null })
    await expect(update(office(), 'TechnicalFile', file, `status = 'ARCHIVED', "archivedAt" = now(), "retainUntil" = current_date + 4000`)).rejects.toThrow(/says why it was archived in words/)
    await expect(update(office(), 'TechnicalFile', file, `status = 'ARCHIVED', "archivedAt" = now(), "archiveReason" = 'Test: left the market.', "retainUntil" = current_date + 365`)).rejects.toThrow(/kept at least ten years after it was archived/)
    await expect(update(office(), 'TechnicalFile', file, `status = 'ARCHIVED', "archivedAt" = now(), "archiveReason" = 'Test: left the market.'`)).rejects.toThrow(/ARCHIVED exactly with when, why and how long it is kept/)
    expect(await update(office(), 'TechnicalFile', file, `status = 'ARCHIVED', "archivedAt" = now(), "archiveReason" = 'Test: left the market.', "retainUntil" = (current_date + interval '10 years 1 day')::date`)).toBe(1)
    await expect(update(office(), 'TechnicalFile', file, `"keeperId" = $2::uuid`, a.actorId)).rejects.toThrow(/is ARCHIVED; it changes no more but its note and a later keep-until day/)
    await expect(update(office(), 'TechnicalFile', file, `status = 'OPEN', "archivedAt" = NULL, "archiveReason" = NULL, "retainUntil" = NULL`)).rejects.toThrow(/ARCHIVED; it changes no more/)
    await expect(update(office(), 'TechnicalFile', file, `"retainUntil" = "retainUntil" - 1`)).rejects.toThrow(/never moves earlier/)
    expect(await update(office(), 'TechnicalFile', file, `"retainUntil" = "retainUntil" + 1, note = 'Test: legal hold.'`)).toBe(1)
    await expect(remove(office(), 'TechnicalFile', file)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "TechnicalFile" WHERE id = $1`, [file])).rejects.toThrow(/removed only once archived and kept ten years/)
    await expect(admin(`DELETE FROM "TechnicalFile" WHERE id = $1`, [s.technicalFileIds.open])).rejects.toThrow(/is OPEN .* removed only once archived/)
  })
})

describe('risk assessments', () => {
  it('signs a draft with rows, one SIGNED per file, then frozen with its rows; a draft may be removed', async () => {
    const draft = s.assessmentIds.draft
    const sign = (assessmentId: string) => update(office(), 'ProductRiskAssessment', assessmentId, `status = 'SIGNED', "signedAt" = now(), "signedById" = $2::uuid, "signedByName" = 'Test Signer'`, a.actorId)
    await expect(copy('ProductRiskAssessment', s.assessmentIds.signed, { technicalFileId: s.technicalFileIds.archived, revision: 50 })).rejects.toThrow(/made as a DRAFT and signed once its rows are written/)
    await expect(update(office(), 'ProductRiskAssessment', s.assessmentIds.signed, `"classReasoning" = 'Changed'`)).rejects.toThrow(/is SIGNED; it changes no more/)
    await expect(update(office(), 'ProductRiskAssessment', s.assessmentIds.signed, `status = 'SUPERSEDED'`)).rejects.toThrow(/SUPERSEDED exactly with when/)
    await expect(update(office(), 'ProductRiskAssessment', s.assessmentIds.signed, `status = 'DRAFT', "signedAt" = NULL, "signedById" = NULL, "signedByName" = NULL, "signedByFunction" = NULL`)).rejects.toThrow(/cannot move from SIGNED to DRAFT/)
    // Rows of a signed assessment are frozen.
    await expect(update(office(), 'ProductRiskRow', s.riskRowIds.signedRow, `control = 'Changed'`)).rejects.toThrow(/is SIGNED; its rows change no more/)
    await expect(remove(office(), 'ProductRiskRow', s.riskRowIds.signedRow)).rejects.toThrow(/is SIGNED; its rows change no more/)
    await expect(copy('ProductRiskRow', s.riskRowIds.signedRow, { seq: 9 })).rejects.toThrow(/is SIGNED/)
    // One SIGNED per file: revision 1 is superseded before revision 2 is signed.
    await expect(sign(draft)).rejects.toThrow(/ProductRiskAssessment_one_signed_per_file|unique/i)
    expect(await update(office(), 'ProductRiskAssessment', s.assessmentIds.signed, `status = 'SUPERSEDED', "supersededAt" = now()`)).toBe(1)
    const empty = await copy('ProductRiskAssessment', draft, { revision: 51 })
    await expect(sign(empty)).rejects.toThrow(/signed with at least one hazard/)
    await expect(update(office(), 'ProductRiskAssessment', draft, `status = 'SIGNED'`)).rejects.toThrow(/signed \(when, by whom, the typed name\) exactly from SIGNED on/)
    expect(await sign(draft)).toBe(1)
    await expect(remove(office(), 'ProductRiskAssessment', draft)).rejects.toThrow(/is SIGNED; it is kept, never removed/)
    expect(await remove(office(), 'ProductRiskAssessment', empty)).toBe(1)
  })

  it('checks a row\'s hazard, zone and words', async () => {
    const draft = await copy('ProductRiskAssessment', s.assessmentIds.signed, { revision: 60, status: 'DRAFT', signedAt: null, signedById: null, signedByName: null, signedByFunction: null, supersededAt: null })
    const row = (changes: Record<string, unknown>) => copy('ProductRiskRow', s.riskRowIds.signedRow, { assessmentId: draft, seq: 1, ...changes })
    await expect(row({ hazard: 'OTHER', hazardNote: null })).rejects.toThrow(/names an OTHER hazard in words/)
    await expect(row({ garmentZone: 'Left Shoulder' })).rejects.toThrow(/zone code of the garment zone map/)
    await expect(row({ intendedUse: '' })).rejects.toThrow(/says the intended use and how the hazard is controlled/)
    await expect(row({ standardClause: '' })).rejects.toThrow(/standard clause of 1 to 100 characters/)
    const ok = await row({ hazard: 'OTHER', hazardNote: 'Test: entanglement of a loose strap.' })
    await expect(update(office(), 'ProductRiskRow', ok, `"assessmentId" = $2::uuid, seq = 77`, s.assessmentIds.signed)).rejects.toThrow(/its rows change no more/)
    expect(await remove(office(), 'ProductRiskRow', ok)).toBe(1)
  })
})

describe('production-control tests', () => {
  it('records a test once with its day, tester and keep-until, then keeps it ten years', async () => {
    const due = s.testIds.due
    await expect(update(office(), 'ProductionControlTest', due, `result = 'PASS', "testedOn" = current_date, "testedBy" = 'Test lab'`)).rejects.toThrow(/kept at least ten years after its test day/)
    await expect(update(office(), 'ProductionControlTest', due, `result = 'PASS', "testedOn" = current_date, "testedBy" = 'Test lab', "retainUntil" = current_date + 365`)).rejects.toThrow(/kept at least ten years after its test day/)
    await expect(update(office(), 'ProductionControlTest', due, `result = 'PASS', "testedOn" = current_date + 3, "testedBy" = 'Test lab', "retainUntil" = current_date + 7000`)).rejects.toThrow(/tested on a day that has come/)
    await expect(update(office(), 'ProductionControlTest', due, `result = 'FAIL', "testedOn" = current_date - 1, "testedBy" = 'Test lab', "retainUntil" = current_date + 7000`)).rejects.toThrow(/failed: its result note says what failed/)
    await expect(update(office(), 'ProductionControlTest', due, `result = 'PASS'`)).rejects.toThrow(/recorded with its test day and who tested it/)
    await expect(update(office(), 'ProductionControlTest', due, `"testedBy" = 'Test lab'`)).rejects.toThrow(/is due: it has no test day, tester/)
    expect(await update(office(), 'ProductionControlTest', due, `result = 'PASS', "testedOn" = current_date - 1, "testedBy" = 'Test lab', "retainUntil" = (current_date - 1 + interval '10 years')::date`)).toBe(1)
    await expect(update(office(), 'ProductionControlTest', due, `result = 'FAIL', "resultNote" = 'Changed my mind'`)).rejects.toThrow(/is recorded \(PASS\); it changes no more but its note and a later keep-until day/)
    await expect(update(office(), 'ProductionControlTest', due, `"retainUntil" = "retainUntil" - 1`)).rejects.toThrow(/never moves earlier/)
    expect(await update(office(), 'ProductionControlTest', due, `note = 'Test: seen by the notified body.', "retainUntil" = "retainUntil" + 30`)).toBe(1)
    await expect(remove(office(), 'ProductionControlTest', due)).rejects.toThrow(/is recorded and kept until .* it is not removed before/)
    await expect(admin(`DELETE FROM "ProductionControlTest" WHERE id = $1`, [s.testIds.passed])).rejects.toThrow(/is recorded and kept until/)
  })

  it('names a work order with its site or a batch typed, an OTHER test by name; a due test may be removed', async () => {
    const other = s.testIds.other
    await expect(copy('ProductionControlTest', other, { batchNumber: 'SEED-BT-X' })).rejects.toThrow(/a work order \(its batch\) or a batch number typed, not both/)
    await expect(copy('ProductionControlTest', other, { siteId: null })).rejects.toThrow(/a work order with its site, or neither/)
    await expect(copy('ProductionControlTest', other, { testName: null })).rejects.toThrow(/names an OTHER test/)
    await expect(copy('ProductionControlTest', other, { companyId: A.companyB })).rejects.toThrow(/foreign key|its style's company/i)
    const fileB = await storedFile('ProductionControlTest', other, A.companyB)
    await expect(copy('ProductionControlTest', s.testIds.passed, { labReportFileId: fileB })).rejects.toThrow(/a lab report of its company/)
    const extra = await copy('ProductionControlTest', other)
    expect(await remove(office(), 'ProductionControlTest', extra)).toBe(1)
  })
})

describe('evidence packs', () => {
  it('starts BUILDING, then BUILT with contents, fingerprint and its own files, or FAILED; then frozen and kept', async () => {
    await expect(copy('EvidencePack', s.packIds.built, { number: tag('T-EP') })).rejects.toThrow(/made BUILDING when its build starts/)
    await expect(copy('EvidencePack', s.packIds.building, { number: tag('T-EP'), shipmentId: randomUUID() })).rejects.toThrow(/from a technical file or from a shipment, exactly one/)
    await expect(copy('EvidencePack', s.packIds.building, { number: tag('T-EP'), purpose: 'SHIPMENT' })).rejects.toThrow(/goes with a shipment, so it is built from that shipment/)
    await expect(copy('EvidencePack', s.packIds.building, { number: tag('T-EP'), language: 'DE' })).rejects.toThrow(/in the recipient's language/)
    await expect(copy('EvidencePack', s.packIds.building, { number: tag('T-EP'), scope: [] })).rejects.toThrow(/keeps what was asked as a JSON object/)
    await expect(copy('EvidencePack', s.packIds.building, { number: null })).rejects.toThrow(/a new evidence pack has its number/)
    const packId = await copy('EvidencePack', s.packIds.building, { number: tag('T-EP') })
    const own = await storedFile('EvidencePack', packId)
    const other = await storedFile('TechnicalFile', s.technicalFileIds.open)
    const built = (set: string, ...values: unknown[]) => update(office(), 'EvidencePack', packId, set, ...values)
    const contents = JSON.stringify([{ title: 'DoC', sha256: sha(), recordType: 'ComplianceDocument', recordId: s.documentIds.docIt1 }])
    await expect(built(`status = 'BUILT', fingerprint = $2, "fileId" = $3::uuid, "builtAt" = now(), "retainUntil" = current_date + 4000`, sha(), own)).rejects.toThrow(/is BUILT with its contents/)
    await expect(built(`status = 'BUILT', contents = '[{"title": "DoC"}]'::jsonb, fingerprint = $2, "fileId" = $3::uuid, "builtAt" = now(), "retainUntil" = current_date + 4000`, sha(), own)).rejects.toThrow(/each document of it has its title .* and SHA-256/)
    await expect(built(`status = 'BUILT', contents = $2::jsonb, fingerprint = $3, "fileId" = $4::uuid, "builtAt" = now(), "retainUntil" = current_date + 4000`, contents, sha(), other)).rejects.toThrow(/are files of the pack itself/)
    await expect(built(`status = 'BUILT', contents = $2::jsonb, fingerprint = $3, "fileId" = $4::uuid, "builtAt" = now(), "retainUntil" = current_date + 30`, contents, sha(), own)).rejects.toThrow(/kept at least ten years after it was built/)
    await expect(built(`status = 'BUILT', contents = $2::jsonb, fingerprint = 'ABC', "fileId" = $3::uuid, "builtAt" = now(), "retainUntil" = current_date + 4000`, contents, own)).rejects.toThrow(/SHA-256 \(lower-case hex\)/)
    await expect(built(`recipient = 'Someone else'`)).rejects.toThrow(/what evidence pack .* is built from and for, and its creation, never change/)
    expect(await built(`status = 'BUILT', contents = $2::jsonb, fingerprint = $3, "fileId" = $4::uuid, "builtAt" = now(), "retainUntil" = current_date + 4000`, contents, sha(), own)).toBe(1)
    await expect(built(`fingerprint = $2`, sha())).rejects.toThrow(/is BUILT; it changes no more but its note and a later keep-until day/)
    await expect(built(`status = 'BUILDING'`)).rejects.toThrow(/cannot move from BUILT to BUILDING/)
    expect(await built(`note = 'Test: sent by link.'`)).toBe(1)
    await expect(remove(office(), 'EvidencePack', packId)).rejects.toThrow(/was built and is kept until/)
    await expect(remove(office(), 'EvidencePack', s.packIds.built)).rejects.toThrow(/was built and is kept until/)
    // A failed pack says why; a failed or a building one may be removed.
    const failing = await copy('EvidencePack', s.packIds.building, { number: tag('T-EP') })
    await expect(update(office(), 'EvidencePack', failing, `status = 'FAILED', "builtAt" = now()`)).rejects.toThrow(/FAILED with why/)
    expect(await update(office(), 'EvidencePack', failing, `status = 'FAILED', "builtAt" = now(), "failureReason" = 'Test: the store did not answer.'`)).toBe(1)
    expect(await remove(office(), 'EvidencePack', failing)).toBe(1)
    const building = await copy('EvidencePack', s.packIds.building, { number: tag('T-EP') })
    expect(await remove(office(), 'EvidencePack', building)).toBe(1)
  })

  it('builds a shipment pack from a shipment of its company', async () => {
    await expect(copy('EvidencePack', s.packIds.building, { number: tag('T-EP'), purpose: 'SHIPMENT', technicalFileId: null, shipmentId: randomUUID() })).rejects.toThrow(/built from a shipment of its company/)
    const shipment = await one(`SELECT "shipmentId"::text AS id FROM "EvidencePack" WHERE id = $1`, [s.packIds.shipment])
    expect(await copy('EvidencePack', s.packIds.building, { number: tag('T-EP'), purpose: 'SHIPMENT', technicalFileId: null, shipmentId: shipment.id })).toMatch(/-/)
  })
})

describe('label artwork', () => {
  it('is approved by a person other than its author, one APPROVED per template revision; the floor reads only that one', async () => {
    const draft = s.artworkIds.draft
    const approve = (artworkId: string, approverId: string) => update(office(), 'LabelArtworkVersion', artworkId, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, approverId)
    await expect(copy('LabelArtworkVersion', s.artworkIds.approved, { templateId: s.templateIds.glove, versionNo: 40 })).rejects.toThrow(/made as a DRAFT and approved by a second person/)
    await expect(approve(draft, a.actorId)).rejects.toThrow(/LabelArtworkVersion_one_approved|unique/i)
    await expect(update(office(), 'LabelArtworkVersion', s.artworkIds.approved, `note = 'Changed'`)).rejects.toThrow(/is APPROVED; it changes no more but its retirement/)
    expect(await sql(floor(), `SELECT "versionNo" AS n FROM "LabelArtworkVersion" ORDER BY "versionNo"`)).toEqual([{ n: 2 }])
    // Retire version 2; version 3 is approved by someone other than its author.
    expect(await update(office(), 'LabelArtworkVersion', s.artworkIds.approved, `status = 'RETIRED', "retiredAt" = now()`)).toBe(1)
    await expect(update(office(), 'LabelArtworkVersion', s.artworkIds.retired, `status = 'APPROVED'`)).rejects.toThrow(/cannot move from RETIRED to APPROVED/)
    await expect(approve(draft, s.designerId)).rejects.toThrow(/approved by a person other than its author/)
    await expect(update(office(), 'LabelArtworkVersion', draft, `status = 'APPROVED'`)).rejects.toThrow(/APPROVED with when and by whom/)
    const noAuthor = await copy('LabelArtworkVersion', draft, { versionNo: 41, authorId: null, createdById: null })
    await expect(approve(noAuthor, a.actorId)).rejects.toThrow(/approved by a person other than its author/)
    expect(await approve(draft, a.actorId)).toBe(1)
    expect(await sql(floor(), `SELECT "versionNo" AS n FROM "LabelArtworkVersion" ORDER BY "versionNo"`)).toEqual([{ n: 3 }])
    await expect(remove(office(), 'LabelArtworkVersion', draft)).rejects.toThrow(/is APPROVED; it is kept, never removed/)
    expect(await remove(office(), 'LabelArtworkVersion', noAuthor)).toBe(1)
  })

  it('takes a proof that is a file of its template, and no artwork on a retired template', async () => {
    const elsewhere = await storedFile('Style', randomUUID())
    await expect(copy('LabelArtworkVersion', s.artworkIds.retired, { versionNo: 43, status: 'DRAFT', approvedAt: null, approvedById: null, retiredAt: null, fileId: elsewhere })).rejects.toThrow(/proof of artwork version .* is a file of its label template/)
    const glove = s.templateIds.glove
    const proof = await storedFile('LabelTemplate', glove)
    expect(await update(office(), 'LabelTemplate', glove, `status = 'RETIRED'`)).toBe(1)
    await expect(copy('LabelArtworkVersion', s.artworkIds.retired, { templateId: glove, versionNo: 1, status: 'DRAFT', approvedAt: null, approvedById: null, retiredAt: null, fileId: proof })).rejects.toThrow(/is RETIRED; it takes no new or approved artwork/)
  })
})

describe('spoiled and returned labels', () => {
  it('is append-only for every login, says why a label spoiled and never exceeds the print', async () => {
    const spoiled = s.spoilIds.spoiled
    await expect(update(office(), 'GarmentLabelSpoil', spoiled, `quantity = 2`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "GarmentLabelSpoil" SET quantity = 2 WHERE id = $1`, [spoiled])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "GarmentLabelSpoil" WHERE id = $1`, [spoiled])).rejects.toThrow(/append-only/)
    await expect(admin(`TRUNCATE "GarmentLabelSpoil"`)).rejects.toThrow(/append-only/)
    await expect(copy('GarmentLabelSpoil', spoiled, { reason: 'x' }, floor())).rejects.toThrow(/say why in words/)
    await expect(copy('GarmentLabelSpoil', spoiled, { quantity: 0 }, floor())).rejects.toThrow(/count 1 or more/)
    await expect(copy('GarmentLabelSpoil', spoiled, { quantity: 2 }, floor())).rejects.toThrow(/gave 3 labels; its spoiled and returned labels are at most that \(4 with these\)/)
    // The floor of another site neither writes nor reads A1's.
    await expect(copy('GarmentLabelSpoil', spoiled, {}, floor(A.siteB))).rejects.toThrow(/row-level security/)
    expect(await sql(floor(A.siteB), `SELECT id FROM "GarmentLabelSpoil"`)).toEqual([])
    expect(await copy('GarmentLabelSpoil', s.spoilIds.returned, { reason: null }, floor())).toMatch(/-/)
    await expect(copy('GarmentLabelSpoil', s.spoilIds.returned, {}, office())).rejects.toThrow(/gave 3 labels/)
    expect((await sql(floor(), `SELECT id FROM "GarmentLabelSpoil"`)).length).toBe(3)
  })
})

describe('generated documents of the new kinds', () => {
  it('ties a compliance pack, an evidence pack, a tech pack and a leaflet to their record\'s company and site', async () => {
    const shipmentPack = await one(`SELECT id::text AS id, "recordId"::text AS shipment FROM "GeneratedDocument" WHERE kind = 'COMPLIANCE_PACK' AND "tenantId" = $1`, [a.tenantId])
    await expect(copy('GeneratedDocument', shipmentPack.id as string, { version: 2, siteId: null })).rejects.toThrow(/of the company and site of its Shipment/)
    await expect(copy('GeneratedDocument', shipmentPack.id as string, { version: 2, kind: 'TECH_PACK' })).rejects.toThrow(/a tech pack a StyleRevision's/)
    const evidence = await one(`SELECT id::text AS id FROM "GeneratedDocument" WHERE kind = 'EVIDENCE_PACK' AND "tenantId" = $1`, [a.tenantId])
    await expect(copy('GeneratedDocument', evidence.id as string, { version: 2, companyId: A.companyB })).rejects.toThrow(/of the company and site of its EvidencePack/)
    // A tech pack of a tenant-wide style's revision: any company of the tenant, a file of the revision.
    const revision = await one(`SELECT r.id::text AS id FROM "StyleRevision" r JOIN "Style" st ON st.id = r."styleId" WHERE st."tenantId" = $1 AND st.code = 'SEED-JKT-02'`, [a.tenantId])
    const techFile = await storedFile('StyleRevision', revision.id as string)
    expect(await copy('GeneratedDocument', evidence.id as string, { recordType: 'StyleRevision', recordId: revision.id, kind: 'TECH_PACK', version: 1, fileId: techFile })).toMatch(/-/)
    // A leaflet of user information, never of a DoC.
    const leafletFile = await storedFile('ComplianceDocument', s.documentIds.infoIt1)
    expect(await copy('GeneratedDocument', evidence.id as string, { recordType: 'ComplianceDocument', recordId: s.documentIds.infoIt1, kind: 'USER_INFORMATION', version: 1, fileId: leafletFile })).toMatch(/-/)
    const docFile = await storedFile('ComplianceDocument', s.documentIds.docIt2)
    await expect(copy('GeneratedDocument', evidence.id as string, { recordType: 'ComplianceDocument', recordId: s.documentIds.docIt2, kind: 'USER_INFORMATION', version: 1, fileId: docFile })).rejects.toThrow(/of kind USER_INFORMATION \(this one is DECLARATION_OF_CONFORMITY\)/)
  })
})
