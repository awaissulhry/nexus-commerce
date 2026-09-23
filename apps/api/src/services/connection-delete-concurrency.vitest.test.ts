/** Real PostgreSQL: a FK writer and a delete must never race into silent data loss. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => (database.client as any)[p] }) }))
const { deleteDeadConnection } = await import('./connection-dependents.service.js')
const WS = 'nexus_legacy_workspace'
const remove = (id: string) => withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, () => deleteDeadConnection(id))

describe.skipIf(!concurrentDatabaseUrl())('connection delete with real FK locks and RLS', () => {
  beforeAll(async () => { database = await concurrentDatabase({ maxConnections: 6 }) }, 180_000)
  afterAll(async () => { await database?.close() }, 60_000)
  async function seed() {
    const id = randomUUID()
    await database.pool.query(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","updatedAt") VALUES ($1,$2,'EBAY',now())`, [id, WS])
    return id
  }
  const exists = async (id: string) => (await database.pool.query('SELECT id FROM "ChannelConnection" WHERE id=$1', [id])).rowCount
  it('positive control: deletes a dead row through the real scoped client', async () => {
    const id = await seed()
    expect(await exists(id)).toBe(1)
    await expect(remove(id)).resolves.toMatchObject({ deleted: true })
    expect(await exists(id)).toBe(0)
  })
  it('waits for an in-flight child, then re-counts and refuses instead of cascading it', async () => {
    const id = await seed()
    const writer = await database.pool.connect()
    let deleting: Promise<unknown> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query(`INSERT INTO "ConnectionScope" (id,"workspaceId","connectionId",kind,"externalId","updatedAt") VALUES ($1,$2,$3,'test','test',now())`, [randomUUID(), WS, id])
      // This FK insert has a KEY SHARE lock. Deletion must be waiting for UPDATE before counting.
      deleting = remove(id)
      void deleting.catch(() => undefined)
      await vi.waitFor(async () => {
        const waiting = await database.pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ChannelConnection%' AND query LIKE '%FOR UPDATE%'`)
        expect(waiting.rowCount).toBe(1)
      }, { timeout: 3000, interval: 20 })
      await writer.query('COMMIT')
      await expect(deleting).rejects.toMatchObject({ code: 'connection_not_safe' })
      expect(await exists(id)).toBe(1)
      expect((await database.pool.query('SELECT id FROM "ConnectionScope" WHERE "connectionId"=$1', [id])).rowCount).toBe(1)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      await deleting?.catch(() => undefined)
    }
  })
})
