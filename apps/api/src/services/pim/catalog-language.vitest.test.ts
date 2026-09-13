import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ product: { findMany: vi.fn() }, readinessIndex: { findMany: vi.fn() }, $queryRaw: vi.fn() }))
vi.mock('../../db.js', () => ({ default: db }))
import { catalogLanguageValues, indexFallsBack, orderCatalogLanguage, restrictCatalogLanguage } from './catalog-language.js'
beforeEach(() => vi.resetAllMocks())
describe('catalog language read path', () => {
  it('matches the indexed fallback verdict, including an optional field', () => {
    // LX.F P2-14 — the verdict is the `kind` key the producer stamps, not the
    // sentence. The old prose matcher is kept here as the arm that must NOT fire:
    // a wording change (or an empty language segment) no longer decides a filter.
    expect(indexFallsBack([{ field: 'description', reason: 'de content is missing; showing it fallback.', kind: 'language-fallback' }])).toBe(true)
    expect(indexFallsBack([{ field: 'description', reason: 'de content is missing; showing it fallback.' }])).toBe(false)
    expect(indexFallsBack([{ field: 'description', reason: 'de content is missing; showing  fallback.', kind: 'language-fallback' }])).toBe(true)
    expect(indexFallsBack([{ reason: 'Missing title' }])).toBe(false)
    expect(indexFallsBack(null)).toBe(false)
  })
  it('uses the resolver for page text and retains missing index as absent/unknown', async () => {
    db.product.findMany.mockResolvedValue([{ id: 'p', name: 'Italian source', description: 'Italian description', translations: [{ language: 'de', name: 'Deutscher Titel', source: 'ai' }] }])
    db.readinessIndex.findMany.mockResolvedValue([])
    const result = (await catalogLanguageValues(['p'], 'de')).get('p')!
    expect(result.title).toMatchObject({ value: 'Deutscher Titel', language: 'de', provenance: { member: 'ai' } })
    expect(result.description).toMatchObject({ value: 'Italian description', language: 'it' })
    // R-LX-9: a product with no ReadinessIndex row for this language is
    // `notComputed` — the catalogue column must not say "Not set up" about a
    // scope nobody has measured.
    expect(result.readiness).toEqual({ state: 'notComputed', pct: null, computedAt: null })
    expect(result.fallsBackToSource).toBeNull()
  })
  it('applies fallback and readiness predicates in SQL before pagination', async () => {
    db.product.findMany.mockResolvedValue([{ id: 'p' }]); db.$queryRaw.mockResolvedValue([{ id: 'p' }])
    expect(await restrictCatalogLanguage({ language: 'de', languageStates: ['warn'], languageFallback: true }, { familyId: 'xavia' })).toEqual(['p'])
    const sql = db.$queryRaw.mock.calls[0][0]
    expect(sql.sql).toContain('jsonb_array_elements'); expect(sql.sql).toContain('r.channel IS NULL')
    expect(sql.values).toEqual(expect.arrayContaining(['de', 'warn', true]))
    expect(db.product.findMany).toHaveBeenCalledWith({ where: { familyId: 'xavia' }, select: { id: true } })
  })
  it('an empty state selection matches no products', async () => {
    expect(await restrictCatalogLanguage({ language: 'de', languageStates: [] }, {})).toEqual([])
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })
  it('sorts the complete indexed scope before limit/offset with a stable tie break', async () => {
    db.product.findMany.mockResolvedValue([{ id: 'p' }]); db.$queryRaw.mockResolvedValue([{ id: 'p' }])
    await orderCatalogLanguage({ language: 'fr', languageSort: { field: 'readiness', direction: 'desc' } }, {}, 100, 100)
    const sql = db.$queryRaw.mock.calls[0][0]
    // LX.F F6 — the readiness sort orders by SEVERITY, not by the alphabet
    // (`absent < blocked < notComputed < ready < warn` put `ready` above `warn`).
    // The CASE is built from the one ordered `SCOPE_STATES`, so the ranks are
    // asserted from that array rather than retyped here.
    const { SCOPE_STATES } = await import('./readiness-model.js')
    expect(sql.sql).toContain(`ORDER BY CASE COALESCE(r.state, 'notComputed')`)
    expect(sql.sql).toContain('END DESC NULLS LAST, p.id ASC LIMIT')
    expect(sql.values.slice(2, 2 + SCOPE_STATES.length * 2)).toEqual(SCOPE_STATES.flatMap((state, index) => [state, index]))
    expect(SCOPE_STATES[0]).toBe('blocked')
    expect(sql.values.slice(-2)).toEqual([100, 100])
  })
  it('orders title@lang and description@lang with ONE SQL ORDER BY on the materialised projection', async () => {
    // LX.F2 R-LX-17 (LX.R P2-21) — the text sorts used to re-read every filtered product with its
    // translations in 100-row batches to order one page (measured: 101.7 ms / 86.0 ms per page at 360
    // products, linear in the FILTERED set). They are one `ORDER BY` on `ReadinessIndex.sortTitle` /
    // `sortDescription` now, written by the same producer from the same resolver.
    for (const [field, column] of [['title', 'r."sortTitle"'], ['description', 'r."sortDescription"']] as const) {
      db.product.findMany.mockResolvedValue([{ id: 'p' }]); db.$queryRaw.mockResolvedValue([{ id: 'p' }])
      db.readinessIndex.findMany.mockResolvedValue([])
      expect(await orderCatalogLanguage({ language: 'de', languageSort: { field, direction: 'asc' } }, {}, 50, 25)).toEqual(['p'])
      // ONE query, not a batch per 100 products — the property the finding was about.
      expect(db.$queryRaw).toHaveBeenCalledTimes(1)
      const sql = db.$queryRaw.mock.calls[0][0]
      expect(sql.sql).toContain(`ORDER BY ${column} COLLATE "C" ASC NULLS LAST, p.id ASC LIMIT`)
      // 🔴 NULL is NOT COMPUTED and must sort LAST in BOTH directions, never as an empty string
      // (R-LX-9's rule one column over). The descending arm is the one that would silently put every
      // unmeasured product at the top.
      expect(sql.values.slice(-2)).toEqual([25, 50])
      db.$queryRaw.mockClear()
      db.$queryRaw.mockResolvedValue([{ id: 'p' }])
      await orderCatalogLanguage({ language: 'de', languageSort: { field, direction: 'desc' } }, {}, 0, 10)
      expect(db.$queryRaw.mock.calls[0][0].sql).toContain(`ORDER BY ${column} COLLATE "C" DESC NULLS LAST, p.id ASC LIMIT`)
      vi.resetAllMocks()
    }
    // POSITIVE CONTROL that the arm above targets the TEXT branch and not the whole function: the
    // readiness sort still emits its severity CASE and no sort column at all.
    db.product.findMany.mockResolvedValue([{ id: 'p' }]); db.$queryRaw.mockResolvedValue([{ id: 'p' }])
    await orderCatalogLanguage({ language: 'de', languageSort: { field: 'readiness', direction: 'asc' } }, {}, 0, 10)
    expect(db.$queryRaw.mock.calls[0][0].sql).not.toContain('sortTitle')
    expect(db.$queryRaw.mock.calls[0][0].sql).toContain(`CASE COALESCE(r.state, 'notComputed')`)
  })
})
