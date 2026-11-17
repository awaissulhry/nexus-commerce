import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { inquiries as exportSource } from './export-source'

/**
 * B-TH-016 (Owner decision 4; PR-30): the inquiries list and its export name the office person who keeps each inquiry, instead
 * of "You" / "A colleague", through the app's real routes on a throwaway PostgreSQL 17 database from the migrations, on the
 * seeds up to the sales intake (SEED-INQ-0002 is assigned to the seeded member). Nobody is counted; a request with nobody keeps
 * none. Made-up data only.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>

const NS = 'th016-assignee-names'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const MEMBER = idOf('user:member')
const salesTemplate = templateOf('sales')!
const SALES = [...salesTemplate.permissions, ...salesTemplate.grains.map((grain) => `money.${grain}`)] as Permission[]
const ADA: SessionContext = { audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: SALES, companies: 'all', sites: 'all', parties: 'all' }] }
const MEMBER_SESSION: SessionContext = { ...ADA, actorId: MEMBER }

let h: Harness
let app: FastifyInstance
let memberName = ''
const run = randomBytes(4).toString('hex')
const get = async (session: string, url: string): Promise<Json> => {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session, 'x-run': run } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  h = await startHarness('th016_names')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  memberName = String((await h.db.admin.query(`SELECT "displayName" FROM "User" WHERE id = $1`, [MEMBER])).rows[0]!.displayName)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => ({ ada: ADA, member: MEMBER_SESSION })[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('lists name office people (B-TH-016)', () => {
  it('the list names the assignee for everyone, the keeper too; nobody for a request with nobody', async () => {
    expect(memberName).not.toBe('')
    const rows = (await get('ada', '/sales/inquiries?tile=ALL')).rows as Json[]
    const assigned = rows.find((row) => row.number === 'SEED-INQ-0002')!
    expect(assigned).toMatchObject({ assigneeId: MEMBER, assignee: { id: MEMBER, name: memberName }, mine: false })
    expect(rows.find((row) => row.number === 'SEED-INQ-0001')).toMatchObject({ assigneeId: null, assignee: null })
    const own = ((await get('member', '/sales/inquiries?tile=ALL')).rows as Json[]).find((row) => row.number === 'SEED-INQ-0002')!
    expect(own).toMatchObject({ assignee: { id: MEMBER, name: memberName }, mine: true })
  })

  it('the export says the same name, never "You" or "A colleague"', async () => {
    const caller = callerFor(h.database, { ...ADA, requestId: newId() } as never)
    const page = await exportSource.read(caller, exportSource.query(new URLSearchParams('tile=ALL')), null, 50)
    const words = (code: string) => exportSource.words!.en[code] ?? code
    const byNumber = new Map((page.rows as Json[]).map((row) => [row.number, row]))
    expect(exportSource.columns.assignedTo!.value(byNumber.get('SEED-INQ-0002')!, words)).toBe(memberName)
    expect(exportSource.columns.assignedTo!.value(byNumber.get('SEED-INQ-0001')!, words)).toBeNull()
    for (const locale of ['en', 'it'] as const) expect(Object.keys(exportSource.words![locale]).filter((key) => key.startsWith('assignee.'))).toEqual([])
  })
})
