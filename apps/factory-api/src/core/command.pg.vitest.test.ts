import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { fixedClock } from '@nexus/factory-domain/core/time'
import { defineMachine } from '@nexus/factory-domain/state/machine'
import {
  callerFor,
  COMMAND_SETTINGS,
  IdempotencyKeyReusedError,
  RECEIPT_TTL_MS,
  runCommand,
  StaleVersionError,
  type CommandCaller,
  type CommandSettings,
  type CommandSpec,
  type CommandTools,
  type PendingEvent,
} from './command'
import type { RequestContext } from './context'
import { ApiError, BUSY_RETRY_AFTER_SECONDS, mapError } from './errors'

/**
 * command() on the local stack: a throwaway PostgreSQL 17 database built from the migrations, the runtime login
 * factory_app through the audited pool and the scoped clients, exactly as the API runs. Fixture rows are written by the
 * admin login (a superuser, which skips row-level security). Run with
 * `node scripts/factory/run-pg-tests.mjs apps/factory-api`.
 */

const NOW = '2026-10-28T09:00:00.000Z'
const SETTINGS: CommandSettings = { ...COMMAND_SETTINGS, clock: fixedClock(NOW) }

let db: MigratedDatabase
let database: FactoryDatabase
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const plantA = newId()
const plantB = newId()
const userA = newId()
const userA2 = newId()
const operator = newId()
const device = newId()
const party = newId()
const link = newId()

const admin = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

beforeAll(async () => {
  db = await migratedDatabase('command')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const [tenantId, slug, companyId, siteId] of [
    [tenantA, 'cmd-a', companyA, plantA],
    [tenantB, 'cmd-b', companyB, plantB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-c`])
    await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $4, 'PLANT')`, [siteId, tenantId, companyId, `${slug}-p`])
  }
}, 60_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
})

/** A fresh site of tenant A (each test changes its own). */
async function newSite(tenantId = tenantA, companyId = companyA): Promise<string> {
  const id = newId()
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, 'Plant', 'PLANT')`, [
    id,
    tenantId,
    companyId,
    `S-${id.slice(-12)}`,
  ])
  return id
}
const siteRow = async (id: string) =>
  (await admin<{ name: string; version: number; status: string }>('SELECT name, version, status::text AS status FROM "Site" WHERE id = $1', [id]))[0]!
const auditRows = (where: string, values: unknown[]) => admin(`SELECT * FROM "AuditLog" WHERE ${where} ORDER BY id`, values)
const receipts = (key: string) => admin('SELECT * FROM "IdempotencyReceipt" WHERE key = $1', [key])
const key = () => `key-${randomUUID()}`

type Ctx = RequestContext
const officeA = (actorId = userA): Ctx => ({ audience: 'office', tenantId: tenantA, actorId, companyId: companyA, grants: [], requestId: newId() })
const officeB = (): Ctx => ({ audience: 'office', tenantId: tenantB, actorId: userA, grants: [], requestId: newId() })
const floorA = (siteId = plantA): Ctx => ({ audience: 'floor', tenantId: tenantA, actorId: operator, siteId, deviceId: device, grants: [], requestId: newId() })
const linkA = (record = { type: 'Quote', id: newId() }): Ctx => ({ audience: 'link', tenantId: tenantA, linkId: link, partyId: party, record, grants: [], requestId: newId() })
const as = (context: Ctx): CommandCaller => callerFor(database, context)

interface Rename {
  readonly siteId: string
  readonly name: string
  readonly version?: number
  readonly key?: string
}

/** sites.rename: the example write of command()'s doc comment. */
function rename(caller: CommandCaller, input: Rename, settings: CommandSettings = SETTINGS, more?: (tools: CommandTools) => Promise<void>) {
  const spec: CommandSpec = {
    name: 'sites.rename',
    idempotencyKey: input.key,
    input: { name: input.name },
    record: { type: 'Site', id: input.siteId, ...(input.version === undefined ? {} : { expectedVersion: input.version }) },
  }
  return runCommand(caller, spec, async (tools) => {
    const { tx, audit, record } = tools
    const before = await tx.site.findUniqueOrThrow({ where: { id: input.siteId }, select: { name: true, companyId: true } })
    await tx.site.update({ where: { id: input.siteId }, data: { name: input.name } })
    audit({ recordType: 'Site', recordId: input.siteId, companyId: before.companyId, before: { name: before.name }, after: { name: input.name } })
    await more?.(tools)
    return { id: input.siteId, name: input.name, version: record!.version }
  }, settings)
}

const siteMachine = defineMachine({
  name: 'site',
  states: ['ACTIVE', 'ARCHIVED'],
  transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] },
  guards: { ARCHIVED: (facts: { openWork: number }) => (facts.openWork === 0 ? [] : [`no open work (${facts.openWork} open)`]) },
})
type SiteState = (typeof siteMachine.states)[number]
const noOpenWork = async () => ({ openWork: 0 })

/** sites.archive (or restore): a move of the site's state machine; `facts` runs in the transaction, before the move. */
const move = (caller: CommandCaller, siteId: string, to: SiteState, facts = noOpenWork, idempotencyKey?: string) =>
  runCommand(
    caller,
    { name: 'sites.archive', idempotencyKey, input: { to }, record: { type: 'Site', id: siteId, transition: { machine: siteMachine, to, facts } } },
    async ({ audit, record }) => {
      audit({ recordType: 'Site', recordId: siteId, companyId: companyA, before: { status: record!.from }, after: { status: record!.to } })
      return { status: record!.to ?? null, version: record!.version }
    },
    SETTINGS,
  )

/** Resolves for every caller once `count` callers wait on it: holds concurrent transactions at one point. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const all = new Promise<void>((resolve) => (release = resolve))
  return () => {
    if (++arrived === count) release()
    return all
  }
}

describe('a write and its audit row', () => {
  it('commit together, with who, where, when and the before and after (PLT-072, PLT-073, PLT-084)', async () => {
    const siteId = await newSite()
    const context = officeA()
    const k = key()
    const outcome = await rename(as(context), { siteId, name: 'Renamed', version: 1, key: k })
    expect(outcome).toEqual({ result: { id: siteId, name: 'Renamed', version: 2 }, replayed: false })
    expect(await siteRow(siteId)).toMatchObject({ name: 'Renamed', version: 2 })

    const rows = await auditRows('"recordId" = $1', [siteId])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenantId: tenantA,
      companyId: companyA,
      siteId: null,
      partyId: null,
      audience: 'OFFICE',
      actorId: userA,
      deviceId: null,
      deviceTime: null,
      action: 'sites.rename',
      recordType: 'Site',
      before: { name: 'Plant' },
      after: { name: 'Renamed' },
      reason: null,
      requestId: context.requestId,
      idempotencyKey: k,
    })
    expect((rows[0]!.at as Date).toISOString()).toBe(NOW)

    const [receipt] = await receipts(k)
    expect(receipt).toMatchObject({ tenantId: tenantA, scope: 'sites.rename', actorId: userA, requestId: context.requestId, response: { result: outcome.result } })
    expect((receipt!.expiresAt as Date).getTime() - (receipt!.createdAt as Date).getTime()).toBe(RECEIPT_TTL_MS)
  })

  it('roll back together when something fails after the audit row was written: the change, the audit row and the receipt', async () => {
    const siteId = await newSite()
    const context = officeA()
    const k = key()
    const failing: CommandSettings = {
      ...SETTINGS,
      // Runs after the audit rows are inserted, inside the transaction.
      async writeEvents(tx, events) {
        expect(events).toHaveLength(1)
        expect(await tx.auditLog.count({ where: { requestId: context.requestId } })).toBe(1)
        expect((await tx.site.findUniqueOrThrow({ where: { id: siteId }, select: { name: true } })).name).toBe('Never')
        throw new Error('the event store is down')
      },
    }
    await expect(rename(as(context), { siteId, name: 'Never', version: 1, key: k }, failing, async ({ emit }) => emit({ type: 'site.renamed', subject: siteId, payload: {} }))).rejects.toThrow(
      'the event store is down',
    )
    expect(await siteRow(siteId)).toMatchObject({ name: 'Plant', version: 1 })
    expect(await auditRows('"requestId" = $1', [context.requestId])).toHaveLength(0)
    expect(await receipts(k)).toHaveLength(0)
  })

  it('roll back when the work fails, and a failed write leaves no receipt: the same key may be sent again', async () => {
    const siteId = await newSite()
    const k = key()
    await expect(
      rename(as(officeA()), { siteId, name: 'Half', version: 1, key: k }, SETTINGS, async () => {
        throw new ConflictError('a duplicate code')
      }),
    ).rejects.toThrow('a duplicate code')
    expect(await siteRow(siteId)).toMatchObject({ name: 'Plant', version: 1 })
    expect(await receipts(k)).toHaveLength(0)
    const retry = await rename(as(officeA()), { siteId, name: 'Whole', version: 1, key: k })
    expect(retry).toMatchObject({ result: { name: 'Whole', version: 2 }, replayed: false })
  })

  it('refuses a command that records no audit row (every write is audited), and rolls its change back', async () => {
    const siteId = await newSite()
    const outcome = runCommand(as(officeA()), { name: 'sites.rename', input: {}, record: { type: 'Site', id: siteId } }, async ({ tx }) => {
      await tx.site.update({ where: { id: siteId }, data: { name: 'Unaudited' } })
      return {}
    }, SETTINGS)
    await expect(outcome).rejects.toThrow(/recorded no audit row/)
    expect(await siteRow(siteId)).toMatchObject({ name: 'Plant', version: 1 })
  })

  it('refuses an answer that is not plain JSON (a replay must equal the first answer)', async () => {
    const siteId = await newSite()
    const outcome = runCommand(as(officeA()), { name: 'sites.touch', input: {}, record: { type: 'Site', id: siteId } }, async ({ audit }) => {
      audit({ recordType: 'Site', recordId: siteId })
      return { at: new Date() }
    }, SETTINGS)
    await expect(outcome).rejects.toThrow(ApiError)
    await expect(outcome).rejects.toThrow(/a Date object at result.at/)
    expect(await siteRow(siteId)).toMatchObject({ version: 1 })
  })

  it('refuses an event type the catalogue does not declare, and writes nothing', async () => {
    const siteId = await newSite()
    const context = officeA()
    await expect(
      rename(as(context), { siteId, name: 'Evented', version: 1 }, { ...SETTINGS, writeEvents: COMMAND_SETTINGS.writeEvents }, async ({ emit }) =>
        emit({ type: 'site.renamed', subject: siteId, payload: { name: 'Evented' } }),
      ),
    ).rejects.toThrow(/"site.renamed" version 1 is not declared in the event catalogue/)
    expect(await siteRow(siteId)).toMatchObject({ name: 'Plant', version: 1 })
    expect(await auditRows('"requestId" = $1', [context.requestId])).toHaveLength(0)
  })

  it('hands the emitted events to the event writer in the transaction, in order, with their envelope (the outbox seam)', async () => {
    const siteId = await newSite()
    const context = officeA()
    const seen: PendingEvent[] = []
    const settings: CommandSettings = { ...SETTINGS, writeEvents: async (_tx, events) => void seen.push(...events) }
    await rename(as(context), { siteId, name: 'Evented', version: 1 }, settings, async ({ emit }) => {
      emit({ type: 'site.renamed', subject: siteId, payload: { name: 'Evented' } })
      emit({ type: 'site.checked', version: 2, subject: siteId, payload: {}, siteId })
    })
    expect(seen.map((event) => event.type)).toEqual(['site.renamed', 'site.checked'])
    expect(seen[0]).toMatchObject({
      version: 1,
      tenantId: tenantA,
      companyId: companyA,
      siteId: null,
      subject: siteId,
      correlationId: context.requestId,
      causationId: null,
      source: 'sites.rename',
      payload: { name: 'Evented' },
    })
    expect(seen[0]!.occurredAt.toISOString()).toBe(NOW)
    expect(seen[1]).toMatchObject({ version: 2, siteId })
    expect(seen[0]!.eventId).not.toBe(seen[1]!.eventId)
  })
})

describe('idempotency keys (PLT-189)', () => {
  it('the same key twice returns the same answer and writes once', async () => {
    const siteId = await newSite()
    const k = key()
    const first = await rename(as(officeA()), { siteId, name: 'Once', version: 1, key: k })
    const again = await rename(as(officeA()), { siteId, name: 'Once', version: 1, key: k })
    expect(again).toEqual({ result: first.result, replayed: true })
    expect(await siteRow(siteId)).toMatchObject({ name: 'Once', version: 2 })
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
    expect(await receipts(k)).toHaveLength(1)
  })

  it('the same key with a different body is refused (409) and writes nothing', async () => {
    const siteId = await newSite()
    const k = key()
    await rename(as(officeA()), { siteId, name: 'First', version: 1, key: k })
    const other = rename(as(officeA()), { siteId, name: 'Second', version: 2, key: k })
    await expect(other).rejects.toThrow(IdempotencyKeyReusedError)
    await expect(other).rejects.toBeInstanceOf(ConflictError)
    expect(await siteRow(siteId)).toMatchObject({ name: 'First', version: 2 })
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
  })

  it('the same key and body from another person is a different request (refused, never their answer)', async () => {
    const siteId = await newSite()
    const k = key()
    await rename(as(officeA()), { siteId, name: 'Mine', version: 1, key: k })
    await expect(rename(as(officeA(userA2)), { siteId, name: 'Mine', version: 1, key: k })).rejects.toThrow(IdempotencyKeyReusedError)
  })

  it('is required for floor and link writes, optional for office ones (no receipt without a key)', async () => {
    const audited = (context: Ctx) =>
      runCommand(as(context), { name: 'scans.record', input: {} }, async ({ audit }) => (audit({ recordType: 'Site', recordId: plantA }), null), SETTINGS)
    await expect(audited(floorA())).rejects.toThrow(ValidationError)
    await expect(audited(linkA())).rejects.toThrow(/An Idempotency-Key is required for link writes/)
    const context = officeA()
    await expect(audited(context)).resolves.toEqual({ result: null, replayed: false })
    expect(await admin('SELECT 1 FROM "IdempotencyReceipt" WHERE "requestId" = $1', [context.requestId])).toHaveLength(0)
    await expect(runCommand(as(officeA()), { name: 'scans.record', input: {}, idempotencyKey: 'short' }, async () => null, SETTINGS)).rejects.toThrow(
      /Idempotency-Key is not valid/,
    )
  })

  it('two simultaneous requests with one key on one record: one write, and both get its answer', async () => {
    const siteId = await newSite()
    const k = key()
    // Both transactions are past the receipt check and have read the record before either moves it; the second then
    // fails on the version and answers from the first one's receipt.
    const wait = barrier(2)
    const facts = async () => (await wait(), { openWork: 0 })
    const [one, two] = await Promise.all([move(as(officeA()), siteId, 'ARCHIVED', facts, k), move(as(officeA()), siteId, 'ARCHIVED', facts, k)])
    expect(one.result).toEqual({ status: 'ARCHIVED', version: 2 })
    expect(two.result).toEqual(one.result)
    expect([one.replayed, two.replayed].sort()).toEqual([false, true])
    expect(await siteRow(siteId)).toMatchObject({ status: 'ARCHIVED', version: 2 })
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
  })

  it('two simultaneous creates with one key: the second fails on the receipt and answers with the first one', async () => {
    const k = key()
    const recordId = newId()
    // Both transactions are past the receipt check before either writes one.
    const wait = barrier(2)
    const create = () =>
      runCommand(as(floorA()), { name: 'scans.record', idempotencyKey: k, input: { bundle: 7 } }, async ({ audit }) => {
        await wait()
        audit({ recordType: 'OperationScan', recordId })
        return { scan: recordId }
      }, SETTINGS)
    const [one, two] = await Promise.all([create(), create()])
    expect(one.result).toEqual({ scan: recordId })
    expect(two.result).toEqual({ scan: recordId })
    expect([one.replayed, two.replayed].sort()).toEqual([false, true])
    expect(await auditRows('"recordId" = $1', [recordId])).toHaveLength(1)
    expect(await receipts(k)).toHaveLength(1)
  })
})

describe('the edit-conflict guard (COL-078)', () => {
  it('a stale version is refused (409) with the current version, and nothing is written', async () => {
    const siteId = await newSite()
    await rename(as(officeA()), { siteId, name: 'Newer', version: 1 })
    const stale = rename(as(officeA()), { siteId, name: 'Older', version: 1 })
    await expect(stale).rejects.toBeInstanceOf(ConflictError)
    await expect(stale).rejects.toMatchObject({ name: 'StaleVersionError', code: 'conflict', currentVersion: 2, issues: [{ path: 'version', message: 'The current version is 2.' }] })
    expect(await siteRow(siteId)).toMatchObject({ name: 'Newer', version: 2 })
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
  })

  it('a missing record is a 404, also another tenant\'s (row-level security hides it)', async () => {
    await expect(rename(as(officeA()), { siteId: newId(), name: 'Nobody', version: 1 })).rejects.toThrow(NotFoundError)
    await expect(rename(as(officeB()), { siteId: plantA, name: 'Theirs', version: 1 })).rejects.toThrow(NotFoundError)
    expect(await siteRow(plantA)).toMatchObject({ version: 1 })
  })
})

describe('state guards (PLT-097, PLT-033)', () => {
  it('an allowed move is written by command(), with the version, and audited', async () => {
    const siteId = await newSite()
    await expect(move(as(officeA()), siteId, 'ARCHIVED')).resolves.toEqual({ result: { status: 'ARCHIVED', version: 2 }, replayed: false })
    expect(await siteRow(siteId)).toMatchObject({ status: 'ARCHIVED', version: 2 })
    expect((await auditRows('"recordId" = $1', [siteId]))[0]).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
  })

  it('a move the machine does not allow is refused (409 invalid_state), and nothing is written', async () => {
    const siteId = await newSite()
    await move(as(officeA()), siteId, 'ARCHIVED')
    const again = move(as(officeA()), siteId, 'ARCHIVED')
    await expect(again).rejects.toBeInstanceOf(InvalidStateError)
    await expect(again).rejects.toThrow('A site in ARCHIVED cannot move to ARCHIVED (from ARCHIVED it can go to ACTIVE).')
    expect(await siteRow(siteId)).toMatchObject({ status: 'ARCHIVED', version: 2 })
  })

  it('a guard that finds something missing says what, and nothing is written', async () => {
    const siteId = await newSite()
    const refused = move(as(officeA()), siteId, 'ARCHIVED', async () => ({ openWork: 3 }))
    await expect(refused).rejects.toMatchObject({ code: 'invalid_state', issues: [{ path: 'state', message: 'no open work (3 open)' }] })
    expect(await siteRow(siteId)).toMatchObject({ status: 'ACTIVE', version: 1 })
  })

  it('two simultaneous moves of one record: one is written, the other fails on the version (compare-and-set)', async () => {
    const siteId = await newSite()
    // Both commands read the record (ACTIVE, version 1) before either bumps the version.
    const wait = barrier(2)
    const facts = async () => (await wait(), { openWork: 0 })
    const results = await Promise.allSettled([move(as(officeA()), siteId, 'ARCHIVED', facts), move(as(officeA()), siteId, 'ARCHIVED', facts)])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    expect(refused.reason).toBeInstanceOf(StaleVersionError)
    expect(await siteRow(siteId)).toMatchObject({ status: 'ARCHIVED', version: 2 })
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
  })
})

describe('audiences', () => {
  it('a floor write is audited with the device, its site and the device time; the floor reads no audit row', async () => {
    const k = key()
    const context = floorA()
    const deviceTime = new Date('2026-10-28T08:59:58.000Z')
    const recordId = newId()
    await runCommand(as(context), { name: 'scans.record', idempotencyKey: k, input: {}, deviceTime }, async ({ audit }) => {
      audit({ recordType: 'OperationScan', recordId, after: { qty: '12' } })
      return { ok: true }
    }, SETTINGS)
    const [row] = await auditRows('"requestId" = $1', [context.requestId])
    expect(row).toMatchObject({ audience: 'FLOOR', actorId: operator, deviceId: device, siteId: plantA, companyId: null, idempotencyKey: k })
    expect((row!.deviceTime as Date).toISOString()).toBe(deviceTime.toISOString())
    expect(await receipts(k)).toMatchObject([{ siteId: plantA, partyId: null }])
    await expect(database.withScope({ audience: 'floor', tenantId: tenantA, actorId: operator, siteId: plantA }, (client) => client.auditLog.count())).rejects.toThrow(
      /permission denied/,
    )
  })

  it('a floor audit row for another site than the device\'s is refused', async () => {
    const outcome = runCommand(as(floorA()), { name: 'scans.record', idempotencyKey: key(), input: {} }, async ({ audit }) => {
      audit({ recordType: 'OperationScan', recordId: newId(), siteId: plantB })
      return null
    }, SETTINGS)
    await expect(outcome).rejects.toThrow(/another site/)
  })

  it('a link write is audited as the link (its token row and party); it may change only its own record', async () => {
    const quote = { type: 'Quote', id: newId() }
    const context = linkA(quote)
    const k = key()
    await runCommand(as(context), { name: 'quotes.accept', idempotencyKey: k, input: { typedName: 'A Buyer' } }, async ({ audit }) => {
      audit({ recordType: 'Quote', recordId: quote.id, after: { status: 'ACCEPTED' } })
      return { accepted: true }
    }, SETTINGS)
    expect((await auditRows('"requestId" = $1', [context.requestId]))[0]).toMatchObject({ audience: 'LINK', actorId: link, partyId: party, siteId: null })
    expect(await receipts(k)).toMatchObject([{ partyId: party, siteId: null }])
    const other = runCommand(as(linkA(quote)), { name: 'sites.rename', idempotencyKey: key(), input: {}, record: { type: 'Site', id: plantA } }, async () => null, SETTINGS)
    await expect(other).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a platform context cannot write through command() (it has no tenant to audit in)', async () => {
    const platform: Ctx = { audience: 'platform', actorId: userA, grants: [], requestId: newId() }
    await expect(runCommand(as(platform), { name: 'tenants.create', input: {} }, async () => null, SETTINGS)).rejects.toThrow(/needs a tenant/)
  })
})

describe('append-only ledgers (A1 §2.1)', () => {
  const office = { audience: 'office', tenantId: tenantA, actorId: userA } as const

  it('the runtime roles cannot update or delete audit rows or receipts', async () => {
    const siteId = await newSite()
    await rename(as(officeA()), { siteId, name: 'Kept', version: 1, key: key() })
    for (const table of ['AuditLog', 'IdempotencyReceipt']) {
      await expect(database.withScope(office, (client) => client.$executeRawUnsafe(`UPDATE "${table}" SET "requestId" = 'x'`))).rejects.toThrow(/permission denied/)
      await expect(database.withScope(office, (client) => client.$executeRawUnsafe(`DELETE FROM "${table}"`))).rejects.toThrow(/permission denied/)
    }
    await expect(database.withScope(office, (client) => client.auditLog.deleteMany({}))).rejects.toThrow(/permission denied/)
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
  })

  it('the triggers refuse UPDATE, DELETE and TRUNCATE even to the owner and a superuser (the test admin)', async () => {
    const siteId = await newSite()
    await rename(as(officeA()), { siteId, name: 'Kept', version: 1, key: key() })
    for (const table of ['AuditLog', 'IdempotencyReceipt']) {
      await expect(admin(`UPDATE "${table}" SET "requestId" = 'x'`)).rejects.toThrow(/append-only: UPDATE/)
      await expect(admin(`DELETE FROM "${table}"`)).rejects.toThrow(/append-only: DELETE/)
      await expect(admin(`TRUNCATE "${table}"`)).rejects.toThrow(/append-only: TRUNCATE/)
    }
    expect(await auditRows('"recordId" = $1', [siteId])).toHaveLength(1)
  })

  it('an expired receipt, and only an expired one, may be purged by the owner', async () => {
    const expired = newId()
    await admin(
      `INSERT INTO "IdempotencyReceipt" (id, "tenantId", scope, key, "requestHash", response, "actorId", "requestId", "createdAt", "expiresAt")
       VALUES ($1, $2, 'sites.rename', $3, 'h', '{}', $4, 'r', now() - interval '31 days', now() - interval '1 day')`,
      [expired, tenantA, key(), userA],
    )
    await expect(admin('DELETE FROM "IdempotencyReceipt" WHERE id = $1 RETURNING id', [expired])).resolves.toEqual([{ id: expired }])
    await expect(admin(`UPDATE "IdempotencyReceipt" SET "expiresAt" = now() - interval '1 day'`)).rejects.toThrow(/append-only/)
  })
})

describe('a busy database (B-W2b-F2): Prisma\'s own errors, answered 503 "busy, try again", never 500', () => {
  const busy = { status: 503, code: 'not_ready', message: 'The factory is busy. Try again in a moment.', unexpected: false, retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS }

  it('no pool connection within maxWait: P2028, nothing written; the command holding the connection still commits', async () => {
    const small = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 1 } })
    try {
      const holding = await newSite()
      const waiting = await newSite()
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      let entered!: () => void
      const inside = new Promise<void>((resolve) => (entered = resolve))
      const holder = rename(callerFor(small, officeA()), { siteId: holding, name: 'Holder', key: key() }, SETTINGS, async () => {
        entered()
        await held
      })
      await inside
      const error = await rename(callerFor(small, officeA()), { siteId: waiting, name: 'Waiting', key: key() }, { ...SETTINGS, maxWaitMs: 200 }).then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toMatchObject({ name: 'PrismaClientKnownRequestError', code: 'P2028' })
      expect(mapError(error)).toEqual(busy)
      release()
      await expect(holder).resolves.toMatchObject({ replayed: false })
      expect(await siteRow(holding)).toMatchObject({ name: 'Holder', version: 2 })
      expect(await siteRow(waiting)).toMatchObject({ name: 'Plant', version: 1 })
    } finally {
      await small.close()
    }
  })

  it('a command that outlives its timeout: P2028 (expired), rolled back, no audit row, no receipt', async () => {
    const siteId = await newSite()
    const context = officeA()
    const k = key()
    const error = await rename(as(context), { siteId, name: 'Slow', key: k }, { ...SETTINGS, timeoutMs: 200 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    }).then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(error).toMatchObject({ name: 'PrismaClientKnownRequestError', code: 'P2028' })
    expect(mapError(error)).toEqual(busy)
    expect(await siteRow(siteId)).toMatchObject({ name: 'Plant', version: 1 })
    expect(await auditRows('"requestId" = $1', [context.requestId])).toEqual([])
    expect(await receipts(k)).toEqual([])
  })
})
