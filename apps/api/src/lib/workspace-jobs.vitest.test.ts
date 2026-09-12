import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ workspace: { findUnique: vi.fn() }, apiKey: { findUnique: vi.fn() } }))
const membership = vi.hoisted(() => vi.fn())
vi.mock('../db.js', () => ({ default: db }))
vi.mock('../services/workspace.service.js', () => ({ createWorkspaceService: () => ({ membership }) }))
import { runWorkspaceJob, scopeJobData } from './workspace-jobs.js'
import { requireWorkspace, withWorkspace } from './workspace-context.js'

const scope = { workspaceId: 'workspace_jobs_a', actorUserId: 'user-a', membershipId: 'member-a', membershipVersion: 3, roleKeys: ['OPERATOR'] }
beforeEach(() => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  db.workspace.findUnique.mockResolvedValue({ status: 'active', automationResumedAt: null })
  db.apiKey.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: null })
  membership.mockResolvedValue({ id: scope.membershipId, version: 3, roleKeys: scope.roleKeys, context: scope })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
const job = (context = scope, timestamp = Date.now()) => ({ data: withWorkspace(context, () => scopeJobData({ productId: 'product-a' })), timestamp })

describe('queued business authority', () => {
  it('captures the initiating profile and strips the login session from durable work', async () => {
    const queued = job({ ...scope, sessionId: 'private-session' } as typeof scope)
    expect(queued.data).not.toHaveProperty('__nexusWorkspace.sessionId')
    const result = await withWorkspace({ ...scope, workspaceId: 'workspace_jobs_b' }, () => runWorkspaceJob(queued, async () => requireWorkspace().workspaceId))
    expect(result).toBe(scope.workspaceId)
  })
  it('refuses to enqueue business work without a profile', () => {
    expect(() => scopeJobData({})).toThrow('Select a business profile')
  })
  it('rechecks revoked membership before executing', async () => {
    membership.mockRejectedValue(Object.assign(new Error('Unavailable'), { code: 'workspace_unavailable' }))
    const work = vi.fn()
    await expect(runWorkspaceJob(job(), work)).rejects.toThrow('membership that queued')
    expect(work).not.toHaveBeenCalled()
  })
  it('refuses a role change even if the member still has access', async () => {
    membership.mockResolvedValue({ id: scope.membershipId, version: 4, roleKeys: ['VIEWER'], context: scope })
    await expect(runWorkspaceJob(job(), async () => true)).rejects.toThrow('membership that queued')
  })
  it('blocks archived profiles and jobs queued before restoration', async () => {
    const queued = job(scope, 100)
    db.workspace.findUnique.mockResolvedValue({ status: 'archived' })
    await expect(runWorkspaceJob(queued, async () => true)).rejects.toThrow('unavailable')
    db.workspace.findUnique.mockResolvedValue({ status: 'active', automationResumedAt: new Date(200) })
    await expect(runWorkspaceJob(queued, async () => true)).rejects.toThrow('predates')
    await expect(runWorkspaceJob(job(scope, 300), async () => true)).resolves.toBe(true)
  })
  it('blocks revoked and expired API keys', async () => {
    const machine = { ...scope, actorUserId: null, membershipId: null, apiKeyId: 'key-a', roleKeys: [] }
    const queued = { timestamp: Date.now(), data: withWorkspace(machine, () => scopeJobData({})) }
    for (const key of [null, { revokedAt: new Date() }, { expiresAt: new Date(1) }]) {
      db.apiKey.findUnique.mockResolvedValue(key)
      await expect(runWorkspaceJob(queued, async () => true)).rejects.toThrow('API key')
    }
  })
  it('preserves transient provider errors for the queue retry policy', async () => {
    const provider = new Error('Temporary provider failure')
    await expect(runWorkspaceJob(job(), async () => { throw provider })).rejects.toBe(provider)
  })
  it('rejects unscoped jobs created after migration', async () => {
    db.workspace.findUnique.mockResolvedValue({ status: 'active', createdAt: new Date(100) })
    await expect(runWorkspaceJob({ data: {}, timestamp: 200 }, async () => true)).rejects.toThrow('no business profile')
  })
})
