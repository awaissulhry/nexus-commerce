import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedChanges, type ChangesSeed } from '../seed/changes'
import { seed as seedFiles } from '../seed/files'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedSamples, type SamplesSeed } from '../seed/samples'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Change control, release and samples (W2b-4, schema wave 29/33, B-W2b-212, …_changes_samples_w2b_guards) on a database built
 * from the migrations and seeded, through the real login and the scoped client:
 *   - a released revision: its release scope widens only (the style's colourways and sizes), never on an OBSOLETE one; its
 *     completeness score once, never on a draft; every other column still frozen (B-W2b-205's guard, redefined);
 *   - change requests: a floor device inserts its own (no number, no read back) with a photo; numbered before it leaves OPEN;
 *     moves, a decision once, DONE with a released change order;
 *   - change orders: DRAFT → SUBMITTED (with its draft revision) → APPROVED (an approver who is not the author) → RELEASED (its
 *     revision released); lines and approvals only while they may change; frozen out of DRAFT;
 *   - sample rounds: cells, the pinned revision, a decision by the office or as the brand's answer to its approval request
 *     (portal or link), frozen once decided; fit measured against the frozen spec; comments; swatches; shipments; gates;
 *   - a SAMPLE work order: its round, its revision, cells of the order that charges it;
 *   - grants: the partner reads its own rounds, swatches and shipments without the hidden columns, the floor none of it.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-212-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let p: ProductionSeed
let s: SamplesSeed
let c: ChangesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1'), P1: key('party:P1'), P2: key('party:P2'), member: key('user:member'), store: key('files:account:r2') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: A.P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const now = () => new Date().toISOString()

/** A new style (a copy of SEED-JKT-02 with its two colourways and sizes 50-54) with revision 1 RELEASED and revision 2 DRAFT. */
async function newStyle(): Promise<{ style: string; rev1: string; rev2: string; blk: string; red: string }> {
  const style = randomUUID()
  expect(await copyRow(office(), 'Style', p.styleId, { id: style, code: tag('T-STY') })).toBe(1)
  const colourways = await admin(`SELECT id::text AS id, code FROM "Colourway" WHERE "styleId" = $1`, [p.styleId])
  const ids: Record<string, string> = {}
  for (const row of colourways) {
    ids[row.code as string] = randomUUID()
    expect(await copyRow(office(), 'Colourway', row.id as string, { id: ids[row.code as string], styleId: style })).toBe(1)
  }
  const rev1 = randomUUID()
  const rev2 = randomUUID()
  expect(await copyRow(office(), 'StyleRevision', p.revisionId, { id: rev1, styleId: style, revision: 1 })).toBe(1)
  expect(await copyRow(office(), 'StyleRevision', p.revisionId, { id: rev2, styleId: style, revision: 2, status: 'DRAFT', releasedAt: null, releasedById: null, effectiveFrom: null })).toBe(1)
  return { style, rev1, rev2, blk: ids.BLK!, red: ids.RED! }
}

beforeAll(async () => {
  db = await migratedDatabase('changessamplesw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  p = await seedProduction({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  s = await seedSamples({ db: factory, namespace: NS })
  c = await seedChanges({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedSamples({ db: factory, namespace: NS })
  await seedChanges({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('a released revision (B-W2b-205\'s guard, redefined with the release scope)', () => {
  it('widens what it is released for, never narrows it, with the style\'s colourways and sizes, each once', async () => {
    const t = await newStyle()
    // Some colourways and sizes only (PRD-191): planned on the draft, released with it (the old revision OBSOLETE first).
    expect(await update(office(), 'StyleRevision', t.rev2, `"releasedColourwayIds" = ARRAY[$2::uuid], "releasedSizes" = ARRAY['50', '52']`, t.blk)).toBe(1)
    await expect(update(office(), 'StyleRevision', t.rev2, `"completenessPct" = 50`)).rejects.toThrow(/from its release on/)
    expect(await update(office(), 'StyleRevision', t.rev1, `status = 'OBSOLETE'`)).toBe(1)
    expect(await update(office(), 'StyleRevision', t.rev2, `status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid`, a.actorId)).toBe(1)
    // An empty scope is every colourway or size: a released revision with it never narrows to some.
    await expect(update(office(), 'StyleRevision', (await newStyle()).rev1, `"releasedSizes" = ARRAY['50']`)).rejects.toThrow(/only widens/)
    const scope = (set: string, ...values: unknown[]) => update(office(), 'StyleRevision', t.rev2, set, ...values)
    expect(await scope(`"releasedColourwayIds" = ARRAY[$2::uuid, $3::uuid]`, t.blk, t.red)).toBe(1)
    await expect(scope(`"releasedColourwayIds" = ARRAY[$2::uuid]`, t.red)).rejects.toThrow(/only widens/)
    await expect(scope(`"releasedSizes" = ARRAY['50']`)).rejects.toThrow(/only widens/)
    await expect(scope(`"releasedSizes" = ARRAY['50', '52', '58']`)).rejects.toThrow(/sizes of its style's range/)
    await expect(scope(`"releasedSizes" = ARRAY['50', '52', '52']`)).rejects.toThrow(/each colourway and size once/)
    const other = (await one(`SELECT id::text AS id FROM "Colourway" WHERE "styleId" = $1 LIMIT 1`, [p.styleId])).id as string
    await expect(scope(`"releasedColourwayIds" = ARRAY[$2::uuid, $3::uuid, $4::uuid]`, t.blk, t.red, other)).rejects.toThrow(/colourways of its style/)
    // Empty = all: a widening; all never narrows again.
    expect(await scope(`"releasedSizes" = ARRAY[]::text[]`)).toBe(1)
    await expect(scope(`"releasedSizes" = ARRAY['50']`)).rejects.toThrow(/only widens/)
    // The completeness score: from the release on, once; never on a draft.
    expect(await scope(`"completenessPct" = 87.5`)).toBe(1)
    await expect(scope(`"completenessPct" = 90`)).rejects.toThrow(/given once/)
    // OBSOLETE: fixed.
    expect(await scope(`status = 'OBSOLETE'`)).toBe(1)
    await expect(scope(`"releasedColourwayIds" = ARRAY[]::uuid[]`)).rejects.toThrow(/OBSOLETE; what it was released for never changes/)
  })

  it('still refuses every other column of a released revision, one by one', async () => {
    const t = await newStyle()
    const moves = new Set(['tenantId', 'status', 'effectiveTo', 'releasedColourwayIds', 'releasedSizes', 'completenessPct', 'version', 'updatedAt'])
    const columns = (await admin(`SELECT column_name AS name, data_type AS type, udt_name AS udt FROM information_schema.columns WHERE table_name = 'StyleRevision'`)) as { name: string; type: string; udt: string }[]
    const changeOf = (column: { name: string; type: string; udt: string }): string => {
      if (column.udt === 'uuid') return `gen_random_uuid()`
      if (column.type === 'integer') return `"${column.name}" + 1`
      if (column.type === 'numeric') return `coalesce("${column.name}", 0) + 1`
      if (column.type === 'text') return `coalesce("${column.name}", '') || 'x'`
      if (column.type === 'date') return `coalesce("${column.name}", current_date) + 1`
      if (column.type.startsWith('timestamp')) return `coalesce("${column.name}", now()) + interval '1 minute'`
      if (column.udt === 'StyleRevisionStatus') return `'DRAFT'`
      // B-W2b-211 (merged before this step): the BOM's output unit.
      if (column.udt === 'Uom') return `CASE WHEN "${column.name}" = 'PAIR' THEN 'SET' ELSE 'PAIR' END::"Uom"`
      throw new Error(`no change for ${column.name} ${column.type}`)
    }
    let tried = 0
    for (const column of columns.filter((entry) => !moves.has(entry.name))) {
      tried += 1
      // A changed id or reference may be refused by a key first; either way the revision does not change.
      await expect(update(office(), 'StyleRevision', t.rev1, `"${column.name}" = ${changeOf(column)}`), column.name).rejects.toThrow()
    }
    expect(tried).toBeGreaterThanOrEqual(10)
    await expect(update(office(), 'StyleRevision', t.rev1, `"changeNote" = 'x'`)).rejects.toThrow(/it never changes, a change is a new revision/)
    await expect(update(office(), 'StyleRevision', t.rev1, `"plannedHideYieldPct" = 50`)).rejects.toThrow(/it never changes, a change is a new revision/)
    expect(await update(office(), 'StyleRevision', t.rev1, `"completenessPct" = 80`)).toBe(1)
  })
})

describe('change requests (PRD-169, PRD-259, MES-006)', () => {
  const request = (changes: Record<string, unknown>) => copyRow(office(), 'ChangeRequest', c.requestIds.office, { id: randomUUID(), number: tag('T-CR'), ...changes })

  it('a floor device inserts its own request of its site, without a number, and reads none; the office numbers it later', async () => {
    const id = randomUUID()
    const row = { id, companyId: A.company, siteId: A.site, source: 'FLOOR', styleId: p.styleId, revisionId: p.revisionId, workOrderId: p.workOrderId, title: 'Zip puller rubs the tank', reason: 'Seen on WO-0001 at sewing (made-up).', priority: 'HIGH' }
    expect(await insert(floor(), 'ChangeRequest', row)).toBe(1)
    await expect(sql(floor(), `SELECT id FROM "ChangeRequest" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(insert(floor(), 'ChangeRequest', { ...row, id: randomUUID(), source: 'OFFICE' })).rejects.toThrow(/row-level security/)
    await expect(insert(floor(), 'ChangeRequest', { ...row, id: randomUUID(), number: 'T-1' })).rejects.toThrow(/permission denied/)
    expect(await one(`SELECT number, status::text AS status, "createdById" FROM "ChangeRequest" WHERE id = $1`, [id])).toEqual({ number: null, status: 'OPEN', createdById: null })
    // Its photo, as a file of the request (the floor cannot read the request: the photo is checked against its site's company).
    const photo = (changes: Record<string, unknown>) =>
      insert(floor(), 'StoredFile', {
        id: randomUUID(), companyId: A.company, recordType: 'ChangeRequest', recordId: id, kind: 'PHOTO', originalName: 'zip.jpg', contentType: 'image/jpeg', sizeBytes: 1024,
        sha256: 'b'.repeat(64), storeAccountId: A.store, storageKey: `t/${a.tenantId}/c/${A.company}/2026/${randomUUID()}`, visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.site, ...changes,
      })
    const photoId = randomUUID()
    expect(await photo({ id: photoId })).toBe(1)
    await expect(photo({ kind: 'AUDIO', contentType: 'audio/webm' })).rejects.toThrow(/photos of a change request/)
    await expect(photo({ category: 'BEFORE_WORK' })).rejects.toThrow(/photos of a change request/)
    await expect(photo({ companyId: key('company:B') })).rejects.toThrow(/of this site's company|violates|foreign key/)
    expect(await run(floor(), `UPDATE "StoredFile" SET status = 'AVAILABLE', "availableAt" = now() WHERE id = $1::uuid`, photoId)).toBe(1)
    // The office takes it up: a number before it leaves OPEN, once.
    await expect(update(office(), 'ChangeRequest', id, `status = 'IN_REVIEW'`)).rejects.toThrow(/only an OPEN request from the floor waits for it/)
    expect(await update(office(), 'ChangeRequest', id, `number = $2, status = 'IN_REVIEW'`, tag('T-CR'))).toBe(1)
    await expect(update(office(), 'ChangeRequest', id, `number = 'X-1'`)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'ChangeRequest', id, `"workOrderId" = NULL`)).rejects.toThrow(/never change/)
  })

  it('an office request is numbered; its source names its party or round; a work order of its style at its site', async () => {
    await expect(request({ number: null })).rejects.toThrow(/has its number from its company's CHANGE_REQUEST series/)
    await expect(request({ source: 'CUSTOMER' })).rejects.toThrow(/names the customer or supplier who asked/)
    expect(await request({ source: 'CUSTOMER', partyId: A.P1 })).toBe(1)
    await expect(request({ partyId: A.P1 })).rejects.toThrow(/names the customer or supplier who asked/)
    await expect(request({ source: 'SAMPLE' })).rejects.toThrow(/sample round that raised it/)
    expect(await request({ source: 'SAMPLE', sampleRoundId: s.roundIds.pp })).toBe(1)
    await expect(request({ siteId: null })).rejects.toThrow(/names its site/)
    await expect(request({ title: '  ' })).rejects.toThrow(/says what should change/)
    await expect(request({ status: 'ACCEPTED' })).rejects.toThrow(/a new change request is OPEN/)
    // No delete grant; the trigger refuses it to the owner too.
    await expect(run(office(), `DELETE FROM "ChangeRequest" WHERE id = $1::uuid`, c.requestIds.office)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "ChangeRequest" WHERE id = $1`, [c.requestIds.office])).rejects.toThrow(/never deleted/)
  })

  it('moves OPEN → IN_REVIEW → ACCEPTED → DONE with its released change order, decided once; a rejection says why', async () => {
    const id = randomUUID()
    expect(await request({ id })).toBe(1)
    await expect(update(office(), 'ChangeRequest', id, `status = 'DONE'`)).rejects.toThrow(/cannot move from OPEN to DONE/)
    await expect(update(office(), 'ChangeRequest', id, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid`, A.member)).rejects.toThrow(/why for a rejection/)
    await expect(update(office(), 'ChangeRequest', id, `status = 'ACCEPTED'`)).rejects.toThrow(/wrong decision/)
    await expect(update(office(), 'ChangeRequest', id, `"changeOrderId" = $2::uuid`, c.changeOrderId)).rejects.toThrow(/only while IN_REVIEW, ACCEPTED or DONE/)
    expect(await update(office(), 'ChangeRequest', id, `status = 'ACCEPTED', "decidedAt" = now(), "decidedById" = $2::uuid, "changeOrderId" = $3::uuid`, A.member, c.changeOrderId)).toBe(1)
    await expect(update(office(), 'ChangeRequest', id, `"decidedById" = $2::uuid`, a.actorId)).rejects.toThrow(/written once/)
    await expect(update(office(), 'ChangeRequest', id, `title = 'Another thing'`)).rejects.toThrow(/stay as they were decided/)
    await expect(update(office(), 'ChangeRequest', id, `status = 'DONE'`)).rejects.toThrow(/DONE once that one is RELEASED \(it is DRAFT\)/)
    // A rejected one never changes.
    expect(await update(office(), 'ChangeRequest', c.requestIds.sample, `version = version`)).toBe(1)
    await expect(update(office(), 'ChangeRequest', c.requestIds.sample, `priority = 'LOW'`)).rejects.toThrow(/REJECTED; it never changes/)
  })
})

describe('change orders (PRD-170): one approval by someone who is not the author, then the release', () => {
  it('runs DRAFT → SUBMITTED → APPROVED → RELEASED and keeps the four eyes, its lines and its frozen columns', async () => {
    const t = await newStyle()
    const order = randomUUID()
    const make = (changes: Record<string, unknown>) => copyRow(office(), 'ChangeOrder', c.changeOrderId, { id: randomUUID(), number: tag('T-ECO'), styleId: t.style, fromRevisionId: t.rev1, ...changes })
    await expect(make({ fromRevisionId: t.rev2 })).rejects.toThrow(/changes the style's RELEASED revision/)
    await expect(make({ toRevisionId: t.rev1 })).rejects.toThrow(/proposes a DRAFT revision of the style after the one it changes/)
    await expect(make({ status: 'SUBMITTED' })).rejects.toThrow(/a new change order is DRAFT/)
    await expect(make({ effect: 'DATE' })).rejects.toThrow(/on a day exactly when its effect is DATE/)
    await expect(make({ number: null })).rejects.toThrow(/has its number/)
    expect(await make({ id: order })).toBe(1)
    const line = (changes: Record<string, unknown>) => copyRow(office(), 'ChangeOrderItem', c.itemIds.change, { id: randomUUID(), changeOrderId: order, seq: Math.floor(Math.random() * 1e6) + 100, ...changes })
    expect(await line({})).toBe(1)
    await expect(line({ before: null, after: null })).rejects.toThrow(/before and\/or after/)
    await expect(line({ recordType: 'bom line' })).rejects.toThrow(/names the record it touches/)
    await expect(line({ kind: 'WORK_IN_PROGRESS' })).rejects.toThrow(/names an open work order/)
    // A work in progress line names an open work order of the change order's style (WO-0001 is SEED-JKT-02's).
    await expect(line({ kind: 'WORK_IN_PROGRESS', recordType: null, recordId: null, field: null, before: null, after: null, siteId: A.site, workOrderId: p.workOrderId, disposition: 'REWORK' })).rejects.toThrow(/open work order of the change order's style/)
    // The approver is never the author.
    const approval = (changes: Record<string, unknown>) => copyRow(office(), 'ChangeApproval', c.approvalId, { id: randomUUID(), changeOrderId: order, ...changes })
    await expect(approval({ approverId: a.actorId })).rejects.toThrow(/never its author/)
    const asked = randomUUID()
    expect(await approval({ id: asked })).toBe(1)
    await expect(update(office(), 'ChangeApproval', asked, `decision = 'APPROVED', "decidedAt" = now()`)).rejects.toThrow(/decided while its change order is SUBMITTED \(it is DRAFT\)/)
    // Submitted with its draft revision; then frozen but for the status, the times and the priority.
    await expect(update(office(), 'ChangeOrder', order, `status = 'SUBMITTED', "submittedAt" = now()`)).rejects.toThrow(/submitted with the DRAFT revision/)
    expect(await update(office(), 'ChangeOrder', order, `"toRevisionId" = $2::uuid`, t.rev2)).toBe(1)
    expect(await update(office(), 'ChangeOrder', order, `status = 'SUBMITTED', "submittedAt" = now()`)).toBe(1)
    await expect(update(office(), 'ChangeOrder', order, `title = 'Changed after submission'`)).rejects.toThrow(/only its status, the times of its moves and its priority change/)
    expect(await update(office(), 'ChangeOrder', order, `priority = 'URGENT'`)).toBe(1)
    await expect(line({})).rejects.toThrow(/change only while it is DRAFT \(it is SUBMITTED\)/)
    await expect(run(office(), `DELETE FROM "ChangeOrderItem" WHERE "changeOrderId" = $1::uuid`, order)).rejects.toThrow(/change only while it is DRAFT/)
    // Approved only once the required approval is APPROVED.
    await expect(update(office(), 'ChangeOrder', order, `status = 'APPROVED', "decidedAt" = now()`)).rejects.toThrow(/1 named, 0 approved, 1 waiting, 0 rejected/)
    await expect(update(office(), 'ChangeApproval', asked, `decision = 'REJECTED', "decidedAt" = now()`)).rejects.toThrow(/a rejection says why/)
    expect(await update(office(), 'ChangeApproval', asked, `decision = 'APPROVED', "decidedAt" = now()`)).toBe(1)
    await expect(update(office(), 'ChangeApproval', asked, `reason = 'Late note'`)).rejects.toThrow(/the decision is written once/)
    await expect(run(office(), `DELETE FROM "ChangeApproval" WHERE id = $1::uuid`, asked)).rejects.toThrow(/removed only undecided/)
    await expect(update(office(), 'ChangeOrder', order, `status = 'REJECTED', "decidedAt" = now()`)).rejects.toThrow(/rejected only by an approver's rejection/)
    expect(await update(office(), 'ChangeOrder', order, `status = 'APPROVED', "decidedAt" = now()`)).toBe(1)
    await expect(approval({ approverId: randomUUID() })).rejects.toThrow(/while the change order is DRAFT or SUBMITTED/)
    // Released with its new revision: the old one OBSOLETE, the new one RELEASED, in one transaction as the release does.
    await expect(update(office(), 'ChangeOrder', order, `status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid`, a.actorId)).rejects.toThrow(/with its new revision RELEASED, not DRAFT/)
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "StyleRevision" SET status = 'OBSOLETE' WHERE id = $1::uuid`, t.rev1)
        await tx.$executeRawUnsafe(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid, "completenessPct" = 100 WHERE id = $1::uuid`, t.rev2, a.actorId)
        await tx.$executeRawUnsafe(`UPDATE "ChangeOrder" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid WHERE id = $1::uuid`, order, a.actorId)
      }),
    )
    await expect(update(office(), 'ChangeOrder', order, `priority = 'LOW'`)).rejects.toThrow(/RELEASED; it never changes/)
    await expect(admin(`DELETE FROM "ChangeOrder" WHERE id = $1`, [order])).rejects.toThrow(/never deleted/)
    // Its accepted request is DONE now.
    const done = randomUUID()
    expect(await copyRow(office(), 'ChangeRequest', c.requestIds.office, { id: done, number: tag('T-CR'), styleId: t.style, revisionId: null, workOrderId: null, siteId: null })).toBe(1)
    expect(await update(office(), 'ChangeRequest', done, `status = 'ACCEPTED', "decidedAt" = now(), "decidedById" = $2::uuid, "changeOrderId" = $3::uuid`, A.member, order)).toBe(1)
    expect(await update(office(), 'ChangeRequest', done, `status = 'DONE'`)).toBe(1)
    // One live change order per proposed revision.
    const t2 = await newStyle()
    expect(await make({ styleId: t2.style, fromRevisionId: t2.rev1, toRevisionId: t2.rev2 })).toBe(1)
    await expect(make({ styleId: t2.style, fromRevisionId: t2.rev1, toRevisionId: t2.rev2 })).rejects.toThrow(/ChangeOrder_one_live_per_to_revision|unique/i)
  })
})

describe('sample rounds (SAL-311, SAL-312, PRD-158)', () => {
  const round = (changes: Record<string, unknown>) => copyRow(office(), 'SampleRound', s.roundIds.fit, { id: randomUUID(), number: tag('T-SR'), ...changes })
  const blk01 = async () => (await one(`SELECT id::text AS id FROM "Colourway" WHERE "styleId" = (SELECT "styleId" FROM "SampleRound" WHERE id = $1) AND code = 'BLK'`, [s.roundIds.fit])).id as string

  it('asks cells of the style\'s colourways and sizes, each once; a charge with its currency; certification columns on a certification round', async () => {
    const blk = await blk01()
    await expect(round({ cells: [] })).rejects.toThrow(/a list of 1 to 200 cells/)
    await expect(round({ cells: [{ size: '58', quantity: 1 }] })).rejects.toThrow(/a size of the style's range in every cell \(not 58\)/)
    await expect(round({ cells: [{ size: '52', quantity: 0 }] })).rejects.toThrow(/a whole quantity from 1 to 1000/)
    await expect(round({ cells: [{ size: '52', quantity: 1.5 }] })).rejects.toThrow(/a whole quantity from 1 to 1000/)
    await expect(round({ cells: [{ size: '52', quantity: 1, colour: 'red' }] })).rejects.toThrow(/a colourway, a size and a quantity only/)
    await expect(round({ cells: [{ colourwayId: randomUUID(), size: '52', quantity: 1 }] })).rejects.toThrow(/a colourway of the style/)
    await expect(round({ cells: [{ colourwayId: blk, size: '52', quantity: 1 }, { colourwayId: blk, size: '52', quantity: 2 }] })).rejects.toThrow(/each colourway and size once/)
    expect(await round({ cells: [{ colourwayId: blk, size: '52', quantity: 1 }, { size: '52', quantity: 2 }] })).toBe(1)
    await expect(round({ chargeAmountMinor: 100 })).rejects.toThrow(/in a currency/)
    await expect(round({ chargeAmountMinor: 100, chargeCurrency: 'eur' })).rejects.toThrow(/in a currency/)
    expect(await round({ chargeAmountMinor: 0, chargeCurrency: 'EUR' })).toBe(1)
    await expect(round({ testZones: 'Shoulders' })).rejects.toThrow(/only a CERTIFICATION round/)
    await expect(round({ stage: 'DECIDED' })).rejects.toThrow(/neither decided nor cancelled/)
    await expect(round({ partyId: null, approvalRequestId: s.approvalRequestId })).rejects.toThrow(/an internal round has no approval request/)
  })

  it('keeps its pinned revision once in making; moves its manual stages freely; is DECIDED only with its decision, frozen after', async () => {
    const id = randomUUID()
    expect(await round({ id })).toBe(1)
    expect(await update(office(), 'SampleRound', id, `stage = 'IN_MAKING'`)).toBe(1)
    const rev2 = randomUUID()
    expect(await copyRow(office(), 'StyleRevision', p.revisionId, { id: rev2, styleId: (await one(`SELECT "styleId"::text AS id FROM "SampleRound" WHERE id = $1`, [id])).id, revision: 7, status: 'DRAFT', releasedAt: null, releasedById: null, effectiveFrom: null, labelTemplateId: null })).toBe(1)
    await expect(update(office(), 'SampleRound', id, `"revisionId" = $2::uuid`, rev2)).rejects.toThrow(/changes only while REQUESTED \(it is IN_MAKING\)/)
    expect(await update(office(), 'SampleRound', id, `stage = 'REQUESTED'`)).toBe(1)
    expect(await update(office(), 'SampleRound', id, `"revisionId" = $2::uuid, stage = 'SENT'`, rev2)).toBe(1)
    await expect(update(office(), 'SampleRound', id, `stage = 'DECIDED'`)).rejects.toThrow(/DECIDED exactly with its decision/)
    await expect(update(office(), 'SampleRound', id, `stage = 'DECIDED', decision = 'REJECTED', "decidedAt" = now(), "decidedVia" = 'OFFICE', "decidedById" = $2::uuid`, A.member)).rejects.toThrow(/the comments say why/)
    await expect(update(office(), 'SampleRound', id, `stage = 'DECIDED', decision = 'APPROVED', "decidedAt" = now(), "decidedVia" = 'OFFICE'`)).rejects.toThrow(/names the office user who recorded it/)
    await expect(update(office(), 'SampleRound', id, `stage = 'DECIDED', decision = 'APPROVED', "decidedAt" = now(), "decidedVia" = 'PORTAL', "decidedById" = $2::uuid`, A.member)).rejects.toThrow(/the answer of its approval request/)
    expect(await update(office(), 'SampleRound', id, `stage = 'DECIDED', decision = 'APPROVED', "decidedAt" = now(), "decidedVia" = 'OFFICE', "decidedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'SampleRound', id, `"dueDate" = current_date`)).rejects.toThrow(/DECIDED; only a certification result and certificate may still come/)
    await expect(update(office(), 'SampleRound', id, `stage = 'UNDER_REVIEW', decision = NULL, "decidedAt" = NULL, "decidedVia" = NULL, "decidedById" = NULL`)).rejects.toThrow(/DECIDED; only/)
    await expect(admin(`DELETE FROM "SampleRound" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    // Cancelled with when and why; a certification round gets its result and certificate after, once.
    await expect(update(office(), 'SampleRound', s.roundIds.fit, `stage = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/with when and why/)
    expect(await update(office(), 'SampleRound', s.roundIds.cert, `version = version`)).toBe(1)
    await expect(update(office(), 'SampleRound', s.roundIds.cert, `"testResult" = 'FAILED'`)).rejects.toThrow(/written once/)
  })

  it('takes the brand\'s answer to its approval request as its decision: the same answer, at its time, by its portal user or its link', async () => {
    const id = randomUUID()
    const request = randomUUID()
    expect(await round({ id, stage: 'UNDER_REVIEW' })).toBe(1)
    expect(await insert(office(), 'ApprovalRequest', { id: request, companyId: A.company, recordType: 'SampleRound', recordId: id, partyId: A.P1, kind: 'SAMPLE', question: 'Approve the fit sample? (made-up)', dueAt: new Date(Date.now() + 86_400_000).toISOString() })).toBe(1)
    const other = randomUUID()
    expect(await insert(office(), 'ApprovalRequest', { id: other, companyId: A.company, recordType: 'SampleRound', recordId: id, partyId: A.P1, kind: 'COLOUR', question: 'A colour? (made-up)', dueAt: new Date(Date.now() + 86_400_000).toISOString() })).toBe(1)
    await expect(update(office(), 'SampleRound', id, `"approvalRequestId" = $2::uuid`, other)).rejects.toThrow(/asks a SAMPLE decision about this SampleRound/)
    await expect(update(office(), 'SampleRound', id, `"approvalRequestId" = $2::uuid`, s.approvalRequestId)).rejects.toThrow(/asks a SAMPLE decision about this SampleRound/)
    expect(await update(office(), 'SampleRound', id, `"approvalRequestId" = $2::uuid`, request)).toBe(1)
    // The brand's partner user answers in the portal (the request's own guard keeps the answer's shape).
    const buyer = (await one(`SELECT id::text AS id FROM "User" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    const answeredAt = new Date().toISOString()
    expect(await update(office(), 'ApprovalRequest', request, `status = 'APPROVED_WITH_CHANGES', answer = 'Shorter sleeves', "typedName" = 'Seed Buyer', "answerRequestId" = 'req-1', "answeredAt" = $2::timestamptz, "answeredByUserId" = $3::uuid, version = version + 1`, answeredAt, buyer)).toBe(1)
    const decide = (set: string, ...values: unknown[]) => update(office(), 'SampleRound', id, `stage = 'DECIDED', ${set}`, ...values)
    await expect(decide(`decision = 'APPROVED', "decidedAt" = $2::timestamptz, "decidedVia" = 'PORTAL', "decidedById" = $3::uuid`, answeredAt, buyer)).rejects.toThrow(/its approval request's answer/)
    await expect(decide(`decision = 'APPROVED_WITH_COMMENTS', "decisionComments" = 'Shorter sleeves', "decidedAt" = now(), "decidedVia" = 'PORTAL', "decidedById" = $2::uuid`, buyer)).rejects.toThrow(/its approval request's answer/)
    await expect(decide(`decision = 'APPROVED_WITH_COMMENTS', "decisionComments" = 'Shorter sleeves', "decidedAt" = $2::timestamptz, "decidedVia" = 'LINK'`, answeredAt)).rejects.toThrow(/its approval request's answer/)
    expect(await decide(`decision = 'APPROVED_WITH_COMMENTS', "decisionComments" = 'Shorter sleeves', "decidedAt" = $2::timestamptz, "decidedVia" = 'PORTAL', "decidedById" = $3::uuid`, answeredAt, buyer)).toBe(1)
  })

  it('measures the fit against the spec frozen in the row, only while the round is open; comments are resolved at any time', async () => {
    const measure = async (changes: Record<string, unknown>) => copyRow(office(), 'SampleMeasurement', (await one(`SELECT id::text AS id FROM "SampleMeasurement" WHERE "roundId" = $1 ORDER BY id LIMIT 1`, [s.roundIds.fit])).id as string, { id: randomUUID(), pomCode: tag('P'), ...changes })
    await expect(measure({ measured: '56.50' })).rejects.toThrow(/together/)
    expect(await measure({ measured: '56.50', measuredAt: now(), pass: true })).toBe(1)
    await expect(measure({ measured: '57.50', measuredAt: now(), pass: true })).rejects.toThrow(/within the tolerance/)
    expect(await measure({ measured: '57.50', measuredAt: now(), pass: false })).toBe(1)
    await expect(measure({ nominal: '0' })).rejects.toThrow(/nominal value above 0/)
    await expect(measure({ uom: 'M' })).rejects.toThrow(/in CM or MM/)
    await expect(measure({ size: '5 2' })).rejects.toThrow(/no spaces/)
    const id = randomUUID()
    expect(await measure({ id })).toBe(1)
    await expect(update(office(), 'SampleMeasurement', id, `nominal = 60`)).rejects.toThrow(/the spec frozen from it/)
    expect(await update(office(), 'SampleMeasurement', id, `measured = 55.2, "measuredAt" = now(), pass = true`)).toBe(1)
    // The proto is decided: its fit is closed, its comments' resolution is not.
    const comment = randomUUID()
    await expect(copyRow(office(), 'SampleMeasurement', id, { id: randomUUID(), roundId: s.roundIds.proto, pomCode: tag('P') })).rejects.toThrow(/written only while it is open \(it is DECIDED\)/)
    await expect(copyRow(office(), 'SampleComment', (await one(`SELECT id::text AS id FROM "SampleComment" WHERE "roundId" = $1 ORDER BY id LIMIT 1`, [s.roundIds.fit])).id as string, { id: comment, roundId: s.roundIds.proto })).rejects.toThrow(/written only while it is open/)
    await admin(`SET session_replication_role = replica`)
    try {
      await admin(`INSERT INTO "SampleComment" (id, "tenantId", "roundId", text) VALUES ($1, $2, $3, 'Carried to the next round (made-up)')`, [comment, a.tenantId, s.roundIds.proto])
    } finally {
      await admin(`SET session_replication_role = DEFAULT`)
    }
    await expect(update(office(), 'SampleComment', comment, `resolved = true`)).rejects.toThrow(/exactly with when and by whom/)
    expect(await update(office(), 'SampleComment', comment, `resolved = true, "resolvedAt" = now(), "resolvedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'SampleComment', comment, `text = 'Changed'`)).rejects.toThrow(/written only while it is open/)
  })

  it('sends a swatch of a colour or lot of its material, asks and decides it once sent; ships with tracking, received after sent', async () => {
    const swatch = (changes: Record<string, unknown>) => copyRow(office(), 'SampleSwatch', s.swatchIds.colour, { id: randomUUID(), ...changes })
    await expect(swatch({ itemColourId: null })).rejects.toThrow(/of a colour and\/or a lot/)
    await expect(swatch({ decision: 'APPROVED', decidedAt: now(), decidedVia: 'OFFICE', decidedById: A.member })).rejects.toThrow(/asked and decided once it is sent/)
    const lining = (await one(`SELECT id::text AS id FROM "Item" WHERE "tenantId" = $1 AND code = 'SEED-LIN-200'`, [a.tenantId])).id as string
    const grey = (await one(`SELECT id::text AS id FROM "ItemColour" WHERE "itemId" = $1 LIMIT 1`, [lining])).id as string
    await expect(swatch({ kind: 'LEATHER', itemId: lining, itemColourId: grey })).rejects.toThrow(/is of a leather material, not of a LINING/)
    expect(await swatch({ itemId: lining, itemColourId: grey })).toBe(1)
    await expect(update(office(), 'SampleSwatch', s.swatchIds.leather, `"lotId" = NULL, "lotSiteId" = NULL, "itemColourId" = $2::uuid`, grey)).rejects.toThrow(/what was sent and when never change|decided; only its note changes|foreign key/)
    await expect(update(office(), 'SampleSwatch', s.swatchIds.leather, `"decisionComments" = 'Later'`)).rejects.toThrow(/decided; only its note changes/)
    expect(await update(office(), 'SampleSwatch', s.swatchIds.leather, `note = 'Kept in the library (made-up)'`)).toBe(1)
    await expect(run(office(), `DELETE FROM "SampleSwatch" WHERE id = $1::uuid`, s.swatchIds.leather)).rejects.toThrow(/was sent; it is kept/)

    const shipment = (changes: Record<string, unknown>) => copyRow(office(), 'SampleShipment', s.shipmentIds.fit, { id: randomUUID(), ...changes })
    await expect(shipment({ receivedAt: now() })).rejects.toThrow(/received after it was sent/)
    await expect(shipment({ direction: 'RETURN' })).rejects.toThrow(/a RETURN names no address/)
    await expect(shipment({ trackingUrl: 'http://tracking.example.com/1' })).rejects.toThrow(/as an https address/)
    expect(await shipment({ sentAt: now(), trackingUrl: 'https://tracking.example.com/1' })).toBe(1)
    await expect(update(office(), 'SampleShipment', s.shipmentIds.ppOut, `"sentAt" = now()`)).rejects.toThrow(/set once/)
    await expect(run(office(), `DELETE FROM "SampleShipment" WHERE id = $1::uuid`, s.shipmentIds.ppOut)).rejects.toThrow(/was sent; it is kept/)
    expect(await run(office(), `DELETE FROM "SampleShipment" WHERE id = $1::uuid`, s.shipmentIds.fit)).toBe(1)
  })
})

describe('pre-production gates (PLN-186)', () => {
  const gate = (changes: Record<string, unknown>) => copyRow(office(), 'OrderGate', s.gateIds.other, { id: randomUUID(), ...changes })

  it('names a sample round only on a sample gate and passes it once the round is approved; an override by another person, with why', async () => {
    await expect(gate({ label: null })).rejects.toThrow(/required for OTHER/)
    await expect(gate({ sampleRoundId: s.roundIds.pp })).rejects.toThrow(/only a sample gate/)
    await expect(gate({ kind: 'PP_SAMPLE' })).rejects.toThrow(/OrderGate_one_per_kind|unique/i)
    await expect(gate({ kind: 'SAMPLE_APPROVED', sampleRoundId: s.roundIds.pp, passedAt: now(), passedById: a.actorId })).rejects.toThrow(/passes once its sample round is approved \(it is not decided\)/)
    expect(await gate({ kind: 'SAMPLE_APPROVED', sampleRoundId: s.roundIds.proto, passedAt: now(), passedById: a.actorId })).toBe(1)
    await expect(update(office(), 'OrderGate', s.gateIds.pp, `"sampleRoundId" = $2::uuid`, s.roundIds.proto)).rejects.toThrow(/waits for a PRE_PRODUCTION round, not a PROTO one/)
    await expect(update(office(), 'OrderGate', s.gateIds.pp, `"overriddenAt" = now(), "overriddenById" = $2::uuid, "overrideReason" = 'Late'`, a.actorId)).rejects.toThrow(/neither its owner nor its maker/)
    await expect(update(office(), 'OrderGate', s.gateIds.pp, `"overriddenAt" = now(), "overriddenById" = $2::uuid`, A.member)).rejects.toThrow(/when, by whom and why/)
    expect(await update(office(), 'OrderGate', s.gateIds.pp, `"overriddenAt" = now(), "overriddenById" = $2::uuid, "overrideReason" = 'Brand on holiday; cutting may start (made-up)'`, A.member)).toBe(1)
    await expect(update(office(), 'OrderGate', s.gateIds.pp, `"overrideReason" = 'Another reason'`)).rejects.toThrow(/each once/)
    await expect(update(office(), 'OrderGate', s.gateIds.leather, `"passedAt" = now()`)).rejects.toThrow(/each once/)
    await expect(run(office(), `DELETE FROM "OrderGate" WHERE id = $1::uuid`, s.gateIds.pp)).rejects.toThrow(/it is kept/)
    expect(await run(office(), `DELETE FROM "OrderGate" WHERE id = $1::uuid`, s.gateIds.other)).toBe(1)
  })
})

describe('a SAMPLE work order (MES-018)', () => {
  it('makes its round from the round\'s revision, with cells of the order that charges the samples', async () => {
    const make = (changes: Record<string, unknown>) => copyRow(office(), 'WorkOrder', p.draftWorkOrderId, { id: randomUUID(), number: tag('T-WO'), ...changes })
    await expect(make({ kind: 'SAMPLE' })).rejects.toThrow(/a SAMPLE work order names the sample round it makes/)
    await expect(make({ sampleRoundId: s.roundIds.pp })).rejects.toThrow(/only a SAMPLE one does/)
    await expect(make({ kind: 'SAMPLE', sampleRoundId: s.roundIds.proto })).rejects.toThrow(/foreign key|DECIDED/)
    const order = randomUUID()
    expect(await make({ id: order, kind: 'SAMPLE', sampleRoundId: s.roundIds.pp })).toBe(1)
    await expect(update(office(), 'WorkOrder', order, `"sampleRoundId" = $2::uuid`, s.roundIds.cert)).rejects.toThrow(/never changes/)
    // Its cells name the SIZE_GRID line of the order (W1: a cell needs a sales order line), without a measurement profile.
    const cell = (await one(`SELECT id::text AS id FROM "WorkOrderSize" WHERE "workOrderId" = $1 LIMIT 1`, [p.draftWorkOrderId])).id as string
    expect(await copyRow(office(), 'WorkOrderSize', cell, { id: randomUUID(), workOrderId: order })).toBe(1)
    // A size grid order still takes a size grid line only; a made-to-measure one a made-to-measure line only (as before).
    const mtm = randomUUID()
    expect(await make({ id: mtm, kind: 'MADE_TO_MEASURE' })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', cell, { id: randomUUID(), workOrderId: mtm })).rejects.toThrow(/made-to-measure unit with its measurement profile|makes its sales order line/)
  })
})

describe('who reads what', () => {
  it('lets the brand read its own rounds, swatches and shipments without the hidden columns, the floor none of it', async () => {
    const rounds = await sql(partner(), `SELECT id::text AS id, number, decision::text AS decision FROM "SampleRound" ORDER BY number`)
    expect(rounds.map((row) => row.number)).toEqual(expect.arrayContaining(['SEED-SR-0001', 'SEED-SR-0003']))
    expect(rounds.map((row) => row.number)).not.toContain('SEED-SR-0002')
    await expect(sql(partner(), `SELECT instructions FROM "SampleRound" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "decidedById" FROM "SampleSwatch" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect((await sql(partner(), `SELECT count(*)::int AS n FROM "SampleShipment"`))[0]!.n).toBeGreaterThan(0)
    await expect(run(partner(), `UPDATE "SampleRound" SET stage = stage WHERE false`)).rejects.toThrow(/permission denied/)
    for (const table of ['SampleMeasurement', 'SampleComment', 'OrderGate', 'ChangeRequest', 'ChangeOrder', 'ChangeOrderItem', 'ChangeApproval']) {
      await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`), table).rejects.toThrow(/permission denied/)
    }
    for (const table of ['SampleRound', 'SampleMeasurement', 'SampleComment', 'SampleSwatch', 'SampleShipment', 'OrderGate', 'ChangeOrder', 'ChangeOrderItem', 'ChangeApproval']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`), table).rejects.toThrow(/permission denied/)
    }
  })
})
