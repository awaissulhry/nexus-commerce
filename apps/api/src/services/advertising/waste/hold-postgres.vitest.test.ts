/**
 * Negative Targeting (2026-10-11, lane NWRITE) — the kept-paused lock and the one negative write door on a real PostgreSQL
 * (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted
 * runtime login, business profiles ON), the ads mode LIVE (the real write gate judges every write), Amazon a recorder
 * (nothing leaves the process) and the job queue a stub (a write is at most queued).
 *
 *   keep      pause-ads with keepPaused, approved by a person: paused, the hold written with it (who, since, always), its
 *             history row on the change set, one queued status write
 *   lock      a rule, the rule action enable_target, a person's plain click and a bulk-sheet rollback are each refused a
 *             turn-on, by name, recorded as a gate refusal (AdWriteRefusal kept_paused) — nothing written, nothing queued
 *   enable    enable-ads refuses a kept-paused keyword by name; with releaseKeepPaused a run by the business's rule does not
 *             run; a person's approval switches it on and ends the hold
 *   rule      pause_target keeps it paused as the rule; off the live-write allowlist the gate refuses it at once: no hold left
 *             behind; the Undo of that pause releases it
 *   Amazon    a kept-paused keyword Amazon reports ENABLED: an EXTERNAL_CHANGE drift row, the status as Amazon has it, the hold
 *             kept (TURNED_ON_ELSEWHERE) — and a pause that never reached Amazon ends its hold instead
 *   door      the author stored on every new negative (brain funnel, Claude, a rule through the push-only wrapper's record,
 *             Harvest); retire-negatives refuses a Harvest negative unless forced with a reason (never by rule)
 *   business  AdsWasteSkip under row security: another business sees none, a row without a business is refused
 *   review    M3 — the turn-on alert is decided by the drift row, so it is sent once whichever sync reads Amazon first (the
 *             keyword list, or the v1 export ingest); S4 — a keeping pause cancelled in its window leaves no hold; S5 — a
 *             person's release on the page lifts a pause of a rule still on (warned), Claude's needs the code; S7 — the
 *             retire service itself refuses a Harvest negative unless forced with a reason, and lets the brain's own pass
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
/** Amazon: a recorder of the negative creates, and the keyword lists the sync reads (set per test). */
const amz = vi.hoisted(() => ({ keywords: [] as Array<Record<string, unknown>>, lists: {} as Record<string, unknown> }))
vi.mock('../ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ads-api-client.js')>()
  return {
    ...real,
    createNegativeKeyword: async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-NK-${amz.keywords.length}`, rawResponse: {} } },
    liveCall: async (req: { path: string }) => {
      const answer = amz.lists[req.path]
      if (answer instanceof Error) throw answer
      if (answer) return answer
      throw new Error(`no Amazon answer for ${req.path} in this test`)
    },
  }
})

const { updateAdTargetWithSync } = await import('../ads-mutation.service.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { rollbackByChangeSetId, rollbackByActionLogId } = await import('../rollback.service.js')
const { syncKeywordsForAdGroups } = await import('../ads-keyword-list-sync.service.js')
const { writeNegativeKeyword, createNegative } = await import('../ads-negative-kw.service.js')
const { ACTION_HANDLERS } = await import('../../automation-rule.service.js')
await import('../automation-action-handlers.js') // the advertising actions (pause_target, enable_target, …) register here
const { callTool } = await import('../../agents/call-tool.js')
const { decideApproval, runOrQueueTool } = await import('../../agents/approval-gate.service.js')
const { getTool } = await import('../../agents/tool-registry.js')
const { holdStateOf } = await import('./hold.js')
const { ingestTargets } = await import('../ads-v1-sync.service.js')
const { cancelPendingMutation } = await import('../ads-mutation.service.js')
const { retireNegatives } = await import('../negatives-retire.service.js')

const hex = randomBytes(4).toString('hex')
const W = `neg_hold_${hex}`
const W2 = `neg_hold_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const RULE = `cnegrule${hex}0000000000000`
type Data = Record<string, any>

const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = (userId: string, via: 'claude' | 'app') => ({ kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: scope(W), permissions: { isOwner: false, permissions: EVERYTHING } })
const OWNER = person('u-owner', 'app')
const CLAUDE = person('u-asker', 'claude')

/** The turn-on warnings the business's people got for this keyword. */
const warnings = async (text: string) => (await inW(() => database.client.notification.count({ where: { type: 'ads_kept_paused_turned_on', body: { contains: text } } })))
/** One record of the v1 targets export. */
const v1 = (targetId: string, keyword: string, state: 'ENABLED' | 'PAUSED') => ({ targetId, campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it', adProduct: 'SPONSORED_PRODUCTS', state, negative: false, targetType: 'KEYWORD', targetLevel: 'AD_GROUP', targetDetails: { keyword, matchType: 'EXACT' }, bid: 0.4 }) as never
const target = (id: string) => inW(() => database.client.adTarget.findUniqueOrThrow({ where: { id } })) as Promise<Data>
const queued = async () => (await rows<{ n: number }>('SELECT count(*)::int n FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W]))[0].n
const refusals = (entityId: string) => rows<Data>('SELECT "deniedAt", reason, "queueId" FROM "AdWriteRefusal" WHERE "workspaceId" = $1 AND "entityId" = $2 ORDER BY "createdAt"', [W, entityId])
/** Wait for the fire-and-forget refusal record (logGateDeny). */
async function refusalsOf(entityId: string, n: number) {
  for (let i = 0; i < 50; i++) {
    const r = await refusals(entityId)
    if (r.length >= n) return r
    await new Promise((done) => setTimeout(done, 20))
  }
  return refusals(entityId)
}
/** A request asked through a door and approved by a person (or by the business's rule). */
async function askAndApprove(tool: string, args: Record<string, unknown>, opts: { asker?: typeof OWNER; byRule?: boolean } = {}) {
  return inW(async () => {
    const asker = opts.asker ?? OWNER
    const run = await database.client.agentRun.create({ data: { agentKey: 'test', trigger: 'manual', status: 'done', via: asker.via, userId: asker.userId } })
    const asked = await runOrQueueTool(tool, args, asker as never, run.id, { forceAsk: true })
    if (!asked.ok || !asked.approvalId) return { asked, ran: null }
    if (opts.byRule) await database.client.agentApproval.update({ where: { id: asked.approvalId }, data: { decisionVia: 'auto' } })
    const ran = await decideApproval(asked.approvalId, 'approve', OWNER as never)
    return { asked, ran }
  })
}

async function seed(prefix = '') {
  const db = database.client
  await seedAdsFixture(db, { prefix })
  const kw = (id: string, text: string) => db.adTarget.create({ data: { id: `${prefix}${id}`, adGroupId: `${prefix}g-c-it`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents: 40, externalTargetId: `EXT-${prefix}${id}` } })
  await kw('t-keep', 'made up boots')
  await kw('t-rule', 'made up helmet')
  await kw('t-refused', 'made up gloves')
  await kw('t-v1', 'made up scarf')
  await kw('t-cancel', 'made up socks')
  // The rule whose pause_target keeps keywords paused below: on (PROPOSE), so enable-ads sees "a rule still on".
  await db.automationRule.create({ data: { id: `${prefix}${RULE}`, name: 'Stop waste (made up)', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: false, autonomyLevel: 'PROPOSE', conditions: [], actions: [{ type: 'pause_target' }] } as never })
  const p = await db.product.create({ data: { id: `${prefix}p-jacket`, sku: `${prefix}NEG-JACKET-${hex}`, name: 'Jacket', basePrice: '80.00' } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-it`, productId: p.id, sku: `${prefix}NEG-JACKET-${hex}`, asin: 'B0NEGJACK1', externalAdId: `EXT-${prefix}pa` } })
}

describe.skipIf(!concurrentDatabaseUrl())('Negative Targeting — the kept-paused lock and the negative write door (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => {
      await seed(); await setAutonomy('AUTO', 'test')
      // A member of the business: the turn-on warning reaches its people (notifyAutomation).
      const u = await database.client.userProfile.create({ data: { email: `neg-${hex}@example.test`, status: 'active', displayName: 'Made up member' } })
      await database.client.workspaceMembership.create({ data: { workspaceId: W, userId: u.id, status: 'active' } })
    })
    await inW2(async () => { await seed('w2-'); await setAutonomy('AUTO', 'test') })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('keep: pause-ads with keepPaused, approved by a person — paused, the hold with it, its history on the change set, one queued write', async () => {
    const before = await queued()
    const { asked, ran } = await askAndApprove('pause-ads', { targetIds: ['t-keep'], keepPaused: true, why: 'spends with no orders (made up)' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued', preview: { keepsPaused: 1, keepUntil: null, summary: expect.stringMatching(/Keeps 1 keyword or target paused \(always\)/) } })
    expect(ran, JSON.stringify(ran)).toMatchObject({ ok: true, status: 'executed' })
    expect(await target('t-keep')).toMatchObject({ status: 'PAUSED', keptPausedAt: expect.any(Date), keptPausedBy: 'user:u-owner', keptPausedUntil: null, keptPausedReason: expect.stringContaining('spends with no orders') })
    const logs = await inW(() => database.client.advertisingActionLog.findMany({ where: { entityId: 't-keep' }, orderBy: { createdAt: 'asc' } })) as Data[]
    expect(logs.map((l) => [l.actionType, l.executionId, l.amazonResponseStatus])).toEqual([
      ['AD_ENTITY_STATE_UPDATE', asked.approvalId, 'PENDING'],
      ['keep_paused', asked.approvalId, 'SKIPPED'],
    ])
    expect(logs[0].payloadAfter).toMatchObject({ status: 'PAUSED', keptPaused: true })
    expect(await queued()).toBe(before + 1)
  })

  it('lock: a rule, enable_target, a person\'s plain click and a bulk-sheet rollback are refused a turn-on, recorded, nothing written', async () => {
    const before = await queued()
    const rule = await inW(() => updateAdTargetWithSync({ adTargetId: 't-keep', patch: { status: 'ENABLED' }, actor: `automation:${RULE}` }))
    expect(rule).toMatchObject({
      ok: false, outboundQueueId: null,
      error: expect.stringMatching(/^Kept paused by a person since .* \(Always · spends with no orders \(made up\)\)\. The rule "Stop waste \(made up\)" may not turn it on: only a person can/),
      keptPaused: { by: 'user:u-owner', byName: 'a person', until: null, needsRelease: true },
    })
    expect(rule.error).not.toMatch(/user:|automation:|UTC/)
    const handler = await inW(() => ACTION_HANDLERS.enable_target({ type: 'enable_target', adTargetId: 't-keep' }, {}, { dryRun: false, ruleId: RULE } as never))
    expect(handler).toMatchObject({ ok: true, output: { skipped: 'kept-paused', reason: expect.stringMatching(/^Kept paused by a person since .*The rule "Stop waste \(made up\)" may not turn it on/) } })
    const click = await inW(() => updateAdTargetWithSync({ adTargetId: 't-keep', patch: { status: 'ENABLED' }, actor: 'user:u-other', manual: true }))
    expect(click.error).toMatch(/Turning it on lets it spend: turn it on from Negative Targeting, or confirm the release/)
    // Review S15 — who was refused is in the history too: the person, and the rule.
    const refusedBy = async () => (await inW(() => database.client.advertisingActionLog.findMany({ where: { entityId: 't-keep', actionType: 'kept_paused_refused' }, select: { userId: true } }))).map((l) => l.userId).sort()
    expect(await refusedBy()).toEqual([`automation:${RULE}`, `automation:${RULE}`, 'user:u-other'].sort())
    // A bulk-sheet upload paused it once; rolling that upload back would switch it on: refused by the lock.
    await inW(() => database.client.advertisingActionLog.create({ data: { executionId: `bulk-${hex}`, userId: 'user:u-sheet', actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'AD_TARGET', entityId: 't-keep', payloadBefore: { status: 'ENABLED', bidCents: 40 }, payloadAfter: { status: 'PAUSED', bidCents: 40 }, amazonResponseStatus: 'SUCCESS', createdAt: new Date(Date.now() - 3_600_000) } }))
    const rolled = await inW(() => rollbackByChangeSetId({ changeSetId: `bulk-${hex}`, actor: 'user:u-sheet', reason: 'undo the upload', manual: true }))
    expect(rolled).toMatchObject({ reversed: 0, failed: 1, details: [{ outcome: 'FAILED', reason: expect.stringMatching(/^Kept paused by/) }] })
    expect(await refusedBy()).toEqual([`automation:${RULE}`, `automation:${RULE}`, 'user:u-other', 'user:u-sheet'].sort())
    expect(await target('t-keep')).toMatchObject({ status: 'PAUSED', keptPausedBy: 'user:u-owner' })
    expect(await queued()).toBe(before)
    expect((await refusalsOf('t-keep', 4)).map((r) => [r.deniedAt, r.queueId])).toEqual([
      ['kept_paused', null], ['kept_paused', null], ['kept_paused', null], ['kept_paused', null],
    ])
  })

  it('enable: refused by name; released by rule does not run; a person\'s approval switches it on and ends the hold', async () => {
    const plain = await inW(() => callTool(CLAUDE as never, 'enable-ads', { targetIds: ['t-keep'] }))
    expect(plain.raw).toMatchObject({ ok: false, error: expect.stringMatching(/is kept paused by a person .* enable-ads switches a kept-paused keyword back on only when asked with releaseKeepPaused: true/) })
    const byRule = await askAndApprove('enable-ads', { targetIds: ['t-keep'], releaseKeepPaused: true, why: 'made up' }, { asker: CLAUDE, byRule: true })
    expect(byRule.asked.preview, JSON.stringify(byRule.asked)).toMatchObject({ releasesKeptPaused: 1 })
    expect(getTool('enable-ads')!.withinLimits!(byRule.asked.preview, {})).toMatch(/only a person releases a kept-paused keyword, never a rule/)
    expect(byRule.ran).toMatchObject({ ok: false, error: expect.stringMatching(/ends the kept-paused hold of 1 keyword or target, which a person decides, never a rule/) })
    expect(await target('t-keep')).toMatchObject({ status: 'PAUSED', keptPausedBy: 'user:u-owner' })
    const { asked, ran } = await askAndApprove('enable-ads', { targetIds: ['t-keep'], releaseKeepPaused: true, why: 'it sells again (made up)' }, { asker: CLAUDE })
    expect(ran, JSON.stringify(ran)).toMatchObject({ ok: true })
    expect(await target('t-keep')).toMatchObject({ status: 'ENABLED', keptPausedAt: null, keptPausedBy: null })
    expect(await inW(() => database.client.advertisingActionLog.findFirst({ where: { entityId: 't-keep', actionType: 'release_kept_paused' } }))).toMatchObject({ executionId: asked.approvalId, amazonResponseStatus: 'SKIPPED' })
  })

  it('rule: pause_target keeps it paused as the rule; off the allowlist it is refused at once with no hold; the Undo of its pause releases it', async () => {
    const run = (adTargetId: string) => inW(() => ACTION_HANDLERS.pause_target({ type: 'pause_target', adTargetId, reason: 'no orders (made up)' }, {}, { dryRun: false, ruleId: RULE } as never))
    expect(await run('t-rule')).toMatchObject({ ok: true, output: { status: 'PAUSED', keptPaused: { until: null } } })
    expect(await target('t-rule')).toMatchObject({ status: 'PAUSED', keptPausedBy: `automation:${RULE}` })
    // Review S5 — the rule is still on. A person's release on the page lifts its pause (warned: it may pause it again);
    // Claude's request needs the approver's code.
    const asClaude = await inW(() => callTool(CLAUDE as never, 'enable-ads', { targetIds: ['t-rule'], includePeoplesPauses: true, releaseKeepPaused: true }))
    expect(asClaude.raw, JSON.stringify(asClaude.raw)).toMatchObject({ ok: true, preview: { needsCode: 1, releasesKeptPaused: 1, rulePausesAgain: [{ ruleId: RULE }] } })
    const asPage = await inW(() => callTool(OWNER as never, 'enable-ads', { targetIds: ['t-rule'], includePeoplesPauses: true, releaseKeepPaused: true }))
    expect(asPage.raw, JSON.stringify(asPage.raw)).toMatchObject({ ok: true, preview: { needsCode: 0, releasesKeptPaused: 1, summary: expect.stringMatching(/Warning: .*the rule "Stop waste \(made up\)" that paused it is still on/) } })
    // c-off is not on the live-write allowlist: refused before anything is written (askGate) — no hold, no local change.
    const off = await run('t-off')
    expect(off).toMatchObject({ ok: false, error: expect.stringMatching(/^Not sent to Amazon: .*allowlist/) })
    expect(await target('t-off')).toMatchObject({ status: 'ENABLED', keptPausedAt: null })
    expect((await refusalsOf('t-off', 1)).map((r) => r.deniedAt)).toEqual(['campaign_allowlist'])
    // The person's Undo of the very pause that set the hold releases it.
    const pause = await inW(() => database.client.advertisingActionLog.findFirstOrThrow({ where: { entityId: 't-rule', actionType: 'AD_ENTITY_STATE_UPDATE' } })) as Data
    expect(pause.payloadAfter).toMatchObject({ keptPaused: true })
    await inW(() => database.client.advertisingActionLog.update({ where: { id: pause.id }, data: { amazonResponseStatus: 'SUCCESS' } }))
    const undone = await inW(() => rollbackByActionLogId({ actionLogId: pause.id, actor: 'user:u-owner', reason: 'undo', manual: true }))
    expect(undone, JSON.stringify(undone)).toMatchObject({ reversed: 1, failed: 0 })
    expect(await target('t-rule')).toMatchObject({ status: 'ENABLED', keptPausedAt: null })
  })

  it('Amazon: a kept-paused keyword reported ENABLED — drift row, status as Amazon has it, hold kept; a pause that never landed ends its hold', async () => {
    // t-refused: kept paused by a pause the worker refused at dispatch (its action log SKIPPED).
    for (const id of ['t-keep', 't-refused']) {
      const { asked, ran } = await askAndApprove('pause-ads', { targetIds: [id], keepPaused: true, why: 'made up' })
      expect(ran, JSON.stringify(asked)).toMatchObject({ ok: true })
    }
    await inW(async () => {
      await database.client.advertisingActionLog.updateMany({ where: { entityId: 't-keep', actionType: 'AD_ENTITY_STATE_UPDATE', amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SUCCESS' } })
      await database.client.advertisingActionLog.updateMany({ where: { entityId: 't-refused', actionType: 'AD_ENTITY_STATE_UPDATE', amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SKIPPED' } })
      // Delivered: nothing is pending, so the sync does not hold the status back.
      await database.client.outboundSyncQueue.updateMany({ data: { syncStatus: 'SUCCESS' } })
      await database.client.adMutation.updateMany({ where: { state: 'PENDING' }, data: { state: 'APPLIED', settledAt: new Date() } })
    })
    amz.lists['/sp/keywords/list'] = { keywords: [
      { keywordId: 'EXT-t-keep', adGroupId: 'EXT-g-c-it', keywordText: 'made up boots', matchType: 'EXACT', bid: 0.4, state: 'ENABLED' },
      { keywordId: 'EXT-t-refused', adGroupId: 'EXT-g-c-it', keywordText: 'made up gloves', matchType: 'EXACT', bid: 0.4, state: 'ENABLED' },
    ] }
    amz.lists['/sp/negativeKeywords/list'] = new Error('not read in this test') // a failed list never archives anything
    const out = await inW(() => syncKeywordsForAdGroups({ profileId: 'P-IT-TEST', region: 'EU', externalAdGroupIds: ['EXT-g-c-it'] }))
    expect(out.upserted).toBeGreaterThanOrEqual(1)
    const kept = await target('t-keep')
    expect(kept).toMatchObject({ status: 'ENABLED', keptPausedBy: 'user:u-owner' })
    expect(holdStateOf(kept as never)).toBe('TURNED_ON_ELSEWHERE')
    expect(await inW(() => database.client.adDrift.findFirst({ where: { entityType: 'AD_TARGET', entityId: 't-keep', field: 'status' } }))).toMatchObject({ classification: 'EXTERNAL_CHANGE', ourValue: 'PAUSED', amazonValue: 'ENABLED', resolvedAt: null })
    // Review M3 — alerted once: the v1 export ingest reading the same ENABLED after the list sync sends nothing again.
    expect(await warnings('made up boots')).toBe(1)
    await inW(() => ingestTargets([v1('EXT-t-keep', 'made up boots', 'ENABLED')]))
    expect(await warnings('made up boots')).toBe(1)
    // The refused pause: nothing to keep — the hold ended, said in its history.
    expect(await target('t-refused')).toMatchObject({ keptPausedAt: null })
    expect(await inW(() => database.client.advertisingActionLog.findFirst({ where: { entityId: 't-refused', actionType: 'kept_paused_ended' } }))).toMatchObject({ amazonResponseStatus: 'SKIPPED' })
    expect(await inW(() => database.client.adDrift.count({ where: { entityId: 't-refused' } }))).toBe(0)
  })

  it('door: the author of every new negative — brain funnel, Claude, a rule through the recorded push-only path, Harvest', async () => {
    // The brain's funnel at PROPOSE: its change plan, approved by a person, writes as that person (the brain's own actor at AUTO
    // needs the live server switch, which this run does not set).
    const funnel = await inW(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'made up funnel', matchType: 'EXACT', userId: 'user:u-owner', manual: true, evidence: { metric: 'claudeRequest', note: 'Approved request ap-x: Ads brain: match-type funnel: the product buys it in 1 ad group' } as never }))
    expect(funnel, JSON.stringify(funnel)).toMatchObject({ outcome: 'created', reachedAmazon: true })
    expect(await target(funnel.adTargetId!)).toMatchObject({ negativeOrigin: 'BRAIN_FUNNEL' })
    // Claude asked, a person approved: add-negative-targets runs as the person; the request came through Claude's door.
    const { ran } = await askAndApprove('add-negative-targets', { negatives: [{ adGroupId: 'g-c-it', text: 'made up claude', matchType: 'NEGATIVE_EXACT' }], why: 'made up' }, { asker: CLAUDE })
    expect(ran, JSON.stringify(ran)).toMatchObject({ ok: true })
    expect(await inW(() => database.client.adTarget.findFirst({ where: { expressionValue: 'made up claude', isNegative: true } }))).toMatchObject({ negativeOrigin: 'CLAUDE' })
    // The push-only wrapper, asked to record (the legacy rule path, the account-wide sync): the row and its audit row.
    const pushed = await inW(() => createNegative({ profileId: 'P-IT-TEST', externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: 'made up rule', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: 'IT', actor: `automation:${RULE}`, record: { userId: `automation:${RULE}` } }))
    expect(pushed).toMatchObject({ ok: true, adTargetId: expect.any(String) })
    expect(await target(pushed.adTargetId!)).toMatchObject({ negativeOrigin: 'RULE', isNegative: true, externalTargetId: expect.stringMatching(/^AMZ-NK-/) })
    expect(await inW(() => database.client.advertisingActionLog.findFirst({ where: { entityId: pushed.adTargetId!, actionType: 'create_negative_keyword' } }))).toMatchObject({ userId: `automation:${RULE}` })
    // A harvest's source negative, approved by a person (the brain's harvest pair at PROPOSE): its evidence names the harvest.
    const harvest = await inW(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'made up harvest', matchType: 'EXACT', userId: 'user:u-owner', manual: true, evidence: { metric: 'brainHarvest', note: 'made up pair' } as never }))
    expect(harvest, JSON.stringify(harvest)).toMatchObject({ outcome: 'created' })
    expect(await target(harvest.adTargetId!)).toMatchObject({ negativeOrigin: 'HARVEST' })

    // retire-negatives never fights Harvest: refused by owner, unless forced with a reason — and never by rule.
    const refused = await inW(() => callTool(CLAUDE as never, 'retire-negatives', { negativeIds: [harvest.adTargetId] }))
    expect(refused.raw).toMatchObject({ ok: false, error: expect.stringMatching(/Harvest keeps it/) })
    const noWhy = await inW(() => callTool(CLAUDE as never, 'retire-negatives', { negativeIds: [harvest.adTargetId], force: true }))
    expect(noWhy.raw.error).toMatch(/say why/)
    const forced = await inW(() => callTool(CLAUDE as never, 'retire-negatives', { negativeIds: [harvest.adTargetId], force: true, why: 'the harvested keyword is gone (made up)' }))
    expect(forced.raw).toMatchObject({ ok: true, preview: { forcedPastOwner: 1, changes: [{ owner: { kind: 'HARVEST' }, forced: true }] } })
    expect(getTool('retire-negatives')!.withinLimits!(forced.raw.preview, { allowRetire: true, markets: ['IT'] })).toMatch(/a person decides, never a rule/)
    // A person's own negative is lifted as before, its owner named.
    const own = await inW(() => callTool(CLAUDE as never, 'retire-negatives', { negativeIds: [pushed.adTargetId] }))
    expect(own.raw).toMatchObject({ ok: true, preview: { changes: [{ owner: { kind: 'RULE' } }] } })
  })

  it('M3: the v1 export ingest sees the turn-on first — status as Amazon has it, the hold kept, alerted once; the list sync after it alerts nothing more', async () => {
    const { ran } = await askAndApprove('pause-ads', { targetIds: ['t-v1'], keepPaused: true, why: 'made up' })
    expect(ran).toMatchObject({ ok: true })
    await inW(async () => {
      await database.client.advertisingActionLog.updateMany({ where: { entityId: 't-v1', actionType: 'AD_ENTITY_STATE_UPDATE', amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SUCCESS' } })
      await database.client.outboundSyncQueue.updateMany({ data: { syncStatus: 'SUCCESS' } })
      await database.client.adMutation.updateMany({ where: { state: 'PENDING' }, data: { state: 'APPLIED', settledAt: new Date() } })
    })
    await inW(() => ingestTargets([v1('EXT-t-v1', 'made up scarf', 'ENABLED')]))
    const seen = await target('t-v1')
    expect(seen).toMatchObject({ status: 'ENABLED', keptPausedBy: 'user:u-owner' })
    expect(holdStateOf(seen as never)).toBe('TURNED_ON_ELSEWHERE')
    expect(await warnings('made up scarf')).toBe(1)
    amz.lists['/sp/keywords/list'] = { keywords: [{ keywordId: 'EXT-t-v1', adGroupId: 'EXT-g-c-it', keywordText: 'made up scarf', matchType: 'EXACT', bid: 0.4, state: 'ENABLED' }] }
    amz.lists['/sp/negativeKeywords/list'] = new Error('not read in this test')
    await inW(() => syncKeywordsForAdGroups({ profileId: 'P-IT-TEST', region: 'EU', externalAdGroupIds: ['EXT-g-c-it'] }))
    expect(await warnings('made up scarf')).toBe(1)
    // A person keeps it paused again: the drift row closes, so a later turn-on at Amazon is alerted again (the drift row
    // re-opens; the notice itself is one per person while an identical one is still unread — notifyAutomation's dedupe).
    const again = await askAndApprove('pause-ads', { targetIds: ['t-v1'], keepPaused: true, why: 'made up' })
    expect(again.ran).toMatchObject({ ok: true })
    expect(await inW(() => database.client.adDrift.findFirst({ where: { entityId: 't-v1', field: 'status' } }))).toMatchObject({ resolvedAt: expect.any(Date) })
    await inW(() => database.client.advertisingActionLog.updateMany({ where: { entityId: 't-v1', amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'SUCCESS' } }))
    await inW(() => database.client.notification.updateMany({ where: { type: 'ads_kept_paused_turned_on' }, data: { readAt: new Date() } }))
    await inW(() => ingestTargets([v1('EXT-t-v1', 'made up scarf', 'ENABLED')]))
    expect(await inW(() => database.client.adDrift.findFirst({ where: { entityId: 't-v1', field: 'status' } }))).toMatchObject({ resolvedAt: null })
    expect(await warnings('made up scarf')).toBe(2)
  })

  it('S4: a keeping pause cancelled in its window is put back — ENABLED, and its hold ended, said in its history', async () => {
    const { asked, ran } = await askAndApprove('pause-ads', { targetIds: ['t-cancel'], keepPaused: true, why: 'made up' })
    expect(ran).toMatchObject({ ok: true })
    expect(await target('t-cancel')).toMatchObject({ status: 'PAUSED', keptPausedAt: expect.any(Date) })
    const log = await inW(() => database.client.advertisingActionLog.findFirstOrThrow({ where: { entityId: 't-cancel', actionType: 'AD_ENTITY_STATE_UPDATE', executionId: asked.approvalId } }))
    expect(await inW(() => cancelPendingMutation(log.outboundQueueId!))).toMatchObject({ ok: true, restored: ['status'] })
    expect(await target('t-cancel')).toMatchObject({ status: 'ENABLED', keptPausedAt: null, keptPausedBy: null })
    expect(await inW(() => database.client.advertisingActionLog.findFirst({ where: { entityId: 't-cancel', actionType: 'kept_paused_ended' } }))).toMatchObject({ amazonResponseStatus: 'SKIPPED', evidence: { note: expect.stringMatching(/the pause never reached Amazon/) } })
  })

  it('S7: the retire service itself never fights Harvest — a person\'s retire refused by its owner, forced with a reason it goes', async () => {
    const h = await inW(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'made up harvest two', matchType: 'EXACT', userId: 'user:u-owner', manual: true, evidence: { metric: 'brainHarvest', note: 'made up pair' } as never }))
    expect(await target(h.adTargetId!)).toMatchObject({ negativeOrigin: 'HARVEST' })
    const plain = await inW(() => retireNegatives({ adTargetIds: [h.adTargetId!], actor: 'user:u-owner', retireReason: 'made up' }))
    expect(plain.outcomes).toMatchObject([{ kind: 'refused', reason: expect.stringMatching(/Harvest keeps it/) }])
    const noWhy = await inW(() => retireNegatives({ adTargetIds: [h.adTargetId!], actor: 'user:u-owner', owners: { force: true, why: ' ' } }))
    expect(noWhy.outcomes).toMatchObject([{ kind: 'refused' }])
    expect(await target(h.adTargetId!)).toMatchObject({ status: 'ENABLED' })
    const forced = await inW(() => retireNegatives({ adTargetIds: [h.adTargetId!], actor: 'user:u-owner', retireReason: 'the keyword is gone (made up)', owners: { force: true, why: 'the keyword is gone (made up)' }, manual: true }))
    expect(forced.outcomes, JSON.stringify(forced.outcomes)).toMatchObject([{ kind: 'retired' }])
  })

  it('business: AdsWasteSkip under row security — another business sees none; a row without a business is refused', async () => {
    const db = database.client
    const { skipRows } = await import('./skip.js')
    expect(await inW(() => skipRows({ ids: ['kw:t-low'], days: 30, by: 'user:u-owner' }))).toMatchObject({ ok: true })
    const row = await inW(() => db.adsWasteSkip.findFirstOrThrow({ where: { rowKey: 'kw:t-low' } }))
    expect(row).toMatchObject({ workspaceId: W, by: 'user:u-owner', endedAt: null })
    await inW2(async () => {
      expect(await db.adsWasteSkip.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsWasteSkip"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsWasteSkip" SET "endedBy" = 'x' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsWasteSkip.create({ data: { rowKey: 'kw:x', until: new Date(Date.now() + 86_400_000), by: 'user:x', workspaceId: W } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      // Another business's hold columns are its own: nothing of W's holds is visible there.
      expect(await db.adTarget.count({ where: { keptPausedAt: { not: null } } })).toBe(0)
    })
    await expect(db.adsWasteSkip.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', ['AdsWasteSkip'])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', ['AdsWasteSkip'])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
  })
})
