/**
 * Meta step 18 review A4 (round 2) + owner fix — the catalog rule for a CHANGE is step 12's read rule: a catalog the chosen
 * ad account's business portfolio owns, or one of its client catalogs whose owner Meta names and is no portfolio another
 * Nexus business uses; never one of a portfolio another Nexus business uses; a product set counts as its catalog; a
 * lookup that FAILS (Meta refuses it, the database errs) is a refusal in words, never a pass. Read client and the taken
 * check are stand-ins; made-up ids.
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
vi.mock('./taken.js', () => {
  const takenIds = vi.fn(async (_p: string, ids: string[]) => { if (h.takenFails) throw new Error('connection to the database lost'); return new Set(ids.filter((id) => h.taken.has(id))) })
  return {
    takenIds,
    portfolioTaken: vi.fn(async (id: string) => ((await takenIds('PORTFOLIO', [id])).has(id) ? { portfolioId: id, takenByAnotherBusiness: true, sentence: 'taken' } : null)),
  }
})

import { metaCatalogProblem } from './catalog-rule.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const PORTFOLIO = '120000000000090'
const PARTNER = '120000000000080' // a portfolio outside Nexus that shared a catalog in
const OTHER_NEXUS = '120000000000081' // a portfolio another business in Nexus uses
const STRANGER = '120000000000099'
beforeEach(() => {
  h.answers = new Map<string, unknown>([
    ['act_1234567890', { business: { id: PORTFOLIO } }],
    ['120000000000060', { id: '120000000000060', business: { id: PORTFOLIO } }], // owned
    ['120000000000062', { id: '120000000000062', business: { id: PARTNER } }], // client, owner outside Nexus
    ['120000000000063', { id: '120000000000063', business: { id: OTHER_NEXUS } }], // client, owner = another Nexus business
    ['120000000000064', { id: '120000000000064' }], // client, Meta names no owner
    ['120000000000069', { id: '120000000000069', business: { id: STRANGER } }], // neither owned nor client
    ['120000000000068', { id: '120000000000068', business: { id: STRANGER } }],
    [`${PORTFOLIO}/client_product_catalogs`, { data: [{ id: '120000000000062' }, { id: '120000000000063' }, { id: '120000000000064' }] }],
    ['120000000000061', { id: '120000000000061', product_catalog: { id: '120000000000060' } }], // a set of the owned catalog
    ['120000000000065', { id: '120000000000065', product_catalog: { id: '120000000000063' } }], // a set of another Nexus business's catalog
    ['120000000000067', { id: '120000000000067', product_catalog: { id: '120000000000068' } }], // a set of a foreign catalog
  ])
  h.taken.clear(); h.taken.add(OTHER_NEXUS); h.takenFails = false; h.reads = []
})

describe('the catalog rule for a change = step 12\'s read rule', () => {
  it('an owned catalog, a client catalog whose named owner is outside Nexus, or a product set of one, passes; nothing named needs no read', async () => {
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toBeNull()
    expect(await metaCatalogProblem(target, { catalogId: '120000000000062' })).toBeNull()
    expect(await metaCatalogProblem(target, { productSetId: '120000000000061' })).toBeNull()
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060', productSetId: '120000000000061' })).toBeNull()
    h.reads = []
    expect(await metaCatalogProblem(target, {})).toBeNull()
    expect(h.reads).toEqual([])
  })
  it('OWNER FIX: a client catalog another Nexus business owns (or a product set of it) is refused; so is a client catalog with no named owner', async () => {
    expect(await metaCatalogProblem(target, { catalogId: '120000000000063' })).toMatch(/^That catalog belongs to a business portfolio another business in Nexus uses\. Nexus names no such catalog in a change, so nothing is sent\.$/)
    expect(await metaCatalogProblem(target, { productSetId: '120000000000065' })).toMatch(/another business in Nexus uses\. .*nothing is sent/)
    expect(await metaCatalogProblem(target, { catalogId: '120000000000064' })).toMatch(/Meta names no owner business for that client catalog, so Nexus cannot tell whose it is\. .*nothing is sent/)
  })
  it('a forged catalog, a product set of a foreign catalog, a set of another catalog than named: refused in words', async () => {
    expect(await metaCatalogProblem(target, { catalogId: '120000000000069' })).toMatch(/not owned by the chosen ad account's business portfolio, nor shared with it as a client catalog\. .*nothing is sent/)
    expect(await metaCatalogProblem(target, { productSetId: '120000000000067' })).toMatch(/not owned by the chosen ad account's business portfolio/)
    expect(await metaCatalogProblem(target, { catalogId: '120000000000062', productSetId: '120000000000061' })).toMatch(/not in the catalog named/)
  })
  it('a portfolio another Nexus business uses: refused before any catalog is read', async () => {
    h.taken.add(PORTFOLIO)
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/shared with another business in Nexus/)
    expect(h.reads).toEqual(['act_1234567890'])
  })
  it('a lookup that FAILS never passes: Meta refuses a read, or the database errs; no portfolio is refused', async () => {
    h.answers.set(`${PORTFOLIO}/client_product_catalogs`, new Error('Meta refused it (200): Permissions error.'))
    expect(await metaCatalogProblem(target, { catalogId: '120000000000062' })).toMatch(/could not confirm the catalog \(Meta refused it \(200\)/)
    h.answers.set('120000000000060', new Error('Meta refused it (100): Unsupported get request.'))
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/could not confirm that this catalog is the business's .*nothing is sent/)
    h.answers.delete('act_1234567890')
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/could not confirm the catalog/)
    h.answers.set('act_1234567890', { business: { id: PORTFOLIO } })
    h.takenFails = true
    expect(await metaCatalogProblem(target, { catalogId: '120000000000062' })).toMatch(/could not confirm the catalog \(connection to the database lost\)/)
    h.answers.set('act_1234567890', { id: 'act_1234567890' })
    h.takenFails = false
    expect(await metaCatalogProblem(target, { catalogId: '120000000000060' })).toMatch(/names no business portfolio.*nothing is sent/)
  })
})
