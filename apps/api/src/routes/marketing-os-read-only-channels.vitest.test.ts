/**
 * Google Ads step 1a (plan-3 §2 D1, D2; §3.5 A3) — the marketing OS routes refuse a write on a channel Nexus only reads.
 *
 * Google, Meta and TikTok have sandbox-stub adapters: before this guard, creating a Google campaign put a draft with the
 * Google dot on the Marketing Calendar, and a pause or a budget change on one was queued, marked SUCCESS by the sandbox,
 * and shown as done although Google was never called. Now each answers 409 `channel_read_only` with a sentence that
 * says where to make the change, BEFORE anything is queued: no OutboundSyncQueue row, no CampaignAction row, no change
 * to the campaign. A campaign on a channel Nexus does write (INTERNAL here) is still queued (the control).
 *
 * On a real PostgreSQL (PGlite) with the real marketing OS routes. Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const db = () => database.client
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance
const ids: Record<string, string> = {}

const counts = () => inside(async () => ({
  campaigns: await db().marketingCampaign.count(),
  queued: await db().outboundSyncQueue.count(),
  actions: await db().campaignAction.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const campaign = (channel: string, surface: string, name: string) =>
      db().marketingCampaign.create({ data: { channel, surface, name, status: 'ACTIVE', startDate: new Date('2026-09-01T00:00:00Z'), budgetCents: 2000 } as never })
    ids.google = (await campaign('GOOGLE', 'SHOPPING_FEED', 'Test Google campaign')).id
    ids.meta = (await campaign('META', 'SHOPPING_FEED', 'Test Meta campaign')).id
    ids.tiktok = (await campaign('TIKTOK', 'SHOPPING_FEED', 'Test TikTok campaign')).id
    ids.internal = (await campaign('INTERNAL', 'CONTENT_PUSH', 'Test content push')).id
  })
  const { default: routes } = await import('./marketing-os.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const SENTENCES = {
  GOOGLE: 'Nexus does not make changes in Google Ads yet. Make this change in Google Ads.',
  META: 'Nexus does not make changes in Meta ads yet. Make this change in Meta Ads Manager.',
  TIKTOK: 'Nexus does not make changes in TikTok ads yet. Make this change in TikTok Ads Manager.',
} as const

describe('A3 — a write on a read-only channel is refused before anything is queued', () => {
  it('creating a Google, Meta or TikTok campaign: 409 channel_read_only, and no campaign row', async () => {
    const before = await counts()
    for (const channel of ['GOOGLE', 'META', 'TIKTOK'] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/marketing/os/campaigns', payload: { name: 'Should not exist', channel, surface: 'SHOPPING_FEED' } })
      expect({ channel, status: res.statusCode, body: res.json() }).toEqual({ channel, status: 409, body: { code: 'channel_read_only', error: SENTENCES[channel] } })
    }
    expect(await counts()).toEqual(before)
  })

  it('pausing, resuming or re-budgeting one: 409, nothing queued, no audit row, the campaign unchanged', async () => {
    const before = await counts()
    for (const [channel, id] of [['GOOGLE', ids.google], ['META', ids.meta], ['TIKTOK', ids.tiktok]] as const) {
      for (const payload of [{ status: 'PAUSED' }, { status: 'ACTIVE' }, { budgetCents: 5000 }]) {
        const res = await app.inject({ method: 'PATCH', url: `/api/marketing/os/campaigns/${id}/mutate`, payload })
        expect({ channel, payload, status: res.statusCode, body: res.json() }).toEqual({ channel, payload, status: 409, body: { code: 'channel_read_only', error: SENTENCES[channel] } })
      }
    }
    expect(await counts()).toEqual(before)
    const google = await inside(() => db().marketingCampaign.findUnique({ where: { id: ids.google }, select: { status: true, budgetCents: true } }))
    expect(google).toEqual({ status: 'ACTIVE', budgetCents: 2000 })
  })

  it('launching one: 409 and nothing queued', async () => {
    const before = await counts()
    const res = await app.inject({ method: 'POST', url: `/api/marketing/os/campaigns/${ids.google}/launch` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'channel_read_only', error: SENTENCES.GOOGLE })
    expect(await counts()).toEqual(before)
  })

  it('control: a campaign on a channel Nexus writes is still queued, and a draft on it is still created', async () => {
    const before = await counts()
    const res = await app.inject({ method: 'PATCH', url: `/api/marketing/os/campaigns/${ids.internal}/mutate`, payload: { budgetCents: 2500 } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ queueId: expect.any(String), campaign: { id: ids.internal, budgetCents: 2500 } })
    const created = await app.inject({ method: 'POST', url: '/api/marketing/os/campaigns', payload: { name: 'Test outreach', channel: 'INTERNAL', surface: 'EMAIL_OUTREACH' } })
    expect(created.statusCode, created.body).toBe(200)
    expect(await counts()).toEqual({ campaigns: before.campaigns + 1, queued: before.queued + 1, actions: before.actions + 1 })
  })
})
