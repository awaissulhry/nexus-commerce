/**
 * Shared stock — a failed pool task is released at once with a back-off (Owner 2026-10-06: "make sure that the
 * stock updates in real time across profiles"). It used to keep its claim, so the next try waited the full two
 * minutes a claim needs to count as dead. On a disposable PostgreSQL (PGlite) with the generated production
 * policies, profiles ON; the recascade itself is a fake that fails or succeeds on demand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// db.ts exports contextualDatabase(prisma), and so must this mock (see stock-pool-rules.vitest.test.ts).
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
const fake = vi.hoisted(() => ({ recascade: vi.fn(), notify: vi.fn(async () => undefined) }))
vi.mock('../stock-movement.service.js', () => ({ recascadeProduct: fake.recascade }))
vi.mock('./pool-notify.js', () => ({ notifyOwners: fake.notify }))
vi.mock('../inventory-oversell-watchdog.service.js', () => ({ evaluateOversellRisk: vi.fn(async () => null) }))

const B = 'ws_b_pool_tasks'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

describe('pool tasks — a failed task is released with a back-off', () => {
  let tasks: typeof import('./pool-tasks.js')
  let productId = ''
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Array<Record<string, any>>
  const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const pending = () => withWorkspace({ workspaceId: '', actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    database.client.$queryRaw<Array<{ workspace_id: string }>>`SELECT workspace_id FROM nexus_pool_pending_workspaces()`)
  const task = async () => (await sql(`SELECT "claimedAt", "retryAt", attempts, "lastError", EXTRACT(EPOCH FROM ("retryAt" - CURRENT_TIMESTAMP)) AS wait FROM "StockPoolTask"`))[0]
  const queue = (fields = '', values = '') =>
    sql(`INSERT INTO "StockPoolTask" (id, "workspaceId", kind, "productId", reason${fields}) VALUES ($1,$2,'recascade',$3,'stock'${values})`, [randomUUID(), B, productId])

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    tasks = await import('./pool-tasks.js')
    await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Borrower B','active','pool',$1,CURRENT_TIMESTAMP)`, [B])
    productId = randomUUID()
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,'SKU-T1','Product T1',10,CURRENT_TIMESTAMP)`, [productId, B])
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  beforeEach(async () => {
    await sql(`DELETE FROM "StockPoolTask"`)
    fake.recascade.mockReset()
    fake.notify.mockClear()
  })

  it('the back-off starts at 5 s, doubles, and never exceeds 5 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 10].map(tasks.retryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
    expect(tasks.retryDelayMs(10_000)).toBe(300_000)
    expect(tasks.retryDelayMs(0)).toBe(5_000)
  })

  it('a failure releases the claim at once and sets the retry time; the task is not taken again before it', async () => {
    fake.recascade.mockRejectedValueOnce(new Error('lock timeout'))
    await queue()
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 1, failed: 1, recascaded: 0 })
    const failed = await task()
    expect(failed.claimedAt).toBeNull()
    expect(failed.attempts).toBe(1)
    expect(failed.lastError).toBe('lock timeout')
    expect(Number(failed.wait)).toBeGreaterThan(3)
    expect(Number(failed.wait)).toBeLessThanOrEqual(5)
    // Not due yet: neither the claim nor the worker's list takes it.
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 0 })
    expect(await pending()).toEqual([])
    expect(fake.recascade).toHaveBeenCalledTimes(1)

    // Due (the clock moved past its retry time): listed, taken, done, gone.
    await sql(`UPDATE "StockPoolTask" SET "retryAt" = CURRENT_TIMESTAMP - interval '1 second'`)
    expect(await pending()).toEqual([{ workspace_id: B }])
    fake.recascade.mockResolvedValueOnce({ ok: true })
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 1, recascaded: 1, failed: 0 })
    expect(await sql(`SELECT id FROM "StockPoolTask"`)).toEqual([])
  })

  it('each further failure waits longer, and the owners are told at the tenth', async () => {
    fake.recascade.mockRejectedValue(new Error('still failing'))
    await queue(', attempts', ', 3')
    await inB(() => tasks.processStockPoolTasks())
    const fourth = await task()
    expect(fourth.attempts).toBe(4)
    expect(Number(fourth.wait)).toBeGreaterThan(38)
    expect(Number(fourth.wait)).toBeLessThanOrEqual(40)
    expect(fake.notify).not.toHaveBeenCalled()

    await sql(`UPDATE "StockPoolTask" SET attempts = 9, "retryAt" = NULL`)
    await inB(() => tasks.processStockPoolTasks())
    const tenth = await task()
    expect(tenth.attempts).toBe(10)
    expect(tenth.claimedAt).toBeNull()
    expect(Number(tenth.wait)).toBeGreaterThan(298)
    expect(Number(tenth.wait)).toBeLessThanOrEqual(300)
    expect(fake.notify).toHaveBeenCalledTimes(1)
  })

  it('a run whose claim another run took over leaves that claim alone when it fails', async () => {
    // The first run outlives its claim: meanwhile another run takes the task over (a fresh claim, attempts 2), and
    // then the first run's recascade fails.
    fake.recascade.mockImplementationOnce(async () => {
      await sql(`UPDATE "StockPoolTask" SET attempts = attempts + 1, "claimedAt" = CURRENT_TIMESTAMP`)
      throw new Error('lock timeout')
    })
    await queue()
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 1, failed: 1 })
    const row = await task()
    expect(row.claimedAt).not.toBeNull() // the other run's claim stands
    expect(row.attempts).toBe(2)
    expect(row.retryAt).toBeNull()
    expect(row.lastError).toBeNull()
    // So no third run takes it while the second works.
    expect(await pending()).toEqual([])
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 0 })
    expect(fake.recascade).toHaveBeenCalledTimes(1)
  })

  it('a claim older than two minutes (a runner that died) is still taken again, whatever its retry time', async () => {
    fake.recascade.mockResolvedValue({ ok: true })
    await queue(', "claimedAt", "retryAt"', `, CURRENT_TIMESTAMP - interval '3 minutes', CURRENT_TIMESTAMP + interval '1 hour'`)
    expect(await pending()).toEqual([{ workspace_id: B }])
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 1, recascaded: 1 })
    // A live claim (a runner at work) is left alone.
    await queue(', "claimedAt"', ', CURRENT_TIMESTAMP')
    expect(await pending()).toEqual([])
    expect(await inB(() => tasks.processStockPoolTasks())).toMatchObject({ claimed: 0 })
  })
})
