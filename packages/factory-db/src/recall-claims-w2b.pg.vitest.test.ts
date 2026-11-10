import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedRecall, type RecallSeed } from '../seed/recall'
import { seed as seedSchedule } from '../seed/schedule'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Recall, authority and claims (W2b-4, schema wave 33/33, B-W2b-222, …_recall_claims_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - the register: the new kinds WITHDRAWAL and AUTHORITY_REQUEST, an entry opened from an authority's request;
 *   - authority notices: drafted for an OPEN entry and a market of the tenant, sent once by a person (a RISK only once the
 *     entry's risk is YES), then frozen but the reference and the copy, filled in once;
 *   - recalls and withdrawals: of the entry's style, a scope set while DRAFT that only widens once started, the public
 *     notice published while ACTIVE and never changed after, closed with how it ended; their progress adds up, follows a
 *     shipment of its own customer, is written while the recall runs and removed only while it is a DRAFT;
 *   - distributor notices: an address for the way they go, what was sent never changes, answered or failed after it was sent,
 *     the recall of their own entry;
 *   - authority requests: received not in the future, due not before, batches with a style, the evidence by record type + id,
 *     the register entry of the style set once, frozen once answered;
 *   - sustainability claims: approved with available evidence of the company that has not expired, then frozen; their uses
 *     only while approved;
 *   - grants: the office only (the floor and partners read nothing); nothing deleted but a DRAFT recall's progress.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-222-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: RecallSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), site: key('site:A1'), P1: key('party:P1'), P2: key('party:P2'), P3: key('party:P3'), member: key('user:member') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
/** A DELETE the office has no grant for, and that the guard refuses for the owner too. */
const refusedDelete = async (table: string, id: string) => {
  await expect(run(office(), `DELETE FROM "${table}" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
  await expect(admin(`DELETE FROM "${table}" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
}
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
const dayIn = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const notice = (title: string) => ({ title, problem: 'The pocket can open (test).', action: 'Bring it back (test).', contact: 'Seed Service (test)' })

/** A new OPEN register entry of company A: a copy of the recall entry with `changes`. */
async function newEntry(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'PpeRegisterEntry', s.entryIds.recall, { id, reference: tag('T-REG'), sourceType: null, sourceId: null, ...changes })).toBe(1)
  return id
}
/** A CLOSED register entry: risk NO, its action done, no garment that left (batch unknown, no work order or shipment). */
async function closedEntry(): Promise<string> {
  const id = await newEntry({ kind: 'COMPLAINT', risk: 'NO', batchNumbers: ['T-BT-NONE'], workOrderIds: [], shipmentIds: [], actionTaken: 'A test action.', actionCompletedAt: ago(1) })
  expect(await update(office(), 'PpeRegisterEntry', id, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid, "closeReason" = 'Test close.'`, A.member)).toBe(1)
  return id
}
/** A new DRAFT recall action: a copy of SEED-RCL-0001 (the withdrawal's DRAFT) with `changes`. */
async function newAction(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'RecallAction', s.actionIds.draft, { id, number: tag('T-RCL'), ...changes })).toBe(1)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('recallclaimsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedRecall({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent. The schedule seed gives the FINISHED garment a claim may not cover.
  await seedRecall({ db: factory, namespace: NS })
  await seedSchedule({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the register', () => {
  it('takes the kinds WITHDRAWAL and AUTHORITY_REQUEST, and an entry opened from an authority request', async () => {
    const kinds = await admin(`SELECT kind::text AS k, "sourceType" AS t FROM "PpeRegisterEntry" WHERE id = ANY($1::uuid[]) ORDER BY reference`, [[s.entryIds.recall, s.entryIds.withdrawal, s.entryIds.request]])
    expect(kinds).toEqual([{ k: 'RECALL', t: null }, { k: 'WITHDRAWAL', t: null }, { k: 'AUTHORITY_REQUEST', t: 'AuthorityRequest' }])
    // One entry per source record (W1's partial unique), and an unknown source type is still refused.
    await expect(newEntry({ kind: 'AUTHORITY_REQUEST', sourceType: 'AuthorityRequest', sourceId: s.requestIds.answered })).rejects.toThrow(/PpeRegisterEntry_tenantId_sourceType_sourceId_key/)
    expect(await newEntry({ kind: 'AUTHORITY_REQUEST', sourceType: 'AuthorityRequest', sourceId: s.requestIds.open })).toBeTruthy()
    await expect(newEntry({ sourceType: 'AuthorityLetter', sourceId: randomUUID() })).rejects.toThrow(/known record type/)
  })
})

describe('authority notices', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'AuthorityNotice', s.noticeIds.draft, { id: randomUUID(), ...changes })

  it('are drafted for an OPEN entry, to a market of the tenant, with words per language', async () => {
    await expect(add({ status: 'SENT', sentAt: ago(0), sentById: A.member })).rejects.toThrow(/drafted first/)
    await expect(add({ marketCode: 'XX' })).rejects.toThrow(/not a market of the tenant/)
    await expect(add({ marketCode: 'italy' })).rejects.toThrow(/names its market by its code/)
    await expect(add({ words: {} })).rejects.toThrow(/per language/)
    await expect(add({ words: { it: '' } })).rejects.toThrow(/per language/)
    await expect(add({ registerEntryId: await closedEntry() })).rejects.toThrow(/while its register entry is OPEN/)
    expect(await add({ marketCode: 'FR', words: { fr: 'Avis de test.\nDeuxième ligne.' } })).toBe(1)
  })

  it('are sent once by a person, a RISK only once the entry says YES, then frozen but the reference and the copy', async () => {
    // The withdrawal entry's risk is NO: a RISK notice of it cannot be sent; a NOT_CONFORMING one can.
    const risky = randomUUID()
    expect(await add({ id: risky, registerEntryId: s.entryIds.withdrawal, decision: 'RISK' })).toBe(1)
    await expect(update(office(), 'AuthorityNotice', risky, `status = 'SENT', "sentAt" = now(), "sentById" = $2::uuid`, A.member)).rejects.toThrow(/risk is decided YES first/)
    const id = randomUUID()
    expect(await add({ id, registerEntryId: s.entryIds.withdrawal, decision: 'NOT_CONFORMING', marketCode: 'DE' })).toBe(1)
    await expect(update(office(), 'AuthorityNotice', id, `status = 'SENT', "sentAt" = now()`)).rejects.toThrow(/by whom/)
    await expect(update(office(), 'AuthorityNotice', id, `status = 'SENT', "sentAt" = now() + interval '1 day', "sentById" = $2::uuid`, A.member)).rejects.toThrow(/not in the future/)
    await expect(update(office(), 'AuthorityNotice', id, `reference = 'T-1'`)).rejects.toThrow(/only once it is SENT/)
    expect(await update(office(), 'AuthorityNotice', id, `status = 'SENT', "sentAt" = now(), "sentById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'AuthorityNotice', id, `words = '{"en": "Changed."}'::jsonb`)).rejects.toThrow(/was sent and never changes/)
    await expect(update(office(), 'AuthorityNotice', id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x'`)).rejects.toThrow(/DRAFT → SENT \| CANCELLED only/)
    expect(await update(office(), 'AuthorityNotice', id, `reference = 'T-REF-1'`)).toBe(1)
    await expect(update(office(), 'AuthorityNotice', id, `reference = 'T-REF-2'`)).rejects.toThrow(/filled in once/)
    // The copy is a file of this notice: the seed's copy belongs to the German notice.
    await expect(update(office(), 'AuthorityNotice', id, `"fileId" = $2::uuid`, s.fileIds.noticeCopy)).rejects.toThrow(/a file of this notice/)
    expect(await update(office(), 'AuthorityNotice', id, `note = 'Called the office to confirm.'`)).toBe(1)
    await refusedDelete('AuthorityNotice', id)
  })
})

describe('recall actions', () => {
  it("are drafted of the entry's style, calling back the whole style or what they name", async () => {
    await expect(newAction({ status: 'ACTIVE', startedAt: ago(0), startedById: A.member })).rejects.toThrow(/drafted first/)
    const other = (await one(`SELECT id::text AS id FROM "Style" WHERE "tenantId" = $1 AND id <> $2 LIMIT 1`, [a.tenantId, s.styleId])).id as string
    await expect(newAction({ styleId: other })).rejects.toThrow(/register entry's style/)
    await expect(newAction({ batchNumbers: [] })).rejects.toThrow(/whole style or names/)
    await expect(newAction({ batchNumbers: ['A', 'A'] })).rejects.toThrow(/once/)
    await expect(newAction({ number: ' ' })).rejects.toThrow(/never blank|has its number/)
    await expect(newAction({ workOrderIds: [randomUUID()] })).rejects.toThrow(/work order that is not of its company and style/)
    await expect(newAction({ registerEntryId: await closedEntry() })).rejects.toThrow(/foreign key|register entry's style|OPEN/)
    expect(await newAction({ batchNumbers: [], wholeStyle: true })).toBeTruthy()
  })

  it('start with a person, widen only, publish their notice while ACTIVE and never change it, close with how it ended', async () => {
    const id = await newAction()
    await expect(update(office(), 'RecallAction', id, `"publicNotice" = $2::jsonb, "noticePublishedAt" = now(), "noticePublishedById" = $3::uuid`, JSON.stringify({ en: notice('Recall') }), A.member)).rejects.toThrow(/while the action runs/)
    await expect(update(office(), 'RecallAction', id, `"publicNotice" = $2::jsonb`, JSON.stringify({ en: { title: 'Recall' } }))).rejects.toThrow(/"title", "problem", "action", "contact"/)
    await expect(update(office(), 'RecallAction', id, `status = 'ACTIVE', "startedAt" = now()`)).rejects.toThrow(/started with when and by whom/)
    expect(await update(office(), 'RecallAction', id, `status = 'ACTIVE', "startedAt" = now(), "startedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'RecallAction', id, `number = 'T-OTHER'`)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'RecallAction', id, `"batchNumbers" = '{}'::text[], "wholeStyle" = true`)).rejects.toThrow(/only widens/)
    expect(await update(office(), 'RecallAction', id, `"batchNumbers" = array_append("batchNumbers", 'T-BT-2'), "workOrderIds" = $2::uuid[]`, [s.workOrderId])).toBe(1)
    await expect(update(office(), 'RecallAction', id, `"noticePublishedAt" = now(), "noticePublishedById" = $2::uuid`, A.member)).rejects.toThrow(/published with its words/)
    expect(await update(office(), 'RecallAction', id, `"publicNotice" = $2::jsonb, "noticePublishedAt" = now(), "noticePublishedById" = $3::uuid`, JSON.stringify({ en: notice('Recall') }), A.member)).toBe(1)
    await expect(update(office(), 'RecallAction', id, `"publicNotice" = $2::jsonb`, JSON.stringify({ en: notice('Recall, changed') }))).rejects.toThrow(/words never change/)
    expect(await update(office(), 'RecallAction', id, `"publicNotice" = $2::jsonb`, JSON.stringify({ en: notice('Recall'), it: notice('Richiamo') }))).toBe(1)
    await expect(update(office(), 'RecallAction', id, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid`, A.member)).rejects.toThrow(/how it ended/)
    expect(await update(office(), 'RecallAction', id, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid, "closeNote" = 'Every garment came back.'`, A.member)).toBe(1)
    await expect(update(office(), 'RecallAction', id, `"batchNumbers" = array_append("batchNumbers", 'T-BT-3')`)).rejects.toThrow(/CLOSED and never changes/)
    expect(await update(office(), 'RecallAction', id, `"noticeWithdrawnAt" = now(), note = 'Notice taken down.'`)).toBe(1)
    await expect(update(office(), 'RecallAction', id, `"noticeWithdrawnAt" = now() - interval '1 minute'`)).rejects.toThrow(/set once/)
    await expect(update(office(), 'RecallAction', id, `status = 'ACTIVE'`)).rejects.toThrow(/DRAFT → ACTIVE \| CANCELLED, ACTIVE → CLOSED/)
    await refusedDelete('RecallAction', id)
  })
})

describe('recall progress', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'RecallProgress', s.progressIds.draft, { id: randomUUID(), ...changes })

  it('adds up, follows a shipment of its own customer, once per action, customer and shipment', async () => {
    const action = await newAction()
    await expect(add({ recallActionId: action, unitsReturned: 1 })).rejects.toThrow(/adds up/)
    await expect(add({ recallActionId: action, unitsSent: -1, unitsStillOut: -1 })).rejects.toThrow(/0 or more/)
    await expect(add({ recallActionId: action, partyId: A.P3, shipmentId: s.shipmentId })).rejects.toThrow(/to its own customer/)
    await expect(add({ recallActionId: action, shipmentId: randomUUID() })).rejects.toThrow(/to its own customer/)
    expect(await add({ recallActionId: action, shipmentId: s.shipmentId, unitsSent: 2, unitsRepaired: 1, unitsDestroyed: 1, unitsStillOut: 0 })).toBe(1)
    await expect(add({ recallActionId: action, shipmentId: s.shipmentId })).rejects.toThrow(/RecallProgress_tenantId_recallActionId_partyId_shipmentId_key/)
  })

  it('is written while the recall runs and removed only while it is a DRAFT', async () => {
    const action = await newAction()
    const id = randomUUID()
    expect(await add({ id, recallActionId: action })).toBe(1)
    await expect(update(office(), 'RecallProgress', id, `"shipmentId" = $2::uuid`, s.shipmentId)).rejects.toThrow(/never change/)
    expect(await update(office(), 'RecallAction', action, `status = 'ACTIVE', "startedAt" = now(), "startedById" = $2::uuid`, A.member)).toBe(1)
    expect(await update(office(), 'RecallProgress', id, `"unitsReturned" = 2, "unitsStillOut" = 0`)).toBe(1)
    await expect(run(office(), `DELETE FROM "RecallProgress" WHERE id = $1::uuid`, id)).rejects.toThrow(/only while its recall is a DRAFT/)
    expect(await update(office(), 'RecallAction', action, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid, "closeNote" = 'Done.'`, A.member)).toBe(1)
    await expect(update(office(), 'RecallProgress', id, `note = 'Late.'`)).rejects.toThrow(/only while its recall is a DRAFT or ACTIVE/)
    // A DRAFT's row goes.
    const draft = await newAction()
    const gone = randomUUID()
    expect(await add({ id: gone, recallActionId: draft })).toBe(1)
    expect(await run(office(), `DELETE FROM "RecallProgress" WHERE id = $1::uuid`, gone)).toBe(1)
  })
})

describe('distributor notices', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'DistributorNotice', s.distributorNoticeIds.draft, { id: randomUUID(), ...changes })

  it("reach an address of their way, of their own entry's recall, for an OPEN entry", async () => {
    await expect(add({ status: 'SENT', sentAt: ago(0), sentById: A.member })).rejects.toThrow(/written first/)
    await expect(add({ contact: 'not an address' })).rejects.toThrow(/e-mail address/)
    await expect(add({ channel: 'PHONE', contact: null })).rejects.toThrow(/phone number/)
    await expect(add({ linkId: randomUUID() })).rejects.toThrow(/a link only when it goes by link/)
    await expect(add({ language: 'Italian' })).rejects.toThrow(/ISO 639/)
    await expect(add({ message: ' ' })).rejects.toThrow(/its words/)
    await expect(add({ registerEntryId: s.entryIds.withdrawal })).rejects.toThrow(/foreign key/)
    await expect(add({ recallActionId: s.actionIds.cancelled, registerEntryId: s.entryIds.withdrawal })).rejects.toThrow(/was cancelled/)
    await expect(add({ partyId: A.P2, registerEntryId: s.entryIds.withdrawal, recallActionId: null })).resolves.toBe(1)
    expect(await add({ channel: 'PORTAL', contact: null, contactName: null })).toBe(1)
  })

  it('never change what was sent; answered or failed after it, then final', async () => {
    const id = randomUUID()
    expect(await add({ id })).toBe(1)
    await expect(update(office(), 'DistributorNotice', id, `status = 'ANSWERED', "answeredAt" = now(), answer = 'Yes.'`)).rejects.toThrow(/DRAFT → SENT \| CANCELLED/)
    expect(await update(office(), 'DistributorNotice', id, `status = 'SENT', "sentAt" = now(), "sentById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'DistributorNotice', id, `message = 'Other words.'`)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'DistributorNotice', id, `status = 'ANSWERED', "answeredAt" = now()`)).rejects.toThrow(/ANSWERED exactly with when/)
    await expect(update(office(), 'DistributorNotice', id, `status = 'ANSWERED', "answeredAt" = now() - interval '1 day', answer = 'Yes.'`)).rejects.toThrow(/not before it was sent/)
    expect(await update(office(), 'DistributorNotice', id, `status = 'ANSWERED', "answeredAt" = now(), answer = 'Received, stopped.', "answeredByName" = 'Seed Buyer One'`)).toBe(1)
    await expect(update(office(), 'DistributorNotice', id, `answer = 'Changed.'`)).rejects.toThrow(/ANSWERED and never changes/)
    await refusedDelete('DistributorNotice', id)
  })
})

describe('authority requests', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'AuthorityRequest', s.requestIds.open, { id: randomUUID(), number: tag('T-AR'), ...changes })

  it('come not in the future, are due not before, name batches with their style and the evidence by type and id', async () => {
    await expect(add({ status: 'ANSWERED' })).rejects.toThrow(/logged OPEN/)
    await expect(add({ receivedAt: new Date(Date.now() + 86_400_000).toISOString(), dueOn: dayIn(10) })).rejects.toThrow(/not in the future/)
    await expect(add({ receivedAt: ago(1), dueOn: dayIn(-5) })).rejects.toThrow(/due on or after the day it came/)
    await expect(add({ styleId: null })).rejects.toThrow(/only with their style/)
    await expect(add({ marketCode: 'XX' })).rejects.toThrow(/not a market of the tenant/)
    await expect(add({ evidenceType: 'EvidencePack' })).rejects.toThrow(/both or neither/)
    await expect(add({ evidenceType: 'evidence pack', evidenceId: randomUUID() })).rejects.toThrow(/record type/)
    expect(await add({ styleId: null, batchNumbers: [], evidenceType: 'EvidencePack', evidenceId: randomUUID() })).toBe(1)
  })

  it('name a register entry of their style once, and are frozen once answered', async () => {
    const id = randomUUID()
    expect(await add({ id })).toBe(1)
    const other = await newEntry({ styleId: (await one(`SELECT "styleId"::text AS s FROM "WorkOrder" WHERE "tenantId" = $1 AND "styleId" <> $2 AND "companyId" = $3 LIMIT 1`, [a.tenantId, s.styleId, A.company])).s, batchNumbers: [], workOrderIds: [], shipmentIds: [] })
    await expect(update(office(), 'AuthorityRequest', id, `"registerEntryId" = $2::uuid`, other)).rejects.toThrow(/of the style it is about/)
    expect(await update(office(), 'AuthorityRequest', id, `"registerEntryId" = $2::uuid`, s.entryIds.recall)).toBe(1)
    await expect(update(office(), 'AuthorityRequest', id, `"registerEntryId" = $2::uuid`, s.entryIds.withdrawal)).rejects.toThrow(/set once/)
    await expect(update(office(), 'AuthorityRequest', id, `status = 'ANSWERED', "answeredAt" = now(), "answeredById" = $2::uuid`, A.member)).rejects.toThrow(/ANSWERED exactly with when/)
    await expect(update(office(), 'AuthorityRequest', id, `number = 'T-AR-OTHER'`)).rejects.toThrow(/never changes/)
    expect(await update(office(), 'AuthorityRequest', id, `status = 'ANSWERED', "answeredAt" = now(), "answeredById" = $2::uuid, "answerSummary" = 'Sent the DoC.'`, A.member)).toBe(1)
    await expect(update(office(), 'AuthorityRequest', id, `request = 'Changed.'`)).rejects.toThrow(/ANSWERED and never changes/)
    expect(await update(office(), 'AuthorityRequest', id, `note = 'Thanked us.'`)).toBe(1)
    await refusedDelete('AuthorityRequest', id)
  })
})

describe('sustainability claims', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'SustainabilityClaim', s.claimIds.draft, { id: randomUUID(), code: tag('T-CL'), ...changes })
  const approve = (id: string) => update(office(), 'SustainabilityClaim', id, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, A.member)

  it('cover what their scope says, with their words, phrase and evidence of their company', async () => {
    await expect(add({ status: 'APPROVED', approvedAt: ago(0), approvedById: A.member })).rejects.toThrow(/drafted first/)
    await expect(add({ code: 'bad code' })).rejects.toThrow(/has a code/)
    await expect(add({ wording: { it: 'Due\nrighe' } })).rejects.toThrow(/one line/)
    await expect(add({ scope: 'STYLE' })).rejects.toThrow(/exactly when it covers a STYLE/)
    await expect(add({ scope: 'COMPANY' })).rejects.toThrow(/neither for the COMPANY/)
    const finished = (await one(`SELECT id::text AS id FROM "Item" WHERE "tenantId" = $1 AND kind = 'FINISHED' LIMIT 1`, [a.tenantId])).id as string
    await expect(add({ itemId: finished })).rejects.toThrow(/never a FINISHED garment/)
    await expect(add({ phraseKey: 'claim.unknown' })).rejects.toThrow(/not a phrase of the tenant/)
    await expect(add({ evidenceFileIds: [s.fileIds.lwg, s.fileIds.lwg] })).rejects.toThrow(/each evidence file once/)
    // A file of company B is not company A's evidence.
    const fileB = randomUUID()
    await admin(`INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(f) || jsonb_build_object('id', $1::uuid, 'companyId', $2::uuid, 'storageKey', 't/' || f."tenantId"::text || '/c/' || $2::text || '/2026/' || $1::text) FROM "StoredFile" f WHERE f.id = $3::uuid))`, [fileB, A.companyB, s.fileIds.lwg])
    await expect(add({ evidenceFileIds: [fileB] })).rejects.toThrow(/only files of its company/)
    expect(await add({ phraseKey: 'claim.made-in-italy', kind: 'OTHER' })).toBe(1)
  })

  it('are approved only with available evidence that has not expired, then never change but their withdrawal', async () => {
    const bare = randomUUID()
    expect(await add({ id: bare, evidenceFileIds: [] })).toBe(1)
    await expect(approve(bare)).rejects.toThrow(/at least one file/)
    const expired = randomUUID()
    expect(await add({ id: expired, validUntil: dayIn(-1) })).toBe(1)
    await expect(approve(expired)).rejects.toThrow(/after its evidence expired/)
    const id = randomUUID()
    expect(await add({ id })).toBe(1)
    await expect(update(office(), 'SustainabilityClaim', id, `status = 'APPROVED', "approvedAt" = now()`)).rejects.toThrow(/when and by whom/)
    expect(await approve(id)).toBe(1)
    await expect(update(office(), 'SustainabilityClaim', id, `wording = '{"en": "Changed"}'::jsonb`)).rejects.toThrow(/approved and never changes/)
    await expect(update(office(), 'SustainabilityClaim', id, `status = 'DRAFT', "approvedAt" = NULL, "approvedById" = NULL`)).rejects.toThrow(/DRAFT → APPROVED \| WITHDRAWN/)
    await expect(update(office(), 'SustainabilityClaim', id, `status = 'WITHDRAWN', "withdrawnAt" = now()`)).rejects.toThrow(/WITHDRAWN exactly with when/)
    expect(await update(office(), 'SustainabilityClaim', id, `status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawReason" = 'No longer made.'`)).toBe(1)
    await expect(update(office(), 'SustainabilityClaim', id, `"scopeNote" = 'x'`)).rejects.toThrow(/WITHDRAWN and never changes/)
    await expect(update(office(), 'SustainabilityClaim', s.claimIds.replacement, `"supersedesId" = NULL`)).rejects.toThrow(/never change/)
    await refusedDelete('SustainabilityClaim', id)
  })
})

describe('claim uses', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'ClaimUse', s.useIds.style, { id: randomUUID(), ...changes })

  it('are added only while their claim is approved and holds; a style use names a Style; ended once, then frozen', async () => {
    await expect(add({ claimId: s.claimIds.draft })).rejects.toThrow(/only while its claim is APPROVED/)
    await expect(add({ claimId: s.claimIds.withdrawn })).rejects.toThrow(/only while its claim is APPROVED/)
    await expect(add({ recordType: 'LabelTemplate' })).rejects.toThrow(/on a style names a Style/)
    await expect(add({ recordId: randomUUID() })).rejects.toThrow(/names a Style of the claim's company/)
    await expect(add({ kind: 'WEB_SHOP', recordType: 'web shop' })).rejects.toThrow(/model name/)
    const id = randomUUID()
    expect(await add({ id, kind: 'WEB_SHOP', recordType: 'StyleText', recordId: randomUUID(), label: 'Web shop text (test)' })).toBe(1)
    await expect(update(office(), 'ClaimUse', id, `"recordId" = $2::uuid`, randomUUID())).rejects.toThrow(/never change/)
    await expect(update(office(), 'ClaimUse', id, `"endedAt" = now() + interval '1 day'`)).rejects.toThrow(/not in the future/)
    expect(await update(office(), 'ClaimUse', id, `"endedAt" = now(), "endedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'ClaimUse', id, `label = 'Changed'`)).rejects.toThrow(/ended and never changes/)
    await refusedDelete('ClaimUse', id)
  })
})

describe('grants', () => {
  it("are the office's: the floor and partners read nothing; nothing is truncated", async () => {
    for (const table of ['AuthorityNotice', 'RecallAction', 'RecallProgress', 'DistributorNotice', 'AuthorityRequest', 'SustainabilityClaim', 'ClaimUse']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(partner(A.P1), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    expect((await sql(office(), `SELECT count(*)::int AS n FROM "RecallAction"`))[0]!.n).toBeGreaterThanOrEqual(3)
    await expect(admin(`TRUNCATE "ClaimUse"`)).rejects.toThrow(/TRUNCATE on "ClaimUse" is refused/)
  })
})
