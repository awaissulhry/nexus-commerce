import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { grantOf } from '@nexus/factory-domain/auth/roles/roles'
import { amountMinor, defineContract, input, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { asMoney, grainedJson, markMoney, money } from '@nexus/factory-domain/money/marked'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { defineManifest, defineRoutes, PUBLIC } from '../../../core/manifest'

/**
 * The money-grain wall on the app (features PLT-034, PLT-035), without a database: every answer is shaped by its
 * contract for the caller's grains, a request that sends money it may not see is refused, floor and link sessions are
 * cost-blind whatever their grants say, and a routes file naming an undeclared permission stops the boot (PLT-029).
 */

const TENANT = '0195f5d0-0000-7000-8000-0000000000f1'
const USER = '0195f5d0-0000-7000-8000-0000000000a1'
const SITE = '0195f5d0-0000-7000-8000-0000000000c1'
const PARTY = '0195f5d0-0000-7000-8000-0000000000d1'

const grantPermissionsForTest = (permissions: Permission[], grains: Grain[]) =>
  grantOf({ permissions, grains }, { allCompanies: true, companyIds: [], siteIds: [], partyIds: [] })
const everyGrain = grantPermissionsForTest(['audit.read'], ['price', 'cost', 'margin', 'wages'])
const SESSIONS: Record<string, SessionContext> = {
  'office-price': { audience: 'office', tenantId: TENANT, actorId: USER, grants: [grantPermissionsForTest(['audit.read'], ['price'])] },
  'office-all': { audience: 'office', tenantId: TENANT, actorId: USER, grants: [everyGrain] },
  'office-none': { audience: 'office', tenantId: TENANT, actorId: USER, grants: [grantPermissionsForTest(['audit.read'], [])] },
  floor: { audience: 'floor', tenantId: TENANT, actorId: USER, siteId: SITE, deviceId: USER, grants: [everyGrain] },
  link: { audience: 'link', tenantId: TENANT, linkId: USER, partyId: PARTY, record: { type: 'Quote', id: USER }, grants: [everyGrain] },
}

const line = output({
  sku: z.string(),
  unitPrice: money.price(unitPrice()),
  unitCost: money.cost(unitPrice()),
  marginMinor: money.margin(amountMinor()),
  pieceRate: money.wages(unitPrice()),
})
const probeContract = defineContract({
  response: { 200: output({ lines: z.array(line), totalMinor: money.price(amountMinor()), history: grainedJson() }) },
})
const writeContract = defineContract({
  body: input({ sku: z.string(), unitCost: money.cost(unitPrice()) }),
  response: { 200: output({ ok: z.literal(true) }) },
})

const probe = defineRoutes(
  'money-probe',
  defineManifest({
    'GET /money-probe': { audiences: ['office', 'floor', 'link'], permission: 'audit.read', scope: 'tenant' },
    'POST /money-probe': { audiences: ['office'], permission: 'audit.read', scope: 'tenant' },
    'GET /money-probe/public': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  }),
  async (app) => {
    const answer = () => ({
      lines: [
        {
          sku: 'JKT-1',
          unitPrice: asMoney('price', '120.000000'),
          unitCost: asMoney('cost', '80.000000'),
          marginMinor: asMoney('margin', 4000),
          pieceRate: asMoney('wages', '1.500000'),
        },
      ],
      totalMinor: asMoney('price', 12000),
      history: { after: { unitCost: markMoney('cost', '80.000000'), unitPrice: markMoney('price', '120.000000'), note: 'kept' } },
    })
    app.get('/money-probe', { schema: probeContract }, async () => answer())
    app.get('/money-probe/public', { schema: probeContract }, async () => answer())
    app.post('/money-probe', { schema: writeContract }, async () => ({ ok: true as const }))
  },
)

const apps: FastifyInstance[] = []
const folders: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

async function boot(options: { routesRoot?: string } = {}): Promise<FastifyInstance> {
  const app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: 'http://localhost:3200' },
    {
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      routes: [probe],
      ...options,
    },
  )
  apps.push(app)
  return app
}

const get = async (app: FastifyInstance, session: string, url = '/money-probe') =>
  (await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })).json()

describe('answers are shaped for the caller grains', () => {
  it('drops every marked field whose grain the caller lacks, in nested lists and in audit JSON', async () => {
    const app = await boot()
    expect(await get(app, 'office-price')).toEqual({
      lines: [{ sku: 'JKT-1', unitPrice: '120.000000' }],
      totalMinor: 12000,
      history: { after: { unitPrice: '120.000000', note: 'kept' } },
    })
    expect(await get(app, 'office-none')).toEqual({ lines: [{ sku: 'JKT-1' }], history: { after: { note: 'kept' } } })
    expect(await get(app, 'office-all')).toEqual({
      lines: [{ sku: 'JKT-1', unitPrice: '120.000000', unitCost: '80.000000', marginMinor: 4000, pieceRate: '1.500000' }],
      totalMinor: 12000,
      history: { after: { unitCost: '80.000000', unitPrice: '120.000000', note: 'kept' } },
    })
  })

  it('keeps floor and link sessions cost-blind by rule, whatever their grants say (PLT-035)', async () => {
    const app = await boot()
    expect(await get(app, 'floor')).toEqual({ lines: [{ sku: 'JKT-1', pieceRate: '1.500000' }], history: { after: { note: 'kept' } } })
    expect(await get(app, 'link')).toEqual({ lines: [{ sku: 'JKT-1', unitPrice: '120.000000' }], totalMinor: 12000, history: { after: { unitPrice: '120.000000', note: 'kept' } } })
  })

  it('gives a public route no money at all', async () => {
    const app = await boot()
    expect(await get(app, 'nobody', '/money-probe/public')).toEqual({ lines: [{ sku: 'JKT-1' }], history: { after: { note: 'kept' } } })
  })
})

describe('requests that send money', () => {
  it('are refused when the caller lacks the grain, accepted with it', async () => {
    const app = await boot()
    const send = (session: string) =>
      app.inject({ method: 'POST', url: '/money-probe', headers: { 'x-test-session': session, origin: 'http://localhost:3200' }, payload: { sku: 'JKT-1', unitCost: '1.000000' } })
    const refused = await send('office-price')
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toMatchObject({ code: 'forbidden', issues: [{ path: 'unitCost', message: 'Needs the cost grain.' }] })
    expect((await send('office-all')).json()).toEqual({ ok: true })
  })
})

describe('the permission registry at boot', () => {
  const manifestModule = fileURLToPath(new URL('../../../core/manifest.ts', import.meta.url))
  const tree = (permission: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'factory-permissions-'))
    folders.push(root)
    mkdirSync(join(root, 'modules', 'quotes'), { recursive: true })
    writeFileSync(
      join(root, 'modules', 'quotes', 'manifest.ts'),
      `import { defineManifest } from ${JSON.stringify(manifestModule)}
export const manifest = defineManifest({ 'GET /quotes': { audiences: ['office'], permission: ${JSON.stringify(permission)}, scope: 'tenant' } })`,
    )
    writeFileSync(
      join(root, 'modules', 'quotes', 'routes.ts'),
      `import { defineRoutes } from ${JSON.stringify(manifestModule)}
import { manifest } from './manifest'
export default defineRoutes('quotes', manifest, async (app) => { app.get('/quotes', async () => ({})) })`,
    )
    return root
  }

  it('refuses to boot a routes file that names an undeclared permission', async () => {
    await expect(boot({ routesRoot: tree('quotes.export') })).rejects.toThrow(/names permissions that are not declared .*: quotes\.export/)
  })

  it('boots a routes file whose permissions are declared', async () => {
    const app = await boot({ routesRoot: tree('audit.read') })
    expect((await app.inject({ method: 'GET', url: '/quotes', headers: { 'x-test-session': 'office-none' } })).statusCode).toBe(200)
  })

  it('every real routes file names declared permissions (the app boots with them)', async () => {
    const app = await boot({ routesRoot: fileURLToPath(new URL('../../..', import.meta.url)) })
    expect(app.factoryRouteManifest.routes().length).toBeGreaterThan(20)
  })
})
