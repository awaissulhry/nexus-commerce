import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Job } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { localFileStore } from '../../adapters/local-files/local'
import { fakePrintRelay, type FakePrintRelay } from '../../adapters/print-relay/fake'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { storeDocumentPdf } from '../documents/documents'
import { pdfFlatText } from '../documents/testing/pdf-text'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../files/service'
import { createGateway } from '../gateway/gateway'
import { runHandler } from '../outbox/dispatch'
import { systemContext } from '../outbox/system'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { printDispatchHandler } from './handler'
import { applyRelayReport, dispatchJob, PrintRetryError } from './jobs'
import { printRelays, usePrintRelays } from './service'

/**
 * The print path on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login through the scoped clients, so row-level security and the …_print_guards triggers are
 * real), the worker's print.dispatch handler run the way the event-handlers queue runs it, and the FAKE relay, which
 * records jobs and sends nothing. Every name and code is made up. Run with `node scripts/factory/run-pg-tests.mjs print`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let relay: FakePrintRelay

const tenantA = newId()
const tenantB = newId()
const company = newId()
const companyB = newId()
const siteOne = newId()
const siteTwo = newId()
const siteB = newId()
const user = newId()
const operator = newId()
const device = newId()
const TAG = tenantTag(tenantA)
let ref = 100

const grant = (permissions: Grant['permissions'], sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies: 'all', sites, parties: 'all' })
const PRINTING = ['print.view', 'print.labels', 'print.documents', 'files.read'] as const
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant([...PRINTING, 'print.manage'])] },
  printer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(PRINTING)] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['print.view'])] },
  'site-two': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(PRINTING, [siteTwo])] },
  'floor-one': { audience: 'floor', tenantId: tenantA, actorId: operator, siteId: siteOne, deviceId: device, grants: [grant(['print.view', 'print.labels'])] },
  'admin-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant([...PRINTING, 'print.manage'])] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (tenantId = tenantA) => callerFor(database, systemContext(tenantId, newId()))
const scanId = (type: 'HIDE' | 'BUNDLE' | 'LOT' | 'CARTON' = 'HIDE', tag = TAG) => formatScanId({ type, tenantTag: tag, ref: ++ref })
const label = (fields: Json = {}) => ({ kind: 'HIDE', language: 'it', scanId: scanId(), maker: 'Seed', title: 'Nappa 1.2 nero', fields: { colour: 'Nero', grade: 'A' }, ...fields })

async function createPrinter(session: string, body: Json): Promise<Json> {
  const response = await call(session, 'POST', '/print/printers', body)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().printer
}
async function queueLabel(session: string, printerId: string, fields: Json = {}, key?: string): Promise<Json> {
  const response = await call(session, 'POST', '/print/jobs/label', { printerId, recordType: 'Hide', recordId: newId(), label: label(), ...fields }, key)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().job
}
const jobRow = async (jobId: string) => (await admin('SELECT status, attempts, "lastError", "relayJobId", "sentAt", "printedAt", "failedAt" FROM "PrintJob" WHERE id = $1', [jobId]))[0]!

/** The latest print.job_queued event of a job, as the outbox relay publishes it. */
async function queuedEvent(jobId: string): Promise<EventEnvelope> {
  const [row] = await admin(
    `SELECT id, type, version, context, "tenantId", "companyId", "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload
       FROM "OutboxEvent" WHERE type = 'print.job_queued' AND subject = $1 ORDER BY "occurredAt" DESC, id DESC LIMIT 1`,
    [jobId],
  )
  return {
    eventId: row!.id,
    type: row!.type,
    version: row!.version,
    context: row!.context,
    tenantId: row!.tenantId,
    companyId: row!.companyId,
    siteId: row!.siteId,
    subject: row!.subject,
    correlationId: row!.correlationId,
    causationId: row!.causationId,
    source: row!.source,
    occurredAt: (row!.occurredAt as Date).toISOString(),
    payload: row!.payload,
  }
}
/** One try of the worker's print.dispatch handler job, exactly as the event-handlers queue runs it. */
const handle = async (jobId: string, attemptsMade = 0) =>
  runHandler({ name: 'print.dispatch', data: await queuedEvent(jobId), attemptsMade } as Job<EventEnvelope>, [printDispatchHandler({ files: () => files })], database)

let labelPrinter: Json
let a4Printer: Json
let siteTwoPrinter: Json

beforeAll(async () => {
  db = await migratedDatabase('print')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-print-test-'))
  for (const [tenantId, slug, companyId, sites] of [
    [tenantA, 'print-a', company, [siteOne, siteTwo]],
    [tenantB, 'print-b', companyB, [siteB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin(
      `INSERT INTO "Company" (id, "tenantId", code, "legalName", address, "vatNumber", "fiscalCode", "reaOffice", "reaNumber")
       VALUES ($1, $2, $3, 'Pelletteria Fittizia S.r.l.', '{"line1":"Via dei Conciatori Finti 1","postalCode":"20121","city":"Milano","country":"IT"}', 'IT12345670009', '12345670009', 'MI', '0000001')`,
      [companyId, tenantId, slug],
    )
    for (const [index, siteId] of sites.entries()) {
      await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $4, 'PLANT')`, [siteId, tenantId, companyId, `${slug}-${index}`])
    }
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  relay = fakePrintRelay({ environment: 'test' })
  usePrintRelays(printRelays({ FAKE: relay }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
  labelPrinter = await createPrinter('admin', { siteId: siteOne, code: 'LBL-RECV', name: 'Receiving labels', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'label-printer-1:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 50 })
  a4Printer = await createPrinter('admin', { siteId: siteOne, code: 'A4-OFFICE', name: 'Office printer', kind: 'A4_PDF', relay: 'FAKE', relayTarget: 'office-printer' })
  siteTwoPrinter = await createPrinter('admin', { siteId: siteTwo, code: 'LBL-CUT', name: 'Cutting labels', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'label-printer-2:9100', dpi: 300, labelWidthMm: 100, labelHeightMm: 50 })
}, 60_000)

beforeEach(() => {
  // The fake relay keeps its jobs for the whole file; each test reads only its own.
  relay.failNext(0)
})

afterAll(async () => {
  usePrintRelays(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('printers', () => {
  it('are added per site by print.manage, audited, and checked: label stock, A4 without stock, a unique code', async () => {
    expect(labelPrinter).toMatchObject({ companyId: company, siteId: siteOne, kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'label-printer-1:9100', dpi: 203, status: 'ACTIVE', version: 1 })
    const [audit] = await admin('SELECT action, "siteId", after FROM "AuditLog" WHERE "recordId" = $1', [labelPrinter.id])
    expect(audit).toMatchObject({ action: 'print.createPrinter', siteId: siteOne, after: { code: 'LBL-RECV', kind: 'LABEL_ZPL' } })

    const base = { siteId: siteOne, code: 'LBL-2', name: 'x', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'x:9100', dpi: 150, labelWidthMm: 100, labelHeightMm: 50 }
    expect((await call('admin', 'POST', '/print/printers', base)).json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/dpi'])
    expect((await call('admin', 'POST', '/print/printers', { ...base, kind: 'A4_PDF', dpi: 300 })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/print/printers', { ...base, dpi: 203, code: 'LBL-RECV' })).statusCode).toBe(409)
    expect((await call('printer', 'POST', '/print/printers', { ...base, dpi: 203 })).statusCode).toBe(403)
  })

  it('are listed by site: a floor device sees its own site\'s printers and not where the relay reaches them', async () => {
    const office = (await call('viewer', 'GET', '/print/printers')).json().printers as Json[]
    expect(office.map((printer) => printer.code).sort()).toEqual(['A4-OFFICE', 'LBL-CUT', 'LBL-RECV'])
    const floor = (await call('floor-one', 'GET', '/print/printers')).json().printers as Json[]
    expect(floor.map((printer) => printer.code).sort()).toEqual(['A4-OFFICE', 'LBL-RECV'])
    expect(floor.every((printer) => !('relayTarget' in printer))).toBe(true)
    expect((await call('site-two', 'GET', '/print/printers')).json().printers.map((printer: Json) => printer.code)).toEqual(['LBL-CUT'])
  })

  it('are paused, refused jobs while paused, and active again (compare-and-set on the version)', async () => {
    const paused = await call('admin', 'PATCH', `/print/printers/${siteTwoPrinter.id}`, { version: siteTwoPrinter.version, status: 'PAUSED' })
    expect(paused.statusCode, paused.body).toBe(200)
    const refused = await call('site-two', 'POST', '/print/jobs/label', { printerId: siteTwoPrinter.id, recordType: 'Hide', recordId: newId(), label: label() })
    expect(refused.statusCode).toBe(409)
    expect((await call('admin', 'PATCH', `/print/printers/${siteTwoPrinter.id}`, { version: siteTwoPrinter.version, status: 'ACTIVE' })).statusCode).toBe(409)
    const active = await call('admin', 'PATCH', `/print/printers/${siteTwoPrinter.id}`, { version: paused.json().printer.version, status: 'ACTIVE' })
    expect(active.json().printer).toMatchObject({ status: 'ACTIVE', version: siteTwoPrinter.version + 2 })
  })
})

describe('label jobs: ZPL with the scannable id (GAP-007, PLT-126)', () => {
  it('queues a label as ZPL whose Code 128 barcode (^BC) and text carry the scannable id, with its audit row and event', async () => {
    const code = scanId('HIDE')
    const job = await queueLabel('printer', labelPrinter.id, { copies: 3, label: label({ scanId: code.toLowerCase() }) })
    expect(job).toMatchObject({ status: 'QUEUED', payloadKind: 'ZPL', labelKind: 'HIDE', scanId: code, copies: 3, attempts: 0, siteId: siteOne, requestedById: user, deviceId: null })
    const one = (await call('viewer', 'GET', `/print/jobs/${job.id}`)).json().job
    expect(one.zpl).toContain(`^BCN,80,N,N,N^FD${code}^FS`)
    expect(one.zpl).toContain(`^FH^FD${code}^FS`)
    expect(one.zpl).toContain('^PQ3\n^XZ')
    expect(await admin('SELECT action FROM "AuditLog" WHERE "recordId" = $1', [job.id])).toEqual([{ action: 'print.queue' }])
    expect(await admin('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1', [job.id])).toEqual([
      { type: 'print.job_queued', payload: { jobId: job.id, printerId: labelPrinter.id, payloadKind: 'ZPL' } },
    ])
  })

  it('refuses another factory\'s code, a code of another kind, and a label printer for a PDF or an A4 printer for a label', async () => {
    const foreign = await call('printer', 'POST', '/print/jobs/label', { printerId: labelPrinter.id, recordType: 'Hide', recordId: newId(), label: label({ scanId: scanId('HIDE', tenantTag(tenantB)) }) })
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().error.issues[0].message).toMatch(/another factory/)
    const wrongKind = await call('printer', 'POST', '/print/jobs/label', { printerId: labelPrinter.id, recordType: 'Hide', recordId: newId(), label: label({ scanId: scanId('BUNDLE') }) })
    expect(wrongKind.statusCode).toBe(400)
    expect((await call('printer', 'POST', '/print/jobs/label', { printerId: a4Printer.id, recordType: 'Hide', recordId: newId(), label: label() })).statusCode).toBe(400)
    expect((await call('viewer', 'POST', '/print/jobs/label', { printerId: labelPrinter.id, recordType: 'Hide', recordId: newId(), label: label() })).statusCode).toBe(403)
  })
})

describe('the worker hands jobs to the relay (QUEUED → SENT → PRINTED)', () => {
  it('goes QUEUED → SENT through the fake relay with retries, counting each try, and sends it once', async () => {
    const job = await queueLabel('printer', labelPrinter.id)
    relay.failNext(2, { message: 'The fake relay is busy.' })
    await expect(handle(job.id, 0)).rejects.toBeInstanceOf(PrintRetryError)
    expect(await jobRow(job.id)).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'The fake relay is busy.' })
    await expect(handle(job.id, 1)).rejects.toBeInstanceOf(PrintRetryError)
    expect(await jobRow(job.id)).toMatchObject({ status: 'QUEUED', attempts: 2 })
    await handle(job.id, 2)
    const sent = await jobRow(job.id)
    expect(sent).toMatchObject({ status: 'SENT', attempts: 3, lastError: null })
    expect(sent.sentAt).not.toBeNull()
    const taken = relay.jobs.filter((entry) => entry.job.jobId === job.id)
    expect(taken).toHaveLength(1)
    expect(taken[0]!.job).toMatchObject({ tenantId: tenantA, siteId: siteOne, copies: 1, printer: { code: 'LBL-RECV', kind: 'LABEL_ZPL', target: 'label-printer-1:9100' }, payload: { kind: 'ZPL' } })
    expect((taken[0]!.job.payload as { zpl: string }).zpl).toContain(`^FD${job.scanId}^FS`)
    expect(sent.relayJobId).toBe(taken[0]!.relayJobId)

    // A repeated event finds the job SENT and does nothing; the relay is not called again.
    const attempts = relay.attempts.length
    await handle(job.id, 0)
    expect(relay.attempts).toHaveLength(attempts)

    const actions = await admin<{ action: string; audience: string }>('SELECT action, audience FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [job.id])
    expect(actions.map((row) => row.action)).toEqual(['print.queue', 'print.recordAttempt', 'print.recordAttempt', 'print.markSent'])
    expect(actions.slice(1).every((row) => row.audience === 'SYSTEM')).toBe(true)
    const changed = await admin('SELECT payload, "causationId" FROM "OutboxEvent" WHERE type = \'print.job_changed\' AND subject = $1 ORDER BY "occurredAt", id', [job.id])
    expect(changed.map((row) => row.payload.status)).toEqual(['QUEUED', 'QUEUED', 'SENT'])
    expect(changed.every((row) => row.causationId !== null)).toBe(true)

    // The relay reports the printer finished it.
    const printed = await applyRelayReport(system(), { jobId: job.id, outcome: 'PRINTED' })
    expect(printed).toMatchObject({ status: 'PRINTED' })
    expect(printed.printedAt).not.toBeNull()
    await expect(applyRelayReport(system(), { jobId: job.id, outcome: 'FAILED' })).rejects.toMatchObject({ name: 'TransitionError' })
  })

  it('fails a job at its last try, keeps the relay\'s words, and sends it again on request', async () => {
    const job = await queueLabel('printer', labelPrinter.id)
    relay.failNext(5, { message: 'Printer out of labels.' })
    for (let attempt = 0; attempt < 4; attempt++) await expect(handle(job.id, attempt)).rejects.toBeInstanceOf(PrintRetryError)
    await handle(job.id, 4)
    const failed = await jobRow(job.id)
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 5, lastError: 'Printer out of labels.' })
    expect(failed.failedAt).not.toBeNull()

    const version = (await call('viewer', 'GET', `/print/jobs/${job.id}`)).json().job.version
    expect((await call('viewer', 'POST', `/print/jobs/${job.id}/retry`, { version })).statusCode).toBe(403)
    const again = await call('printer', 'POST', `/print/jobs/${job.id}/retry`, { version })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().job).toMatchObject({ status: 'QUEUED', attempts: 0, lastError: null, failedAt: null })
    await handle(job.id, 0)
    expect(await jobRow(job.id)).toMatchObject({ status: 'SENT', attempts: 1 })
    expect((await call('printer', 'POST', `/print/jobs/${job.id}/retry`, { version: version + 1 })).statusCode).toBe(409)
  })

  it('fails at once on a final refusal, and when no relay serves the printer here', async () => {
    const job = await queueLabel('printer', labelPrinter.id)
    relay.failNext(1, { message: 'Printer unknown to the relay.', retryable: false })
    await handle(job.id, 0)
    expect(await jobRow(job.id)).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'Printer unknown to the relay.' })

    const orphan = await queueLabel('printer', labelPrinter.id)
    expect(await dispatchJob({ relays: printRelays({}), files: () => files }, system(), orphan.id)).toBe('failed')
    expect(await jobRow(orphan.id)).toMatchObject({ status: 'FAILED', lastError: 'No print relay serves this printer here.' })
  })

  it('keeps a queued job\'s content fixed and its row forever (the …_print_guards trigger)', async () => {
    const job = await queueLabel('printer', labelPrinter.id)
    await expect(db.admin.query('UPDATE "PrintJob" SET zpl = $1 WHERE id = $2', ['^XA^XZ', job.id])).rejects.toThrow(/never changes/)
    await expect(db.admin.query(`UPDATE "PrintJob" SET status = 'PRINTED', "printedAt" = now() WHERE id = $1`, [job.id])).rejects.toThrow(/cannot move from QUEUED to PRINTED/)
    await expect(db.admin.query(`UPDATE "PrintJob" SET status = 'SENT' WHERE id = $1`, [job.id])).rejects.toThrow(/without its time/)
    await expect(db.admin.query('DELETE FROM "PrintJob" WHERE id = $1', [job.id])).rejects.toThrow(/never deleted/)
    await expect(db.admin.query('DELETE FROM "Printer" WHERE id = $1', [labelPrinter.id])).rejects.toThrow(/never deleted/)
    await expect(db.admin.query(`UPDATE "Printer" SET kind = 'A4_PDF', dpi = NULL, "labelWidthMm" = NULL, "labelHeightMm" = NULL WHERE id = $1`, [labelPrinter.id])).rejects.toThrow(/never changes/)
  })
})

describe('document jobs: a stored PDF on an A4 printer', () => {
  it('queues an available PDF of the printer\'s company and gives the relay a short download made on request', async () => {
    const office = callerFor(database, { audience: 'office', tenantId: tenantA, actorId: user, grants: [], requestId: newId() })
    const ddt = await storeDocumentPdf(files, office, {
      companyId: company,
      recordType: 'Ddt',
      recordId: newId(),
      document: {
        type: 'DDT',
        language: 'it',
        number: '2026/000200',
        date: '2026-10-28',
        currency: 'EUR',
        party: { name: 'Cliente Esempio S.r.l.', address: { line1: 'Via Esempio 10', postalCode: '40121', city: 'Bologna', country: 'IT' } },
        lines: [{ description: 'Giacche in pelle', quantity: '4', uom: 'PCS' }],
        transport: { reason: 'SALE', transportBy: 'SENDER', startAt: '2026-10-28T08:00:00Z', appearance: 'Scatole', packages: 1, grossWeightKg: '6' },
      },
    })
    const queued = await call('printer', 'POST', '/print/jobs/document', { printerId: a4Printer.id, fileId: ddt.file.id, copies: 2 })
    expect(queued.statusCode, queued.body).toBe(201)
    const job = queued.json().job
    expect(job).toMatchObject({ payloadKind: 'PDF', fileId: ddt.file.id, recordType: 'Ddt', recordId: ddt.file.recordId, copies: 2, labelKind: null, scanId: null })
    expect((await call('printer', 'POST', '/print/jobs/document', { printerId: labelPrinter.id, fileId: ddt.file.id })).statusCode).toBe(400)

    await handle(job.id, 0)
    expect(await jobRow(job.id)).toMatchObject({ status: 'SENT', attempts: 1 })
    const taken = relay.jobs.find((entry) => entry.job.jobId === job.id)!.job
    expect(taken.payload).toMatchObject({ kind: 'PDF', fileId: ddt.file.id, sha256: ddt.file.sha256, sizeBytes: ddt.file.sizeBytes })
    // The fake relay never fetched it; a real one would, within 60 seconds, from the store.
    const download = await (taken.payload as { download(): Promise<{ url: string }> }).download()
    const fetched = await app.inject({ method: 'GET', url: download.url })
    expect(fetched.statusCode).toBe(200)
    expect(pdfFlatText(fetched.rawPayload)).toContain('Numero: 2026/000200')
  })
})

describe('the floor prints at its own site only', () => {
  it('queues a label at its device\'s site with an idempotency key, and sees nothing of another site', async () => {
    expect((await call('floor-one', 'POST', '/print/jobs/label', { printerId: labelPrinter.id, recordType: 'Hide', recordId: newId(), label: label() })).statusCode).toBe(400)
    const job = await queueLabel('floor-one', labelPrinter.id, {}, 'floor-label-0001')
    expect(job).toMatchObject({ siteId: siteOne, requestedById: operator, deviceId: device, status: 'QUEUED' })
    // A device resending its queue gets the first answer; the same key for another label is refused.
    const body = { printerId: labelPrinter.id, recordType: 'Hide', recordId: job.recordId, label: { ...label(), scanId: job.scanId } }
    const resent = await call('floor-one', 'POST', '/print/jobs/label', body, 'floor-label-0001')
    expect(resent.json().job.id).toBe(job.id)
    expect(await admin('SELECT id FROM "PrintJob" WHERE "recordId" = $1', [job.recordId])).toHaveLength(1)
    expect((await call('floor-one', 'POST', '/print/jobs/label', { ...body, copies: 2 }, 'floor-label-0001')).statusCode).toBe(409)
    const [audit] = await admin('SELECT audience, "siteId", "deviceId" FROM "AuditLog" WHERE "recordId" = $1', [job.id])
    expect(audit).toEqual({ audience: 'FLOOR', siteId: siteOne, deviceId: device })

    // Another site's printer does not exist for this device (row-level security), nor do its jobs.
    expect((await call('floor-one', 'POST', '/print/jobs/label', { printerId: siteTwoPrinter.id, recordType: 'Hide', recordId: newId(), label: label() }, 'floor-label-0002')).statusCode).toBe(404)
    const other = await queueLabel('admin', siteTwoPrinter.id)
    expect((await call('floor-one', 'GET', `/print/jobs/${other.id}`)).statusCode).toBe(404)
    const listed = (await call('floor-one', 'GET', '/print/jobs')).json().jobs as Json[]
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((entry) => entry.siteId === siteOne)).toBe(true)
    // An office user limited to site two cannot print at site one either.
    expect((await call('site-two', 'POST', '/print/jobs/label', { printerId: labelPrinter.id, recordType: 'Hide', recordId: newId(), label: label() })).statusCode).toBe(403)
  })
})

describe('the tenant wall', () => {
  it('keeps another tenant away from this tenant\'s printers and jobs', async () => {
    const job = await queueLabel('printer', labelPrinter.id)
    expect((await call('admin-b', 'GET', '/print/printers')).json().printers).toEqual([])
    expect((await call('admin-b', 'GET', '/print/jobs')).json().jobs).toEqual([])
    expect((await call('admin-b', 'GET', `/print/jobs/${job.id}`)).statusCode).toBe(404)
    expect((await call('admin-b', 'POST', `/print/jobs/${job.id}/retry`, { version: 1 })).statusCode).toBe(404)
    expect((await call('admin-b', 'PATCH', `/print/printers/${labelPrinter.id}`, { version: 1, name: 'mine' })).statusCode).toBe(404)
    const queued = await call('admin-b', 'POST', '/print/jobs/label', { printerId: labelPrinter.id, recordType: 'Hide', recordId: newId(), label: label({ scanId: scanId('HIDE', tenantTag(tenantB)) }) })
    expect(queued.statusCode).toBe(404)
    expect(await dispatchJob({ relays: printRelays({ FAKE: relay }), files: () => files }, system(tenantB), job.id)).toBe('skipped')
    expect(await jobRow(job.id)).toMatchObject({ status: 'QUEUED', attempts: 0 })
  })
})

describe('POST /print/labels/pdf (the browser fallback)', () => {
  it('answers the label as a PDF for any printer, with the scannable id, for the office and the floor', async () => {
    const code = scanId('CARTON')
    for (const session of ['printer', 'floor-one']) {
      const response = await call(session, 'POST', '/print/labels/pdf', { label: { kind: 'CARTON', language: 'en', scanId: code, title: 'Order SO-2026-0042', fields: { carton: '3/12' } }, copies: 2 })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.headers['content-type']).toBe('application/pdf')
      expect(response.headers['content-disposition']).toContain(`${code}.pdf`)
      const text = pdfFlatText(response.rawPayload)
      expect(text).toContain(code)
      expect(text).toContain('Carton 3/12')
    }
    expect((await call('printer', 'POST', '/print/labels/pdf', { label: label({ scanId: scanId('HIDE', tenantTag(tenantB)) }) })).statusCode).toBe(400)
    expect((await call('printer', 'POST', '/print/labels/pdf', { label: label(), widthMm: 40 })).statusCode).toBe(400)
    expect((await call('viewer', 'POST', '/print/labels/pdf', { label: label() })).statusCode).toBe(403)
  })
})
