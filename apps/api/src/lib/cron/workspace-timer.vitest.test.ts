import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), claim: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { workspace: { findMany: mocks.findMany } } }))
vi.mock('../queue.js', () => ({ redis: { connection: { status: 'ready' } } }))
vi.mock('./workspace-lease.js', () => ({ runWorkspaceTick: mocks.claim }))
import { runProfileTimer } from './workspace-timer.js'
import { requireWorkspace, withWorkspace, workspaceContext } from '../workspace-context.js'
beforeEach(() => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  mocks.findMany.mockReset(); mocks.claim.mockReset()
  mocks.claim.mockImplementation(async (_store, _name, _at, work) => { await work(); return true })
})
afterEach(() => vi.unstubAllEnvs())

it('visits active businesses in bounded pages and isolates a failing business', async () => {
  mocks.findMany.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ id: `business-${i}` }))).mockResolvedValueOnce([{ id: 'business-last' }])
  const seen: string[] = []
  await runProfileTimer('inventory', async () => {
    seen.push(requireWorkspace().workspaceId)
    if (seen.length === 1) throw new Error('One provider is unavailable')
  }, 30_000)
  expect(seen).toHaveLength(51)
  expect(seen.at(-1)).toBe('business-last')
  expect(mocks.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { status: 'active' }, take: 50, cursor: { id: 'business-49' }, skip: 1 }))
  expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), 'timer:inventory:workspace:business-last', expect.any(Number), expect.any(Function), 30_000)
  expect(workspaceContext()).toBeUndefined()
})
it('keeps a timer invoked from a business inside that business', async () => {
  const seen: string[] = []
  await withWorkspace({ workspaceId: 'business-captured', actorUserId: null, membershipId: null, roleKeys: [] }, () => runProfileTimer('nested', async () => { seen.push(requireWorkspace().workspaceId) }))
  expect(seen).toEqual(['business-captured'])
  expect(mocks.findMany).not.toHaveBeenCalled()
  expect(mocks.claim).not.toHaveBeenCalled()
})
it('starts no work if leases cannot be acquired, and handles a database outage', async () => {
  const work = vi.fn(async () => {})
  mocks.findMany.mockResolvedValueOnce([{ id: 'business-a' }])
  mocks.claim.mockResolvedValue(false)
  await runProfileTimer('inventory', work)
  mocks.findMany.mockRejectedValueOnce(new Error('database unavailable'))
  await expect(runProfileTimer('inventory', work)).resolves.toBeUndefined()
  expect(work).not.toHaveBeenCalled()
})
