import { beforeEach, expect, it, vi } from 'vitest'
import { withWorkspace } from '@nexus/database/workspace-context'
const state = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), lock: vi.fn(), transaction: vi.fn(), fetch: vi.fn() }))
vi.hoisted(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No channel request in limiter test') })) })
vi.mock('../../db.js', () => ({ default: { $transaction: state.transaction } }))
import { parseVerifyRequest, reservePresenceReadBudget, withAmazonPresenceReadLock } from './verify-budget.service.js'
const coordinate = { productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' }
const context = { workspaceId: 'workspace', actorUserId: 'session-user', membershipId: 'member', roleKeys: [] }
const now = new Date('2026-09-13T12:00:00.000Z')
const scoped = <T>(read: () => T) => withWorkspace(context, read)
beforeEach(() => {
  vi.clearAllMocks()
  state.read.mockResolvedValue([])
  state.write.mockResolvedValue({})
  state.lock.mockResolvedValue(1)
  state.transaction.mockImplementation(async work => work({ $executeRaw: state.lock, rateLimitLog: { findMany: state.read, upsert: state.write } }))
})
it.each(['productId', 'channel', 'marketplace', 'channelConnectionId', 'aliasKey'])('names missing %s before a read or reservation', key => {
  const incomplete = { ...coordinate } as Record<string, unknown>
  delete incomplete[key]
  expect(() => parseVerifyRequest({ coordinates: [incomplete], reason: 'operator' })).toThrow(key)
  expect(parseVerifyRequest({ coordinates: [coordinate], reason: 'operator' }).coordinates).toEqual([coordinate])
  expect(state.transaction).not.toHaveBeenCalled()
})
it('rejects duplicates, no reason and call overflow with a ten-coordinate positive control', () => {
  expect(() => parseVerifyRequest({ coordinates: [coordinate, coordinate], reason: 'operator' })).toThrow('Duplicate')
  expect(() => parseVerifyRequest({ coordinates: [coordinate] })).toThrow('reason')
  expect(() => parseVerifyRequest({ coordinates: Array(11).fill(coordinate), reason: 'operator' })).toThrow('10')
  expect(parseVerifyRequest({ coordinates: Array.from({ length: 10 }, (_, i) => ({ ...coordinate, productId: `p-${i}` })), reason: 'operator' }).coordinates).toHaveLength(10)
})
it('reserves the last available slot under the verified workspace lock', async () => {
  state.read.mockResolvedValue([{ requestCount: 59, resetAt: new Date('2026-09-13T12:10:00Z') }])
  expect(await scoped(() => reservePresenceReadBudget(1, now))).toEqual({ remaining: 0, resetAt: '2026-09-13T13:00:00.000Z' })
  expect(state.lock.mock.calls[0][1]).toBe('presence-verify-budget:workspace')
  expect(state.read).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'workspace', channel: 'PRESENCE_READ', endpoint: 'presence/verify', resetAt: { gt: now } } }))
  expect(state.write).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ workspaceId: 'workspace', requestCount: 1 }), update: { requestCount: { increment: 1 } } }))
  expect(state.lock.mock.invocationCallOrder[0]).toBeLessThan(state.read.mock.invocationCallOrder[0])
  expect(state.read.mock.invocationCallOrder[0]).toBeLessThan(state.write.mock.invocationCallOrder[0])
})
it('returns the first time sufficient capacity expires without reserving or calling the channel', async () => {
  state.read.mockResolvedValue([{ requestCount: 1, resetAt: new Date('2026-09-13T12:10:00Z') }, { requestCount: 59, resetAt: new Date('2026-09-13T12:20:00Z') }])
  await expect(scoped(() => reservePresenceReadBudget(2, now))).rejects.toMatchObject({ statusCode: 429, retryAt: '2026-09-13T12:20:00.000Z', retryAfter: 1200 })
  expect(state.write).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
it('refuses a missing workspace, failed lock or failed durable counter', async () => {
  await expect(reservePresenceReadBudget(1, now)).rejects.toMatchObject({ code: 'workspace_required' })
  expect(state.transaction).not.toHaveBeenCalled()
  state.lock.mockRejectedValueOnce(new Error('lock unavailable'))
  await expect(scoped(() => reservePresenceReadBudget(1, now))).rejects.toThrow('lock unavailable')
  expect(state.read).not.toHaveBeenCalled()
  state.read.mockRejectedValueOnce(new Error('counter unavailable'))
  await expect(scoped(() => reservePresenceReadBudget(1, now))).rejects.toThrow('counter unavailable')
  expect(state.write).not.toHaveBeenCalled()
})
it('uses durable data after a module reload and a distinct key for another workspace', async () => {
  state.read.mockResolvedValue([{ requestCount: 60, resetAt: new Date('2026-09-13T12:30:00Z') }])
  vi.resetModules()
  const reloaded = await import('./verify-budget.service.js')
  // Import shares the already-installed workspace module; reload only proves no module-local budget.
  const workspace = await import('@nexus/database/workspace-context')
  await expect(workspace.withWorkspace({ ...context, workspaceId: 'other' }, () => reloaded.reservePresenceReadBudget(1, now))).rejects.toMatchObject({ statusCode: 429 })
  expect(state.lock.mock.calls[0][1]).toBe('presence-verify-budget:other')
})
it('keeps the Amazon read inside the account-specific lock and returns its result', async () => {
  const trace: string[] = []
  state.lock.mockImplementation(async () => { trace.push('lock') })
  state.transaction.mockImplementation(async work => { trace.push('begin'); const result = await work({ $executeRaw: state.lock }); trace.push('commit'); return result })
  expect(await scoped(() => withAmazonPresenceReadLock('amazon-account', async () => { trace.push('read'); return 'answer' }))).toBe('answer')
  expect(trace).toEqual(['begin', 'lock', 'lock', 'read', 'commit'])
  expect(state.lock.mock.calls[1][1]).toBe('presence-amazon-read:workspace:amazon-account')
  state.lock.mockRejectedValueOnce(new Error('account busy'))
  const channelRead = vi.fn()
  await expect(scoped(() => withAmazonPresenceReadLock('amazon-account', channelRead))).rejects.toThrow('account busy')
  expect(channelRead).not.toHaveBeenCalled()
})
