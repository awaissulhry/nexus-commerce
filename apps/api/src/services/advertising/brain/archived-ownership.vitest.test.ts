/**
 * C3 (2026-10-10) — an archived campaign leaves the brain (brain/archived-ownership.ts), on PGlite with the production
 * schema. Review 2026-10-10: the settings sync can mark a campaign ARCHIVED by mistake and put it back on its next read,
 * so nothing happens before a day has passed, and the Owner's overrides end only on proof that Amazon took the archive:
 *   proof      Amazon accepted Nexus's archive a day ago: LIVE → SHADOW and his CAMPAIGN overrides end (system:campaign-archived)
 *   too soon   the same, two hours ago: nothing
 *   quiet      archived, no proof, unseen by the sync for a day: HELD → SHADOW; his overrides stay in force
 *   flip-back  the sync archives a campaign by mistake and its next read puts it back: nothing ends, then or a day later
 *   kept       ENABLED and PAUSED campaigns, PRODUCT overrides
 *   once       a second run changes nothing; one note per campaign
 *   the tick   the state cron runs it first, and records a run only when it ended something
 * Nothing here calls Amazon. Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
const rec = vi.hoisted(() => ({ runs: [] as Array<{ job: string; summary: unknown }> }))
vi.mock('../../../utils/cron-observability.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordCronRun: async (job: string, run: () => Promise<unknown>) => { const summary = await run(); rec.runs.push({ job, summary }); return summary },
}))

const { endBrainOwnershipOfArchived, archiveAcceptedAt, CAMPAIGN_ARCHIVED_BY, ARCHIVED_OWNERSHIP_NOTE } = await import('./archived-ownership.js')
const { brainOwnedCampaignIds } = await import('../bid-brain/live.js')
const { reconcileCampaignDeletions } = await import('../ads-campaign-settings-sync.service.js')
const { runBrainStateTick, BRAIN_STATE_JOB } = await import('../../../jobs/ads-brain-state.job.js')

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const HOUR = 3_600_000
const NOW = new Date('2026-10-10T12:50:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR)

async function campaign(id: string, status: string, lastSyncedAt: Date | null = null) {
  await db().campaign.create({
    data: { id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, status, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), lastSyncedAt },
  })
}
const enroll = (campaignId: string, mode: string) => db().bidBrainEnrollment.create({
  data: { campaignId, marketplace: 'IT', mode, enrolledBy: 'user:owner', ...(mode === 'HELD' ? { heldUntil: new Date('2026-10-20T00:00:00Z'), heldBy: 'auto-undo', heldReason: 'a worse day' } : {}) },
})
const override = (id: string, scope: 'CAMPAIGN' | 'PRODUCT', campaignId: string | null) => db().adsBrainOverride.create({
  data: { id, productId: 'prod-jacket', marketplace: 'IT', scope, campaignId, kind: 'LOCK', key: 'bids', by: 'user:owner' },
})
/** Nexus archived the campaign; Amazon accepted it at `syncedAt` (null: the queue row never succeeded). */
async function nexusArchive(campaignId: string, syncedAt: Date | null) {
  const q = await db().outboundSyncQueue.create({ data: { payload: {}, syncType: 'CAMPAIGN_UPDATE', syncStatus: syncedAt ? 'SUCCESS' : 'FAILED', syncedAt } })
  await db().advertisingActionLog.create({
    data: { actionType: 'CAMPAIGN_UPDATE', entityType: 'CAMPAIGN', entityId: campaignId, userId: 'user:owner', payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'ARCHIVED' }, outboundQueueId: q.id, amazonResponseStatus: 'PENDING' },
  })
}
const enrollmentOf = (campaignId: string) => inside(() => db().bidBrainEnrollment.findFirst({ where: { campaignId } }))
const overrideOf = (id: string) => inside(() => db().adsBrainOverride.findUnique({ where: { id } }))
const notes = () => inside(() => db().advertisingActionLog.findMany({ where: { actionType: 'custom_event', userId: CAMPAIGN_ARCHIVED_BY }, orderBy: { entityId: 'asc' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await campaign('c-proof', 'ARCHIVED', ago(30)) // Amazon took Nexus's archive 30 h ago
    await campaign('c-proof-new', 'ARCHIVED', ago(2)) // ... two hours ago
    await campaign('c-quiet', 'ARCHIVED', ago(30)) // archived in Seller Central, unseen by the sync since
    await campaign('c-quiet-new', 'ARCHIVED', ago(2))
    await campaign('c-enabled', 'ENABLED', ago(1))
    await campaign('c-paused', 'PAUSED', ago(1))
    await nexusArchive('c-proof', ago(30))
    await nexusArchive('c-proof-new', ago(2))
    await nexusArchive('c-quiet', null) // its own archive request failed at Amazon: no proof
    await enroll('c-proof', 'LIVE')
    await enroll('c-proof-new', 'LIVE')
    await enroll('c-quiet', 'HELD')
    await enroll('c-quiet-new', 'LIVE')
    await enroll('c-enabled', 'LIVE')
    await enroll('c-paused', 'HELD')
    await override('o-proof', 'CAMPAIGN', 'c-proof')
    await override('o-proof-new', 'CAMPAIGN', 'c-proof-new')
    await override('o-quiet', 'CAMPAIGN', 'c-quiet')
    await override('o-paused', 'CAMPAIGN', 'c-paused')
    await override('o-product', 'PRODUCT', null)
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() })

describe('C3 — archive ends brain ownership, a day later, on evidence', () => {
  it('reads when Amazon accepted Nexus\'s archive; a failed request is no proof', async () => {
    const at = await inside(() => archiveAcceptedAt(['c-proof', 'c-proof-new', 'c-quiet', 'c-enabled']))
    expect(Object.fromEntries(at)).toEqual({ 'c-proof': ago(30), 'c-proof-new': ago(2) })
  })

  it('proof a day old: SHADOW and his overrides end; quiet a day: SHADOW, his overrides stay; anything newer: nothing', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    const r = await inside(() => endBrainOwnershipOfArchived(NOW))
    expect(r).toEqual({ enrollments: ['c-proof', 'c-quiet'], overrides: 1, campaigns: ['c-proof', 'c-quiet'] })

    expect(await enrollmentOf('c-proof')).toMatchObject({ mode: 'SHADOW', heldUntil: null, heldBy: null, heldReason: null, enrolledBy: 'user:owner' })
    expect(await enrollmentOf('c-quiet')).toMatchObject({ mode: 'SHADOW', heldUntil: null, heldBy: null, heldReason: null })
    expect(await overrideOf('o-proof')).toMatchObject({ endedAt: NOW, endedBy: CAMPAIGN_ARCHIVED_BY })
    expect(await overrideOf('o-quiet')).toMatchObject({ endedAt: null, endedBy: null }) // no proof: his, left in force
    // Too soon: nothing.
    expect(await enrollmentOf('c-proof-new')).toMatchObject({ mode: 'LIVE' })
    expect(await enrollmentOf('c-quiet-new')).toMatchObject({ mode: 'LIVE' })
    expect(await overrideOf('o-proof-new')).toMatchObject({ endedAt: null })
    // Never: running and paused campaigns, PRODUCT overrides.
    expect(await enrollmentOf('c-enabled')).toMatchObject({ mode: 'LIVE' })
    expect(await enrollmentOf('c-paused')).toMatchObject({ mode: 'HELD', heldBy: 'auto-undo' })
    expect(await overrideOf('o-paused')).toMatchObject({ endedAt: null })
    expect(await overrideOf('o-product')).toMatchObject({ endedAt: null })
    expect(await inside(() => brainOwnedCampaignIds())).toEqual(new Set(['c-proof-new', 'c-quiet-new', 'c-enabled', 'c-paused']))

    const n = await notes()
    expect(n.map((x: { entityId: string }) => x.entityId)).toEqual(['c-proof', 'c-quiet'])
    expect(n[0]).toMatchObject({ entityType: 'CAMPAIGN', payloadBefore: { enrollment: 'LIVE', openOverrides: 1 }, payloadAfter: { enrollment: 'SHADOW', overridesEnded: 1 } })
    expect(n[0].payloadAfter.note).toMatch(new RegExp(`^${ARCHIVED_OWNERSHIP_NOTE} — Amazon accepted its archive from Nexus`))
    expect(n[1].payloadAfter.note).toMatch(/the Owner's campaign overrides stay/)
    expect(n[1].payloadAfter).not.toHaveProperty('overridesEnded')
  })

  it('a second run changes nothing, and each note stays written once', async () => {
    const before = await notes()
    expect(await inside(() => endBrainOwnershipOfArchived(new Date(NOW.getTime() + HOUR)))).toEqual({ enrollments: [], overrides: 0, campaigns: [] })
    expect(await overrideOf('o-proof')).toMatchObject({ endedAt: NOW })
    expect(await notes()).toHaveLength(before.length)
  })

  it('flip-back: the sync archives a campaign by mistake and its next read puts it back — nothing ends, then or a day later', async () => {
    await inside(async () => {
      await campaign('c-flip', 'ENABLED', new Date())
      await enroll('c-flip', 'LIVE')
      await override('o-flip', 'CAMPAIGN', 'c-flip')
    })
    // A read that missed it: the real reconcile marks it ARCHIVED (it stamps lastSyncedAt now).
    const live = await inside(() => db().campaign.findMany({ where: { marketplace: 'IT', status: { in: ['ENABLED', 'PAUSED'] } }, select: { externalCampaignId: true } }))
    const seen = new Set<string>(live.map((c: { externalCampaignId: string }) => c.externalCampaignId).filter((x: string) => x !== 'EXT-c-flip'))
    expect(await inside(() => reconcileCampaignDeletions({ connMarketplace: 'IT', seenExternalCampaignIds: seen, fetchOk: true }))).toBe(1)
    expect((await inside(() => db().campaign.findUnique({ where: { id: 'c-flip' } }))).status).toBe('ARCHIVED')
    const hourLater = new Date(Date.now() + HOUR)
    expect((await inside(() => endBrainOwnershipOfArchived(hourLater))).campaigns).not.toContain('c-flip')
    // The next read returns it: its status comes back (as the sync's row update does).
    await inside(() => db().campaign.update({ where: { id: 'c-flip' }, data: { status: 'ENABLED', lastSyncedAt: new Date() } }))
    expect((await inside(() => endBrainOwnershipOfArchived(new Date(Date.now() + 25 * HOUR)))).campaigns).not.toContain('c-flip')
    expect(await enrollmentOf('c-flip')).toMatchObject({ mode: 'LIVE' })
    expect(await overrideOf('o-flip')).toMatchObject({ endedAt: null })
  })

  it('the state tick runs it first and records a run only when it ended something', async () => {
    rec.runs = []
    await inside(() => runBrainStateTick(new Date(NOW.getTime() + 2 * HOUR))) // nothing due, no product watched
    expect(rec.runs).toEqual([])
    await inside(async () => {
      await campaign('c-later', 'ARCHIVED', ago(48))
      await nexusArchive('c-later', ago(48))
      await override('o-later', 'CAMPAIGN', 'c-later')
    })
    await inside(() => runBrainStateTick(NOW))
    expect(rec.runs).toEqual([{ job: BRAIN_STATE_JOB, summary: 'archived campaigns left the brain: 1 (enrollments to shadow 0, overrides ended 1)' }])
    expect(await overrideOf('o-later')).toMatchObject({ endedBy: CAMPAIGN_ARCHIVED_BY })
  })
})
