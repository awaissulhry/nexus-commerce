import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, PrismaClient } from '@prisma/client'

type Context = { client: Prisma.TransactionClient; isolationLevel: Prisma.TransactionIsolationLevel; effects: Map<string, () => Promise<unknown>>; producers: Map<string, () => Promise<unknown>> }
const context = new AsyncLocalStorage<Context>()

/** Formula operations reuse the ordinary writers inside one outer transaction. */
export function contextualDatabase(root: PrismaClient): PrismaClient {
  return new Proxy(root, {
    get(target, property) {
      const active = context.getStore()
      if (active && property === '$transaction') return async (work: unknown) => {
        if (typeof work === 'function') return work(active.client)
        const results = []
        for (const statement of work as Promise<unknown>[]) results.push(await statement)
        return results
      }
      const owner = active?.client ?? target
      const value = Reflect.get(owner, property, owner)
      return typeof value === 'function' ? value.bind(owner) : value
    },
  })
}

export const activeDatabaseTransaction = () => context.getStore()?.client

/** A sheet reads many related tables. Configure workspace ownership once for its snapshot,
 * rather than opening a new transaction for every query over the database connection. */
export async function inDatabaseReadTransaction<T>(client: PrismaClient, work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work()
  return client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`
    return context.run({ client: tx, isolationLevel: 'RepeatableRead', effects: new Map(), producers: new Map() }, work)
  }, { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 20_000 })
}

/** Work that must never join the caller's transaction: a cache row written while a read-only sheet
 * snapshot is open would fail, and a failure would roll the caller back. The business context is
 * a separate store and stays in force. */
export function outsideDatabaseTransaction<T>(work: () => Promise<T>): Promise<T> {
  return context.exit(work)
}

/** Fastify injection starts a new async resource; carry only an internal context handle. */
export function captureDatabaseContext() {
  const captured = context.getStore()
  return <T>(work: () => Promise<T>): Promise<T> => captured ? context.run(captured, work) : work()
}

export async function afterDatabaseCommit(key: string, effect: () => Promise<unknown>) {
  const active = context.getStore()
  if (active) { active.effects.set(key, effect); return }
  await effect()
}

/** Deduplicated synchronous producers: failure rolls the entire content transaction back. */
export async function beforeDatabaseCommit(key: string, producer: () => Promise<unknown>) {
  const active = context.getStore()
  if (!active) throw new Error('A readiness producer requires the content transaction.')
  active.producers.set(key, producer)
}

/**
 * A transaction PostgreSQL rolled back because it lost a race — safe to run again from the start.
 *
 * Prisma reports the same conflict several ways: `P2034` from its own queries; `P2010` from raw SQL, with the SQLSTATE
 * in `meta.code` (Prisma 6) or in `meta.driverAdapterError.cause` as `originalCode` and kind `TransactionWriteConflict`
 * (Prisma 7's pg adapter maps 40001 and 40P01 to that kind); and a message carrying the code for a deadlock victim.
 * Before P2 (docs/attributes/PLAN.md §4.7) only `P2034` was retried, so a serialization conflict raised by raw SQL
 * failed a save that a retry would have completed (measured in readiness-pending-race.vitest.test.ts).
 */
export function retryableConflict(error: unknown): boolean {
  type Cause = { originalCode?: string; code?: string; kind?: string }
  const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: Cause } }; message?: string } | null
  if (!e) return false
  if (e.code === 'P2034') return true
  if (e.code === 'P2010') {
    const cause = e.meta?.driverAdapterError?.cause
    const sqlstate = e.meta?.code ?? cause?.originalCode ?? cause?.code
    if (sqlstate === '40001' || sqlstate === '40P01' || cause?.kind === 'TransactionWriteConflict') return true
  }
  return /code: "(40001|40P01)"|Code: `(40001|40P01)`/.test(e.message ?? '')
}

export async function inDatabaseTransaction<T>(client: PrismaClient, work: () => Promise<T>, options?: { isolationLevel: Prisma.TransactionIsolationLevel }): Promise<T> {
  const existing = context.getStore()
  if (existing) {
    if (options && options.isolationLevel !== existing.isolationLevel) throw new Error('The requested transaction isolation does not match the current transaction.')
    return work()
  }
  const isolationLevel = options?.isolationLevel ?? 'Serializable'
  for (let attempt = 0; ; attempt++) {
    const effects = new Map<string, () => Promise<unknown>>()
    const producers = new Map<string, () => Promise<unknown>>()
    let result: T
    try {
      result = await client.$transaction(tx => context.run({ client: tx, isolationLevel, effects, producers }, async () => {
        const value = await work()
        while (producers.size) {
          const pending = [...producers.values()]; producers.clear()
          for (const produce of pending) await produce()
        }
        return value
      }), {
        isolationLevel, maxWait: 10_000, timeout: 60_000,
      })
    } catch (error) {
      if (attempt < 2 && retryableConflict(error)) continue
      throw error
    }
    // Derived refreshes run only after commit. A refresh cannot turn a committed write into a refusal.
    const outcomes = await Promise.allSettled([...effects.values()].map(effect => effect()))
    for (const outcome of outcomes) if (outcome.status === 'rejected') console.warn('[formula] post-commit refresh failed', outcome.reason)
    return result
  }
}
