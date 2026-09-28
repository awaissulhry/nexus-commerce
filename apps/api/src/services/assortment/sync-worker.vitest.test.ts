/**
 * Shared stock step 7 — which connection the live-sync worker LISTENs on (build doc §7). A LISTEN made
 * through Neon's pooler never hears a notify, so the worker must reach the direct host the same way the
 * migration runner (packages/database/scripts/migrate-direct.mjs) does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { listenUrlFrom, syncOne, type SyncRun } from './sync-worker.js'

const db = vi.hoisted(() => ({
  assortmentChange: { update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./sync.service.js', () => ({ MEDIA_KEY: 'media', syncLink: vi.fn(async () => { throw new Error('the source could not be read') }) }))
vi.mock('../stock-pool/pool-notify.js', () => ({ notifyOwners: vi.fn() }))

const pooled = 'postgresql://owner:secret@ep-quiet-river-123-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require'
const direct = 'postgresql://owner:secret@ep-quiet-river-123.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require'

describe('AE.4 — the listener URL', () => {
  it('takes the pooler off DATABASE_URL, keeping the same credential, database and options', () => {
    expect(listenUrlFrom({ DATABASE_URL: pooled })).toBe(direct)
  })

  it('prefers DIRECT_URL when it is set', () => {
    const other = 'postgresql://owner:secret@127.0.0.1:5432/other'
    expect(listenUrlFrom({ DATABASE_URL: pooled, DIRECT_URL: other })).toBe(other)
  })

  it('passes a direct or local URL through unchanged, and has none without a database URL', () => {
    expect(listenUrlFrom({ DATABASE_URL: direct })).toBe(direct)
    expect(listenUrlFrom({ DATABASE_URL: 'postgresql://postgres@127.0.0.1:55611/ss_ui' })).toBe('postgresql://postgres@127.0.0.1:55611/ss_ui')
    expect(listenUrlFrom({})).toBeNull()
  })

  it('matches the migration runner: the same input gives the same host', async () => {
    const { migrationConnection } = await import('../../../../../packages/database/scripts/migration-connection.mjs')
    for (const url of [pooled, direct, pooled.replace('secret', 'secret-pooler'), 'postgresql://dev@local-pooler.internal/test']) {
      expect(listenUrlFrom({ DATABASE_URL: url })).toBe(migrationConnection({ DATABASE_URL: url }))
    }
  })
})

describe('AE.4 — a failed sync goes back to wait, once', () => {
  const run = (): SyncRun => ({ claimed: 0, synced: 0, unchanged: 0, detached: 0, skipped: 0, retried: 0, failed: 0 })
  beforeEach(() => { for (const fn of Object.values(db.assortmentChange)) fn.mockReset() })

  it('puts the first note back to wait and closes the others', async () => {
    const counted = run()
    await syncOne('link-1', [{ id: 'c1', linkId: 'link-1', attempts: 1 }, { id: 'c2', linkId: 'link-1', attempts: 1 }], counted)
    expect(counted.retried).toBe(1)
    expect(db.assortmentChange.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['c2'] } }, data: expect.objectContaining({ state: 'done' }) }))
    expect(db.assortmentChange.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' }, data: expect.objectContaining({ state: 'pending' }) }))
  })

  it('a newer note for the link, arriving before the put-back, closes this one instead of leaving the batch claimed', async () => {
    // What the unique index says when a pending note for this link already exists (it arrived after any check).
    db.assortmentChange.count.mockResolvedValue(0)
    db.assortmentChange.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`linkId`)', { code: 'P2002', clientVersion: 'test' }))
    const counted = run()
    await expect(syncOne('link-1', [{ id: 'c1', linkId: 'link-1', attempts: 2 }], counted)).resolves.toBeUndefined()
    expect(counted.retried).toBe(1)
    expect(db.assortmentChange.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' }, data: expect.objectContaining({ state: 'done', lastError: 'the source could not be read' }) }))
  })

  it('any other failure of the put-back is not swallowed', async () => {
    db.assortmentChange.update.mockRejectedValue(new Error('connection lost'))
    await expect(syncOne('link-1', [{ id: 'c1', linkId: 'link-1', attempts: 2 }], run())).rejects.toThrow('connection lost')
  })
})
