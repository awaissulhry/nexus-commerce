// apps/api/src/services/ebay-description-theme.service.vitest.test.ts
//
// ED v2 POLISH — unit tests for the two deferred Phase-1 items:
//
//   1. {{policies}} wiring: resolvePolicyDisplayNames (ebay-account.service)
//      turns the candidate policy ids a push site holds into the display names
//      the theme renders, and the single-SKU render pipeline receives them —
//      the exact plumbing the flat-file push call sites now use.
//   2. SHELL pool-parent gallery borrow in loadGalleries: a childless shell
//      product with no curated rows and no master gallery borrows the pool
//      parent's galleries via ACTIVE SharedListingMembership rows (mock
//      prisma; fail-open on any error).

import { describe, it, expect, vi } from 'vitest'

// The gallery loader fail-open-reads the per-market image axis through the
// real preference service (own prisma singleton) — neutralize it so tests
// never touch a database and stay deterministic.
vi.mock('./ebay-image-axis-preference.service.js', () => ({
  readImageAxisPreference: async () => undefined,
}))

import { resolvePolicyDisplayNames } from './ebay-account.service.js'
import { renderListingDescriptionSafe, ensureBuiltInThemes } from './ebay-description-theme.service.js'
import { BUILT_IN_THEMES, BUILT_IN_PREVIOUS } from './ebay-description-render.js'

// ── Fixtures ───────────────────────────────────────────────────────────────

const IT_SNAPSHOT = {
  fulfillmentPolicies: [
    { id: 'F1', name: 'Spedizione 24/48h', marketplaceId: 'EBAY_IT' },
    { id: 'F2', name: 'Ritiro in negozio', marketplaceId: 'EBAY_IT' },
  ],
  paymentPolicies: [{ id: 'P1', name: 'PayPal e carte', marketplaceId: 'EBAY_IT' }],
  returnPolicies: [{ id: 'R1', name: 'Reso 30 giorni', marketplaceId: 'EBAY_IT' }],
  locations: [],
}

const okProvider = { getSnapshot: vi.fn(async () => IT_SNAPSHOT) }

interface RenderFixture {
  themeHtml?: string
  /** curated eBay ListingImage rows, keyed by productId */
  curatedByProduct?: Record<
    string,
    Array<{ variantGroupKey: string | null; variantGroupValue: string | null; variationId: string | null; url: string }>
  >
  /** master ProductImage rows, keyed by productId */
  masterByProduct?: Record<string, Array<{ url: string }>>
  productsById?: Record<string, { sku: string }>
  childCount?: number
  memberships?: Array<{ productId: string | null }>
  memberParents?: Record<string, { parentId: string | null }>
  membershipsThrow?: boolean
}

function mockPrisma(f: RenderFixture) {
  return {
    channelListing: {
      findFirst: vi.fn(async () => ({
        title: 'Listing title',
        description: 'Corpo annuncio',
        platformAttributes: {},
        flatFileSnapshot: null,
      })),
    },
    ebayDescriptionTheme: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({
        id: 'th1',
        name: 'Test theme',
        html: f.themeHtml ?? '<div>{{gallery}}</div>',
        active: true,
        isDefault: true,
        version: 1,
      })),
    },
    listingImage: {
      findMany: vi.fn(async ({ where }: { where: { productId: string } }) => f.curatedByProduct?.[where.productId] ?? []),
    },
    productImage: {
      findMany: vi.fn(async ({ where }: { where: { productId: string } }) => f.masterByProduct?.[where.productId] ?? []),
    },
    product: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; sku?: string } }) => {
        if (where.id) return f.productsById?.[where.id] ?? null
        return null // variant-by-sku lookup — not under test here
      }),
      count: vi.fn(async () => f.childCount ?? 0),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => f.memberParents?.[id]).filter((x): x is { parentId: string | null } => Boolean(x)),
      ),
    },
    sharedListingMembership: {
      findMany: vi.fn(async () => {
        if (f.membershipsThrow) throw new Error('memberships table unavailable')
        return f.memberships ?? []
      }),
    },
  }
}

const asPrisma = (m: ReturnType<typeof mockPrisma>) => m as unknown as Parameters<typeof renderListingDescriptionSafe>[0]

// ═══════════════════════════════════════════════════════════════════════════
// 1. resolvePolicyDisplayNames — candidate ids → display names
// ═══════════════════════════════════════════════════════════════════════════

describe('resolvePolicyDisplayNames', () => {
  it('maps exact policy ids to their display names, keyed shipping/returns/payment', async () => {
    const out = await resolvePolicyDisplayNames('conn-1', 'EBAY_IT', { fulfillmentId: 'F2', paymentId: 'P1', returnId: 'R1' }, okProvider)
    expect(out).toEqual({ shipping: 'Ritiro in negozio', returns: 'Reso 30 giorni', payment: 'PayPal e carte' })
  })

  it('missing or unknown ids resolve to the market\'s FIRST policy — mirroring the offer waterfall\'s 25007 replacement', async () => {
    const out = await resolvePolicyDisplayNames('conn-1', 'EBAY_IT', { fulfillmentId: undefined, paymentId: 'GHOST', returnId: 'WRONG-MARKET' }, okProvider)
    expect(out).toEqual({ shipping: 'Spedizione 24/48h', returns: 'Reso 30 giorni', payment: 'PayPal e carte' })
  })

  it('fail-open: a snapshot error yields undefined (theme renders without a policies block), never a throw', async () => {
    const out = await resolvePolicyDisplayNames('conn-1', 'EBAY_IT', { fulfillmentId: 'F1' }, {
      getSnapshot: async () => { throw new Error('eBay API error 500') },
    })
    expect(out).toBeUndefined()
  })

  it('a market with no policies at all yields undefined, not an empty object', async () => {
    const out = await resolvePolicyDisplayNames('conn-1', 'EBAY_DE', { fulfillmentId: 'F1' }, {
      getSnapshot: async () => ({ fulfillmentPolicies: [], paymentPolicies: [], returnPolicies: [], locations: [] }),
    })
    expect(out).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Single-SKU render receives policies (the push call sites' plumbing)
// ═══════════════════════════════════════════════════════════════════════════

describe('renderListingDescriptionSafe — {{policies}} wiring', () => {
  it('the resolved display names flow into the single-SKU render and appear localized for the market', async () => {
    const prisma = mockPrisma({ themeHtml: '<div>{{policies}}</div>' })
    // The exact two steps the flat-file push sites perform:
    const policies = await resolvePolicyDisplayNames('conn-1', 'EBAY_IT', { fulfillmentId: 'F1', paymentId: 'P1', returnId: 'R1' }, okProvider)
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'prod-1',
      marketplace: 'IT',
      mode: 'single',
      sku: 'SKU-1',
      body: 'Corpo annuncio',
      policies,
    })
    expect(res.themed).toBe(true)
    expect(res.warnings).toEqual([])
    // Names delivered…
    expect(res.html).toContain('Spedizione 24/48h')
    expect(res.html).toContain('Reso 30 giorni')
    expect(res.html).toContain('PayPal e carte')
    // …under the market's own section labels (IT buyer never sees 'Shipping:').
    expect(res.html).toContain('<strong>Spedizione:</strong>')
    expect(res.html).toContain('<strong>Resi:</strong>')
    expect(res.html).toContain('<strong>Pagamento:</strong>')
  })

  it('without policies the block renders empty (inert) — no labels, no throw', async () => {
    const prisma = mockPrisma({ themeHtml: '<div>{{policies}}</div>' })
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'prod-1',
      marketplace: 'IT',
      mode: 'single',
      sku: 'SKU-1',
      body: 'Corpo annuncio',
    })
    expect(res.themed).toBe(true)
    expect(res.html).not.toContain('Spedizione')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. SHELL pool-parent gallery borrow
// ═══════════════════════════════════════════════════════════════════════════

const POOL = 'pool-parent-1'

const shellFixture = (extra: Partial<RenderFixture> = {}): RenderFixture => ({
  productsById: { 'shell-1': { sku: 'SHELL-1' } },
  childCount: 0,
  memberships: [{ productId: 'v1' }, { productId: 'v2' }, { productId: null }],
  memberParents: { v1: { parentId: POOL }, v2: { parentId: POOL } },
  ...extra,
})

describe('loadGalleries — shell pool-parent borrow (via renderListingDescriptionSafe)', () => {
  it('a childless shell with nothing curated and no master gallery borrows the pool parent\'s CURATED galleries', async () => {
    const prisma = mockPrisma(shellFixture({
      curatedByProduct: {
        [POOL]: [
          { variantGroupKey: null, variantGroupValue: null, variationId: null, url: 'https://img.example/pool-shared.jpg' },
          { variantGroupKey: 'Colore', variantGroupValue: 'Nero', variationId: null, url: 'https://img.example/pool-nero.jpg' },
        ],
      },
    }))
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'shell-1',
      marketplace: 'IT',
      mode: 'group',
      body: 'Corpo annuncio',
    })
    expect(res.themed).toBe(true)
    expect(res.html).toContain('https://img.example/pool-shared.jpg')
    expect(res.html).toContain('https://img.example/pool-nero.jpg')
    expect(res.html).toContain('Nero') // per-colour section heading survives the borrow
    // Exactly ONE extra pass: shell first, then the pool parent — no recursion.
    const curatedCalls = prisma.listingImage.findMany.mock.calls.map((c) => (c[0] as { where: { productId: string } }).where.productId)
    expect(curatedCalls).toEqual(['shell-1', POOL])
  })

  it('borrow re-runs the FULL curated-then-master resolution: pool parent with no curation falls to its master gallery', async () => {
    const prisma = mockPrisma(shellFixture({
      masterByProduct: { [POOL]: [{ url: 'https://img.example/pool-master.jpg' }] },
    }))
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'shell-1',
      marketplace: 'IT',
      mode: 'group',
      body: 'Corpo annuncio',
    })
    expect(res.themed).toBe(true)
    expect(res.html).toContain('https://img.example/pool-master.jpg')
  })

  it('a product WITH children never borrows (it is not a shell) — empty gallery stays empty', async () => {
    const prisma = mockPrisma(shellFixture({
      childCount: 3,
      curatedByProduct: { [POOL]: [{ variantGroupKey: null, variantGroupValue: null, variationId: null, url: 'https://img.example/pool-shared.jpg' }] },
    }))
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'shell-1',
      marketplace: 'IT',
      mode: 'group',
      body: 'Corpo annuncio',
    })
    expect(res.themed).toBe(true)
    expect(res.html).not.toContain('img.example')
    // Only the shell's own pass — the pool parent was never consulted.
    const curatedCalls = prisma.listingImage.findMany.mock.calls.map((c) => (c[0] as { where: { productId: string } }).where.productId)
    expect(curatedCalls).toEqual(['shell-1'])
  })

  it('a product with its own curated gallery never borrows even when memberships exist', async () => {
    const prisma = mockPrisma(shellFixture({
      curatedByProduct: {
        'shell-1': [{ variantGroupKey: null, variantGroupValue: null, variationId: null, url: 'https://img.example/own.jpg' }],
        [POOL]: [{ variantGroupKey: null, variantGroupValue: null, variationId: null, url: 'https://img.example/pool-shared.jpg' }],
      },
    }))
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'shell-1',
      marketplace: 'IT',
      mode: 'group',
      body: 'Corpo annuncio',
    })
    expect(res.html).toContain('https://img.example/own.jpg')
    expect(res.html).not.toContain('pool-shared.jpg')
  })

  it('fail-open: a membership lookup error keeps the current empty-gallery behaviour, render still succeeds', async () => {
    const prisma = mockPrisma(shellFixture({ membershipsThrow: true }))
    const res = await renderListingDescriptionSafe(asPrisma(prisma), {
      productId: 'shell-1',
      marketplace: 'IT',
      mode: 'group',
      body: 'Corpo annuncio',
    })
    expect(res.themed).toBe(true)
    expect(res.warnings).toEqual([])
    expect(res.html).not.toContain('<img')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. ensureBuiltInThemes — safe auto-upgrade of UNEDITED built-in rows (v2)
// ═══════════════════════════════════════════════════════════════════════════

describe('ensureBuiltInThemes — upgrade guard', () => {
  const XAVIA = BUILT_IN_THEMES.find((t) => t.name === 'Xavia Pro Clean')!
  const V1_HTML = BUILT_IN_PREVIOUS['Xavia Pro Clean'][0]
  const otherRows = BUILT_IN_THEMES.filter((t) => t.name !== XAVIA.name).map((t) => ({
    name: t.name,
    html: t.html,
    builtIn: true,
  }))

  function seedPrisma(rows: Array<{ name: string; html: string; builtIn: boolean }>) {
    return {
      ebayDescriptionTheme: {
        findMany: vi.fn(async () => rows),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    }
  }
  const asClient = (m: ReturnType<typeof seedPrisma>) => m as unknown as Parameters<typeof ensureBuiltInThemes>[0]

  it('the frozen v1 html really is a previous version of the CURRENT v2 (guard preconditions)', () => {
    expect(V1_HTML).toBeTruthy()
    expect(V1_HTML).not.toBe(XAVIA.html)
  })

  it('missing themes are still inserted (existing behaviour unchanged)', async () => {
    const prisma = seedPrisma([])
    await ensureBuiltInThemes(asClient(prisma))
    expect(prisma.ebayDescriptionTheme.create).toHaveBeenCalledTimes(BUILT_IN_THEMES.length)
    expect(prisma.ebayDescriptionTheme.update).not.toHaveBeenCalled()
  })

  it('an UNEDITED seeded row (html byte-equals the frozen v1) is upgraded: html + notes, version incremented', async () => {
    const prisma = seedPrisma([{ name: XAVIA.name, html: V1_HTML, builtIn: true }, ...otherRows])
    await ensureBuiltInThemes(asClient(prisma))
    expect(prisma.ebayDescriptionTheme.create).not.toHaveBeenCalled()
    expect(prisma.ebayDescriptionTheme.update).toHaveBeenCalledTimes(1)
    expect(prisma.ebayDescriptionTheme.update).toHaveBeenCalledWith({
      where: { name: XAVIA.name },
      data: { html: XAVIA.html, notes: XAVIA.notes, version: { increment: 1 } },
    })
  })

  it('an OPERATOR-EDITED row is NEVER touched, even though the built-in constant moved on', async () => {
    const prisma = seedPrisma([
      { name: XAVIA.name, html: V1_HTML + '<!-- operator tweak -->', builtIn: true },
      ...otherRows,
    ])
    await ensureBuiltInThemes(asClient(prisma))
    expect(prisma.ebayDescriptionTheme.update).not.toHaveBeenCalled()
    expect(prisma.ebayDescriptionTheme.create).not.toHaveBeenCalled()
  })

  it('rows already at the CURRENT html are left alone — no useless version bumps', async () => {
    const prisma = seedPrisma(BUILT_IN_THEMES.map((t) => ({ name: t.name, html: t.html, builtIn: true })))
    await ensureBuiltInThemes(asClient(prisma))
    expect(prisma.ebayDescriptionTheme.update).not.toHaveBeenCalled()
    expect(prisma.ebayDescriptionTheme.create).not.toHaveBeenCalled()
  })

  it('a same-named NON-built-in (operator-created) theme is never upgraded, even at v1 html', async () => {
    const prisma = seedPrisma([{ name: XAVIA.name, html: V1_HTML, builtIn: false }, ...otherRows])
    await ensureBuiltInThemes(asClient(prisma))
    expect(prisma.ebayDescriptionTheme.update).not.toHaveBeenCalled()
  })
})
