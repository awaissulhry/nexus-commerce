import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withWorkspace } from '../lib/workspace-context.js'

const m = vi.hoisted(() => ({ row: {} as any, counts: {} as Record<string, number | Error>, deleted: false, locked: false, tx: null as any }))
vi.mock('../db.js', () => ({ default: {
  $transaction: async (work: (tx: any) => unknown) => work(m.tx),
} }))
const { deleteDeadConnection } = await import('./connection-dependents.service.js')
const run = () => withWorkspace({ workspaceId: 'owner', actorUserId: null, membershipId: null, roleKeys: [] }, () => deleteDeadConnection('dead'))

beforeEach(() => {
  m.row = { id: 'dead', workspaceId: 'owner', isActive: false, isPrimary: false, authStatus: 'DISCONNECTED', accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null }
  m.counts = {}; m.deleted = false; m.locked = false
  m.tx = new Proxy({
    $queryRaw: async (_sql: unknown, id: string, workspaceId: string) => {
      m.locked = true
      return m.row?.id === id && m.row.workspaceId === workspaceId ? [{ id }] : []
    },
    channelConnection: {
      findUnique: async () => m.row,
      delete: async () => { m.deleted = true; return { id: 'dead' } },
    },
  }, { get: (target, prop: string) => prop in target ? (target as any)[prop] : {
    count: async () => {
      expect(m.locked).toBe(true)
      const n = m.counts[prop] ?? 0
      if (n instanceof Error) throw n
      return n
    },
  } })
})

describe('guarded dead-connection deletion', () => {
  it('positive control: deletes the named dead row after a complete fresh count', async () => {
    expect(await run()).toMatchObject({ deleted: true, connectionId: 'dead', dependents: { destroyedTotal: 0, incomplete: false } })
    expect(m.deleted).toBe(true)
  })
  it.each(['ebayCampaign', 'connectionScope', 'variantChannelListing'])('re-counts at delete time and refuses a newly attached %s', async model => {
    m.counts[model] = 1
    await expect(run()).rejects.toMatchObject({ code: 'connection_not_safe', statusCode: 409 })
    expect(m.deleted).toBe(false)
  })
  it('refuses an unreadable table even when the destructive count is zero', async () => {
    m.counts.ebayCampaign = new Error('unreadable')
    await expect(run()).rejects.toMatchObject({ code: 'connection_not_safe' })
    expect(m.deleted).toBe(false)
  })
  it.each(['isActive', 'isPrimary', 'accessToken', 'refreshToken', 'ebayAccessToken', 'ebayRefreshToken', 'credentialsEnc'])('refuses a row with %s despite zero dependents', async field => {
    m.row[field] = field.startsWith('is') ? true : 'present'
    await expect(run()).rejects.toMatchObject({ code: 'connection_in_use' })
    expect(m.deleted).toBe(false)
  })
  it.each(['connected', 'CONNECTED', 'degraded', 'DEGRADED'])('refuses %s auth status', async status => {
    m.row.authStatus = status
    await expect(run()).rejects.toMatchObject({ code: 'connection_in_use' })
    expect(m.deleted).toBe(false)
  })
  it.each([null, { id: 'dead', workspaceId: 'someone-else' }])('does not delete an absent or foreign-profile connection', async row => {
    m.row = row
    await expect(run()).rejects.toMatchObject({ code: 'connection_not_found', statusCode: 404 })
    expect(m.deleted).toBe(false)
  })
  it('reports surviving history whose link is cleared', async () => {
    m.counts.connectionEvent = 2079
    expect(await run()).toMatchObject({ dependents: { destroyedTotal: 0, unlinkedTotal: 2079 } })
    expect(m.deleted).toBe(true)
  })
})
