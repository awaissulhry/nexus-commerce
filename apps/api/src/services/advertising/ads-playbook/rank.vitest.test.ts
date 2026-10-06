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
 *   start      START switches on as the phase says (none: both on; PROFIT: performance stays off), STOP off; a plan that is
 *              on takes a new campaign only at START
 *   one owner  auto-bid leaves a campaign whose playbook plan is on, and holds nothing on it once the plan is off
 *   phase      applyRankPhase: light writes the light hours; before START nothing is switched on; once running, on is on
 *   hook       ARTIFACT_COMPILERS holds the compiler
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

import { ARTIFACT_COMPILERS, compileArtifacts, type ArtifactContext } from './artifacts.js'
import { applyRankPhase, previewRankPhase, rankGroupCompiler, rankGroupName } from './rank.js'
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
    const out = await compileArtifacts(await ctxOf(p, mode, doc), [])
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
    it('START with no phase switches both on, their schedules on; auto-bid then leaves those campaigns alone', async () => {
      const { autoBidHolders } = await import('../ads-auto-bid.service.js')
      const members = [p.campaigns['exact-category'], p.campaigns['exact-brand'], p.campaigns.auto, p.campaigns['broad-category']]
      // Off: the plan holds nothing from auto-bid (and a campaign the playbook built is off the live-write allowlist anyway).
      expect([...(await inA(() => autoBidHolders(members))).entries()]).toEqual([])
      const preview = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'start'), []))
      expect(preview.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'enable'], ['rank:research', 'enable']])
      const on = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))
      expect(on.errors).toEqual([])
      expect(on.changed).toHaveLength(2)
      for (const role of ['performance', 'research'] as const) {
        const g = (await groupOf(p, role))!
        expect(g.group.enabled).toBe(true)
        expect(g.schedules.every((s: any) => s.enabled)).toBe(true)
      }
      const holders = await inA(() => autoBidHolders([...members, p.campaigns.pat]))
      expect(members.map((id) => holders.get(id))).toEqual(['hourlyPlan', 'hourlyPlan', 'hourlyPlan', 'hourlyPlan'])
      expect(holders.get(p.campaigns.pat)).toBeUndefined()
    })

    it('a plan that is on takes a new campaign only at START; the one gone leaves at once', async () => {
      // The broad-category slot is played by a new campaign (the old one archived): research is on.
      const old = p.campaigns['broad-category']
      await inA(() => db().campaign.update({ where: { id: old }, data: { status: 'ARCHIVED' } }))
      const fresh = await inA(() => campaign('TESTPB8 | IT | Broad | Category (2)', {}, true))
      await inA(() => db().adsPlaybookLink.updateMany({ where: { playbookId: p.rowId, kind: 'slot', key: 'broad-category' }, data: { refId: fresh } }))
      p.campaigns['broad-category'] = fresh
      const lines = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'build'), []))
      expect(lines[1].summary).toMatch(/leaves it \(what it floored on them is given back\); "TESTPB8 \| IT \| Broad \| Category \(2\)" joins it at the next START \(it is on: joining now would start hourly bids on it\)/)
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

    it('START in PROFIT (performance off in that phase): performance stays off, research goes on', async () => {
      await inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: p.parent, label: 'Test product strategy', goal: 'PROFIT', updatedBy: 'user:test' } }))
      const preview = await inA(async () => rankGroupCompiler.preview(await ctxOf(p, 'start'), []))
      expect(preview.map((l) => [l.key, l.does])).toEqual([['rank:performance', 'keep'], ['rank:research', 'enable']])
      const on = await inA(async () => rankGroupCompiler.setEnabled(await ctxOf(p, 'start'), [], true))
      expect(on.errors).toEqual([])
      expect((await groupOf(p, 'performance'))!.group.enabled).toBe(false)
      expect((await groupOf(p, 'research'))!.group.enabled).toBe(true)
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

  it('a schedule of its own (switched off) — and an enabled product rank plan of the product: refused, untouched', async () => {
    const p = await product('TESTPB8B', { adopted: ['auto', 'exact-category'] })
    const own = await inA(() => db().adSchedule.create({ data: { campaignId: p.campaigns.auto, name: 'Owner single plan', windows: [{ days: [2], startHour: 1, endHour: 3, targetKey: 'test-owner' }], enabled: false } }))
    const plan = await inA(() => db().productRankPlan.create({ data: { productId: p.parent, marketplace: 'IT', enabled: true, excludeCampaignIds: [p.campaigns['broad-category']] } }))
    const before = await inA(() => db().adSchedule.findUnique({ where: { id: own.id } }))
    const out = await compile(p)
    expect(out.errors).toEqual([
      'rankGroup: The performance campaigns get no hourly plan: "TESTPB8B | IT | Exact | Category" is held by the product rank plan of this product — adopt it first; "TESTPB8B | IT | Exact | Brand" is held by the product rank plan of this product — adopt it first. That plan is not touched. Nothing of this role is written.',
      'rankGroup: The research campaigns get no hourly plan: "TESTPB8B | IT | Auto" is held by its own hourly plan "Owner single plan" — adopt it first. That plan is not touched. Nothing of this role is written.',
    ])
    expect(await inA(() => db().adSchedule.findUnique({ where: { id: own.id } }))).toEqual(before)
    expect(await inA(() => db().adSchedule.count({ where: { campaignId: { in: Object.values(p.campaigns) } } }))).toBe(1)
    await inA(() => db().productRankPlan.delete({ where: { id: plan.id } }))
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

describe('the hook', () => {
  it('ARTIFACT_COMPILERS holds the hourly-plan compiler', () => {
    expect(ARTIFACT_COMPILERS).toContain(rankGroupCompiler)
    expect(rankGroupCompiler.kind).toBe('rankGroup')
  })
})
