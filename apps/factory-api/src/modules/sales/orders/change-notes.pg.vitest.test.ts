import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { FLOOR_NOTE_MAX, noPriceIn } from '@nexus/factory-domain/sales/orders/change-notes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProductionSupervisor } from '../../../../../../packages/factory-db/seed/production-supervisor'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { PARTNER_RULES } from '../../../platform/portal/notifications/rules'
import { acceptRequest, refuseRequest } from '../change-requests/office'
import { orderChangeNotes } from './change-notes'

/**
 * B-SA-052 / B-SA-053 / B-SA-054 — tell everyone on the order (sales page plan P8', R2, R7, R8, R9; 13-backend B7; 14-change-flow §4.1,
 * §5; review C-6, C-7, WP-1, WP-2), the worker handler `sales.orderChangeNotes`, on the local stack: the factory-db seeds up to
 * shipping and subcontracting (SEED-SO-0002's line made by work order WO-0001 at plant A1; SEED-SC-0001 a job of WO-0001 at the
 * workshop P2), P1's production supervisor and backup (production managers limited to P1) and the second brand's planner (limited
 * to Brand Beta, the seeds' second brand). Per test an order of Brand Alpha (P1) in production, one line of 4 pieces of size 52 made
 * by an IN_PROGRESS work order, with an OPEN change request to lower it — planted whole as an import would. The handler is run as
 * the worker does: every event of one command, in any order, and again (a replay):
 *
 *   ONE LINE    one change = ONE system line on the order's thread (office only, the company's language, no price), whichever
 *               event runs first; a replay writes nothing; an unchanged order gets none
 *   THE FLOOR   ONE floor note per open work order whose work changes (for the floor, the customer's CODE, never its name, no
 *               person, no price, ≤ 1000 characters) + production.floor_note_posted; a refusal and a withdrawal tell the floor nothing
 *   THE WALL    a mixed work order is "a work order" in the line and its floor note names no customer; a person limited to Brand
 *               Beta who follows Alpha's order is never counted told; a withdrawal leaves out who B-PR-32 told
 *   WORKSHOPS   the partner rule tells the workshop of an OPEN subcontract order of a changed work order, by its own number only;
 *               a work order with no open subcontract order tells no workshop
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/change-notes`.
 */

let h: Harness
const NS = 'sa052-change-notes'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
let officeId: string
let people: { supervisor: string; backup: string; betaPlanner: string }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const caller = (permissions: Permission[], requestId = newId()) => callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId, grants: [{ permissions, companies: 'all', sites: 'all', parties: 'all' }] })
const SALES: Permission[] = ['orders.view', 'orders.manage']

/** Rows written whole, the database's rules off for them (as an import would). */
async function planted(rows: readonly { sql: string; values: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await h.db.admin.query(row.sql, row.values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const copy = (table: string, from: string, over: Json) => ({ sql: `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, values: [JSON.stringify(over), from] })

let made = 0
/** An order in production of one line, 4 of size 52, made by an IN_PROGRESS work order (`mixed`: one of before the one-customer rule). */
async function inWork(asked: number, options: { readonly mixed?: boolean } = {}) {
  const so2 = await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SO-0002'])
  const [line] = await admin<{ id: string; colourwayId: string }>('SELECT id::text AS id, "colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [so2.id])
  const [cell] = await admin<{ id: string; workOrderId: string }>('SELECT id::text AS id, "workOrderId"::text AS "workOrderId" FROM "WorkOrderSize" WHERE "salesOrderLineId" = $1 LIMIT 1', [line!.id])
  const ids = { order: newId(), line: newId(), workOrder: newId(), cell: newId(), request: newId() }
  const tag = `T-SA052-${++made}-${ids.order.slice(-4)}`
  await planted([
    copy('SalesOrder', so2.id, { id: ids.order, number: tag, status: 'IN_PRODUCTION', version: 1, reapprovalNeededAt: null }),
    copy('SalesOrderLine', line!.id, { id: ids.line, orderId: ids.order, seq: 10, quantity: 4, closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, version: 1 }),
    { sql: `INSERT INTO "SalesOrderLineSize" (id, "tenantId", "lineId", "partyId", size, quantity) VALUES ($1, $2, $3, $4, '52', 4)`, values: [newId(), T, ids.line, P1] },
    copy('WorkOrder', cell!.workOrderId, { id: ids.workOrder, number: `${tag}-WO`, batchNumber: `${tag}-BT`, status: 'IN_PROGRESS', version: 1, ...(options.mixed ? { partyId: null } : {}) }),
    copy('WorkOrderSize', cell!.id, { id: ids.cell, workOrderId: ids.workOrder, salesOrderLineId: ids.line, colourwayId: line!.colourwayId, size: '52', quantity: 4, version: 1 }),
    { sql: `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, version) VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'OPEN', 1)`, values: [ids.request, T, companyA, P1, ids.order] },
    { sql: `INSERT INTO "OrderChangeRequestLine" (id, "tenantId", "partyId", "requestId", "orderLineId", size, "quantityBefore", quantity) VALUES ($1, $2, $3, $4, $5, '52', 4, $6)`, values: [newId(), T, P1, ids.request, ids.line, asked] },
  ])
  return { ...ids, number: `${tag}-WO`, tag }
}

const follow = (userId: string, recordType: string, recordId: string) => admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, muted) VALUES ($1, $2, $3, $4, $5, 'CHOSE', false)`, [newId(), T, recordType, recordId, userId])

/** Every event one command wrote (its correlation), as the relay hands them on. */
async function eventsOf(correlationId: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND "correlationId" = $2 ORDER BY "occurredAt", id`, [T, correlationId])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }) as EventEnvelope)
}
/** The worker's handler on every event of the command, last first (whichever runs first, one line). */
async function tellEveryone(correlationId: string, events?: readonly EventEnvelope[]): Promise<void> {
  for (const event of [...(events ?? (await eventsOf(correlationId)))].reverse()) await orderChangeNotes(callerFor(h.database, systemContext(T, correlationId)), event)
}
const notesOn = (recordType: string, recordId: string) =>
  admin<{ id: string; bodyText: string; forFloor: boolean; authorKind: string; authorName: string | null; audience: string }>(
    `SELECT m.id::text AS id, m."bodyText", m."forFloor", m."authorKind"::text AS "authorKind", m."authorName", m.audience::text AS audience FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."tenantId" = $1 AND t."recordType" = $2 AND t."recordId" = $3 AND m."authorKind" = 'SYSTEM' ORDER BY m.at, m.id`,
    [T, recordType, recordId],
  )
const posted = async (correlationId: string, messageId: string) => (await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND "correlationId" = $2 AND type = 'thread.message_posted' AND payload->>'messageId' = $3`, [T, correlationId, messageId]))[0]?.payload as Json | undefined
const customer = async () => one<{ code: string; legalName: string; tradeName: string | null }>('SELECT code, "legalName", "tradeName" FROM "Party" WHERE id = $1', [P1])

beforeAll(async () => {
  h = await startHarness('sa052_change_notes')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedSubcontract({ db: h.database, namespace: NS })
  const supervisors = await seedProductionSupervisor({ db: h.database, namespace: NS })
  people = { supervisor: supervisors.userIds.supervisor, backup: supervisors.userIds.backup, betaPlanner: supervisors.userIds.secondBrandPlanner }
  const actorId = newId()
  officeId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    await client.user.create({ data: { id: officeId, email: 'otto.office@sa052.example', displayName: 'Otto Office', status: 'ACTIVE' }, select: { id: true } })
  })
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('B-SA-052: ONE system line per change, whichever event runs first; a replay writes nothing', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an accepted change: the line in the company language, what was asked, done, next and who was told; no price; the bell names the actor and the steps', async () => {
    const world = await inWork(3)
    await follow(people.supervisor, 'SalesOrder', world.order)
    await follow(people.betaPlanner, 'SalesOrder', world.order) // limited to Brand Beta: never told of Alpha's order
    await follow(people.backup, 'WorkOrder', world.workOrder)
    const correlation = newId()
    await acceptRequest(caller(SALES, correlation), world.request, { version: 1 }, undefined, h.clock)
    const events = await eventsOf(correlation)
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['order_change_request.answered', 'sales_order.amended']))
    await tellEveryone(correlation, events)
    const lines = await notesOn('SalesOrder', world.order)
    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line).toMatchObject({ forFloor: false, authorName: null, audience: 'OFFICE' })
    const text = line!.bodyText.split('\n')
    expect(text[0]).toMatch(/^Modifica accettata · Otto Office · \d\d:\d\d$/)
    expect(text[1]).toContain('ha chiesto (portale, ')
    expect(text[1]).toContain('riga 10 · 52 4 → 3')
    expect(text).toContain('Fatto: ordine modificato (revisione 1).')
    expect(text.find((entry) => entry.startsWith('Prossimi: '))).toContain('(inviato alla pianificazione)')
    // Told: the supervisor (follows the order) and the backup (follows the work order); never the Beta planner, never the actor.
    expect(text.find((entry) => entry.startsWith('Avvisati: '))).toBe(`Avvisati: 2 persone in ufficio · il reparto di ${world.number}`)
    expect(noPriceIn(line!.bodyText)).toBe(true)
    const event = await posted(correlation, line!.id)
    expect(event).toMatchObject({ causedById: officeId, orderId: world.order, stillToDo: 1 })
    expect(event).not.toHaveProperty('alreadyTold')
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderChangeNotes' AND "recordId" = $2 AND after->>'written' = 'true'`, [T, world.order])
    expect(audit!.after).toMatchObject({ messageId: line!.id, people: 2, stillToDo: 1, floor: [{ workOrderId: world.workOrder }] })

    // A replay of every event of the change (and of the handler's own) writes nothing more.
    await tellEveryone(correlation)
    expect(await notesOn('SalesOrder', world.order)).toHaveLength(1)
    expect(await notesOn('WorkOrder', world.workOrder)).toHaveLength(1)
  })

  it('a refusal is one short line with its words; the floor is told nothing', async () => {
    const world = await inWork(3)
    const correlation = newId()
    await refuseRequest(caller(SALES, correlation), world.request, { version: 1, answer: 'We cannot change sizes after cutting.' }, undefined, h.clock)
    await tellEveryone(correlation)
    const [line, ...rest] = await notesOn('SalesOrder', world.order)
    expect(rest).toEqual([])
    expect(line!.bodyText.split('\n').slice(0, 2)).toEqual([expect.stringMatching(/^Rifiutata · Otto Office · \d\d:\d\d$/), '“We cannot change sizes after cutting.”'])
    expect(await notesOn('WorkOrder', world.workOrder)).toEqual([])
  })

  it("a withdrawal: \"Ritirata da <customer>\", nobody of the office acted, and the people B-PR-32 already told are left out of the bell", async () => {
    const world = await inWork(3)
    const at = new Date(h.clock.now().getTime() + 1_000)
    await planted([{ sql: `UPDATE "OrderChangeRequest" SET status = 'WITHDRAWN', "withdrawnAt" = $2, version = version + 1 WHERE id = $1`, values: [world.request, at] }])
    const correlation = newId()
    const withdrawn: EventEnvelope = { eventId: newId(), type: 'order_change_request.withdrawn', version: 1, context: 'sales-change-requests', tenantId: T, companyId: companyA, siteId: null, subject: world.request, correlationId: correlation, causationId: null, source: 'sales.changeRequests.withdraw', occurredAt: at.toISOString(), payload: { requestId: world.request, orderId: world.order, partyId: P1, kind: 'CHANGE' } } as EventEnvelope
    await tellEveryone(correlation, [withdrawn])
    const [line] = await notesOn('SalesOrder', world.order)
    const party = await customer()
    expect(line!.bodyText.split('\n')[0]).toMatch(new RegExp(`^Ritirata da ${party.tradeName ?? party.legalName} · \\d\\d:\\d\\d$`))
    const event = await posted(correlation, line!.id)
    expect(event).toMatchObject({ causedById: null, orderId: world.order })
    expect([...(event!.alreadyTold as string[])].sort()).toEqual([people.supervisor, people.backup].sort())
    expect(await notesOn('WorkOrder', world.workOrder)).toEqual([])
  })

  it('an event of an unchanged order writes no line (the audit row says so)', async () => {
    const world = await inWork(3)
    const correlation = newId()
    const amended: EventEnvelope = { eventId: newId(), type: 'sales_order.amended', version: 1, context: 'sales', tenantId: T, companyId: companyA, siteId: null, subject: world.order, correlationId: correlation, causationId: null, source: 'test', occurredAt: h.clock.now().toISOString(), payload: { orderId: world.order, number: world.tag, amendmentId: newId(), revision: 1, reacceptanceNeeded: false, lineIds: [], partyId: P1 } } as EventEnvelope
    await tellEveryone(correlation, [amended])
    expect(await notesOn('SalesOrder', world.order)).toEqual([])
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderChangeNotes' AND "recordId" = $2 AND after->>'written' = 'false'`, [T, world.order])).toHaveLength(1)
  })
})

describe('B-SA-053: the floor note on each open work order whose work changes', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('names the customer CODE (never its name), no person, no price, within what a tablet shows; tells the tablets of its site', async () => {
    const world = await inWork(3)
    const correlation = newId()
    await acceptRequest(caller(SALES, correlation), world.request, { version: 1 }, undefined, h.clock)
    await tellEveryone(correlation)
    const [note, ...rest] = await notesOn('WorkOrder', world.workOrder)
    expect(rest).toEqual([])
    const party = await customer()
    expect(note).toMatchObject({ forFloor: true, authorName: null })
    expect(note!.bodyText).toBe(`Modifica d'ordine su ${world.number} (${party.code}): taglia 52 ora 3 (erano 4). Aspetta i nuovi numeri dell'ordine di lavoro prima di tagliare 52.`)
    for (const word of [party.legalName, party.tradeName, 'Otto Office'].filter((entry): entry is string => !!entry)) expect(note!.bodyText).not.toContain(word)
    expect(noPriceIn(note!.bodyText)).toBe(true)
    expect(note!.bodyText.length).toBeLessThanOrEqual(FLOOR_NOTE_MAX)
    const floorEvents = await admin(`SELECT payload, "siteId"::text AS "siteId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND "correlationId" = $2 AND type = 'production.floor_note_posted'`, [T, correlation])
    expect(floorEvents).toHaveLength(1)
    expect(floorEvents[0]!.payload).toMatchObject({ workOrderId: world.workOrder, number: world.number, messageId: note!.id, salesOrderId: world.order, changes: ['SIZES'] })
    // Nothing records who or which station saw it (R2): no "seen" event of any kind.
    expect(await admin(`SELECT 1 FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE '%seen%'`, [T])).toEqual([])
  })

  it('a work order of several customers: "a work order" in the line, no customer at all in its floor note', async () => {
    const world = await inWork(3, { mixed: true })
    const correlation = newId()
    await acceptRequest(caller(SALES, correlation), world.request, { version: 1 }, undefined, h.clock)
    await tellEveryone(correlation)
    const party = await customer()
    const [line] = await notesOn('SalesOrder', world.order)
    expect(line!.bodyText).not.toContain(world.number)
    expect(line!.bodyText).toContain('un ordine di lavoro')
    const [note] = await notesOn('WorkOrder', world.workOrder)
    expect(note!.bodyText.startsWith(`Modifica d'ordine su ${world.number}: `)).toBe(true)
    for (const word of [party.code, party.legalName, party.tradeName].filter((entry): entry is string => !!entry)) expect(note!.bodyText).not.toContain(word)
  })
})

// ---- B-SA-053b (14-change-flow S7): production applied the work-order change — the floor note and the line's "Fatto" give the work
// order's NEW cells (Lower to the order keeps what is cut: 52 asked 4 → 1, 3 cut, the cell makes 3), never the ask's figure; the line
// (office only) names the extra pieces kept and their outcome; the floor never reads them.
describe('B-SA-053b: an applied work-order change names the work order\'s new cells, and its extra pieces in the office line only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('52 asked 4 → 1 with 3 cut: "cambiato: taglia 52 3." on the floor; "52 4 → 3 · 2 pezzi in più tenuti come rimanenza del cliente" in the line', async () => {
    const world = await inWork(1)
    const correlation = newId()
    await acceptRequest(caller(SALES, correlation), world.request, { version: 1 }, undefined, h.clock)
    await tellEveryone(correlation)
    const [change] = await admin<{ id: string; cells: Json[] }>(`SELECT id::text AS id, cells FROM "WorkOrderChange" WHERE "tenantId" = $1 AND "salesOrderId" = $2 AND status = 'PROPOSED'`, [T, world.order])
    expect(change!.cells).toEqual([expect.objectContaining({ size: '52', from: 4, to: 1, workOrderSizeId: world.cell })])
    // Production applies it as Lower to the order does when 3 are cut: the cell keeps 3 (planted as the command leaves it).
    const decidedAt = new Date(h.clock.now().getTime() + 60_000)
    await planted([
      { sql: `UPDATE "WorkOrderSize" SET quantity = 3, version = version + 1 WHERE id = $1`, values: [world.cell] },
      {
        sql: `UPDATE "WorkOrderChange" SET status = 'APPLIED', "decidedAt" = $2, "decidedById" = $3, extra = $4::jsonb, "extraOutcome" = 'LEFTOVER', version = version + 1 WHERE id = $1`,
        values: [change!.id, decidedAt, officeId, JSON.stringify([{ workOrderSizeId: world.cell, salesOrderLineId: world.line, size: '52', count: 2 }])],
      },
    ])
    const [template] = await eventsOf(correlation)
    const applied = newId()
    const event = { ...template!, eventId: newId(), type: 'work_order_change.applied', subject: change!.id, correlationId: applied, causationId: null, occurredAt: decidedAt.toISOString(), payload: { changeId: change!.id, salesOrderId: world.order, workOrderId: world.workOrder } } as EventEnvelope
    await orderChangeNotes(callerFor(h.database, systemContext(T, applied)), event)

    const lines = await notesOn('SalesOrder', world.order)
    expect(lines).toHaveLength(2)
    const text = lines[1]!.bodyText.split('\n')
    expect(text[0]).toMatch(/^Ordine di lavoro cambiato · Otto Office · \d\d:\d\d$/)
    expect(text).toContain(`Fatto: ${world.number} cambiato: 52 4 → 3 · 2 pezzi in più tenuti come rimanenza del cliente.`)
    expect(lines[1]!.bodyText).not.toContain('52 4 → 1')
    const notes = await notesOn('WorkOrder', world.workOrder)
    expect(notes).toHaveLength(2)
    expect(notes[1]!.bodyText).toBe(`${world.number} cambiato: taglia 52 3.`)
    expect(notes[1]!.bodyText).not.toMatch(/in più|rimanenza|addebit|scart/)
  })
})
// ---- end B-SA-053b

describe('B-SA-054: the outside workshops are told by their own subcontract order', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const rule = () => PARTNER_RULES.find((entry) => entry.name === 'portalProduction.workshopOrderChanged')!
  const draftsOf = (event: EventEnvelope) => h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) => rule().drafts({ tx: client as never, tenantId: T, now: h.clock.now(), event }, event.payload))

  it("an open job of the changed work order: its workshop is told, by the job's number only; a work order with no open job tells nobody", async () => {
    const world = await inWork(3)
    const seeded = await one<{ id: string; partyId: string }>(`SELECT id::text AS id, "partyId"::text AS "partyId" FROM "SubcontractOrder" WHERE "tenantId" = $1 AND number = 'SEED-SC-0001'`, [T])
    const job = newId()
    await planted([copy('SubcontractOrder', seeded.id, { id: job, number: `${world.tag}-SC`, workOrderId: world.workOrder, status: 'ISSUED', version: 1 })])
    const correlation = newId()
    await acceptRequest(caller(SALES, correlation), world.request, { version: 1 }, undefined, h.clock)
    await tellEveryone(correlation)
    const [floorEvent] = await eventsOf(correlation).then((events) => events.filter((event) => event.type === 'production.floor_note_posted'))
    expect(floorEvent).toBeDefined()
    const drafts = await draftsOf(floorEvent!)
    expect(drafts.map((draft) => ({ partyId: draft.partyId, record: draft.record, messageKey: draft.messageKey, params: draft.params }))).toEqual([
      { partyId: seeded.partyId, record: { type: 'SubcontractOrder', id: job, label: `${world.tag}-SC` }, messageKey: 'portal.job.order_changed', params: {} },
    ])
    const party = await customer()
    const words = JSON.stringify(drafts.map(({ forReader: _forReader, ...draft }) => draft))
    for (const word of [party.code, party.legalName, party.tradeName, world.tag + '-WO', world.order].filter((entry): entry is string => !!entry)) expect(words).not.toContain(word)

    // A floor note that is not that work order's own (another work order named) tells nobody.
    const quiet: EventEnvelope = { ...floorEvent!, eventId: newId(), payload: { ...(floorEvent!.payload as Json), workOrderId: newId() } }
    expect(await draftsOf(quiet)).toEqual([])
    // The seeds' own job of WO-0001 is a DRAFT (not at the workshop): a change of WO-0001 tells no workshop.
    expect(await admin(`SELECT 1 FROM "SubcontractOrder" WHERE id = $1 AND status = 'DRAFT'`, [seeded.id])).toHaveLength(1)
    // Nor does a change that touches no quantity (a pause: the floor note alone).
    expect(await draftsOf({ ...floorEvent!, eventId: newId(), payload: { ...(floorEvent!.payload as Json), changes: ['PAUSED'] } })).toEqual([])
  })
})
