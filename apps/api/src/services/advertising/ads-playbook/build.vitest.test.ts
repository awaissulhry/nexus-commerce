/**
 * ADS PLAYBOOK PB-5a — the build (build.ts): the wizard body it sends (pure), and the run on a real PostgreSQL with the
 * production schema and every business policy (PGlite), business profiles ON. The SP Super Wizard launch itself is
 * proven in ads-sp-wizard-launch.vitest.test.ts; here it is a stand-in that records what it was asked and makes the
 * campaigns in Nexus. Values are made up (public repo).
 *
 *   body       one wizard campaign per slot built (its id the slot key), the products by SKU, no placements or rules
 *   options    off the allowlist, born suppressed by the requester, the approval's change set, placements deferred
 *   guard      one build per product at a time: a running one is answered with its id; one that stopped (no progress
 *              for 30 minutes) is marked FAILED with every campaign it made (from its change set's audit rows), its
 *              Nexus-only records archived, so archive-ads buildRunId and a new build work
 *   run        the slot links (built) and the portfolio link, the run row (playbookId, APPLIED), the row BUILT with what it
 *              compiled, the placements kept for START; a Nexus-only portfolio stops it before any campaign; a campaign
 *              Amazon never took is archived in Nexus so its name is free
 *   slots      a slot linked to a live campaign is not built again; one whose campaign was archived is
 *   artifacts  a compiler on the hook is called after the slot links, and its link is stored
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

/** The wizard's launch, as a recorder that makes each campaign (and its ad group) in Nexus with an Amazon id. */
const launches = vi.hoisted(() => ({ calls: [] as Array<{ body: any; actor: string; opts: any }>, offAmazon: new Set<string>() }))
vi.mock('../ads-sp-wizard-launch.service.js', () => ({
  spWizardLaunch: async (body: any, actor: string, opts: any) => {
    launches.calls.push({ body, actor, opts })
    const prisma = (await import('../../../db.js')).default as any
    const created: Array<{ name: string; campaignId: string; externalCampaignId: string | null; mode: string }> = []
    const slots: Record<string, { campaignId: string; adGroupId: string }> = {}
    for (const [i, c] of body.campaigns.entries()) {
      await opts?.onProgress?.({ done: i, total: body.campaigns.length, campaign: c.name, created: created.length, campaignIds: created.map((x) => x.campaignId) })
      const off = launches.offAmazon.has(c.id)
      const camp = await prisma.campaign.create({ data: { name: c.name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: body.market, dailyBudget: String(c.budgetEur), startDate: new Date(), externalCampaignId: off ? null : `AMZ-${c.name}`, portfolioId: body.portfolioId ?? null } })
      created.push({ name: c.name, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, mode: 'live' })
      if (off) continue
      const g = await prisma.adGroup.create({ data: { campaignId: camp.id, name: c.adGroupName, externalAdGroupId: `AMZ-G-${c.name}` } })
      slots[c.id] = { campaignId: camp.id, adGroupId: g.id }
    }
    await opts?.onProgress?.({ done: body.campaigns.length, total: body.campaigns.length, campaign: null, created: created.length, campaignIds: created.map((x) => x.campaignId) })
    const live = created.filter((c) => c.externalCampaignId)
    return {
      status: 200,
      body: {
        ok: live.length === created.length, created, slots, deferredPlacements: [],
        launch: { ok: live.length === created.length, campaigns: created.map((c) => ({ name: c.name, status: c.externalCampaignId ? 'live' : 'failed', reason: c.externalCampaignId ? null : 'Amazon refused it: a made-up reason', failed: [] })) },
        verification: { ok: true, problems: [] },
      },
    }
  },
}))
const portfolios = vi.hoisted(() => ({ next: 'pf-test-made' as string }))
vi.mock('../ads-portfolio.service.js', () => ({
  createPortfolio: async (input: { name: string }) => ({ portfolio: { portfolioId: portfolios.next, name: input.name }, mode: portfolios.next.startsWith('local-pf-') ? 'local' : 'live' }),
}))

import { buildRunCampaigns, planBuild, runPlaybookBuild, startPlaybookBuild, wizardBodyOf, STALE_RUN_MS, type BuildPlan } from './build.js'
import type { ArtifactCompiler } from './artifacts.js'

const A = 'pb5_build_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const writer = { via: 'claude', actor: 'user:u-approver', actorUserId: 'u-approver', updatedBy: 'claude:ap-1' }
let seeded: Awaited<ReturnType<typeof seedProductPlaybook>>
let other: Awaited<ReturnType<typeof seedProductPlaybook>>
let dead: Awaited<ReturnType<typeof seedProductPlaybook>>

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    seeded = await seedProductPlaybook(db(), { token: 'TESTPB5', asinPrefix: 'B0TESTPB' })
    other = await seedProductPlaybook(db(), { token: 'TESTPB5X', asinPrefix: 'B0TESTPX' })
    dead = await seedProductPlaybook(db(), { token: 'TESTPB5D', asinPrefix: 'B0TESTPD' })
  })
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

const plan = async (productId: string, only?: string[]): Promise<BuildPlan> => {
  const out = await inA(() => planBuild({ market: 'IT', productId, only }))
  if ('error' in out) throw new Error(out.error)
  return out.data
}
/** The run, finished (it runs detached). */
const finished = async (applicationId: string) => {
  await vi.waitFor(async () => {
    const row = await inA(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 10_000, interval: 50 })
  return inA(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
}

describe('the wizard body (pure)', () => {
  it('one campaign per slot, its id the slot key; keywords, product targets, Auto groups and negatives as planned; no placements or rules', async () => {
    const p = await plan(seeded.parent)
    const body = wizardBodyOf(p, 'pf-1')
    expect(body).toMatchObject({ market: 'IT', productGroupName: 'TESTPB5', portfolioId: 'pf-1', products: [{ sku: 'TEST-TESTPB5-V1', asin: 'B0TESTPB01' }, { sku: 'TEST-TESTPB5-V2', asin: 'B0TESTPB02' }] })
    expect(body.campaigns!.map((c) => [c.id, c.kind])).toEqual([['auto', 'auto'], ['broad-category', 'keyword'], ['exact-category', 'keyword'], ['exact-brand', 'keyword'], ['pat', 'pat']])
    const exact = body.campaigns!.find((c) => c.id === 'exact-category')!
    expect(exact).toMatchObject({ name: 'TESTPB5 | IT | Exact | Category', keywords: [{ text: 'test jacket', matchType: 'EXACT' }], biddingStrategy: 'LEGACY_FOR_SALES' })
    expect(exact.negKeywords).toEqual(expect.arrayContaining([{ text: 'test kids', matchType: 'PHRASE' }]))
    expect(body.campaigns!.find((c) => c.id === 'auto')!.autoGroups!.map((g) => g.key)).toEqual(['CLOSE_MATCH', 'LOOSE_MATCH'])
    expect(body.campaigns!.find((c) => c.id === 'pat')!.productTargets).toEqual([{ asin: 'B0TESTRIV1' }])
    expect(body).not.toHaveProperty('placementBids')
    expect(body).not.toHaveProperty('rules')
    expect(body).not.toHaveProperty('bidConfig')
  })
})

describe('the build run', () => {
  let applicationId = ''
  const compiled: string[] = []
  const fake: ArtifactCompiler = {
    kind: 'rankGroup',
    preview: async () => [],
    compile: async (ctx) => {
      // Called after the slot links: every built slot is linked by now.
      const links = await db().adsPlaybookLink.count({ where: { playbookId: ctx.playbookId, kind: 'slot' } })
      compiled.push(`${ctx.mode}:${ctx.slots.length}:${links}`)
      return { links: [{ key: 'rank:performance', refId: 'rank-group-test' }], errors: [] }
    },
    setEnabled: async () => ({ changed: [], errors: [] }),
  }

  beforeAll(async () => {
    const p = await plan(seeded.parent)
    expect(p).toMatchObject({ allowed: true, portfolio: { does: 'create', name: 'Test TESTPB5 IT' } })
    const started = await inA(() => startPlaybookBuild({ plan: p, actor: 'user:u-approver', requester: 'user:u-asker', changeSetId: 'ap-1', writer, compilers: [fake] }))
    if ('refusal' in started) throw new Error(started.refusal)
    applicationId = started.applicationId
  })

  it('runs through the wizard launch: off the allowlist, born suppressed by the requester, the change set, placements deferred', async () => {
    await finished(applicationId)
    const call = launches.calls.at(-1)!
    expect(call.actor).toBe('user:u-approver')
    expect(call.opts).toMatchObject({ allowlistAtBirth: false, bornSuppressed: { floorCents: 2, by: 'user:u-asker' }, changeSetId: 'ap-1', deferPlacements: true })
    expect(call.body.portfolioId).toBe('pf-test-made')
  })

  it('links every slot (built) and the portfolio; the run is APPLIED with its playbook; the row is BUILT with what it compiled', async () => {
    const run = await finished(applicationId)
    expect(run).toMatchObject({ status: 'APPLIED', playbookId: seeded.rowId, launchMode: 'floor', marketplace: 'IT', productToken: 'TESTPB5', errors: [] })
    expect(run.createdCampaignIds).toHaveLength(5)
    expect((run.options as any).deferredPlacements.map((d: any) => d.slot).sort()).toEqual(['exact-category', 'pat'])
    expect((run.progress as any)).toMatchObject({ done: 5, total: 5, campaign: null })
    const links = await inA(() => db().adsPlaybookLink.findMany({ where: { playbookId: seeded.rowId }, orderBy: [{ kind: 'asc' }, { key: 'asc' }], select: { kind: true, key: true, refId: true, origin: true, adGroupId: true } }))
    expect(links.map((l) => [l.kind, l.key, l.origin])).toEqual([
      ['portfolio', 'portfolio', 'built'], ['rankGroup', 'rank:performance', 'built'],
      ['slot', 'auto', 'built'], ['slot', 'broad-category', 'built'], ['slot', 'exact-brand', 'built'], ['slot', 'exact-category', 'built'], ['slot', 'pat', 'built'],
    ])
    expect(links.filter((l) => l.kind === 'slot').every((l) => l.adGroupId)).toBe(true)
    const row = await inA(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: seeded.rowId }, select: { state: true, version: true, compiledVersion: true, compiledTemplateVersion: true } }))
    expect(row).toEqual({ state: 'BUILT', version: 2, compiledVersion: 2, compiledTemplateVersion: 1 })
    const version = await inA(() => db().adsPlaybookVersion.findFirstOrThrow({ where: { refId: seeded.rowId, version: 2 }, select: { op: true, direction: true, approvalId: true, actor: true } }))
    expect(version).toEqual({ op: 'build', direction: 'same', approvalId: 'ap-1', actor: 'user:u-approver' })
  })

  it('calls the artifacts hook after the slot links, with every linked slot', () => {
    expect(compiled).toEqual(['build:5:5'])
  })

  it('a re-plan builds nothing more: every slot is held by a live campaign; an archived one is missing again', async () => {
    expect((await plan(seeded.parent)).campaigns).toEqual([])
    const pat = await inA(() => db().adsPlaybookLink.findFirstOrThrow({ where: { playbookId: seeded.rowId, kind: 'slot', key: 'pat' } }))
    await inA(() => db().campaign.update({ where: { id: pat.refId }, data: { status: 'ARCHIVED' } }))
    const again = await plan(seeded.parent)
    expect(again.campaigns.map((c) => c.role)).toEqual(['pat'])
    // The archived campaign's name is free again at Amazon (and in the gate); a playbook's own build is not "a second set".
    expect(again.blockers).toEqual([])
    expect(again.warnings.join('\n')).not.toMatch(/SECOND set/)
  })
})

describe('one build at a time; a Nexus-only portfolio stops it', () => {
  it('a running build is answered with its id', async () => {
    const p = await plan(other.parent)
    const row = await inA(() => db().adBlueprintApplication.create({ data: {
      productToken: 'TESTPB5X', marketplace: 'IT', status: 'RUNNING', plan: {}, playbookId: other.rowId, startedAt: new Date(),
      progress: { done: 1, total: 5, campaign: 'TESTPB5X | IT | Auto', at: new Date().toISOString() },
    } }))
    expect(await inA(() => startPlaybookBuild({ plan: p, actor: 'user:u-approver', requester: 'user:u-asker', changeSetId: 'ap-2', writer }))).toEqual({ applicationId: row.id, alreadyRunning: true })
    await inA(() => db().adBlueprintApplication.update({ where: { id: row.id }, data: { status: 'FAILED' } }))
  })

  it('a portfolio Amazon does not hold (local-pf-) stops the run before any campaign', async () => {
    portfolios.next = 'local-pf-P-IT-PB-test'
    const before = launches.calls.length
    const p = await plan(other.parent)
    const started = await inA(() => startPlaybookBuild({ plan: p, actor: 'user:u-approver', requester: 'user:u-asker', changeSetId: 'ap-3', writer }))
    if ('refusal' in started) throw new Error(started.refusal)
    const run = await finished(started.applicationId)
    expect(run).toMatchObject({ status: 'FAILED', createdCampaignIds: [] })
    expect(run.errors[0]).toMatch(/could not be made at Amazon .* so nothing was built/)
    expect(launches.calls.length).toBe(before)
    expect(await inA(() => db().adsPlaybookLink.count({ where: { playbookId: other.rowId } }))).toBe(0)
    expect((await inA(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: other.rowId } }))).state).toBe('DRAFT')
    portfolios.next = 'pf-test-made'
  })

  it('a campaign Amazon did not take is not linked, named, and the run is PARTIAL', async () => {
    launches.offAmazon.add('pat')
    const p = await plan(other.parent)
    const started = await inA(() => startPlaybookBuild({ plan: p, actor: 'user:u-approver', requester: 'user:u-asker', changeSetId: 'ap-4', writer }))
    if ('refusal' in started) throw new Error(started.refusal)
    const run = await finished(started.applicationId)
    launches.offAmazon.clear()
    expect(run.status).toBe('PARTIAL')
    expect(run.notOnAmazon).toHaveLength(1)
    expect(run.errors.join('\n')).toMatch(/"TESTPB5X \| IT \| PAT": Amazon refused it: a made-up reason/)
    // The record Amazon never took is archived in Nexus: its name is free for the next build of that slot.
    expect((await inA(() => db().campaign.findUniqueOrThrow({ where: { id: run.notOnAmazon[0] }, select: { status: true } }))).status).toBe('ARCHIVED')
    expect(run.errors.join('\n')).toMatch(/1 campaign record\(s\) Amazon never took were archived in Nexus, so their names are free/)
    expect((await plan(other.parent)).campaigns.map((c) => c.role)).toEqual(['pat'])
    const keys = (await inA(() => db().adsPlaybookLink.findMany({ where: { playbookId: other.rowId, kind: 'slot' }, select: { key: true } }))).map((l) => l.key).sort()
    expect(keys).toEqual(['auto', 'broad-category', 'exact-brand', 'exact-category'])
  })

  it('a build killed mid-way: marked FAILED with what it made (from its audit rows), its Nexus-only record archived; archive-ads and a new build work', async () => {
    // Killed after making two campaigns and recording none: one at Amazon, one Amazon never took.
    const made = await inA(async () => {
      const at = await db().campaign.create({ data: { name: 'TESTPB5D dead | IT | Auto', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '3.00', startDate: new Date(), externalCampaignId: 'AMZ-dead-1' } })
      const local = await db().campaign.create({ data: { name: 'TESTPB5D dead | IT | PAT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '3.00', startDate: new Date() } })
      for (const c of [at, local]) await db().advertisingActionLog.create({ data: { executionId: 'ap-dead', userId: 'user:u-approver', actionType: 'create_campaign', entityType: 'CAMPAIGN', entityId: c.id, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUCCESS' } })
      return { at: at.id, local: local.id }
    })
    const deadRun = await inA(() => db().adBlueprintApplication.create({ data: {
      productToken: 'TESTPB5D', marketplace: 'IT', status: 'RUNNING', plan: {}, playbookId: dead.rowId, startedAt: new Date(Date.now() - 2 * STALE_RUN_MS),
      options: { source: 'playbook', changeSetId: 'ap-dead' }, createdCampaignIds: [],
      progress: { done: 2, total: 5, campaign: 'TESTPB5D dead | IT | Broad', at: new Date(Date.now() - STALE_RUN_MS - 60_000).toISOString() },
    } }))
    // Its undo (archive-ads buildRunId) names the campaign Amazon holds; the run is FAILED with both and why.
    expect(await inA(() => buildRunCampaigns(deadRun.id))).toEqual({ campaignIds: [made.at], status: 'FAILED' })
    const row = await inA(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: deadRun.id } }))
    expect(row.status).toBe('FAILED')
    expect([...row.createdCampaignIds].sort()).toEqual([made.at, made.local].sort())
    expect(row.errors.join('\n')).toMatch(/stopped without finishing at "TESTPB5D dead \| IT \| Broad": no progress for 30 minutes .*archive-ads buildRunId .* 1 campaign record\(s\) Amazon never took were archived in Nexus/)
    expect((await inA(() => db().campaign.findUniqueOrThrow({ where: { id: made.local }, select: { status: true } }))).status).toBe('ARCHIVED')
    // Another stopped build no longer holds the next one: it is marked FAILED and the new one starts.
    const again = await inA(() => db().adBlueprintApplication.create({ data: {
      productToken: 'TESTPB5D', marketplace: 'IT', status: 'RUNNING', plan: {}, playbookId: dead.rowId, options: { source: 'playbook', changeSetId: 'ap-dead-2' },
      progress: { done: 0, total: 5, campaign: null, at: new Date(Date.now() - STALE_RUN_MS - 60_000).toISOString() },
    } }))
    portfolios.next = 'pf-test-dead'
    const started = await inA(async () => startPlaybookBuild({ plan: await plan(dead.parent), actor: 'user:u-approver', requester: 'user:u-asker', changeSetId: 'ap-5', writer }))
    if ('refusal' in started) throw new Error(started.refusal)
    expect(started.alreadyRunning).toBeUndefined()
    expect(started.applicationId).not.toBe(again.id)
    expect((await inA(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: again.id } }))).status).toBe('FAILED')
    expect((await finished(started.applicationId)).status).toBe('APPLIED')
    portfolios.next = 'pf-test-made'
  })

  it('the run is a no-op on a row that is not RUNNING', async () => {
    const before = launches.calls.length
    const done = await inA(() => db().adBlueprintApplication.findFirstOrThrow({ where: { playbookId: other.rowId, status: 'PARTIAL' } }))
    await inA(() => runPlaybookBuild(done.id))
    expect(launches.calls.length).toBe(before)
  })
})
