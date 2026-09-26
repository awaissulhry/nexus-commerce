/**
 * S1 (2026-09-26) — the ads integrity check per business profile, on a real PostgreSQL (PGlite with the production
 * schema and every policy).
 *
 * Production's public health showed ADS_SETTINGS_SYNC_NEVER as CRITICAL from a profile with no campaigns and no Ads
 * connection. That profile can never have a sync time: the settings sync has nothing there to verify. What decides it
 * is a count — Sponsored Products campaigns, not archived, holding an Amazon id, the only campaigns the sync can
 * stamp — so the count is measured here in the database rather than mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withWorkspace } from '../../lib/workspace-context.js'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const business = (id: string) => state.db.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])

describe('S1 — the settings-sync checks run only where there is something to sync', () => {
  let service: typeof import('./ads-sync-integrity.service.js')
  let prisma: typeof import('../../db.js').default
  const inProfile = <T>(id: string, work: () => Promise<T>) => withWorkspace(scope(id), work)
  const campaign = (name: string, over: Record<string, unknown>) => prisma.campaign.create({
    data: { name, type: 'SP', dailyBudget: 10, startDate: new Date('2026-01-01'), marketplace: 'IT', status: 'ENABLED', adProduct: 'SPONSORED_PRODUCTS', ...over } as never,
  })

  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    service = await import('./ads-sync-integrity.service.js')
    prisma = (await import('../../db.js')).default
    for (const id of ['EMPTY', 'SD_SB_ONLY', 'SP_LIVE']) {
      await business(id)
      // Every profile's reconcile ran, so the only possible finding left is the one under test.
      await inProfile(id, () => prisma.cronRun.create({ data: { jobName: 'ads-structural-reconcile', status: 'SUCCESS', finishedAt: new Date() } }))
    }
    await inProfile('SD_SB_ONLY', async () => {
      // None of these can ever be stamped by the SP-only settings sync.
      await campaign('display', { type: 'SD', adProduct: 'SPONSORED_DISPLAY', externalCampaignId: 'SD-1' })
      await campaign('brands', { type: 'SB', adProduct: 'SPONSORED_BRANDS', externalCampaignId: 'SB-1', status: 'PAUSED' })
      await campaign('archived products', { externalCampaignId: 'SP-ARCH', status: 'ARCHIVED' })
      await campaign('never sent', { externalCampaignId: null })
    })
    await inProfile('SP_LIVE', async () => {
      await campaign('products', { externalCampaignId: 'SP-1' })
      // No adProduct: the launch verifier reads it as Sponsored Products, so the sync may stamp it too.
      await campaign('legacy row', { adProduct: null, externalCampaignId: 'SP-2', status: 'PAUSED' })
      await campaign('display', { type: 'SD', adProduct: 'SPONSORED_DISPLAY', externalCampaignId: 'SD-2' })
    })
  }, 120_000)
  afterAll(async () => { vi.unstubAllEnvs(); await state.db?.close() }, 30_000)

  const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code)

  it('a profile with no campaigns and no connection is healthy, not CRITICAL', async () => {
    const r = await inProfile('EMPTY', () => service.runSyncIntegrityCheck())
    expect(codes(r)).toEqual([])
    expect(r.severity).toBe('OK')
    expect(r.snapshot.minutesSinceSettingsSync).toBeNull()
    expect(r.snapshot.settingsSyncScope).toBe(0)
  })

  it('a profile with only Display, Brands, archived or never-sent campaigns raises no settings-sync finding', async () => {
    const r = await inProfile('SD_SB_ONLY', () => service.runSyncIntegrityCheck())
    expect(codes(r)).not.toContain('ADS_SETTINGS_SYNC_NEVER')
    expect(codes(r)).not.toContain('ADS_SETTINGS_SYNC_STALE')
    expect(r.snapshot.settingsSyncScope).toBe(0)
  })

  it('positive control: live Sponsored Products campaigns that were never verified are still CRITICAL', async () => {
    const r = await inProfile('SP_LIVE', () => service.runSyncIntegrityCheck())
    expect(codes(r)).toContain('ADS_SETTINGS_SYNC_NEVER')
    expect(r.severity).toBe('CRITICAL')
    expect(r.snapshot.settingsSyncScope).toBe(2)
  })
})
