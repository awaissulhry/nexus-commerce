import { PrismaPg } from '@prisma/adapter-pg'
import type { SqlDriverAdapterFactory } from '@prisma/client/runtime/client'
import type { Pool } from 'pg'
import { makeScope, scopeStatement, TenantScopeError, type Scope, type ScopeDefinition, type ScopeValues } from './scope'
import { checkStatement } from './sql-guard'

/**
 * The fail-closed tenant adapter for Prisma 7 + `pg`: around a `PrismaPg`, every statement runs inside a transaction that
 * first enters the scope (the role and every setting, in ONE statement with bound values). Ported from Commerce's
 * `WorkspacePg` (packages/database/workspace-adapter.ts), made generic and stricter:
 *   - the scope is checked when the adapter is made; a missing required value throws, there is no fallback scope;
 *   - every statement passes `checkStatement` (sql-guard.ts) first, Prisma's own statements included;
 *   - a statement outside a transaction gets its own: BEGIN, the scope, the statement, COMMIT (Commerce's "off switch"
 *     path; its one-round-trip batch on pg internals is not ported);
 *   - inside a transaction, the bare COMMIT or ROLLBACK that Prisma's engine sends ends it, and the adapter then
 *     refuses any further statement on it (a raw COMMIT cannot leave later statements running unscoped);
 *   - `executeScript` (migrations) is refused: DDL never runs through a scoped adapter.
 *
 * The scope is FIXED per adapter: make one PrismaClient per scope. One client must never serve two scopes, because
 * Prisma batches some reads of one client into one statement. It wraps a `PrismaPg` instead of extending it, so no
 * unscoped method of the pg adapter (a shadow database, the raw pool) is reachable through it.
 */

type Adapter = Awaited<ReturnType<SqlDriverAdapterFactory['connect']>>
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>
type Query = Parameters<Adapter['queryRaw']>[0]
type Isolation = Parameters<Adapter['startTransaction']>[0]
type PrismaPgOptions = ConstructorParameters<typeof PrismaPg>[1]

const TEXT = { scalarType: 'string', dbType: 'TEXT', arity: 'scalar' } as const

async function enterScope(tx: Transaction, scope: Scope): Promise<void> {
  const { sql, values } = scopeStatement(scope)
  await tx.queryRaw({ sql, args: values, argTypes: values.map(() => TEXT) })
}

/**
 * Ends a transaction after a failure: ROLLBACK, then hand the connection back (Prisma's own order). A failure here is
 * swallowed so the caller rethrows the error that matters (a refused scope, a policy violation), not the cleanup's.
 */
async function abandon(tx: Transaction): Promise<void> {
  try {
    await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] })
  } catch {
    // The connection is broken or the transaction is gone; either way the scope ended with it.
  } finally {
    await tx.rollback().catch(() => {})
  }
}

/** A transaction whose statements are guarded and which refuses everything once COMMIT or ROLLBACK went through. */
function guardedTransaction(tx: Transaction): Transaction {
  let ended = false
  const open = (): void => {
    if (ended) throw new TenantScopeError('scope_closed', 'This transaction already ended; no statement may run on it.')
  }
  const run =
    <R>(method: 'queryRaw' | 'executeRaw') =>
    async (query: Query): Promise<R> => {
      open()
      const kind = checkStatement(query.sql)
      if (kind !== 'query') ended = true
      return (await tx[method](query)) as R
    }
  const savepoint = (method: 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint') => {
    const inner = tx[method]
    if (inner === undefined) return undefined
    return async (name: string): Promise<void> => {
      open()
      await inner.call(tx, name)
    }
  }
  const guarded: Transaction = {
    provider: tx.provider,
    adapterName: tx.adapterName,
    options: tx.options,
    queryRaw: run('queryRaw'),
    executeRaw: run('executeRaw'),
    commit: () => tx.commit(),
    rollback: () => tx.rollback(),
  }
  for (const method of ['createSavepoint', 'rollbackToSavepoint', 'releaseSavepoint'] as const) {
    const wrapped = savepoint(method)
    if (wrapped) guarded[method] = wrapped
  }
  return guarded
}

export class TenantPg<K extends string = string> implements SqlDriverAdapterFactory {
  readonly provider = 'postgres' as const
  readonly adapterName: string
  /** The checked, frozen scope every statement of this adapter runs in. */
  readonly scope: Scope
  private readonly pg: PrismaPg

  constructor(pool: Pool, definition: ScopeDefinition<K>, values: ScopeValues<K>, options?: PrismaPgOptions) {
    // Check first: a bad scope never reaches the pool.
    this.scope = makeScope(definition, values)
    this.pg = new PrismaPg(pool, options)
    this.adapterName = this.pg.adapterName
  }

  async connect(): Promise<Adapter> {
    const inner = await this.pg.connect()
    const scope = this.scope

    const startTransaction = async (isolation?: Isolation): Promise<Transaction> => {
      const tx = await inner.startTransaction(isolation)
      try {
        await enterScope(tx, scope)
      } catch (error) {
        await abandon(tx)
        throw error
      }
      return guardedTransaction(tx)
    }

    const standalone =
      <R>(method: 'queryRaw' | 'executeRaw') =>
      async (query: Query): Promise<R> => {
        // Refuse before a connection is taken. COMMIT or ROLLBACK outside a transaction has nothing to end.
        if (checkStatement(query.sql) !== 'query') {
          throw new TenantScopeError('statement_refused', 'Statement refused by the tenant scope: transaction control outside a transaction.')
        }
        const tx = await inner.startTransaction()
        let result: R
        try {
          await enterScope(tx, scope)
          result = (await tx[method](query)) as R
          await tx.executeRaw({ sql: 'COMMIT', args: [], argTypes: [] })
        } catch (error) {
          await abandon(tx)
          throw error
        }
        await tx.commit()
        return result
      }

    const adapter: Adapter = {
      provider: inner.provider,
      adapterName: inner.adapterName,
      queryRaw: standalone('queryRaw'),
      executeRaw: standalone('executeRaw'),
      startTransaction,
      executeScript: async () => {
        throw new TenantScopeError('scope_closed', 'A scoped adapter does not run scripts; migrations use the owner login.')
      },
      dispose: () => inner.dispose(),
    }
    const info = inner.getConnectionInfo?.bind(inner)
    if (info) adapter.getConnectionInfo = info
    return adapter
  }
}
