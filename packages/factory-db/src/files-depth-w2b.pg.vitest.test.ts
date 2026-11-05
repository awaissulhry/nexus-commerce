import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFilesDepth, type FilesDepthSeed } from '../seed/files-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * Files in depth (W2b schema wave 18/22, B-W2b-153, …_files_depth_w2b_guards) on a database built from the migrations and
 * seeded, through the real login and the scoped client:
 *   - grants: upload sessions and required-document rules are the office's; a partner reads the markups of its own party
 *     only, and of a file its series, number, superseded, expiry date and thumbnail, never the source of a copy nor the
 *     expiry reminder; the floor reads none of the new tables, and of a file the number, superseded and thumbnail only
 *     (never its series: it makes no versions);
 *   - versions: numbered in their series from the first version, of its record and kind, never of a fiscal archive file,
 *     one new version at a time; superseded once a later version is AVAILABLE; one current version per series at commit;
 *     a superseded version read-only; the content (with the version and the source of a copy) never changes; a version
 *     restored as a copy;
 *   - copies: the same bytes as an available source; the expiry date and its reminder; the thumbnail without location
 *     data, once, while AVAILABLE, never in the legal store;
 *   - upload sessions: born OPEN with no part, for an announced file; parts of their size, each once, only added, only
 *     while the file is announced; COMPLETED with every part; final once ended;
 *   - markups: on the current version of a picture or a PDF (a page exactly on a PDF), named authors, a party only on its
 *     own shared files, a new version only of a picture, one markup per version, append-only for every login;
 *   - required-document rules: a model name and a status value, one active rule per key, kept company.
 * The refusals are check_violation (SQLSTATE 23514) or restrict_violation (23001); their messages are read through raw SQL.
 */

const NS = 'w2b-153-a'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: FilesDepthSeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: key('worker:A1:operator'), siteId: key('site:A1') })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const value = async (text: string, values: unknown[] = []): Promise<unknown> => Object.values((await admin(text, values))[0] ?? {})[0]
/** INSERT a copy of row `id` of `table` with `changes` (the office's role: every column). */
const copyRow = (table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()) =>
  run(
    scope,
    `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`,
    JSON.stringify(changes),
    id,
  )
const update = (table: string, id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const at = '2026-10-28T09:00:00.000Z'
/** A new file from `base` (a fresh id and key, none of the base's version, copy, expiry, thumbnail or scan facts). */
const fresh = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  storageKey: `t/${a.tenantId}/c/${key('company:A')}/2026/${randomUUID()}`,
  seriesId: null,
  versionNo: 1,
  supersededAt: null,
  sourceFileId: null,
  expiresOn: null,
  expiryRemindedAt: null,
  thumbnailKey: null,
  exifStrippedAt: null,
  status: 'AVAILABLE',
  availableAt: at,
  deletedAt: null,
  quarantineReason: null,
  scanStatus: 'NOT_SCANNED',
  scannedAt: null,
  scanEngine: null,
  scanFinding: null,
  version: 1,
  ...changes,
})
const part = (partNumber: number, sizeBytes = 5 * 1_048_576) => ({ partNumber, etag: `"test-${partNumber}"`, sizeBytes })

beforeAll(async () => {
  db = await migratedDatabase('filesdepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seeded = await seedFilesDepth({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the three models of the file: only markups reach a partner, none is personal data', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'files-depth.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['FileMarkup', 'FileUploadSession', 'RequiredDocumentRule'])
    for (const { model, ownership: entry } of models) {
      expect(Object.keys(entry.access).sort(), model.name).toEqual(model.name === 'FileMarkup' ? ['factory_partner_runtime', 'factory_runtime'] : ['factory_runtime'])
    }
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
  })

  it('keeps the new tables from the floor, sessions and rules from the partner, and its markups to its own party', async () => {
    for (const table of ['FileUploadSession', 'FileMarkup', 'RequiredDocumentRule']) await expect(sql(floor(), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    for (const table of ['FileUploadSession', 'RequiredDocumentRule']) await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    expect((await sql(partner(), `SELECT id::text FROM "FileMarkup"`)).map((row) => row.id)).toEqual([seeded.markups.partnerOverlay])
    await expect(run(partner(), `INSERT INTO "FileMarkup" (id) VALUES ($1::uuid)`, randomUUID())).rejects.toThrow(DENIED)
    await expect(run(office(), `UPDATE "FileMarkup" SET note = note WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "FileMarkup" WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "FileUploadSession" WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "RequiredDocumentRule" WHERE false`)).rejects.toThrow(DENIED)
  })

  it('shows a partner the versions, expiry and thumbnails of its files, never the source of a copy or the reminder; the floor no series', async () => {
    const rows = await sql(partner(), `SELECT id::text, "seriesId"::text, "versionNo", "supersededAt", "expiresOn", "thumbnailKey" FROM "StoredFile" ORDER BY "versionNo"`)
    expect(rows.filter((row) => row.id === seeded.files.certificateV2)).toEqual([expect.objectContaining({ seriesId: seeded.files.certificateV1, versionNo: 2, supersededAt: null })])
    expect(rows.find((row) => row.id === seeded.files.certificateV1)?.supersededAt).not.toBeNull()
    for (const column of ['sourceFileId', 'expiryRemindedAt']) await expect(sql(partner(), `SELECT "${column}" FROM "StoredFile"`)).rejects.toThrow(DENIED)
    expect((await sql(floor(), `SELECT "versionNo", "supersededAt", "thumbnailKey", "exifStrippedAt" FROM "StoredFile"`)).length).toBeGreaterThan(0)
    for (const column of ['seriesId', 'sourceFileId', 'expiresOn', 'expiryRemindedAt']) await expect(sql(floor(), `SELECT "${column}" FROM "StoredFile"`)).rejects.toThrow(DENIED)
    await expect(run(floor(), `INSERT INTO "StoredFile" (id, "seriesId") VALUES ($1::uuid, $1::uuid)`, randomUUID())).rejects.toThrow(DENIED)
    // A floor UPDATE keeps every new column as it was (the plant care trigger), whatever the file.
    await expect(run(floor(), `UPDATE "StoredFile" SET "thumbnailKey" = 'x' WHERE id = $1::uuid`, key('files:floor:A1'))).rejects.toThrow(/the floor confirms the upload of its own photos/)
  })

  it('the seed is idempotent: a second run writes nothing new', async () => {
    const counted = async () =>
      admin(
        `SELECT (SELECT count(*) FROM "StoredFile") f, (SELECT count(*) FROM "FileUploadSession") s, (SELECT count(*) FROM "FileMarkup") m, (SELECT count(*) FROM "RequiredDocumentRule") r`,
      )
    const before = await counted()
    await seedFilesDepth({ db: factory, namespace: NS })
    expect(await counted()).toEqual(before)
    expect(before[0]).toMatchObject({ s: '3', m: '3', r: '5' })
  })
})

describe('versions', () => {
  const v1 = () => seeded.files.certificateV1
  const v2 = () => seeded.files.certificateV2
  const v3 = randomUUID()
  const v4 = randomUUID()

  it('numbers a version in its series from the first one, of its record and kind, never a fiscal archive file', async () => {
    await expect(copyRow('StoredFile', v2(), fresh({ seriesId: v1(), versionNo: 4 }))).rejects.toThrow(/the next version of the series is 3, not 4/)
    await expect(copyRow('StoredFile', v2(), fresh({ seriesId: v2(), versionNo: 3 }))).rejects.toThrow(/names a series by its first version, which is not there/)
    await expect(copyRow('StoredFile', v2(), fresh({ seriesId: v1(), versionNo: 3, recordId: key('party:P2') }))).rejects.toThrow(/of its first version's record, company and kind/)
    await expect(copyRow('StoredFile', v2(), fresh({ seriesId: null, versionNo: 2 }))).rejects.toThrow(/a first version \(1\) names no series/)
    const fiscal = key('files:fiscal')
    await expect(
      copyRow('StoredFile', fiscal, fresh({ seriesId: fiscal, versionNo: 2, storageKey: `legal/t/${a.tenantId}/c/${key('company:A')}/2026/${randomUUID()}` })),
    ).rejects.toThrow(/a fiscal archive file has no later version/)
  })

  it('takes one new version at a time, and supersedes only once a later version is available', async () => {
    expect(await copyRow('StoredFile', v2(), fresh({ id: v3, seriesId: v1(), versionNo: 3, status: 'PENDING_UPLOAD', availableAt: null }))).toBe(1)
    await expect(copyRow('StoredFile', v2(), fresh({ seriesId: v1(), versionNo: 4 }))).rejects.toThrow(/waits until the upload of the series' earlier version/)
    await expect(update('StoredFile', v2(), `"supersededAt" = now()`)).rejects.toThrow(/superseded only once a later version of its series is available/)
  })

  it('keeps one current version per series at commit: the new one available first, the old one superseded in the same transaction', async () => {
    // Alone, v3 available leaves two current versions: refused at commit.
    await expect(update('StoredFile', v3, `status = 'AVAILABLE', "availableAt" = now()`)).rejects.toThrow(/has 2 current versions/)
    expect(await value(`SELECT status::text FROM "StoredFile" WHERE id = $1::uuid`, [v3])).toBe('PENDING_UPLOAD')
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "StoredFile" SET status = 'AVAILABLE', "availableAt" = now() WHERE id = $1::uuid`, v3)
        await tx.$executeRawUnsafe(`UPDATE "StoredFile" SET "supersededAt" = now() WHERE id = $1::uuid`, v2())
      }),
    )
    expect(await value(`SELECT count(*)::int FROM "StoredFile" WHERE (id = $1::uuid OR "seriesId" = $1::uuid) AND status = 'AVAILABLE' AND "supersededAt" IS NULL`, [v1()])).toBe(1)
  })

  it('keeps a superseded version read-only: superseded for good, its tags fixed, never shared more widely', async () => {
    await expect(update('StoredFile', v2(), `"supersededAt" = NULL`)).rejects.toThrow(/superseded version: it stays as it is/)
    await expect(update('StoredFile', v2(), `"supersededAt" = now() + interval '1 day'`)).rejects.toThrow(/superseded version: it stays as it is/)
    await expect(update('StoredFile', v2(), `category = 'TEST_REPORT'`)).rejects.toThrow(/superseded version: it stays as it is/)
    await expect(update('StoredFile', v2(), `"expiresOn" = "expiresOn" + 30`)).rejects.toThrow(/superseded version: it stays as it is/)
    await expect(update('StoredFile', v2(), `visibility = ARRAY['OFFICE', 'PARTNER', 'LINK']::"FileAudience"[]`)).rejects.toThrow(/never shared more widely/)
    // Its thumbnail, its retention and a narrower sharing still change.
    expect(await update('StoredFile', v2(), `"thumbnailKey" = $2, "exifStrippedAt" = now()`, tag('thumbnail'))).toBe(1)
    expect(await update('StoredFile', v2(), `"retainUntil" = now() + interval '1 year'`)).toBe(1)
    expect(await update('StoredFile', v2(), `visibility = ARRAY['OFFICE']::"FileAudience"[], "partyId" = NULL`)).toBe(1)
  })

  it('never changes the content: the version and the source of a copy with it', async () => {
    await expect(update('StoredFile', v3, `"versionNo" = 5`)).rejects.toThrow(/the content of file .* never changes/)
    await expect(update('StoredFile', v3, `"seriesId" = NULL, "versionNo" = 1`)).rejects.toThrow(/the content of file .* never changes/)
    await expect(update('StoredFile', seeded.files.certificateCopy, `"sourceFileId" = $2::uuid`, v1())).rejects.toThrow(/the content of file .* never changes/)
  })

  it('restores an older version as a new one: a copy of it in the same series', async () => {
    const restored = (await admin(`SELECT sha256, "sizeBytes", "contentType" FROM "StoredFile" WHERE id = $1::uuid`, [v1()]))[0]!
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(r) || $1::jsonb FROM "StoredFile" r WHERE r.id = $2::uuid))`,
          JSON.stringify(fresh({ id: v4, seriesId: v1(), versionNo: 4, sourceFileId: v1(), ...restored })),
          v2(),
        )
        await tx.$executeRawUnsafe(`UPDATE "StoredFile" SET "supersededAt" = now() WHERE id = $1::uuid`, v3)
      }),
    )
    expect(await value(`SELECT "sourceFileId"::text FROM "StoredFile" WHERE id = $1::uuid`, [v4])).toBe(v1())
  })

  it('deletes a superseded version, which then changes no more', async () => {
    expect(await update('StoredFile', v1(), `status = 'DELETED', "deletedAt" = now()`)).toBe(1)
    await expect(update('StoredFile', v1(), `"thumbnailKey" = $2, "exifStrippedAt" = now()`, tag('thumbnail'))).rejects.toThrow(/is deleted; it changes no more/)
  })
})

describe('copies, expiry and thumbnails', () => {
  it('copies only an available file, with its bytes, never itself', async () => {
    const source = seeded.files.photoV2
    await expect(copyRow('StoredFile', source, fresh({ sourceFileId: source, sha256: 'a'.repeat(64), recordType: 'Shipment', recordId: randomUUID() }))).rejects.toThrow(/has its source's bytes/)
    await expect(copyRow('StoredFile', source, fresh({ sourceFileId: seeded.files.pendingTechPack, recordType: 'Shipment', recordId: randomUUID() }))).rejects.toThrow(/names a source that is not an available file/)
    const self = randomUUID()
    await expect(copyRow('StoredFile', source, fresh({ id: self, sourceFileId: self }))).rejects.toThrow(/is not a copy of itself/)
    expect(await copyRow('StoredFile', source, fresh({ sourceFileId: source, recordType: 'Shipment', recordId: randomUUID(), seriesId: null }))).toBe(1)
  })

  it('keeps an expiry reminder with its date, moving later, and a new date without one', async () => {
    const file = seeded.files.certificateCopy
    await expect(update('StoredFile', file, `"expiryRemindedAt" = now()`)).rejects.toThrow(/has an expiry reminder but no expiry date/)
    expect(await update('StoredFile', file, `"expiresOn" = current_date + 25`)).toBe(1)
    expect(await update('StoredFile', file, `"expiryRemindedAt" = now()`)).toBe(1)
    await expect(update('StoredFile', file, `"expiryRemindedAt" = now() - interval '1 day'`)).rejects.toThrow(/expiry reminder of file .* only moves later/)
    await expect(update('StoredFile', file, `"expiresOn" = current_date + 60`)).rejects.toThrow(/a new expiry date of file .* starts without a reminder/)
    expect(await update('StoredFile', file, `"expiresOn" = current_date + 60, "expiryRemindedAt" = NULL`)).toBe(1)
    await expect(copyRow('StoredFile', file, fresh({ expiresOn: '2027-01-01', expiryRemindedAt: at }))).rejects.toThrow(/neither superseded nor reminded of its expiry yet/)
  })

  it('makes a thumbnail once, while the file is AVAILABLE, with the EXIF stripped, never in the legal store', async () => {
    const file = seeded.files.uploadedTechPack
    await expect(update('StoredFile', seeded.files.pendingTechPack, `"thumbnailKey" = $2, "exifStrippedAt" = now()`, tag('thumbnail'))).rejects.toThrow(/made once, while the file is AVAILABLE/)
    await expect(update('StoredFile', file, `"thumbnailKey" = $2`, tag('thumbnail'))).rejects.toThrow(/both or neither/)
    await expect(update('StoredFile', file, `"thumbnailKey" = $2, "exifStrippedAt" = now()`, `legal/${tag('thumbnail')}`)).rejects.toThrow(/never in the legal store/)
    await expect(update('StoredFile', file, `"thumbnailKey" = "storageKey", "exifStrippedAt" = now()`)).rejects.toThrow(/not the file's key/)
    const thumbnail = tag('thumbnail')
    expect(await update('StoredFile', file, `"thumbnailKey" = $2, "exifStrippedAt" = now()`, thumbnail)).toBe(1)
    await expect(update('StoredFile', file, `"thumbnailKey" = $2`, tag('thumbnail'))).rejects.toThrow(/made once, while the file is AVAILABLE, and never changes/)
    await expect(update('StoredFile', seeded.files.certificateCopy, `"thumbnailKey" = $2, "exifStrippedAt" = now()`, thumbnail)).rejects.toThrow(/StoredFile_tenantId_thumbnailKey_key/)
    await expect(copyRow('StoredFile', file, fresh({ status: 'PENDING_UPLOAD', availableAt: null, thumbnailKey: tag('thumbnail'), exifStrippedAt: at }))).rejects.toThrow(/has a thumbnail only when it is born AVAILABLE/)
  })
})

describe('upload sessions', () => {
  const session = () => seeded.sessions.resumable

  it('adds parts of their size, each once, never taking one back', async () => {
    // The seed's two parts done (1 and 2, with the store's ETags).
    const done = (await admin(`SELECT "partsDone" FROM "FileUploadSession" WHERE id = $1::uuid`, [session()]))[0]!.partsDone as Record<string, unknown>[]
    expect(done.map((entry) => entry.partNumber)).toEqual([1, 2])
    const parts = (...more: unknown[]) => JSON.stringify([...done, ...more])
    await expect(update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, JSON.stringify([done[0]]))).rejects.toThrow(/stays as it is; parts are only added/)
    await expect(update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, JSON.stringify([done[0], part(2)]))).rejects.toThrow(/stays as it is; parts are only added/)
    await expect(update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, parts(part(3, 1)))).rejects.toThrow(/not the file's parts/)
    await expect(update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, parts(part(2)))).rejects.toThrow(/not the file's parts/)
    await expect(update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, parts(part(5)))).rejects.toThrow(/not the file's parts/)
    await expect(update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, parts({ partNumber: 3, etag: '', sizeBytes: 5 * 1_048_576 }))).rejects.toThrow(/not the file's parts/)
    expect(await update('FileUploadSession', session(), `"partsDone" = $2::jsonb`, parts(part(4)))).toBe(1)
    await expect(update('FileUploadSession', session(), `status = 'COMPLETED', "endedAt" = now()`)).rejects.toThrow(/completed only with every part done/)
    await expect(update('FileUploadSession', session(), `"partSizeBytes" = 6291456`)).rejects.toThrow(/keeps its file, upload id, part size, expiry and creation/)
    await expect(update('FileUploadSession', session(), `status = 'ABORTED'`)).rejects.toThrow(/an end exactly when it is no longer OPEN/)
  })

  it('is born OPEN with no part, for an announced file, with parts of 5 MiB at least and an expiry within seven days', async () => {
    const base = seeded.sessions.started
    const fresh = (changes: Record<string, unknown>) => ({ id: randomUUID(), uploadId: tag('upload'), ...changes })
    await expect(copyRow('FileUploadSession', base, fresh({ partsDone: [part(1)] }))).rejects.toThrow(/born OPEN with no part done/)
    await expect(copyRow('FileUploadSession', base, fresh({ fileId: seeded.files.uploadedTechPack }))).rejects.toThrow(/is for an announced file \(PENDING_UPLOAD\), not one that is AVAILABLE/)
    await expect(copyRow('FileUploadSession', base, fresh({ partSizeBytes: 1_048_576 }))).rejects.toThrow(/parts of at least 5 MiB/)
    const started = (await admin(`SELECT "createdAt" FROM "FileUploadSession" WHERE id = $1::uuid`, [base]))[0]!.createdAt as Date
    await expect(copyRow('FileUploadSession', base, fresh({ expiresAt: new Date(started.getTime() + 8 * 86_400_000).toISOString() }))).rejects.toThrow(/at most seven days/)
    expect(await copyRow('FileUploadSession', base, fresh({}))).toBe(1)
  })

  it('takes parts only while its file is announced, and changes no more once it ended', async () => {
    const file = randomUUID()
    const opened = randomUUID()
    expect(await copyRow('StoredFile', seeded.files.pendingTechPack, fresh({ id: file, status: 'PENDING_UPLOAD', availableAt: null }))).toBe(1)
    expect(await copyRow('FileUploadSession', seeded.sessions.started, { id: opened, uploadId: tag('upload'), fileId: file })).toBe(1)
    expect(await update('StoredFile', file, `status = 'DELETED', "deletedAt" = now()`)).toBe(1)
    await expect(update('FileUploadSession', opened, `"partsDone" = $2::jsonb`, JSON.stringify([part(1)]))).rejects.toThrow(/takes parts only while its file is an announced upload \(not DELETED\)/)
    expect(await update('FileUploadSession', opened, `status = 'ABORTED', "endedAt" = now()`)).toBe(1)
    await expect(update('FileUploadSession', opened, `status = 'OPEN', "endedAt" = NULL`)).rejects.toThrow(/is ABORTED and changes no more/)
    await expect(update('FileUploadSession', seeded.sessions.completed, `"endedAt" = now()`)).rejects.toThrow(/is COMPLETED and changes no more/)
  })
})

describe('markups', () => {
  const insert = (changes: Record<string, unknown>) =>
    run(
      office(),
      `INSERT INTO "FileMarkup" SELECT * FROM jsonb_populate_record(NULL::"FileMarkup", $1::jsonb)`,
      JSON.stringify({ id: randomUUID(), tenantId: a.tenantId, page: null, shapes: [{ kind: 'CIRCLE', x: 0.5, y: 0.5, radius: 0.1 }], note: null, resultFileId: null, createdById: a.actorId, partyId: null, createdAt: at, ...changes }),
    )

  it('marks up only the current version of a picture or a PDF, a page exactly on a PDF', async () => {
    await expect(insert({ fileId: seeded.files.photoV1 })).rejects.toThrow(/on the current version of a file, available/)
    await expect(insert({ fileId: seeded.files.pendingTechPack, page: 1 })).rejects.toThrow(/on the current version of a file, available/)
    await expect(insert({ fileId: key('files:fiscal') })).rejects.toThrow(/on a picture or a PDF, not application\/xml/)
    await expect(insert({ fileId: seeded.files.photoV2, page: 1 })).rejects.toThrow(/names a page exactly on a PDF/)
    await expect(insert({ fileId: seeded.files.costSheet })).rejects.toThrow(/names a page exactly on a PDF/)
    expect(await insert({ fileId: seeded.files.costSheet, page: 2, note: 'Second page too.' })).toBe(1)
  })

  it('holds shapes and words, names who drew it, and a party draws only on its own shared files', async () => {
    await expect(insert({ fileId: seeded.files.photoV2, shapes: [] })).rejects.toThrow(/1 to 200 shapes/)
    await expect(insert({ fileId: seeded.files.photoV2, shapes: ['circle'] })).rejects.toThrow(/1 to 200 shapes/)
    await expect(insert({ fileId: seeded.files.photoV2, note: '   ' })).rejects.toThrow(/at most 2000 characters, or none/)
    await expect(insert({ fileId: seeded.files.photoV2, createdById: null })).rejects.toThrow(/names who drew it/)
    await expect(insert({ fileId: seeded.files.costSheet, page: 1, createdById: null, partyId: P1 })).rejects.toThrow(/a party marks up only a file shared with its portal or links/)
    expect(await insert({ fileId: seeded.files.partnerReport, page: 3, createdById: null, partyId: P1 })).toBe(1)
  })

  it('makes a new version only of a picture: a later version of its series, not a copy, one markup per version', async () => {
    await expect(insert({ fileId: seeded.files.costSheet, page: 1, resultFileId: seeded.files.photoV2 })).rejects.toThrow(/on a PDF stays an overlay/)
    await expect(insert({ fileId: seeded.files.photoV2, resultFileId: seeded.files.photoV1 })).rejects.toThrow(/is a later version of the same series/)
    const v3 = randomUUID()
    expect(await copyRow('StoredFile', seeded.files.photoV2, fresh({ id: v3, seriesId: seeded.files.photoV1, versionNo: 3, status: 'PENDING_UPLOAD', availableAt: null }))).toBe(1)
    expect(await insert({ fileId: seeded.files.photoV2, resultFileId: v3 })).toBe(1)
    await expect(insert({ fileId: seeded.files.photoV2, resultFileId: v3 })).rejects.toThrow(/FileMarkup_tenantId_resultFileId_key/)
    expect(await update('StoredFile', v3, `status = 'DELETED', "deletedAt" = now()`)).toBe(1)
    const copy = (await admin(`SELECT id::text FROM "StoredFile" WHERE "sourceFileId" = $1::uuid LIMIT 1`, [seeded.files.photoV2]))[0]!.id as string
    await expect(insert({ fileId: seeded.files.photoV2, resultFileId: copy })).rejects.toThrow(/is a later version of the same series/)
  })

  it('is append-only for every login, the owner included', async () => {
    const markup = seeded.markups.photo
    await expect(admin(`UPDATE "FileMarkup" SET note = 'changed' WHERE id = $1::uuid`, [markup])).rejects.toThrow(/a markup is never changed or removed \(UPDATE\)/)
    await expect(admin(`DELETE FROM "FileMarkup" WHERE id = $1::uuid`, [markup])).rejects.toThrow(/a markup is never changed or removed \(DELETE\)/)
    await expect(admin(`TRUNCATE "FileMarkup"`)).rejects.toThrow(/a markup is never changed or removed \(TRUNCATE\)/)
    await expect(admin(`TRUNCATE "FileUploadSession"`)).rejects.toThrow(/TRUNCATE on "FileUploadSession" is refused/)
    await expect(admin(`TRUNCATE "RequiredDocumentRule"`)).rejects.toThrow(/TRUNCATE on "RequiredDocumentRule" is refused/)
  })
})

describe('required document rules', () => {
  const rule = () => seeded.rules.poCertificate
  const fresh = (changes: Record<string, unknown>) => ({ id: randomUUID(), ...changes })

  it('names a record type and a status value, keeps its company, one active rule per key', async () => {
    await expect(copyRow('RequiredDocumentRule', rule(), fresh({ recordType: 'purchase_order', active: false }))).rejects.toThrow(/names a record type \(its model name\) and a status/)
    await expect(copyRow('RequiredDocumentRule', rule(), fresh({ beforeStatus: 'confirmed', active: false }))).rejects.toThrow(/names a record type \(its model name\) and a status/)
    await expect(copyRow('RequiredDocumentRule', rule(), fresh({}))).rejects.toThrow(/RequiredDocumentRule_one_active/)
    await expect(copyRow('RequiredDocumentRule', seeded.rules.receiptReport, fresh({}))).rejects.toThrow(/RequiredDocumentRule_one_active_any_party/)
    expect(await copyRow('RequiredDocumentRule', rule(), fresh({ active: false }))).toBe(1)
    expect(await copyRow('RequiredDocumentRule', rule(), fresh({ partyRole: 'SUBCONTRACTOR' }))).toBe(1)
    expect(await update('RequiredDocumentRule', rule(), `level = 'WARN', active = false`)).toBe(1)
    await expect(update('RequiredDocumentRule', rule(), `"companyId" = $2::uuid`, key('company:B'))).rejects.toThrow(/keeps its company and creation/)
  })
})
