import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinks } from '../seed/links'
import { seed as seedPrivacy, type PrivacySeed } from '../seed/privacy'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The privacy walls beyond the generated isolation tests (B-W1-36; PLAN §2.8; GDPR arts. 13, 30, 35; Statuto dei
 * Lavoratori, L. 300/1970, art. 4 c.3; PLT-208, GAP-004, GAP-005, GAP-009), on a database built from the migrations and
 * seeded twice (tenants A and B: company A's worker, staff and public notices 2026-10 in force, the worker notice
 * 2026-11 a DRAFT, the DPIA stored, three processing activities; the production seed's WO-0001 in progress at A1),
 * through the real login and the scoped client:
 *   - a notice is written as a DRAFT, its languages only while it is one, each with the SHA-256 of what is shown; it is
 *     published with an Italian text (a worker notice an English one too), one in force per company and kind, then
 *     frozen; superseded only by a later version;
 *   - a scan names a worker only once they acknowledged the worker notice IN FORCE: not an earlier version, and no worker
 *     at all while the company has none in force (the redefined factory_production_check_subject);
 *   - an acknowledgement names the version in force and the fingerprint of one of its languages;
 *   - the staff acknowledgements are append-only; the DPIA is stored with its signed PDF and frozen; the record of
 *     processing activities is archived, never deleted;
 *   - the floor reads notices (never who published them) and nothing else here; portal and link sessions nothing;
 *   - the seed is idempotent.
 * Every text is a made-up sample. The refusals are check_violation; their messages are read through raw SQL.
 */

const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PrivacySeed
let production: ProductionSeed

const key = (name: string): string => seedUuid('privacy-a', name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  store: key('files:account:r2'),
  member: key('user:member'),
  invited: key('user:invited'),
  party: key('party:P1'),
}

const office = (actorId: string = a.actorId): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: A.party })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const tag = (): string => randomUUID().slice(0, 8)
const SAMPLE = (what: string) => `SAMPLE - made-up ${what} for tests.`

/** A DRAFT notice of company A with its languages (texts by locale). */
async function draftNotice(kind: string, texts: Record<string, string>, companyId = A.companyA): Promise<{ id: string; versionNo: number; label: string }> {
  const [{ next }] = (await admin(`SELECT coalesce(max("versionNo"), 0) + 1 AS next FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = $3::"PrivacyNoticeKind"`, [a.tenantId, companyId, kind])) as [{ next: number }]
  const notice = { id: randomUUID(), companyId, kind, versionNo: next, label: `T-${tag()}` }
  expect(await insert(office(), 'PrivacyNotice', notice)).toBe(1)
  for (const [locale, body] of Object.entries(texts)) expect(await insert(office(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: notice.id, locale, body, sha256: sha(body) })).toBe(1)
  return notice
}

/** Publishes a DRAFT the way the API does: the version in force (if any) superseded first, then this one, in one transaction. */
const publish = (noticeId: string, kind: string, companyId = A.companyA) =>
  as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "PrivacyNotice" SET status = 'SUPERSEDED', "supersededAt" = now() WHERE "companyId" = $1::uuid AND kind = $2::"PrivacyNoticeKind" AND status = 'PUBLISHED'`,
        companyId,
        kind,
      )
      return tx.$executeRawUnsafe(`UPDATE "PrivacyNotice" SET status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $2::uuid WHERE id = $1::uuid`, noticeId, a.actorId)
    }),
  )

/** A bundle of WO-0001 (the production seed's, in progress at A1), made on A1's floor. */
async function bundle(): Promise<string> {
  const id = randomUUID()
  await insert(floor(), 'Bundle', { id, siteId: A.siteA, workOrderId: production.workOrderId, workOrderSizeId: production.cellIds['RED-50'], code: `T-BN-${tag()}`, quantity: 1, deviceId: production.deviceId })
  return id
}
/** A REPORT of a fresh bundle at sewing, naming `workerId`, on the cutting tablet. */
const scanBy = async (workerId: string) =>
  insert(floor(), 'OperationScan', {
    id: randomUUID(),
    siteId: A.siteA,
    workOrderId: production.workOrderId,
    workOrderOperationId: production.operationIds.sew,
    bundleId: await bundle(),
    kind: 'REPORT',
    goodQuantity: 1,
    workerId,
    deviceId: production.deviceId,
    clientScanId: `t-${randomUUID()}`,
    deviceTime: new Date().toISOString(),
  })
/** A worker's acknowledgement on the cutting tablet. */
const ackRow = (workerId: string, notice: { id: string; label: string } | null, body: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  siteId: A.siteA,
  workerId,
  noticeId: notice?.id ?? null,
  noticeVersion: notice?.label ?? `none-${tag()}`,
  locale: 'it',
  noticeSha256: sha(body),
  channel: 'DEVICE',
  deviceId: production.deviceId,
  deviceTime: new Date().toISOString(),
  ...extra,
})
const textOf = async (noticeId: string, locale: string): Promise<string> => (await admin('SELECT body FROM "PrivacyNoticeText" WHERE "noticeId" = $1 AND locale = $2', [noticeId, locale]))[0]!.body as string
const inForce = async (kind: string): Promise<{ id: string; label: string }> =>
  (await admin(`SELECT id, label FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = $3::"PrivacyNoticeKind" AND status = 'PUBLISHED'`, [a.tenantId, A.companyA, kind]))[0] as { id: string; label: string }

beforeAll(async () => {
  db = await migratedDatabase('privacy')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'privacy-a' })
  await seedCore({ db: factory, namespace: 'privacy-b' })
  await seedLinks({ db: factory, namespace: 'privacy-a' })
  await seedLinks({ db: factory, namespace: 'privacy-b' })
  production = await seedProduction({ db: factory, namespace: 'privacy-a' })
  await seedProduction({ db: factory, namespace: 'privacy-b' })
  seeded = await seedPrivacy({ db: factory, namespace: 'privacy-a' })
  await seedPrivacy({ db: factory, namespace: 'privacy-b' })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('holds company A’s notices in force, a DRAFT, the stored DPIA and the register; a second run adds nothing', async () => {
    const counts = async () =>
      (await admin(
        `SELECT (SELECT count(*) FROM "PrivacyNotice")::int AS notices, (SELECT count(*) FROM "PrivacyNoticeText")::int AS texts, (SELECT count(*) FROM "PrivacyDpia")::int AS dpias,
                (SELECT count(*) FROM "ProcessingActivity")::int AS activities, (SELECT count(*) FROM "StaffNoticeAck")::int AS staff, (SELECT count(*) FROM "WorkerNoticeAck")::int AS acks`,
      ))[0]
    const before = await counts()
    await seedPrivacy({ db: factory, namespace: 'privacy-a' })
    expect(await counts()).toEqual(before)
    const rows = await admin(`SELECT n.kind::text AS kind, n.label, n.status::text AS status FROM "PrivacyNotice" n WHERE n."tenantId" = $1 ORDER BY n.kind, n."versionNo"`, [a.tenantId])
    expect(rows).toEqual([
      { kind: 'WORKER_FLOOR', label: '2026-10', status: 'PUBLISHED' },
      { kind: 'WORKER_FLOOR', label: '2026-11', status: 'DRAFT' },
      { kind: 'OFFICE_STAFF', label: '2026-10', status: 'PUBLISHED' },
      { kind: 'PRIVACY_PUBLIC', label: '2026-10', status: 'PUBLISHED' },
    ])
    for (const { body, sha256 } of (await admin('SELECT body, sha256 FROM "PrivacyNoticeText"')) as { body: string; sha256: string }[]) {
      expect(body).toMatch(/^(ESEMPIO|SAMPLE) - /)
      expect(sha256).toBe(sha(body))
    }
  }, 30_000)
})

describe('notice versions', () => {
  it('start as a DRAFT; their languages carry the SHA-256 of the text; a published one is frozen', async () => {
    await expect(insert(office(), 'PrivacyNotice', { id: randomUUID(), companyId: A.companyA, kind: 'PRIVACY_PUBLIC', versionNo: 90, label: `T-${tag()}`, status: 'PUBLISHED', publishedAt: new Date().toISOString(), publishedById: a.actorId })).rejects.toThrow(
      /starts as a DRAFT, unpublished/,
    )
    const body = SAMPLE('public notice')
    const notice = await draftNotice('PRIVACY_PUBLIC', { it: body })
    await expect(insert(office(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: notice.id, locale: 'en', body: 'SAMPLE text', sha256: sha('another text') })).rejects.toThrow(/fingerprint of text .* is the SHA-256 of its text/)
    await expect(insert(office(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: notice.id, locale: 'ro', sha256: sha('x') })).rejects.toThrow(/a text or a PDF/)
    // A PDF-only language: an AVAILABLE file of the notice, and the fingerprint is the PDF's.
    const pdfSha = sha(`pdf ${tag()}`)
    const fileId = randomUUID()
    await as(office(), (client) =>
      client.storedFile.create({
        data: {
          id: fileId,
          companyId: A.companyA,
          recordType: 'PrivacyNotice',
          recordId: notice.id,
          kind: 'DOCUMENT',
          originalName: 'sample-ro.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
          sha256: pdfSha,
          storeAccountId: A.store,
          storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
          status: 'AVAILABLE',
          availableAt: new Date(),
        },
        select: { id: true },
      }),
    )
    await expect(insert(office(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: notice.id, locale: 'ro', fileId, sha256: sha('not the pdf') })).rejects.toThrow(/its fingerprint is the PDF's SHA-256/)
    expect(await insert(office(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: notice.id, locale: 'ro', fileId, sha256: pdfSha })).toBe(1)
    // One in force per company and kind (the seed's 2026-10 is): publishing another without superseding it is refused.
    await expect(run(office(), `UPDATE "PrivacyNotice" SET status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $2::uuid WHERE id = $1::uuid`, notice.id, a.actorId)).rejects.toThrow(/PrivacyNotice_one_published/)
    expect(await publish(notice.id, 'PRIVACY_PUBLIC')).toBe(1)
    expect((await admin('SELECT status::text FROM "PrivacyNotice" WHERE id = $1', [seeded.publicNoticeId]))[0]).toEqual({ status: 'SUPERSEDED' })
    // Frozen: its languages, its label; a SUPERSEDED one never changes; neither is deleted.
    await expect(run(office(), `UPDATE "PrivacyNoticeText" SET body = 'changed', sha256 = $2 WHERE "noticeId" = $1::uuid AND locale = 'it'`, notice.id, sha('changed'))).rejects.toThrow(/is PUBLISHED; its languages never change/)
    await expect(run(office(), `DELETE FROM "PrivacyNoticeText" WHERE "noticeId" = $1::uuid`, notice.id)).rejects.toThrow(/its languages never change/)
    await expect(insert(office(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: notice.id, locale: 'de', body: 'SAMPLE', sha256: sha('SAMPLE') })).rejects.toThrow(/its languages never change/)
    await expect(run(office(), `UPDATE "PrivacyNotice" SET label = 'other' WHERE id = $1::uuid`, notice.id)).rejects.toThrow(/label and when and by whom it was published never change/)
    await expect(run(office(), `UPDATE "PrivacyNotice" SET status = 'DRAFT' WHERE id = $1::uuid`, notice.id)).rejects.toThrow(/moves DRAFT → PUBLISHED → SUPERSEDED/)
    await expect(run(office(), `UPDATE "PrivacyNotice" SET label = 'other' WHERE id = $1::uuid`, seeded.publicNoticeId)).rejects.toThrow(/is SUPERSEDED; it never changes/)
    await expect(run(office(), 'DELETE FROM "PrivacyNotice" WHERE id = $1::uuid', notice.id)).rejects.toThrow(/only a DRAFT is deleted/)
    await expect(admin('TRUNCATE "PrivacyNoticeText"')).rejects.toThrow(/privacy: TRUNCATE on "PrivacyNoticeText" is refused/)
  }, 30_000)

  it('are published with an Italian text, a worker notice with an English one too (Q15); a draft may be deleted', async () => {
    const workerOnlyIt = await draftNotice('WORKER_FLOOR', { it: SAMPLE('worker notice') })
    await expect(publish(workerOnlyIt.id, 'WORKER_FLOOR')).rejects.toThrow(/published with its text in Italian, and a worker notice in English too/)
    const staffOnlyEn = await draftNotice('OFFICE_STAFF', { en: SAMPLE('staff notice') })
    await expect(publish(staffOnlyEn.id, 'OFFICE_STAFF')).rejects.toThrow(/published with its text in Italian/)
    // Nothing changed: the seed's versions are still in force.
    expect((await inForce('WORKER_FLOOR')).id).toBe(seeded.workerNoticeId)
    expect((await inForce('OFFICE_STAFF')).id).toBe(seeded.staffNoticeId)
    // A draft (and its languages) may be deleted.
    expect(await run(office(), 'DELETE FROM "PrivacyNoticeText" WHERE "noticeId" = $1::uuid', staffOnlyEn.id)).toBe(1)
    expect(await run(office(), 'DELETE FROM "PrivacyNotice" WHERE id = $1::uuid', staffOnlyEn.id)).toBe(1)
    // Superseded only by a later version.
    await expect(run(office(), `UPDATE "PrivacyNotice" SET status = 'SUPERSEDED', "supersededAt" = now() WHERE id = $1::uuid`, seeded.staffNoticeId)).rejects.toThrow(/superseded only by a later version/)
  }, 30_000)
})

describe('the floor gate: a scan names a worker only after they acknowledged the notice in force (art. 4 c.3)', () => {
  it('v1 acknowledged → scans; v2 published → acknowledge again; an acknowledgement names the notice', async () => {
    const lead = production.leadId
    const operator = production.operatorId
    const v1 = await inForce('WORKER_FLOOR')
    expect(v1.id).toBe(seeded.workerNoticeId)
    // Every acknowledgement names the notice it acknowledges.
    await expect(insert(floor(), 'WorkerNoticeAck', ackRow(lead, null, 'an older notice'))).rejects.toThrow(/names the worker notice it acknowledges/)
    await expect(scanBy(lead)).rejects.toThrow(/worker .* has not acknowledged the information notice in force \(version 2026-10\); no scan names a worker before that \(Statuto dei Lavoratori art\. 4 c\.3/)
    // The seed's operator acknowledged 2026-10 on the tablet: their scan is taken.
    expect(await scanBy(operator)).toBe(1)

    // The lead acknowledges v1: only the version in force, with the fingerprint of a language of it.
    const itV1 = await textOf(v1.id, 'it')
    await expect(insert(floor(), 'WorkerNoticeAck', ackRow(lead, v1, 'not the text'))).rejects.toThrow(/stores the fingerprint of notice .* in language it/)
    await expect(insert(floor(), 'WorkerNoticeAck', ackRow(lead, { id: seeded.workerDraftId, label: '2026-11' }, await textOf(seeded.workerDraftId, 'it')))).rejects.toThrow(/notice in force of their site's company; notice .* is a DRAFT WORKER_FLOOR one/)
    await expect(insert(floor(), 'WorkerNoticeAck', ackRow(lead, { id: seeded.staffNoticeId, label: '2026-10' }, await textOf(seeded.staffNoticeId, 'it')))).rejects.toThrow(/is a PUBLISHED OFFICE_STAFF one/)
    expect(await insert(floor(), 'WorkerNoticeAck', ackRow(lead, v1, itV1))).toBe(1)
    expect(await scanBy(lead)).toBe(1)

    // v2 is published: v1's acknowledgements no longer count, for anybody.
    const v2Texts = { it: SAMPLE('worker notice v2, Italian'), en: SAMPLE('worker notice v2, English') }
    const v2 = await draftNotice('WORKER_FLOOR', v2Texts)
    expect(await publish(v2.id, 'WORKER_FLOOR')).toBe(1)
    await expect(scanBy(operator)).rejects.toThrow(new RegExp(`has not acknowledged the information notice in force \\(version ${v2.label}\\)`))
    await expect(scanBy(lead)).rejects.toThrow(/has not acknowledged the information notice in force/)
    // An acknowledgement of the superseded v1 is refused too.
    await expect(insert(floor(), 'WorkerNoticeAck', ackRow(operator, v1, itV1, { noticeVersion: '2026-10-again' }))).rejects.toThrow(/is a SUPERSEDED WORKER_FLOOR one/)
    expect(await insert(floor(), 'WorkerNoticeAck', ackRow(operator, v2, v2Texts.en, { locale: 'en' }))).toBe(1)
    expect(await scanBy(operator)).toBe(1)
    await expect(scanBy(lead)).rejects.toThrow(/has not acknowledged the information notice in force/)
    // Acknowledgements stay as given.
    await expect(admin('UPDATE "WorkerNoticeAck" SET locale = \'de\' WHERE "noticeId" = $1', [v2.id])).rejects.toThrow(/append-only: UPDATE on "WorkerNoticeAck" is refused/)
  }, 30_000)
})

describe('a company without a worker notice in force', () => {
  it('names no worker on a floor record, and no worker acknowledges anything there (strict, art. 4 c.3)', async () => {
    // Company B published no worker notice. Its plant B1 records stations; switched to WORKER, the subject check refuses.
    const siteB1 = key('site:B1')
    const operatorB1 = key('worker:B1:operator')
    expect(await run(office(), `UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1::uuid`, siteB1)).toBe(1)
    try {
      await expect(sql(office(), `SELECT "factory_production_check_subject"($1::uuid, $2::uuid, $3::uuid, NULL, 'scan', $4::uuid)`, a.tenantId, siteB1, operatorB1, randomUUID())).rejects.toThrow(
        /the company of site .* has no worker notice in force; no scan names a worker before workers acknowledged one/,
      )
    } finally {
      expect(await run(office(), `UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1::uuid`, siteB1)).toBe(1)
    }
    // Company A's notice is not B1's company's: a B1 worker cannot acknowledge it.
    const v1 = await inForce('WORKER_FLOOR')
    await expect(
      insert(office(), 'WorkerNoticeAck', { ...ackRow(operatorB1, v1, await textOf(v1.id, 'it'), { siteId: siteB1, channel: 'PAPER', deviceId: null, deviceTime: null }) }),
    ).rejects.toThrow(/notice in force of their site's company/)
  }, 30_000)
})

describe('staff acknowledgements', () => {
  it('name the staff notice in force with a fingerprint of it, by an ACTIVE person, and are append-only', async () => {
    const notice = await inForce('OFFICE_STAFF')
    const body = await textOf(notice.id, 'it')
    const row = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), companyId: A.companyA, noticeId: notice.id, userId: A.member, noticeVersion: `${notice.label}-${tag()}`, locale: 'it', noticeSha256: sha(body), ...extra })
    await expect(insert(office(A.member), 'StaffNoticeAck', row({ noticeSha256: sha('another text') }))).rejects.toThrow(/stores the fingerprint of notice/)
    await expect(insert(office(A.member), 'StaffNoticeAck', row({ noticeId: seeded.workerNoticeId, noticeSha256: sha(await textOf(seeded.workerNoticeId, 'it')) }))).rejects.toThrow(/names its company's staff notice in force/)
    await expect(insert(office(A.invited), 'StaffNoticeAck', row({ userId: A.invited }))).rejects.toThrow(/is INVITED; only an ACTIVE person acknowledges/)
    expect(await insert(office(A.member), 'StaffNoticeAck', row())).toBe(1)
    await expect(admin('UPDATE "StaffNoticeAck" SET locale = \'en\' WHERE id = $1', [seeded.staffAckId])).rejects.toThrow(/append-only: UPDATE on "StaffNoticeAck" is refused/)
    await expect(admin('DELETE FROM "StaffNoticeAck" WHERE id = $1', [seeded.staffAckId])).rejects.toThrow(/append-only: DELETE on "StaffNoticeAck" is refused/)
    await expect(admin('TRUNCATE "StaffNoticeAck"')).rejects.toThrow(/append-only: TRUNCATE on "StaffNoticeAck" is refused/)
  }, 30_000)
})

describe('the DPIA', () => {
  it('is stored with its signed PDF, who signed it, the days; one stored per company; frozen; superseded by a later one', async () => {
    await expect(insert(office(), 'PrivacyDpia', { id: randomUUID(), companyId: A.companyA, versionNo: 50, scope: 'x', status: 'STORED' })).rejects.toThrow(/starts as a DRAFT, without its signed PDF/)
    const dpiaId = randomUUID()
    expect(await insert(office(), 'PrivacyDpia', { id: dpiaId, companyId: A.companyA, versionNo: 3, scope: SAMPLE('scope') })).toBe(1)
    const pdfSha = sha(`dpia ${tag()}`)
    const fileId = randomUUID()
    await as(office(), (client) =>
      client.storedFile.create({
        data: {
          id: fileId,
          companyId: A.companyA,
          recordType: 'PrivacyDpia',
          recordId: dpiaId,
          kind: 'DOCUMENT',
          originalName: 'sample-dpia.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
          sha256: pdfSha,
          storeAccountId: A.store,
          storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
          status: 'AVAILABLE',
          availableAt: new Date(),
        },
        select: { id: true },
      }),
    )
    const store = (extra: string) =>
      run(office(), `UPDATE "PrivacyDpia" SET status = 'STORED', "storedAt" = now(), "storedById" = $2::uuid, ${extra} WHERE id = $1::uuid`, dpiaId, a.actorId)
    await expect(store(`"fileId" = '${fileId}', "fileSha256" = '${sha('other')}', "signedByName" = 'Sample Signer', "signedOn" = current_date, "reviewDueOn" = current_date + 365`)).rejects.toThrow(
      /signed PDF of DPIA .* is an available file of that DPIA, with its SHA-256/,
    )
    await expect(store(`"fileId" = '${fileId}', "fileSha256" = '${pdfSha}', "signedOn" = current_date, "reviewDueOn" = current_date + 365`)).rejects.toThrow(/names its signed PDF, who signed it/)
    await expect(store(`"fileId" = '${fileId}', "fileSha256" = '${pdfSha}', "signedByName" = 'Sample Signer', "signedOn" = current_date, "reviewDueOn" = current_date`)).rejects.toThrow(/reviewed after it was signed/)
    // The seed's version 1 is stored: a second stored one waits until it is superseded.
    await expect(store(`"fileId" = '${fileId}', "fileSha256" = '${pdfSha}', "signedByName" = 'Sample Signer', "signedOn" = current_date, "reviewDueOn" = current_date + 365`)).rejects.toThrow(/PrivacyDpia_one_stored/)
    expect(
      await as(office(), (client) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE "PrivacyDpia" SET status = 'SUPERSEDED', "supersededAt" = now() WHERE id = $1::uuid`, seeded.dpiaId)
          return tx.$executeRawUnsafe(
            `UPDATE "PrivacyDpia" SET status = 'STORED', "storedAt" = now(), "storedById" = $2::uuid, "fileId" = $3::uuid, "fileSha256" = $4, "signedByName" = 'Sample Signer', "signedOn" = current_date, "reviewDueOn" = current_date + 365 WHERE id = $1::uuid`,
            dpiaId,
            a.actorId,
            fileId,
            pdfSha,
          )
        }),
      ),
    ).toBe(1)
    await expect(run(office(), `UPDATE "PrivacyDpia" SET scope = 'changed' WHERE id = $1::uuid`, dpiaId)).rejects.toThrow(/it never changes \(a later version replaces it\)/)
    await expect(run(office(), `UPDATE "PrivacyDpia" SET "reviewDueOn" = current_date + 2 WHERE id = $1::uuid`, seeded.dpiaId)).rejects.toThrow(/is SUPERSEDED|never changes/)
    await expect(run(office(), 'DELETE FROM "PrivacyDpia" WHERE id = $1::uuid', dpiaId)).rejects.toThrow(/only a DRAFT is deleted/)
    expect(await run(office(), 'DELETE FROM "PrivacyDpia" WHERE id = $1::uuid', seeded.dpiaDraftId)).toBe(1)
  }, 30_000)
})

describe('the record of processing activities', () => {
  it('says what, why, on which basis, about whom and which data; archived, never deleted', async () => {
    const row = { id: randomUUID(), companyId: A.companyA, code: `T-${tag().toUpperCase()}`, name: 'SAMPLE', purpose: 'SAMPLE', legalBasis: 'SAMPLE', dataSubjects: ['staff'], dataCategories: ['name'], transfers: 'None', retention: '1 year', security: 'SAMPLE' }
    await expect(insert(office(), 'ProcessingActivity', { ...row, dataSubjects: [] })).rejects.toThrow(/says what, why, on which basis, about whom/)
    await expect(insert(office(), 'ProcessingActivity', { ...row, purpose: ' ' })).rejects.toThrow(/GDPR art\. 30\(1\)/)
    expect(await insert(office(), 'ProcessingActivity', row)).toBe(1)
    await expect(run(office(), `UPDATE "ProcessingActivity" SET code = 'OTHER' WHERE id = $1::uuid`, row.id)).rejects.toThrow(/company, code and creation .* never change/)
    expect(await run(office(), `UPDATE "ProcessingActivity" SET status = 'ARCHIVED' WHERE id = $1::uuid`, row.id)).toBe(1)
    await expect(run(office(), `UPDATE "ProcessingActivity" SET name = 'x' WHERE id = $1::uuid`, row.id)).rejects.toThrow(/is ARCHIVED; it never changes/)
    await expect(run(office(), 'DELETE FROM "ProcessingActivity" WHERE id = $1::uuid', row.id)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "ProcessingActivity" WHERE id = $1', [row.id])).rejects.toThrow(/archived, never deleted/)
  }, 30_000)
})

describe('who reads what', () => {
  it('the floor reads notices and their texts, never who published them, and nothing else here', async () => {
    expect((await sql(floor(), 'SELECT id, kind::text, status::text, label FROM "PrivacyNotice"')).length).toBeGreaterThan(0)
    expect((await sql(floor(), 'SELECT locale, body, sha256 FROM "PrivacyNoticeText"')).length).toBeGreaterThan(0)
    await expect(sql(floor(), 'SELECT "publishedById" FROM "PrivacyNotice"')).rejects.toThrow(DENIED)
    await expect(sql(floor(), 'SELECT "fileId" FROM "PrivacyNoticeText"')).rejects.toThrow(DENIED)
    for (const table of ['PrivacyDpia', 'ProcessingActivity', 'StaffNoticeAck']) await expect(sql(floor(), `SELECT 1 FROM "${table}"`)).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'PrivacyNoticeText', { id: randomUUID(), noticeId: seeded.workerDraftId, locale: 'fr', body: 'x', sha256: sha('x') })).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "PrivacyNotice" SET label = label`)).rejects.toThrow(DENIED)
  }, 30_000)

  it('portal and link sessions read nothing here (the API reads the public notice for them)', async () => {
    for (const table of ['PrivacyNotice', 'PrivacyNoticeText', 'PrivacyDpia', 'ProcessingActivity', 'StaffNoticeAck']) await expect(sql(partner(), `SELECT 1 FROM "${table}"`)).rejects.toThrow(DENIED)
  }, 30_000)
})
