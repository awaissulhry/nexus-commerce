import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedProjects, type ProjectsSeed } from '../seed/projects'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * Projects (TH-5, threads schema wave 8/9, B-TH-065; …_projects_th_guards and the generated policy migration), on a database
 * built from the migrations and seeded twice, through the real login and the scoped client:
 *   - the wall (W01, W38): a portal session reads its own party's projects, their links and its own people's member rows, never
 *     the office's columns, never an office-only project; the second brand of the same factory (P2 here, testing/second-brand)
 *     reads none of P1's and P1 none of its; the floor reads nothing; a record of another company is refused as a link, at
 *     link time and when a linked record later becomes another company's; a portal person joins only a project of their own
 *     company, added by the office; a project's thread names the project's own outside company;
 *   - the project: numbered, made ACTIVE, ACTIVE ⇄ ON_HOLD → CLOSED with its outcome → reopened ACTIVE, a CLOSED one frozen; its
 *     company, number, outside company and creation fixed; led by an active office person; shared with a customer, brand,
 *     supplier or subcontractor that is neither blocked nor archived, of its company or every company;
 *   - the links: of the kinds a project links, a record of the tenant, of the project's company, once; added and removed while
 *     the project is open, never changed; FollowReason ADDED names who added.
 * The refusals are check_violation (23514), the wall's permission denied or a foreign key; the words name no customer.
 */

const NS = 'th-065-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let projects: ProjectsSeed
let second: SecondBrand

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  member: key('user:member'),
  invited: key('user:invited'),
  style: key('product:style:JKT-01'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string, actorId: string = randomUUID()): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
const ids = (rows: Record<string, unknown>[]): string[] => rows.map((row) => String(row.id)).sort()

let numbers = 0
/** A project of company A made by the office (`extra`: its outside company, lead …); answers its id. */
async function project(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Project', { id, companyId: A.companyA, number: `SEED-TH65-${++numbers}`, name: 'Seed test project', leadId: a.actorId, targetDate: '2027-02-01', ...extra })).toBe(1)
  return id
}
/** A link of `recordType` `recordId` to `projectId`, written by the office. */
const link = (projectId: string, recordType: string, recordId: string, extra: Record<string, unknown> = {}) =>
  insert(office(), 'ProjectLink', { id: randomUUID(), projectId, recordType, recordId, key: `link:${projectId}:${recordType}:${recordId}`, createdById: a.actorId, ...extra })
/** `userId` follows `recordType` `recordId` (a project unless said), written by the office. */
const follow = (recordId: string, userId: string, extra: Record<string, unknown> = {}) =>
  insert(office(), 'RecordFollower', { id: randomUUID(), recordType: 'Project', recordId, userId, reason: 'ADDED', createdById: a.actorId, ...extra })
/** A party of the tenant written by the office (`extra`: its company, status, roles). */
async function party(extra: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Party', { id, code: `SEED-TH65-${id.slice(0, 6)}`, kind: 'ORGANISATION', legalName: 'Seed Customer Six S.r.l.', roles: ['CUSTOMER'], status: 'ACTIVE', ...extra })).toBe(1)
  return id
}
/** A thread of a project (`partyId`: the party it is shared with), written by the office. */
const thread = (recordId: string, partyId: string | null) =>
  insert(office(), 'Thread', { id: randomUUID(), companyId: A.companyA, partyId, recordType: 'Project', recordId, replyToken: `seedth65${randomUUID().replace(/-/g, '').slice(0, 20)}`, createdById: a.actorId })
const statusOf = async (id: string) => (await admin(`SELECT status::text AS status FROM "Project" WHERE id = $1::uuid`, [id]))[0]!.status

beforeAll(async () => {
  db = await migratedDatabase('projectsth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  projects = await seedProjects({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedProjects({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and writes its projects, link and people once', async () => {
    expect(await admin(`SELECT number, status::text AS status, outcome::text AS outcome FROM "Project" WHERE "tenantId" = $1::uuid AND number LIKE 'SEED-PRJ-%' ORDER BY number`, [a.tenantId])).toEqual([
      { number: 'SEED-PRJ-001', status: 'ACTIVE', outcome: null },
      { number: 'SEED-PRJ-002', status: 'ON_HOLD', outcome: null },
      { number: 'SEED-PRJ-003', status: 'CLOSED', outcome: 'DONE' },
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "ProjectLink" WHERE "projectId" = $1::uuid`, [projects.active]))[0]!.n).toBe(1)
    expect(await admin(`SELECT reason::text AS reason, "partyId"::text AS party FROM "RecordFollower" WHERE "recordId" = $1::uuid ORDER BY reason, "partyId" NULLS FIRST`, [projects.active])).toEqual([
      { reason: 'ADDED', party: null },
      { reason: 'ADDED', party: A.P1 },
      { reason: 'CREATOR', party: null },
    ])
    // The company's PROJECT series.
    expect((await admin(`SELECT pattern FROM "NumberSeries" WHERE "companyId" = $1::uuid AND kind = 'PROJECT'`, [A.companyA]))[0]!.pattern).toBe('PRJ-{YY}-{N:3}')
  })
})

describe('the wall (W01, W38)', () => {
  it("a portal session reads its own party's projects, links and people, never an office-only project nor another brand's", async () => {
    const brandTwo = await project({ partyId: second.partyId, name: 'Seed Brand Two capsule' })
    expect(await link(brandTwo, 'SalesOrder', second.salesOrderId)).toBe(1)
    expect(await follow(brandTwo, second.userId, { partyId: second.partyId })).toBe(1)
    // P1: its two projects, its link, its buyer's member row; not the office-only one, not Brand Two's.
    const p1 = partner(A.P1, portal.userIds.p1Buyer)
    expect(ids(await sql(p1, `SELECT id FROM "Project"`))).toEqual([projects.active, projects.closed].sort())
    expect(ids(await sql(p1, `SELECT id FROM "ProjectLink"`))).toEqual([projects.styleLink])
    expect(ids(await sql(p1, `SELECT id FROM "RecordFollower"`))).toEqual([projects.buyerMember])
    for (const table of ['Project', 'ProjectLink', 'RecordFollower']) {
      expect(await sql(p1, `SELECT id FROM "${table}" WHERE "partyId" = $1::uuid`, second.partyId)).toEqual([])
    }
    // Brand Two (P2 of the wall tests): none of P1's, by id or by party; only its own.
    const two = partner(second.partyId, second.userId)
    expect(ids(await sql(two, `SELECT id FROM "Project"`))).toEqual([brandTwo])
    expect(await sql(two, `SELECT id FROM "Project" WHERE id = ANY($1::uuid[])`, [projects.active, projects.closed, projects.officeOnly])).toEqual([])
    expect(await sql(two, `SELECT id FROM "ProjectLink" WHERE "projectId" = $1::uuid`, projects.active)).toEqual([])
    expect(await sql(two, `SELECT id FROM "RecordFollower" WHERE "recordId" = $1::uuid`, projects.active)).toEqual([])
    // Never the office's columns.
    for (const [table, column] of [['Project', 'goal'], ['Project', 'leadId'], ['Project', 'outcome'], ['Project', 'outcomeNote'], ['Project', 'closedById'], ['ProjectLink', 'note'], ['RecordFollower', 'createdById']] as const) {
      await expect(sql(p1, `SELECT "${column}" FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    // A portal session writes none of it.
    await expect(run(p1, `UPDATE "Project" SET name = name WHERE id = $1::uuid`, projects.active)).rejects.toThrow(/permission denied/)
    await expect(run(p1, `DELETE FROM "RecordFollower" WHERE id = $1::uuid`, projects.buyerMember)).rejects.toThrow(/permission denied/)
    // The floor reads nothing.
    for (const table of ['Project', 'ProjectLink']) await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it("a record of another company never joins a project: not at link time, not by a later change", async () => {
    const words = /belongs to another company; it cannot join this project/
    // Brand Two's order in P1's project, P1's style in Brand Two's project, a customer's record in an office-only project.
    await expect(link(projects.active, 'SalesOrder', second.salesOrderId)).rejects.toThrow(words)
    const brandTwo = await project({ partyId: second.partyId })
    await expect(link(brandTwo, 'Style', A.style)).rejects.toThrow(words)
    await expect(link(await project(), 'Style', A.style)).rejects.toThrow(words)
    // The words name no company.
    await expect(link(projects.active, 'SalesOrder', second.salesOrderId)).rejects.toThrow(/^(?![\s\S]*SEED-)/)
    // A prospect's request (of no customer) joins P1's project; matching it to Brand Two later is refused, to P1 is not.
    const request = randomUUID()
    expect(
      await insert(office(), 'Inquiry', { id: request, companyId: A.companyA, number: `SEED-TH65-INQ-${request.slice(0, 6)}`, source: 'OFFICE', receivedAt: new Date(Date.now() - 60_000).toISOString(), prospectName: 'Seed Prospect', prospectLawfulBasis: 'CONTRACT', request: 'Seed: ten jackets.' }),
    ).toBe(1)
    expect(await link(projects.active, 'Inquiry', request)).toBe(1)
    await expect(run(office(), `UPDATE "Inquiry" SET "partyId" = $1::uuid WHERE id = $2::uuid`, second.partyId, request)).rejects.toThrow(/is linked to a project of another company/)
    expect(await run(office(), `UPDATE "Inquiry" SET "partyId" = $1::uuid WHERE id = $2::uuid`, A.P1, request)).toBe(1)
    // A linked style made another brand's private label: refused until it is unlinked.
    await expect(run(office(), `UPDATE "Style" SET "brandPartyId" = $1::uuid WHERE id = $2::uuid`, second.partyId, A.style)).rejects.toThrow(/is linked to a project of another company/)
  })

  it('a portal person joins only a project of their own company, added by the office', async () => {
    // Brand Two's buyer in P1's project; P1's buyer on an order; P1's buyer by choice; an office person with a party.
    await expect(follow(projects.active, second.userId, { partyId: second.partyId })).rejects.toThrow(/follows only a project shared with their own company/)
    await expect(follow(projects.active, second.userId, { partyId: A.P1 })).rejects.toThrow(/an office person \(no party\) or a portal person with their own party/)
    await expect(follow(projects.active, portal.userIds.p1Viewer)).rejects.toThrow(/an office person \(no party\) or a portal person with their own party/)
    await expect(follow(second.salesOrderId, portal.userIds.p1Viewer, { recordType: 'SalesOrder', partyId: A.P1 })).rejects.toThrow(/follows only a project shared with their own company/)
    await expect(follow(projects.officeOnly, portal.userIds.p1Viewer, { partyId: A.P1 })).rejects.toThrow(/follows only a project shared with their own company/)
    await expect(follow(projects.active, portal.userIds.p1Viewer, { partyId: A.P1, reason: 'CHOSE' })).rejects.toThrow(/only when the office ADDED them/)
    await expect(follow(projects.active, A.member, { partyId: A.P1, recordId: randomUUID() })).rejects.toThrow(/office person \(no party\)/)
    // P1's viewer added by the office: a member; its party never changes.
    expect(await follow(projects.active, portal.userIds.p1Viewer, { partyId: A.P1 })).toBe(1)
    await expect(run(office(), `UPDATE "RecordFollower" SET "partyId" = NULL WHERE "userId" = $1::uuid AND "recordId" = $2::uuid`, portal.userIds.p1Viewer, projects.active)).rejects.toThrow(/never changes/)
  })

  it("a project's thread is shared with the project's own outside company, or with nobody outside", async () => {
    await expect(thread(projects.active, second.partyId)).rejects.toThrow(/shared with the project's own outside company/)
    await expect(thread(projects.officeOnly, A.P1)).rejects.toThrow(/shared with the project's own outside company/)
    await expect(thread(randomUUID(), null)).rejects.toThrow(/thread of a project of the tenant/)
    expect(await thread(projects.active, A.P1)).toBe(1)
    expect(await thread(projects.officeOnly, null)).toBe(1)
  })
})

describe('the project (PROJ-G01)', () => {
  it('is made ACTIVE, held, closed with its outcome, frozen, reopened on its own', async () => {
    await expect(project({ status: 'CLOSED', outcome: 'DONE', outcomeNote: 'Seed: done.', closedAt: new Date().toISOString() })).rejects.toThrow(/made ACTIVE/)
    const id = await project({ partyId: A.P1 })
    const update = (set: string, ...values: unknown[]) => run(office(), `UPDATE "Project" SET ${set} WHERE id = $${values.length + 1}::uuid`, ...values, id)
    expect(await update(`status = 'ON_HOLD'`)).toBe(1)
    expect(await update(`status = 'ACTIVE'`)).toBe(1)
    // CLOSED needs its outcome, its line and when.
    await expect(update(`status = 'CLOSED'`)).rejects.toThrow(/CLOSED exactly with its outcome/)
    await expect(update(`status = 'CLOSED', outcome = 'DONE', "outcomeNote" = $1, "closedAt" = now()`, 'Seed: line one\nline two')).rejects.toThrow(/one line of 1 to 500/)
    await expect(update(`status = 'CLOSED', outcome = 'DONE', "outcomeNote" = 'Seed: done.', "closedAt" = now() + interval '1 day'`)).rejects.toThrow(/not in the future/)
    expect(await update(`status = 'CLOSED', outcome = 'STOPPED', "outcomeNote" = 'Seed: stopped by the brand.', "closedAt" = now(), "closedById" = $1::uuid`, a.actorId)).toBe(1)
    // Frozen; reopened on its own, the outcome goes; then it changes again.
    await expect(update(`name = 'Seed renamed'`)).rejects.toThrow(/CLOSED and never changes/)
    await expect(update(`status = 'ON_HOLD', outcome = NULL, "outcomeNote" = NULL, "closedAt" = NULL, "closedById" = NULL`)).rejects.toThrow(/cannot move from CLOSED to ON_HOLD/)
    await expect(update(`status = 'ACTIVE', outcome = NULL, "outcomeNote" = NULL, "closedAt" = NULL, "closedById" = NULL, name = 'Seed renamed'`)).rejects.toThrow(/reopened on its own/)
    await expect(update(`status = 'ACTIVE'`)).rejects.toThrow(/CLOSED exactly with its outcome/)
    expect(await update(`status = 'ACTIVE', outcome = NULL, "outcomeNote" = NULL, "closedAt" = NULL, "closedById" = NULL`)).toBe(1)
    expect(await update(`name = 'Seed renamed', goal = 'Seed: a new goal.'`)).toBe(1)
    expect(await statusOf(id)).toBe('ACTIVE')
  })

  it('keeps its company, number, outside company and creation; one line of name; an active office lead', async () => {
    const id = await project({ partyId: A.P1 })
    const update = (set: string, ...values: unknown[]) => run(office(), `UPDATE "Project" SET ${set} WHERE id = $${values.length + 1}::uuid`, ...values, id)
    await expect(update(`number = 'SEED-OTHER'`)).rejects.toThrow(/never changes/)
    await expect(update(`"partyId" = NULL`)).rejects.toThrow(/outside company and creation of project .* never change/)
    await expect(update(`"companyId" = $1::uuid`, a.companies[1]!.id)).rejects.toThrow(/never change/)
    await expect(project({ name: 'Seed\nname' })).rejects.toThrow(/name of one line/)
    await expect(project({ name: ' ' })).rejects.toThrow(/name of one line/)
    // The lead: an active office person (not someone invited, not a portal person).
    await expect(project({ leadId: A.invited })).rejects.toThrow(/led by an active office person/)
    await expect(project({ leadId: portal.userIds.p1Buyer })).rejects.toThrow(/led by an active office person/)
    await expect(update(`"leadId" = $1::uuid`, A.invited)).rejects.toThrow(/led by an active office person/)
    expect(await update(`"leadId" = $1::uuid`, A.member)).toBe(1)
    // A number from its company's series is given at insert.
    await expect(insert(office(), 'Project', { id: randomUUID(), companyId: A.companyA, number: ' ', name: 'Seed', leadId: a.actorId, targetDate: '2027-02-01' })).rejects.toThrow(/has its number/)
  })

  it('is shared with a customer, brand, supplier or subcontractor of its company or every company, not blocked nor archived', async () => {
    // P2 is a supplier: a supplier project.
    expect(await project({ partyId: A.P2 })).toBeTruthy()
    await expect(project({ partyId: await party({ roles: ['CARRIER'] }) })).rejects.toThrow(/a customer, a brand, a supplier or a subcontractor/)
    await expect(project({ partyId: await party({ status: 'BLOCKED' }) })).rejects.toThrow(/cannot be shared with a company that is blocked/)
    await expect(project({ partyId: await party({ companyId: a.companies[1]!.id }) })).rejects.toThrow(/of its own company's, or of every company/)
    expect(await project({ partyId: await party({ companyId: A.companyA }) })).toBeTruthy()
    // A season of another company: the reference refuses it (company A has no season of that code).
    await expect(project({ seasonCode: 'SEED-NONE' })).rejects.toThrow(/foreign key/)
  })
})

describe('the links (PROJ-G03)', () => {
  it('of the kinds a project links, a record of the tenant and of its company, once', async () => {
    const id = await project({ partyId: A.P1 })
    await expect(link(id, 'WorkOrder', randomUUID())).rejects.toThrow(/a project links styles, sample rounds/)
    await expect(link(id, 'Style', randomUUID())).rejects.toThrow(/not a record of the tenant/)
    await expect(link(id, 'Style', A.style, { key: `link:${id}:Style:other` })).rejects.toThrow(/link:<projectId>:<recordType>:<recordId>/)
    await expect(link(id, 'Style', A.style, { note: 'Seed\nnote' })).rejects.toThrow(/one line of 1 to 500/)
    expect(await link(id, 'Style', A.style)).toBe(1)
    await expect(link(id, 'Style', A.style)).rejects.toThrow(/unique|duplicate/)
    // Its party is the project's, whatever the writer says.
    expect((await admin(`SELECT "partyId"::text AS party FROM "ProjectLink" WHERE "projectId" = $1::uuid`, [id]))[0]!.party).toBe(A.P1)
    // A company-A project never links company B's records: Brand Two's order is company A's, so a company-B project shows it.
    const ofB = randomUUID()
    expect(await insert(office(), 'Project', { id: ofB, companyId: a.companies[1]!.id, number: `SEED-TH65-B-${ofB.slice(0, 6)}`, name: 'Seed company B project', leadId: a.actorId, targetDate: '2027-02-01', partyId: second.partyId })).toBe(1)
    await expect(link(ofB, 'SalesOrder', second.salesOrderId)).rejects.toThrow(/records of its own company/)
  })

  it('are added and removed while the project is open, and never changed', async () => {
    const id = await project({ partyId: A.P1 })
    expect(await link(id, 'Style', A.style)).toBe(1)
    await expect(run(office(), `UPDATE "ProjectLink" SET note = 'Seed: changed.' WHERE "projectId" = $1::uuid`, id)).rejects.toThrow(/permission denied|never changed/)
    expect(await run(office(), `UPDATE "Project" SET status = 'CLOSED', outcome = 'DONE', "outcomeNote" = 'Seed: done.', "closedAt" = now() WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `DELETE FROM "ProjectLink" WHERE "projectId" = $1::uuid`, id)).rejects.toThrow(/links of a CLOSED project stay/)
    await expect(link(id, 'SalesOrder', randomUUID())).rejects.toThrow(/CLOSED project links no new record/)
    expect(await run(office(), `UPDATE "Project" SET status = 'ACTIVE', outcome = NULL, "outcomeNote" = NULL, "closedAt" = NULL WHERE id = $1::uuid`, id)).toBe(1)
    expect(await run(office(), `DELETE FROM "ProjectLink" WHERE "projectId" = $1::uuid`, id)).toBe(1)
  })
})

describe('FollowReason ADDED (PROJ-G04)', () => {
  it('names who added the person, someone else', async () => {
    const id = await project()
    await expect(follow(id, A.member, { createdById: null })).rejects.toThrow(/ADDED by someone else, who is named/)
    await expect(follow(id, A.member, { createdById: A.member })).rejects.toThrow(/ADDED by someone else, who is named/)
    expect(await follow(id, A.member)).toBe(1)
    // CHOSE stays what it was: one's own choice (an office person with no party).
    expect(await follow(id, a.actorId, { reason: 'CHOSE', createdById: a.actorId })).toBe(1)
  })
})
