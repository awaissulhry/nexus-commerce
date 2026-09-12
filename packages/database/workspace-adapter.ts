import { PrismaPg } from '@prisma/adapter-pg'
import type { Pool } from 'pg'
import { LEGACY_WORKSPACE_ID, WorkspaceError, workspaceContext, type WorkspaceContext } from './workspace-context.js'

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>
type Query = Parameters<Adapter['queryRaw']>[0]

export type WorkspaceResolver = () => Promise<WorkspaceContext | undefined>
let resolver: WorkspaceResolver | undefined
export function registerWorkspaceResolver(next: WorkspaceResolver): void { resolver = next }

export async function resolveWorkspaceContext(): Promise<WorkspaceContext | undefined> {
  return workspaceContext() ?? await resolver?.()
}

async function configure(tx: Transaction, scope: WorkspaceContext | undefined) {
  const id = scope?.workspaceId ?? (process.env.NEXUS_WORKSPACES_ENABLED === '1' ? '' : LEGACY_WORKSPACE_ID)
  // SET LOCAL belongs to this transaction, including when PgBouncer reuses connections.
  await tx.executeRaw({ sql: 'SET LOCAL ROLE nexus_workspace_runtime', args: [], argTypes: [] })
  await tx.queryRaw({
    sql: "SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)",
    args: [id, scope?.actorUserId ?? ''], argTypes: [{ scalarType: 'string', dbType: 'TEXT', arity: 'scalar' }, { scalarType: 'string', dbType: 'TEXT', arity: 'scalar' }],
  })
}

function prohibitScopeMutation(query: Query) {
  // Only this adapter may alter the transaction's authority. User-supplied values remain
  // bound parameters; application raw SQL cannot replace the context or database role.
  // Deliberately conservative: application statements have no reason to change
  // session configuration. Cover parameterized set_config, comments and RESET ALL.
  const sql = query.sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  if (/\bset_config\b|\bRESET\b|\bSET\s+(?:(?:LOCAL|SESSION)\s+)?(?:ROLE|SESSION\s+AUTHORIZATION|nexus\b|row_security\b)|\bDISCARD\b/i.test(sql)) {
    throw new WorkspaceError('workspace_scope_immutable', 'Database workspace context cannot be changed by a query.')
  }
}

function wrapTransaction(tx: Transaction): Transaction {
  return new Proxy(tx, {
    get(target, property) {
      if (property === 'queryRaw' || property === 'executeRaw') return async (query: Query) => {
        prohibitScopeMutation(query)
        return target[property](query)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The same transaction boundary covers ORM queries, nested relations and raw SQL. */
export class WorkspacePg extends PrismaPg {
  constructor(pool: Pool, private readonly scope?: WorkspaceContext) { super(pool) }

  override async connect(): Promise<Adapter> {
    const adapter = await super.connect()
    const captured = this.scope
    return new Proxy(adapter, {
      get(target, property) {
        if (property === 'startTransaction') return async (isolation?: Parameters<Adapter['startTransaction']>[0]) => {
          const tx = await target.startTransaction(isolation)
          try { await configure(tx, captured); return wrapTransaction(tx) }
          catch (error) {
            try { await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] }) }
            finally { await tx.rollback() }
            throw error
          }
        }
        if (property === 'queryRaw' || property === 'executeRaw') return async (query: Query) => {
          prohibitScopeMutation(query)
          const tx = await target.startTransaction()
          try {
            await configure(tx, captured)
            const result = await tx[property](query)
            // Prisma's adapter commit()/rollback() release the connection. Its engine
            // normally sends the SQL; these short transactions are owned by this adapter.
            await tx.executeRaw({ sql: 'COMMIT', args: [], argTypes: [] })
            await tx.commit()
            return result
          } catch (error) {
            try { await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] }) }
            finally { await tx.rollback() }
            throw error
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
}
