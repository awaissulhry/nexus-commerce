/**
 * DS-0 (Description Studio) — server read-path truth for the theme routes:
 *
 *   1. POST /ebay/description-preview root-resolves a child-row seed to its
 *      FAMILY ROOT (mirrors the push service walk) and reports an EMPTY
 *      per-market body as a warning — never an error, the render still returns.
 *   2. GET /ebay/description-themes/usage?marketplace= counts assignments for
 *      that market only, ONE per family root (child listings don't inflate);
 *      absent param = exactly the legacy all-listings behaviour.
 *   3. PUT /ebay/description-themes/:id with expectedVersion replies 409 on a
 *      version conflict; absent param = legacy last-write-wins passthrough.
 *
 * All prisma + theme-service I/O is mocked; assertions run via Fastify inject.
 *
 * Run: npx vitest run src/routes/ebay-description-themes.routes.vitest.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const productFindFirst = vi.fn()
const productFindMany = vi.fn()
const productCount = vi.fn()
const clFindFirst = vi.fn()
const clFindMany = vi.fn()
const themeFindUnique = vi.fn()
const themeUpdate = vi.fn()
const mockRender = vi.fn()
const mockResolveMode = vi.fn()

vi.mock('../db.js', () => ({
  default: {
    product: {
      findFirst: (...args: unknown[]) => productFindFirst(...args),
      findMany: (...args: unknown[]) => productFindMany(...args),
      count: (...args: unknown[]) => productCount(...args),
    },
    channelListing: {
      findFirst: (...args: unknown[]) => clFindFirst(...args),
      findMany: (...args: unknown[]) => clFindMany(...args),
    },
    ebayDescriptionTheme: {
      findUnique: (...args: unknown[]) => themeFindUnique(...args),
      update: (...args: unknown[]) => themeUpdate(...args),
    },
  },
}))
vi.mock('../services/ebay-description-theme.service.js', () => ({
  listThemes: vi.fn(async () => []),
  setDefaultTheme: vi.fn(async () => undefined),
  renderListingDescriptionSafe: (...args: unknown[]) => mockRender(...args),
  galleryHashOfRows: vi.fn(() => 'hash'),
  evaluateDescriptionStaleness: vi.fn(() => ({ stale: false, reasons: [] })),
  resolveDescriptionMode: (...args: unknown[]) => mockResolveMode(...args),
}))

import ebayDescriptionThemesRoutes from './ebay-description-themes.routes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(ebayDescriptionThemesRoutes)
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no products, no listings, render echoes the body it was given.
  productFindFirst.mockResolvedValue(null)
  productFindMany.mockResolvedValue([])
  productCount.mockResolvedValue(0)
  clFindFirst.mockResolvedValue(null)
  clFindMany.mockResolvedValue([])
  mockRender.mockImplementation(async (_prisma: unknown, args: { body: string }) => ({
    html: `<div class="t">${args.body}</div>`,
    themed: true,
    themeId: 'theme-1',
    themeName: 'Classic',
    warnings: [],
  }))
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. POST /ebay/description-preview — root-resolve + empty-body warning
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /ebay/description-preview (DS-0)', () => {
  const preview = (payload: object) =>
    app.inject({ method: 'POST', url: '/ebay/description-preview', payload })

  it('a CHILD-row seed previews the FAMILY: listing lookup + render use the root product id', async () => {
    const family: Record<string, { id: string; parentId: string | null }> = {
      'child-1': { id: 'child-1', parentId: 'root-1' },
      'root-1': { id: 'root-1', parentId: null },
    }
    productFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => family[where.id] ?? null)
    clFindFirst.mockResolvedValue({ description: 'Family body', title: 'Family title' })

    const res = await preview({ productId: 'child-1', marketplace: 'IT' })
    expect(res.statusCode).toBe(200)

    // The listing row is the ROOT's row for the market.
    expect(clFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ productId: 'root-1', channel: 'EBAY', region: 'IT' }) }),
    )
    // The render sees the ROOT id (theme assignment + galleries live there)
    // and the family's per-market body.
    const renderArgs = mockRender.mock.calls[0][1] as { productId: string; body: string }
    expect(renderArgs.productId).toBe('root-1')
    expect(renderArgs.body).toBe('Family body')
    expect(res.json().html).toBe('<div class="t">Family body</div>')
  })

  it('a ROOT (or unknown) product id resolves to itself — legacy passthrough', async () => {
    productFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'root-1' ? { id: 'root-1', parentId: null } : null,
    )
    clFindFirst.mockResolvedValue({ description: 'Body', title: 'T' })

    await preview({ productId: 'root-1' })
    expect((mockRender.mock.calls[0][1] as { productId: string }).productId).toBe('root-1')

    // Unknown id: no product row → render still runs against the given id.
    await preview({ productId: 'ghost' })
    expect((mockRender.mock.calls[1][1] as { productId: string }).productId).toBe('ghost')
  })

  it('EMPTY per-market body → warning (never an error); the render still returns', async () => {
    productFindFirst.mockResolvedValue({ id: 'root-1', parentId: null })
    clFindFirst.mockResolvedValue(null) // no listing row → no body for this market

    const res = await preview({ productId: 'root-1', marketplace: 'de' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.warnings).toContain('body: empty — no DE listing content for this product')
    expect(body.html).toBe('<div class="t"></div>') // theme shell still rendered
  })

  it('whitespace-only stored description also warns; renderer warnings are preserved alongside', async () => {
    productFindFirst.mockResolvedValue({ id: 'root-1', parentId: null })
    clFindFirst.mockResolvedValue({ description: '   ', title: 'T' })
    mockRender.mockResolvedValue({ html: '<div/>', themed: true, warnings: ['renderer says hi'] })

    const res = await preview({ productId: 'root-1' })
    expect(res.json().warnings).toEqual([
      'renderer says hi',
      'body: empty — no IT listing content for this product',
    ])
  })

  it('a NON-empty body produces no empty-body warning (regression guard)', async () => {
    productFindFirst.mockResolvedValue({ id: 'root-1', parentId: null })
    clFindFirst.mockResolvedValue({ description: 'Real body', title: 'T' })

    const res = await preview({ productId: 'root-1' })
    expect(res.json().warnings).toEqual([])

    // Request-supplied body wins over the (empty) listing too.
    clFindFirst.mockResolvedValue(null)
    const res2 = await preview({ productId: 'root-1', body: 'Draft body' })
    expect(res2.json().warnings).toEqual([])
  })

  // DS-6 — the Studio calls the preview "exactly what a push would send", so
  // the render MODE has to be the one pushDescriptions uses. The route used to
  // default to 'group' unconditionally (per-colour sections for standalone
  // products), then briefly counted children itself — which scored every
  // adopted/pool-shell listing 'single' and hid its Colori section. Both sides
  // now delegate to resolveDescriptionMode, so parity is structural: the route's
  // job is to CALL it with the family root and pass the answer through.
  describe('render mode parity with the push service', () => {
    beforeEach(() => {
      productFindFirst.mockResolvedValue({ id: 'root-1', parentId: null })
      clFindFirst.mockResolvedValue({ description: 'Body', title: 'T' })
    })

    it('delegates to the shared resolver, keyed on the FAMILY ROOT', async () => {
      mockResolveMode.mockResolvedValue('group')
      await preview({ productId: 'root-1' })
      expect(mockResolveMode).toHaveBeenCalledWith(expect.anything(), 'root-1')
      expect((mockRender.mock.calls[0][1] as { mode: string }).mode).toBe('group')
    })

    it('passes the resolver\'s single-mode answer straight through', async () => {
      mockResolveMode.mockResolvedValue('single')
      await preview({ productId: 'root-1' })
      expect((mockRender.mock.calls[0][1] as { mode: string }).mode).toBe('single')
    })

    it('an explicit mode from the caller still wins (legacy callers unchanged)', async () => {
      mockResolveMode.mockResolvedValue('single')
      await preview({ productId: 'root-1', mode: 'group' })
      expect((mockRender.mock.calls[0][1] as { mode: string }).mode).toBe('group')
      expect(mockResolveMode).not.toHaveBeenCalled()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET /ebay/description-themes/usage — marketplace filter + root-scoping
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /ebay/description-themes/usage (DS-0)', () => {
  it('WITHOUT marketplace: legacy behaviour — every eBay row counted, no root-resolve', async () => {
    clFindMany.mockResolvedValue([
      { platformAttributes: { descriptionThemeId: 't1' } },
      { platformAttributes: { descriptionThemeId: 't1' } },
      { platformAttributes: { descriptionThemeId: 'none' } },
      { platformAttributes: {} },
      { platformAttributes: null },
    ])

    const res = await app.inject({ method: 'GET', url: '/ebay/description-themes/usage' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ total: 5, default: 2, raw: 1, byThemeId: { t1: 2 } })
    // Legacy query shape: all markets, and NO family walk.
    expect(clFindMany).toHaveBeenCalledWith({
      where: { channel: 'EBAY' },
      select: { platformAttributes: true },
    })
    expect(productFindMany).not.toHaveBeenCalled()
  })

  it('WITH marketplace: filters to the region and counts ONE per family root (root row wins)', async () => {
    clFindMany.mockResolvedValue([
      // Family 1: a CHILD row first (stale assignment), then the ROOT row —
      // the root's assignment is the truth and the family counts ONCE.
      { productId: 'c1', platformAttributes: { descriptionThemeId: 'stale-child-theme' } },
      { productId: 'root-1', platformAttributes: { descriptionThemeId: 't9' } },
      { productId: 'c2', platformAttributes: {} },
      // Family 2: root-only, no assignment → default.
      { productId: 'root-2', platformAttributes: {} },
      // Family 3: only a child row exists for this market → it stands in.
      { productId: 'c3', platformAttributes: { descriptionThemeId: 'none' } },
    ])
    productFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      const rows: Record<string, { id: string; parentId: string | null }> = {
        'c1': { id: 'c1', parentId: 'root-1' },
        'c2': { id: 'c2', parentId: 'root-1' },
        'c3': { id: 'c3', parentId: 'root-3' },
        'root-1': { id: 'root-1', parentId: null },
        'root-2': { id: 'root-2', parentId: null },
        'root-3': { id: 'root-3', parentId: null },
      }
      return where.id.in.map((id) => rows[id]).filter(Boolean)
    })

    const res = await app.inject({ method: 'GET', url: '/ebay/description-themes/usage?marketplace=IT' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      marketplace: 'IT',
      total: 3, // 3 families, not 5 listing rows
      default: 1, // root-2
      raw: 1, // family 3 via its child row
      byThemeId: { t9: 1 }, // root-1's own row beat the child's stale value
    })
    expect(clFindMany).toHaveBeenCalledWith({
      where: { channel: 'EBAY', region: 'IT' },
      select: { productId: true, platformAttributes: true },
    })
  })

  it('marketplace=UK maps to region GB (flat-file market code convention)', async () => {
    clFindMany.mockResolvedValue([])
    const res = await app.inject({ method: 'GET', url: '/ebay/description-themes/usage?marketplace=uk' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ marketplace: 'UK', total: 0, default: 0, raw: 0, byThemeId: {} })
    expect(clFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channel: 'EBAY', region: 'GB' } }),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. PUT /ebay/description-themes/:id — optimistic expectedVersion guard
// ═══════════════════════════════════════════════════════════════════════════

describe('PUT /ebay/description-themes/:id (DS-0 version guard)', () => {
  const put = (payload: object) =>
    app.inject({ method: 'PUT', url: '/ebay/description-themes/t1', payload })

  beforeEach(() => {
    themeFindUnique.mockResolvedValue({ id: 't1', name: 'Classic', version: 5, active: true, builtIn: false })
    themeUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }))
  })

  it('expectedVersion mismatch → 409 with the current version; nothing is written', async () => {
    const res = await put({ name: 'Renamed', expectedVersion: 3 })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'version conflict — theme was modified elsewhere', currentVersion: 5 })
    expect(themeUpdate).not.toHaveBeenCalled()
  })

  it('expectedVersion match → update proceeds (version still increments)', async () => {
    const res = await put({ name: 'Renamed', expectedVersion: 5 })
    expect(res.statusCode).toBe(200)
    expect(themeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1' },
        data: expect.objectContaining({ name: 'Renamed', version: { increment: 1 } }),
      }),
    )
  })

  it('ABSENT expectedVersion → legacy last-write-wins passthrough', async () => {
    const res = await put({ name: 'Renamed' })
    expect(res.statusCode).toBe(200)
    expect(themeUpdate).toHaveBeenCalledTimes(1)
  })

  it('404 for a missing theme still wins over the version guard', async () => {
    themeFindUnique.mockResolvedValue(null)
    const res = await put({ name: 'X', expectedVersion: 1 })
    expect(res.statusCode).toBe(404)
  })
})
