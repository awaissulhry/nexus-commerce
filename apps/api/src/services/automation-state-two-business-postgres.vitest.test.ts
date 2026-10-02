/**
 * R1 (MCP full control, part 06 gap 10) — the three automation brakes are PER BUSINESS, on a real PostgreSQL with
 * the production policies and the restricted runtime login (NOBYPASSRLS), as production runs.
 *
 *   · the ads automation dial and halt (`AdsAutomationState`, ads-automation-state.service.ts)
 *   · the agent fleet halt and daily ceiling (`AgentFleetState`, fleet-state.service.ts)
 *   · the review request mailer pause (`ReviewMailerState`, review-mailer-state.service.ts + the mailer job)
 *
 * Each table had one fixed primary key (`singleton` / `default`). The question the plan left open was whether a
 * second business could hold its own row at all, or whether its read failed (ads automation then reads as halted,
 * fail-safe) and its halt could not be written. A halt in one business must stop that business only; the legacy
 * business keeps its row, under its old id, exactly as before; each business has one row.
 *
 * R16: an engine's per-business switch (AutomationSwitch) is one row per business; a switch in one never reaches another.
 *
 * MCP full control (2026-10-02): the account-wide ads settings Claude's tools read and write — stop-automation's halt,
 * tune-ad-engine's breaker and target ACOS, the catalog's dial — are per business through the same rewrite (measured
 * here, not assumed).
 *
 * Business profiles are ON for the whole file, as production runs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
// A halt notifies operators (best effort). Nothing here may reach a bell, an inbox or a channel.
vi.mock('./advertising/ads-automation-notify.service.js', () => ({ notifyAutomation: vi.fn(async () => undefined) }))
// The mailer tick, when NOT paused, goes on to schedule and send. Its senders are stubbed: the test reads only
// whether the tick ran or was skipped as paused.
vi.mock('./reviews/review-scheduler.service.js', () => ({ schedulePendingOrders: vi.fn(async () => ({ scheduled: 0 })), buildReviewUrl: vi.fn(() => '') }))
vi.mock('./reviews/review-request-email.service.js', () => ({ sendReviewRequestEmail: vi.fn() }))
vi.mock('./reviews/amazon-solicitations.service.js', () => ({ sendAmazonSolicitation: vi.fn(), isBenignFailure: vi.fn(() => false), benignSuppressedReason: vi.fn(() => null) }))
vi.mock('./reviews/sentiment-check-email.service.js', () => ({ sendSentimentCheckEmail: vi.fn(), resolveLocaleForMarketplace: vi.fn(() => 'en') }))
vi.mock('./reviews/orders-delivered-backfill.service.js', () => ({ applyShipDeliveryHeuristic: vi.fn(async () => ({ updated: 0 })) }))

const ads = await import('./advertising/ads-automation-state.service.js')
const fleet = await import('./agent-fleet/fleet-state.service.js')
const mailer = await import('./reviews/review-mailer-state.service.js')
const { runReviewMailerOnce } = await import('../jobs/review-request-mailer.job.js')

const LEGACY = 'nexus_legacy_workspace'
const B = randomUUID()
const C = randomUUID()
const inBusiness = <T>(workspaceId: string, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

/** Every row of a state table, read as the owner (row security bypassed) so all businesses are visible. */
async function rowsOf(table: 'AdsAutomationState' | 'AgentFleetState' | 'ReviewMailerState') {
  const r = await database.pool.query(`SELECT id, "workspaceId" FROM "${table}" ORDER BY "workspaceId", id`)
  return r.rows as Array<{ id: string; workspaceId: string }>
}

describe.skipIf(!concurrentDatabaseUrl())('automation brakes are per business (real PostgreSQL, row security on)', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_ADS_AUTOMATION_KILL', '')
    database = await concurrentDatabase({ maxConnections: 4 })
    for (const id of [B, C]) {
      await database.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, now())`, [id])
    }
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('ads: a halt in one business stops that business only; each reads its own dial; the legacy row keeps its id', async () => {
    // First reads create each business's row from the schema default (SUGGEST, not halted), never "degraded".
    for (const ws of [LEGACY, B, C]) {
      const s = await inBusiness(ws, () => ads.getAutomationState())
      expect({ ws, degraded: s.degraded, halted: s.halted, autonomy: s.autonomy }).toEqual({ ws, degraded: false, halted: false, autonomy: 'SUGGEST' })
    }

    await inBusiness(B, () => ads.haltAutomation('test breaker trip', 'operator:test'))
    expect(await inBusiness(B, () => ads.isAutomationHalted())).toBe(true)
    expect(await inBusiness(LEGACY, () => ads.isAutomationHalted())).toBe(false)
    expect(await inBusiness(C, () => ads.isAutomationHalted())).toBe(false)
    const b = await inBusiness(B, () => ads.getAutomationState())
    expect({ halted: b.halted, haltReason: b.haltReason, haltedBy: b.haltedBy, effectivelyStopped: b.effectivelyStopped, degraded: b.degraded })
      .toEqual({ halted: true, haltReason: 'test breaker trip', haltedBy: 'operator:test', effectivelyStopped: true, degraded: false })

    // The dial and the default target are per business too.
    await inBusiness(LEGACY, () => ads.setAutonomy('AUTO', 'operator:test'))
    await inBusiness(C, () => ads.setDefaultTargetAcosPct(25, 'operator:test'))
    expect(await inBusiness(LEGACY, () => ads.shouldForceDryRun())).toBe(false)
    expect(await inBusiness(B, () => ads.shouldForceDryRun())).toBe(true)
    expect(await inBusiness(C, () => ads.shouldForceDryRun())).toBe(true)
    expect((await inBusiness(C, () => ads.getAutomationState())).defaultTargetAcosPct).toBe(25)
    expect((await inBusiness(LEGACY, () => ads.getAutomationState())).defaultTargetAcosPct).toBeNull()

    // A halt written in a business that has no row yet (a breaker tripping before anyone opened the page).
    const D = randomUUID()
    await database.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, now())`, [D])
    await inBusiness(D, () => ads.haltAutomation('first write is a halt', 'auto:anomaly-guard'))
    expect(await inBusiness(D, () => ads.isAutomationHalted())).toBe(true)
    expect(await inBusiness(LEGACY, () => ads.isAutomationHalted())).toBe(false)

    await inBusiness(B, () => ads.resumeAutomation('operator:test'))
    expect(await inBusiness(B, () => ads.isAutomationHalted())).toBe(false)
    expect(await inBusiness(D, () => ads.isAutomationHalted())).toBe(true)

    const rows = await rowsOf('AdsAutomationState')
    expect(rows.find((r) => r.workspaceId === LEGACY)?.id).toBe('singleton')
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([LEGACY, B, C, D].sort())
  })

  // MCP full control R12–R14 — the account-wide ads settings Claude reads and writes go through their own paths:
  // stop-automation's halt (readHaltState), tune-ad-engine's breaker and target ACOS (setGuardThresholds,
  // setDefaultTargetAcosPct, a findUnique by the literal id), and the catalog's dial (adsDial). Set in one business,
  // read in the others: each business keeps its own.
  it("ads, through Claude's tools' paths: the breaker, the target ACOS and a halt set in one business stay in it", async () => {
    const tune = await import('./advertising/ads-engine-tune.service.js')
    const stop = await import('./automation/automation-stop.service.js')
    const { automationAdapter } = await import('./automation/automation-catalog.service.js')
    const E = randomUUID()
    await database.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, now())`, [E])
    const breakerIn = async (ws: string) => (await inBusiness(ws, () => tune.tuneStateNow({ setting: 'breaker', subjectId: null, name: '', state: {} })))?.state
    const targetIn = async (ws: string) => (await inBusiness(ws, () => tune.tuneStateNow({ setting: 'account-target-acos', subjectId: null, name: '', state: {} })))?.state

    // The breaker, tuned in E (no row yet there: the write creates E's own).
    const before = { LEGACY: await breakerIn(LEGACY), B: await breakerIn(B), C: await breakerIn(C) }
    const tuned = await inBusiness(E, () => tune.applyTune({ setting: 'breaker', values: { maxHourlySpendCentsEur: 12_345, maxActionsPerHour: 42 } }, 'u-r1'))
    expect(tuned.ok).toBe(true)
    expect(await breakerIn(E)).toEqual({ maxHourlySpendCentsEur: 12_345, maxActionsPerHour: 42 })
    expect({ LEGACY: await breakerIn(LEGACY), B: await breakerIn(B), C: await breakerIn(C) }).toEqual(before)
    expect(await inBusiness(E, () => ads.getAutomationState())).toMatchObject({ maxHourlySpendCentsEur: 12_345, maxActionsPerHour: 42 })
    expect(await inBusiness(LEGACY, () => ads.getAutomationState())).toMatchObject({ maxHourlySpendCentsEur: null, maxActionsPerHour: null })

    // The target ACOS, tuned in B; C keeps the 25 it set above; the legacy business has none.
    expect((await inBusiness(B, () => tune.applyTune({ setting: 'account-target-acos', values: { targetAcosPct: 33 } }, 'u-r1'))).ok).toBe(true)
    expect(await targetIn(B)).toEqual({ targetAcosPct: 33 })
    expect(await targetIn(C)).toEqual({ targetAcosPct: 25 })
    expect(await targetIn(LEGACY)).toEqual({ targetAcosPct: null })
    expect(await targetIn(E)).toEqual({ targetAcosPct: null })

    // A halt by stop-automation in E; the dial the catalog shows (A3) reads each business's own row.
    expect((await inBusiness(E, () => stop.applyStop('stop', 'amazon-ads', undefined, undefined, 'R1 test stop', 'u-r1'))).ok).toBe(true)
    expect(await inBusiness(E, () => ads.readHaltState())).toMatchObject({ halted: true, haltReason: 'R1 test stop' })
    for (const ws of [LEGACY, B, C]) expect(await inBusiness(ws, () => ads.readHaltState()), ws).toMatchObject({ halted: false })
    const dialOf = async (ws: string) => inBusiness(ws, () => automationAdapter('A3')!.state())
    expect(await dialOf(E)).toMatchObject({ level: 'OFF', reason: 'Halted: R1 test stop.' })
    expect((await dialOf(LEGACY)).reason).not.toContain('Halted')

    const rows = await rowsOf('AdsAutomationState')
    expect(rows.filter((r) => r.workspaceId === E)).toEqual([{ id: `${E}:singleton`, workspaceId: E }])
    expect(rows.find((r) => r.workspaceId === LEGACY)?.id).toBe('singleton')
  })

  // R16 (decision D-R2) — an engine's per-business switch: set in one business, the others read only their env.
  it('engine switches: one business switched off, the others run on their env; one row per business', async () => {
    const sw = await import('./automation/engine-switch.service.js')
    await inBusiness(B, () => sw.setEngineSwitch('rank-defend', 'OFF', 'user:r16', 'B stops rank-defend'))
    await inBusiness(C, () => sw.setEngineSwitch('rank-defend', 'OFF', 'user:r16'))
    await inBusiness(C, () => sw.setEngineSwitch('budget-enforce', 'OBSERVE', 'user:r16'))
    expect(await inBusiness(B, () => sw.engineMode('rank-defend', 'AUTO'))).toMatchObject({ mode: 'OFF', switched: { mode: 'OFF', reason: 'B stops rank-defend' } })
    expect(await inBusiness(LEGACY, () => sw.engineMode('rank-defend', 'AUTO'))).toEqual({ mode: 'AUTO', switched: null, note: null })
    expect(await inBusiness(B, () => sw.engineMode('budget-enforce', 'AUTO'))).toEqual({ mode: 'AUTO', switched: null, note: null })
    expect((await inBusiness(C, () => sw.engineMode('budget-enforce', 'AUTO'))).mode).toBe('OBSERVE')
    // Back to the top: C's row goes, B's stays.
    await inBusiness(C, () => sw.setEngineSwitch('rank-defend', 'AUTO', 'user:r16'))
    expect((await inBusiness(C, () => sw.engineMode('rank-defend', 'AUTO'))).mode).toBe('AUTO')
    expect((await inBusiness(B, () => sw.engineMode('rank-defend', 'AUTO'))).mode).toBe('OFF')
    const rows = await database.pool.query(`SELECT "workspaceId", key, mode FROM "AutomationSwitch" ORDER BY "workspaceId", key`)
    expect(rows.rows).toEqual([
      ...[{ workspaceId: B, key: 'rank-defend', mode: 'OFF' }, { workspaceId: C, key: 'budget-enforce', mode: 'OBSERVE' }].sort((x, y) => x.workspaceId.localeCompare(y.workspaceId)),
    ])
  })

  it('fleet: a halt in one business halts that fleet only; the legacy row keeps its id', async () => {
    for (const ws of [LEGACY, B, C]) {
      const s = await inBusiness(ws, () => fleet.getFleetState())
      expect({ ws, degraded: s.degraded, halted: s.halted, ceiling: s.dailyCeilingUSD }).toEqual({ ws, degraded: false, halted: false, ceiling: 2 })
    }
    const halted = await inBusiness(C, () => fleet.haltFleet('budget guard', 'auto:budget-guard'))
    expect({ halted: halted.halted, degraded: halted.degraded }).toEqual({ halted: true, degraded: false })
    expect((await inBusiness(C, () => fleet.getFleetState())).halted).toBe(true)
    expect((await inBusiness(LEGACY, () => fleet.getFleetState())).halted).toBe(false)
    expect((await inBusiness(B, () => fleet.getFleetState())).halted).toBe(false)

    await inBusiness(LEGACY, () => fleet.haltFleet('operator stop', 'operator:test'))
    await inBusiness(C, () => fleet.resumeFleet('operator:test'))
    expect((await inBusiness(LEGACY, () => fleet.getFleetState())).halted).toBe(true)
    expect((await inBusiness(C, () => fleet.getFleetState())).halted).toBe(false)
    expect((await inBusiness(B, () => fleet.getFleetState())).halted).toBe(false)

    const rows = await rowsOf('AgentFleetState')
    expect(rows.find((r) => r.workspaceId === LEGACY)?.id).toBe('singleton')
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([LEGACY, B, C].sort())
  })

  it('review mailer: a pause in one business skips that business\'s tick only; the legacy row keeps its id', async () => {
    for (const ws of [LEGACY, B]) {
      expect((await inBusiness(ws, () => mailer.readReviewMailerState())).isPaused).toBe(false)
    }
    await inBusiness(B, () => mailer.pauseReviewMailer({ reason: 'complaint spike', pausedBy: 'operator:test' }))
    expect((await inBusiness(B, () => runReviewMailerOnce())).paused).toBe(true)
    expect((await inBusiness(LEGACY, () => runReviewMailerOnce())).paused).toBeUndefined()
    expect((await inBusiness(C, () => runReviewMailerOnce())).paused).toBeUndefined()
    expect(await inBusiness(LEGACY, () => mailer.findReviewMailerState())).toMatchObject({ isPaused: false })
    expect(await inBusiness(B, () => mailer.findReviewMailerState())).toMatchObject({ isPaused: true, pausedReason: 'complaint spike', pausedBy: 'operator:test' })

    await inBusiness(LEGACY, () => mailer.pauseReviewMailer({ reason: null, pausedBy: null }))
    await inBusiness(B, () => mailer.resumeReviewMailer())
    expect((await inBusiness(LEGACY, () => runReviewMailerOnce())).paused).toBe(true)
    expect((await inBusiness(B, () => runReviewMailerOnce())).paused).toBeUndefined()

    const rows = await rowsOf('ReviewMailerState')
    expect(rows.find((r) => r.workspaceId === LEGACY)?.id).toBe('default')
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([LEGACY, B, C].sort())
  })
})
