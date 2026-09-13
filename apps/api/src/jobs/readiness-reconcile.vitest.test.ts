import { expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ findMany: vi.fn(), reconcile: vi.fn(), schedule: vi.fn() }))
vi.mock('../db.js', () => ({ default: { product: { findMany: mock.findMany } } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: mock.schedule } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, work: () => Promise<unknown>) => work() }))
vi.mock('../services/pim/readiness-index.service.js', () => ({ reconcileFamilyReadiness: mock.reconcile }))
import { runReadinessReconcile } from './readiness-reconcile.job.js'
it('continues across family failures and reports the run as failed after trying the remaining families', async () => {
 mock.findMany.mockResolvedValueOnce([{ id: 'one' }, { id: 'two' }, { id: 'three' }])
 mock.reconcile.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('stale schema transaction')).mockResolvedValueOnce(5)
 await expect(runReadinessReconcile()).rejects.toThrow('2 families repaired; 1 failed')
 expect(mock.reconcile.mock.calls.map(call => call[0])).toEqual(['one','two','three'])
 expect(mock.schedule).not.toHaveBeenCalled()
})
it('walks root families in bounded cursor pages and repairs missing rows through the same producer', async () => {
 mock.findMany.mockReset(); mock.reconcile.mockReset().mockResolvedValue(2)
 mock.findMany.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: `family-${i}` }))).mockResolvedValueOnce([{ id: 'last' }])
 await expect(runReadinessReconcile()).resolves.toBe('Reconciled 101 families, 202 readiness rows.')
 expect(mock.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'family-99' }, skip: 1, take: 100, where: { parentId: null, deletedAt: null } })
 expect(mock.reconcile).toHaveBeenCalledTimes(101)
})
