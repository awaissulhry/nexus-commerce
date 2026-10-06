/**
 * ADS PLAYBOOK PB-5b — START and STOP of a built playbook (start.ts), on a real PostgreSQL with the production schema and
 * every business policy (PGlite), business profiles ON. The writers that reach Amazon are stand-ins that record what
 * they were asked, in order, and write the value as Amazon would accept it (the gate and the queue are the mutation
 * layer's own tests); the allowlist switch too. Values are made up (public repo).
 *
 *   order      allowlist → planned bids → placements, campaign by campaign, then the portfolio repair, then the
 *              artifacts switched on; the row RUNNING
 *   bids       each goes back to the bid remembered, held under the highest bid but never above what was planned; a bid
 *              that left the floor since stays where it is, named
 *   engines    a campaign an engine floored stays at its floor (named "held by"); an ad group at its own floor stays
 *   paused     a campaign paused at Amazon is prepared, never enabled; an adopted campaign is left as it is
 *   again      a second START writes nothing
 *   stop       every bid to the floor (remembered again) BEFORE the artifacts are switched off, off the allowlist; the
 *              row STOPPED; a START after it puts the same bids back (an engine's floor is never lifted)
 *   review     an adopted campaign's hourly-plan floor the stop takes over is recorded and given back by START (only
 *              there); a stop after a half-done start floors the bids it put back first; a stop by rule never claims a
 *              floor the gate would refuse; START switches nothing on when no built campaign runs
 *   rules      the playbook's own rule compiler records its stop (PLAYBOOK_STOP_METRIC), so the next START switches the
 *              rule on again — a person's switch-off after it still holds
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedProductPlaybook } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})

/** Every write that would reach Amazon (or open a campaign to the engines), in order. */
const writes = vi.hoisted(() => ({ log: [] as Array<{ what: string; id: string; value?: unknown; actor?: string; manual?: boolean; changeSetId?: string | null }>, refuseAllowlist: false }))
vi.mock('../ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateAdGroupWithSync: vi.fn(async (a: { adGroupId: string; patch: { defaultBidCents: number }; actor: string; manual?: boolean; changeSetId?: string | null }) => {
    writes.log.push({ what: 'adGroupBid', id: a.adGroupId, value: a.patch.defaultBidCents, actor: a.actor, manual: a.manual, changeSetId: a.changeSetId })
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  }),
  updateAdTargetWithSync: vi.fn(async (a: { adTargetId: string; patch: { bidCents: number }; actor: string; manual?: boolean; changeSetId?: string | null }) => {
    writes.log.push({ what: 'targetBid', id: a.adTargetId, value: a.patch.bidCents, actor: a.actor, manual: a.manual, changeSetId: a.changeSetId })
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  }),
}))
vi.mock('../campaign-settings.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setLiveWrites: vi.fn(async (campaignId: string, enabled: boolean, actor: string) => {
    if (writes.refuseAllowlist) return { status: 404, error: 'campaign not found' }
    writes.log.push({ what: enabled ? 'allowlistOn' : 'allowlistOff', id: campaignId, actor })
    await database.client.campaign.update({ where: { id: campaignId }, data: { liveBidWritesEnabled: enabled } })
    return { value: { ok: true, campaignId, liveBidWritesEnabled: enabled } }
  }),
}))
vi.mock('../ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updatePlacementBidding: vi.fn(async (input: { campaignId: string; adjustments: Array<{ placement: string; percentage: number }>; actor: string; changeSetId?: string | null; manual?: boolean }) => {
    writes.log.push({ what: 'placements', id: input.campaignId, value: input.adjustments, actor: input.actor, manual: input.manual, changeSetId: input.changeSetId })
    const c = await database.client.campaign.findUniqueOrThrow({ where: { id: input.campaignId }, select: { dynamicBidding: true } })
    await database.client.campaign.update({ where: { id: input.campaignId }, data: { dynamicBidding: { ...((c.dynamicBidding ?? {}) as object), placementBidding: input.adjustments } } })
    return { ok: true, adjustments: input.adjustments, mode: 'sandbox' }
  }),
  settleLaunchPortfolios: vi.fn(async (ids: string[]) => { writes.log.push({ what: 'portfolioRepair', id: ids.join(',') }); return null }),
}))

import { planStart, runStart, runStop, type StartPlan } from './start.js'
import { ARTIFACT_COMPILERS, type ArtifactCompiler } from './artifacts.js'
import { ensureCompiledRule } from './rules.js'
import { playbookHolds, STOP_FLOOR_KIND } from './held.js'
import { plannedGiveBack } from '../ads-bid-suppression.service.js'

const A = 'pb5b_start_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const writer = { via: 'claude', actor: 'user:u-approver', actorUserId: 'u-approver', approvalId: 'ap-start', updatedBy: 'claude:ap-start' }
const run = { actor: 'user:u-approver' as const, reason: 'Claude request ap-start: start the test playbook', changeSetId: 'ap-start', manual: true }

/** The rank engine's own floor owner in these tests (rank.ts hands such floors to whoever switches the plan off). */
const RANK_OWNER = 'automation:rank-plan-test'
/** A compiler on the hook that records its switch in the same log as the writes; switched off, it hands rank's floors over as rank.ts does. */
const switched: ArtifactCompiler = {
  kind: 'rankGroup',
  preview: async (ctx) => [{ kind: 'rankGroup', key: 'rank:performance', does: ctx.mode === 'stop' ? 'disable' : 'enable', summary: 'a test hourly plan' }],
  compile: async () => ({ links: [], errors: [] }),
  setEnabled: async (ctx, _links, enabled) => {
    writes.log.push({ what: enabled ? 'artifactsOn' : 'artifactsOff', id: ctx.playbookId, actor: ctx.actor })
    if (!enabled) await database.client.campaign.updateMany({ where: { id: { in: ctx.slots.map((x) => x.campaignId) }, bidsSuppressedBy: RANK_OWNER }, data: { bidsSuppressedBy: ctx.actor } })
    return { changed: [`rank:performance ${enabled ? 'on' : 'off'}`], errors: [] }
  },
}
const compilers = [switched]

let seeded: Awaited<ReturnType<typeof seedProductPlaybook>>
const ids: Record<string, { campaign: string; group: string; target: string }> = {}

/** A campaign as a build leaves it: ENABLED at the 2¢ floor (planned bids remembered, floored by the asker), off the allowlist. */
async function built(slot: string, opts: { status?: 'ENABLED' | 'PAUSED'; by?: string; groupBid?: number; targetBid?: number; remembered?: [number, number]; origin?: 'built' | 'adopted'; liveWrites?: boolean; floored?: boolean } = {}) {
  const name = `TESTPB5B | IT | ${slot}`
  const floored = opts.floored !== false
  const [groupMemory, targetMemory] = opts.remembered ?? [40, 55]
  const c = await db().campaign.create({ data: {
    name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: `AMZ-${slot}`,
    status: opts.status ?? 'ENABLED', liveBidWritesEnabled: opts.liveWrites ?? false,
    ...(floored ? { bidsSuppressedAt: new Date(), bidsSuppressedBy: opts.by ?? 'user:u-asker', bidsSuppressedFloorCents: 2 } : {}),
  } })
  const g = await db().adGroup.create({ data: { campaignId: c.id, name: `${slot} group`, externalAdGroupId: `AMZ-G-${slot}`, defaultBidCents: floored ? opts.groupBid ?? 2 : 40, ...(floored ? { suppressedFromBidCents: groupMemory } : {}) } })
  const t = await db().adTarget.create({ data: { adGroupId: g.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test ${slot} term`, externalTargetId: `AMZ-T-${slot}`, bidCents: floored ? opts.targetBid ?? 2 : 55, ...(floored ? { suppressedFromBidCents: targetMemory } : {}) } })
  await db().adsPlaybookLink.create({ data: { playbookId: seeded.rowId, kind: 'slot', key: slot, refId: c.id, adGroupId: g.id, origin: opts.origin ?? 'built', compiledVersion: 1, updatedBy: 'user:test' } })
  ids[slot] = { campaign: c.id, group: g.id, target: t.id }
}

const plan = async (op: 'start' | 'stop', slots?: string[]): Promise<StartPlan> => {
  const out = await inA(() => planStart({ op, market: 'IT', productId: seeded.parent, slots }, { compilers }))
  if ('error' in out) throw new Error(out.error)
  return out.data
}
const bidsOf = (slot: string) => inA(async () => {
  const g = await db().adGroup.findUniqueOrThrow({ where: { id: ids[slot].group } })
  const t = await db().adTarget.findUniqueOrThrow({ where: { id: ids[slot].target } })
  const c = await db().campaign.findUniqueOrThrow({ where: { id: ids[slot].campaign } })
  return { group: [g.defaultBidCents, g.suppressedFromBidCents], target: [t.bidCents, t.suppressedFromBidCents], liveWrites: c.liveBidWritesEnabled, floorBy: c.bidsSuppressedAt ? c.bidsSuppressedBy : null, status: String(c.status) }
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    seeded = await seedProductPlaybook(db(), { token: 'TESTPB5B', asinPrefix: 'B0TESTSB' })
    await db().adsPlaybook.update({ where: { id: seeded.rowId }, data: { state: 'BUILT' } })
    await built('exact-category', { remembered: [40, 150] })              // the target's planned bid is above the strategy's highest (100)
    await built('broad-category', { targetBid: 35 })                       // a person moved the target off the floor since the build
    await built('auto', { by: 'automation:dayparting-test' })              // an engine's floor
    await built('pat', { status: 'PAUSED' })                               // paused at Amazon
    await built('exact-brand', { origin: 'adopted', floored: false, liveWrites: false }) // the business's own campaign
    // An ad group at its own floor (stock) inside the Exact Category campaign.
    const own = await db().adGroup.create({ data: { campaignId: ids['exact-category'].campaign, name: 'exact-category stock group', defaultBidCents: 2, suppressedFromBidCents: 45, bidsSuppressedAt: new Date(), bidsSuppressedBy: 'automation:stock-test', bidsSuppressedFloorCents: 2 } })
    ids.own = { campaign: ids['exact-category'].campaign, group: own.id, target: ids['exact-category'].target }
    await db().adBlueprintApplication.create({ data: {
      productToken: 'TESTPB5B', marketplace: 'IT', status: 'APPLIED', plan: {}, playbookId: seeded.rowId, createdCampaignIds: [ids['exact-category'].campaign],
      options: { source: 'playbook', deferredPlacements: [{ slot: 'exact-category', campaignId: ids['exact-category'].campaign, placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 25 }] }] },
    } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('the planned give-back (pure)', () => {
  const band = (max: number | null, min: number | null) => ({ max: max == null ? null : { value: max, source: 'test highest' }, min: min == null ? null : { value: min, source: 'test lowest' } }) as never
  it('the bid remembered; held under a highest bid; never ABOVE what was planned; a bid off the floor is left', () => {
    expect(plannedGiveBack(40, 2, 2, band(null, null))).toEqual({ cents: 40, heldBy: null })
    expect(plannedGiveBack(150, 2, 2, band(100, null))).toMatchObject({ cents: 100, heldBy: expect.stringContaining('test highest') })
    expect(plannedGiveBack(30, 2, 2, band(null, 50))).toEqual({ cents: 30, heldBy: null })
    expect(plannedGiveBack(40, 35, 2, band(null, null))).toEqual({ left: true })
  })
})

describe('START', () => {
  it('the preview: what each built campaign gets, the engine floor and the own floor held, the paused and the adopted named', async () => {
    const p = await plan('start')
    const by = Object.fromEntries(p.campaigns.map((c) => [c.slot, c]))
    expect(Object.keys(by).sort()).toEqual(['auto', 'broad-category', 'exact-category', 'pat'])
    expect(by['exact-category']).toMatchObject({ allowlist: 'on', ownFloors: 1, placements: { does: 'apply', adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 25 }] }, spends: true })
    expect(by['exact-category'].bids).toMatchObject({ does: 'restore', adGroups: 1, targets: 1, highestCents: 100, held: [expect.objectContaining({ rememberedCents: 150, toCents: 100 })] })
    expect(by['broad-category'].bids).toMatchObject({ does: 'restore', adGroups: 1, targets: 0, left: [{ text: '"test broad-category term"', bidCents: 35, rememberedCents: 55 }] })
    // On the allowlist, but its engine's floor holds it: it does not start spending.
    expect(by.auto).toMatchObject({ allowlist: 'on', bids: { does: 'held', by: 'automation:dayparting-test' }, spends: false })
    expect(by.pat).toMatchObject({ status: 'PAUSED', paused: expect.stringMatching(/never enables it/), spends: false })
    expect(p.untouched).toEqual([expect.objectContaining({ slot: 'exact-brand', why: expect.stringMatching(/^adopted: .* left as they are .*off the live-write allowlist/) })])
    expect(p.highestRestoredBidCents).toBe(100)
    expect(p.spending).toBe(2)
    expect(p.artifacts).toEqual([expect.objectContaining({ kind: 'rankGroup', does: 'enable' })])
    expect(p.warnings.join(' ')).toMatch(/never lifts an engine's floor/)
    expect(writes.log).toEqual([])
  })

  it('runs in order — allowlist, planned bids, placements; then the portfolio repair; then the artifacts; the row RUNNING', async () => {
    const p = await plan('start')
    const out = await inA(() => runStart(p, run, writer, { compilers }))
    expect(out).toMatchObject({ failed: [], errors: [], state: 'RUNNING' })
    expect(out.done.sort()).toEqual(['auto', 'broad-category', 'exact-category', 'pat'])
    expect(out.left).toEqual([expect.objectContaining({ slot: 'broad-category', bidCents: 35, rememberedCents: 55 })])
    const exact = ids['exact-category']
    const steps = writes.log.filter((w) => w.id === exact.campaign || w.id === exact.group || w.id === exact.target).map((w) => w.what)
    expect(steps).toEqual(['allowlistOn', 'adGroupBid', 'targetBid', 'placements'])
    const whats = writes.log.map((w) => w.what)
    expect(whats.indexOf('portfolioRepair')).toBeGreaterThan(whats.lastIndexOf('placements'))
    expect(whats.at(-1)).toBe('artifactsOn')
    // Every write is the approver's, his click (manual), with the approval's change set.
    expect(writes.log.filter((w) => w.what.endsWith('Bid') || w.what === 'placements').every((w) => w.actor === 'user:u-approver' && w.manual === true && w.changeSetId === 'ap-start')).toBe(true)
    expect(await bidsOf('exact-category')).toMatchObject({ group: [40, null], target: [100, null], liveWrites: true, floorBy: null })
    // The bid a person moved stays where he put it; its memory is dropped, the campaign's floor lifted.
    expect(await bidsOf('broad-category')).toMatchObject({ group: [40, null], target: [35, null], floorBy: null })
    // The engine's floor stays; the campaign is on the allowlist (the engine lifts its own floor when its reason ends).
    expect(await bidsOf('auto')).toMatchObject({ group: [2, 40], target: [2, 55], liveWrites: true, floorBy: 'automation:dayparting-test' })
    // Paused: prepared, never enabled.
    expect(await bidsOf('pat')).toMatchObject({ group: [40, null], status: 'PAUSED', liveWrites: true })
    // The ad group at its own floor stays; the adopted campaign is untouched.
    expect((await inA(() => db().adGroup.findUniqueOrThrow({ where: { id: ids.own.group } })))).toMatchObject({ defaultBidCents: 2, suppressedFromBidCents: 45, bidsSuppressedBy: 'automation:stock-test' })
    expect(await bidsOf('exact-brand')).toMatchObject({ liveWrites: false })
    expect(writes.log.some((w) => w.id === ids['exact-brand'].campaign)).toBe(false)
    const placements = (await inA(() => db().campaign.findUniqueOrThrow({ where: { id: exact.campaign } }))).dynamicBidding as { placementBidding: unknown }
    expect(placements.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 25 }])
    const row = await inA(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: seeded.rowId } }))
    expect(row).toMatchObject({ state: 'RUNNING', version: 2 })
    expect(await inA(() => db().adsPlaybookVersion.findFirst({ where: { refId: seeded.rowId, op: 'start' } }))).toMatchObject({ approvalId: 'ap-start', actor: 'user:u-approver' })
  })

  it('a second START writes nothing: each step skips what is done', async () => {
    const before = writes.log.length
    const p = await plan('start')
    expect(p.campaigns.every((c) => c.allowlist === 'already' && c.bids.does !== 'restore' && c.placements.does !== 'apply')).toBe(true)
    const out = await inA(() => runStart(p, run, writer, { compilers }))
    expect(out.done).toEqual([])
    expect(writes.log.slice(before).map((w) => w.what).filter((w) => w !== 'portfolioRepair' && w !== 'artifactsOn')).toEqual([])
  })
})

describe('STOP', () => {
  it('floors every bid (remembered again) and takes the campaigns off the allowlist BEFORE the artifacts; the row STOPPED', async () => {
    writes.log.length = 0
    const p = await plan('stop')
    const by = Object.fromEntries(p.campaigns.map((c) => [c.slot, c]))
    expect(by['exact-category']).toMatchObject({ allowlist: 'off', bids: { does: 'floor', adGroups: 1, targets: 1 } })
    expect(by.auto).toMatchObject({ allowlist: 'off', bids: { does: 'none', why: expect.stringMatching(/automation:dayparting-test/) } })
    expect(p.artifacts).toEqual([expect.objectContaining({ does: 'disable' })])
    const out = await inA(() => runStop(p, { ...run, changeSetId: 'ap-stop' }, { ...writer, approvalId: 'ap-stop' }, { compilers }))
    expect(out).toMatchObject({ failed: [], errors: [], state: 'STOPPED' })
    const whats = writes.log.map((w) => w.what)
    expect(whats.at(-1)).toBe('artifactsOff')
    expect(whats.lastIndexOf('targetBid')).toBeLessThan(whats.indexOf('artifactsOff'))
    expect(whats.filter((w) => w === 'allowlistOff')).toHaveLength(4)
    expect(whats).not.toContain('placements')
    expect(await bidsOf('exact-category')).toMatchObject({ group: [2, 40], target: [2, 100], liveWrites: false, floorBy: 'user:u-approver', status: 'ENABLED' })
    expect(await bidsOf('broad-category')).toMatchObject({ target: [2, 35], floorBy: 'user:u-approver' })
    // The engine's floor stays the engine's (the test compiler hands nothing over; rank.ts does for its own floors).
    expect(await bidsOf('auto')).toMatchObject({ group: [2, 40], target: [2, 55], liveWrites: false, floorBy: 'automation:dayparting-test' })
    expect((await inA(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: seeded.rowId } }))).state).toBe('STOPPED')
  })

  it('a START after the stop puts the same bids back (the stop\'s floor is a person\'s, his approver\'s)', async () => {
    const p = await plan('start')
    expect(p.campaigns.find((c) => c.slot === 'broad-category')!.bids).toMatchObject({ does: 'restore', targets: 1, left: [] })
    const out = await inA(() => runStart(p, run, writer, { compilers }))
    expect(out.state).toBe('RUNNING')
    expect(await bidsOf('exact-category')).toMatchObject({ group: [40, null], target: [100, null], liveWrites: true })
    expect(await bidsOf('broad-category')).toMatchObject({ target: [35, null] })
    // An engine's floor is never lifted by START.
    expect(await bidsOf('auto')).toMatchObject({ group: [2, 40], target: [2, 55], floorBy: 'automation:dayparting-test' })
  })

  it('a stop of some slots leaves the artifacts on while another built campaign still runs; the row stays RUNNING', async () => {
    writes.log.length = 0
    const p = await plan('stop', ['exact-category'])
    const out = await inA(() => runStop(p, run, writer, { compilers }))
    expect(out.done).toEqual(['exact-category'])
    expect(out.errors.join(' ')).toMatch(/still run .*stay on, and the row stays RUNNING/)
    expect(writes.log.map((w) => w.what)).not.toContain('artifactsOff')
    expect(out.state).toBe('RUNNING')
  })

  it('refused slots: one the playbook holds no campaign for, and an adopted one', async () => {
    expect((await plan('stop', ['nope'])).problems).toEqual(['the playbook holds no live campaign for slot "nope"'])
    expect((await plan('start', ['exact-brand'])).problems[0]).toMatch(/^slot "exact-brand" was adopted, not built/)
  })
})

describe('review fixes', () => {
  it('🔴 an adopted campaign whose hourly plan\'s floor the stop takes over gets its bids back at START, and only there', async () => {
    // The adopted campaign sits at a floor its hourly plan set (rank's own owner), its bids remembered.
    await inA(async () => {
      await db().campaign.update({ where: { id: ids['exact-brand'].campaign }, data: { bidsSuppressedAt: new Date(), bidsSuppressedBy: RANK_OWNER, bidsSuppressedFloorCents: 2 } })
      await db().adGroup.update({ where: { id: ids['exact-brand'].group }, data: { defaultBidCents: 2, suppressedFromBidCents: 40 } })
      await db().adTarget.update({ where: { id: ids['exact-brand'].target }, data: { bidCents: 2, suppressedFromBidCents: 55 } })
    })
    const stopped = await inA(async () => runStop(await plan('stop'), run, writer, { compilers }))
    expect(stopped).toMatchObject({ state: 'STOPPED', floorsHeld: ['exact-brand'] })
    expect(await inA(() => db().adsPlaybookLink.findFirst({ where: { kind: STOP_FLOOR_KIND, refId: ids['exact-brand'].campaign } }))).toMatchObject({ playbookId: seeded.rowId, origin: 'adopted', updatedBy: 'user:u-approver' })
    expect(await inA(() => playbookHolds([ids['exact-brand'].campaign]))).toEqual(new Map([[ids['exact-brand'].campaign, 'held']]))
    const p = await plan('start')
    expect(p.heldFloors).toEqual([expect.objectContaining({ slot: 'exact-brand', origin: 'adopted', bids: expect.objectContaining({ adGroups: 1, targets: 1 }) })])
    expect(p.warnings.join(' ')).toMatch(/\(adopted\) is at the floor its hourly plan set, which the playbook's stop holds: START gives its bids back/)
    const started = await inA(() => runStart(p, run, writer, { compilers }))
    expect(started.done).toContain('exact-brand')
    // Its bids are back; nothing else of it moved (still off the allowlist: the business's own switch); the link is gone.
    expect(await bidsOf('exact-brand')).toMatchObject({ group: [40, null], target: [55, null], floorBy: null, liveWrites: false })
    expect(await inA(() => db().adsPlaybookLink.count({ where: { kind: STOP_FLOOR_KIND } }))).toBe(0)
  })

  it('🔴 a stop after a start that did not finish floors the bids it put back again, before the campaign leaves the allowlist', async () => {
    // Half started: on the allowlist, still flagged at the floor, the target already at its planned bid (memory gone).
    await inA(async () => {
      await db().campaign.update({ where: { id: ids['broad-category'].campaign }, data: { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'user:u-approver', bidsSuppressedFloorCents: 2, liveBidWritesEnabled: true } })
      await db().adGroup.update({ where: { id: ids['broad-category'].group }, data: { defaultBidCents: 2, suppressedFromBidCents: 40 } })
      await db().adTarget.update({ where: { id: ids['broad-category'].target }, data: { bidCents: 35, suppressedFromBidCents: null } })
    })
    writes.log.length = 0
    const p = await plan('stop', ['broad-category'])
    expect(p.campaigns[0]).toMatchObject({ allowlist: 'off', bids: { does: 'refloor', floorCents: 2, adGroups: 0, targets: 1 }, spends: true })
    expect(p.warnings.join(' ')).toMatch(/a start that did not finish/)
    const out = await inA(() => runStop(p, run, writer, { compilers }))
    expect(out.done).toEqual(['broad-category'])
    expect(writes.log.map((w) => w.what)).toEqual(['targetBid', 'allowlistOff'])
    expect(await bidsOf('broad-category')).toMatchObject({ group: [2, 40], target: [2, 35], liveWrites: false })
  })

  it('a stop by rule does not claim a floor the write gate would refuse: a campaign off the allowlist waits for a person', async () => {
    await inA(() => db().campaign.update({ where: { id: ids.pat.campaign }, data: { liveBidWritesEnabled: false } }))
    const out = await inA(async () => runStop(await plan('stop', ['pat']), { ...run, manual: false }, writer, { compilers }))
    expect(out.failed).toEqual([expect.objectContaining({ slot: 'pat', why: expect.stringMatching(/off the live-write allowlist, so a stop by rule cannot lower its bids/) })])
    expect((await bidsOf('pat')).floorBy).toBeNull()
  })

  it('START switches the playbook\'s plans and rules on only once a campaign it built runs', async () => {
    // Every built campaign off the allowlist, and the allowlist refuses them all: nothing starts, nothing is switched on.
    await inA(() => db().campaign.updateMany({ where: { id: { in: ['exact-category', 'broad-category', 'auto', 'pat'].map((k) => ids[k].campaign) } }, data: { liveBidWritesEnabled: false } }))
    writes.log.length = 0
    writes.refuseAllowlist = true
    try {
      const out = await inA(async () => runStart(await plan('start'), run, writer, { compilers }))
      expect(out.failed).toHaveLength(4)
      expect(writes.log.map((w) => w.what)).not.toContain('artifactsOn')
      expect(out.errors.join(' ')).toMatch(/no campaign the playbook built runs after this start: its hourly plans and rules stay off/)
    } finally { writes.refuseAllowlist = false }
  })
})

describe('the playbook\'s own rules', () => {
  it('its compiler\'s stop is recorded as the playbook\'s: the next START switches the rule on again; a person\'s switch-off after it holds', async () => {
    const action = { type: 'harvest_and_negate', v: 2, playbookId: seeded.rowId, market: 'IT', sources: [] }
    const save = (start: boolean) => inA(() => ensureCompiledRule({ playbookId: seeded.rowId, kind: 'harvestRule', key: 'harvest', name: 'TESTPB5B (IT) — playbook harvest', action, enabled: false, start, compiledVersion: 3, actor: 'user:u-approver' }))
    const { ruleId } = await save(true)
    const harvest = ARTIFACT_COMPILERS.find((c) => c.kind === 'harvestRule')!
    const ctx = { playbookId: seeded.rowId, market: 'IT', productId: seeded.parent, nameToken: 'TESTPB5B', doc: {} as never, slots: [], mode: 'stop' as const, actor: 'user:u-stopper' as const, changeSetId: 'ap-stop', compiledVersion: 3 }
    const links = [{ key: 'harvest', refId: ruleId }]
    expect(await inA(() => harvest.preview(ctx, links))).toEqual([expect.objectContaining({ does: 'disable' })])
    expect(await inA(() => harvest.setEnabled(ctx, links, false))).toEqual({ changed: [ruleId], errors: [] })
    expect(await inA(() => db().advertisingActionLog.findFirst({ where: { entityId: ruleId, actionType: 'update_rule' }, orderBy: { createdAt: 'desc' } }))).toMatchObject({
      userId: 'user:u-stopper', payloadAfter: { enabled: false }, evidence: expect.objectContaining({ metric: 'playbook_stop' }),
    })
    expect(await inA(() => harvest.setEnabled(ctx, links, false))).toEqual({ changed: [], errors: [] })
    expect(await save(true)).toMatchObject({ enabled: true })
    // Stopped again, then a person switches it on and off: his switch-off holds.
    await inA(() => harvest.setEnabled(ctx, links, false))
    await new Promise((r) => setTimeout(r, 5))
    await inA(async () => {
      await db().automationRule.update({ where: { id: ruleId }, data: { enabled: true } })
      await db().advertisingActionLog.create({ data: { userId: 'user:owner-test', actionType: 'update_rule', entityType: 'RULE', entityId: ruleId, payloadBefore: { enabled: false }, payloadAfter: { enabled: true }, amazonResponseStatus: 'SUCCESS' } })
      await db().automationRule.update({ where: { id: ruleId }, data: { enabled: false } })
      await db().advertisingActionLog.create({ data: { userId: 'user:owner-test', actionType: 'update_rule', entityType: 'RULE', entityId: ruleId, payloadBefore: { enabled: true }, payloadAfter: { enabled: false }, amazonResponseStatus: 'SUCCESS' } })
    })
    expect(await save(true)).toMatchObject({ enabled: false, keptOff: expect.stringContaining('user:owner-test') })
  })
})
