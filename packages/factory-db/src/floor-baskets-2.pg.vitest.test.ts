import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedAndon, type AndonSeed } from '../seed/andon'
import { seed as seedPeople, type PeopleSeed } from '../seed/people'
import type { ProductionSeed } from '../seed/production'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedFloorBaskets, type FloorBasketsFixture } from './testing/floor-baskets'

/**
 * owb-fl0 (order workflow build, schema wave "floor baskets 2"; build/briefs/owb-fl0.md, LF _owb-fl-common.md § 1-4): the rules
 * of …_production_floor_baskets_2_guards on a database built from the migrations and seeded, through the real login and the
 * scoped client. Plant A1 of company A: SEED-WO-0001 with its steps and bundles 1-2, the operator and the team lead, the cutting
 * tablet (seed/production.ts), the employees (seed/people.ts), the SOLVED material call and the SENT maintenance call
 * (seed/andon.ts), and the wave's own rows (testing/floor-baskets.ts: bundle 1's open "Do this first" mark, an idea told without a
 * name). A second tenant's core gives a file of another tenant.
 *   - BasketFlag       a mark is born open at version 1, on a basket of its work order; set → cleared once → a second clear
 *                      refused; nothing else of an open mark changes; two open FIRST marks on one basket refused (a cleared
 *                      one frees it); never deleted; the office reads, never writes.
 *   - FloorSuggestion  append-only (update, delete, truncate refused for every login); the floor inserts and never reads one back;
 *                      without a name no employee and no device; words of 1 to 1000; the voice note an AUDIO file this session
 *                      can open; a client event id once per tenant.
 *   - Checklist photo  OperationChecklistResult.fileId: an image the floor can open, of the work order's company or the whole
 *                      factory; another tenant's file, a file the floor cannot open, a voice note, a fiscal archive, body data, a
 *                      priced file, a PDF or a design file refused.
 *   - HelpCall.spot    0-8 (9 and -1 refused by HelpCall_spot_range); set and changed while the call is open; a SOLVED call keeps
 *                      its place; the call's guard unchanged (the floor's UPDATE of an open call passes it).
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation or a foreign_key_violation, a grant "permission
 * denied", a wall "row-level security"); their messages are read through raw SQL. Files are planted by the owner with triggers off
 * (rows only an upload reaches). Every name is made up. Not run in the build (Owner rule: checks at the end).
 */

const NS = 'owb-fl0-floor-baskets-2'
const DENIED = /permission denied/
const UNIQUE = /Unique constraint|duplicate key|unique/i
// BasketFlag
const FLAG_NEW = /a new basket mark is open \(not cleared\), at version 1/
const FLAG_BASKET = /marks a basket of its work order at its site|_fkey|foreign key/
const FLAG_CLEARED = /basket mark .* was cleared; it never changes again/
const FLAG_ONCE = /is only cleared, once, with when \(not before it was set\) and who; nothing else of it changes/
const FLAG_KEPT = /basket mark .* is cleared, never deleted/
const TRUNCATE = (table: string): RegExp => new RegExp(`TRUNCATE on "${table}" is refused`)
// FloorSuggestion
const APPEND_ONLY = (op: string, table: string): RegExp => new RegExp(`append-only: ${op} on "${table}" is refused`)
const NAMELESS = /is sent without a name: it names no employee and no device/
const WORDS = /has words of 1 to 1000 characters, not blank, or none/
const VOICE_OPEN = /the voice note of suggestion .* is a file this person can open/
const VOICE_KIND = /the voice note of suggestion .* is a voice note \(AUDIO\)/
// Checklist photo
const PHOTO_OPEN = /the photo of ticked step .* is a file this person can open/
const PHOTO_KIND = /the photo of ticked step .* is an image: never a fiscal archive, a voice note, body data/
const PHOTO_COMPANY = /the photo of ticked step .* is a file of its work order's company or of the whole factory/
// HelpCall.spot
const SPOT_RANGE = /HelpCall_spot_range|check constraint/
const SPOT_OPEN = /its place on the picture is shown while it is open/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let other: CoreSeed
let andon: AndonSeed
let production: ProductionSeed
let people: PeopleSeed
let fx: FloorBasketsFixture

const key = (name: string): string => seedUuid(NS, name)
const companyA = key('company:A')
const companyB = key('company:B')
const siteA = key('site:A1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorAs = (workerId: string): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: workerId, siteId: siteA })
const lead = (): FactoryScope => floorAs(production.leadId)
const operator = (): FactoryScope => floorAs(production.operatorId)
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)

/** The owner, with every trigger (and so every reference check) off for one statement: a row only an upload reaches. */
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

/**
 * A file planted by the owner (every NOT NULL column named): by default an AVAILABLE JPEG photo of company A in tenant A, shared
 * with A1's floor (the floor role reads it), of bundle 2. `changes` override any column.
 */
async function plantFile(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const tenantId = (changes.tenantId as string | undefined) ?? a.tenantId
  const companyId = changes.companyId === undefined ? companyA : (changes.companyId as string | null)
  const row: Record<string, unknown> = {
    id,
    tenantId,
    companyId,
    recordType: 'Bundle',
    recordId: production.bundleIds[1],
    kind: 'PHOTO',
    originalName: 'Made-up step photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    storeAccountId: key('files:account:r2'),
    storageKey: companyId === null ? `t/${tenantId}/tenant/2026/${randomUUID()}` : `t/${tenantId}/c/${companyId}/2026/${randomUUID()}`,
    status: 'AVAILABLE',
    availableAt: new Date().toISOString(),
    visibility: ['OFFICE', 'FLOOR'],
    floorSiteId: siteA,
    priced: false,
    ...changes,
  }
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  await replica(`INSERT INTO "StoredFile" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"StoredFile", $1::jsonb)`, [JSON.stringify(row)])
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('floorbaskets2')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  other = await seedCore({ db: factory, namespace: `${NS}-other` })
  andon = await seedAndon({ db: factory, namespace: NS })
  production = andon.production
  people = await seedPeople({ db: factory, namespace: NS })
  fx = await seedFloorBaskets({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('BasketFlag — "Do this first" (factory_basket_flag_guard, BasketFlag_one_open)', () => {
  const flagRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: companyA,
    siteId: siteA,
    workOrderId: production.workOrderId,
    bundleId: production.bundleIds[1],
    kind: 'FIRST',
    setByWorkerId: production.leadId,
    employeeId: people.employeeIds.e2,
    deviceId: production.deviceId,
    clientEventId: tag('flag'),
    ...extra,
  })
  const CLEAR = `"clearedAt" = now(), "clearedByWorkerId" = $2::uuid, version = version + 1`

  it('the fixture: bundle 1 is marked, open, and the floor and the office read it', async () => {
    const seen = await as(lead(), (client) => client.basketFlag.findMany({ where: { id: fx.ids.flag }, select: { bundleId: true, clearedAt: true } }))
    expect(seen).toEqual([{ bundleId: fx.bundleIds[0], clearedAt: null }])
    expect(await as(office(), (client) => client.basketFlag.count({ where: { id: fx.ids.flag } }))).toBe(1)
  })

  it('set → cleared once → a second clear refused; a cleared mark never changes; a new mark after it is a new row', async () => {
    const row = flagRow()
    expect(await insert(lead(), 'BasketFlag', row)).toBe(1)
    // Two open FIRST marks on one basket: refused (one open mark per basket and kind).
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow()))).toMatch(UNIQUE)
    expect(await update(lead(), 'BasketFlag', row.id as string, CLEAR, production.leadId)).toBe(1)
    expect(await admin(`SELECT "clearedAt" IS NOT NULL AS cleared, "clearedByWorkerId"::text AS who, version FROM "BasketFlag" WHERE id = $1::uuid`, [row.id])).toEqual([
      { cleared: true, who: production.leadId, version: 2 },
    ])
    // Cleared once: a second clear, or any change, refused.
    expect(await refusalOf(update(lead(), 'BasketFlag', row.id as string, CLEAR, production.leadId))).toMatch(FLAG_CLEARED)
    expect(await refusalOf(update(lead(), 'BasketFlag', row.id as string, `"clearedAt" = NULL, "clearedByWorkerId" = NULL, version = version + 1`))).toMatch(FLAG_CLEARED)
    // The cleared mark frees the basket: a new mark is a new row.
    const again = flagRow()
    expect(await insert(lead(), 'BasketFlag', again)).toBe(1)
    expect(await update(lead(), 'BasketFlag', again.id as string, CLEAR, production.leadId)).toBe(1)
  })

  it('an open mark is only cleared: nothing else changes, a clear names when (not before it was set), the version moves by one', async () => {
    const row = flagRow()
    expect(await insert(lead(), 'BasketFlag', row)).toBe(1)
    const id = row.id as string
    expect(await refusalOf(update(lead(), 'BasketFlag', id, `"setAt" = "setAt" - interval '1 hour', version = version + 1`))).toMatch(FLAG_ONCE)
    expect(await refusalOf(update(lead(), 'BasketFlag', id, `"clearedByWorkerId" = $2::uuid, version = version + 1`, production.leadId))).toMatch(FLAG_ONCE)
    expect(await refusalOf(update(lead(), 'BasketFlag', id, `"clearedAt" = now(), "bundleId" = $2::uuid, version = version + 1`, production.bundleIds[0]))).toMatch(/only cleared|_fkey|foreign key|duplicate key|unique/i)
    expect(await refusalOf(update(lead(), 'BasketFlag', id, `"clearedAt" = "setAt" - interval '1 minute', version = version + 1`))).toMatch(FLAG_ONCE)
    expect(await refusalOf(update(lead(), 'BasketFlag', id, `"clearedAt" = now(), version = version + 5`))).toMatch(FLAG_ONCE)
    // Cleared at a station-only site: nobody named, only the time.
    expect(await update(lead(), 'BasketFlag', id, `"clearedAt" = now(), version = version + 1`)).toBe(1)
  })

  it('born open at version 1, on a basket of its work order; a client event id not blank; once per device, event and basket', async () => {
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow({ clearedAt: new Date().toISOString() })))).toMatch(FLAG_NEW)
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow({ clearedByWorkerId: production.leadId })))).toMatch(FLAG_NEW)
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow({ version: 2 })))).toMatch(FLAG_NEW)
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow({ bundleId: randomUUID() })))).toMatch(FLAG_BASKET)
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow({ clientEventId: '  ' })))).toMatch(/names a client event id that is not blank/)
    // One event marks several baskets: the key names the basket, so the same event on the same basket is refused.
    const event = tag('flag-event')
    const row = flagRow({ clientEventId: event })
    expect(await insert(lead(), 'BasketFlag', row)).toBe(1)
    expect(await update(lead(), 'BasketFlag', row.id as string, CLEAR, production.leadId)).toBe(1)
    expect(await refusalOf(insert(lead(), 'BasketFlag', flagRow({ clientEventId: event })))).toMatch(UNIQUE)
  })

  it('never deleted, never truncated; the office reads the marks and writes none', async () => {
    expect(await refusalOf(remove(lead(), 'BasketFlag', fx.ids.flag))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "BasketFlag" WHERE id = $1::uuid`, [fx.ids.flag])).rejects.toThrow(FLAG_KEPT)
    await expect(admin(`TRUNCATE "BasketFlag"`)).rejects.toThrow(TRUNCATE('BasketFlag'))
    expect(await refusalOf(insert(office(), 'BasketFlag', flagRow({ setByWorkerId: null, employeeId: null, deviceId: null, setByUserId: a.actorId })))).toMatch(DENIED)
    expect(await refusalOf(update(office(), 'BasketFlag', fx.ids.flag, `"clearedAt" = now(), "clearedByUserId" = $2::uuid, version = version + 1`, a.actorId))).toMatch(DENIED)
    expect(await admin(`SELECT "clearedAt" FROM "BasketFlag" WHERE id = $1::uuid`, [fx.ids.flag])).toEqual([{ clearedAt: null }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('FloorSuggestion — "Tell the office" (append-only, factory_floor_suggestion_check)', () => {
  const suggestionRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: companyA,
    siteId: siteA,
    kind: 'WRONG',
    words: 'Made-up: the light over table 3 flickers.',
    clientEventId: tag('say'),
    ...extra,
  })
  const named = { workerId: production.operatorId, employeeId: people.employeeIds.e1, deviceId: production.deviceId }

  it('the floor sends one with or without its name and never reads one back; the office reads them', async () => {
    const anonymous = suggestionRow({ kind: 'THANKS', words: null })
    expect(await insert(operator(), 'FloorSuggestion', anonymous)).toBe(1)
    const withName = suggestionRow({ kind: 'IDEA', ...named })
    expect(await insert(operator(), 'FloorSuggestion', withName)).toBe(1)
    await expect(as(operator(), (client) => client.$queryRawUnsafe(`SELECT id FROM "FloorSuggestion" LIMIT 1`))).rejects.toThrow(DENIED)
    const read = await as(office(), (client) =>
      client.floorSuggestion.findMany({ where: { id: { in: [anonymous.id as string, withName.id as string, fx.ids.suggestion] } }, select: { id: true, workerId: true, deviceId: true } }),
    )
    expect(read.find((row) => row.id === anonymous.id)).toEqual({ id: anonymous.id, workerId: null, deviceId: null })
    expect(read.find((row) => row.id === withName.id)).toEqual({ id: withName.id, workerId: production.operatorId, deviceId: production.deviceId })
    expect(read.find((row) => row.id === fx.ids.suggestion)).toEqual({ id: fx.ids.suggestion, workerId: null, deviceId: null })
  })

  it('without a name it names no employee and no device (a PHONE is one person\'s own)', async () => {
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ deviceId: production.deviceId })))).toMatch(NAMELESS)
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ employeeId: people.employeeIds.e1 })))).toMatch(NAMELESS)
  })

  it('words of 1 to 1000, not blank, or none; a client event id once per tenant, not blank', async () => {
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ words: '   ' })))).toMatch(WORDS)
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ words: 'x'.repeat(1001) })))).toMatch(WORDS)
    expect(await insert(operator(), 'FloorSuggestion', suggestionRow({ words: 'y'.repeat(1000) }))).toBe(1)
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ clientEventId: ' ' })))).toMatch(/names a client event id that is not blank/)
    const event = tag('say-event')
    expect(await insert(operator(), 'FloorSuggestion', suggestionRow({ clientEventId: event }))).toBe(1)
    // Resent (from the same device or, named, from any): made once.
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ clientEventId: event, ...named })))).toMatch(UNIQUE)
  })

  it('the voice note: an AUDIO file the floor can open, of its company or the whole factory, neither deleted nor quarantined', async () => {
    const audio = { kind: 'AUDIO', contentType: 'audio/webm', originalName: 'Made-up voice note.webm' }
    expect(await insert(operator(), 'FloorSuggestion', suggestionRow({ words: null, voiceFileId: await plantFile(audio) }))).toBe(1)
    expect(await insert(operator(), 'FloorSuggestion', suggestionRow({ words: null, voiceFileId: await plantFile({ ...audio, companyId: null }) }))).toBe(1)
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ voiceFileId: await plantFile() })))).toMatch(VOICE_KIND)
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ voiceFileId: await plantFile({ ...audio, status: 'QUARANTINED', quarantineReason: 'scan_pending' }) })))).toMatch(VOICE_KIND)
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ voiceFileId: await plantFile({ ...audio, companyId: companyB }) })))).toMatch(VOICE_KIND)
    // Office only: the floor cannot open it.
    expect(await refusalOf(insert(operator(), 'FloorSuggestion', suggestionRow({ voiceFileId: await plantFile({ ...audio, visibility: ['OFFICE'], floorSiteId: null }) })))).toMatch(VOICE_OPEN)
  })

  it('append-only: no update or delete grant, and the triggers refuse UPDATE, DELETE and TRUNCATE for every login', async () => {
    expect(await refusalOf(update(operator(), 'FloorSuggestion', fx.ids.suggestion, `words = 'x'`))).toMatch(DENIED)
    expect(await refusalOf(update(office(), 'FloorSuggestion', fx.ids.suggestion, `words = 'x'`))).toMatch(DENIED)
    expect(await refusalOf(remove(office(), 'FloorSuggestion', fx.ids.suggestion))).toMatch(DENIED)
    await expect(admin(`UPDATE "FloorSuggestion" SET words = 'x' WHERE id = $1::uuid`, [fx.ids.suggestion])).rejects.toThrow(APPEND_ONLY('UPDATE', 'FloorSuggestion'))
    await expect(admin(`DELETE FROM "FloorSuggestion" WHERE id = $1::uuid`, [fx.ids.suggestion])).rejects.toThrow(APPEND_ONLY('DELETE', 'FloorSuggestion'))
    await expect(admin(`TRUNCATE "FloorSuggestion"`)).rejects.toThrow(APPEND_ONLY('TRUNCATE', 'FloorSuggestion'))
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('OperationChecklistResult.fileId — the quality step photo (factory_operation_checklist_photo_check)', () => {
  const tickRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    siteId: siteA,
    workOrderId: production.workOrderId,
    workOrderOperationId: production.operationIds.sew,
    bundleId: production.bundleIds[1],
    stepCode: 'PHOTO_FRONT',
    outcome: 'DONE',
    workerId: production.operatorId,
    employeeId: people.employeeIds.e1,
    deviceId: production.deviceId,
    clientEventId: tag('tick'),
    createdById: production.operatorId,
    ...extra,
  })

  it('a photo the floor can open, written with its tick; of the work order\'s company or the whole factory; then never changed', async () => {
    const row = tickRow({ fileId: await plantFile() })
    expect(await insert(operator(), 'OperationChecklistResult', row)).toBe(1)
    expect(await insert(operator(), 'OperationChecklistResult', tickRow({ fileId: await plantFile({ companyId: null }) }))).toBe(1)
    // A tick with no photo, as before.
    expect(await insert(operator(), 'OperationChecklistResult', tickRow({ stepCode: 'TRIM_THREADS' }))).toBe(1)
    expect(await refusalOf(insert(operator(), 'OperationChecklistResult', tickRow({ fileId: await plantFile({ companyId: companyB }) })))).toMatch(PHOTO_COMPANY)
    // Append-only as before: the photo is never added or swapped later.
    await expect(admin(`UPDATE "OperationChecklistResult" SET "fileId" = NULL WHERE id = $1::uuid`, [row.id])).rejects.toThrow()
  })

  it('a file of another tenant, or one the floor cannot open, is refused', async () => {
    const otherTenant = await plantFile({ tenantId: other.tenantId, companyId: other.companies[0]!.id, floorSiteId: null, visibility: ['OFFICE'], recordType: 'Company', recordId: other.companies[0]!.id })
    // (The photo's own check speaks first: no such file in this tenant for this session; else the reference refuses it.)
    expect(await refusalOf(insert(operator(), 'OperationChecklistResult', tickRow({ fileId: otherTenant })))).toMatch(/is a file this person can open|_fkey|foreign key/)
    expect(await refusalOf(insert(operator(), 'OperationChecklistResult', tickRow({ fileId: await plantFile({ visibility: ['OFFICE'], floorSiteId: null }) })))).toMatch(PHOTO_OPEN)
    expect(await refusalOf(insert(operator(), 'OperationChecklistResult', tickRow({ fileId: randomUUID() })))).toMatch(/is a file this person can open|_fkey|foreign key/)
  })

  it('an image only: never a voice note, a fiscal archive, body data, a priced file, a PDF or a design file, nor one deleted or quarantined', async () => {
    const bad: Record<string, unknown>[] = [
      { kind: 'AUDIO', contentType: 'audio/webm' },
      { kind: 'FISCAL_ARCHIVE', contentType: 'image/jpeg', storageKey: `legal/t/${a.tenantId}/2026/${randomUUID()}` },
      { category: 'MEASUREMENTS' },
      { category: 'BODY_PHOTO' },
      { category: 'MTM_PHOTO' },
      { category: 'FITTING_PHOTO' },
      { priced: true },
      { kind: 'DOCUMENT', contentType: 'application/pdf' },
      { kind: 'ATTACHMENT', contentType: 'image/vnd.adobe.photoshop' },
      { status: 'DELETED', deletedAt: new Date().toISOString() },
      { status: 'QUARANTINED', quarantineReason: 'scan_pending' },
    ]
    for (const changes of bad) {
      const fileId = await plantFile(changes)
      expect(await refusalOf(insert(operator(), 'OperationChecklistResult', tickRow({ fileId }))), JSON.stringify(changes)).toMatch(PHOTO_KIND)
    }
    expect(await insert(operator(), 'OperationChecklistResult', tickRow({ fileId: await plantFile({ contentType: 'Image/PNG; q=1' }) }))).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('HelpCall.spot — the place on the picture (HelpCall_spot_range, factory_help_call_spot_check)', () => {
  const [solvedCall, openCall] = [() => andon.callIds[0], () => andon.callIds[1]]

  it('set and changed while the call is open, 0 to 8; the call\'s guard lets the floor do it', async () => {
    expect(await update(lead(), 'HelpCall', openCall(), `spot = 4`)).toBe(1)
    expect(await update(lead(), 'HelpCall', openCall(), `spot = 0`)).toBe(1)
    expect(await update(office(), 'HelpCall', openCall(), `spot = 8`)).toBe(1)
    expect(await admin(`SELECT spot, status::text AS status FROM "HelpCall" WHERE id = $1::uuid`, [openCall()])).toEqual([{ spot: 8, status: 'SENT' }])
  })

  it('9 and -1 are refused (the CHECK constraint)', async () => {
    expect(await refusalOf(update(lead(), 'HelpCall', openCall(), `spot = 9`))).toMatch(SPOT_RANGE)
    expect(await refusalOf(update(lead(), 'HelpCall', openCall(), `spot = -1`))).toMatch(SPOT_RANGE)
    expect(await refusalOf(insert(lead(), 'HelpCall', { id: randomUUID(), siteId: siteA, typeId: andon.typeIds.teamLeader, stationId: key('site:A1:station:SEW-01'), lineId: key('site:A1:line:L1'), sentAt: new Date().toISOString(), spot: 9 }))).toMatch(SPOT_RANGE)
  })

  it('a SOLVED call keeps its place', async () => {
    expect(await refusalOf(update(lead(), 'HelpCall', solvedCall(), `spot = 3`))).toMatch(SPOT_OPEN)
    expect(await admin(`SELECT spot FROM "HelpCall" WHERE id = $1::uuid`, [solvedCall()])).toEqual([{ spot: null }])
  })
})
