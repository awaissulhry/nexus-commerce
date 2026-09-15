import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, PrismaClient } from '@prisma/client'

type Context = { client: Prisma.TransactionClient; effects: Map<string, () => Promise<unknown>>; producers: Map<string, () => Promise<unknown>> }
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
    return context.run({ client: tx, effects: new Map(), producers: new Map() }, work)
  }, { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 20_000 })
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

export async function inDatabaseTransaction<T>(client: PrismaClient, work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work()
  for (let attempt = 0; ; attempt++) {
    const effects = new Map<string, () => Promise<unknown>>()
    const producers = new Map<string, () => Promise<unknown>>()
    let result: T
    try {
      result = await client.$transaction(tx => context.run({ client: tx, effects, producers }, async () => {
        const value = await work()
        while (producers.size) {
          const pending = [...producers.values()]; producers.clear()
          for (const produce of pending) await produce()
        }
        return value
      }), {
        isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000,
      })
    } catch (error) {
      if (attempt < 2 && (error as { code?: string }).code === 'P2034') continue
      throw error
    }
    // Derived refreshes run only after commit. A refresh cannot turn a committed write into a refusal.
    const outcomes = await Promise.allSettled([...effects.values()].map(effect => effect()))
    for (const outcome of outcomes) if (outcome.status === 'rejected') console.warn('[formula] post-commit refresh failed', outcome.reason)
    return result
  }
}
