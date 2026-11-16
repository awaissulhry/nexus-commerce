import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedEmail } from '../seed/email'
import { seed as seedEmailIn } from '../seed/email-in'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedPrivacy, type PrivacySeed } from '../seed/privacy'
import { seed as seedPrivacyOps, type PrivacyOpsSeed } from '../seed/privacy-ops'
import { seed as seedThreads } from '../seed/threads'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import type { Prisma } from './generated/prisma/client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-W2b-GF1 (…_privacy_partner_w2b_guards) on a database built from the migrations, through the real login and as the owner login:
 *   - G275: the office staff notice is acknowledged by an OFFICE person only; a partner person is refused (for every login);
 *   - G274: a person's data package (a file of a DataRequest) takes a delete date; any other file but a made-to-measure photo
 *     still takes none;
 *   - F54: an erasure blanks a received mail's envelope sender too (the door and the trigger); the retention sweep anonymises a
 *     settled mail past its rule's period, only inside its APPLY sweep of this transaction, only those six columns, only to
 *     NULL — refused without the sweep, for a REPORT sweep, a sweep of an earlier transaction, a mail waiting for a person, a
 *     mail newer than the cut-off, another value or another column, and a tenant-wide rule where the company has its own.
 * Every person, address and text is made up.
 */

const NS = 'w2b-gf1-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let p: PrivacySeed
let portal: PortalAuthSeed
let s: PrivacyOpsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  held: key('email-in:held'),
  triage: key('email-in:triage'),
  virus: key('email-in:virus'),
  staffNotice: key('privacy:notice:A:OFFICE_STAFF:1'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
type Tx = Prisma.TransactionClient
const inOffice = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => as(office(), (client) => client.$transaction((tx) => work(tx)))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, any>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
/** As the owner login (a superuser), in one transaction that is always rolled back: the triggers alone. */
async function asOwner(work: () => Promise<unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await work()
  } finally {
    await db.admin.query('ROLLBACK')
  }
}
async function refused(text: string, values: unknown[], pattern: RegExp): Promise<void> {
  await db.admin.query('SAVEPOINT refused')
  await expect(admin(text, values)).rejects.toThrow(pattern)
  await db.admin.query('ROLLBACK TO SAVEPOINT refused')
}

/** A made-up REJECTED mail received long ago (2024), copied from the seeded one with its own ids. */
async function oldMail(receivedAt = '2024-01-10T09:00:00.000Z', companyId: string | null = A.companyA): Promise<string> {
  const id = randomUUID()
  await admin(
    `INSERT INTO "InboundEmail" (id, "tenantId", "companyId", "accountId", "receiptId", "sesMessageId", "s3Bucket", "s3Key", "receivedAt", "envelopeFrom", "envelopeTo",
                                 "fromAddress", "fromName", "to", subject, "bodyText", "spfVerdict", "dkimVerdict", "dmarcVerdict", "spamVerdict", "virusVerdict",
                                 status, "rejectReason", "sortedAt", "createdAt", "updatedAt")
     SELECT $1::uuid, "tenantId", $3::uuid, "accountId", "receiptId", 'gf1-' || $1, "s3Bucket", 'inbound/gf1-' || $1, $2::timestamptz, 'old.sender.gf1@example.com', "envelopeTo",
            'old.sender.gf1@example.com', 'Old Sender', "to", 'Made-up old mail', 'Made-up text of an old mail.', "spfVerdict", "dkimVerdict", "dmarcVerdict", "spamVerdict", "virusVerdict",
            'REJECTED', 'VIRUS', $2::timestamptz, $2::timestamptz, $2::timestamptz
       FROM "InboundEmail" WHERE id = $4::uuid`,
    [id, receivedAt, companyId, A.virus],
  )
  return id
}
/** Inside asOwner: the seeded tenant-wide InboundEmail rule switched on, and its sweep (APPLY unless said) started now. */
async function sweepNow(mode: 'APPLY' | 'REPORT' = 'APPLY'): Promise<string> {
  await admin(`UPDATE "RetentionRule" SET "applyOn" = true, "applyOnAt" = now(), "applyOnById" = $2::uuid WHERE id = $1::uuid AND NOT "applyOn"`, [s.ruleIds.inboundMail, a.actorId])
  const id = randomUUID()
  await admin(
    `INSERT INTO "RetentionSweep" (id, "tenantId", "ruleId", mode, "keepMonths", "thenAction", "cutoffOn", status, "startedAt")
     SELECT $1::uuid, r."tenantId", r.id, $3::"RetentionSweepMode", r."keepMonths", r."thenAction", ("factory_money_rome_day"(now()) - make_interval(months => r."keepMonths"))::date, 'RUNNING', now()
       FROM "RetentionRule" r WHERE r.id = $2::uuid`,
    [id, s.ruleIds.inboundMail, mode],
  )
  return id
}
const BLANK_SIX = `"fromAddress" = NULL, "fromName" = NULL, subject = NULL, "bodyText" = NULL, "bodyHtml" = NULL, "envelopeFrom" = NULL`

beforeAll(async () => {
  db = await migratedDatabase('privacypartnerw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedEmailIn({ db: factory, namespace: NS })
  await seedEmail({ db: factory, namespace: NS })
  await seedIntegration({ db: factory, namespace: NS })
  await seedThreads({ db: factory, namespace: NS })
  p = await seedPrivacy({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  s = await seedPrivacyOps({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('G275: the office staff notice is acknowledged by office people only', () => {
  const ack = (userId: string) => ({
    id: randomUUID(),
    tenantId: a.tenantId,
    companyId: A.companyA,
    noticeId: p.staffNoticeId,
    userId,
    noticeVersion: `gf1-${randomUUID().slice(0, 8)}`,
    locale: 'en',
    noticeSha256: '',
    serverTime: new Date().toISOString(),
    createdById: userId,
  })
  it('refuses a partner person (an ACTIVE portal buyer) for every login, the owner included; an office person passes', async () => {
    const { sha256 } = await one(`SELECT sha256 FROM "PrivacyNoticeText" WHERE "noticeId" = $1 AND locale = 'en'`, [p.staffNoticeId])
    expect(await one(`SELECT audience::text, status::text FROM "User" WHERE id = $1`, [portal.userIds.p1Buyer])).toEqual({ audience: 'PARTNER', status: 'ACTIVE' })
    await asOwner(async () => {
      const [text, row] = insertSql('StaffNoticeAck', { ...ack(portal.userIds.p1Buyer), noticeSha256: sha256 })
      await refused(text, [row], /signs in to a partner portal \(PARTNER\): the office staff notice is acknowledged by office people only/)
      const officeAck = { ...ack(a.actorId), noticeSha256: sha256 }
      const [officeText, officeRow] = insertSql('StaffNoticeAck', officeAck)
      await admin(officeText, [officeRow])
      expect(await one(`SELECT count(*)::int AS n FROM "StaffNoticeAck" WHERE id = $1`, [officeAck.id])).toEqual({ n: 1 })
    })
  })
})

describe("G274: a person's data package takes a delete date", () => {
  it('a DataRequest file takes one (and moves later, never cleared); any other file but a made-to-measure photo still takes none', async () => {
    await asOwner(async () => {
      await admin(`UPDATE "StoredFile" SET "deleteAfter" = now() + interval '30 days' WHERE id = $1`, [s.packageFileId])
      expect(await one(`SELECT "recordType", "deleteAfter" IS NOT NULL AS dated FROM "StoredFile" WHERE id = $1`, [s.packageFileId])).toEqual({ recordType: 'DataRequest', dated: true })
      await admin(`UPDATE "StoredFile" SET "deleteAfter" = "deleteAfter" + interval '1 day' WHERE id = $1`, [s.packageFileId])
      await refused(`UPDATE "StoredFile" SET "deleteAfter" = NULL WHERE id = $1`, [s.packageFileId], /moves but is never cleared/)
      const other = await one(`SELECT id FROM "StoredFile" WHERE "recordType" NOT IN ('DataRequest', 'MeasurementProfile', 'FittingResult') AND "retainUntil" IS NULL AND NOT "legalHold" AND status = 'AVAILABLE' ORDER BY id LIMIT 1`)
      await refused(`UPDATE "StoredFile" SET "deleteAfter" = now() + interval '30 days' WHERE id = $1`, [other.id], /takes no delete date: only a made-to-measure photo \(MTM_PHOTO, FITTING_PHOTO\) or a person's data package/)
    })
  })
})

describe('F54: the envelope sender goes with an erasure', () => {
  it('the door blanks it when the erasure record names it; the trigger takes it with the other five', async () => {
    const erasure = { id: randomUUID(), companyId: A.companyA, dataRequestId: s.requestIds.contactErasure, recordType: 'InboundEmail', recordId: A.held, method: 'ANONYMISED', erasedFields: ['fromAddress', 'subject', 'envelopeFrom'], erasedById: a.actorId }
    const changed = await inOffice(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('ErasureRecord', erasure))
      const rows = await tx.$queryRawUnsafe<{ changed: boolean }[]>('SELECT "factory_privacy_erase_row"($1::uuid, $2::text[], $3::text[]) AS changed', erasure.id, [], [])
      return rows[0]!.changed
    })
    expect(changed).toBe(true)
    expect(await one(`SELECT "envelopeFrom", "fromAddress", subject, "fromName", status::text FROM "InboundEmail" WHERE id = $1`, [A.held])).toEqual({ envelopeFrom: null, fromAddress: null, subject: null, fromName: 'Ufficio amministrazione', status: 'HELD' })
    // Without the record the envelope sender never changes (what SES said).
    await asOwner(async () => {
      await refused(`UPDATE "InboundEmail" SET "envelopeFrom" = NULL WHERE id = $1`, [A.triage], /what SES said about mail .* never changes/)
    })
  })
})

describe('F54: the retention sweep anonymises a settled mail past its period', () => {
  it('blanks the six columns inside its APPLY sweep of this transaction; the row and everything else stay', async () => {
    const mail = await oldMail()
    await asOwner(async () => {
      await sweepNow()
      await admin(`UPDATE "InboundEmail" SET ${BLANK_SIX} WHERE id = $1`, [mail])
      expect(await one(`SELECT "fromAddress", "fromName", subject, "bodyText", "bodyHtml", "envelopeFrom", status::text, "rejectReason", "s3Key" FROM "InboundEmail" WHERE id = $1`, [mail])).toEqual({
        fromAddress: null,
        fromName: null,
        subject: null,
        bodyText: null,
        bodyHtml: null,
        envelopeFrom: null,
        status: 'REJECTED',
        rejectReason: 'VIRUS',
        s3Key: `inbound/gf1-${mail}`,
      })
      // A mail of a tenant-wide account (no company) is covered by the tenant-wide rule too.
      const noCompany = await oldMail('2024-02-01T09:00:00.000Z', null)
      await admin(`UPDATE "InboundEmail" SET "fromAddress" = NULL WHERE id = $1`, [noCompany])
    })
  })

  it('refuses without a sweep, with a REPORT sweep, with a sweep of an earlier transaction', async () => {
    const mail = await oldMail()
    await asOwner(async () => {
      await refused(`UPDATE "InboundEmail" SET ${BLANK_SIX} WHERE id = $1`, [mail], /email-in: mail .* is REJECTED; it changes no more/)
    })
    await asOwner(async () => {
      await sweepNow('REPORT')
      await refused(`UPDATE "InboundEmail" SET ${BLANK_SIX} WHERE id = $1`, [mail], /changes no more/)
    })
    // A sweep committed earlier (as the owner, outside a rolled-back block) no longer opens the path.
    const earlier = randomUUID()
    await admin(`UPDATE "RetentionRule" SET "applyOn" = true, "applyOnAt" = now(), "applyOnById" = $2::uuid WHERE id = $1::uuid AND NOT "applyOn"`, [s.ruleIds.inboundMail, a.actorId])
    await admin(
      `INSERT INTO "RetentionSweep" (id, "tenantId", "ruleId", mode, "keepMonths", "thenAction", "cutoffOn", status, "startedAt")
       SELECT $1::uuid, r."tenantId", r.id, 'APPLY', r."keepMonths", r."thenAction", ("factory_money_rome_day"(now()) - make_interval(months => r."keepMonths"))::date, 'RUNNING', now() FROM "RetentionRule" r WHERE r.id = $2::uuid`,
      [earlier, s.ruleIds.inboundMail],
    )
    await asOwner(async () => {
      await refused(`UPDATE "InboundEmail" SET ${BLANK_SIX} WHERE id = $1`, [mail], /changes no more/)
    })
    await admin(`UPDATE "RetentionSweep" SET status = 'DONE', "finishedAt" = now() WHERE id = $1`, [earlier])
    await admin(`UPDATE "RetentionRule" SET "applyOn" = false, "applyOnAt" = NULL, "applyOnById" = NULL WHERE id = $1`, [s.ruleIds.inboundMail])
    expect(await one(`SELECT "fromAddress" FROM "InboundEmail" WHERE id = $1`, [mail])).toEqual({ fromAddress: 'old.sender.gf1@example.com' })
  })

  it('refuses a mail waiting for a person, a mail newer than the cut-off, another value, another column', async () => {
    const mail = await oldMail()
    await asOwner(async () => {
      await sweepNow()
      // TRIAGE waits for a person (and was received in October 2026: after the 24-month cut-off as well).
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL WHERE id = $1`, [A.triage], /what mail .* held was written when it was read; it never changes/)
      // A settled mail newer than the cut-off.
      const recent = await oldMail(new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL WHERE id = $1`, [recent], /changes no more/)
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = 'someone.else@example.com' WHERE id = $1`, [mail], /changes no more/)
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL, "to" = '{}' WHERE id = $1`, [mail], /changes no more/)
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL, "receivedAt" = "receivedAt" - interval '1 day' WHERE id = $1`, [mail], /changes no more|never changes/)
      await refused(`DELETE FROM "InboundEmail" WHERE id = $1`, [mail], /is never deleted/)
    })
  })

  it("refuses under a tenant-wide rule a mail whose company has an active rule of its own", async () => {
    const mail = await oldMail()
    await asOwner(async () => {
      await admin(
        `INSERT INTO "RetentionRule" (id, "tenantId", "companyId", key, "recordType", "keepMonths", "thenAction", "legalReason", active)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'retention:InboundEmail:' || $3, 'InboundEmail', 60, 'ANONYMISE', 'Made-up longer period of the company.', true)`,
        [randomUUID(), a.tenantId, A.companyA],
      )
      await sweepNow()
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL WHERE id = $1`, [mail], /changes no more/)
    })
  })
})
