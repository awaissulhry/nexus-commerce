import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Job } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { fakePrintRelay, type FakePrintRelay } from '../../../adapters/print-relay/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { runHandler } from '../../outbox/dispatch'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { printDispatchHandler } from '../handler'
import { printRelays, usePrintRelays } from '../service'

/**
 * Direct thermal printing (B-W2b-391; LOG-026) on the local stack with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, the floor's column grants (no printer address, no
 * update on a job), B-W2b-367's Printer_mode_check), the FAKE relay, made-up printers and addresses, sessions from the test
 * authenticator. Run with `node scripts/factory/run-pg-tests.mjs platform/print/direct`.
 *
 *   mode      DIRECT only for a label printer with an address the station's browser reaches (409 in words); a DIRECT
 *             printer keeps one; the floor reads the mode, never the address
 *   worker    the dispatch handler leaves a DIRECT printer's job to its station; a PDF printer's job fails in words
 *   station   the floor lists its DIRECT jobs, takes one (the ZPL and the address, SENT), says it failed (its words), sends it
 *             again, takes it again and says it printed; another station or the office cannot take or report it
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let relay: FakePrintRelay

const tenant = newId()
const company = newId()
const site = newId()
const device = newId()
const operator = newId()
const TAG = tenantTag(tenant)
let ref = 300

const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['print.view', 'print.labels', 'print.manage'])] },
  printer: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['print.view', 'print.labels'])] },
  station: { audience: 'floor', tenantId: tenant, actorId: operator, siteId: site, deviceId: device, grants: [grant(['print.view', 'print.labels'])] },
  otherStation: { audience: 'floor', tenantId: tenant, actorId: operator, siteId: site, deviceId: newId(), grants: [grant(['print.view', 'print.labels'])] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]!.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': `direct-391-${run}-${++keys}` } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const label = () => ({ kind: 'HIDE', language: 'it', scanId: formatScanId({ type: 'HIDE', tenantTag: TAG, ref: ++ref }), maker: 'Test', title: 'Nappa 1.2 nero', fields: { colour: 'Nero' } })
const queue = async (session: string, printerId: string) => (await ok(session, 'POST', '/print/jobs/label', { printerId, recordType: 'Hide', recordId: newId(), copies: 2, label: label() }, 201)).job
const row = async (jobId: string) => (await admin('SELECT status::text AS status, "relayJobId", "lastError", "sentAt" IS NOT NULL AS sent, "printedAt" IS NOT NULL AS printed FROM "PrintJob" WHERE id = $1', [jobId]))[0]!

async function queuedEvent(jobId: string): Promise<EventEnvelope> {
  const [event] = await admin(
    `SELECT id, type, version, context, "tenantId", "companyId", "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload
       FROM "OutboxEvent" WHERE type = 'print.job_queued' AND subject = $1 ORDER BY "occurredAt" DESC, id DESC LIMIT 1`,
    [jobId],
  )
  return {
    eventId: event!.id,
    type: event!.type,
    version: event!.version,
    context: event!.context,
    tenantId: event!.tenantId,
    companyId: event!.companyId,
    siteId: event!.siteId,
    subject: event!.subject,
    correlationId: event!.correlationId,
    causationId: event!.causationId,
    source: event!.source,
    occurredAt: (event!.occurredAt as Date).toISOString(),
    payload: event!.payload,
  }
}
/** One try of the worker's print.dispatch handler, as the event-handlers queue runs it. */
const dispatch = async (jobId: string) => runHandler({ name: 'print.dispatch', data: await queuedEvent(jobId), attemptsMade: 0 } as Job<EventEnvelope>, [printDispatchHandler()], database)

let label1: Json
let label2: Json
let a4: Json

beforeAll(async () => {
  db = await migratedDatabase('printdirect')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  redis = testRedis()
  connection = redis.connect()
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'direct-391'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'direct-391', 'Pelletteria Fittizia S.r.l.')`, [company, tenant])
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'D391', 'Test plant', 'PLANT')`, [site, tenant, company])
  relay = fakePrintRelay({ environment: 'test' })
  usePrintRelays(printRelays({ FAKE: relay }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  // Made-up printers: a label printer known by a queue name only, another by its address, an A4 printer.
  label1 = (await ok('admin', 'POST', '/print/printers', { siteId: site, code: 'LBL-PACK', name: 'Packing labels', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'zebra queue 1', dpi: 203, labelWidthMm: 100, labelHeightMm: 50 }, 201)).printer
  label2 = (await ok('admin', 'POST', '/print/printers', { siteId: site, code: 'LBL-DOCK', name: 'Dock labels', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: '192.168.1.51', dpi: 203, labelWidthMm: 100, labelHeightMm: 50 }, 201)).printer
  a4 = (await ok('admin', 'POST', '/print/printers', { siteId: site, code: 'A4-DOCK', name: 'Dock office', kind: 'A4_PDF', relay: 'FAKE', relayTarget: 'office-printer' }, 201)).printer
  void connection
}, 60_000)

afterAll(async () => {
  usePrintRelays(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe("a printer's mode (LOG-026)", () => {
  it('prints straight from the station only for a label printer with an address its browser reaches', async () => {
    expect(label1).toMatchObject({ mode: 'RELAY' })
    expect((await refused('admin', 'PUT', `/print/printers/${a4.id}/mode`, { mode: 'DIRECT', version: 1 }, 409)).message).toBe(
      'Only a label printer (ZPL) prints straight from the station; an A4 printer prints through the relay or from the browser.',
    )
    expect((await refused('admin', 'PUT', `/print/printers/${label1.id}/mode`, { mode: 'DIRECT', version: 1 }, 409)).message).toContain("Say the printer's address on the local network first")
    const moved = await ok('admin', 'PATCH', `/print/printers/${label1.id}`, { version: 1, relayTarget: '192.168.1.50' })
    const direct = await ok('admin', 'PUT', `/print/printers/${label1.id}/mode`, { mode: 'DIRECT', version: moved.printer.version })
    expect(direct).toMatchObject({ mode: 'DIRECT', changed: true, printer: { mode: 'DIRECT' } })
    expect((await ok('admin', 'PUT', `/print/printers/${label1.id}/mode`, { mode: 'DIRECT', version: direct.printer.version })).changed).toBe(false)
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'print.setMode'`, [label1.id])
    expect(audit).toEqual({ before: { mode: 'RELAY' }, after: { mode: 'DIRECT' } })
    // A DIRECT printer keeps an address; the floor reads the mode, never the address.
    expect((await refused('admin', 'PATCH', `/print/printers/${label1.id}`, { version: direct.printer.version, relayTarget: 'zebra queue 1' }, 409)).message).toContain("Say the printer's address")
    const seen = (await ok('station', 'GET', '/print/printers')).printers.find((printer: Json) => printer.id === label1.id)
    expect(seen).toMatchObject({ mode: 'DIRECT' })
    expect(seen.relayTarget).toBeUndefined()
    expect((await refused('printer', 'PUT', `/print/printers/${label2.id}/mode`, { mode: 'PDF', version: 1 }, 403)).code).toBe('forbidden')
  })
})

describe('a station prints the job itself (LOG-026)', () => {
  let job: Json

  it("the worker leaves a DIRECT printer's job to its station", async () => {
    job = await queue('station', label1.id)
    await dispatch(job.id)
    expect(await row(job.id)).toMatchObject({ status: 'QUEUED', sent: false })
    expect(relay.jobs.some((sent) => sent.job.jobId === job.id)).toBe(false)
  })

  it('the station lists it, takes it (the ZPL and the address), says it failed, sends it again, takes it and says it printed', async () => {
    const listed = await ok('station', 'GET', '/print/direct/jobs')
    expect(listed.printers.map((printer: Json) => printer.code)).toEqual(['LBL-PACK'])
    expect(listed.jobs.map((entry: Json) => entry.id)).toEqual([job.id])
    expect(listed.jobs[0].zpl).toBeUndefined()

    const taken = await ok('station', 'POST', `/print/direct/jobs/${job.id}/take`, {})
    expect(taken).toMatchObject({ copies: 2, printer: { code: 'LBL-PACK', address: '192.168.1.50' }, job: { status: 'SENT', relayJobId: `direct:${device}` } })
    expect(taken.zpl).toMatch(/^\^XA/)
    expect((await refused('otherStation', 'POST', `/print/direct/jobs/${job.id}/take`, {}, 409)).message).toMatch(/^A station took this job at /)
    expect((await refused('printer', 'POST', `/print/direct/jobs/${job.id}/report`, { outcome: 'PRINTED' }, 409)).message).toBe('Another station took this job: that station reports how it went.')

    const failed = await ok('station', 'POST', `/print/direct/jobs/${job.id}/report`, { outcome: 'FAILED', message: 'no answer from 192.168.1.50' })
    expect(failed.job).toMatchObject({ status: 'FAILED', lastError: 'The station could not print it: no answer from 192.168.1.50' })
    const again = await ok('station', 'POST', `/print/jobs/${job.id}/retry`, { version: failed.job.version })
    expect(again.job.status).toBe('QUEUED')
    await dispatch(job.id)
    expect((await row(job.id)).status).toBe('QUEUED')

    await ok('station', 'POST', `/print/direct/jobs/${job.id}/take`, {})
    const printed = await ok('station', 'POST', `/print/direct/jobs/${job.id}/report`, { outcome: 'PRINTED' })
    expect(printed.job).toMatchObject({ status: 'PRINTED', lastError: null })
    expect(await row(job.id)).toMatchObject({ status: 'PRINTED', printed: true })
    expect((await refused('station', 'POST', `/print/direct/jobs/${job.id}/report`, { outcome: 'PRINTED' }, 409)).message).toBe('This job is printed already: nothing to report.')
    const audit = await admin(`SELECT action, after->>'deviceId' AS device FROM "AuditLog" WHERE "recordId" = $1 AND action LIKE 'print.direct%' ORDER BY at, id`, [job.id])
    expect(audit).toEqual([
      { action: 'print.directTake', device },
      { action: 'print.directReport', device },
      { action: 'print.directTake', device },
      { action: 'print.directReport', device },
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'print.job_changed' AND subject = $1`, [job.id]))[0]!.n).toBe(4)
  })

  it("leaves a relay printer's job to the worker, and fails a PDF printer's job in words", async () => {
    const relayed = await queue('station', label2.id)
    expect((await refused('station', 'POST', `/print/direct/jobs/${relayed.id}/take`, {}, 409)).message).toBe("This printer is reached through the site's relay: the worker sends it the job, not a station.")
    const pdf = await ok('admin', 'PUT', `/print/printers/${label2.id}/mode`, { mode: 'PDF', version: label2.version })
    expect(pdf.printer.mode).toBe('PDF')
    const browserOnly = await queue('station', label2.id)
    await dispatch(browserOnly.id)
    expect(await row(browserOnly.id)).toMatchObject({ status: 'FAILED', lastError: 'This printer prints from the browser as a PDF: print the PDF there.' })
  })
})
