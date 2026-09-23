import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { FEATURES } from '@nexus/shared/permissions'
const m = vi.hoisted(() => ({ remove: vi.fn() }))
vi.mock('../services/connection-dependents.service.js', () => ({
  connectionDependentsReport: vi.fn(), dependentRelations: () => [], deleteDeadConnection: m.remove,
}))
import routes from './connection-dependents.routes.js'
const app = Fastify()
await app.register(routes, { prefix: '/api' })
afterEach(() => vi.resetAllMocks())
it('requires the destructive admin permission', () => {
  expect(permissionForRoute('DELETE', '/api/admin/connection-dependents/:id')).toBe(FEATURES.adminPurge)
  expect(permissionForRoute('GET', '/api/admin/connection-dependents')).toBe(FEATURES.adminView)
})
it('returns a completed deletion', async () => {
  m.remove.mockResolvedValue({ deleted: true, connectionId: 'dead' })
  const r = await app.inject({ method: 'DELETE', url: '/api/admin/connection-dependents/dead' })
  expect(r.statusCode).toBe(200)
  expect(r.json()).toMatchObject({ deleted: true, connectionId: 'dead' })
  expect(m.remove).toHaveBeenCalledWith('dead')
})
it.each([['connection_not_safe', 409], ['connection_not_found', 404]])('reports %s without claiming a deletion', async (code, statusCode) => {
  m.remove.mockRejectedValue(Object.assign(new Error('Refused'), { code, statusCode }))
  const r = await app.inject({ method: 'DELETE', url: '/api/admin/connection-dependents/dead' })
  expect(r.statusCode).toBe(statusCode)
  expect(r.json()).toMatchObject({ deleted: false, code })
})
it('fails closed on a database error', async () => {
  m.remove.mockRejectedValue(new Error('database offline'))
  const r = await app.inject({ method: 'DELETE', url: '/api/admin/connection-dependents/dead' })
  expect(r.statusCode).toBe(500)
  expect(r.json()).toMatchObject({ deleted: false })
})
