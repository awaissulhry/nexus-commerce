import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedEmail } from '../seed/email'
import { seed as seedEmailIn } from '../seed/email-in'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPrivacyOps, type PrivacyOpsSeed } from '../seed/privacy-ops'
import { seed as seedThreads } from '../seed/threads'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import type { Prisma } from './generated/prisma/client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The guarded erasure of mail, messages, outbound mail and audit rows (B-W2b-F54, …_privacy_erasure_w2b_guards; GDPR art. 17;
 * PV1:01) on a database built from the migrations, through the real login and its scopes and as the owner login:
 *   - the door `factory_privacy_erase_row` (the office role only) blanks exactly the columns an erasure record of this
 *     transaction names (ANONYMISED, of an ERASURE request in progress), to their blank values, and refuses a record of an
 *     earlier transaction, a KEPT record, a mail still on its way, a message the system wrote;
 *   - the triggers let exactly those columns go blank, only in the same transaction as such a record, only to the blank
 *     value: refused without it, for another value, another column, a delete, for every login (the owner included);
 *   - the runtime roles still have no UPDATE on the append-only Message and AuditLog; the other ledgers of the audit
 *     function stay refused.
 * Every person, address and text is made up.
 */

const NS = 'w2b-f54-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: PrivacyOpsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  triage: key('email-in:triage'),
  rejected: key('email-in:virus'),
  partyMessage: key('threads:message:quote-in'),
  userMessage: key('threads:message:company-note'),
  quoteThread: key('threads:quote:Q1'),
  delivered: key('email:outbound:invitation'),
  failedMail: key('email:outbound:suppressed'),
  integrationCall: key('integration:call:ok'),
}
const INVITED = `invited.${NS}@example.com`
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
type Tx = Prisma.TransactionClient
/** One office transaction (the runtime login, the office role, row-level security). */
const inOffice = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => as(office(), (client) => client.$transaction((tx) => work(tx)))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, any>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const erasureRow = (recordType: string, recordId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  dataRequestId: s.requestIds.contactErasure,
  recordType,
  recordId,
  method: 'ANONYMISED',
  erasedById: a.actorId,
  ...extra,
})
/** Inside an office transaction: an erasure record, then the door (answers whether the row changed). */
async function erase(tx: Tx, recordType: string, recordId: string, erasedFields: string[], options: { addresses?: string[]; keys?: string[]; extra?: Record<string, unknown> } = {}): Promise<boolean> {
  const row = erasureRow(recordType, recordId, { erasedFields, ...options.extra })
  await tx.$executeRawUnsafe(...insertSql('ErasureRecord', row))
  return door(tx, row.id, options.addresses ?? [], options.keys ?? [])
}
async function door(tx: Tx, erasureId: string, addresses: string[] = [], keys: string[] = []): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<{ changed: boolean }[]>('SELECT "factory_privacy_erase_row"($1::uuid, $2::text[], $3::text[]) AS changed', erasureId, addresses, keys)
  return rows[0]!.changed
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
/** As the owner, inside asOwner: a statement refused, rolled back to a savepoint so the transaction goes on. */
async function refused(text: string, values: unknown[], pattern: RegExp): Promise<void> {
  await db.admin.query('SAVEPOINT refused')
  await expect(admin(text, values)).rejects.toThrow(pattern)
  await db.admin.query('ROLLBACK TO SAVEPOINT refused')
}
/** As the owner, inside asOwner: an erasure record of this transaction. */
async function ownerErasure(recordType: string, recordId: string, erasedFields: string[], extra: Record<string, unknown> = {}): Promise<void> {
  const [text, row] = insertSql('ErasureRecord', { ...erasureRow(recordType, recordId, { erasedFields, ...extra }), tenantId: a.tenantId })
  await admin(text, [row])
}

/** A made-up audit row of the former contact, the person's details inside (nested and in a list too). */
async function auditRow(): Promise<string> {
  const id = randomUUID()
  await inOffice((tx) =>
    tx.$executeRawUnsafe(
      ...insertSql('AuditLog', {
        id,
        companyId: A.companyA,
        audience: 'OFFICE',
        actorId: a.actorId,
        action: 'parties.updateContact',
        recordType: 'PartyContact',
        recordId: s.formerContactId,
        before: { name: 'Anna Esempio', email: 'anna.esempio@example.com', roles: ['ORDERS'], contact: { phone: '+39 000 0000099' }, history: [{ name: 'A. Esempio' }] },
        after: { name: 'Anna Esempio Bis', email: 'anna.bis@example.com', roles: ['ORDERS'], contact: { phone: null }, history: [] },
        reason: 'Made up for a test.',
        requestId: `f54-${id}`,
      }),
    ),
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('privacyerasew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedEmailIn({ db: factory, namespace: NS })
  await seedEmail({ db: factory, namespace: NS })
  await seedIntegration({ db: factory, namespace: NS })
  await seedThreads({ db: factory, namespace: NS })
  s = await seedPrivacyOps({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the door: an erasure blanks a mail, a message, a sent mail and an audit row (GDPR art. 17)', () => {
  it('blanks exactly the columns its erasure record of this transaction names, to their blank values; the rows stay', async () => {
    const audit = await auditRow()
    const changed = await inOffice(async (tx) => [
      await erase(tx, 'InboundEmail', A.triage, ['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml']),
      await erase(tx, 'InboundEmail', A.rejected, ['fromAddress', 'subject']),
      await erase(tx, 'Message', A.partyMessage, ['authorName', 'bodyText']),
      await erase(tx, 'EmailOutbound', A.delivered, ['to', 'subject'], { addresses: [`  ${INVITED.toUpperCase()} `] }),
      await erase(tx, 'AuditLog', audit, ['before', 'after'], { keys: ['name', 'email', 'phone'] }),
    ])
    expect(changed).toEqual([true, true, true, true, true])
    expect(await one(`SELECT "fromAddress", "fromName", subject, "bodyText", "bodyHtml", status::text, "envelopeFrom" IS NOT NULL AS envelope FROM "InboundEmail" WHERE id = $1`, [A.triage])).toEqual({
      fromAddress: null,
      fromName: null,
      subject: null,
      bodyText: null,
      bodyHtml: null,
      status: 'TRIAGE',
      envelope: true,
    })
    // A REJECTED mail changes no more, but for an erasure.
    expect(await one(`SELECT "fromAddress", subject, status::text FROM "InboundEmail" WHERE id = $1`, [A.rejected])).toEqual({ fromAddress: null, subject: null, status: 'REJECTED' })
    expect(await one(`SELECT "authorName", "bodyText", "authorKind"::text AS author, "threadId" FROM "Message" WHERE id = $1`, [A.partyMessage])).toEqual({ authorName: null, bodyText: '', author: 'PARTY', threadId: A.quoteThread })
    expect(await one(`SELECT "to", subject, status::text, "fromAddress" FROM "EmailOutbound" WHERE id = $1`, [A.delivered])).toEqual({ to: [''], subject: '', status: 'DELIVERED', fromAddress: `noreply@mail.company-a.${NS}.example.com` })
    const blanked = await one(`SELECT before, after, reason, action FROM "AuditLog" WHERE id = $1`, [audit])
    expect(blanked).toEqual({
      before: { name: null, email: null, roles: ['ORDERS'], contact: { phone: null }, history: [{ name: null }] },
      after: { name: null, email: null, roles: ['ORDERS'], contact: { phone: null }, history: [] },
      reason: 'Made up for a test.',
      action: 'parties.updateContact',
    })
  })

  it('answers false when the row holds nothing more to blank (a second erasure of it)', async () => {
    expect(await inOffice((tx) => erase(tx, 'Message', A.partyMessage, ['authorName', 'bodyText']))).toBe(false)
  })

  it('refuses a record of an earlier transaction, a KEPT record, a mail on its way, a system message, another table', async () => {
    // A record written (and committed) before: the door no longer takes it.
    const earlier = erasureRow('Message', A.userMessage, { erasedFields: ['bodyText'] })
    await inOffice((tx) => tx.$executeRawUnsafe(...insertSql('ErasureRecord', earlier)))
    await expect(inOffice((tx) => door(tx, earlier.id))).rejects.toThrow(/was not written in this transaction/)
    await expect(inOffice((tx) => erase(tx, 'Message', A.userMessage, [], { extra: { method: 'KEPT', keptFields: ['bodyText'], keptWhy: 'Kept for a test.' } }))).rejects.toThrow(/only when it anonymises it for an erasure request \(it is KEPT\)/)
    await expect(inOffice((tx) => door(tx, randomUUID()))).rejects.toThrow(/is not an erasure record of this tenant/)
    await expect(inOffice((tx) => erase(tx, 'Message', A.userMessage, ['at']))).rejects.toThrow(/blanks only its author's name, its text and its HTML/)
    await expect(inOffice((tx) => erase(tx, 'PartyContact', s.formerContactId, ['name']))).rejects.toThrow(/only received and sent mail, messages and audit rows are blanked through this door/)
    // A mail still on its way keeps what it sends.
    const queued = randomUUID()
    await inOffice((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "EmailOutbound" (id, "companyId", "identityId", "templateKey", locale, "fromAddress", "fromName", "to", subject, "emailMessageId", "queuedAt")
         SELECT $1::uuid, "companyId", "identityId", "templateKey", locale, "fromAddress", "fromName", ARRAY['queued.f54@example.com'], 'Made-up queued mail', '<' || $1 || '@example.com>', now()
           FROM "EmailOutbound" WHERE id = $2::uuid`,
        queued,
        A.failedMail,
      ),
    )
    await expect(inOffice((tx) => erase(tx, 'EmailOutbound', queued, ['to'], { addresses: ['queued.f54@example.com'] }))).rejects.toThrow(/is still on its way \(QUEUED\)/)
    const system = randomUUID()
    await inOffice((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "Message" (id, "threadId", direction, audience, channel, "authorKind", "bodyText", at) VALUES ($1::uuid, $2::uuid, 'INTERNAL_NOTE', 'OFFICE', 'APP', 'SYSTEM', 'Made-up system note.', now())`,
        system,
        A.quoteThread,
      ),
    )
    await expect(inOffice((tx) => erase(tx, 'Message', system, ['bodyText']))).rejects.toThrow(/was written by the system, not by a person/)
    // Nothing of them moved.
    expect(await one(`SELECT "bodyText" FROM "Message" WHERE id = $1`, [A.userMessage])).toEqual({ bodyText: 'Seed note: the cost sheet for the new season is attached.' })
    expect(await one(`SELECT "to" FROM "EmailOutbound" WHERE id = $1`, [queued])).toEqual({ to: ['queued.f54@example.com'] })
  })

  it('is the office role\'s only: no other scope may run it, and the runtime still has no UPDATE on the append-only rows', async () => {
    await expect(as({ audience: 'platform' }, (client) => client.$queryRawUnsafe('SELECT "factory_privacy_erase_row"($1::uuid, $2::text[], $3::text[])', randomUUID(), [], []))).rejects.toThrow(/permission denied for function factory_privacy_erase_row/)
    await expect(inOffice((tx) => tx.$executeRawUnsafe(`UPDATE "Message" SET "bodyText" = '' WHERE id = $1::uuid`, A.userMessage))).rejects.toThrow(/permission denied for table Message/)
    await expect(inOffice((tx) => tx.$executeRawUnsafe(`UPDATE "AuditLog" SET before = NULL WHERE "recordType" = 'Site'`))).rejects.toThrow(/permission denied for table AuditLog/)
  })
})

describe('the triggers: exactly these columns go blank, only with an erasure record of the same transaction, for every login', () => {
  it('a message: refused without the record, for another value, another column, a column the record does not name, a delete; allowed blank', async () => {
    const id = A.userMessage
    await asOwner(async () => {
      await refused(`UPDATE "Message" SET "bodyText" = '' WHERE id = $1`, [id], /append-only: UPDATE on "Message" is refused/)
    })
    await asOwner(async () => {
      await ownerErasure('Message', id, ['bodyText'])
      await refused(`UPDATE "Message" SET "bodyText" = 'Another text' WHERE id = $1`, [id], /append-only: UPDATE on "Message" is refused/)
    })
    await asOwner(async () => {
      await ownerErasure('Message', id, ['bodyText'])
      await refused(`UPDATE "Message" SET "bodyText" = '', at = at + interval '1 minute' WHERE id = $1`, [id], /append-only/)
    })
    await asOwner(async () => {
      await ownerErasure('Message', id, ['bodyText'])
      await refused(`UPDATE "Message" SET "authorName" = NULL WHERE id = $1`, [id], /append-only/)
    })
    await asOwner(async () => {
      await ownerErasure('Message', id, ['bodyText'])
      await refused(`DELETE FROM "Message" WHERE id = $1`, [id], /append-only: DELETE on "Message" is refused/)
    })
    await asOwner(async () => {
      await ownerErasure('Message', id, ['bodyText', 'authorName'])
      expect((await db.admin.query(`UPDATE "Message" SET "bodyText" = '', "authorName" = NULL WHERE id = $1`, [id])).rowCount).toBe(1)
    })
  })

  it('a message: a record of an earlier transaction, a KEPT record or one of an access request does not open it', async () => {
    // Committed before (the first describe's door call wrote one for the party message).
    expect((await admin(`SELECT count(*)::int AS n FROM "ErasureRecord" WHERE "recordId" = $1 AND method = 'ANONYMISED'`, [A.partyMessage]))[0]!.n).toBeGreaterThan(0)
    await asOwner(async () => {
      await refused(`UPDATE "Message" SET "bodyText" = '' WHERE id = $1`, [A.userMessage], /append-only/)
    })
    await asOwner(async () => {
      await ownerErasure('Message', A.userMessage, [], { method: 'KEPT', keptFields: ['bodyText'], keptWhy: 'Kept for a test.' })
      await refused(`UPDATE "Message" SET "bodyText" = '' WHERE id = $1`, [A.userMessage], /append-only/)
    })
    await asOwner(async () => {
      await expect(ownerErasure('Message', A.userMessage, ['bodyText'], { dataRequestId: s.requestIds.memberAccess })).rejects.toThrow(/is done for an erasure request of its company that is in progress/)
    })
  })

  it('a received mail: only the sender, its name, subject, text and HTML, to NULL; never what SES said, never a delete', async () => {
    const id = key('email-in:held')
    await asOwner(async () => {
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL WHERE id = $1`, [id], /what mail .* held was written when it was read; it never changes/)
    })
    await asOwner(async () => {
      await ownerErasure('InboundEmail', id, ['fromAddress', 'subject'])
      await refused(`UPDATE "InboundEmail" SET subject = 'Another subject' WHERE id = $1`, [id], /never changes/)
      await refused(`UPDATE "InboundEmail" SET "fromAddress" = NULL, "envelopeFrom" = NULL WHERE id = $1`, [id], /what SES said about mail .* never changes/)
      await refused(`UPDATE "InboundEmail" SET "bodyText" = NULL WHERE id = $1`, [id], /never changes/)
      await refused(`DELETE FROM "InboundEmail" WHERE id = $1`, [id], /is never deleted/)
    })
    await asOwner(async () => {
      await ownerErasure('InboundEmail', id, ['fromAddress', 'subject'])
      expect((await db.admin.query(`UPDATE "InboundEmail" SET "fromAddress" = NULL, subject = NULL WHERE id = $1`, [id])).rowCount).toBe(1)
    })
  })

  it('a sent mail: an address of the list to \'\' and the subject to \'\', once it is no longer on its way; nothing else', async () => {
    const id = A.failedMail
    await asOwner(async () => {
      await refused(`UPDATE "EmailOutbound" SET "to" = ARRAY[''] WHERE id = $1`, [id], /what mail .* sends never changes/)
    })
    await asOwner(async () => {
      await ownerErasure('EmailOutbound', id, ['to', 'subject'])
      await refused(`UPDATE "EmailOutbound" SET "to" = ARRAY['someone.else@example.com'] WHERE id = $1`, [id], /never changes/)
      await refused(`UPDATE "EmailOutbound" SET "to" = ARRAY[]::text[] WHERE id = $1`, [id], /never changes/)
      await refused(`UPDATE "EmailOutbound" SET "to" = ARRAY[''], bcc = ARRAY['x@example.com'] WHERE id = $1`, [id], /never changes/)
      await refused(`UPDATE "EmailOutbound" SET "cc" = ARRAY['']::text[] WHERE id = $1`, [id], /never changes/)
      await refused(`DELETE FROM "EmailOutbound" WHERE id = $1`, [id], /is never deleted/)
    })
    await asOwner(async () => {
      await ownerErasure('EmailOutbound', id, ['to', 'subject'])
      expect((await db.admin.query(`UPDATE "EmailOutbound" SET "to" = ARRAY[''], subject = '' WHERE id = $1`, [id])).rowCount).toBe(1)
    })
    // A mail on its way: refused even with the record.
    const queued = (await one(`SELECT id FROM "EmailOutbound" WHERE status = 'QUEUED' AND "tenantId" = $1 LIMIT 1`, [a.tenantId])).id as string
    await asOwner(async () => {
      await ownerErasure('EmailOutbound', queued, ['to'])
      await refused(`UPDATE "EmailOutbound" SET "to" = ARRAY[''] WHERE id = $1`, [queued], /never changes/)
    })
  })

  it('an audit row: values inside before and after to JSON null; never a key, another value, another column or the row', async () => {
    const id = await auditRow()
    await asOwner(async () => {
      await refused(`UPDATE "AuditLog" SET before = before || '{"name": null}' WHERE id = $1`, [id], /append-only: UPDATE on "AuditLog" is refused/)
    })
    await asOwner(async () => {
      await ownerErasure('AuditLog', id, ['before'])
      await refused(`UPDATE "AuditLog" SET before = before || '{"name": "Someone else"}' WHERE id = $1`, [id], /append-only/)
      await refused(`UPDATE "AuditLog" SET before = before - 'name' WHERE id = $1`, [id], /append-only/)
      await refused(`UPDATE "AuditLog" SET before = jsonb_set(before, '{history}', '[]') WHERE id = $1`, [id], /append-only/)
      await refused(`UPDATE "AuditLog" SET before = NULL WHERE id = $1`, [id], /append-only/)
      await refused(`UPDATE "AuditLog" SET before = before || '{"name": null}', reason = NULL WHERE id = $1`, [id], /append-only/)
      await refused(`UPDATE "AuditLog" SET after = after || '{"name": null}' WHERE id = $1`, [id], /append-only/)
      await refused(`DELETE FROM "AuditLog" WHERE id = $1`, [id], /append-only: DELETE on "AuditLog" is refused/)
    })
    await asOwner(async () => {
      await ownerErasure('AuditLog', id, ['before'])
      expect((await db.admin.query(`UPDATE "AuditLog" SET before = jsonb_set(before || '{"name": null}', '{contact}', 'null') WHERE id = $1`, [id])).rowCount).toBe(1)
    })
  })

  it('leaves the other ledgers of the audit function and every TRUNCATE refused', async () => {
    await asOwner(async () => {
      await refused(`UPDATE "IntegrationCall" SET operation = operation || '' WHERE id = $1`, [A.integrationCall], /append-only: UPDATE on "IntegrationCall" is refused/)
    })
    for (const table of ['AuditLog', 'Message', 'InboundEmail', 'EmailOutbound']) {
      await asOwner(async () => {
        await expect(admin(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow(/TRUNCATE on "[A-Za-z]+" is refused/)
      })
    }
  })
})
