/**
 * ADS PLAYBOOK PB-4 — createPortfolio, moved from POST /advertising/portfolios into ads-portfolio.service.ts with no
 * behaviour change, on PGlite with the production schema (business profiles ON). Values are made up.
 *
 *   local     with no Amazon Ads connection for the market, nothing is sent: the portfolio is stored with a local id
 *             (`local-pf-<profile>-<name>`) under the market's local profile, mode `local`
 *   again     the same name again is the same row (an upsert), not a second portfolio
 *   gated     with a connection whose write gate is shut, Amazon is still not called (the client is never reached)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const amazon = vi.hoisted(() => ({ createPortfolio: vi.fn(async () => ({ externalId: 'amazon-pf-1', mode: 'production' })) }))
vi.mock('./ads-api-client.js', async (original) => ({ ...(await original<Record<string, unknown>>()), createPortfolio: amazon.createPortfolio }))
const gate = vi.hoisted(() => ({ profile: null as null | { profileId: string; region: 'EU' }, allowed: false }))
vi.mock('./ads-profile-resolver.js', async (original) => ({ ...(await original<Record<string, unknown>>()), adsClientContextFor: vi.fn(async () => gate.profile) }))
vi.mock('./ads-write-gate.js', async (original) => ({ ...(await original<Record<string, unknown>>()), checkAdsWriteGate: vi.fn(async () => ({ allowed: gate.allowed })) }))

import { createPortfolio } from './ads-portfolio.service.js'

const A = 'pb4_portfolio_alpha'
const inA = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('createPortfolio', () => {
  it('no connection: stored with a local id under the market\'s local profile; nothing sent', async () => {
    const out = await inA(() => createPortfolio({ name: 'Test Portfolio IT', marketplace: 'IT' }))
    expect(out).toEqual({ portfolio: { portfolioId: 'local-pf-local-IT-test-portfolio-it', name: 'Test Portfolio IT' }, mode: 'local' })
    expect(await inA(() => database.client.amazonAdsPortfolio.findMany({ select: { profileId: true, externalPortfolioId: true, name: true, state: true } })))
      .toEqual([{ profileId: 'local-IT', externalPortfolioId: 'local-pf-local-IT-test-portfolio-it', name: 'Test Portfolio IT', state: 'ENABLED' }])
    expect(amazon.createPortfolio).not.toHaveBeenCalled()
  })

  it('the same name again is the same row', async () => {
    await inA(() => createPortfolio({ name: 'Test Portfolio IT', marketplace: 'IT' }))
    expect(await inA(() => database.client.amazonAdsPortfolio.count())).toBe(1)
  })

  it('a connection with the write gate shut: still local, in that profile; with it open: made at Amazon', async () => {
    gate.profile = { profileId: 'test-profile-1', region: 'EU' }
    try {
      const shut = await inA(() => createPortfolio({ name: 'Test Gate', marketplace: 'DE' }))
      expect(shut).toEqual({ portfolio: { portfolioId: 'local-pf-test-profile-1-test-gate', name: 'Test Gate' }, mode: 'local' })
      expect(amazon.createPortfolio).not.toHaveBeenCalled()
      gate.allowed = true
      const open = await inA(() => createPortfolio({ name: 'Test Open', marketplace: 'DE' }))
      expect(open).toEqual({ portfolio: { portfolioId: 'amazon-pf-1', name: 'Test Open' }, mode: 'production' })
      expect(amazon.createPortfolio).toHaveBeenCalledWith({ profileId: 'test-profile-1', region: 'EU' }, { name: 'Test Open', state: 'enabled' })
    } finally {
      gate.profile = null
      gate.allowed = false
    }
  })
})
