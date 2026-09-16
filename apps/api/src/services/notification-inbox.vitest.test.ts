/**
 * The bell's list: every unread row first, read rows only fill the room left.
 *
 * The defect this pins (2026-09-16): the list returned the newest rows only, so an
 * older unread `danger` alarm was counted in the badge and never sent to the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = { id: string; readAt: Date | null }
const unreadRows: Row[] = []
const readRows: Row[] = []
const findMany = vi.fn(async (args: { where: { readAt: unknown }; take: number }) =>
  (args.where.readAt === null ? unreadRows : readRows).slice(0, args.take))
const count = vi.fn(async (_args?: unknown) => unreadRows.length)

vi.mock('../db.js', () => ({
  default: { notification: { get findMany() { return findMany }, get count() { return count } } },
}))

const { listInbox } = await import('./notification-inbox.service.js')

const unread = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, readAt: null }))
const read = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, readAt: new Date() }))

beforeEach(() => {
  findMany.mockClear(); count.mockClear()
  unreadRows.length = 0; readRows.length = 0
})

describe('listInbox', () => {
  it('🔴 an unread row is returned even when 30 newer read rows exist', async () => {
    unreadRows.push(...unread(1)); readRows.push(...read(30))
    const r = await listInbox('user-1', { unreadOnly: false, limit: 30 })
    expect(r.rows[0].id).toBe('u0')
    expect(r.rows).toHaveLength(30)
    expect(r.unreadCount).toBe(1)
  })

  it('read rows only fill the room the unread rows leave', async () => {
    unreadRows.push(...unread(3)); readRows.push(...read(10))
    const r = await listInbox('user-1', { unreadOnly: false, limit: 5 })
    expect(r.rows.map(x => x.id)).toEqual(['u0', 'u1', 'u2', 'r0', 'r1'])
    expect((findMany.mock.calls[1]?.[0] as { take: number }).take).toBe(2)
  })

  it('no room left: read rows are not even asked for', async () => {
    unreadRows.push(...unread(8)); readRows.push(...read(10))
    const r = await listInbox('user-1', { unreadOnly: false, limit: 5 })
    expect(r.rows.every(x => x.readAt === null)).toBe(true)
    expect(r.unreadCount).toBe(8)
    expect(findMany).toHaveBeenCalledTimes(1)
  })

  it('unreadOnly never returns a read row', async () => {
    unreadRows.push(...unread(1)); readRows.push(...read(10))
    const r = await listInbox('user-1', { unreadOnly: true, limit: 30 })
    expect(r.rows.map(x => x.id)).toEqual(['u0'])
    expect(findMany).toHaveBeenCalledTimes(1)
  })

  it('every query is scoped to the one person asking', async () => {
    unreadRows.push(...unread(1)); readRows.push(...read(1))
    await listInbox('user-1', { unreadOnly: false, limit: 30 })
    for (const [args] of findMany.mock.calls) expect((args as { where: { userId: string } }).where.userId).toBe('user-1')
    expect((count.mock.calls[0]?.[0] as { where: { userId: string } }).where.userId).toBe('user-1')
  })
})
