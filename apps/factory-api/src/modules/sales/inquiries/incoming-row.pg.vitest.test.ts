import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-TH-216 (threads plan TH-1b, Sales › Incoming; features O-SAL-INQ-LIST.list-F01, -F02; wall check W19): an Incoming row
 * carries the Picture cell (the main picture of the style its first style line names, the file only with files.read) and the
 * Files cell (the request's files and its mail's kept attachments, counted by kind, only with files.read), and
 * GET /sales/inquiries/:inquiryId/picture serves only the small preview of a request the reader may see — through the app's
 * real routes on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake and the styles'
 * pictures (SEED-INQ-0004: P1's line for its own private-label jacket SEED-JKT-01, whose black colourway photo is the main
 * picture; SEED-INQ-0003: made from a mail whose tech pack is attached; SEED-INQ-0001: a prospect's lines in words). Made-up
 * data only. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/inquiries/incoming-row`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>

const NS = 'th216-incoming-row'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const salesTemplate = templateOf('sales')!
const SALES = [...salesTemplate.permissions, ...salesTemplate.grains.map((grain) => `money.${grain}`)] as Permission[]
const withFiles = SALES.includes('files.read' as Permission) ? SALES : ([...SALES, 'files.read'] as Permission[])
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions, parties)] })
const SESSIONS: Record<string, SessionContext> = {
  sales: office(withFiles),
  // Reads requests but no files: names the style, never its file; no counts.
  noFiles: office(withFiles.filter((name) => name !== 'files.read')),
  // A role limited to the customer P3: P1's request (and its picture) is not there for it.
  onlyP3: office(withFiles, [P3]),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session, 'x-run': run } })
async function get(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const rowsOf = async (session: string): Promise<Json[]> => (await get(session, '/sales/inquiries?tile=ALL')).rows as Json[]
const byNumber = (rows: readonly Json[], number: string): Json | undefined => rows.find((row) => row.number === number)

beforeAll(async () => {
  h = await startHarness('th216_incoming')
  // In the CLI's name order (each seed runs the ones it builds on itself).
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedOptions({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  await seedStylesDepth({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the Picture and Files cells of Sales › Incoming (B-TH-216)', () => {
  it('a request whose line names a style shows that style and its main picture; lines in words show none', async () => {
    const rows = await rowsOf('sales')
    const quoted = byNumber(rows, 'SEED-INQ-0004')!
    expect(quoted.picture).toMatchObject({ styleCode: 'SEED-JKT-01', small: false })
    expect(quoted.picture.fileId).toEqual(expect.any(String))
    expect(quoted.picture.contentType).toMatch(/^image\//)
    expect(quoted.styleCount).toBe(1)
    const prospect = byNumber(rows, 'SEED-INQ-0001')!
    expect(prospect.picture).toBeNull()
    expect(prospect.styleCount).toBe(0)
  })

  it('files are counted by kind (the mail\'s kept attachments too), never named, and only with files.read', async () => {
    const rows = await rowsOf('sales')
    const fromMail = byNumber(rows, 'SEED-INQ-0003')!
    expect(fromMail.fileCounts).toEqual({ photos: expect.any(Number), documents: expect.any(Number) })
    expect(fromMail.fileCounts.photos + fromMail.fileCounts.documents).toBeGreaterThan(0)
    expect(JSON.stringify(fromMail.fileCounts)).not.toMatch(/\.pdf|originalName/i)
    for (const row of rows) expect(row.fileCounts === null || typeof row.fileCounts.photos === 'number').toBe(true)

    const blind = await rowsOf('noFiles')
    expect(blind.every((row) => row.fileCounts === null)).toBe(true)
    // The style is still named; its file is not.
    expect(byNumber(blind, 'SEED-INQ-0004')!.picture).toMatchObject({ styleCode: 'SEED-JKT-01', fileId: null, contentType: null, small: false })
  })

  it('the picture route serves the small preview of a visible request only (W19), never the original', async () => {
    const quoted = byNumber(await rowsOf('sales'), 'SEED-INQ-0004')!
    const answer = await get('sales', `/sales/inquiries/${quoted.id}/picture`)
    expect(answer.picture).toMatchObject({ fileId: quoted.picture.fileId, styleId: quoted.picture.styleId, small: null })
    expect(JSON.stringify(answer)).not.toMatch(/"url":"[^"]*original/i)

    const prospect = byNumber(await rowsOf('sales'), 'SEED-INQ-0001')!
    expect((await call('sales', `/sales/inquiries/${prospect.id}/picture`)).statusCode).toBe(404)
    expect((await call('noFiles', `/sales/inquiries/${quoted.id}/picture`)).statusCode).toBe(404)

    // W19: a person limited to P3 never sees P1's request, its row, its counts or its picture.
    const limited = await rowsOf('onlyP3')
    expect(byNumber(limited, 'SEED-INQ-0004')).toBeUndefined()
    expect(limited.every((row) => row.party === null || row.party.id === P3)).toBe(true)
    expect(JSON.stringify(limited)).not.toContain(P1)
    expect((await call('onlyP3', `/sales/inquiries/${quoted.id}/picture`)).statusCode).toBe(404)
  })
})
