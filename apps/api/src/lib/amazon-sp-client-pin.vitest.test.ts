/** CX A0 — an explicit account pins the lazy client from its FIRST call, not after the resolver chose. */
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ resolve: vi.fn(), list: vi.fn() }))
vi.mock('../services/connection-resolver.service.js', () => ({
  resolveConnection: m.resolve, listActiveConnections: m.list, chooseConnection: vi.fn(),
}))
const { amazonSpClient } = await import('./amazon-sp-client.js')
const { withWorkspace } = await import('./workspace-context.js')
// Production reads Amazon inside a business (profiles ON refuses otherwise); the pin is the same there.
const inBusiness = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeEach(() => {
  vi.clearAllMocks()
  m.resolve.mockRejectedValue(new Error('stop after resolution'))
  m.list.mockRejectedValue(new Error('stop after resolution'))
})

it('resolves the named account on the first call', async () => {
  await expect(inBusiness(() => (amazonSpClient('acct-A') as any).callAPI({ operation: 'getOrders' }))).rejects.toThrow('stop after resolution')
  expect(m.resolve).toHaveBeenCalledWith({ accountId: 'acct-A' })
  expect(m.list).not.toHaveBeenCalled()
})

it('without an account, the resolver default is unchanged', async () => {
  await expect(inBusiness(() => (amazonSpClient() as any).callAPI({ operation: 'getOrders' }))).rejects.toThrow('stop after resolution')
  expect(m.list).toHaveBeenCalledWith('AMAZON')
  expect(m.resolve).not.toHaveBeenCalled()
})
