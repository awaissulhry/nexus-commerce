/**
 * Meta step 18 review A4 (round 2) — the catalog rule: a catalog of the chosen ad account's business portfolio, never one
 * of a portfolio another Nexus business uses; a product set counts as its catalog; a lookup that FAILS (Meta refuses it,
 * the database errs) is a refusal in words, never a pass. Read client and the taken check are stand-ins; made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ answers: new Map<string, unknown>(), taken: new Set<string>(), takenFails: false, reads: [] as string[] }))
vi.mock('./read-client.js', async () => {
  const { MetaReadError, localFailure } = await import('./errors.js')
  const answer = (path: string) => {
    h.reads.push(path)
    const body = h.answers.get(path)
    if (body instanceof Error) throw new MetaReadError(localFailure(body.message, 'X'), 'r', 1)
    if (body === undefined) throw new MetaReadError(localFailure(`no answer for ${path}`, 'X'), 'r', 1)
    return body
  }
  return {
    metaReadOne: vi.fn(async (_t: unknown, req: { path: string }) => ({ body: answer(req.path), calls: 1 })),
    metaReadAll: vi.fn(async (_t: unknown, req: { path: string }, onRows: (rows: unknown[]) => void) => { onRows((answer(req.path) as { data: unknown[] }).data); return { rows: 0, calls: 1, truncated: false } }),
  }
})
vi.mock('./taken.js', () => ({
  takenIds: vi.fn(async (_p: string, ids: string[]) => { if (h.takenFails) throw new Error('connection to the database lost'); return new Set(ids.filter((id) => h.taken.has(id))) }),
}))

import { metaCatalogProblem } from './catalog-rule.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const PORTFOLIO = '120000000000090'
beforeEach(() => {
  h.answers = new Map<string, unknown>([
    ['act_1234567890', { business: { id: PORTFOLIO } }],
    [`${PORTFOLIO}/owned_product_catalogs`, { data: [{ id: '120000000000060' }] }],
    [`${PORTFOLIO}/client_product_catalogs`, { data: [{ id: '120000000000062' }] }],
    ['120000000000061', { id: '120000000000061', product_catalog: { id: '120000000000060' } }],
    ['120000000000067', { id: '120000000000067', product_catalog: { id: '120000000000068' } }],
  ])
  h.taken.clear(); h.takenFails = false; h.reads = []
})

describe('the catalog rule', () => {
  it('an owned or client catalog of the portfolio, or a product set of one, passes; nothing named needs no read', async () => {
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toBeNull()
    expect(await metaCatalogProblem(target, { catalogId: '120000000000062' })).toBeNull()
    expect(await metaCatalogProblem(target, { productSetId: '120000000000061' })).toBeNull()
    h.reads = []
    expect(await metaCatalogProblem(target, {})).toBeNull()
    expect(h.reads).toEqual([])
  })
  it('a forged catalog, a product set of a foreign catalog, a set of another catalog than named: refused in words', async () => {
    expect(await metaCatalogProblem(target, { catalogId: '120000000000069' })).toMatch(/not one the chosen ad account's business portfolio owns or was given/)
    expect(await metaCatalogProblem(target, { productSetId: '120000000000067' })).toMatch(/Catalog 120000000000068 is not one/)
    expect(await metaCatalogProblem(target, { catalogId: '120000000000062', productSetId: '120000000000061' })).toMatch(/not in catalog 120000000000062/)
  })
  it('a portfolio another Nexus business uses: refused before any catalog list is read', async () => {
    h.taken.add(PORTFOLIO)
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/Another business in Nexus/)
    expect(h.reads).toEqual(['act_1234567890'])
  })
  it('a lookup that FAILS never passes: Meta refuses a read, or the database errs', async () => {
    h.answers.set(`${PORTFOLIO}/owned_product_catalogs`, new Error('Meta refused it (200): Permissions error.'))
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/could not confirm the catalog \(Meta refused it \(200\)/)
    h.answers.delete('act_1234567890')
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/could not confirm the catalog/)
    h.answers.set('act_1234567890', { business: { id: PORTFOLIO } })
    h.takenFails = true
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/could not confirm the catalog \(connection to the database lost\)/)
    h.answers.set('act_1234567890', { id: 'act_1234567890' })
    h.takenFails = false
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/names no business portfolio/)
  })
})
