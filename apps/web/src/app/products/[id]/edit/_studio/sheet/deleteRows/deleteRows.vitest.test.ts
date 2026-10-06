/**
 * Delete rows (Owner, 2026-10-06) — the one "Delete…" of every sheet view: what it asks, what it refuses, and the Undo.
 * The server's plan is faked here; `apps/api/src/services/pim/sheet-delete-rows.vitest.test.ts` proves the plan.
 */
import { describe, expect, it, vi } from 'vitest'

import { runAction } from '@/design-system/grid/actions/runAction'
import { isRunnable, type ActionImpact } from '@/design-system/grid/actions/registry'

import { deleteImpact, deleteRowsAction, deleteTargets, type DeleteRowsApi, type DeleteRowsDone, type DeleteRowsPlan } from './deleteRows'

interface Row { id: string; sku: string; aliasId: string | null }
const row = (id: string, aliasId: string | null = null): Row => ({ id, sku: id.toUpperCase(), aliasId })
const target = (r: Row) => ({ productId: r.id, aliasId: r.aliasId })

const plan = (over: Partial<DeleteRowsPlan> = {}): DeleteRowsPlan => ({ rootId: 'p', rootSku: 'P', products: [], aliases: [], familyDeleted: false, refusals: [], ...over })

function setup(answer: DeleteRowsPlan, ask = vi.fn(async (_impact: ActionImpact) => true)) {
  const api: DeleteRowsApi = {
    preview: vi.fn(async () => answer),
    run: vi.fn(async () => answer),
    restore: vi.fn(async () => ({ restored: { products: answer.products.length, aliases: answer.aliases.length } })),
  }
  const done: DeleteRowsDone[] = []
  const action = deleteRowsAction<Row>({ productId: 'p', target, can: () => true, authStatus: 'authed', api, onDeleted: (d) => done.push(d) })
  return { api, done, action, run: (rows: Row[]) => runAction(action, rows, ask), ask }
}

describe('Delete… on the selection bar', () => {
  it('needs ticked rows and the products.delete permission, and says which', () => {
    const { action } = setup(plan())
    expect(action.label).toBe('Delete…')
    expect(action.available([])).toEqual({ kind: 'disabled', reason: 'Tick the rows to delete' })
    expect(isRunnable(action.available([row('a')]))).toBe(true)
    const denied = deleteRowsAction<Row>({ productId: 'p', target, can: () => false, authStatus: 'authed', onDeleted: () => {} })
    expect(denied.available([row('a')])).toEqual({ kind: 'disabled', reason: 'Deleting needs the "products.delete" permission, which this account does not have' })
    const unknown = deleteRowsAction<Row>({ productId: 'p', target, can: () => false, authStatus: 'anon', onDeleted: () => {} })
    expect((unknown.available([row('a')]) as { reason: string }).reason).toContain('not signed in')
  })

  it('sends each ticked product and listing once', () => {
    expect(deleteTargets([row('a'), row('a'), row('a', 'x'), row('b')], target)).toEqual([
      { productId: 'a', aliasId: null }, { productId: 'a', aliasId: 'x' }, { productId: 'b', aliasId: null },
    ])
  })

  it('asks once, naming each product and extra listing, and runs exactly what it named', async () => {
    const answer = plan({ products: [{ id: 'a', sku: 'A' }], aliases: [{ id: 'x', label: 'test', channel: 'EBAY', marketplace: 'IT' }] })
    const { api, done, run, ask } = setup(answer)
    const outcome = await run([row('a'), row('p', 'x'), row('a', 'x')])
    expect(outcome.kind).toBe('ran')
    const impact = ask.mock.calls[0]![0] as ActionImpact
    expect(impact.title).toBe('Delete 1 product and 1 extra listing?')
    expect(impact.level).toBe('confirm')
    expect(impact.consequences).toEqual([
      'A: to the recycle bin, with its listings on every channel and market.',
      'test (eBay · IT): this extra listing is removed. Its products stay in the Main listing.',
    ])
    expect(impact.sideEffects).toContain('Nothing is sent to a channel.')
    expect(api.run).toHaveBeenCalledWith('p', [{ productId: 'a', aliasId: null }, { productId: 'p', aliasId: 'x' }, { productId: 'a', aliasId: 'x' }], { products: ['a'], aliases: ['x'] })
    expect(done[0]?.summary).toBe('Deleted 1 product and 1 extra listing.')
    expect(await done[0]!.undo()).toEqual({ ok: true, message: 'Put back 1 product and 1 extra listing.' })
    expect(api.restore).toHaveBeenCalledWith('p', { products: ['a'], aliases: ['x'] })
  })

  it('the whole family is typed: its SKU, never "DELETE"', () => {
    const impact = deleteImpact(plan({ familyDeleted: true, products: [{ id: 'p', sku: 'P' }, { id: 'a', sku: 'A' }] }), [{ productId: 'p', aliasId: null }])
    expect(impact).toMatchObject({ level: 'type-to-confirm', confirmPhrase: 'P', title: 'Delete the family P?' })
    expect(impact.consequences).toEqual(['P and its 1 variation: to the recycle bin, with every listing on every channel and market, extra listings included.'])
    expect(impact.sideEffects).toContain('This page closes and Products opens.')
  })

  it('deleting the variation this page is open on closes the page too', async () => {
    const answer = plan({ products: [{ id: 'a', sku: 'A' }] })
    expect(deleteImpact(answer, [], 'a').sideEffects).toContain('This page closes and Products opens.')
    expect(deleteImpact(answer, [], 'p').sideEffects).not.toContain('This page closes and Products opens.')
    const api: DeleteRowsApi = { preview: vi.fn(async () => answer), run: vi.fn(async () => answer), restore: vi.fn() }
    const done: DeleteRowsDone[] = []
    const action = deleteRowsAction<Row>({ productId: 'a', target, can: () => true, authStatus: 'authed', api, onDeleted: (d) => done.push(d) })
    await runAction(action, [row('a')], async () => true)
    expect(done[0]?.closesPage).toBe(true)
  })

  it('a refused row stays, and the confirm says why', () => {
    const impact = deleteImpact(plan({ products: [{ id: 'a', sku: 'A' }], refusals: [{ productId: 'c', aliasId: null, sku: 'C', reason: 'C is still on eBay · IT (Item ID 1). Set its Action to Delete and press Publish first, then delete the row.' }] }), [])
    expect(impact.findings).toEqual([{ rowId: 'c', label: 'C: C is still on eBay · IT (Item ID 1). Set its Action to Delete and press Publish first, then delete the row.', severity: 'error' }])
    expect(impact.sideEffects).toContain('1 row cannot be deleted and stays as it is (below).')
  })

  it('nothing deletable: refused in the server\'s words, never asked, never run', async () => {
    const { api, run, ask } = setup(plan({ refusals: [{ productId: 'c', aliasId: null, sku: 'C', reason: 'C is still on eBay · IT (Item ID 1).' }] }))
    const outcome = await run([row('c')])
    expect(outcome).toEqual({ kind: 'refused', problem: 'Nothing was deleted. C is still on eBay · IT (Item ID 1).' })
    expect(ask).not.toHaveBeenCalled()
    expect(api.run).not.toHaveBeenCalled()
  })

  it('a check that could not run is refused, never a gentler confirm', async () => {
    const { api, run, ask } = setup(plan())
    vi.mocked(api.preview).mockRejectedValueOnce(new Error('HTTP 500'))
    const outcome = await run([row('a')])
    expect(outcome).toEqual({ kind: 'refused', problem: 'Could not check what these rows hold: HTTP 500' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('cancelled: nothing is deleted', async () => {
    const { api, run } = setup(plan({ products: [{ id: 'a', sku: 'A' }] }), vi.fn(async (_impact: ActionImpact) => false))
    expect((await run([row('a')])).kind).toBe('cancelled')
    expect(api.run).not.toHaveBeenCalled()
  })
})
