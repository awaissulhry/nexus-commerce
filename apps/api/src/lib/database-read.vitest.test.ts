import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { assertWorkspaceSql } from '../../../../packages/database/workspace-sql.js'
import { activeDatabaseTransaction, contextualDatabase, inDatabaseReadTransaction, inDatabaseTransaction } from './database-context.js'

function database() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(0), product: { findMany: vi.fn().mockResolvedValue(['snapshot']) } }
  const root = { $transaction: vi.fn(async (work, _options?: unknown) => work(tx)), product: { findMany: vi.fn().mockResolvedValue(['outside']) } }
  const client = contextualDatabase(root as unknown as PrismaClient)
  return { tx, root, client }
}

describe('sheet read transaction', () => {
  it('uses one read-only snapshot for concurrent related reads, including nested reads', async () => {
    const { client, root, tx } = database()
    const result = await inDatabaseReadTransaction(client, async () => {
      expect(activeDatabaseTransaction()).toBe(tx)
      return Promise.all([client.product.findMany(), inDatabaseReadTransaction(client, () => client.product.findMany())])
    })
    expect(result).toEqual([['snapshot'], ['snapshot']])
    expect(root.$transaction).toHaveBeenCalledOnce()
    expect(root.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 20000 })
    expect(tx.$executeRaw.mock.calls[0][0]).toEqual(['SET TRANSACTION READ ONLY'])
    expect(root.product.findMany).not.toHaveBeenCalled()
    expect(await client.product.findMany()).toEqual(['outside'])
    expect(activeDatabaseTransaction()).toBeUndefined()
  })

  it('keeps a writer’s existing transaction and its uncommitted edits visible', async () => {
    const { client, root, tx } = database()
    await inDatabaseTransaction(client, () => inDatabaseReadTransaction(client, () => client.product.findMany()))
    expect(root.$transaction).toHaveBeenCalledOnce()
    expect(tx.$executeRaw).not.toHaveBeenCalled()
    expect(tx.product.findMany).toHaveBeenCalledOnce()
  })

  it('releases the failed snapshot without leaking it into a subsequent request', async () => {
    const { client, root } = database()
    await expect(inDatabaseReadTransaction(client, async () => { throw Error('read failed') })).rejects.toThrow('read failed')
    expect(activeDatabaseTransaction()).toBeUndefined()
    await inDatabaseReadTransaction(client, () => client.product.findMany())
    expect(root.$transaction).toHaveBeenCalledTimes(2)
  })

  it('allows only the statement that removes write capability', () => {
    expect(() => assertWorkspaceSql('$executeRaw', [['SET TRANSACTION READ ONLY']])).not.toThrow()
    for (const sql of ['SET TRANSACTION READ WRITE', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      'SET LOCAL ROLE admin', 'SET TRANSACTION READ ONLY; COMMIT', 'COMMIT', 'RESET ALL', "SELECT set_config('nexus.workspace_id', 'other', true)"]) {
      expect(() => assertWorkspaceSql('$executeRawUnsafe', [sql]), sql).toThrow('Application SQL must stay inside its business transaction')
    }
  })
})
