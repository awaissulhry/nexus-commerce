/**
 * Meta step 33 review F7 (and consent PR 2's "Upload customer lists to Meta") — the "Send sales to Meta" switch's history row is never reverted from Settings › History (a
 * revert needs only settings.workspace.edit; the switch needs settings.security.manage): the revert answers 400 in words
 * and writes nothing. The database and the audit writer are stand-ins.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ row: null as unknown, update: vi.fn(), audit: vi.fn() }))
vi.mock('../db.js', () => ({ default: { auditLog: { findUnique: vi.fn(async () => h.row) }, accountSettings: { findFirst: vi.fn(async () => ({ id: 'acc-1' })), update: h.update } } }))
vi.mock('../utils/settings-audit.js', () => ({ writeSettingsAudit: h.audit }))
vi.mock('../services/audit/audit-search.service.js', () => ({ listSettingsAudit: vi.fn(), settingsAuditKeyCounts: vi.fn() }))
vi.mock('../lib/auth/current-user.js', () => ({ currentProfileUser: vi.fn(async () => null) }))

import settingsAuditRoutes from './settings-audit.routes.js'

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(settingsAuditRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })

describe('settings history revert', () => {
  it('never reverts the "Send sales to Meta" switch', async () => {
    h.row = { id: 'audit-1', entityType: 'Settings', entityId: 'meta-conversions-api', action: 'update', before: { metaConversionsApi: true }, after: { metaConversionsApi: false }, userId: 'user-1' }
    const res = await app.inject({ method: 'POST', url: '/api/settings/audit/audit-1/revert' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/only in Settings › Channels › Meta.*the history never reverts it/)
    expect(h.update).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })
  it('never reverts the "Upload customer lists to Meta" switch (consent PR 2)', async () => {
    h.row = { id: 'audit-2', entityType: 'Settings', entityId: 'meta-customer-lists', action: 'update', before: { metaCustomerLists: false }, after: { metaCustomerLists: true }, userId: 'user-1' }
    const res = await app.inject({ method: 'POST', url: '/api/settings/audit/audit-2/revert' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/"Upload customer lists to Meta" switch is turned on or off only in Settings › Channels › Meta.*the history never reverts it/)
    expect(h.update).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })
})
