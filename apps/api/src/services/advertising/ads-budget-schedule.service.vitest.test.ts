/**
 * 3c (review 6.5 removal, 6.8; Owner S13) — the budget-schedule service on PGlite with the production schema: the
 * real create and edit, the real give-back (updateCampaignWithSync, its local write, action log and queue row).
 * Nothing leaves the process: the queue is a stub and no worker runs.
 *
 * Proven here:
 *   · a campaign is in one switched-on budget schedule at a time: a create, a campaigns edit or a re-enable that would
 *     put it in a second one is refused, the answer names the other schedule, and nothing is written;
 *   · a switched-off schedule does not count (it holds nothing), which is why switching it back on is checked;
 *   · a campaign taken out of a switched-on schedule gets its budget back — only while it still sits at the value the
 *     schedule set; a budget someone changed since is kept, and the answer counts both.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})

const { createBudgetSchedule, patchBudgetSchedule } = await import('./ads-budget-schedule.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const budget = (id: string) => inside(async () => Number((await db().campaign.findUnique({ where: { id }, select: { dailyBudget: true } })).dailyBudget))
const schedule = (name: string) => inside(() => db().budgetSchedule.findFirst({ where: { name } }))
async function seedCampaign(id: string, dailyBudget: number) {
  await inside(() => db().campaign.create({
    data: { id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: String(dailyBudget), startDate: new Date('2026-01-01T00:00:00Z') },
  }))
}
const pick = (...ids: string[]) => ids.map((id) => ({ id, name: `Campaign ${id}`, dailyBudget: 10 }))
const WINDOW = [{ day: 1, start: '18:00', end: '22:00', adj: 'incPct', value: 50 }]

beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterAll(async () => {
  await database?.close()
})

describe('3c — one switched-on budget schedule per campaign (Owner S13)', () => {
  it('🔴 6.8 — a create, a campaigns edit and a re-enable that would share a campaign are refused, naming the other schedule', async () => {
    for (const id of ['ov-a', 'ov-b', 'ov-c']) await seedCampaign(id, 10)

    const first = await inside(() => createBudgetSchedule({ name: 'Weekend boost', campaigns: pick('ov-a'), windows: WINDOW }, 'user:awais'))
    expect('schedule' in first && first.schedule).toMatchObject({ name: 'Weekend boost', kind: 'BUDGET', enabled: true })
    const firstId = (await schedule('Weekend boost')).id
    // The audit row the route always wrote.
    expect(await inside(() => db().advertisingActionLog.count({ where: { actionType: 'budget_schedule_create', entityId: firstId, userId: 'user:awais' } }))).toBe(1)

    // Create: ov-a is already in "Weekend boost" — refused, and nothing is created.
    const second = await inside(() => createBudgetSchedule({ name: 'Evening lift', campaigns: pick('ov-a', 'ov-b'), windows: WINDOW }, 'user:awais'))
    expect(second).toEqual({ conflict: {
      error: 'The campaign “Campaign ov-a” is already in the budget schedule “Weekend boost”. A campaign can be in one switched-on budget schedule at a time: take it out of “Weekend boost”, or pause that schedule, first.',
      scheduleId: firstId, scheduleName: 'Weekend boost', campaignIds: ['ov-a'],
    } })
    expect(await schedule('Evening lift')).toBeNull()

    const third = await inside(() => createBudgetSchedule({ name: 'Evening lift', campaigns: pick('ov-b', 'ov-c'), windows: WINDOW }, 'user:awais'))
    expect('schedule' in third).toBe(true)
    const thirdId = (await schedule('Evening lift')).id

    // Campaigns edit: adding ov-a to "Evening lift" — refused; its campaigns stay as they were.
    const edit = await inside(() => patchBudgetSchedule(thirdId, { campaigns: pick('ov-b', 'ov-c', 'ov-a'), name: 'Evening lift (edited)' }, 'user:awais'))
    expect(edit && 'conflict' in edit && edit.conflict).toMatchObject({ scheduleId: firstId, campaignIds: ['ov-a'] })
    expect((await schedule('Evening lift')).campaigns.map((c: { id: string }) => c.id)).toEqual(['ov-b', 'ov-c'])
    // A schedule cannot conflict with itself: editing its own campaigns is fine.
    expect(await inside(() => patchBudgetSchedule(thirdId, { campaigns: pick('ov-c', 'ov-b') }, 'user:awais'))).toMatchObject({ restore: null })

    // A switched-off schedule holds nothing and does not count…
    expect(await inside(() => patchBudgetSchedule(firstId, { enabled: false }, 'user:awais'))).toMatchObject({ schedule: { enabled: false } })
    expect(await inside(() => patchBudgetSchedule(thirdId, { campaigns: pick('ov-b', 'ov-c', 'ov-a') }, 'user:awais'))).toMatchObject({ schedule: { id: thirdId } })
    // …and an edit while it is off is not checked; switching it back on is.
    expect(await inside(() => patchBudgetSchedule(firstId, { name: 'Weekend boost (off)' }, 'user:awais'))).toMatchObject({ schedule: { enabled: false } })
    const back = await inside(() => patchBudgetSchedule(firstId, { enabled: true }, 'user:awais'))
    expect(back).toEqual({ conflict: {
      error: 'The campaign “Campaign ov-a” is already in the budget schedule “Evening lift”. A campaign can be in one switched-on budget schedule at a time: take it out of “Evening lift”, or pause that schedule, first.',
      scheduleId: thirdId, scheduleName: 'Evening lift', campaignIds: ['ov-a'],
    } })
    expect((await schedule('Weekend boost (off)')).enabled).toBe(false)
  })

  it('names every shared campaign, and says when more schedules hold them', async () => {
    for (const id of ['mx-a', 'mx-b', 'mx-c', 'mx-d', 'mx-e']) await seedCampaign(id, 10)
    await inside(() => createBudgetSchedule({ name: 'Big', campaigns: pick('mx-a', 'mx-b', 'mx-c', 'mx-d'), windows: WINDOW }, 'user:awais'))
    await inside(() => createBudgetSchedule({ name: 'Small', campaigns: pick('mx-e'), windows: WINDOW }, 'user:awais'))
    const out = await inside(() => createBudgetSchedule({ name: 'All', campaigns: pick('mx-a', 'mx-b', 'mx-c', 'mx-d', 'mx-e'), windows: WINDOW }, 'user:awais'))
    expect('conflict' in out && out.conflict.error).toBe(
      '4 campaigns (“Campaign mx-a”, “Campaign mx-b”, “Campaign mx-c” and 1 more) are already in the budget schedule “Big”. A campaign can be in one switched-on budget schedule at a time: take them out of “Big”, or pause that schedule, first. 1 other budget schedule also holds some of these campaigns.',
    )
  })
})

describe('3c — a campaign taken out of a schedule gets its budget back (review 6.5)', () => {
  /** A switched-on schedule that set €15 (from €10) on each of `ids` inside its window. */
  async function holding(name: string, ids: string[], enabled = true) {
    const record = { budget: 15, at: '2026-10-05T18:00:00.000Z', state: 'applied', windowKey: '2026-10-05#1|18:00|22:00|incPct|50', baseCents: 1000, ownCents: 1500 }
    return (await inside(() => db().budgetSchedule.create({ data: {
      name, enabled, timezone: 'UTC', windows: WINDOW, campaigns: pick(...ids),
      lastApplied: Object.fromEntries(ids.map((id) => [id, record])),
    } }))).id as string
  }

  it('🔴 gives back a removed campaign that still sits at the schedule’s value, keeps one someone changed, and leaves the rest', async () => {
    await seedCampaign('rm-a', 15) // still at the schedule's €15
    await seedCampaign('rm-b', 25) // a person set €25 since
    await seedCampaign('rm-c', 15) // stays in the schedule
    const id = await holding('Removal', ['rm-a', 'rm-b', 'rm-c'])

    const out = await inside(() => patchBudgetSchedule(id, { campaigns: pick('rm-c') }, 'user:awais'))
    expect(out && 'restore' in out && out.restore).toEqual({ restored: 1, kept: 1, refused: 0 })
    expect(await budget('rm-a')).toBe(10) // back to the budget before the window
    expect(await budget('rm-b')).toBe(25) // the person's change stays
    expect(await budget('rm-c')).toBe(15) // still in the schedule: untouched
    // The give-back is the schedule's own write, queued for Amazon, carrying the entry it gives back.
    const rows = await inside(() => db().advertisingActionLog.findMany({ where: { actionType: 'AD_BUDGET_UPDATE', entityId: { in: ['rm-a', 'rm-b', 'rm-c'] } }, select: { entityId: true, userId: true, evidence: true } }))
    expect(rows).toEqual([expect.objectContaining({ entityId: 'rm-a', userId: `automation:budget-schedule-${id}` })])
    expect((rows[0].evidence as { giveBackOf?: string }).giveBackOf).toBe('2026-10-05#1|18:00|22:00|incPct|50')
    const queued = await inside(() => db().outboundSyncQueue.findMany({ where: { payload: { path: ['entityId'], string_contains: 'rm-' } }, select: { payload: true } }))
    expect(queued.map((q: { payload: { entityId: string } }) => q.payload.entityId)).toEqual(['rm-a'])
  })

  it('an edit that removes nothing, or a schedule that is off, gives nothing back', async () => {
    await seedCampaign('rn-a', 15)
    await seedCampaign('rn-b', 15)
    const on = await holding('Same set', ['rn-a'])
    expect(await inside(() => patchBudgetSchedule(on, { campaigns: pick('rn-a'), name: 'Same set (renamed)' }, 'user:awais'))).toMatchObject({ restore: null })
    expect(await budget('rn-a')).toBe(15)

    const off = await holding('Switched off', ['rn-b'], false)
    expect(await inside(() => patchBudgetSchedule(off, { campaigns: [] }, 'user:awais'))).toMatchObject({ restore: null })
    expect(await budget('rn-b')).toBe(15)
  })

  it('taking a campaign out and switching off in one edit gives back every campaign once', async () => {
    await seedCampaign('rb-a', 15)
    await seedCampaign('rb-b', 15)
    const id = await holding('Both', ['rb-a', 'rb-b'])
    const out = await inside(() => patchBudgetSchedule(id, { campaigns: pick('rb-b'), enabled: false }, 'user:awais'))
    expect(out && 'restore' in out && out.restore).toEqual({ restored: 2, kept: 0, refused: 0 })
    expect([await budget('rb-a'), await budget('rb-b')]).toEqual([10, 10])
  })
})

describe('4b — window values are read and range-checked before anything is stored (review 4.1)', () => {
  it('🔴 a decimal comma is read, and stored as the number it says ("Set budget 15,50" used to put €1 on every campaign)', async () => {
    const out = await inside(() => createBudgetSchedule({ name: 'Comma', campaigns: pick('dv-a'), windows: [{ day: 1, start: '18:00', end: '22:00', adj: 'set', value: '15,50' }] }, 'user:awais'))
    expect('schedule' in out).toBe(true)
    expect((await schedule('Comma')).windows).toEqual([{ day: 1, start: '18:00', end: '22:00', adj: 'set', value: 15.5 }])
  })

  it('a value that cannot be read, or is out of range, refuses the save with a sentence naming the window; nothing is written', async () => {
    const bad = (windows: unknown[], type?: string) =>
      inside(() => createBudgetSchedule({ name: 'Refused', campaigns: pick('dv-b'), windows, ...(type ? { type } : {}) }, 'user:awais'))
    expect(await bad([{ day: 1, start: '18:00', end: '22:00', adj: 'set', value: 'abc' }])).toEqual({ invalid: {
      error: 'Monday 18:00–22:00: Set budget to (€): "abc" is not a number — type digits with at most one decimal comma or point, for example 2,5.',
    } })
    expect(await bad([{ day: 2, start: '08:00', end: '12:00', adj: 'decPct', value: 150 }])).toEqual({ invalid: { error: 'Tuesday 08:00–12:00: Decrease budget by (%) must be at most 100 (it is 150).' } })
    expect(await bad([{ day: 3, start: '18:00', end: '22:00', adj: 'set', value: '0,5' }])).toEqual({ invalid: { error: 'Wednesday 18:00–22:00: Set budget to (€) must be at least 1 (it is 0.5).' } })
    expect(await bad([{ day: 4, start: '18:00', end: '22:00', adj: 'incPct', value: '' }])).toEqual({ invalid: { error: 'Thursday 18:00–22:00: Increase budget by (%) is empty: type a number.' } })
    expect(await bad([{ day: 0, start: '', end: '', adj: 'mult', value: 0 }], 'budget-multiplier')).toEqual({ invalid: { error: 'Sunday (all day): Multiplier (×) must be above 0 (it is 0).' } })
    expect(await schedule('Refused')).toBeNull()
  })

  it('an edit reads new windows against the stored type, and a refused edit changes nothing', async () => {
    const made = await inside(() => createBudgetSchedule({ name: 'Multiplier', type: 'budget-multiplier', campaigns: pick('dv-c'), windows: [{ day: 1, start: '', end: '', adj: 'mult', value: 2 }] }, 'user:awais'))
    const id = ('schedule' in made ? made.schedule.id : '') as string
    expect(await inside(() => patchBudgetSchedule(id, { windows: [{ day: 1, start: '', end: '', adj: 'mult', value: '-1' }] }, 'user:awais')))
      .toEqual({ invalid: { error: 'Monday (all day): Multiplier (×) must be above 0 (it is -1).' } })
    expect((await schedule('Multiplier')).windows).toEqual([{ day: 1, start: '', end: '', adj: 'mult', value: 2 }])
    expect(await inside(() => patchBudgetSchedule(id, { windows: [{ day: 1, start: '', end: '', adj: 'mult', value: '1,25' }] }, 'user:awais')))
      .toMatchObject({ schedule: { windows: [{ value: 1.25 }] } })
    // A schedule that does not exist is still "not found", whatever its windows say.
    expect(await inside(() => patchBudgetSchedule('nope', { windows: [{ day: 1, adj: 'set', value: 'abc' }] }, 'user:awais'))).toBeNull()
  })
})
