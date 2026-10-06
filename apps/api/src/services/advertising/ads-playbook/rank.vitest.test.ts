/**
 * ADS PLAYBOOK PB-8 — the playbook's rank roles as hourly bid plans (rank.ts), on a real PostgreSQL with the production
 * schema and every business policy (PGlite), business profiles ON. The Hourly Bids writer (saveRankScheduleGroup) and
 * its give-back on a save switched off, the strategy read (the phase) and auto-bid's holders are the real ones; nothing
 * reaches Amazon (no floor here is one an hourly plan set, so nothing is given back). Values are made up (public repo).
 *
 *   build      one group per rank role, its members this product's linked campaigns of that role only, born OFF with its
 *              schedules, read back; another product's campaign and a slot with no rank role are left out; the build's
 *              own floor stays
 *   again      a second compile keeps; a campaign gone leaves; a group renamed and re-timed on Hourly Bids keeps both
 *   Owner      a campaign in an hourly plan the playbook did not make (a group, its own schedule, a portfolio group, a
 *              product plan), a group with the name it would get, bids an earlier plan left: the role is refused by name,
 *              and the Owner's plan reads back exactly as before
 *   start      START switches on as the phase says (none set: research only, performance needs a goal; DEFEND: performance
 *              only), STOP off; a plan that is on takes a new campaign only at START
 *   one owner  auto-bid leaves a campaign whose playbook plan is on, and holds nothing on it once the plan is off
 *   nothing    STOP inside a Min-bid window: rank's floor stays (handed to the approver, remembered for START); a base-bid
 *   rises      change rank made downward stays, one it made upward goes back down; top of search named as last set; the
 *              classifier says the same, and calls a give-back a raise (a phase that gives back: bids come back)
 *   plans      a campaign that also advertises another product an Owner's product rank plan governs (resolved as the engine
 *              resolves it): refused; one the plan excludes: free
 *   adopt      an unbind from a plan that is on saves nothing (it leaves at STOP); a build takes it out, nothing rises
 *   race       a same-name group made between the plan and the save is never taken over
 *   hook       ARTIFACT_COMPILERS holds the compiler
 *
 * The give-back is the real one (rank-release.service.ts, the dial on AUTO, Rank & Dayparting on), its bid writes a
 * recorder that applies each bid to the database — so a test that a bid did not rise is a test of the real give-back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedProductPlaybook, templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

vi.mock('../ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
// The give-back's bid writes: each lands on the row, as the real service does locally (no queue, no gate, no Amazon).
const rec = vi.hoisted(() => ({ writes: [] as Array<{ id: string; bid: number; actor: string }> }))
vi.mock('../ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateAdGroupWithSync: async (a: { adGroupId: string; patch: { defaultBidCents: number }; actor: string }) => {
    rec.writes.push({ id: a.adGroupId, bid: a.patch.defaultBidCents, actor: a.actor })
    await database.client.adGroup.update({ where: { id: a.adGroupId }, data: { defaultBidCents: a.patch.defaultBidCents } })
    return { ok: true }
  },
  updateAdTargetWithSync: async (a: { adTargetId: string; patch: { bidCents: number }; actor: string }) => {
    rec.writes.push({ id: a.adTargetId, bid: a.patch.bidCents, actor: a.actor })
    await database.client.adTarget.update({ where: { id: a.adTargetId }, data: { bidCents: a.patch.bidCents } })
    return { ok: true }
  },
}))

import { ARTIFACT_COMPILERS, compileArtifacts, type ArtifactContext } from './artifacts.js'
import { applyRankPhase, classifyRankOff, loadRankFacts, planCompile, previewRankPhase, rankGroupCompiler, rankGroupName, rankOffEffect, runRankSteps } from './rank.js'
import type { TemplateDoc } from './doc.js'

const A = 'pb8_rank_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client as any
const DOC = templateDoc()
const roleOf = (doc: TemplateDoc, key: string) => doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'

type Seeded = Awaited<ReturnType<typeof seedProductPlaybook>> & { token: string; campaigns: Record<string, string> }

/** One campaign with an ad group in IT; `floored` = born at the 2¢ floor by the person who asked (as a build makes it). */
async function campaign(name: string, extra: Record<string, unknown> = {}, floored = false): Promise<string> {
  const c = await db().campaign.create({ data: {
    name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `AMZ-${name}`, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'),
    ...(floored ? { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'user:u-asker' } : {}), ...extra,
  } })
  await db().adGroup.create({ data: { campaignId: c.id, name, defaultBidCents: floored ? 2 : 30, ...(floored ? { suppressedFromBidCents: 30 } : {}) } })
  return c.id
}

/** A seeded product playbook with one campaign per slot, linked (origin given per slot; built by default). */
async function product(token: string, opts: { adopted?: string[]; extra?: Record<string, Record<string, unknown>> } = {}): Promise<Seeded> {
  return inA(async () => {
    const seeded = await seedProductPlaybook(db(), { token, asinPrefix: `B0T${token.slice(-4)}` })
    const campaigns: Record<string, string> = {}
    for (const slot of DOC.structure.slots) {
      const adopted = opts.adopted?.includes(slot.key) ?? false
      campaigns[slot.key] = await campaign(`${token} | IT | ${slot.nameParts.join(' | ')}`, opts.extra?.[slot.key] ?? {}, !adopted)
      await db().adsPlaybookLink.create({ data: { playbookId: seeded.rowId, kind: 'slot', key: slot.key, refId: campaigns[slot.key], origin: adopted ? 'adopted' : 'built', compiledVersion: 1, updatedBy: 'user:test' } })
    }
    return { ...seeded, token, campaigns }
  })
}

async function ctxOf(p: Seeded, mode: ArtifactContext['mode'], doc: TemplateDoc = DOC): Promise<ArtifactContext> {
  const links = await inA(() => db().adsPlaybookLink.findMany({ where: { playbookId: p.rowId, kind: 'slot' }, select: { key: true, refId: true, adGroupId: true, origin: true } }))
  return {
    playbookId: p.rowId, market: 'IT', productId: p.parent, nameToken: p.token, doc, mode, actor: 'user:u-approver', changeSetId: 'ap-8', compiledVersion: 1,
    slots: links.map((l: any) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId, origin: l.origin, rankRole: roleOf(doc, l.key) })),
  }
}

/** Compile through the hook as a build does, and store the links it returns (an upsert by key, as build.ts writeLink). */
async function compile(p: Seeded, mode: 'build' | 'adopt' = 'build', doc: TemplateDoc = DOC) {
  return inA(async () => {
    const out = await compileArtifacts(await ctxOf(p, mode, doc), [], [rankGroupCompiler])
    for (const l of out.links) {
      const mine = await db().adsPlaybookLink.findFirst({ where: { playbookId: p.rowId, kind: l.kind, key: l.key } })
      if (mine) await db().adsPlaybookLink.update({ where: { id: mine.id }, data: { refId: l.refId } })
      else await db().adsPlaybookLink.create({ data: { playbookId: p.rowId, kind: l.kind, key: l.key, refId: l.refId, origin: 'built', compiledVersion: 1, updatedBy: 'user:test' } })
    }
    return out
  })
}

const groupOf = (p: Seeded, role: 'performance' | 'research') => inA(async () => {
  const link = await db().adsPlaybookLink.findFirst({ where: { playbookId: p.rowId, kind: 'rankGroup', key: `rank:${role}` } })
  if (!link) return null
  const group = await db().rankScheduleGroup.findUnique({ where: { id: link.refId } })
  const schedules = await db().adSchedule.findMany({ where: { groupId: link.refId }, orderBy: { campaignId: 'asc' }, select: { campaignId: true, enabled: true, windows: true, defaultTargetKey: true, timezone: true } })
  return { group, schedules, members: schedules.map((s: any) => s.campaignId).sort() as string[] }
})
const sorted = (...ids: string[]) => [...ids].sort()

/** Everything the Owner's hourly plan is made of: its row, its schedules, its history. */
const snapshotOf = (groupId: string) => inA(async () => ({
  group: await db().rankScheduleGroup.findUnique({ where: { id: groupId } }),
  schedules: await db().adSchedule.findMany({ where: { groupId }, orderBy: { campaignId: 'asc' } }),
  versions: await db().rankScheduleVersion.count({ where: { groupId } }),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  // Ads automation on AUTO and Rank & Dayparting switched on: a give-back runs (it is not deferred), as in production.
  const { setEngineSwitch } = await import('../../automation/engine-switch.service.js')
  await inA(async () => {
    await db().adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO', halted: false } })
    await setEngineSwitch('rank-defend', 'AUTO', 'user:test')
  })
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('the name a group is created with', () => {
  it('names the product, the market and the role', () => {
    expect(rankGroupName('TESTPB8', 'IT', 'performance')).toBe('TESTPB8 | IT | Playbook Performance')
    expect(rankGroupName('TESTPB8', 'IT', 'research')).toBe('TESTPB8 | IT | Playbook Research')
  })
})

describe('a build: one hourly plan per rank role, born off', () => {
  let p: Seeded
  let other: Seeded
  beforeAll(async () => {
    p = await product('TESTPB8')
    other = await product('TESTPB8X')
  })

  it('previews two plans to create, switched off, naming their campaigns', async () => {
    const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'build'), []))
    expect(lines.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'create'], ['rank:research', 'create']])
    expect(lines[0].summary).toMatch(/^Creates the hourly plan "TESTPB8 \| IT \| Playbook Performance" for the performance campaigns "TESTPB8 \| IT \| Exact \| Category", "TESTPB8 \| IT \| Exact \| Brand" .*switched OFF with its campaigns: nothing runs until START\.$/)
    // Nothing was written by the preview.
    expect(await inA(() => db().rankScheduleGroup.count({ where: { name: { startsWith: 'TESTPB8 |' } } }))).toBe(0)
  })

  it('compiles each role into one group with an explicit list of its campaigns, off, its schedules off; read back clean', async () => {
    const out = await compile(p)
    expect(out.errors).toEqual([])
    expect(out.links.map((l) => [l.kind, l.key])).toEqual([['rankGroup', 'rank:performance'], ['rankGroup', 'rank:research']])
    const perf = (await groupOf(p, 'performance'))!
    expect(perf.group).toMatchObject({
      name: 'TESTPB8 | IT | Playbook Performance', enabled: false, portfolioId: null, marketplace: 'IT', timezone: 'Europe/Rome',
      windows: DOC.rank.roles.performance!.windows, defaultTargetKey: 'test-rest', createdBy: 'user:u-approver',
    })
    expect(perf.members).toEqual(sorted(p.campaigns['exact-category'], p.campaigns['exact-brand']))
    expect(perf.schedules.every((s: any) => s.enabled === false && s.defaultTargetKey === 'test-rest')).toBe(true)
    const research = (await groupOf(p, 'research'))!
    expect(research.group).toMatchObject({ name: 'TESTPB8 | IT | Playbook Research', enabled: false, portfolioId: null, defaultTargetKey: null })
    expect(research.members).toEqual(sorted(p.campaigns.auto, p.campaigns['broad-category']))
    // The slot with no rank role, and another product's campaigns, are in no plan.
    for (const id of [p.campaigns.pat, ...Object.values(other.campaigns)]) expect(await inA(() => db().adSchedule.findFirst({ where: { campaignId: id } }))).toBeNull()
    expect(await inA(() => db().rankScheduleVersion.count({ where: { groupId: perf.group.id, enabled: false } }))).toBe(1)
  })

  it('a plan saved switched off gives back nothing the build floored (the floor is the requester\'s, not an hourly plan\'s)', async () => {
    const c = await inA(() => db().campaign.findUniqueOrThrow({ where: { id: p.campaigns['exact-category'] }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true, adGroups: { select: { defaultBidCents: true, suppressedFromBidCents: true } } } }))
    expect(c).toMatchObject({ bidsSuppressedBy: 'user:u-asker', adGroups: [{ defaultBidCents: 2, suppressedFromBidCents: 30 }] })
    expect(c.bidsSuppressedAt).not.toBeNull()
  })

  it('a second compile keeps both: nothing is saved again', async () => {
    const versions = await inA(() => db().rankScheduleVersion.count())
    const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'build'), []))
    expect(lines.map((l) => l.does)).toEqual(['keep', 'keep'])
    expect(await compile(p)).toMatchObject({ errors: [] })
    expect(await inA(() => db().rankScheduleVersion.count())).toBe(versions)
  })

  it('a campaign gone leaves its plan; a plan renamed and re-timed on Hourly Bids keeps its name and hours', async () => {
    const perf = (await groupOf(p, 'performance'))!
    const hours = [{ days: [6], startHour: 10, endHour: 12, targetKey: 'test-owner-tuned' }]
    await inA(() => db().rankScheduleGroup.update({ where: { id: perf.group.id }, data: { name: 'TESTPB8 renamed on Hourly Bids', windows: hours } }))
    await inA(() => db().campaign.update({ where: { id: p.campaigns['exact-brand'] }, data: { status: 'ARCHIVED' } }))
    const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'build'), []))
    expect(lines[0]).toMatchObject({ key: 'rank:performance', does: 'update', refId: perf.group.id })
    expect(lines[0].summary).toMatch(/"TESTPB8 \| IT \| Exact \| Brand" leaves it\. Its name, hours, baseline and on\/off \(off\) stay as they are\./)
    expect(await compile(p)).toMatchObject({ errors: [] })
    const after = (await groupOf(p, 'performance'))!
    expect(after.group).toMatchObject({ id: perf.group.id, name: 'TESTPB8 renamed on Hourly Bids', windows: hours, enabled: false })
    expect(after.members).toEqual([p.campaigns['exact-category']])
    expect(after.schedules[0].windows).toEqual(hours)
    await inA(() => db().campaign.update({ where: { id: p.campaigns['exact-brand'] }, data: { status: 'ENABLED' } }))
    expect(await compile(p)).toMatchObject({ errors: [] })
    expect((await groupOf(p, 'performance'))!.members).toEqual(sorted(p.campaigns['exact-category'], p.campaigns['exact-brand']))
  })

  describe('START and STOP, as the phase says; one owner per campaign', () => {
    it('START with no phase set: research goes on alone (performance needs a goal, and the preview says so); auto-bid then leaves those campaigns alone', async () => {
      const { autoBidHolders } = await import('../ads-auto-bid.service.js')
      const research = [p.campaigns.auto, p.campaigns['broad-category']]
      const performance = [p.campaigns['exact-category'], p.campaigns['exact-brand']]
      // Off: the plan holds nothing from auto-bid (and a campaign the playbook built is off the live-write allowlist anyway).
      expect([...(await inA(() => autoBidHolders([...research, ...performance]))).entries()]).toEqual([])
      const preview = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'start'), []))
      expect(preview.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'keep'], ['rank:research', 'enable']])
      expect(preview[0].summary).toBe('The playbook\'s hourly plan "TESTPB8 renamed on Hourly Bids" is off already: no phase is set for this product (its ads strategy\'s goal), and performance needs one: research goes on alone.')
      const on = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))
      expect(on.errors).toEqual([])
      expect(on.changed).toHaveLength(1)
      expect((await groupOf(p, 'performance'))!.group.enabled).toBe(false)
      const g = (await groupOf(p, 'research'))!
      expect(g.group.enabled).toBe(true)
      expect(g.schedules.every((s: any) => s.enabled)).toBe(true)
      const holders = await inA(() => autoBidHolders([...research, ...performance, p.campaigns.pat]))
      expect(research.map((id) => holders.get(id))).toEqual(['hourlyPlan', 'hourlyPlan'])
      expect([...performance, p.campaigns.pat].map((id) => holders.get(id))).toEqual([undefined, undefined, undefined])
    })

    it('a plan that is on takes a new campaign only at START; the one gone leaves at once', async () => {
      // The broad-category slot is played by a new campaign (the old one archived): research is on.
      const old = p.campaigns['broad-category']
      await inA(() => db().campaign.update({ where: { id: old }, data: { status: 'ARCHIVED' } }))
      const fresh = await inA(() => campaign('TESTPB8 | IT | Broad | Category (2)', {}, true))
      await inA(() => db().adsPlaybookLink.updateMany({ where: { playbookId: p.rowId, kind: 'slot', key: 'broad-category' }, data: { refId: fresh } }))
      p.campaigns['broad-category'] = fresh
      const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'build'), []))
      expect(lines[1].summary).toMatch(/leaves it \(top of search stays as last set\); "TESTPB8 \| IT \| Broad \| Category \(2\)" joins it at the next START \(it is on: joining now would start hourly bids on it\)/)
      expect(await compile(p)).toMatchObject({ errors: [] })
      expect((await groupOf(p, 'research'))!.members).toEqual([p.campaigns.auto])
      const on = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))
      expect(on.errors).toEqual([])
      const research = (await groupOf(p, 'research'))!
      expect(research.members).toEqual(sorted(p.campaigns.auto, fresh))
      expect(research.schedules.every((s: any) => s.enabled)).toBe(true)
    })

    it('STOP switches both off; auto-bid holds nothing on them again', async () => {
      const { autoBidHolders } = await import('../ads-auto-bid.service.js')
      const off = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'stop'), [], false))
      expect(off.errors).toEqual([])
      for (const role of ['performance', 'research'] as const) {
        const g = (await groupOf(p, role))!
        expect(g.group.enabled).toBe(false)
        expect(g.schedules.every((s: any) => !s.enabled)).toBe(true)
      }
      expect([...(await inA(() => autoBidHolders([p.campaigns['exact-category'], p.campaigns.auto]))).entries()]).toEqual([])
    })

    it('START in DEFEND (research off in that phase): performance goes on, research stays off', async () => {
      await inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: p.parent, label: 'Test product strategy', goal: 'DEFEND', updatedBy: 'user:test' } }))
      const preview = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'start'), []))
      expect(preview.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'enable'], ['rank:research', 'keep']])
      const on = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))
      expect(on.errors).toEqual([])
      expect((await groupOf(p, 'performance'))!.group.enabled).toBe(true)
      expect((await groupOf(p, 'research'))!.group.enabled).toBe(false)
      await inA(() => rankGroupCompiler.setEnabled({ ...DOC_CTX(p) }, [], false))
    })
  })

  describe('a phase (PB-9 calls applyRankPhase)', () => {
    const withLight = (): TemplateDoc => {
      const doc = templateDoc()
      doc.rank.roles.research!.light = { windows: [{ days: [0, 6], startHour: 0, endHour: 5, targetKey: 'test-min-bid' }], baseline: null }
      return doc
    }

    it('before START: light and on write the playbook\'s hours and keep the plans off', async () => {
      const doc = withLight()
      const ctx = await ctxOf(p, 'start', doc)
      const lines = await inA(() => previewRankPhase(ctx, { performance: 'on', research: 'light' }))
      expect(lines.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'update'], ['rank:research', 'update']])
      expect(lines[1].summary).toMatch(/light research plan .* Kept off until START\.$/)
      expect(await inA(() => applyRankPhase(ctx, { performance: 'on', research: 'light' }))).toMatchObject({ errors: [] })
      const perf = (await groupOf(p, 'performance'))!
      const research = (await groupOf(p, 'research'))!
      expect(perf.group).toMatchObject({ enabled: false, windows: doc.rank.roles.performance!.windows })
      expect(research.group).toMatchObject({ enabled: false, windows: doc.rank.roles.research!.light!.windows })
      expect(research.schedules.map((s: any) => [s.enabled, s.windows])).toEqual(research.schedules.map(() => [false, doc.rank.roles.research!.light!.windows]))
    })

    it('once the playbook runs: off is off, on is on with the full hours; a missing light plan is refused by name', async () => {
      await inA(() => db().adsPlaybook.update({ where: { id: p.rowId }, data: { state: 'RUNNING' } }))
      const ctx = await ctxOf(p, 'start', withLight())
      expect(await inA(() => applyRankPhase(ctx, { performance: 'off', research: 'on' }))).toMatchObject({ errors: [] })
      expect((await groupOf(p, 'performance'))!.group.enabled).toBe(false)
      expect((await groupOf(p, 'research'))!.group).toMatchObject({ enabled: true, windows: DOC.rank.roles.research!.windows })
      const refused = await inA(async () => applyRankPhase(await ctxOf(p, 'start'), { performance: 'light' }))
      expect(refused.errors).toEqual(['The playbook has no light performance plan: "TESTPB8 renamed on Hourly Bids" is left as it is.'])
      await inA(() => rankGroupCompiler.setEnabled(DOC_CTX(p), [], false))
      await inA(() => db().adsPlaybook.update({ where: { id: p.rowId }, data: { state: 'BUILT' } }))
    })
  })
})

/** A context good enough for STOP (no slots needed: STOP switches off what the playbook made). */
function DOC_CTX(p: Seeded): ArtifactContext {
  return { playbookId: p.rowId, market: 'IT', productId: p.parent, nameToken: p.token, doc: DOC, slots: [], mode: 'stop', actor: 'user:u-approver', changeSetId: 'ap-8', compiledVersion: 1 }
}

describe("the Owner's hourly plans are his own: a role is refused by name, his plan reads back as it was", () => {
  it('a campaign in his group: the performance role is refused, his group, its schedules and its history are untouched', async () => {
    const p = await product('TESTPB8A', { adopted: ['exact-brand'] })
    const own = await inA(() => campaign('Owner test campaign'))
    const ownerGroup = await inA(async () => {
      const g = await db().rankScheduleGroup.create({ data: { name: 'Owner test plan', marketplace: 'IT', windows: [{ days: [1], startHour: 9, endHour: 17, targetKey: 'test-owner' }], defaultTargetKey: 'test-owner-rest', targetOverrides: { [p.campaigns['exact-brand']]: { 'test-owner': { biasPct: 50 } } }, enabled: true } })
      for (const id of [own, p.campaigns['exact-brand']]) {
        await db().adSchedule.create({ data: { campaignId: id, name: `Owner test plan member`, groupId: g.id, windows: [{ days: [1], startHour: 9, endHour: 17, targetKey: 'test-owner' }], defaultTargetKey: 'test-owner-rest', targetOverrides: id === own ? {} : { 'test-owner': { biasPct: 50 } }, enabled: true } })
      }
      await db().rankScheduleVersion.create({ data: { groupId: g.id, name: 'Owner test plan', windows: [], campaignCount: 2, enabled: true } })
      return g.id
    })
    const before = await snapshotOf(ownerGroup)
    const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'build'), []))
    const out = await compile(p)
    // His group, every schedule in it (his campaign's and the adopted one's) and its history read back exactly as before.
    expect(await snapshotOf(ownerGroup)).toEqual(before)
    expect(await groupOf(p, 'performance')).toBeNull()
    expect(lines[0]).toMatchObject({ key: 'rank:performance', does: 'report' })
    expect(lines[0].summary).toBe('The performance campaigns get no hourly plan: "TESTPB8A | IT | Exact | Brand" is held by the hourly plan "Owner test plan" — adopt it first. That plan is not touched. Nothing of this role is written.')
    expect(out.errors).toEqual([`rankGroup: ${lines[0].summary}`])
    // The other role is compiled as usual.
    expect((await groupOf(p, 'research'))!.members).toEqual(sorted(p.campaigns.auto, p.campaigns['broad-category']))
    // START never switches on what it did not make, and leaves his plan as it is.
    expect(await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))).toMatchObject({ errors: [] })
    expect(await snapshotOf(ownerGroup)).toEqual(before)
    await inA(() => rankGroupCompiler.setEnabled(DOC_CTX(p), [], false))
    expect(await snapshotOf(ownerGroup)).toEqual(before)
  })

  it('a schedule of its own (switched off) — and a campaign that also advertises another product an Owner\'s product rank plan governs: refused, untouched', async () => {
    const p = await product('TESTPB8B', { adopted: ['auto', 'exact-category'] })
    const own = await inA(() => db().adSchedule.create({ data: { campaignId: p.campaigns.auto, name: 'Owner single plan', windows: [{ days: [2], startHour: 1, endHour: 3, targetKey: 'test-owner' }], enabled: false } }))
    // Another product of the Owner's, held by his product rank plan; two of the playbook's campaigns also advertise it.
    // The engine resolves the plan's campaigns by the family's ASINs (resolveProductFamily): both are governed, but the
    // one the plan excludes.
    const plan = await inA(async () => {
      const z = await db().product.create({ data: { sku: 'TEST-OWNERZ-PARENT', name: 'Owner test product', basePrice: '10.00', isParent: true, amazonAsin: 'B0TESTZZP0' } })
      await db().product.create({ data: { sku: 'TEST-OWNERZ-V1', name: 'Owner test product v1', basePrice: '10.00', parentId: z.id, amazonAsin: 'B0TESTZZ01' } })
      for (const slot of ['exact-category', 'exact-brand']) {
        const g = await db().adGroup.findFirstOrThrow({ where: { campaignId: p.campaigns[slot] } })
        await db().adProductAd.create({ data: { adGroupId: g.id, asin: 'B0TESTZZ01', sku: 'TEST-OWNERZ-V1' } })
      }
      return db().productRankPlan.create({ data: { productId: z.id, marketplace: 'IT', enabled: true, excludeCampaignIds: [p.campaigns['exact-brand']] } })
    })
    const before = await inA(() => db().adSchedule.findUnique({ where: { id: own.id } }))
    const out = await compile(p)
    expect(out.errors).toEqual([
      'rankGroup: The performance campaigns get no hourly plan: "TESTPB8B | IT | Exact | Category" is held by the product rank plan of "Owner test product" — adopt it first. That plan is not touched. Nothing of this role is written.',
      'rankGroup: The research campaigns get no hourly plan: "TESTPB8B | IT | Auto" is held by its own hourly plan "Owner single plan" — adopt it first. That plan is not touched. Nothing of this role is written.',
    ])
    expect(await inA(() => db().adSchedule.findUnique({ where: { id: own.id } }))).toEqual(before)
    expect(await inA(() => db().adSchedule.count({ where: { campaignId: { in: Object.values(p.campaigns) } } }))).toBe(1)
    // Switched off, the plan governs nothing: the performance role compiles.
    await inA(() => db().productRankPlan.update({ where: { id: plan.id }, data: { enabled: false } }))
    expect((await compile(p)).errors).toHaveLength(1)
    expect((await groupOf(p, 'performance'))!.members).toEqual(sorted(p.campaigns['exact-category'], p.campaigns['exact-brand']))
  })

  it('a portfolio his group covers, a group with the name it would get, bids an earlier plan left: refused, untouched', async () => {
    const p = await product('TESTPB8C', {
      adopted: ['exact-category', 'auto'],
      extra: { 'exact-category': { portfolioId: 'pf-owner-test' }, auto: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: null } },
    })
    const scoped = await inA(() => db().rankScheduleGroup.create({ data: { name: 'Owner portfolio plan', marketplace: 'IT', portfolioId: 'pf-owner-test', enabled: true } }))
    const twin = await inA(() => db().rankScheduleGroup.create({ data: { name: 'TESTPB8C | IT | Playbook Research', marketplace: 'IT', enabled: false } }))
    const [beforeScoped, beforeTwin] = [await snapshotOf(scoped.id), await snapshotOf(twin.id)]
    const autoBids = await inA(() => db().adGroup.findFirstOrThrow({ where: { campaignId: p.campaigns.auto }, select: { defaultBidCents: true } }))
    const out = await compile(p)
    expect(out.errors).toEqual([
      'rankGroup: The performance campaigns get no hourly plan: "TESTPB8C | IT | Exact | Category" is held by the hourly plan "Owner portfolio plan", which covers its portfolio — adopt it first. That plan is not touched. Nothing of this role is written.',
      'rankGroup: The research campaigns get no hourly plan: "TESTPB8C | IT | Auto" still carries bids an earlier hourly plan left at the floor: a person gives those bids back on the Hourly Bids list first (a plan saved switched off would give them back by itself). Nothing of this role is written.',
    ])
    expect(await snapshotOf(scoped.id)).toEqual(beforeScoped)
    expect(await inA(() => db().adGroup.findFirstOrThrow({ where: { campaignId: p.campaigns.auto }, select: { defaultBidCents: true } }))).toEqual(autoBids)
    // The floor given back by a person, research would take the twin's name: refused too, the twin untouched.
    await inA(() => db().campaign.update({ where: { id: p.campaigns.auto }, data: { bidsSuppressedAt: null, bidsSuppressedBy: null } }))
    const again = await compile(p)
    expect(again.errors[1]).toBe('rankGroup: The research campaigns get no hourly plan: an hourly plan named "TESTPB8C | IT | Playbook Research" exists already and is not this playbook\'s — it is not touched (rename it, or adopt it first). Nothing of this role is written.')
    expect(await snapshotOf(twin.id)).toEqual(beforeTwin)
    expect(await inA(() => db().adSchedule.count({ where: { campaignId: { in: Object.values(p.campaigns) } } }))).toBe(0)
  })
})

describe('switched off, nothing rises: what rank set is kept, not given back', () => {
  let p: Seeded
  let ids: { floored: string; floorGroup: string; down: string; up: string }
  /** Rank holds the campaigns now, as a Min-bid window and a base-bid swatch leave them. */
  const rankHolds = () => inA(async () => {
    const exact = p.campaigns['exact-category']
    const sid = (await db().adSchedule.findFirstOrThrow({ where: { campaignId: exact } })).id
    await db().campaign.update({ where: { id: exact }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: `automation:rank-defend-${sid}`, dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 300 }] } } })
    await db().adGroup.update({ where: { id: ids.floorGroup }, data: { defaultBidCents: 2, suppressedFromBidCents: 30 } })
    // On the auto slot: one bid rank lowered (24 from 30) and one it raised (36 from 30).
    await db().adGroup.update({ where: { id: ids.down }, data: { defaultBidCents: 24, baseBidFromCents: 30 } })
    await db().adTarget.update({ where: { id: ids.up }, data: { bidCents: 36, baseBidFromCents: 30 } })
  })
  const state = () => inA(async () => ({
    campaign: await db().campaign.findUniqueOrThrow({ where: { id: p.campaigns['exact-category'] }, select: { bidsSuppressedAt: true, bidsSuppressedBy: true } }),
    floorGroup: await db().adGroup.findUniqueOrThrow({ where: { id: ids.floorGroup }, select: { defaultBidCents: true, suppressedFromBidCents: true } }),
    down: await db().adGroup.findUniqueOrThrow({ where: { id: ids.down }, select: { defaultBidCents: true, baseBidFromCents: true } }),
    up: await db().adTarget.findUniqueOrThrow({ where: { id: ids.up }, select: { bidCents: true, baseBidFromCents: true } }),
  }))

  beforeAll(async () => {
    p = await product('TESTPB8E', { adopted: DOC.structure.slots.map((x) => x.key) })
    ids = await inA(async () => {
      const floorGroup = (await db().adGroup.findFirstOrThrow({ where: { campaignId: p.campaigns['exact-category'] } })).id
      const down = (await db().adGroup.findFirstOrThrow({ where: { campaignId: p.campaigns.auto } })).id
      const up = (await db().adTarget.create({ data: { adGroupId: down, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test pb8 term', bidCents: 30 } })).id
      return { floored: p.campaigns['exact-category'], floorGroup, down, up }
    })
    expect((await compile(p)).errors).toEqual([])
    await inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: p.parent, label: 'Test product strategy E', goal: 'LAUNCH', updatedBy: 'user:test' } }))
    expect((await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))).errors).toEqual([])
  })

  it('the classifier: kept, the floor stays and only a bid rank raised goes down; given back, it is a raise', async () => {
    await rankHolds()
    const ctx = await ctxOf(p, 'stop')
    const kept = await inA(() => rankOffEffect(ctx, ['performance', 'research']))
    expect(kept).toMatchObject({ direction: 'lower', heldAtFloor: [{ campaignId: ids.floored, bids: 1 }], givenBack: [], keptDown: 1, raisedBack: 0, loweredBack: 1, topOfSearch: [{ campaignId: ids.floored, pct: 300 }] })
    const given = await inA(() => rankOffEffect(ctx, ['performance', 'research'], 'giveBack'))
    expect(given).toMatchObject({ direction: 'raise', heldAtFloor: [], givenBack: [{ campaignId: ids.floored, bids: 1 }], keptDown: 0, raisedBack: 1, loweredBack: 1 })
    expect(given.words).toMatch(/gets the bids rank floored back \(a raise\)/)
    // Pure: a floor another owner set keeps the campaign out of it altogether.
    const facts = await inA(() => loadRankFacts(ctx))
    facts.bids.get(ids.floored)!.floorBy = 'automation:retail-guard'
    expect(classifyRankOff(facts, [ids.floored], 'giveBack')).toMatchObject({ direction: 'same', givenBack: [] })
  })

  it('STOP inside a Min-bid window: the floor stays at 2¢, handed to the approver and remembered; no bid rises; top of search named', async () => {
    rec.writes = []
    const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'stop'), []))
    expect(lines.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'disable'], ['rank:research', 'disable']])
    expect(lines[0].summary).toMatch(/"TESTPB8E \| IT \| Exact \| Category" stays at the floor rank set \(kept as the approver's floor; START gives the bids back\); top of search stays as last set \("TESTPB8E \| IT \| Exact \| Category" 300%\)/)
    expect(lines[1].summary).toMatch(/1 bid rank lowered stays where it is; 1 bid rank raised goes back down to its earlier bid/)
    const off = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'stop'), [], false))
    expect(off.errors).toEqual([])
    const after = await state()
    expect(after.campaign.bidsSuppressedAt).not.toBeNull()
    expect(after.campaign.bidsSuppressedBy).toBe('user:u-approver')
    expect(after.floorGroup).toEqual({ defaultBidCents: 2, suppressedFromBidCents: 30 })
    expect(after.down).toEqual({ defaultBidCents: 24, baseBidFromCents: null })
    expect(after.up).toEqual({ bidCents: 30, baseBidFromCents: null })
    // The real give-back ran: the one bid it wrote went down.
    expect(rec.writes.map((w) => [w.id, w.bid])).toEqual([[ids.up, 30]])
  })

  it('a phase that gives back (floors giveBack): the bids rank floored come back — the raise the classifier names', async () => {
    await inA(() => db().adsPlaybook.update({ where: { id: p.rowId }, data: { state: 'RUNNING' } }))
    expect((await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))).errors).toEqual([])
    await inA(() => db().campaign.update({ where: { id: ids.floored }, data: { bidsSuppressedAt: null, bidsSuppressedBy: null } }))
    await rankHolds()
    rec.writes = []
    const lines = await inA(async () => previewRankPhase(await ctxOf(p, 'start'), { performance: 'off' }, { floors: 'giveBack' }))
    expect(lines[0].summary).toMatch(/gets the bids rank floored back \(a raise\)/)
    expect((await inA(async () => applyRankPhase(await ctxOf(p, 'start'), { performance: 'off' }, { floors: 'giveBack' }))).errors).toEqual([])
    expect((await state()).floorGroup).toEqual({ defaultBidCents: 30, suppressedFromBidCents: null })
    expect(rec.writes.map((w) => [w.id, w.bid])).toEqual([[ids.floorGroup, 30]])
    await inA(() => rankGroupCompiler.setEnabled(DOC_CTX(p), [], false))
  })
})

describe('an adopt changes Nexus only; a build takes a campaign out', () => {
  it('an unbind from a plan that is on saves nothing (it leaves at STOP); a build then takes it out and nothing rises', async () => {
    const p = await product('TESTPB8F', { adopted: DOC.structure.slots.map((x) => x.key) })
    expect((await compile(p)).errors).toEqual([])
    expect((await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))).errors).toEqual([])
    const research = (await groupOf(p, 'research'))!
    expect(research.group.enabled).toBe(true)
    // The auto slot is unbound (the undo of an adopt), while rank holds it at the floor.
    const sid = (await inA(() => db().adSchedule.findFirstOrThrow({ where: { campaignId: p.campaigns.auto } }))).id
    await inA(async () => {
      await db().adsPlaybookLink.deleteMany({ where: { playbookId: p.rowId, kind: 'slot', key: 'auto' } })
      await db().campaign.update({ where: { id: p.campaigns.auto }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: `automation:rank-defend-${sid}` } })
      await db().adGroup.updateMany({ where: { campaignId: p.campaigns.auto }, data: { defaultBidCents: 2, suppressedFromBidCents: 30 } })
    })
    const versions = await inA(() => db().rankScheduleVersion.count({ where: { groupId: research.group.id } }))
    const out = await compile(p, 'adopt')
    expect(out.errors).toEqual([])
    const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'adopt'), []))
    expect(lines[1]).toMatchObject({ key: 'rank:research', does: 'report' })
    expect(lines[1].summary).toBe('The playbook\'s hourly plan "TESTPB8F | IT | Playbook Research" is on: "TESTPB8F | IT | Auto" leaves it at STOP — taking it out now would change its bids at Amazon, and an adopt changes Nexus only. Nothing of this plan is saved.')
    expect((await groupOf(p, 'research'))!.members).toEqual(research.members)
    expect(await inA(() => db().rankScheduleVersion.count({ where: { groupId: research.group.id } }))).toBe(versions)
    // A build takes it out: rank's floor stays, handed over; nothing written at Amazon.
    rec.writes = []
    expect((await compile(p, 'build')).errors).toEqual([])
    expect((await groupOf(p, 'research'))!.members).toEqual([p.campaigns['broad-category']])
    expect(await inA(() => db().campaign.findUniqueOrThrow({ where: { id: p.campaigns.auto }, select: { bidsSuppressedBy: true } }))).toEqual({ bidsSuppressedBy: 'user:u-approver' })
    expect(rec.writes).toEqual([])
    await inA(() => rankGroupCompiler.setEnabled(DOC_CTX(p), [], false))
  })
})

describe('ownership checked again just before the save', () => {
  it('a group of the same name made after the plan was read is never taken over: the role is refused, that group untouched', async () => {
    const p = await product('TESTPB8G')
    const ctx = await ctxOf(p, 'build')
    const facts = await inA(() => loadRankFacts(ctx))
    const steps = planCompile(ctx, facts)
    expect(steps.map((x) => x.does)).toEqual(['create', 'create'])
    const twin = await inA(() => db().rankScheduleGroup.create({ data: { name: 'TESTPB8G | IT | Playbook Research', marketplace: 'IT', enabled: true } }))
    const before = await snapshotOf(twin.id)
    const out = await inA(() => runRankSteps(ctx, facts, steps))
    expect(out.errors).toEqual(['an hourly plan named "TESTPB8G | IT | Playbook Research" exists already and is not this playbook\'s — it is not touched, and the research campaigns get no plan'])
    expect(out.links.map((l) => l.key)).toEqual(['rank:performance'])
    expect(await snapshotOf(twin.id)).toEqual(before)
  })
})

describe('the hook', () => {
  it('ARTIFACT_COMPILERS holds the hourly-plan compiler', () => {
    expect(ARTIFACT_COMPILERS).toContain(rankGroupCompiler)
    expect(rankGroupCompiler.kind).toBe('rankGroup')
  })
})
