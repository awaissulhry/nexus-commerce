import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ policies: {} as Record<string, number>, archive: vi.fn(), deleteWebhook: vi.fn(), deleteAudit: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  dataRetentionPolicy: { findFirst: async () => ({ policies: state.policies }) },
  webhookEvent: { deleteMany: state.deleteWebhook }, auditLog: { deleteMany: state.deleteAudit },
} }))
vi.mock('../services/cx/ingress/archive.js', () => ({ archiveCompletedInbound: state.archive }))
vi.mock('../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const { runRetentionSweepOnce } = await import('./data-retention-sweep.job.js')
beforeEach(() => {
  vi.clearAllMocks(); state.policies = { webhookEvents: 90, auditLog: 730 }
  state.archive.mockResolvedValue({ archived: 3, limitReached: false })
  state.deleteWebhook.mockResolvedValue({ count: 9 }); state.deleteAudit.mockResolvedValue({ count: 2 })
})
it('archives webhook history and reports archive counts separately from deletion', async () => {
  const result = await runRetentionSweepOnce()
  expect(state.deleteWebhook).not.toHaveBeenCalled()
  expect(state.archive).toHaveBeenCalledExactlyOnceWith(90)
  expect(result).toMatchObject({ totalDeleted: 2, totalArchived: 3, archivedByKey: { webhookEvents: 3 }, deletedByKey: { auditLog: 2 } })
  expect(result.deletedByKey).not.toHaveProperty('webhookEvents')
})
it('never falls back to deletion if archiving fails', async () => {
  state.archive.mockRejectedValueOnce(new Error('synthetic failure'))
  expect(await runRetentionSweepOnce()).toMatchObject({ totalArchived: 0, totalDeleted: 2 })
  expect(state.deleteWebhook).not.toHaveBeenCalled()
})
it('reports a bounded batch without claiming the entire archive backlog is finished', async () => {
  state.archive.mockResolvedValueOnce({ archived: 500, limitReached: true })
  expect(await runRetentionSweepOnce()).toMatchObject({ totalArchived: 500, archiveLimitReached: true })
})
