import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ job: null as any }))
vi.mock('../../db.js', () => ({ default: { bulkOperation: {
  create: vi.fn(async ({ data }) => { state.job = { id: 'job', ...structuredClone(data) }; return { id: 'job' } }),
  findUnique: vi.fn(async () => structuredClone(state.job)),
  updateMany: vi.fn(async ({ where, data }) => {
    if (state.job.status !== where.status) return { count: 0 }
    Object.assign(state.job, structuredClone(data)); return { count: 1 }
  }),
  update: vi.fn(async ({ data }) => { Object.assign(state.job, structuredClone(data)); return state.job }),
} } }))

import { applyStoredJob, readJob, revertStoredJob, storePreview, type StoredCell } from './import-jobs.service.js'
import type { DiffCell } from './import-diff.service.js'

const cell = (id: string): DiffCell => ({ rowId: id, aliasKey: '', aliasResolved: true, fieldKey: 'color', writeField: 'attr_color',
  scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', locale: 'it' }, verdict: 'changed', pins: true,
  before: 'Nero', after: 'Blu', restoreIntent: 'reset' })
beforeEach(() => { state.job = null })
async function preview(cells = [cell('child')]) {
  return storePreview({ cells, counts: { changed: cells.length, unchanged: 0, refused: 0, wouldPin: cells.length },
    productId: 'parent', blankPolicy: 'ignore', scope: cells[0].scope, market: 'IT' })
}

it('persists the inherited restore intent and returns successful outcomes when polled', async () => {
  await preview()
  const applied = await applyStoredJob({ jobId: 'job', currentOf: async () => 'Nero', writeCells: async () => ({ applied: 1, errors: [] }) })
  const loaded = await readJob('job')
  expect(loaded?.outcomes).toEqual(applied.outcomes)
  expect(loaded?.cells[0].restoreIntent).toBe('reset')
  const writeCells = vi.fn(async (_cells: StoredCell[]) => ({ applied: 1, errors: [] }))
  await revertStoredJob({ jobId: 'job', currentOf: async () => 'Blu', writeCells })
  expect(writeCells.mock.calls[0][0][0]).toMatchObject({ after: 'Nero', restoreIntent: 'reset' })
  expect((await readJob('job'))?.phase).toBe('revert')
})

it('never reverts a cell the import refused, even if someone later gave it the proposed value', async () => {
  await preview([cell('written'), cell('refused')])
  await applyStoredJob({ jobId: 'job', currentOf: async () => 'Nero', writeCells: async () => ({ applied: 1,
    errors: [{ productId: 'refused', fieldKey: 'color', error: 'Concurrent edit' }] }) })
  const writeCells = vi.fn(async (_cells: StoredCell[]) => ({ applied: 1, errors: [] }))
  await revertStoredJob({ jobId: 'job', currentOf: async () => 'Blu', writeCells })
  expect(writeCells.mock.calls[0][0].map(row => row.productId)).toEqual(['written'])
})

it('refuses changed cells and a second apply without calling the writer', async () => {
  await preview()
  const writeCells = vi.fn(async () => ({ applied: 0, errors: [] }))
  const result = await applyStoredJob({ jobId: 'job', currentOf: async () => 'Rosso', writeCells })
  expect(result.state).toBe('PARTIAL')
  expect(writeCells).not.toHaveBeenCalled()
  await expect(applyStoredJob({ jobId: 'job', currentOf: async () => 'Nero', writeCells })).rejects.toThrow('applies once')
})
