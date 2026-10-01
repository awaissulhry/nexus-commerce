import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl, CONCURRENT_PG_ENV } from '../test-support/concurrent-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from './workspace-context.js'
import { afterDatabaseCommit, contextualDatabase, inDatabaseTransaction } from './database-context.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const signal = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe.skipIf(!concurrentDatabaseUrl())(`transaction commit race (needs ${CONCURRENT_PG_ENV})`, () => {
  let db: Awaited<ReturnType<typeof concurrentDatabase>>
  beforeAll(async () => { db = await concurrentDatabase() }, 120_000)
  afterAll(async () => { await db?.close() }, 60_000)

  it('retries a real conflict at COMMIT, with a fresh snapshot and effects only from the committed attempt', async () => {
    const ids = ['commit-race-first', 'commit-race-second']
    await scoped(() => db.client.product.createMany({ data: ids.map(id => ({ id, sku: id, name: 'initial', basePrice: 1 })) }))
    const database = contextualDatabase(db.client)
    const firstRead = signal(), secondRead = signal(), firstWrite = signal(), secondWrite = signal(), firstCommitted = signal()
    const attempts = [0, 0]
    const failures: Array<{ callbackFinished: boolean; error: unknown }> = []
    const snapshots: string[][][] = [[], []]
    const effects: string[] = []
    // Forward the REAL transaction untouched; observe whether its callback returned before COMMIT failed.
    const observed = new Proxy(db.client, { get(target, property) {
      if (property === '$transaction') return async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
        let callbackFinished = false
        try { return await target.$transaction(async tx => { const result = await work(tx); callbackFinished = true; return result }, options as never) }
        catch (error) { failures.push({ callbackFinished, error }); throw error }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const run = (index: number) => scoped(() => inDatabaseTransaction(observed, async () => {
      const attempt = ++attempts[index]
      const rows = await database.product.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { name: true } })
      snapshots[index].push(rows.map(row => row.name))
      if (attempt === 1) {
        if (index === 0) { firstRead.release(); await secondRead.promise }
        else { secondRead.release(); await firstRead.promise; await firstWrite.promise }
      }
      await database.product.update({ where: { id: ids[index] }, data: { name: `${rows[index].name}-saved` } })
      await afterDatabaseCommit(`saved-${index}`, async () => { effects.push(`${index}:${attempt}`) })
      if (attempt === 1) {
        if (index === 0) { firstWrite.release(); await secondWrite.promise }
        else { secondWrite.release(); await firstCommitted.promise }
      }
    }, { timeoutMs: 10_000 }))
    // All gates are released on failure too, so a failed positive control cannot strand teardown.
    const first = run(0).finally(() => { firstCommitted.release(); firstRead.release(); firstWrite.release() })
    const second = run(1).finally(() => { secondRead.release(); secondWrite.release() })
    const results = await Promise.allSettled([first, second])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ callbackFinished: true, error: { name: 'DriverAdapterError', cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } } })
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(attempts).toEqual([1, 2])
    expect(snapshots[1]).toEqual([['initial', 'initial'], ['initial-saved', 'initial']])
    const stored = await scoped(() => db.client.product.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: { name: true } }))
    expect(stored.map(row => row.name)).toEqual(['initial-saved', 'initial-saved'])
    expect(effects).toEqual(['0:1', '1:2'])
  }, 40_000)
})
