import { beforeEach, describe, expect, it, vi } from 'vitest'
const preview = vi.hoisted(() => vi.fn())
const database = vi.hoisted(() => ({ bulkOperation: { create: vi.fn() } }))
vi.mock('../../../db.js', () => ({ default: database }))
vi.mock('./cell-formula.service.js', () => ({ previewCellFormula: (...args: unknown[]) => preview(...args), readFormulaCell: vi.fn(), setCellFormula: vi.fn(), setCellLiteral: vi.fn(), restoreFormulaSnapshot: vi.fn() }))
import { previewFormulaBatch } from './formula-bulk.service.js'
beforeEach(() => { vi.clearAllMocks() })
describe('bounded bulk preview', () => {
  it('preserves row order, isolates a refused row, and writes nothing', async () => {
    preview.mockImplementation(async ({ productId }: any) => { if (productId === 'bad') throw new Error('Invalid field'); return { ok: true, value: productId } })
    const result = await previewFormulaBatch({ scope: 'master', fieldKey: 'brand', market: 'IT', expr: 'upper($brand)', mode: 'once', rows: ['one', 'bad', 'two'].map(productId => ({ productId })) })
    expect(result.rows).toEqual([{ productId: 'one', ok: true, value: 'one' }, { productId: 'bad', ok: false, error: 'Invalid field' }, { productId: 'two', ok: true, value: 'two' }])
    expect(database.bulkOperation.create).not.toHaveBeenCalled()
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ allowSelfReference: true }))
  })
  it('checks at most four products concurrently and disallows linked self-references', async () => {
    let active = 0; let peak = 0
    preview.mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return { ok: true } })
    await previewFormulaBatch({ scope: 'master', fieldKey: 'brand', expr: '$manufacturer', mode: 'linked', rows: Array.from({ length: 50 }, (_, i) => ({ productId: String(i) })) })
    expect(peak).toBe(4); expect(preview).toHaveBeenCalledTimes(50)
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ allowSelfReference: false }))
  })
})
