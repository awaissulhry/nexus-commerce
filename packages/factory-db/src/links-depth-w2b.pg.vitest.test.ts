import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinksDepth, type LinksDepthSeed } from '../seed/links-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * Links in depth (W2b schema wave 19/22, B-W2b-154, …_links_depth_w2b_guards) on a database built from the migrations and
 * seeded, through the real login and the scoped client:
 *   - grants: a partner (portal or link session) reads its own party's link files, drafts, shares, approval requests and
 *     concessions, never another party's, never the password hash nor the office people; the office never reads a draft's
 *     data; the floor reads none of it; no pay record ever goes by link, share or approval;
 *   - links: a password only as a scrypt hash, on a DOCUMENT_VIEW or SECURE_FILE link; the receipt once, on a SECURE_FILE
 *     link that is not revoked; five wrong passwords hold the link up to 15 minutes; a renewal of the same record and
 *     purpose; the new columns fixed;
 *   - link files: added while the link is unused, of its company, available; never changed or removed;
 *   - drafts: sealed, only for a long form, only while the link opens, purged 7 days after its expiry;
 *   - record shares: VIEW always, at most 180 days, a RECORD_INVITE link of the record; the party switches its e-mail only;
 *     revoked once and frozen;
 *   - approval requests: OPEN, answered once by the party (typed name, one answerer, words for a change or a refusal),
 *     withdrawn or expired by the office; the APPROVAL link of the request; final states frozen;
 *   - concessions: the request named once while ASKED; the customer writes the answer columns only, as its request was
 *     answered first, never the cost lines.
 * The refusals are check_violation (SQLSTATE 23514) or restrict_violation (23001); their messages are read through raw SQL.
 */

const NS = 'w2b-154-a'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: LinksDepthSeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const P2 = key('party:P2')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: key('worker:A1:operator'), siteId: key('site:A1') })
const partner = (partyId: string = P1): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes`. */
const copyRow = (table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()) =>
  run(
    scope,
    `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`,
    JSON.stringify(changes),
    id,
  )
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** Runs `text` as the owner with the triggers off: to put a row in a state the guards only reach with time. */
async function bypass(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const token = (): string => `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const HASH = '$scrypt$ln=15,r=8,p=3$c2VlZC10ZXN0LXNhbHQtMDE$c2VlZC10ZXN0LWhhc2gtb2Ytbm90aGluZy1hdC1hbGwtMDA'
const SEALED = 'l1.AAAAAAAAAAAAAAAA.c2VlZCBkcmFmdA.BBBBBBBBBBBBBBBBBBBBBB'
/** A new link of company A, unused, made from the seed's unopened DOCUMENT_VIEW link with `changes`. */
async function newLink(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow('OneOffLink', seeded.links.fileSet, { id, tokenHash: token(), note: null, ...changes })
  return id
}
/** A new approval request of P1, OPEN, made from the seed's OPEN sample request with `changes`. */
async function newRequest(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow('ApprovalRequest', seeded.approvals.sample, { id, ...changes })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('linksdepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seeded = await seedLinksDepth({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the four models: office and partner only, no floor, none personal data', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'links-depth.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['ApprovalRequest', 'LinkDraft', 'LinkFile', 'RecordShare'])
    for (const { model, ownership: entry } of models) expect(Object.keys(entry.access).sort(), model.name).toEqual(['factory_partner_runtime', 'factory_runtime'])
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
    const all = classifiedModels(loadSchema(), ownership)
    expect(all.find(({ model }) => model.name === 'OneOffLink')!.ownership.access.factory_partner_runtime!.hiddenColumns).toContain('passwordHash')
    expect(all.find(({ model }) => model.name === 'NcrConcession')!.ownership.access.factory_partner_runtime).toMatchObject({ privileges: ['select', 'update'], scopedBy: ['party'] })
    expect(Object.keys(all.find(({ model }) => model.name === 'NcrCostLine')!.ownership.access)).toEqual(['factory_runtime'])
  })

  it('the seed: a file set, a secure file received, a live draft, two shares, three requests and the concession answered by the customer', async () => {
    const links = await sql(office(), `SELECT id, purpose::text, uses, "passwordTries", "receivedName", "renewalOfId" FROM "OneOffLink" WHERE id = ANY($1::uuid[]) ORDER BY purpose`, Object.values(seeded.links))
    expect(links.map((row) => [row.purpose, row.uses])).toEqual([
      ['APPROVAL', 1],
      ['DOCUMENT_VIEW', 0],
      ['MEASUREMENTS', 0],
      ['PO_CONFIRM', 0],
      ['RECORD_INVITE', 0],
      ['SECURE_FILE', 1],
    ])
    expect(links.find((row) => row.purpose === 'SECURE_FILE')).toMatchObject({ receivedName: 'Seed Buyer One', passwordTries: 0 })
    expect(links.find((row) => row.purpose === 'PO_CONFIRM')!.renewalOfId).toBe(key('link:P2'))
    expect(await sql(office(), `SELECT status::text FROM "ApprovalRequest" WHERE "partyId" = $1::uuid ORDER BY status`, P1)).toEqual([{ status: 'APPROVED_WITH_CHANGES' }, { status: 'OPEN' }, { status: 'WITHDRAWN' }])
    expect(await sql(office(), `SELECT status::text, "recordedById", "approvalRequestId" FROM "NcrConcession" WHERE id = $1::uuid`, seeded.concessionId)).toEqual([
      { status: 'ACCEPTED', recordedById: null, approvalRequestId: seeded.approvals.concession },
    ])
    const actions = await sql(office(), `SELECT action::text FROM "LinkEvidence" WHERE "linkId" = ANY($1::uuid[]) ORDER BY at, action`, [seeded.links.secureFile, seeded.links.approval])
    expect(actions.map((row) => row.action).sort()).toEqual(['APPROVED', 'DOWNLOADED', 'OPENED', 'OPENED', 'RECEIVED'])
  })

  it('a partner reads its own party only, never the password hash or the office people; the office never reads a draft', async () => {
    expect((await sql(partner(), 'SELECT id FROM "LinkFile"')).length).toBe(4)
    expect((await sql(partner(), 'SELECT id FROM "LinkDraft"')).length).toBe(1)
    expect(await sql(partner(), 'SELECT id FROM "RecordShare"')).toEqual([{ id: seeded.shares.invite }])
    expect(await sql(partner(P2), 'SELECT id FROM "RecordShare"')).toEqual([{ id: seeded.shares.supplier }])
    expect((await sql(partner(P2), 'SELECT id FROM "ApprovalRequest"')).length).toBe(0)
    expect((await sql(partner(), 'SELECT id FROM "ApprovalRequest"')).length).toBe(3)
    expect((await sql(partner(), 'SELECT id FROM "NcrConcession"')).length).toBeGreaterThan(0)
    expect((await sql(partner(P2), 'SELECT id FROM "NcrConcession"')).length).toBe(0)
    await expect(sql(partner(), 'SELECT "passwordHash" FROM "OneOffLink"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "createdById" FROM "RecordShare"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "withdrawnById" FROM "ApprovalRequest"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "recordedById" FROM "NcrConcession"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT id FROM "NcrCostLine"')).rejects.toThrow(DENIED)
    await expect(sql(office(), 'SELECT "dataEnc" FROM "LinkDraft"')).rejects.toThrow(DENIED)
    expect(await sql(office(), 'SELECT id, "purgeAfter" IS NOT NULL AS purged FROM "LinkDraft"')).toEqual([{ id: seeded.draft, purged: true }])
    for (const table of ['LinkFile', 'LinkDraft', 'RecordShare', 'ApprovalRequest']) await expect(sql(floor(), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    await expect(run(partner(), `INSERT INTO "LinkFile" (id, "partyId", "linkId", "fileId", position) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 9)`, randomUUID(), P1, seeded.links.fileSet, seeded.files.doc)).rejects.toThrow(DENIED)
  })

  it('keeps the list of pay records equal to the schema: every model of pay.prisma with a pay figure but the payroll export', async () => {
    const schema = loadSchema()
    const payModels = schema.filter((model) => model.fields.some((field) => (field.tags ?? []).some((tag) => tag === '@grain pay' || tag === '@grain wages'))).map((model) => model.name)
    expect(payModels.length).toBeGreaterThan(3)
    for (const name of payModels) {
      const [{ pay }] = (await admin(`SELECT "factory_link_pay_record"($1) AS pay`, [name])) as [{ pay: boolean }]
      expect(pay, name).toBe(name !== 'PayrollExport')
    }
    const payFile = schema.filter((model) => model.file === 'pay.prisma').map((model) => model.name)
    for (const name of ['PieceRateTable', 'PieceRateVersion', 'RatePublication', 'RateAcknowledgement', 'PayPeriod']) {
      expect(payFile, name).toContain(name)
      expect(((await admin(`SELECT "factory_link_pay_record"($1) AS pay`, [name])) as [{ pay: boolean }])[0].pay, name).toBe(true)
    }
    for (const name of ['Quote', 'StoredFile', 'PayrollExport', 'Shipment']) expect(((await admin(`SELECT "factory_link_pay_record"($1) AS pay`, [name])) as [{ pay: boolean }])[0].pay, name).toBe(false)
  })
})

describe('one-off links in depth', () => {
  it('a password only as a scrypt hash, on a DOCUMENT_VIEW or SECURE_FILE link; never a pay record; a new link has no receipt', async () => {
    await expect(newLink({ purpose: 'SECURE_FILE', passwordHash: 'letmein-2026' })).rejects.toThrow(/scrypt hash/)
    await expect(newLink({ purpose: 'QUOTE_ACCEPT', recordType: 'Quote', passwordHash: HASH })).rejects.toThrow(/only a DOCUMENT_VIEW or SECURE_FILE link takes a password/)
    expect(await newLink({ purpose: 'SECURE_FILE', passwordHash: HASH })).toBeTruthy()
    await expect(newLink({ purpose: 'SECURE_FILE', recordType: 'WorkerStatement' })).rejects.toThrow(/pay figures/)
    await expect(newLink({ purpose: 'DOCUMENT_VIEW', recordType: 'EarningsEntry' })).rejects.toThrow(/pay figures/)
    // B-W2b-54's payroll file goes by a DOCUMENT_VIEW link of its export today; whether an hours-only file may is the API's.
    expect(await newLink({ purpose: 'DOCUMENT_VIEW', recordType: 'PayrollExport' })).toBeTruthy()
    await expect(newLink({ purpose: 'SECURE_FILE', receivedAt: '2026-10-29T10:00:00Z' })).rejects.toThrow(/no receipt and no wrong password/)
    await expect(newLink({ passwordTries: 1, passwordHash: HASH })).rejects.toThrow(/no receipt and no wrong password/)
  })

  it('a renewal opens the same record for the same purpose; the password, contact and renewal stay fixed', async () => {
    const old = seeded.links.fileSet
    const renewal = await newLink({ renewalOfId: old })
    const self = randomUUID()
    await expect(copyRow('OneOffLink', old, { id: self, tokenHash: token(), renewalOfId: self })).rejects.toThrow(/cannot renew itself/)
    await expect(newLink({ renewalOfId: old, recordId: randomUUID() })).rejects.toThrow(/another record or serves another purpose/)
    await expect(newLink({ renewalOfId: old, purpose: 'SECURE_FILE' })).rejects.toThrow(/another record or serves another purpose/)
    await expect(update(office(), 'OneOffLink', renewal, `"renewalOfId" = NULL`)).rejects.toThrow(/fixed once made/)
    await expect(update(office(), 'OneOffLink', seeded.links.secureFile, `"passwordHash" = NULL`)).rejects.toThrow(/fixed once made/)
    await expect(update(office(), 'OneOffLink', renewal, `"contactId" = NULL`)).rejects.toThrow(/fixed once made/)
  })

  it('the receipt: once, by the link session, on a SECURE_FILE link that is not revoked', async () => {
    const link = await newLink({ purpose: 'SECURE_FILE' })
    await expect(update(partner(), 'OneOffLink', seeded.links.fileSet, `"receivedAt" = now()`)).rejects.toThrow(/only a SECURE_FILE link takes the receipt/)
    await expect(update(partner(), 'OneOffLink', link, `"receivedName" = 'Seed Buyer One'`)).rejects.toThrow(/has its time/)
    expect(await update(partner(), 'OneOffLink', link, `"receivedAt" = now(), "receivedName" = 'Seed Buyer One'`)).toBe(1)
    await expect(update(partner(), 'OneOffLink', link, `"receivedName" = 'Someone else'`)).rejects.toThrow(/written once/)
    const revoked = await newLink({ purpose: 'SECURE_FILE' })
    expect(await update(office(), 'OneOffLink', revoked, `"revokedAt" = now(), "revokedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(partner(), 'OneOffLink', revoked, `"receivedAt" = now()`)).rejects.toThrow(/revoked; it takes no receipt/)
  })

  it('five wrong passwords hold the link up to 15 minutes; nothing moves while it holds; then the count starts again', async () => {
    const link = await newLink({ purpose: 'SECURE_FILE', passwordHash: HASH })
    const tries = (set: string) => update(partner(), 'OneOffLink', link, set)
    await expect(update(partner(), 'OneOffLink', seeded.links.fileSet, `"passwordTries" = 1`)).rejects.toThrow(/has no password/)
    expect(await tries(`"passwordTries" = 1`)).toBe(1)
    await expect(tries(`"passwordTries" = 3`)).rejects.toThrow(/one at a time/)
    expect(await tries(`"passwordTries" = 0`)).toBe(1)
    for (const n of [1, 2, 3, 4]) expect(await tries(`"passwordTries" = ${n}`)).toBe(1)
    await expect(tries(`"passwordTries" = 5`)).rejects.toThrow(/only the fifth/)
    await expect(tries(`"passwordTries" = 5, "passwordHeldUntil" = now() + interval '1 hour'`)).rejects.toThrow(/up to 15 minutes/)
    expect(await tries(`"passwordTries" = 5, "passwordHeldUntil" = now() + interval '15 minutes'`)).toBe(1)
    await expect(tries(`"passwordTries" = 0, "passwordHeldUntil" = NULL`)).rejects.toThrow(/is held after five wrong passwords/)
    await bypass(`UPDATE "OneOffLink" SET "passwordHeldUntil" = now() - interval '1 minute' WHERE id = $1::uuid`, [link])
    expect(await tries(`"passwordTries" = 1, "passwordHeldUntil" = NULL`)).toBe(1)
  })

  it('records the new evidence actions', async () => {
    for (const action of ['DOWNLOADED', 'RECEIVED', 'SUBMITTED', 'APPROVED', 'REFUSED', 'PAID', 'MOVED_DATE', 'POSTED', 'UPLOADED']) {
      expect(
        await run(
          partner(),
          `INSERT INTO "LinkEvidence" (id, "partyId", "linkId", action, "emailCheck", at, "requestId") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"LinkEvidenceAction", 'NOT_ASKED', now(), 'test')`,
          randomUUID(),
          P1,
          seeded.links.fileSet,
          action,
        ),
      ).toBe(1)
    }
  })
})

describe('link files', () => {
  const add = (linkId: string, fileId: string, position = 7) =>
    run(office(), `INSERT INTO "LinkFile" (id, "partyId", "linkId", "fileId", position) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`, randomUUID(), P1, linkId, fileId, position)

  it('are added to an unused DOCUMENT_VIEW or SECURE_FILE link: available files of its company, never a pay record', async () => {
    const link = await newLink()
    expect(await add(link, seeded.files.doc, 1)).toBe(1)
    await expect(add(link, seeded.files.leaflet, 0)).rejects.toThrow(/numbered from 1/)
    await expect(add(seeded.links.secureFile, seeded.files.doc)).rejects.toThrow(/used or revoked/)
    await expect(add(seeded.links.approval, seeded.files.doc)).rejects.toThrow(/only a DOCUMENT_VIEW or SECURE_FILE link has a set of files/)
    await expect(add(link, key('files:pending'))).rejects.toThrow(/a link shares an available file only/)
    await expect(add(link, key('files:floor:B1'))).rejects.toThrow(/another company's/)
    const payFile = randomUUID()
    await copyRow('StoredFile', seeded.files.techPack, { id: payFile, storageKey: `t/${a.tenantId}/c/${key('company:A')}/2026/${randomUUID()}`, recordType: 'WorkerStatement' })
    await expect(add(link, payFile)).rejects.toThrow(/pay figures never go by link/)
  })

  it('never change and are never removed', async () => {
    const [first] = seeded.linkFiles
    await expect(update(office(), 'LinkFile', first!, `position = 3`)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "LinkFile" SET position = 3 WHERE id = $1`, [first])).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "LinkFile" WHERE id = $1`, [first])).rejects.toThrow(/never removed/)
    await expect(admin(`TRUNCATE "LinkFile"`)).rejects.toThrow(/TRUNCATE/)
  })
})

describe('drafts', () => {
  const live = async (changes: Record<string, unknown> = {}) => {
    const expiresAt = new Date(Date.now() + 5 * 86_400_000)
    const link = await newLink({ purpose: 'MEASUREMENTS', maxUses: 1, createdAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: expiresAt.toISOString(), ...changes })
    return { link, purgeAfter: new Date(expiresAt.getTime() + 7 * 86_400_000).toISOString() }
  }
  const save = (linkId: string, purgeAfter: string, data = SEALED) =>
    run(partner(), `INSERT INTO "LinkDraft" (id, "partyId", "linkId", "dataEnc", "purgeAfter") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)`, randomUUID(), P1, linkId, data, purgeAfter)

  it('are sealed, only for a long form, purged 7 days after the link expires, saved again with the version', async () => {
    const { link, purgeAfter } = await live()
    await expect(save(link, purgeAfter, '{"chest": "100"}')).rejects.toThrow(/sealed/)
    await expect(save(link, new Date().toISOString())).rejects.toThrow(/purged 7 days after its link expires/)
    const other = await newLink({ purpose: 'SECURE_FILE' })
    await expect(save(other, purgeAfter)).rejects.toThrow(/only a long form keeps a draft/)
    expect(await save(link, purgeAfter)).toBe(1)
    const [{ id }] = (await sql(partner(), `SELECT id FROM "LinkDraft" WHERE "linkId" = $1::uuid`, link)) as [{ id: string }]
    expect(await update(partner(), 'LinkDraft', id, `"dataEnc" = $2, version = version + 1`, SEALED.replace('l1.', 'l2.'))).toBe(1)
    await expect(update(partner(), 'LinkDraft', id, `"dataEnc" = $2`, SEALED)).rejects.toThrow(/goes up by one with every save/)
    await expect(update(partner(), 'LinkDraft', id, `"purgeAfter" = now(), version = version + 1`)).rejects.toThrow(/stays with its link/)
    expect(await run(partner(), `DELETE FROM "LinkDraft" WHERE id = $1::uuid`, id)).toBe(1)
  })

  it('are saved only while the link opens: never revoked, expired or used up', async () => {
    const revoked = await live()
    await update(office(), 'OneOffLink', revoked.link, `"revokedAt" = now(), "revokedById" = $2::uuid`, a.actorId)
    await expect(save(revoked.link, revoked.purgeAfter)).rejects.toThrow(/no longer opens/)
    const used = await live()
    await update(partner(), 'OneOffLink', used.link, `uses = 1`)
    await expect(save(used.link, used.purgeAfter)).rejects.toThrow(/no longer opens/)
    const expiredAt = new Date(Date.now() - 86_400_000)
    const expired = await newLink({ purpose: 'CLAIM', createdAt: new Date(expiredAt.getTime() - 86_400_000).toISOString(), expiresAt: expiredAt.toISOString() })
    await expect(save(expired, new Date(expiredAt.getTime() + 7 * 86_400_000).toISOString())).rejects.toThrow(/no longer opens/)
  })

  it('the purge job deletes them in the office scope', async () => {
    const { link, purgeAfter } = await live({ purpose: 'SUPPLIER_ONBOARD' })
    await save(link, purgeAfter)
    expect(await run(office(), `DELETE FROM "LinkDraft" WHERE "linkId" = $1::uuid AND "purgeAfter" > now()`, link)).toBe(1)
  })
})

describe('record shares', () => {
  const share = (changes: Record<string, unknown> = {}) => copyRow('RecordShare', seeded.shares.supplier, { id: randomUUID(), ...changes })

  it('allow VIEW, each permission once, at most 180 days, to one address; never a pay record', async () => {
    await expect(share({ permissions: ['COMMENT'] })).rejects.toThrow(/allows VIEW/)
    await expect(share({ permissions: ['VIEW', 'UPLOAD', 'UPLOAD'] })).rejects.toThrow(/allows VIEW/)
    await expect(share({ expiresAt: '2027-12-31T00:00:00Z' })).rejects.toThrow(/at most 180 days/)
    await expect(share({ email: 'Orders.P2@Example.com' })).rejects.toThrow(/trimmed and lower case/)
    await expect(share({ recordType: 'EarningsEntry' })).rejects.toThrow(/pay figures/)
    await expect(share({ revokedAt: '2026-10-29T00:00:00Z' })).rejects.toThrow(/a new share is live/)
    expect(await share({ permissions: ['VIEW', 'COMMENT', 'UPLOAD'] })).toBe(1)
  })

  it('open through a RECORD_INVITE link of the record that never outlives them, set once', async () => {
    const id = randomUUID()
    await share({ id })
    const invite = await newLink({ partyId: P2, contactId: null, purpose: 'RECORD_INVITE', recordType: 'PurchaseOrder', recordId: key('link:P2:record'), expiresAt: '2026-11-20T00:00:00Z' })
    const wrongPurpose = await newLink({ partyId: P2, contactId: null, purpose: 'DOCUMENT_VIEW', recordType: 'PurchaseOrder', recordId: key('link:P2:record') })
    const outliving = await newLink({ partyId: P2, contactId: null, purpose: 'RECORD_INVITE', recordType: 'PurchaseOrder', recordId: key('link:P2:record'), expiresAt: '2026-12-31T00:00:00Z' })
    await expect(update(office(), 'RecordShare', id, `"linkId" = $2::uuid`, wrongPurpose)).rejects.toThrow(/RECORD_INVITE link of the shared record/)
    await expect(update(office(), 'RecordShare', id, `"linkId" = $2::uuid`, outliving)).rejects.toThrow(/never outlives the share/)
    expect(await update(office(), 'RecordShare', id, `"linkId" = $2::uuid, version = version + 1`, invite)).toBe(1)
    await expect(update(office(), 'RecordShare', id, `"linkId" = $2::uuid`, outliving)).rejects.toThrow(/set once/)
  })

  it('the invited party switches its e-mail only; a revoked share is frozen and never deleted', async () => {
    const invite = seeded.shares.invite
    expect(await update(partner(), 'RecordShare', invite, `"notifyByEmail" = false, version = version + 1`)).toBe(1)
    await expect(update(partner(), 'RecordShare', invite, `permissions = ARRAY['VIEW', 'COMMENT', 'UPLOAD']::"RecordSharePermission"[]`)).rejects.toThrow(/only switches the e-mail/)
    await expect(update(partner(), 'RecordShare', invite, `"expiresAt" = "expiresAt" + interval '1 day'`)).rejects.toThrow(/only switches the e-mail/)
    await expect(update(office(), 'RecordShare', invite, `"recordId" = $2::uuid`, randomUUID())).rejects.toThrow(/never change/)
    const id = randomUUID()
    await share({ id })
    expect(await update(office(), 'RecordShare', id, `permissions = ARRAY['VIEW', 'UPLOAD']::"RecordSharePermission"[], version = version + 1`)).toBe(1)
    await expect(update(office(), 'RecordShare', id, `"revokedById" = $2::uuid`, a.actorId)).rejects.toThrow(/names who revoked it/)
    expect(await update(office(), 'RecordShare', id, `"revokedAt" = now(), "revokedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'RecordShare', id, `"notifyByEmail" = false`)).rejects.toThrow(/revoked; it never changes again/)
    await expect(admin(`DELETE FROM "RecordShare" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })
})

describe('approval requests', () => {
  const answer = (id: string, linkId: string, status = 'APPROVED', more = '') =>
    update(
      partner(),
      'ApprovalRequest',
      id,
      `status = '${status}', "typedName" = 'Seed Buyer One', "answeredAt" = now(), "answeredViaLinkId" = $2::uuid, "answerRequestId" = 'test-answer', version = version + 1${more}`,
      linkId,
    )
  const approvalLink = (requestId: string) => newLink({ purpose: 'APPROVAL', recordType: 'ApprovalRequest', recordId: requestId, maxUses: 1 })

  it('start OPEN; a CONCESSION names an asked concession of its own customer; never a pay record', async () => {
    await expect(newRequest({ status: 'APPROVED' })).rejects.toThrow(/a new approval request is OPEN/)
    await expect(newRequest({ kind: 'CONCESSION', recordType: 'Style' })).rejects.toThrow(/names an NCR's concession/)
    await expect(newRequest({ kind: 'CONCESSION', recordType: 'NcrConcession', recordId: seeded.concessionId })).rejects.toThrow(/while the concession is ASKED/)
    await expect(newRequest({ recordType: 'WorkerStatement' })).rejects.toThrow(/pay figures/)
    await expect(newRequest({ question: '  ' })).rejects.toThrow(/in words/)
    await expect(newRequest({ dueAt: '2026-10-01T00:00:00Z' })).rejects.toThrow(/due after it was made/)
  })

  it('the party answers once, through the APPROVAL link of the request: typed name, one answerer, words for a change', async () => {
    const id = await newRequest()
    const link = await approvalLink(id)
    const otherLink = await approvalLink(await newRequest())
    await expect(update(partner(), 'ApprovalRequest', id, `question = 'Approve anything'`)).rejects.toThrow(/only answers its OPEN approval request/)
    await expect(update(partner(), 'ApprovalRequest', id, `status = 'WITHDRAWN', "withdrawnAt" = now()`)).rejects.toThrow(/only answers/)
    await expect(answer(id, otherLink)).rejects.toThrow(/APPROVAL link of it or of its record/)
    await expect(answer(id, link, 'APPROVED_WITH_CHANGES')).rejects.toThrow(/wrong answer/)
    await expect(update(partner(), 'ApprovalRequest', id, `status = 'APPROVED', "answeredAt" = now(), "answeredViaLinkId" = $2::uuid, "answerRequestId" = 'x'`, link)).rejects.toThrow(/wrong answer/)
    expect(await answer(id, link, 'APPROVED_WITH_CHANGES', `, answer = 'Move the logo 1 cm up'`)).toBe(1)
    await expect(update(partner(), 'ApprovalRequest', id, `answer = 'Changed my mind'`)).rejects.toThrow(/only answers|never changes again/)
    await expect(update(office(), 'ApprovalRequest', id, `question = 'x'`)).rejects.toThrow(/never changes again/)
  })

  it('a markup is a file of the request; both answerers or none are refused', async () => {
    const id = await newRequest()
    const link = await approvalLink(id)
    await expect(answer(id, link, 'APPROVED', `, "markupFileId" = '${seeded.files.markup}'::uuid`)).rejects.toThrow(/a file of the request/)
    await expect(update(office(), 'ApprovalRequest', id, `status = 'REFUSED', "typedName" = 'X', "answeredAt" = now(), "answerRequestId" = 'x', answer = 'No'`)).rejects.toThrow(/one answerer/)
    await expect(
      update(office(), 'ApprovalRequest', id, `status = 'REFUSED', "typedName" = 'X', "answeredAt" = now(), "answerRequestId" = 'x', "answeredViaLinkId" = $2::uuid, "answeredByUserId" = $3::uuid`, link, a.actorId),
    ).rejects.toThrow(/wrong answer/)
  })

  it('the office corrects while OPEN, withdraws with its time, expires only after the due time; never deleted', async () => {
    const id = await newRequest({ dueAt: '2099-01-01T00:00:00Z' })
    expect(await update(office(), 'ApprovalRequest', id, `question = 'Approve the second fit sample.', "dueAt" = "dueAt" + interval '2 days', version = version + 1`)).toBe(1)
    await expect(update(office(), 'ApprovalRequest', id, `kind = 'PROOF'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'ApprovalRequest', id, `status = 'EXPIRED'`)).rejects.toThrow(/expires only after that/)
    await expect(update(office(), 'ApprovalRequest', id, `status = 'WITHDRAWN'`)).rejects.toThrow(/wrong withdrawal/)
    expect(await update(office(), 'ApprovalRequest', id, `status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    const overdue = await newRequest({ createdAt: '2026-10-01T08:00:00Z', dueAt: '2026-10-05T08:00:00Z' })
    expect(await update(office(), 'ApprovalRequest', overdue, `status = 'EXPIRED', version = version + 1`)).toBe(1)
    await expect(update(office(), 'ApprovalRequest', overdue, `status = 'OPEN'`)).rejects.toThrow(/never changes again/)
    await expect(admin(`DELETE FROM "ApprovalRequest" WHERE id = $1`, [overdue])).rejects.toThrow(/never deleted/)
  })
})

describe('concessions answered by the customer (QHS-085 by link)', () => {
  /** A new concession on the CAPA seed's contained NCR, ASKED, of P1. */
  async function newConcession(): Promise<string> {
    const id = randomUUID()
    await copyRow('NcrConcession', seeded.concessionId, {
      id,
      seq: Math.floor(Math.random() * 1_000_000) + 100,
      status: 'ASKED',
      answer: null,
      answeredAt: null,
      answeredBy: null,
      answerFileId: null,
      recordedById: null,
      approvalRequestId: null,
      version: 1,
    })
    return id
  }
  const answerConcession = (id: string, status: string) =>
    update(partner(), 'NcrConcession', id, `status = '${status}', answer = 'As in our answer to the request', "answeredAt" = now(), "answeredBy" = 'Seed Buyer One', version = version + 1`)

  it('the request is named once, while ASKED, and is a CONCESSION request naming the concession', async () => {
    await expect(copyRow('NcrConcession', seeded.concessionId, { id: randomUUID(), seq: 999_999, status: 'ASKED', answer: null, answeredAt: null, answeredBy: null, recordedById: null })).rejects.toThrow(
      /asked first; its approval request names it/,
    )
    const id = await newConcession()
    const sample = await newRequest()
    await expect(update(office(), 'NcrConcession', id, `"approvalRequestId" = $2::uuid`, sample)).rejects.toThrow(/a CONCESSION request that names it/)
    const request = await newRequest({ kind: 'CONCESSION', recordType: 'NcrConcession', recordId: id })
    expect(await update(office(), 'NcrConcession', id, `"approvalRequestId" = $2::uuid, version = version + 1`, request)).toBe(1)
    const second = await newRequest({ kind: 'CONCESSION', recordType: 'NcrConcession', recordId: id })
    await expect(update(office(), 'NcrConcession', id, `"approvalRequestId" = $2::uuid`, second)).rejects.toThrow(/set once/)
  })

  it('the customer writes the answer columns only, as its request was answered first; never who recorded it nor the cost lines', async () => {
    const lone = await newConcession()
    await expect(answerConcession(lone, 'ACCEPTED')).rejects.toThrow(/only when its approval request asks it/)
    const id = await newConcession()
    const request = await newRequest({ kind: 'CONCESSION', recordType: 'NcrConcession', recordId: id })
    await update(office(), 'NcrConcession', id, `"approvalRequestId" = $2::uuid, version = version + 1`, request)
    await expect(answerConcession(id, 'ACCEPTED')).rejects.toThrow(/answer the request first/)
    await expect(update(partner(), 'NcrConcession', id, `proposal = 'Free jackets'`)).rejects.toThrow(/only when its approval request asks it/)
    await expect(update(partner(), 'NcrConcession', id, `"recordedById" = $2::uuid`, a.actorId)).rejects.toThrow(DENIED)
    const link = await newLink({ purpose: 'APPROVAL', recordType: 'NcrConcession', recordId: id, maxUses: 1 })
    expect(
      await update(
        partner(),
        'ApprovalRequest',
        request,
        `status = 'REFUSED', answer = 'Not this shade', "typedName" = 'Seed Buyer One', "answeredAt" = now(), "answeredViaLinkId" = $2::uuid, "answerRequestId" = 'test', version = version + 1`,
        link,
      ),
    ).toBe(1)
    await expect(answerConcession(id, 'ACCEPTED')).rejects.toThrow(/answered as its approval request was/)
    expect(await answerConcession(id, 'REFUSED')).toBe(1)
    expect(await sql(office(), `SELECT status::text, "recordedById" FROM "NcrConcession" WHERE id = $1::uuid`, id)).toEqual([{ status: 'REFUSED', recordedById: null }])
    await expect(answerConcession(id, 'ACCEPTED')).rejects.toThrow(/an answered concession never changes|only when/)
    await expect(sql(partner(), 'SELECT id FROM "NcrCostLine"')).rejects.toThrow(DENIED)
  })

  it('the office still keeps the customer and records answers itself', async () => {
    const id = await newConcession()
    await expect(update(office(), 'NcrConcession', id, `"partyId" = $2::uuid`, key('party:P3'))).rejects.toThrow(/never change/)
    expect(await update(office(), 'NcrConcession', id, `status = 'ACCEPTED', "answeredAt" = now(), "answeredBy" = 'Seed Buyer', "recordedById" = $2::uuid`, a.actorId)).toBe(1)
  })
})
