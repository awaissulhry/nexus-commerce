import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedPeople, type PeopleSeed } from '../seed/people'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedOrderStructures, type OrderStructuresFixture } from './testing/order-structures'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * owb-ssw (order workflow build, S3 schema wave "structures + units"; _owb-ss-common L9, L10; build/briefs/owb-ssw.md w.4): the
 * rules of …_order_structures_guards on a database built from the migrations and seeded, through the real login and the scoped
 * client. P1 (the seeds' customer), SEED-SO-0002 with its BLK and RED lines (seed/production.ts), A1's team L1-A of company A and
 * B1's L1-B of company B, the people E1 (company A) and EB1 (company B) (seed/people.ts), P1's portal buyer (a PARTNER user,
 * seed/portal-auth.ts), and the wave's own rows (testing/order-structures.ts: the design page of SEED-SO-0002, the structure "Seed
 * jackets", rule 1 for P1's jackets, SEED-SO-0002's structure by hand, its BLK line's kept structure, the scan code's place). Seed
 * Brand Two (testing/second-brand.ts: its order and its file) is the other customer.
 *   - Team as a unit (Team_unit_check): the owner's word 1 to 40 trimmed; what it does 1 to 500; the most baskets 1 or more; the
 *     stand-in's day only beside the stand-in, the stand-in a person of the same company; the customers it works for each once,
 *     customers of its company; never under itself, never in a cycle, under 50 deep; the unit above of the same company and open;
 *     a merged unit archived, merged into an open unit of the same company, never into itself.
 *   - OrderStructure: born open at version 1; a name of 1 to 80 trimmed; each team and person once; open teams of its company;
 *     active office people; closed with when and who; the company never changes; the version up by one; never deleted.
 *   - OrderStructureRule: two OPEN rules never fit exactly the same orders (the same customer or any, the same kind or any; a
 *     closed one does not count); a customer of its company; an open rule gives an open structure (made, reopened or moved to
 *     another), a structure closed later only flags it; its place 1 or more; never deleted.
 *   - OrderStructureOverride: one open row per order; born open with an open structure; normalWay exactly without a structure;
 *     why 3 to 500 trimmed; only ended (when and who), then frozen; never deleted.
 *   - OrderLineStructureKept: append-only (UPDATE, DELETE, TRUNCATE refused for every login); a line of its own order, once; RULE
 *     names the rule and the structure it gives, ORDER no rule, NORMAL neither; the snapshot one object.
 *   - ScanCodePlacement: a line of its own order; once per line, file and page; page 1 or more, x and y 0 or more, 20 mm or
 *     more; an image or a PDF (never a design source, body data or a priced file); never another customer's file, never a file
 *     of another tenant; moved only on its own page; no TRUNCATE.
 *   - The walls: the floor and the partner role read and write none of the new tables.
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation or a foreign_key_violation, a grant "permission
 * denied"); their messages are read through raw SQL. Rows only time reaches (another order of P1, a customer of another company)
 * are planted by the owner with triggers off; append-only is shown on the owner's own write. Every name is made up. Not run in
 * the build (Owner rule: checks at the end).
 */

const NS = 'owb-ssw-order-structures'
const DENIED = /permission denied/
const UNIQUE = /Unique constraint|duplicate key|unique/i
const FOREIGN = /_fkey|foreign key/i
// Team as a unit
const UNIT_WORD = /the word for unit .* is 1 to 40 characters, with no space at either end/
const UNIT_ABOUT = /what unit .* does is said in 1 to 500 characters/
const UNIT_BASKETS = /takes at least 1 basket at once, or has no limit/
const UNIT_STAND_IN = /names who stands in for its leader before the day they stand in until/
const UNIT_PARTIES_ONCE = /names each customer it works for once/
const UNIT_PARTIES = /the customers unit .* works for are customers of its own company/
const UNIT_SELF = /never sits under itself nor is merged into itself/
const UNIT_MERGED_CLOSED = /was merged into another unit; a merged unit is closed \(archived\)/
const UNIT_MERGED_OPEN = /is merged into an open unit; that one is closed/
const UNIT_PARENT_OPEN = /sits under an open unit; that one is closed/
const UNIT_CYCLE = /cannot sit under a unit that sits under it; move that unit first/
const UNIT_DEEP = /would sit 50 or more units deep/
// OrderStructure
const STRUCTURE_NEW = /a new order structure is open, at version 1/
const STRUCTURE_NAME = /an order structure has a name of 1 to 80 characters, with no space at either end/
const STRUCTURE_ONCE = /names each team and each person once/
const STRUCTURE_TEAMS = /the teams of order structure .* are open teams of its own company/
const STRUCTURE_PEOPLE = /the people of order structure .* are active office people/
const STRUCTURE_CLOSED = /is closed with when and who, both or neither/
const STRUCTURE_FROZEN = /the company and the creation of order structure .* never change/
const STRUCTURE_VERSION = /the version of order structure .* goes up by one/
const STRUCTURE_KEPT = /an order structure is closed, never deleted/
// OrderStructureRule
const RULE_NEW = /a new structure rule is open, at version 1/
const RULE_PLACE = /a structure rule has its place on the list, 1 or more/
const RULE_PARTY = /names a customer of its own company/
const RULE_STRUCTURE_OPEN = /gives a closed structure; an open rule gives an open structure/
const RULE_KEPT = /a structure rule is closed, never deleted/
// OrderStructureOverride
const OVERRIDE_NEW = /a new structure by hand is open \(not ended\)/
const OVERRIDE_OPEN_STRUCTURE = /an order takes an open structure by hand; this structure is closed/
const OVERRIDE_WAY = /names a structure or is the normal way, exactly one of the two/
const OVERRIDE_WHY = /why the order takes a structure by hand is said in 3 to 500 characters/
const OVERRIDE_ONLY_END = /a structure by hand is only ended \(when and who\); nothing else of it changes/
const OVERRIDE_END = /a structure by hand is ended with when and who, both or neither/
const OVERRIDE_ENDED = /this structure by hand was ended; it never changes again/
const OVERRIDE_KEPT = /an order's structure by hand is ended, never deleted/
// OrderLineStructureKept
const APPEND_ONLY = (op: string, table: string): RegExp => new RegExp(`append-only: ${op} on "${table}" is refused`)
const KEPT_LINE = /a line keeps its structure on its own order/
const KEPT_FROM = /a structure kept from a RULE names the rule and its structure, one by hand on the ORDER names no rule, and the NORMAL way names neither/
const KEPT_RULE = /a structure kept from a rule is the structure that rule gives/
const KEPT_SNAPSHOT = /a kept structure keeps what it was as one object/
// ScanCodePlacement
const PLACE_LINE = /a scan code is placed for a line of its own order/
const PLACE_SIZE = /a scan code sits on page 1 or later, 0 mm or more from the top and left edges, and is at least 20 mm wide/
const PLACE_KIND = /a scan code is placed on an image or a PDF page the floor may see/
const PLACE_WALL = /a scan code is placed on a file of its own order's company and customer, or of the whole factory; never another customer's/
const PLACE_MOVES = /a scan code moves on its own page; its order, line, file and page never change/
const PLACE_VERSION = /the version of a scan code's place goes up by one/
const TRUNCATE_REFUSED = (table: string): RegExp => new RegExp(`TRUNCATE on "${table}" is refused`)

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let production: ProductionSeed
let people: PeopleSeed
let second: SecondBrand
let os: OrderStructuresFixture

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const companyA = key('company:A')
const companyB = key('company:B')
const siteA = key('site:A1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: production.operatorId, siteId: siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
/** The owner, with every trigger off for one statement (set-up only: rows only time reaches). */
async function replica(text: string, values: unknown[]): Promise<void> {
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
/** A copy of row `id` of `table` with `changes`, planted. */
const plant = (table: string, id: string, changes: Record<string, unknown>) =>
  replica(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

/** A new unit (team) of plant A1, company A, with `extra`; its id. */
async function newUnit(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Team', { id, companyId: companyA, siteId: siteA, code: tag('T-UNIT'), name: 'Made-up unit', createdById: a.actorId, ...extra })).toBe(1)
  return id
}
const archive = (teamId: string) => update(office(), 'Team', teamId, `status = 'ARCHIVED', version = version + 1`)
/** A new open structure of company A (team L1-A, the auth seed's office member); its id. */
async function newStructure(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'OrderStructure', { id, companyId: companyA, name: tag('Made-up structure'), teamIds: [os.teamId], peopleUserIds: [os.memberId], createdById: a.actorId, ...extra })).toBe(1)
  return id
}
const closeStructure = (structureId: string) => update(office(), 'OrderStructure', structureId, `"closedAt" = now(), "closedById" = $2::uuid, version = version + 1`, a.actorId)
const ruleRow = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: randomUUID(), companyId: companyA, sortOrder: 5, createdById: a.actorId, ...extra })
/** Another CONFIRMED order of P1 (a copy of SEED-SO-0002 under a new number) with a copy of its BLK line, planted. */
async function anotherOrderOfP1(): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID()
  const lineId = randomUUID()
  await plant('SalesOrder', os.orderId, { id: orderId, number: tag('T-SO'), customerSeq: null })
  await plant('SalesOrderLine', os.orderLineIds[0], { id: lineId, orderId })
  return { orderId, lineId }
}
const overrideRow = (salesOrderId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId,
  why: 'The customer asked for it (made up).',
  createdById: a.actorId,
  ...extra,
})
const keptRow = (salesOrderId: string, salesOrderLineId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId,
  salesOrderLineId,
  snapshot: { steps: [], teams: [], people: [] },
  keptById: a.actorId,
  ...extra,
})
const placeRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId: os.orderId,
  salesOrderLineId: os.orderLineIds[1],
  fileId: os.ids.file,
  page: 1,
  xMm: 10,
  yMm: 10,
  sizeMm: 20,
  placedById: a.actorId,
  ...extra,
})
/** A file planted as a copy of the fixture's design page (a PDF of SEED-SO-0002, office only, company A) with `changes`. */
async function plantFile(changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await plant('StoredFile', os.ids.file, { id, storageKey: `t/${a.tenantId}/c/${companyA}/2026/${randomUUID()}`, ...changes })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('orderstructures')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  people = await seedPeople({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
  os = await seedOrderStructures({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('Team as a unit (Team_unit_check)', () => {
  it("the owner's word, what it does, the most baskets: in their bounds", async () => {
    const unit = await newUnit({ kindWord: 'Line', about: 'Cuts and sews the made-up jackets.', maxBaskets: 1 })
    expect(await refusalOf(update(office(), 'Team', unit, `"kindWord" = ' Line', version = version + 1`))).toMatch(UNIT_WORD)
    expect(await refusalOf(update(office(), 'Team', unit, `"kindWord" = $2, version = version + 1`, 'x'.repeat(41)))).toMatch(UNIT_WORD)
    expect(await refusalOf(update(office(), 'Team', unit, `about = '   ', version = version + 1`))).toMatch(UNIT_ABOUT)
    expect(await refusalOf(update(office(), 'Team', unit, `about = $2, version = version + 1`, 'x'.repeat(501)))).toMatch(UNIT_ABOUT)
    expect(await refusalOf(update(office(), 'Team', unit, `"maxBaskets" = 0, version = version + 1`))).toMatch(UNIT_BASKETS)
    expect(await update(office(), 'Team', unit, `"kindWord" = 'Shift', "maxBaskets" = 12, about = NULL, version = version + 1`)).toBe(1)
    // A new team takes orders and new orders by the database's default; nothing else is set.
    expect(await admin(`SELECT "takesOrders" AS takes, "takesNewOrders" AS "takesNew", "worksForPartyIds"::text AS parties FROM "Team" WHERE id = $1::uuid`, [unit])).toEqual([{ takes: true, takesNew: true, parties: '{}' }])
  })

  it('the stand-in: a person of the same company; the day only beside the person', async () => {
    const unit = await newUnit()
    expect(await refusalOf(update(office(), 'Team', unit, `"standInUntil" = DATE '2026-12-31', version = version + 1`))).toMatch(UNIT_STAND_IN)
    expect(await refusalOf(update(office(), 'Team', unit, `"standInEmployeeId" = $2::uuid, version = version + 1`, people.employeeIds.eb1))).toMatch(FOREIGN)
    expect(await update(office(), 'Team', unit, `"standInEmployeeId" = $2::uuid, "standInUntil" = DATE '2026-12-31', version = version + 1`, people.employeeIds.e1)).toBe(1)
    expect(await refusalOf(update(office(), 'Team', unit, `"standInEmployeeId" = NULL, version = version + 1`))).toMatch(UNIT_STAND_IN)
    expect(await update(office(), 'Team', unit, `"standInEmployeeId" = NULL, "standInUntil" = NULL, version = version + 1`)).toBe(1)
  })

  it('the customers it works for: each once, customers of its own company (a wish, not a wall)', async () => {
    const unit = await newUnit()
    expect(await update(office(), 'Team', unit, `"worksForPartyIds" = ARRAY[$2::uuid], version = version + 1`, P1)).toBe(1)
    expect(await refusalOf(update(office(), 'Team', unit, `"worksForPartyIds" = ARRAY[$2::uuid, $2::uuid], version = version + 1`, P1))).toMatch(UNIT_PARTIES_ONCE)
    expect(await refusalOf(update(office(), 'Team', unit, `"worksForPartyIds" = NULL, version = version + 1`))).toMatch(UNIT_PARTIES_ONCE)
    expect(await refusalOf(update(office(), 'Team', unit, `"worksForPartyIds" = ARRAY[$2::uuid], version = version + 1`, randomUUID()))).toMatch(UNIT_PARTIES)
    // A customer of company B only.
    const partyOfB = randomUUID()
    await plant('Party', P1, { id: partyOfB, code: tag('T-PB'), companyId: companyB })
    const words = await refusalOf(update(office(), 'Team', unit, `"worksForPartyIds" = ARRAY[$2::uuid], version = version + 1`, partyOfB))
    expect(words).toMatch(UNIT_PARTIES)
    await expectNeutral(words)
  })

  it('the unit above: of the same company, open, never itself, never a unit under it', async () => {
    const top = await newUnit()
    const middle = await newUnit({ parentTeamId: top })
    const bottom = await newUnit({ parentTeamId: middle })
    expect(await refusalOf(update(office(), 'Team', top, `"parentTeamId" = $2::uuid, version = version + 1`, top))).toMatch(UNIT_SELF)
    expect(await refusalOf(update(office(), 'Team', top, `"parentTeamId" = $2::uuid, version = version + 1`, bottom))).toMatch(UNIT_CYCLE)
    // B1's team is of company B: the same-company foreign key refuses it.
    expect(await refusalOf(update(office(), 'Team', bottom, `"parentTeamId" = $2::uuid, version = version + 1`, people.teamIds.b))).toMatch(FOREIGN)
    const closed = await newUnit()
    expect(await archive(closed)).toBe(1)
    expect(await refusalOf(update(office(), 'Team', bottom, `"parentTeamId" = $2::uuid, version = version + 1`, closed))).toMatch(UNIT_PARENT_OPEN)
    expect(await refusalOf(newUnit({ parentTeamId: closed }))).toMatch(UNIT_PARENT_OPEN)
    // Moved to the top, then under the middle again.
    expect(await update(office(), 'Team', bottom, `"parentTeamId" = NULL, version = version + 1`)).toBe(1)
    expect(await update(office(), 'Team', bottom, `"parentTeamId" = $2::uuid, version = version + 1`, middle)).toBe(1)
  })

  it('a unit has at most 49 units above it: the 50th level is refused', async () => {
    let parent: string | null = null
    for (let level = 1; level <= 50; level++) parent = await newUnit(parent === null ? {} : { parentTeamId: parent })
    expect(await refusalOf(newUnit({ parentTeamId: parent }))).toMatch(UNIT_DEEP)
  })

  it('merged: into an open unit of the same company, never itself; a merged unit is archived', async () => {
    const keep = await newUnit()
    const gone = await newUnit()
    expect(await refusalOf(update(office(), 'Team', gone, `"mergedIntoId" = $2::uuid, version = version + 1`, keep))).toMatch(UNIT_MERGED_CLOSED)
    expect(await refusalOf(update(office(), 'Team', gone, `status = 'ARCHIVED', "mergedIntoId" = $2::uuid, version = version + 1`, gone))).toMatch(UNIT_SELF)
    expect(await refusalOf(update(office(), 'Team', gone, `status = 'ARCHIVED', "mergedIntoId" = $2::uuid, version = version + 1`, people.teamIds.b))).toMatch(FOREIGN)
    const closed = await newUnit()
    expect(await archive(closed)).toBe(1)
    expect(await refusalOf(update(office(), 'Team', gone, `status = 'ARCHIVED', "mergedIntoId" = $2::uuid, version = version + 1`, closed))).toMatch(UNIT_MERGED_OPEN)
    expect(await update(office(), 'Team', gone, `status = 'ARCHIVED', "mergedIntoId" = $2::uuid, version = version + 1`, keep)).toBe(1)
    // Opened again while still merged: refused; opened again with the merge cleared: fine.
    expect(await refusalOf(update(office(), 'Team', gone, `status = 'ACTIVE', version = version + 1`))).toMatch(UNIT_MERGED_CLOSED)
    expect(await update(office(), 'Team', gone, `status = 'ACTIVE', "mergedIntoId" = NULL, version = version + 1`)).toBe(1)
  })

  it('the floor reads its site\'s teams with their unit columns, and writes none', async () => {
    const rows = await as(floor(), (client) => client.$queryRawUnsafe<{ kind: string | null }[]>(`SELECT "kindWord" AS kind FROM "Team" WHERE id = $1::uuid`, os.teamId))
    expect(rows).toHaveLength(1)
    expect(await refusalOf(update(floor(), 'Team', os.teamId, `"kindWord" = 'Line'`))).toMatch(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('OrderStructure (factory_order_structure_guard)', () => {
  it('born open at version 1, with a name of 1 to 80 trimmed characters', async () => {
    await newStructure()
    expect(await refusalOf(newStructure({ closedAt: new Date().toISOString(), closedById: a.actorId }))).toMatch(STRUCTURE_NEW)
    expect(await refusalOf(newStructure({ version: 2 }))).toMatch(STRUCTURE_NEW)
    expect(await refusalOf(newStructure({ name: ' Jackets' }))).toMatch(STRUCTURE_NAME)
    expect(await refusalOf(newStructure({ name: 'x'.repeat(81) }))).toMatch(STRUCTURE_NAME)
    expect(await refusalOf(newStructure({ name: '' }))).toMatch(STRUCTURE_NAME)
  })

  it('each team and person once; open teams of its own company; active office people', async () => {
    expect(await refusalOf(newStructure({ teamIds: [os.teamId, os.teamId] }))).toMatch(STRUCTURE_ONCE)
    expect(await refusalOf(newStructure({ peopleUserIds: [os.memberId, os.memberId] }))).toMatch(STRUCTURE_ONCE)
    expect(await refusalOf(newStructure({ teamIds: [people.teamIds.b] }))).toMatch(STRUCTURE_TEAMS)
    expect(await refusalOf(newStructure({ teamIds: [randomUUID()] }))).toMatch(STRUCTURE_TEAMS)
    const closedTeam = await newUnit()
    expect(await archive(closedTeam)).toBe(1)
    expect(await refusalOf(newStructure({ teamIds: [closedTeam] }))).toMatch(STRUCTURE_TEAMS)
    // A portal person (PARTNER) is never one of the office people.
    expect(await refusalOf(newStructure({ peopleUserIds: [portal.userIds.p1Buyer] }))).toMatch(STRUCTURE_PEOPLE)
    // A team named while open stays named after it closed (a rename passes); naming it again anew is refused.
    const team = await newUnit()
    const structure = await newStructure({ teamIds: [team] })
    expect(await archive(team)).toBe(1)
    expect(await update(office(), 'OrderStructure', structure, `name = $2, version = version + 1`, tag('Renamed structure'))).toBe(1)
    const fresh = await newStructure({ teamIds: [] })
    expect(await refusalOf(update(office(), 'OrderStructure', fresh, `"teamIds" = ARRAY[$2::uuid], version = version + 1`, team))).toMatch(STRUCTURE_TEAMS)
  })

  it('closed with when and who, both or neither, and reopened; its company and creation never change; never deleted', async () => {
    const structure = await newStructure()
    expect(await refusalOf(update(office(), 'OrderStructure', structure, `"closedAt" = now(), version = version + 1`))).toMatch(STRUCTURE_CLOSED)
    expect(await closeStructure(structure)).toBe(1)
    expect(await update(office(), 'OrderStructure', structure, `"closedAt" = NULL, "closedById" = NULL, version = version + 1`)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderStructure', structure, `"companyId" = $2::uuid, version = version + 1`, companyB))).toMatch(new RegExp(`${STRUCTURE_FROZEN.source}|${FOREIGN.source}`))
    expect(await refusalOf(update(office(), 'OrderStructure', structure, `note = 'More', version = version + 2`))).toMatch(STRUCTURE_VERSION)
    expect(await refusalOf(remove(office(), 'OrderStructure', structure))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "OrderStructure" WHERE id = $1::uuid`, [structure])).rejects.toThrow(STRUCTURE_KEPT)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('OrderStructureRule (factory_order_structure_rule_guard; OrderStructureRule_open_same_orders)', () => {
  it('two OPEN rules never fit exactly the same orders; a closed one does not count', async () => {
    const structure = await newStructure()
    // The fixture's rule 1 gives P1's jackets. (A duplicate is a unique_violation of OrderStructureRule_open_same_orders or
    // …_any_kind: the API says it in words first.)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: 'JACKET', structureId: structure })))).toMatch(UNIQUE)
    // Any customer's gloves, twice.
    expect(await insert(office(), 'OrderStructureRule', ruleRow({ partyId: null, category: 'GLOVES', structureId: structure }))).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: null, category: 'GLOVES', structureId: structure })))).toMatch(UNIQUE)
    // P1, any kind, twice (the second index: no kind named).
    const anyKind = ruleRow({ partyId: P1, category: null, structureId: structure })
    expect(await insert(office(), 'OrderStructureRule', anyKind)).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: null, structureId: structure })))).toMatch(UNIQUE)
    // Closed, it no longer counts: the same orders may get a new open rule; reopening the closed one is then refused.
    expect(await update(office(), 'OrderStructureRule', anyKind.id as string, `"closedAt" = now(), "closedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: null, structureId: structure }))).toBe(1)
    expect(await refusalOf(update(office(), 'OrderStructureRule', anyKind.id as string, `"closedAt" = NULL, "closedById" = NULL, version = version + 1`))).toMatch(UNIQUE)
  })

  it('a customer of its own company; its place 1 or more; born open at version 1', async () => {
    const structure = await newStructure()
    const partyOfB = randomUUID()
    await plant('Party', P1, { id: partyOfB, code: tag('T-PB'), companyId: companyB })
    const words = await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: partyOfB, category: 'VEST', structureId: structure })))
    expect(words).toMatch(RULE_PARTY)
    await expectNeutral(words)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: randomUUID(), category: 'VEST', structureId: structure })))).toMatch(FOREIGN)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: 'VEST', structureId: structure, sortOrder: 0 })))).toMatch(RULE_PLACE)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: 'VEST', structureId: structure, version: 2 })))).toMatch(RULE_NEW)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: 'VEST', structureId: randomUUID() })))).toMatch(FOREIGN)
  })

  it('an open rule gives an open structure when made, reopened or moved; a structure closed later only flags it', async () => {
    const open = await newStructure()
    const closed = await newStructure()
    expect(await closeStructure(closed)).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderStructureRule', ruleRow({ partyId: P1, category: 'TROUSERS', structureId: closed })))).toMatch(RULE_STRUCTURE_OPEN)
    const rule = ruleRow({ partyId: P1, category: 'TROUSERS', structureId: open })
    expect(await insert(office(), 'OrderStructureRule', rule)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderStructureRule', rule.id as string, `"structureId" = $2::uuid, version = version + 1`, closed))).toMatch(RULE_STRUCTURE_OPEN)
    // Its structure closes later: the rule stays (the API flags it), and its note still changes.
    expect(await closeStructure(open)).toBe(1)
    expect(await update(office(), 'OrderStructureRule', rule.id as string, `note = 'Flagged on the list', version = version + 1`)).toBe(1)
    // Closed, then reopened while its structure is closed: refused.
    expect(await update(office(), 'OrderStructureRule', rule.id as string, `"closedAt" = now(), "closedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderStructureRule', rule.id as string, `"closedAt" = NULL, "closedById" = NULL, version = version + 1`))).toMatch(RULE_STRUCTURE_OPEN)
  })

  it('never deleted; the order of the list is kept by its places', async () => {
    expect(await refusalOf(remove(office(), 'OrderStructureRule', os.ids.rule))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "OrderStructureRule" WHERE id = $1::uuid`, [os.ids.rule])).rejects.toThrow(RULE_KEPT)
    const structure = await newStructure()
    const next = ruleRow({ partyId: null, category: 'SUIT', structureId: structure, sortOrder: 2 })
    expect(await insert(office(), 'OrderStructureRule', next)).toBe(1)
    expect(await update(office(), 'OrderStructureRule', next.id as string, `"sortOrder" = 1, version = version + 1`)).toBe(1)
    expect(await update(office(), 'OrderStructureRule', os.ids.rule, `"sortOrder" = 2, version = version + 1`)).toBe(1)
    const list = await admin(`SELECT id::text AS id FROM "OrderStructureRule" WHERE id IN ($1::uuid, $2::uuid) ORDER BY "sortOrder"`, [os.ids.rule, next.id])
    expect(list.map((row) => row.id)).toEqual([next.id, os.ids.rule])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('OrderStructureOverride (factory_order_structure_override_guard; OrderStructureOverride_one_open)', () => {
  it('one open row per order; born open with an open structure; normalWay exactly without a structure; why 3 to 500', async () => {
    // The fixture's SEED-SO-0002 has its open structure by hand (OrderStructureOverride_one_open).
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(os.orderId, { structureId: os.ids.structure })))).toMatch(UNIQUE)
    const { orderId } = await anotherOrderOfP1()
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: os.ids.structure, endedAt: new Date().toISOString(), endedById: a.actorId })))).toMatch(OVERRIDE_NEW)
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: null, normalWay: false })))).toMatch(OVERRIDE_WAY)
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: os.ids.structure, normalWay: true })))).toMatch(OVERRIDE_WAY)
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: os.ids.structure, why: 'no' })))).toMatch(OVERRIDE_WHY)
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: os.ids.structure, why: 'x'.repeat(501) })))).toMatch(OVERRIDE_WHY)
    const closed = await newStructure()
    expect(await closeStructure(closed)).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: closed })))).toMatch(OVERRIDE_OPEN_STRUCTURE)
    // The normal way by hand.
    expect(await insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: null, normalWay: true }))).toBe(1)
  })

  it('only ended (when and who, both, once); an ended row never changes; never deleted; then a new one may open', async () => {
    const { orderId } = await anotherOrderOfP1()
    const row = overrideRow(orderId, { structureId: os.ids.structure })
    expect(await insert(office(), 'OrderStructureOverride', row)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderStructureOverride', row.id as string, `why = 'Another reason (made up)'`))).toMatch(OVERRIDE_ONLY_END)
    expect(await refusalOf(update(office(), 'OrderStructureOverride', row.id as string, `"endedAt" = now()`))).toMatch(OVERRIDE_END)
    expect(await update(office(), 'OrderStructureOverride', row.id as string, `"endedAt" = now(), "endedById" = $2::uuid`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderStructureOverride', row.id as string, `"endedAt" = now() + interval '1 hour'`))).toMatch(OVERRIDE_ENDED)
    expect(await refusalOf(remove(office(), 'OrderStructureOverride', row.id as string))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "OrderStructureOverride" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(OVERRIDE_KEPT)
    expect(await insert(office(), 'OrderStructureOverride', overrideRow(orderId, { structureId: null, normalWay: true }))).toBe(1)
    await expect(admin(`TRUNCATE "OrderStructureOverride"`)).rejects.toThrow(TRUNCATE_REFUSED('OrderStructureOverride'))
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('OrderLineStructureKept: append-only, and what an insert says', () => {
  it('nobody changes or removes a kept line, the owner included; the office has no grant to', async () => {
    expect(await refusalOf(update(office(), 'OrderLineStructureKept', os.ids.kept, `"keptFrom" = 'NORMAL'`))).toMatch(DENIED)
    expect(await refusalOf(remove(office(), 'OrderLineStructureKept', os.ids.kept))).toMatch(DENIED)
    await expect(admin(`UPDATE "OrderLineStructureKept" SET "keptById" = NULL WHERE id = $1::uuid`, [os.ids.kept])).rejects.toThrow(APPEND_ONLY('UPDATE', 'OrderLineStructureKept'))
    await expect(admin(`DELETE FROM "OrderLineStructureKept" WHERE id = $1::uuid`, [os.ids.kept])).rejects.toThrow(APPEND_ONLY('DELETE', 'OrderLineStructureKept'))
    await expect(admin(`TRUNCATE "OrderLineStructureKept"`)).rejects.toThrow(APPEND_ONLY('TRUNCATE', 'OrderLineStructureKept'))
  })

  it('a line of its own order, once', async () => {
    // The fixture's BLK line kept its structure: once.
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(os.orderId, os.orderLineIds[0], { keptFrom: 'NORMAL' })))).toMatch(UNIQUE)
    const other = await anotherOrderOfP1()
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(os.orderId, other.lineId, { keptFrom: 'NORMAL' })))).toMatch(KEPT_LINE)
    expect(await insert(office(), 'OrderLineStructureKept', keptRow(other.orderId, other.lineId, { keptFrom: 'NORMAL' }))).toBe(1)
  })

  it('RULE names the rule and the structure it gives; ORDER no rule; NORMAL neither; the snapshot one object', async () => {
    const rule = await admin(`SELECT "structureId"::text AS structure FROM "OrderStructureRule" WHERE id = $1::uuid`, [os.ids.rule])
    const ruleStructure = rule[0]!.structure as string
    let line = await anotherOrderOfP1()
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'RULE', structureId: ruleStructure })))).toMatch(KEPT_FROM)
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'ORDER', structureId: ruleStructure, ruleId: os.ids.rule })))).toMatch(KEPT_FROM)
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'NORMAL', structureId: ruleStructure })))).toMatch(KEPT_FROM)
    const another = await newStructure()
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'RULE', structureId: another, ruleId: os.ids.rule })))).toMatch(KEPT_RULE)
    expect(await refusalOf(insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'NORMAL', snapshot: [1, 2] })))).toMatch(KEPT_SNAPSHOT)
    expect(await insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'RULE', structureId: ruleStructure, ruleId: os.ids.rule }))).toBe(1)
    line = await anotherOrderOfP1()
    expect(await insert(office(), 'OrderLineStructureKept', keptRow(line.orderId, line.lineId, { keptFrom: 'ORDER', structureId: null }))).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('ScanCodePlacement (factory_scan_code_placement_guard)', () => {
  it('a line of its own order; once per line, file and page; page, place and a side of 20 mm or more', async () => {
    const other = await anotherOrderOfP1()
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ salesOrderLineId: other.lineId })))).toMatch(PLACE_LINE)
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ sizeMm: 19.99 })))).toMatch(PLACE_SIZE)
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ page: 0 })))).toMatch(PLACE_SIZE)
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ xMm: -1 })))).toMatch(PLACE_SIZE)
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ yMm: -0.5 })))).toMatch(PLACE_SIZE)
    expect(await insert(office(), 'ScanCodePlacement', placeRow({ page: 2 }))).toBe(1)
    // The fixture's place: BLK line, the design page, page 1.
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ salesOrderLineId: os.orderLineIds[0] })))).toMatch(UNIQUE)
  })

  it('an image or a PDF the floor may see: never a design source, body data or a priced file, nor one deleted', async () => {
    const png = await plantFile({ kind: 'PHOTO', contentType: 'image/png' })
    expect(await insert(office(), 'ScanCodePlacement', placeRow({ fileId: png, page: 1 }))).toBe(1)
    const eps = await plantFile({ kind: 'ATTACHMENT', contentType: 'application/postscript' })
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: eps })))).toMatch(PLACE_KIND)
    const priced = await plantFile({ priced: true })
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: priced })))).toMatch(PLACE_KIND)
    const body = await plantFile({ kind: 'PHOTO', contentType: 'image/jpeg', category: 'BODY_PHOTO' })
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: body })))).toMatch(PLACE_KIND)
    const deleted = await plantFile({ status: 'DELETED', deletedAt: new Date().toISOString() })
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: deleted })))).toMatch(PLACE_KIND)
  })

  it("never another customer's file (the brand wall), never a file of another tenant", async () => {
    // Seed Brand Two's file of its own order.
    const words = await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: second.fileId })))
    expect(words).toMatch(PLACE_WALL)
    await expectNeutral(words)
    // A file of P1's order filed under Seed Brand Two's order (its record's customer is the other one).
    const filedElsewhere = await plantFile({ recordType: 'SalesOrder', recordId: second.salesOrderId })
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: filedElsewhere })))).toMatch(PLACE_WALL)
    // No such file in this tenant: the tenant-safe foreign key.
    expect(await refusalOf(insert(office(), 'ScanCodePlacement', placeRow({ fileId: randomUUID() })))).toMatch(FOREIGN)
  })

  it('moved only on its own page, the version up by one; no TRUNCATE', async () => {
    expect(await update(office(), 'ScanCodePlacement', os.ids.placement, `"xMm" = 30, "yMm" = 40, "sizeMm" = 22, version = version + 1`)).toBe(1)
    expect(await refusalOf(update(office(), 'ScanCodePlacement', os.ids.placement, `page = 3, version = version + 1`))).toMatch(PLACE_MOVES)
    expect(await refusalOf(update(office(), 'ScanCodePlacement', os.ids.placement, `"salesOrderLineId" = $2::uuid, version = version + 1`, os.orderLineIds[1]))).toMatch(PLACE_MOVES)
    expect(await refusalOf(update(office(), 'ScanCodePlacement', os.ids.placement, `"xMm" = 31, version = version + 2`))).toMatch(PLACE_VERSION)
    expect(await refusalOf(update(office(), 'ScanCodePlacement', os.ids.placement, `"sizeMm" = 10, version = version + 1`))).toMatch(PLACE_SIZE)
    expect(await refusalOf(remove(office(), 'ScanCodePlacement', os.ids.placement))).toMatch(DENIED)
    await expect(admin(`TRUNCATE "ScanCodePlacement"`)).rejects.toThrow(TRUNCATE_REFUSED('ScanCodePlacement'))
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the walls: the floor and the customer read and write none of the new tables', () => {
  const TABLES = ['OrderStructure', 'OrderStructureRule', 'OrderStructureOverride', 'OrderLineStructureKept', 'ScanCodePlacement'] as const

  it.each(TABLES)('%s: the floor and the partner role have no grant', async (table) => {
    for (const scope of [floor(), p1()]) {
      expect(await refusalOf(as(scope, (client) => client.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)))).toMatch(DENIED)
      expect(await refusalOf(run(scope, `UPDATE "${table}" SET id = id WHERE false`))).toMatch(DENIED)
    }
  })
})
