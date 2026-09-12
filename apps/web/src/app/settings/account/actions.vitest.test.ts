import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ access: vi.fn(), find: vi.fn(), update: vi.fn(), audit: vi.fn(), final: vi.fn() }))
vi.mock('@/lib/workspaces/server', () => ({ requireWebPermission: mocks.access, currentWebUser: async () => ({ id: 'actor' }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@nexus/database', () => ({ prisma: { $transaction: (work: (tx: unknown) => unknown) => work({ accountSettings: { findFirst: mocks.find, updateMany: mocks.update, findFirstOrThrow: mocks.final }, auditLog: { create: mocks.audit } }) } }))
import { saveAccountSettings } from './actions'
const stamp = '2026-09-08T10:00:00.000Z'
const form = () => {
  const data = new FormData()
  for (const [key, value] of Object.entries({ businessName: 'Second business', country: 'GB', currency: 'GBP', timezone: 'Europe/London', city: 'London', updatedAt: stamp })) data.set(key, value)
  return data
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.find.mockResolvedValue({ id: 'settings-b', updatedAt: new Date(stamp), businessName: 'Second business' })
  mocks.update.mockResolvedValue({ count: 1 })
  mocks.final.mockResolvedValue({ updatedAt: new Date('2026-09-08T10:01:00.000Z') })
})
it('saves through the workspace permission gate with a compare-and-set and transactional audit', async () => {
  expect(await saveAccountSettings(form())).toMatchObject({ success: true, updatedAt: '2026-09-08T10:01:00.000Z' })
  expect(mocks.access).toHaveBeenCalledWith('settings.workspace.edit')
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'settings-b', updatedAt: new Date(stamp) }, data: expect.objectContaining({ city: 'London', currency: 'GBP' }) }))
  expect(mocks.audit).toHaveBeenCalledTimes(1)
})
it('rejects an old tab before writing any settings', async () => {
  const data = form(); data.set('updatedAt', '2026-09-07T10:00:00.000Z')
  await expect(saveAccountSettings(data)).rejects.toThrow('another tab')
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled()
})
it('rejects a race after the initial read without recording a successful audit', async () => {
  mocks.update.mockResolvedValue({ count: 0 })
  await expect(saveAccountSettings(form())).rejects.toThrow('another tab')
  expect(mocks.audit).not.toHaveBeenCalled()
})
it('rejects invalid business defaults before opening a write', async () => {
  const data = form(); data.set('timezone', 'Made-up/Zone')
  await expect(saveAccountSettings(data)).rejects.toThrow('timezone')
  expect(mocks.find).not.toHaveBeenCalled()
})
