import { afterEach, expect, it, vi } from 'vitest'
import { formulaOperationRequest, mergeFormulaOperation } from './formulaOperations'
afterEach(() => vi.unstubAllGlobals())
it('does not label an empty undo/continue request as a JSON document', async () => {
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => ({ status: 'UNDONE' }) }))
  vi.stubGlobal('fetch', fetch)
  await formulaOperationRequest('operation/undo')
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' })
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('headers')
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body')
})
it('encodes apply requests as JSON and uses the collection URL for history', async () => {
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetch)
  await formulaOperationRequest('apply', { operationId: 'retained-id' })
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { 'content-type': 'application/json' }, body: '{"operationId":"retained-id"}' })
  await formulaOperationRequest('?familyProductId=one&scope=master', undefined, 'GET')
  expect(fetch.mock.calls[1][0]).toContain('/bulk?familyProductId=one')
})
it('merges resumed progress without losing products from earlier responses', () => {
  const initial = { operationId: 'one', status: 'APPLYING', processed: 1, total: 2, rows: [{ productId: 'first', status: 'applied' as const, ok: true }] }
  const next = mergeFormulaOperation(initial, { ...initial, status: 'SUCCESS', processed: 2, rows: [{ productId: 'second', status: 'applied', ok: true }] })
  expect(next.rows.map(row => row.productId)).toEqual(['first', 'second'])
  expect(next.status).toBe('SUCCESS')
})
