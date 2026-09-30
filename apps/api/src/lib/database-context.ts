import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, PrismaClient } from '@prisma/client'
import { memoizeReads, type ReadMemo } from './transaction-read-memo.js'

type Context = {
  client: Prisma.TransactionClient; isolationLevel: Prisma.TransactionIsolationLevel
  /** `memoReads` transactions: repeated reads answered from memory (transaction-read-memo.ts). */
  memo?: ReadMemo
  effects: Map<string, () => Promise<unknown>>; producers: Map<string, () => Promise<unknown>>
  /** Items collected under one after-commit key (`afterDatabaseCommitBatch`), so N writers pay ONE effect. */
  batches: Map<string, Set<unknown>>
}
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
    return context.run({ client: tx, isolationLevel: 'RepeatableRead', effects: new Map(), producers: new Map(), batches: new Map() }, work)
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

/**
 * Like `afterDatabaseCommit`, but every call with the same `key` in one transaction adds its `items` to ONE effect that
 * runs once after commit with all of them.
 *
 * A bulk save runs the ordinary row writer once per row inside one transaction. Each row asked for its own read-cache
 * refresh, so 250 rows started 250 Serializable refreshes at once after commit — every one of them rewriting the same
 * parent's cache row. Collected here they are one refresh of 250 products.
 */
export async function afterDatabaseCommitBatch<T>(key: string, items: readonly T[], run: (items: T[]) => Promise<unknown>) {
  const active = context.getStore()
  if (!active) { await run([...items]); return }
  const bag = (active.batches.get(key) ?? new Set<unknown>()) as Set<T>
  for (const item of items) bag.add(item)
  active.batches.set(key, bag)
  // Read the bag when the effect RUNS: a savepoint rollback replaces it with the copy taken before the row.
  active.effects.set(key, () => run([...((active.batches.get(key) ?? []) as Set<T>)]))
}

/**
 * B31 — `afterDatabaseCommitBatch`, but the work runs INSIDE the transaction, just before it commits: every caller's
 * items, in order, in one call (a bulk save's per-row audit rows become one INSERT). A savepoint rolled back drops its
 * own items with it. Outside a transaction the work runs at once.
 */
export async function beforeDatabaseCommitBatch<T>(key: string, items: readonly T[], run: (items: T[]) => Promise<unknown>) {
  const active = context.getStore()
  if (!active) { await run([...items]); return }
  const bag = (active.batches.get(key) ?? new Set<unknown>()) as Set<T>
  for (const item of items) bag.add(item)
  active.batches.set(key, bag)
  active.producers.set(key, () => run([...((active.batches.get(key) ?? []) as Set<T>)]))
}

/** PSIE — is a before-commit producer with this key already registered in the active transaction? */
export function hasBeforeDatabaseCommit(key: string): boolean {
  return context.getStore()?.producers.has(key) ?? false
}
/** PSIE — drop registered before-commit producers whose key starts with `prefix` (a wider producer covers them). */
export function dropBeforeDatabaseCommit(prefix: string): void {
  const producers = context.getStore()?.producers
  if (producers) for (const key of [...producers.keys()]) if (key.startsWith(prefix)) producers.delete(key)
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
  return causesOf(error).some(isRaceFailure)
}

/**
 * An error and the errors it wraps (`cause`), outermost first.
 *
 * 🔴 A conflict must be recognised when it is WRAPPED. `applyProductBulkEdits` turns every unexpected error into
 * `ProductBulkError(500)`; before it kept the original as `cause`, a deadlock inside a save reached the retry loop as a
 * plain 500 and was never retried (measured 2026-09-29: a 250-row fill, 61 answers of 500).
 */
function causesOf(error: unknown): unknown[] {
  const chain: unknown[] = []
  for (let e = error; e && chain.length < 5 && !chain.includes(e); e = (e as { cause?: unknown }).cause) chain.push(e)
  return chain
}

/**
 * PostgreSQL refused a statement because an EARLIER statement of the same transaction already failed (SQLSTATE 25P02,
 * Prisma P2039 "current transaction is aborted").
 *
 * It says nothing about what failed first — and that first failure is often a lost race: the sheet read runs queries in
 * parallel on the transaction's one connection (`Promise.all`), so when one loses a serialization check its siblings
 * answer 25P02, and whichever settles first is the error the caller sees. Measured 2026-09-29: 56 of 250 saves failed
 * with 25P02 and none was retried. The transaction is dead either way, so running it again is the only recovery; a
 * failure that is not a race fails again the same way and surfaces after the last attempt.
 */
export function abortedByEarlierStatement(error: unknown): boolean {
  type Cause = { originalCode?: string; code?: string }
  return causesOf(error).some(item => {
    const e = item as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: Cause } }; message?: string } | null
    if (!e) return false
    const cause = e.meta?.driverAdapterError?.cause
    if (e.meta?.code === '25P02' || cause?.originalCode === '25P02' || cause?.code === '25P02') return true
    return /Code: `25P02`|code: "25P02"|current transaction is aborted/.test(e.message ?? '')
  })
}

/** The whole transaction must run again from the start: it lost a race, or a hidden failure already killed it. */
export function transactionMustRestart(error: unknown): boolean {
  return retryableConflict(error) || abortedByEarlierStatement(error)
}

function isRaceFailure(error: unknown): boolean {
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

/**
 * `memoReads` (P2): repeated reads inside this transaction are answered from memory until this transaction writes
 * (transaction-read-memo.ts). Only for a snapshot isolation level, where a repeated read returns the same rows.
 */
export async function inDatabaseTransaction<T>(client: PrismaClient, work: () => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeoutMs?: number; memoReads?: boolean }): Promise<T> {
  const existing = context.getStore()
  if (existing) {
    if (options?.isolationLevel && options.isolationLevel !== existing.isolationLevel) throw new Error('The requested transaction isolation does not match the current transaction.')
    return work()
  }
  const isolationLevel = options?.isolationLevel ?? 'Serializable'
  if (options?.memoReads && isolationLevel !== 'Serializable' && isolationLevel !== 'RepeatableRead') throw new Error('Remembered reads need a snapshot transaction (Serializable or Repeatable Read).')
  for (let attempt = 0; ; attempt++) {
    const effects = new Map<string, () => Promise<unknown>>()
    const producers = new Map<string, () => Promise<unknown>>()
    const batches = new Map<string, Set<unknown>>()
    let result: T
    try {
      result = await client.$transaction(tx => {
        // A restarted attempt starts with nothing remembered: it reads a new snapshot.
        const reads = options?.memoReads ? memoizeReads(tx) : null
        return context.run({ client: reads?.client ?? tx, memo: reads?.memo, isolationLevel, effects, producers, batches }, async () => {
        const value = await work()
        while (producers.size) {
          const pending = [...producers.values()]; producers.clear()
          for (const produce of pending) await produce()
        }
        return value
      })
      }, {
        isolationLevel, maxWait: 10_000, timeout: options?.timeoutMs ?? 60_000,
      })
    } catch (error) {
      if (attempt < 2 && transactionMustRestart(error)) continue
      throw error
    }
    // Derived refreshes run only after commit. A refresh cannot turn a committed write into a refusal.
    const outcomes = await Promise.allSettled([...effects.values()].map(effect => effect()))
    for (const outcome of outcomes) if (outcome.status === 'rejected') console.warn('[formula] post-commit refresh failed', outcome.reason)
    return result
  }
}

const restoreInPlace = <K, V>(target: Map<K, V>, snapshot: Map<K, V>) => { target.clear(); for (const [key, value] of snapshot) target.set(key, value) }

/**
 * Run `work` inside a SAVEPOINT of the active transaction: if it fails, only its own statements are undone and the
 * transaction carries on — a bulk save keeps every row that saved and reports the one that did not.
 *
 * The savepoint is Prisma's own nested transaction (Prisma 7: `$transaction` on a transaction client issues SAVEPOINT /
 * RELEASE / ROLLBACK TO SAVEPOINT). Raw savepoint SQL is refused by the business-profile guard (`workspace-sql.ts`),
 * and `work` keeps querying through the SAME guarded transaction client: its statements run on the transaction's one
 * connection, so they belong to the savepoint (measured 2026-09-29 on a real server: the refused unit's write was
 * undone, the unit before it kept, the transaction committed).
 *
 * Its after-commit effects, before-commit producers and batched items are undone with it, so a row that rolled back
 * never publishes an event, refreshes a cache or rebuilds readiness for a write that is not there.
 *
 * A failure that kills the whole transaction (`transactionMustRestart`: a lost race, or 25P02) is NOT contained: a
 * savepoint cannot bring a transaction back from a serialization failure, so it is rethrown and the whole transaction
 * runs again.
 */
export async function inSavepoint<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const active = context.getStore()
  if (!active) throw new Error('A savepoint requires the content transaction.')
  const effects = new Map(active.effects)
  const producers = new Map(active.producers)
  const batches = new Map([...active.batches].map(([key, bag]) => [key, new Set(bag)]))
  const client = active.client as unknown as { $transaction: (run: () => Promise<unknown>) => Promise<unknown> }
  let value: T
  try {
    await client.$transaction(async () => { value = await work() })
    return { ok: true, value: value! }
  } catch (error) {
    if (transactionMustRestart(error)) throw error
    // The savepoint's writes are undone: a read remembered after them no longer describes the database.
    active.memo?.clear()
    restoreInPlace(active.effects, effects)
    restoreInPlace(active.producers, producers)
    restoreInPlace(active.batches, batches)
    return { ok: false, error }
  }
}
