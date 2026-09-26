/**
 * S2 (2026-09-26) — the 20-minute settings sync closes a drift row only for a field it compared, on a real
 * PostgreSQL (PGlite with the production schema and policies). Only the Amazon read is stubbed.
 *
 * It used to close every open CAMPAIGN row whose field was not drifting in this read: rows it never compares
 * (name, state, existence — the structural reconcile's) and rows for fields Amazon left out of the response.
 * A row closed that way was closed on ignorance, not evidence.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, amazon: [] as unknown[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('./ads-api-client.js', () => ({ listCampaignsV3: vi.fn(async () => state.amazon) }))
vi.mock('./ads-mutation.service.js', () => ({ pendingWriteFieldsByEntity: vi.fn(async () => new Map()) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { syncCampaignSettingsFromAmazon } from './ads-campaign-settings-sync.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const FIELDS = ['status', 'dailyBudget', 'portfolioId', 'name', 'state', 'existence', 'targetingType', 'biddingStrategy']
let campaignId = ''

beforeAll(() => scoped(async () => {
  await prisma.amazonAdsConnection.create({ data: { profileId: 'profile-it', marketplace: 'IT', region: 'EU', isActive: true } })
  campaignId = (await prisma.campaign.create({ data: {
    name: 'Boots', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'C-EXT',
    status: 'ENABLED', dailyBudget: 10, biddingStrategy: 'MANUAL', portfolioId: '111', startDate: new Date('2026-01-01'),
  } })).id
  for (const field of FIELDS) {
    await prisma.adDrift.create({ data: { entityType: 'CAMPAIGN', entityId: campaignId, field, ourValue: 'x', amazonValue: 'y', classification: 'EXTERNAL_CHANGE' } })
  }
  // Amazon agrees on state and budget, reports no bidding strategy, and holds no portfolio.
  state.amazon = [{ campaignId: 'C-EXT', name: 'Boots', state: 'ENABLED', budget: { budget: 10 }, targetingType: 'MANUAL' }]
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('closes only the fields it compared and found agreeing; every other open row stays open', async () => {
  const r = await scoped(() => syncCampaignSettingsFromAmazon())
  expect(r.errors).toEqual([])
  expect(r.campaigns).toBe(1)
  const rows = await scoped(() => prisma.adDrift.findMany({ where: { entityId: campaignId }, select: { field: true, resolvedAt: true, amazonValue: true } }))
  const closed = rows.filter((x) => x.resolvedAt).map((x) => x.field).sort()
  const open = rows.filter((x) => !x.resolvedAt).map((x) => x.field).sort()
  expect(closed).toEqual(['dailyBudget', 'status'])
  // name/state/existence: the reconcile's rows. targetingType: not compared here. biddingStrategy: not reported.
  // portfolioId: still differs (ours 111, Amazon none) and was seen again.
  expect(open).toEqual(['biddingStrategy', 'existence', 'name', 'portfolioId', 'state', 'targetingType'])
  expect(rows.find((x) => x.field === 'portfolioId')?.amazonValue).toBeNull()
})
