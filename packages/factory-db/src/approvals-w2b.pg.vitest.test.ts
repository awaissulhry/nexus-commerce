import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedApprovals, type ApprovalsSeed } from '../seed/approvals'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Approvals and workflow (W2b-5, schema wave 35/44, B-W2b-276, …_approvals_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - approval rules: built switched off; the RuleBuilder's condition; exactly one approver, an office role or an office person
 *     who has not left; kind, company and creation fixed; never deleted;
 *   - requests: asked PENDING, what was asked fixed, decided once (a yes with its comment and step-up, a no with its reason code
 *     and words), withdrawn or found stale; the rules that asked are the kind's, of the company or tenant-wide;
 *   - NOBODY DECIDES THEIR OWN REQUEST, the Owner included (Owner answer Q3 = A), whatever the path: the office scope and the
 *     owner login alike; nor the writer, nor the office account of a worker who asked on the floor; a named approver is never
 *     one of them and is the only one who decides;
 *   - the history: append-only, a task's line agrees with its task, a domain approval's decision never by the person of the
 *     record's last REQUESTED line;
 *   - grants: the office only (the floor and partners read nothing); the reject reasons as a coded list.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-276-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: ApprovalsSeed

const key = (name: string): string => seedUuid(NS, name)
const ROLE = { owner: key('role:owner'), finance: key('role:finance'), admin: key('role:admin'), operator: key('role:operator') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: s.siteA1 })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns); `owner`: through the owner login. */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const sha = (): string => randomUUID().replace(/-/g, '').padEnd(64, '0')
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

/** A new rule: a copy of the PO rule (off) with `changes`. */
const addRule = (changes: Record<string, unknown>) => copyRow(office(), 'ApprovalRule', s.ruleIds.po, { id: randomUUID(), ...changes })
/** A new PENDING request: a copy of PO2's (asked by the Owner, for Finance) with `changes`; its id. */
async function newTask(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'ApprovalTask', s.taskIds.pending, { id, fingerprint: sha(), requestedAt: ago(30), createdAt: ago(30), dueAt: null, ...changes })).toBe(1)
  return id
}
/** A line of the history: a copy of PO2's REQUESTED line with `changes`. */
const addLine = (changes: Record<string, unknown>) => copyRow(office(), 'ApprovalEvent', s.eventIds.requested, { id: randomUUID(), at: ago(1), createdAt: ago(0), ...changes })

beforeAll(async () => {
  db = await migratedDatabase('approvalsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedApprovals({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedApprovals({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('approval rules', () => {
  it('are built switched off: no request needs a yes until a person switches a rule on (Owner answer Q3)', async () => {
    const rules = await admin(`SELECT active FROM "ApprovalRule" WHERE "tenantId" = $1::uuid`, [a.tenantId])
    expect(rules).toHaveLength(5)
    expect(rules.every((row) => row.active === false)).toBe(true)
    const id = randomUUID()
    expect(
      await run(office(), `INSERT INTO "ApprovalRule" (id, kind, name, condition, "approverRoleId") VALUES ($1::uuid, 'PURCHASE_REQUEST', 'Asks to buy', '{"combinator":"and","rows":[]}', $2::uuid)`, id, ROLE.finance),
    ).toBe(1)
    expect((await admin(`SELECT active, sequence FROM "ApprovalRule" WHERE id = $1::uuid`, [id]))[0]).toEqual({ active: false, sequence: 100 })
    expect(await update(office(), 'ApprovalRule', id, `active = true, version = version + 1, "updatedById" = $2::uuid`, s.memberId)).toBe(1)
  })

  it("keep the RuleBuilder's condition", async () => {
    const cond = (value: unknown) => addRule({ condition: value })
    const row = (field: string, operator: string, value: unknown) => ({ combinator: 'and', rows: [{ id: 'r1', field, operator, value }] })
    await expect(cond({ combinator: 'xor', rows: [] })).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond({ combinator: 'and', rows: {} })).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond({ combinator: 'and', rows: [], extra: 1 })).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('orderValue', 'between', '5'))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('Order Value', 'gt', '5'))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('overLimit', 'isTrue', 'yes'))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('supplierStatus', 'in', 'APPROVED'))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('supplierStatus', 'in', []))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('orderValue', 'gt', ''))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond(row('orderValue', 'gt', 5))).rejects.toThrow(/as the RuleBuilder does/)
    await expect(cond({ combinator: 'or', rows: Array.from({ length: 51 }, (_, n) => ({ field: 'orderValue', operator: 'gt', value: String(n) })) })).rejects.toThrow(/as the RuleBuilder does/)
    expect(await cond(row('supplierStatus', 'notIn', ['APPROVED', 'CONDITIONAL']))).toBe(1)
    expect(await cond(row('overLimit', 'isFalse', null))).toBe(1)
    expect(await cond({ combinator: 'or', rows: [{ field: 'margin.pct', operator: 'lt', value: '25' }, { field: 'discountPct', operator: 'gte', value: '10,5' }] })).toBe(1)
  })

  it('name exactly one approver: an office role, or an office person who has not left', async () => {
    await expect(addRule({ approverUserId: s.memberId })).rejects.toThrow(/exactly one approver/)
    await expect(addRule({ approverRoleId: null })).rejects.toThrow(/exactly one approver/)
    await expect(addRule({ approverRoleId: ROLE.operator })).rejects.toThrow(/not an office role/)
    expect(await addRule({ approverRoleId: null, approverUserId: s.memberId })).toBe(1)
    const left = randomUUID()
    expect(await copyRow(office(), 'User', s.memberId, { id: left, email: `left.${left}@example.com`, status: 'DEACTIVATED', passwordHash: null })).toBe(1)
    await expect(addRule({ approverRoleId: null, approverUserId: left })).rejects.toThrow(/not an office user of the tenant \(or has left\)/)
  })

  it('keep their kind, company and creation; their bounds; never deleted', async () => {
    const id = randomUUID()
    expect(await addRule({ id })).toBe(1)
    await expect(update(office(), 'ApprovalRule', id, `kind = 'SALES_ORDER'`)).rejects.toThrow(/keeps its kind, company and creation/)
    await expect(update(office(), 'ApprovalRule', id, `"companyId" = NULL`)).rejects.toThrow(/keeps its kind, company and creation/)
    await expect(update(office(), 'ApprovalRule', id, `version = version + 2`)).rejects.toThrow(/version by one at most/)
    await expect(update(office(), 'ApprovalRule', id, `name = ' '`)).rejects.toThrow(/a name of one line/)
    await expect(update(office(), 'ApprovalRule', id, `name = E'Two\\nlines'`)).rejects.toThrow(/a name of one line/)
    await expect(update(office(), 'ApprovalRule', id, `sequence = 0`)).rejects.toThrow(/between 1 and 9999/)
    await expect(update(office(), 'ApprovalRule', id, `"dueHours" = 2161`)).rejects.toThrow(/1 to 2160 hours/)
    await expect(addRule({ version: 2 })).rejects.toThrow(/starts at version 1/)
    expect(await update(office(), 'ApprovalRule', id, `name = 'POs over 8,000', condition = '{"combinator":"and","rows":[{"field":"orderValue","operator":"gt","value":"8000"}]}', "approverRoleId" = $2::uuid, "signatureMeaning" = 'RELEASED', "requireStepUp" = true, active = true, version = version + 1`, ROLE.owner)).toBe(1)
    await expect(run(office(), `DELETE FROM "ApprovalRule" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "ApprovalRule" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
  })
})

describe('requests for a yes', () => {
  it('are asked PENDING at version 1, by one person, for one approver, because of rules of their kind', async () => {
    await expect(newTask({ status: 'APPROVED', decidedAt: ago(1), decidedById: s.memberId })).rejects.toThrow(/asked PENDING at version 1/)
    await expect(newTask({ comment: 'Early.' })).rejects.toThrow(/asked PENDING at version 1/)
    await expect(newTask({ version: 2 })).rejects.toThrow(/asked PENDING at version 1/)
    await expect(newTask({ recordType: 'purchase order' })).rejects.toThrow(/by its model name/)
    await expect(newTask({ summary: '' })).rejects.toThrow(/one line of 1 to 500/)
    await expect(newTask({ preview: { fields: [] } })).rejects.toThrow(/shows its change/)
    await expect(newTask({ preview: { changes: [{ field: 'price', from: '1', to: '2', grain: 'euro' }] } })).rejects.toThrow(/shows its change/)
    await expect(newTask({ preview: { changes: [{ from: '1', to: '2' }] } })).rejects.toThrow(/shows its change/)
    await expect(newTask({ fingerprint: 'ABC' })).rejects.toThrow(/SHA-256 fingerprint/)
    await expect(newTask({ requestedByWorkerId: s.workerId, siteId: s.siteA1 })).rejects.toThrow(/exactly one person who asked/)
    await expect(newTask({ requestedById: null })).rejects.toThrow(/exactly one person who asked/)
    await expect(newTask({ requestedById: null, requestedByWorkerId: s.workerId })).rejects.toThrow(/names the site of the worker/)
    await expect(newTask({ approverUserId: s.memberId })).rejects.toThrow(/exactly one approver/)
    await expect(newTask({ approverRoleId: ROLE.operator })).rejects.toThrow(/not an office role/)
    await expect(newTask({ ruleIds: [s.ruleIds.po, s.ruleIds.po] })).rejects.toThrow(/each once/)
    await expect(newTask({ ruleIds: [s.ruleIds.so] })).rejects.toThrow(/not a PURCHASE_ORDER rule/)
    await expect(newTask({ ruleIds: [randomUUID()] })).rejects.toThrow(/not an approval rule of the tenant/)
    await expect(newTask({ requestedAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/not asked in the future/)
    await expect(newTask({ dueAt: ago(60) })).rejects.toThrow(/due after it was asked/)
    // A domain switch asks without a rule; a tenant-wide rule asks for every company; a request asked on the floor.
    expect(await newTask({ ruleIds: [] })).toBeTruthy()
    expect(await newTask({ kind: 'STOCK_ADJUSTMENT', ruleIds: [s.ruleIds.adjustment], companyId: key('company:B'), recordType: 'Item', recordId: randomUUID() })).toBeTruthy()
    expect(await newTask({ requestedById: null, requestedByWorkerId: s.workerId, siteId: s.siteA1, createdById: s.memberId, approverRoleId: ROLE.finance })).toBeTruthy()
  })

  it('keep what was asked; are decided once, then frozen; are never deleted', async () => {
    const id = await newTask()
    for (const set of [`summary = 'Other words'`, `fingerprint = '${sha()}'`, `"ruleIds" = '{}'`, `"approverRoleId" = '${ROLE.admin}'`, `"requireStepUp" = true`, `"recordId" = '${randomUUID()}'`]) {
      await expect(update(office(), 'ApprovalTask', id, set)).rejects.toThrow(/keeps what was asked/)
    }
    await expect(update(office(), 'ApprovalTask', id, `status = 'APPROVED'`)).rejects.toThrow(/exactly with when and by whom/)
    await expect(update(office(), 'ApprovalTask', id, `status = 'APPROVED', "decidedAt" = now() + interval '1 hour', "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/not in the future/)
    await expect(update(office(), 'ApprovalTask', id, `status = 'APPROVED', "decidedAt" = now() - interval '2 hours', "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/not before it was asked/)
    await expect(update(office(), 'ApprovalTask', id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 2`, s.memberId)).rejects.toThrow(/version by one at most/)
    expect(await update(office(), 'ApprovalTask', id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, comment = E'Fine.\\nSend it.', version = version + 1`, s.memberId)).toBe(1)
    await expect(update(office(), 'ApprovalTask', id, `comment = 'Changed my mind.'`)).rejects.toThrow(/APPROVED already: it never changes again/)
    await expect(update(office(), 'ApprovalTask', id, `status = 'PENDING', "decidedAt" = NULL, "decidedById" = NULL, comment = NULL`)).rejects.toThrow(/never changes again/)
    await expect(run(office(), `DELETE FROM "ApprovalTask" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "ApprovalTask" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
  })

  it('say no with a reason code of the list and words; a comment only with a yes; the step-up where asked', async () => {
    const no = await newTask()
    await expect(update(office(), 'ApprovalTask', no, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/reason code of the APPROVAL_REJECT list/)
    await expect(update(office(), 'ApprovalTask', no, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, "rejectReasonCode" = 'OVER_BUDGET'`, s.memberId)).rejects.toThrow(/reason code of the APPROVAL_REJECT list/)
    await expect(update(office(), 'ApprovalTask', no, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, "rejectReasonCode" = 'over budget', "rejectReason" = 'Too much.'`, s.memberId)).rejects.toThrow(/reason code of the APPROVAL_REJECT list/)
    await expect(update(office(), 'ApprovalTask', no, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, "rejectReasonCode" = 'OVER_BUDGET', "rejectReason" = 'Too much.', comment = 'No.'`, s.memberId)).rejects.toThrow(/a comment only with a yes/)
    await expect(update(office(), 'ApprovalTask', no, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, "rejectReasonCode" = 'OVER_BUDGET', "rejectReason" = 'Too much.', "stepUpAt" = now()`, s.memberId)).rejects.toThrow(/step-up only with its yes/)
    await expect(update(office(), 'ApprovalTask', no, `"rejectReasonCode" = 'OVER_BUDGET', "rejectReason" = 'Too much.'`)).rejects.toThrow(/REJECTED exactly with a reason code/)
    expect(await update(office(), 'ApprovalTask', no, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, "rejectReasonCode" = 'OVER_BUDGET', "rejectReason" = 'Too much for this month.', version = version + 1`, s.memberId)).toBe(1)

    const signed = await newTask({ requireStepUp: true, signatureMeaning: 'RELEASED' })
    await expect(update(office(), 'ApprovalTask', signed, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/fresh step-up/)
    await expect(update(office(), 'ApprovalTask', signed, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, "stepUpAt" = now() - interval '20 minutes'`, s.memberId)).rejects.toThrow(/at most 15 minutes before the yes/)
    expect(await update(office(), 'ApprovalTask', signed, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, "stepUpAt" = now() - interval '3 minutes', version = version + 1`, s.memberId)).toBe(1)
  })

  it('are withdrawn or found stale exactly with when', async () => {
    const back = await newTask()
    await expect(update(office(), 'ApprovalTask', back, `status = 'WITHDRAWN'`)).rejects.toThrow(/WITHDRAWN exactly with when/)
    await expect(update(office(), 'ApprovalTask', back, `"withdrawnAt" = now()`)).rejects.toThrow(/WITHDRAWN exactly with when/)
    expect(await update(office(), 'ApprovalTask', back, `status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawnById" = $2::uuid`, a.actorId)).toBe(1)
    const stale = await newTask()
    await expect(update(office(), 'ApprovalTask', stale, `status = 'STALE'`)).rejects.toThrow(/STALE exactly with when/)
    await expect(update(office(), 'ApprovalTask', stale, `status = 'STALE', "staleAt" = now(), "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/exactly with when and by whom/)
    expect(await update(office(), 'ApprovalTask', stale, `status = 'STALE', "staleAt" = now()`)).toBe(1)
  })
})

describe('nobody decides their own request, the Owner included (Owner answer Q3 = A)', () => {
  const approve = (scope: 'office' | 'owner', id: string, by: string) => {
    const set = `UPDATE "ApprovalTask" SET status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid WHERE id = $1::uuid`
    return scope === 'office' ? run(office(), set, id, by) : admin(set, [id, by])
  }

  it('refuses the person who asked on every path: the office scope and the owner login', async () => {
    // PO2's copy: asked by the Owner (the tenant's owner role), addressed to Finance's holders.
    const id = await newTask()
    await expect(approve('office', id, a.actorId)).rejects.toThrow(/nobody approves their own request, the Owner included/)
    await expect(approve('owner', id, a.actorId)).rejects.toThrow(/nobody approves their own request, the Owner included/)
    const reject = `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, "rejectReasonCode" = 'NOT_NEEDED', "rejectReason" = 'Mine.'`
    await expect(update(office(), 'ApprovalTask', id, reject, a.actorId)).rejects.toThrow(/nobody approves their own request/)
    expect(await approve('office', id, s.memberId)).toBe(1)
  })

  it('refuses the person who wrote the request for someone else', async () => {
    const id = await newTask({ requestedById: s.memberId, createdById: a.actorId })
    await expect(approve('office', id, a.actorId)).rejects.toThrow(/nobody approves their own request/)
    await expect(approve('office', id, s.memberId)).rejects.toThrow(/nobody approves their own request/)
    expect(await approve('office', id, key('user:invited'))).toBe(1)
  })

  it("refuses the office account of the worker who asked on the floor, as approver and as decider", async () => {
    expect(await admin(`UPDATE "Worker" SET "userId" = $2::uuid WHERE id = $1::uuid`, [s.workerId, s.memberId])).toBeDefined()
    try {
      const floorAsked = { requestedById: null, requestedByWorkerId: s.workerId, siteId: s.siteA1, createdById: a.actorId, kind: 'STOCK_ADJUSTMENT', ruleIds: [s.ruleIds.adjustment], recordType: 'Item', recordId: randomUUID() }
      await expect(newTask({ ...floorAsked, approverRoleId: null, approverUserId: s.memberId })).rejects.toThrow(/addressed to the person who asked/)
      const id = await newTask(floorAsked)
      await expect(approve('office', id, s.memberId)).rejects.toThrow(/nobody approves their own request/)
      await expect(approve('owner', id, s.memberId)).rejects.toThrow(/nobody approves their own request/)
      expect(await approve('office', id, key('user:invited'))).toBe(1)
    } finally {
      await admin(`UPDATE "Worker" SET "userId" = NULL WHERE id = $1::uuid`, [s.workerId])
    }
  })

  it('never addresses a request to the person who asked; a named approver is the only one who decides', async () => {
    await expect(newTask({ approverRoleId: null, approverUserId: a.actorId })).rejects.toThrow(/addressed to the person who asked/)
    const id = await newTask({ approverRoleId: null, approverUserId: s.memberId })
    await expect(approve('office', id, key('user:invited'))).rejects.toThrow(/only they decide it/)
    expect(await approve('office', id, s.memberId)).toBe(1)
  })
})

describe('the history', () => {
  it('is append-only, for every login', async () => {
    await expect(run(office(), `UPDATE "ApprovalEvent" SET words = 'Changed.' WHERE id = $1::uuid`, s.eventIds.commented)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "ApprovalEvent" SET words = 'Changed.' WHERE id = $1::uuid`, [s.eventIds.commented])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`DELETE FROM "ApprovalEvent" WHERE id = $1::uuid`, [s.eventIds.commented])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`TRUNCATE "ApprovalEvent"`)).rejects.toThrow(/TRUNCATE on "ApprovalEvent" is refused/)
  })

  it('says who, the words, the code and the meaning where each belongs', async () => {
    await expect(addLine({ action: 'COMMENTED', byId: null, words: 'Who?' })).rejects.toThrow(/names the person who did it/)
    await expect(addLine({ action: 'COMMENTED', byId: s.memberId, byWorkerId: s.workerId, words: 'Two.' })).rejects.toThrow(/names one person/)
    await expect(addLine({ action: 'COMMENTED', byId: s.memberId, words: null })).rejects.toThrow(/required for COMMENTED and REJECTED/)
    await expect(addLine({ action: 'COMMENTED', byId: s.memberId, words: 'Note.', reasonCode: 'OVER_BUDGET' })).rejects.toThrow(/only on REJECTED/)
    await expect(addLine({ action: 'COMMENTED', byId: s.memberId, words: 'Note.', meaning: 'APPROVED' })).rejects.toThrow(/a meaning only on SIGNED/)
    await expect(addLine({ action: 'COMMENTED', byId: s.memberId, words: 'Later.', at: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/not in the future/)
    await expect(addLine({ action: 'COMMENTED', byId: s.memberId, words: 'Elsewhere.', recordId: randomUUID() })).rejects.toThrow(/names the request's subject/)
    expect(await addLine({ action: 'COMMENTED', byId: s.memberId, words: 'Asked the supplier again.\nNo answer yet.' })).toBe(1)
  })

  it("agrees with its task: its requester, its decision, its decider, its meaning and code", async () => {
    await expect(addLine({ byId: s.memberId })).rejects.toThrow(/asked by the person who asked it/)
    await expect(addLine({ action: 'APPROVED', byId: s.memberId })).rejects.toThrow(/follows request .*'s yes/)
    await expect(addLine({ action: 'WITHDRAWN', byId: a.actorId })).rejects.toThrow(/follows request .*'s withdrawal/)
    await expect(addLine({ action: 'STALE', byId: null })).rejects.toThrow(/found stale/)
    // SEED-SO-0001's yes: by the Owner, signed 'Approved'.
    const so = { taskId: s.taskIds.approved, recordType: 'SalesOrder', recordId: s.salesOrderId }
    await expect(addLine({ ...so, action: 'SIGNED', byId: a.actorId, meaning: 'RELEASED' })).rejects.toThrow(/follows request .*'s yes/)
    await expect(addLine({ ...so, action: 'APPROVED', byId: s.memberId })).rejects.toThrow(/follows request .*'s yes/)
    await expect(addLine({ ...so, action: 'REJECTED', byId: a.actorId, words: 'No.', reasonCode: 'OVER_BUDGET' })).rejects.toThrow(/follows request .*'s no/)
    expect(await addLine({ ...so, action: 'SIGNED', byId: a.actorId, meaning: 'APPROVED' })).toBe(1)
    // The leather's no: by the member, MISSING_INFO.
    const leather = { taskId: s.taskIds.rejected, recordType: 'Item', recordId: (await admin(`SELECT "recordId" FROM "ApprovalTask" WHERE id = $1::uuid`, [s.taskIds.rejected]))[0]!.recordId }
    await expect(addLine({ ...leather, action: 'REJECTED', byId: s.memberId, words: 'No.', reasonCode: 'OVER_BUDGET' })).rejects.toThrow(/follows request .*'s no/)
    expect(await addLine({ ...leather, action: 'REQUESTED', byId: null, byWorkerId: s.workerId, words: 'Asked again on the tablet.' })).toBe(1)
  })

  it("never records a domain approval's decision by the person of the record's last REQUESTED line", async () => {
    const order = { taskId: null, recordType: 'ChangeOrder', recordId: randomUUID() }
    expect(await addLine({ ...order, action: 'REQUESTED', byId: a.actorId, at: ago(10) })).toBe(1)
    await expect(addLine({ ...order, action: 'APPROVED', byId: a.actorId })).rejects.toThrow(/nobody approves their own request, the Owner included/)
    await expect(addLine({ ...order, action: 'SIGNED', byId: a.actorId, meaning: 'APPROVED' })).rejects.toThrow(/nobody approves their own request/)
    expect(await addLine({ ...order, action: 'APPROVED', byId: s.memberId, at: ago(9) })).toBe(1)
    // Asked again, by the member: now the member may not decide, the Owner may.
    expect(await addLine({ ...order, action: 'REQUESTED', byId: s.memberId, at: ago(5) })).toBe(1)
    await expect(addLine({ ...order, action: 'REJECTED', byId: s.memberId, words: 'Mine.' })).rejects.toThrow(/nobody approves their own request/)
    expect(await addLine({ ...order, action: 'REJECTED', byId: a.actorId, words: 'Not this season.' })).toBe(1)
    // Asked on the floor by a worker whose office account is the member.
    await admin(`UPDATE "Worker" SET "userId" = $2::uuid WHERE id = $1::uuid`, [s.workerId, s.memberId])
    try {
      const scrap = { taskId: null, recordType: 'ScrapApproval', recordId: randomUUID() }
      expect(await addLine({ ...scrap, action: 'REQUESTED', byId: null, byWorkerId: s.workerId, at: ago(3) })).toBe(1)
      await expect(addLine({ ...scrap, action: 'APPROVED', byId: s.memberId })).rejects.toThrow(/nobody approves their own request/)
      await expect(addLine({ ...scrap, action: 'APPROVED', byId: null, byWorkerId: s.workerId })).rejects.toThrow(/nobody approves their own request/)
      expect(await addLine({ ...scrap, action: 'APPROVED', byId: a.actorId })).toBe(1)
    } finally {
      await admin(`UPDATE "Worker" SET "userId" = NULL WHERE id = $1::uuid`, [s.workerId])
    }
  })
})

describe('grants and the reject reasons', () => {
  it("are the office's: the floor and partners read nothing; nothing is truncated", async () => {
    for (const table of ['ApprovalRule', 'ApprovalTask', 'ApprovalEvent']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    expect((await sql(office(), `SELECT count(*)::int AS n FROM "ApprovalTask"`))[0]!.n).toBeGreaterThanOrEqual(5)
    // The history's key refuses a plain TRUNCATE of the requests first; with CASCADE, the triggers speak.
    await expect(admin(`TRUNCATE "ApprovalTask"`)).rejects.toThrow(/cannot truncate a table referenced in a foreign key constraint/)
    await expect(admin(`TRUNCATE "ApprovalTask" CASCADE`)).rejects.toThrow(/TRUNCATE on "Approval(Task|Event)" is refused/)
    await expect(admin(`TRUNCATE "ApprovalRule"`)).rejects.toThrow(/TRUNCATE on "ApprovalRule" is refused/)
  })

  it('keep the reject reasons as the APPROVAL_REJECT list', async () => {
    const codes = await sql(office(), `SELECT code FROM "ReasonCode" WHERE list = 'APPROVAL_REJECT' ORDER BY "sortOrder", code`)
    expect(codes.map((row) => row.code)).toEqual(['OVER_BUDGET', 'NEEDS_CHANGES', 'MISSING_INFO', 'NOT_NEEDED', 'OTHER'])
  })
})
