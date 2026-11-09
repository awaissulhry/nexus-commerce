import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedQualityLab } from '../seed/quality-lab'
import { seed as seedSubstances, type SubstancesSeed } from '../seed/substances'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Materials and restricted substances (W2b-4, schema wave 31/33, B-W2b-217, …_substances_w2b_guards) on a database built from
 * the migrations and seeded twice, through the real login and the scoped client:
 *   - the substance list: CAS and EC check digits, given once, one ACTIVE row per CAS, lists and Annex XVII entries;
 *   - substance rules: one substance or group, a limit with its unit and bound, a brand for a CUSTOMER rule, switched OFF
 *     with the reason and every switch with its time;
 *   - Candidate List versions: what was published never changes, kept while named;
 *   - material profiles: a material only, tannage of a leather, the SVHC answer with its list version and SVHCs, what the
 *     evaluator found only with its time, BLOCKED with why;
 *   - declaration requests: SENT → ANSWERED → ACCEPTED in the portal (its task, a reminder, the upload accepted, every line
 *     answered), OVERDUE after the due day, by link or by hand (a file of the request), asked again, frozen once decided;
 *     lines only while open, the SVHC threshold at 0.1 % w/w;
 *   - test plan rules: a kind or a material, a substance rule of its own test;
 *   - lab results (W1's guard, redefined): CR_VI as before, the new tests with their unit and the rule's limit;
 *   - grants: the supplier reads its own requests and lines without the hidden columns; the floor reads none.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-217-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SubstancesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1'), P1: key('party:P1'), P2: key('party:P2'), member: key('user:member') }
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

/** A new request: a copy of SEED-SD-0001 (SENT, by e-mail, SVHC of the July list) with `changes`, and its first line copied. */
async function newRequest(changes: Record<string, unknown> = {}): Promise<{ id: string; line: string }> {
  const id = randomUUID()
  const line = randomUUID()
  expect(await copyRow(office(), 'SupplierDeclarationRequest', s.requestIds.again, { id, number: tag('T-SD'), supersedesId: null, ...changes })).toBe(1)
  const party = (await one(`SELECT "partyId"::text AS p FROM "SupplierDeclarationRequest" WHERE id = $1`, [id])).p as string
  expect(await copyRow(office(), 'SupplierDeclarationLine', s.lineIds.againLeather, { id: line, requestId: id, partyId: party })).toBe(1)
  return { id, line }
}

beforeAll(async () => {
  db = await migratedDatabase('substancesw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedSubstances({ db: factory, namespace: NS })
  await seedQualityLab({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedSubstances({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the substance list', () => {
  it('takes CAS and EC numbers with their check digits right, once, one ACTIVE row per CAS', async () => {
    const add = (changes: Record<string, unknown>) => copyRow(office(), 'RestrictedSubstance', s.substanceIds.npe, { id: randomUUID(), ...changes })
    await expect(add({ casNumber: '50-32-9' })).rejects.toThrow(/check digits right/)
    await expect(add({ ecNumber: '200-028-4' })).rejects.toThrow(/check digits right/)
    await expect(add({ casNumber: '50 32 8' })).rejects.toThrow(/check digits right/)
    // Benzo[a]pyrene is on the list already (ACTIVE): a second row of its CAS is refused by the partial unique.
    await expect(add({ casNumber: '50-32-8' })).rejects.toThrow(/RestrictedSubstance_one_active_per_cas/)
    // A family with no number (the first seeded row) may be copied; a number given once is never changed.
    const id = randomUUID()
    expect(await add({ id, name: 'Seed test family' })).toBe(1)
    expect(await update(office(), 'RestrictedSubstance', id, `"casNumber" = '7440-47-3'`)).toBe(1)
    await expect(update(office(), 'RestrictedSubstance', id, `"casNumber" = '7440-48-4'`)).rejects.toThrow(/given once, never changed/)
    // Archived, the number is free for a new ACTIVE row.
    expect(await update(office(), 'RestrictedSubstance', id, `status = 'ARCHIVED'`)).toBe(1)
    expect(await add({ casNumber: '7440-47-3', name: 'Chromium (test)' })).toBe(1)
    await refusedDelete('RestrictedSubstance', id)
  })

  it('names its Annex XVII entries exactly when on that list, and an SVHC version only when on SVHC', async () => {
    const add = (changes: Record<string, unknown>) => copyRow(office(), 'RestrictedSubstance', s.substanceIds.npe, { id: randomUUID(), ...changes })
    await expect(add({ annexXviiEntries: [] })).rejects.toThrow(/exactly when it is on REACH_ANNEX_XVII/)
    await expect(add({ lists: ['SVHC'] })).rejects.toThrow(/exactly when it is on REACH_ANNEX_XVII/)
    await expect(add({ annexXviiEntries: ['46a', '46a'] })).rejects.toThrow(/each once/)
    await expect(add({ annexXviiEntries: ['entry 46'] })).rejects.toThrow(/Annex XVII entries/)
    await expect(add({ lists: [] })).rejects.toThrow(/at least one list/)
    await expect(add({ svhcListVersionId: s.listVersionIds.v1 })).rejects.toThrow(/only when it is on SVHC/)
    await expect(add({ groupCode: 'npe group' })).rejects.toThrow(/group code/)
    expect(await add({ lists: ['REACH_ANNEX_XVII', 'SVHC'], svhcListVersionId: s.listVersionIds.v2, name: 'Seed SVHC family' })).toBe(1)
  })
})

describe('substance rules', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'SubstanceRule', s.ruleIds.cr6, { id: randomUUID(), key: tag('T-RULE'), ...changes })

  it('restricts one substance or one group, with a limit, its unit and its bound together', async () => {
    await expect(add({ substanceGroup: 'AZO_AMINES' })).rejects.toThrow(/exactly one/)
    await expect(add({ substanceId: null })).rejects.toThrow(/exactly one/)
    await expect(add({ limitUnit: null })).rejects.toThrow(/its unit and the side/)
    await expect(add({ limitBound: null })).rejects.toThrow(/its unit and the side/)
    await expect(add({ limitValue: 0 })).rejects.toThrow(/above 0/)
    await expect(add({ materialKinds: ['LEATHER', 'FINISHED'] })).rejects.toThrow(/never FINISHED/)
    await expect(add({ marketCodes: ['it'] })).rejects.toThrow(/market codes/)
    await expect(add({ key: 'bad key' })).rejects.toThrow(/key of substance rule/)
    await expect(add({ legalUrl: 'http://example.com' })).rejects.toThrow(/legal reference/)
    // A ban the evidence answers: no limit at all.
    expect(await add({ limitValue: null, limitUnit: null, limitBound: null, evidence: 'DECLARATION' })).toBe(1)
    expect(await add({ marketCodes: ['FR', 'US-CA'], productTypes: ['JACKET', 'GLOVES'] })).toBe(1)
  })

  it('names the brand exactly for a CUSTOMER rule', async () => {
    await expect(add({ source: 'CUSTOMER' })).rejects.toThrow(/exactly when it is a CUSTOMER rule/)
    await expect(add({ customerPartyId: A.P1 })).rejects.toThrow(/exactly when it is a CUSTOMER rule/)
    expect(await add({ source: 'CUSTOMER', customerPartyId: A.P1 })).toBe(1)
  })

  it('is switched OFF with the reason and every switch with its time; never deleted, its key fixed', async () => {
    const id = randomUUID()
    expect(await add({ id })).toBe(1)
    await expect(update(office(), 'SubstanceRule', id, `"switchedOn" = false, "switchedAt" = now()`)).rejects.toThrow(/OFF saying why/)
    await expect(update(office(), 'SubstanceRule', id, `"switchedOn" = false, "offReason" = 'Waits for the Owner.'`)).rejects.toThrow(/with the time of the switch/)
    expect(await update(office(), 'SubstanceRule', id, `"switchedOn" = false, "offReason" = 'Waits for the Owner.', "switchedAt" = now(), "switchedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'SubstanceRule', id, `"switchedOn" = true, "switchedAt" = now()`)).rejects.toThrow(/ON with no reason/)
    expect(await update(office(), 'SubstanceRule', id, `"switchedOn" = true, "offReason" = NULL, "switchedAt" = now() + interval '1 minute'`)).toBe(1)
    await expect(update(office(), 'SubstanceRule', id, `key = 'T-OTHER'`)).rejects.toThrow(/company, key and creation/)
    await refusedDelete('SubstanceRule', id)
  })
})

describe('Candidate List versions', () => {
  it('keep what ECHA published (only the note moves) and stay while anything names them', async () => {
    await expect(update(office(), 'SvhcListVersion', s.listVersionIds.v1, `"entryCount" = 251`)).rejects.toThrow(/never changes; only its note/)
    expect(await update(office(), 'SvhcListVersion', s.listVersionIds.v1, `note = 'Read again on the ECHA page.'`)).toBe(1)
    await expect(run(office(), `DELETE FROM "SvhcListVersion" WHERE id = $1::uuid`, s.listVersionIds.v1)).rejects.toThrow(/it is kept/)
    const id = randomUUID()
    await expect(copyRow(office(), 'SvhcListVersion', s.listVersionIds.v1, { id, publishedOn: '2027-01-15', entryCount: 0 })).rejects.toThrow(/entries \(from 1\)/)
    expect(await copyRow(office(), 'SvhcListVersion', s.listVersionIds.v1, { id, publishedOn: '2027-01-15', entryCount: 256 })).toBe(1)
    await expect(copyRow(office(), 'SvhcListVersion', s.listVersionIds.v1, { id: randomUUID(), publishedOn: '2027-01-15' })).rejects.toThrow(/SvhcListVersion_tenantId_publishedOn_key/)
    expect(await run(office(), `DELETE FROM "SvhcListVersion" WHERE id = $1::uuid`, id)).toBe(1)
  })
})

describe('material compliance profiles', () => {
  const add = (from: string, changes: Record<string, unknown>) => copyRow(office(), 'MaterialComplianceProfile', from, { id: randomUUID(), ...changes })

  it('are a material\'s, with the tannage of a leather and each confirmation with its time and person', async () => {
    const finished = (await one(`SELECT id::text AS id FROM "Item" WHERE kind = 'FINISHED' AND "tenantId" = $1 LIMIT 1`, [a.tenantId]))?.id as string | undefined
    if (finished) await expect(add(s.itemIds.lining, { itemId: finished })).rejects.toThrow(/never a finished garment/)
    await expect(add(s.itemIds.lining, { tannageConfirmedAt: new Date().toISOString(), tannageConfirmedById: A.member })).rejects.toThrow(/only for a leather/)
    await expect(add(s.itemIds.lining, { compositionConfirmedById: null })).rejects.toThrow(/its time and its person/)
    await expect(add(s.itemIds.lining, { originCountry: 'Italy' })).rejects.toThrow(/ISO code/)
    await expect(update(office(), 'MaterialComplianceProfile', s.itemIds.lining, `"itemId" = $2::uuid`, s.itemIds.leather)).rejects.toThrow(/material and creation/)
    await refusedDelete('MaterialComplianceProfile', s.itemIds.lining)
  })

  it('has its SVHC answer with the list version, naming SVHCs exactly when one is above 0.1 %', async () => {
    const lining = s.itemIds.lining
    await expect(update(office(), 'MaterialComplianceProfile', lining, `"svhcAboveThreshold" = false`)).rejects.toThrow(/Candidate List version it was judged against/)
    await expect(update(office(), 'MaterialComplianceProfile', lining, `"svhcAboveThreshold" = true, "svhcListVersionId" = $2::uuid`, s.listVersionIds.v2)).rejects.toThrow(/exactly when one is above/)
    await expect(update(office(), 'MaterialComplianceProfile', lining, `"svhcAboveThreshold" = true, "svhcListVersionId" = $2::uuid, "svhcSubstanceIds" = ARRAY[$3::uuid]`, s.listVersionIds.v2, s.substanceIds.nickel)).rejects.toThrow(/on the Candidate List/)
    expect(await update(office(), 'MaterialComplianceProfile', lining, `"svhcAboveThreshold" = true, "svhcListVersionId" = $2::uuid, "svhcSubstanceIds" = ARRAY[$3::uuid]`, s.listVersionIds.v2, s.substanceIds.dmf)).toBe(1)
  })

  it('holds what the evaluator found only with its time; BLOCKED says why, COMPLETE was evaluated', async () => {
    await expect(add(s.itemIds.zip, { evaluatedAt: null })).rejects.toThrow(/only with the time it ran/)
    await expect(add(s.itemIds.zip, { applicableRuleIds: [randomUUID()] })).rejects.toThrow(/substance rules of the list/)
    await expect(add(s.itemIds.zip, { testsNeeded: ['NICKEL', 'NICKEL'] })).rejects.toThrow(/each once/)
    await expect(add(s.itemIds.zip, { stateReason: null })).rejects.toThrow(/why it is BLOCKED/)
    await expect(add(s.itemIds.zip, { state: 'COMPLETE' })).rejects.toThrow(/COMPLETE only once evaluated and with no reason/)
    await expect(add(s.itemIds.zip, { state: 'COMPLETE', stateReason: null, evaluatedAt: null, applicableRuleIds: [], testsNeeded: [], declarationsNeeded: [] })).rejects.toThrow(/COMPLETE only once evaluated/)
    expect(await add(s.itemIds.zip, { state: 'INCOMPLETE', stateReason: null })).toBe(1)
  })
})

describe('declaration requests asked of a supplier', () => {
  it('runs SENT → ANSWERED → ACCEPTED in the portal: its task, a reminder, the upload accepted, every line answered', async () => {
    const r = await newRequest({ kind: 'CR6', svhcListVersionId: null, channel: 'PORTAL', sentAt: ago(10), dueOn: dayIn(5) })
    // The task: an UPLOAD_DOCUMENT task of the party about this request (a copy of SEED-SD-0003's, made for this one).
    const task = randomUUID()
    expect(await copyRow(office(), 'PartnerTask', s.taskId, { id: task, recordId: r.id, recordLabel: 'T-SD', sourceKey: `SupplierDeclarationRequest:${r.id}` })).toBe(1)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"partnerTaskId" = $2::uuid`, s.taskId)).rejects.toThrow(/about this request/)
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `"partnerTaskId" = $2::uuid`, task)).toBe(1)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"partnerTaskId" = NULL`)).rejects.toThrow(/set once/)
    // Reminders: one at a time, each later.
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"remindersSent" = 2, "lastRemindedAt" = now()`)).rejects.toThrow(/one at a time/)
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `"remindersSent" = 1, "lastRemindedAt" = now()`)).toBe(1)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"remindersSent" = 2, "lastRemindedAt" = now() - interval '1 day'`)).rejects.toThrow(/each later than the last/)
    // Not overdue before its due day; what was asked never changes.
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'OVERDUE'`)).rejects.toThrow(/only after its due day/)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"dueOn" = $2::date`, dayIn(9))).rejects.toThrow(/never changes/)
    // The answer: the party's DECLARATION upload (a file of a request is the other channels').
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ANSWERED', "answeredAt" = now(), "answerFileId" = $2::uuid`, s.answerFileIds.accepted)).rejects.toThrow(/portal upload \(PORTAL\)/)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ANSWERED', "answeredAt" = now()`)).rejects.toThrow(/portal upload \(PORTAL\)/)
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ANSWERED', "answeredAt" = now(), "uploadId" = $2::uuid, "validTo" = $3::date`, s.uploadId, dayIn(365))).toBe(1)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"answeredAt" = now() + interval '1 minute'`)).rejects.toThrow(/never changes once it came/)
    // Accepted only with every line answered and the upload accepted (the document in force).
    const accept = () => update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ACCEPTED', "decidedAt" = now(), "decidedById" = $2::uuid, "decidedByName" = 'Seed Compliance Lead'`, A.member)
    await expect(accept()).rejects.toThrow(/an answer for each \(1 of 1 not answered\)/)
    expect(await update(office(), 'SupplierDeclarationLine', r.line, `contains = false`)).toBe(1)
    await expect(accept()).rejects.toThrow(/its portal upload accepted .*WAITING/)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ACCEPTED', "decidedAt" = now()`)).rejects.toThrow(/name of who decided/)
    await admin(`UPDATE "SupplierDocumentUpload" SET "receivedAt" = now(), status = 'ACCEPTED', "decidedAt" = now(), "decidedByName" = 'Seed Buyer', "acceptedCategory" = 'DECLARATION', "documentFileId" = "fileId", version = version + 1 WHERE id = $1`, [s.uploadId])
    expect(await accept()).toBe(1)
    // Frozen: lines and the request (the internal note only).
    await expect(update(office(), 'SupplierDeclarationLine', r.line, `note = 'late'`)).rejects.toThrow(/only while it waits or is answered \(it is ACCEPTED\)/)
    await expect(run(office(), `DELETE FROM "SupplierDeclarationLine" WHERE id = $1::uuid`, r.line)).rejects.toThrow(/only while it waits or is answered/)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"validTo" = NULL`)).rejects.toThrow(/is ACCEPTED and never changes again/)
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `"internalNote" = 'Filed with the technical file.'`)).toBe(1)
    await refusedDelete('SupplierDeclarationRequest', r.id)
  })

  it('starts SENT, asks the Candidate List version for SVHC only, and moves only along its paths', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'SupplierDeclarationRequest', s.requestIds.again, { id: randomUUID(), number: tag('T-SD'), supersedesId: null, ...changes })
    await expect(copy({ status: 'ANSWERED' })).rejects.toThrow(/starts SENT/)
    await expect(copy({ remindersSent: 1, lastRemindedAt: new Date().toISOString() })).rejects.toThrow(/starts SENT/)
    await expect(copy({ svhcListVersionId: null })).rejects.toThrow(/exactly for a REACH_SVHC declaration/)
    await expect(copy({ kind: 'RSL' })).rejects.toThrow(/exactly for a REACH_SVHC declaration/)
    await expect(copy({ partnerTaskId: s.taskId, channel: 'OFFICE' })).rejects.toThrow(/portal task only when asked in the portal/)
    await expect(copy({ dueOn: '2026-01-01' })).rejects.toThrow(/due on or after the day it went out/)
    await expect(copy({ reminderEveryDays: 0 })).rejects.toThrow(/every 1 to 90 days/)
    await expect(copy({ number: ' ' })).rejects.toThrow(/has its number/)
    const r = await newRequest()
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ACCEPTED'`)).rejects.toThrow(/not SENT → ACCEPTED/)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'CANCELLED'`)).rejects.toThrow(/CANCELLED exactly with when and why/)
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Asked the wrong supplier.'`)).toBe(1)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'SENT', "cancelledAt" = NULL, "cancelReason" = NULL`)).rejects.toThrow(/is CANCELLED and never changes again/)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `number = 'T-OTHER'`)).rejects.toThrow(/never changes/)
  })

  it('is OVERDUE after its due day; answered late by hand with a file of the request, then refused with the reason', async () => {
    const r = await newRequest({ sentAt: ago(20), dueOn: ago(3).slice(0, 10) })
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `status = 'OVERDUE'`)).toBe(1)
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `"remindersSent" = 1, "lastRemindedAt" = now()`)).toBe(1)
    // The answer of SEED-SD-0002 is a file of that request, not of this one.
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ANSWERED', "answeredAt" = now(), "answerFileId" = $2::uuid`, s.answerFileIds.accepted)).rejects.toThrow(/a file of this request/)
    const file = randomUUID()
    await admin(
      `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(f) || jsonb_build_object('id', $1::text, 'recordId', $2::text, 'storageKey', $3::text) FROM "StoredFile" f WHERE f.id = $4::uuid))`,
      [file, r.id, tag('t/test/key'), s.answerFileIds.accepted],
    )
    expect(await update(office(), 'SupplierDeclarationRequest', r.id, `status = 'ANSWERED', "answeredAt" = now(), "answerFileId" = $2::uuid, "answeredListVersionId" = $3::uuid`, file, s.listVersionIds.v1)).toBe(1)
    await expect(update(office(), 'SupplierDeclarationRequest', r.id, `"remindersSent" = 2, "lastRemindedAt" = now() + interval '1 minute'`)).rejects.toThrow(/while it waits for the answer/)
    const refuse = (reason: string | null) =>
      update(office(), 'SupplierDeclarationRequest', r.id, `status = 'REFUSED', "decidedAt" = now(), "decidedByName" = 'Seed Compliance Lead', "refuseReason" = $2`, reason)
    await expect(refuse(null)).rejects.toThrow(/refused, why in 3 to 500 characters/)
    await expect(refuse('no')).rejects.toThrow(/refused, why in 3 to 500 characters/)
    expect(await refuse('It answers the January list; we asked for the July one.')).toBe(1)
  })

  it('asks again only a decided or cancelled request of the same kind', async () => {
    const open = await newRequest()
    const again = (supersedesId: string, changes: Record<string, unknown> = {}) =>
      copyRow(office(), 'SupplierDeclarationRequest', s.requestIds.again, { id: randomUUID(), number: tag('T-SD'), supersedesId, ...changes })
    await expect(again(open.id)).rejects.toThrow(/accepted, refused or cancelled \(it is REACH_SVHC SENT\)/)
    await expect(again(s.requestIds.overdue, { kind: 'NICKEL', svhcListVersionId: null })).rejects.toThrow(/NICKEL OVERDUE/)
    await expect(again(s.requestIds.refused)).rejects.toThrow(/foreign key|violates/)
    expect(await again(s.requestIds.accepted)).toBe(1)
  })

  it('takes lines while open: none yet, no, or yes with the substance; an SVHC above 0.1 % w/w is above the threshold', async () => {
    const r = await newRequest()
    const set = (assignments: string, ...values: unknown[]) => update(office(), 'SupplierDeclarationLine', r.line, assignments, ...values)
    await expect(set(`"aboveThreshold" = false`)).rejects.toThrow(/answers not yet or no with nothing more/)
    await expect(set(`contains = false, "substanceName" = 'DEHP'`)).rejects.toThrow(/answers not yet or no/)
    await expect(set(`contains = true, "aboveThreshold" = false`)).rejects.toThrow(/the substance/)
    await expect(set(`contains = true, "aboveThreshold" = false, "substanceId" = $2::uuid`, s.substanceIds.nickel)).rejects.toThrow(/names an SVHC of the Candidate List/)
    await expect(set(`contains = true, "aboveThreshold" = false, "substanceId" = $2::uuid, concentration = 0.15, "concentrationUnit" = 'PERCENT_WW'`, s.substanceIds.dehp)).rejects.toThrow(/over 0.1 % w\/w/)
    await expect(set(`contains = true, "aboveThreshold" = true, "substanceId" = $2::uuid, concentration = 0.1, "concentrationUnit" = 'PERCENT_WW'`, s.substanceIds.dehp)).rejects.toThrow(/over 0.1 % w\/w/)
    await expect(set(`contains = true, "aboveThreshold" = true, "substanceId" = $2::uuid, concentration = 0.15`, s.substanceIds.dehp)).rejects.toThrow(/with its unit or neither/)
    expect(await set(`contains = true, "aboveThreshold" = true, "substanceId" = $2::uuid, concentration = 0.15, "concentrationUnit" = 'PERCENT_WW'`, s.substanceIds.dehp)).toBe(1)
    expect(await set(`contains = true, "aboveThreshold" = false, "substanceId" = NULL, "substanceName" = 'A substance the supplier named', concentration = 500, "concentrationUnit" = 'MG_KG'`)).toBe(1)
    await expect(set(`"itemId" = $2::uuid`, s.itemIds.protector)).rejects.toThrow(/request, material and creation/)
    await expect(set(`seq = 0`)).rejects.toThrow(/its place from 1/)
    // A line of another party's request: the reference pins the party.
    await expect(copyRow(office(), 'SupplierDeclarationLine', r.line, { id: randomUUID(), seq: 9, partyId: A.P1 })).rejects.toThrow(/foreign key|violates/)
    expect(await run(office(), `DELETE FROM "SupplierDeclarationLine" WHERE id = $1::uuid`, r.line)).toBe(1)
  })
})

describe('test plan rules', () => {
  const add = (changes: Record<string, unknown>) => copyRow(office(), 'TestPlanRule', s.testPlanIds.cr6, { id: randomUUID(), ...changes })

  it('apply to a kind or one material, and prove a substance rule of their own test', async () => {
    await expect(add({ itemId: s.itemIds.leather })).rejects.toThrow(/exactly one/)
    await expect(add({ itemKind: 'FINISHED' })).rejects.toThrow(/never FINISHED/)
    await expect(add({ test: 'AZO' })).rejects.toThrow(/of its own test \(a CR6 rule for a AZO test\)/)
    await expect(add({ marketCode: 'france' })).rejects.toThrow(/market code/)
    await expect(add({ switchedOn: false })).rejects.toThrow(/OFF saying why/)
    expect(await add({ test: 'AZO', substanceRuleId: s.ruleIds.azo, frequency: 'ON_CHANGE' })).toBe(1)
    // A CMR (or OTHER) rule is proved by any test.
    expect(await add({ test: 'NPE', substanceRuleId: s.ruleIds.cmr, itemKind: 'TEXTILE' })).toBe(1)
    expect(await add({ itemKind: null, itemId: s.itemIds.zip, test: 'NICKEL', substanceRuleId: s.ruleIds.nickel, marketCode: 'US-CA' })).toBe(1)
    await refusedDelete('TestPlanRule', s.testPlanIds.cr6)
  })
})

describe('lab results of the new tests (W1\'s guard, redefined)', () => {
  const result = async () => (await one(`SELECT id::text AS id FROM "LabResult" WHERE "tenantId" = $1 AND test = 'CR_VI' ORDER BY "createdAt" LIMIT 1`, [a.tenantId])).id as string
  const add = async (changes: Record<string, unknown>) => copyRow(office(), 'LabResult', await result(), { id: randomUUID(), supersedesId: null, ...changes })

  it('keeps chromium VI as W1 wrote it', async () => {
    await expect(add({ method: 'EN ISO 17234-1' })).rejects.toThrow(/chromium VI result in mg\/kg, by EN ISO 17075-1 or -2/)
    await expect(add({ valueMgKg: 3, verdict: 'PASS' })).rejects.toThrow(/at or above FAIL/)
    await expect(add({ limitMgKg: 2 })).rejects.toThrow(/its lot's own chromium VI limit/)
  })

  it('records an azo, nickel or PAH result with its method, unit and the rule\'s limit; at the limit the rule decides', async () => {
    const azo = { test: 'AZO', method: 'EN ISO 17234-1', unit: 'mg/kg', limitMgKg: 30 }
    expect(await add({ ...azo, valueMgKg: 12, verdict: 'PASS' })).toBe(1)
    await expect(add({ ...azo, valueMgKg: 31, verdict: 'PASS' })).rejects.toThrow(/below PASS, above FAIL/)
    await expect(add({ ...azo, valueMgKg: 12, verdict: 'FAIL' })).rejects.toThrow(/below PASS, above FAIL/)
    // At the limit: azo passes at 30 mg/kg (entry 43 restricts "above"); the API decides by the rule's bound.
    expect(await add({ ...azo, valueMgKg: 30, verdict: 'PASS' })).toBe(1)
    expect(await add({ ...azo, valueMgKg: 30, verdict: 'FAIL' })).toBe(1)
    await expect(add({ ...azo, method: ' ' })).rejects.toThrow(/names its method/)
    await expect(add({ ...azo, unit: 'ppm' })).rejects.toThrow(/its unit/)
    await expect(add({ ...azo, limitMgKg: 0, valueMgKg: 0, verdict: 'PASS' })).rejects.toThrow(/above 0/)
    // Nickel release: µg/cm²/week, and only nickel.
    await expect(add({ test: 'NICKEL', method: 'EN 1811', unit: 'mg/kg', limitMgKg: 0.5, valueMgKg: 0.2, verdict: 'PASS' })).rejects.toThrow(/exactly for nickel release/)
    await expect(add({ ...azo, unit: 'µg/cm²/week', valueMgKg: 12, verdict: 'PASS' })).rejects.toThrow(/exactly for nickel release/)
    expect(await add({ test: 'NICKEL', method: 'EN 1811', unit: 'µg/cm²/week', limitMgKg: 0.5, valueMgKg: 0.2, verdict: 'PASS' })).toBe(1)
    // Below a detection limit: PASS only at or below the limit.
    const below = { ...azo, test: 'PAH', method: 'AfPS GS 2019:01 PAK', limitMgKg: 1, valueMgKg: null, belowDetectionLimit: true }
    expect(await add({ ...below, detectionLimitMgKg: 0.2, verdict: 'PASS' })).toBe(1)
    await expect(add({ ...below, detectionLimitMgKg: 2, verdict: 'PASS' })).rejects.toThrow(/below a detection limit only at or below the limit/)
  })

  it('supersedes only a PASS of its own test', async () => {
    const pass = randomUUID()
    expect(await add({ id: pass, test: 'AZO', method: 'EN ISO 17234-1', unit: 'mg/kg', limitMgKg: 30, valueMgKg: 5, verdict: 'PASS' })).toBe(1)
    await expect(add({ test: 'DMFU', method: 'CEN ISO/TS 16186', unit: 'mg/kg', limitMgKg: 0.1, valueMgKg: 0.5, verdict: 'FAIL', supersedesId: pass })).rejects.toThrow(/a result of its own test \(a DMFU result, not AZO\)/)
    expect(await add({ test: 'AZO', method: 'EN ISO 17234-1', unit: 'mg/kg', limitMgKg: 30, valueMgKg: 45, verdict: 'FAIL', supersedesId: pass })).toBe(1)
  })
})

describe('grants', () => {
  it('the supplier reads its own requests and lines, never the hidden columns; the floor reads none', async () => {
    const p1 = await sql(partner(A.P1), `SELECT number, status::text AS status, "refuseReason", "decidedByName" FROM "SupplierDeclarationRequest" ORDER BY number`)
    expect(p1.map((row) => row.number)).toEqual(['SEED-SD-0005'])
    expect(p1[0]).toMatchObject({ status: 'REFUSED', decidedByName: 'Seed Compliance Lead' })
    expect(p1[0]!.refuseReason).toMatch(/does not name the lining/)
    const p2 = await sql(partner(A.P2), `SELECT number FROM "SupplierDeclarationRequest" WHERE number LIKE 'SEED-%' ORDER BY number`)
    expect(p2.map((row) => row.number)).toEqual(['SEED-SD-0001', 'SEED-SD-0002', 'SEED-SD-0003', 'SEED-SD-0004'])
    const lines = await sql(partner(A.P1), `SELECT "articleLabel", contains FROM "SupplierDeclarationLine"`)
    expect(lines).toEqual([{ articleLabel: 'Seed brand mesh lining', contains: false }])
    for (const column of ['internalNote', 'decidedById', 'createdById']) {
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "SupplierDeclarationRequest"`)).rejects.toThrow(/permission denied/)
    }
    await expect(sql(partner(A.P1), `SELECT "createdById" FROM "SupplierDeclarationLine"`)).rejects.toThrow(/permission denied/)
    await expect(run(partner(A.P1), `UPDATE "SupplierDeclarationRequest" SET status = status`)).rejects.toThrow(/permission denied/)
    for (const table of ['RestrictedSubstance', 'SubstanceRule', 'SvhcListVersion', 'MaterialComplianceProfile', 'TestPlanRule']) {
      await expect(sql(partner(A.P1), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    for (const table of ['RestrictedSubstance', 'SubstanceRule', 'SvhcListVersion', 'MaterialComplianceProfile', 'SupplierDeclarationRequest', 'SupplierDeclarationLine', 'TestPlanRule']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(run(office(), `TRUNCATE "${table}" CASCADE`)).rejects.toThrow(/permission denied|TRUNCATE/)
    }
  })
})
