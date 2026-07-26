// apps/api/src/services/ebay-description-push.service.vitest.test.ts
//
// ED v2 Phase 4a — unit tests for the description-only push.
//
// All external I/O is mocked:
//   - ebay-trading-api.service (callTradingApi; escapeXml kept FAITHFUL so the
//     pure XML-builder tests exercise real escaping)
//   - ebay-description-theme.service (renderListingDescriptionSafe)
//   - ebay-variation-push.service (resolvePerMarketContent — its field
//     authority has its own tests; here it just echoes the listing)
//   - prisma (injected object, ebay-flat-file-delete.service test style)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock the Trading API module (BEFORE the dynamic import) ────────────────
const mockCallTradingApi = vi.fn()
vi.mock('./ebay-trading-api.service.js', () => ({
  callTradingApi: (...args: unknown[]) => mockCallTradingApi(...args),
  siteIdForMarket: (market: string) => {
    const ids: Record<string, string> = { IT: '101', DE: '77', FR: '71', ES: '186', UK: '3' }
    const id = ids[(market ?? '').toUpperCase()]
    if (!id) throw new Error(`unknown eBay market: ${market}`)
    return id
  },
  // Faithful copy of the real escapeXml — builder tests must see real escaping.
  escapeXml: (s: string) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;'),
}))

// ── Mock the theme renderer + the ED v2 P5 staleness stamp ─────────────────
const mockRender = vi.fn()
const mockStamp = vi.fn()
vi.mock('./ebay-description-theme.service.js', () => ({
  renderListingDescriptionSafe: (...args: unknown[]) => mockRender(...args),
  stampDescriptionPushSafe: (...args: unknown[]) => mockStamp(...args),
}))

// ── Mock the per-market content resolver (heavy module; pure echo here) ────
vi.mock('./ebay-variation-push.service.js', () => ({
  resolvePerMarketContent: (
    listing: { title?: string | null; description?: string | null } | null | undefined,
    fallback: { title?: string | null; description?: string | null; subtitle?: string | null },
  ) => ({
    title: listing?.title ?? fallback.title ?? '',
    description: listing?.description ?? fallback.description ?? '',
    subtitle: fallback.subtitle ?? '',
  }),
}))

// ── Import module under test (after vi.mock) ───────────────────────────────
const {
  buildDescriptionReviseXml,
  buildGetItemDescriptionXml,
  parseDescriptionFromGetItem,
  normalizedDescriptionHash,
  resolvePerListingContent,
  pushDescriptions,
  LANE_A_SKIP_MESSAGE,
} = await import('./ebay-description-push.service.js')

// ── Prisma mock factory ────────────────────────────────────────────────────

interface MockPrismaOpts {
  products?: Array<{ id: string; sku: string; parentId: string | null }>
  children?: Array<{ id: string }>
  parentCl?: Record<string, unknown> | null
  familyCls?: Array<{ platformAttributes: unknown }>
  memberships?: Array<{ itemId: string; flatFileSnapshot: unknown }>
}

function mockPrisma(opts: MockPrismaOpts = {}) {
  const products = opts.products ?? []
  return {
    product: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
        products.find((p) => p.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () => opts.children ?? []),
    },
    channelListing: {
      findFirst: vi.fn(async () => opts.parentCl ?? null),
      findMany: vi.fn(async () => opts.familyCls ?? []),
      update: vi.fn(async () => ({})),
    },
    sharedListingMembership: {
      findMany: vi.fn(async () => opts.memberships ?? []),
    },
  }
}

/** Default render: wrap the body so tests can see which body was rendered. */
function echoRender() {
  mockRender.mockImplementation(async (_prisma: unknown, args: { body: string }) => ({
    html: `<div class="t">${args.body}</div>`,
    themed: true,
    themeId: 'theme-1',
    themeName: 'Classic',
    themeVersion: 3,
    warnings: [],
  }))
}

/** Trading mock: revise succeeds; GetItem echoes back the last-sent CDATA body. */
function tradingEcho() {
  let lastSent = ''
  mockCallTradingApi.mockImplementation(async (callName: string, xml: string) => {
    if (callName === 'ReviseFixedPriceItem') {
      lastSent = /<Description><!\[CDATA\[([\s\S]*?)\]\]><\/Description>/.exec(xml)?.[1] ?? ''
      return { ack: 'Success', errors: [], raw: '<ReviseFixedPriceItemResponse/>' }
    }
    if (callName === 'GetItem') {
      return { ack: 'Success', errors: [], raw: `<GetItemResponse><Item><Description><![CDATA[${lastSent}]]></Description></Item></GetItemResponse>` }
    }
    throw new Error(`unexpected call ${callName}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure XML builder
// ═══════════════════════════════════════════════════════════════════════════

describe('buildDescriptionReviseXml', () => {
  it('carries ONLY ItemID + Description — no other Item fields can move', () => {
    const xml = buildDescriptionReviseXml('123456789', '<p>Ciao</p>')
    expect(xml).toContain('<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">')
    expect(xml).toContain('<Item><ItemID>123456789</ItemID><Description>')
    for (const forbidden of ['<Title>', '<SKU>', '<StartPrice>', '<Quantity>', '<Variations>', '<PictureDetails>', '<PrimaryCategory>']) {
      expect(xml).not.toContain(forbidden)
    }
  })

  it('embeds HTML in CDATA verbatim (no entity escaping of the body)', () => {
    const html = '<p>Guanti "Pro" & <b>caldo</b></p>'
    const xml = buildDescriptionReviseXml('1', html)
    expect(xml).toContain(`<Description><![CDATA[${html}]]></Description>`)
    expect(xml).not.toContain('&lt;p&gt;')
  })

  it('splits a literal "]]>" in the body so it cannot break out of CDATA', () => {
    const xml = buildDescriptionReviseXml('1', 'a]]>b')
    expect(xml).toContain('<![CDATA[a]]]]><![CDATA[>b]]>')
  })

  it('escapes the ItemID', () => {
    const xml = buildDescriptionReviseXml('1&2', 'x')
    expect(xml).toContain('<ItemID>1&amp;2</ItemID>')
  })
})

describe('buildGetItemDescriptionXml', () => {
  it('requests only Item.Description', () => {
    const xml = buildGetItemDescriptionXml('42')
    expect(xml).toContain('<ItemID>42</ItemID>')
    expect(xml).toContain('<OutputSelector>Item.Description</OutputSelector>')
  })
})

describe('parseDescriptionFromGetItem + normalizedDescriptionHash', () => {
  it('round-trips a CDATA description, including the split "]]>" case', () => {
    for (const html of ['<p>Ciao & "bella"</p>', 'a]]>b']) {
      const revise = buildDescriptionReviseXml('1', html)
      const cdata = /<Description>([\s\S]*)<\/Description>/.exec(revise)![1]
      const parsed = parseDescriptionFromGetItem(`<Item><Description>${cdata}</Description></Item>`)
      expect(parsed).toBe(html)
    }
  })

  it('decodes an entity-escaped description', () => {
    const raw = '<Item><Description>&lt;p&gt;Ciao &amp; &quot;bella&quot;&lt;/p&gt;</Description></Item>'
    expect(parseDescriptionFromGetItem(raw)).toBe('<p>Ciao & "bella"</p>')
  })

  it('returns null when there is no Description', () => {
    expect(parseDescriptionFromGetItem('<Item><Title>x</Title></Item>')).toBeNull()
  })

  it('hash ignores whitespace reflow but catches content changes', () => {
    const a = normalizedDescriptionHash('<p>a</p>\n   <p>b</p>')
    const b = normalizedDescriptionHash('<p>a</p><p>b</p>')
    const c = normalizedDescriptionHash('<p>a</p><p>DIFFERENT</p>')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Per-listing body resolution (operator decision D5)
// ═══════════════════════════════════════════════════════════════════════════

describe('resolvePerListingContent', () => {
  const parent = { title: 'Parent T', subtitle: 'Parent S', description: 'Parent D' }

  it('membership snapshot description wins over the parent (bodySource=membership)', () => {
    const out = resolvePerListingContent(
      [{ description: 'Own D', title: 'Own T' }],
      parent,
    )
    expect(out.description).toBe('Own D')
    expect(out.title).toBe('Own T')
    expect(out.subtitle).toBe('Parent S') // per-field fallback
    expect(out.bodySource).toBe('membership')
  })

  it('blank/missing snapshot fields fall back to the parent (bodySource=parent)', () => {
    const out = resolvePerListingContent([{ description: '   ' }, { title: '' }, null], parent)
    expect(out.description).toBe('Parent D')
    expect(out.title).toBe('Parent T')
    expect(out.bodySource).toBe('parent')
  })

  it('first non-blank across the listing\'s snapshots wins', () => {
    const out = resolvePerListingContent(
      [{ description: '' }, { description: 'Second row D' }, { description: 'Third row D' }],
      parent,
    )
    expect(out.description).toBe('Second row D')
  })

  it('non-string snapshot values are ignored', () => {
    const out = resolvePerListingContent([{ description: 42, title: { a: 1 } }], parent)
    expect(out.description).toBe('Parent D')
    expect(out.title).toBe('Parent T')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. pushDescriptions orchestration
// ═══════════════════════════════════════════════════════════════════════════

const ctxWith = (prisma: unknown) => ({
  prisma: prisma as never,
  oauthToken: 'tok',
  sleepMs: 0,
})

describe('pushDescriptions', () => {
  it('Trading family: revises primary (parent body) + adopted listing (its OWN snapshot body), parity OK', async () => {
    echoRender()
    tradingEcho()
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      children: [{ id: 'c1' }, { id: 'c2' }],
      parentCl: {
        id: 'cl-1',
        externalListingId: '2220000001',
        title: 'Family title',
        description: 'Parent body',
        platformAttributes: {},
        flatFileSnapshot: null,
      },
      familyCls: [{ platformAttributes: {} }], // NO __offerIds → Trading primary
      memberships: [
        { itemId: '1110000001', flatFileSnapshot: { description: 'Adopted body', title: 'Adopted title' } },
      ],
    })

    const res = await pushDescriptions({ productIds: ['p1'], marketplace: 'IT' }, ctxWith(prisma))

    expect(res.listings).toHaveLength(2)
    const [primary, adopted] = res.listings
    expect(primary).toMatchObject({ itemId: '2220000001', lane: 'trading', outcome: 'revised', bodySource: 'parent', themed: true })
    expect(adopted).toMatchObject({ itemId: '1110000001', lane: 'trading', outcome: 'revised', bodySource: 'membership' })
    expect(primary.warnings).toEqual([])
    expect(adopted.warnings).toEqual([])

    // D5 — each listing rendered its OWN body through the SAME theme.
    const bodies = mockRender.mock.calls.map((c) => (c[1] as { body: string }).body)
    expect(bodies).toEqual(['Parent body', 'Adopted body'])

    // Revise XML is Description-only, CDATA-wrapped, per listing.
    const reviseCalls = mockCallTradingApi.mock.calls.filter((c) => c[0] === 'ReviseFixedPriceItem')
    expect(reviseCalls).toHaveLength(2)
    expect(reviseCalls[1][1]).toContain('<Item><ItemID>1110000001</ItemID><Description><![CDATA[<div class="t">Adopted body</div>]]></Description></Item>')
    expect(reviseCalls[1][1]).not.toContain('<Title>')

    // Parity read-back happened for both.
    const getCalls = mockCallTradingApi.mock.calls.filter((c) => c[0] === 'GetItem')
    expect(getCalls).toHaveLength(2)
    expect(getCalls[0][1]).toContain('<OutputSelector>Item.Description</OutputSelector>')

    // ED v2 P5 — ONE staleness stamp per family × market after a real revise,
    // carrying the rendered theme id + version.
    expect(mockStamp).toHaveBeenCalledTimes(1)
    expect(mockStamp.mock.calls[0][1]).toEqual({
      productId: 'p1',
      marketplace: 'IT',
      themeId: 'theme-1',
      themeVersion: 3,
    })
  })

  it('Lane A: Inventory-managed primary (__offerIds) is SKIPPED honestly; adopted sibling still revised', async () => {
    echoRender()
    tradingEcho()
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      children: [{ id: 'c1' }],
      parentCl: {
        id: 'cl-1',
        externalListingId: '2220000001',
        title: 'T',
        description: 'Parent body',
        platformAttributes: {},
        flatFileSnapshot: null,
      },
      familyCls: [{ platformAttributes: { __offerIds: { EBAY_IT: 'offer-1' } } }],
      memberships: [{ itemId: '1110000001', flatFileSnapshot: { description: 'Adopted body' } }],
    })

    const res = await pushDescriptions({ productIds: ['p1'], marketplace: 'IT' }, ctxWith(prisma))

    const primary = res.listings.find((l) => l.itemId === '2220000001')!
    expect(primary.lane).toBe('inventory')
    expect(primary.outcome).toBe('inventory-managed')
    expect(primary.message).toBe(LANE_A_SKIP_MESSAGE)
    expect(primary.message).toContain('Full Publish')

    const adopted = res.listings.find((l) => l.itemId === '1110000001')!
    expect(adopted).toMatchObject({ lane: 'trading', outcome: 'revised' })

    // The Inventory-managed primary got NO trading calls at all.
    const revisedIds = mockCallTradingApi.mock.calls
      .filter((c) => c[0] === 'ReviseFixedPriceItem')
      .map((c) => /<ItemID>(\d+)<\/ItemID>/.exec(c[1] as string)?.[1])
    expect(revisedIds).toEqual(['1110000001'])
  })

  it('PARITY MISMATCH: eBay returning different content produces the loud warning', async () => {
    echoRender()
    mockCallTradingApi.mockImplementation(async (callName: string) => {
      if (callName === 'ReviseFixedPriceItem') return { ack: 'Success', errors: [], raw: '<ok/>' }
      return { ack: 'Success', errors: [], raw: '<Item><Description><![CDATA[<div>SOMETHING ELSE</div>]]></Description></Item>' }
    })
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: 'T', description: 'Body', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }],
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings[0].outcome).toBe('revised')
    expect(res.listings[0].warnings.some((w) => w.includes('PARITY MISMATCH — do not trust this result'))).toBe(true)
  })

  it('persists themeId into platformAttributes MERGE-ONLY, even when the primary is Lane-A skipped', async () => {
    echoRender()
    tradingEcho()
    const offerAttrs = { __offerIds: { EBAY_IT: 'o1' }, subtitle: 'Sub' }
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: {
        id: 'cl-1',
        externalListingId: '2220000001',
        title: 'T',
        description: 'Body',
        platformAttributes: offerAttrs,
        flatFileSnapshot: null,
      },
      familyCls: [{ platformAttributes: offerAttrs }], // Inventory-managed family
    })

    const res = await pushDescriptions({ productIds: ['p1'], themeId: 'theme-9' }, ctxWith(prisma))

    expect(prisma.channelListing.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: {
        platformAttributes: {
          __offerIds: { EBAY_IT: 'o1' }, // preserved
          subtitle: 'Sub', // preserved
          descriptionThemeId: 'theme-9',
        },
      },
    })
    expect(res.products[0].themePersisted).toBe(true)
    // The theme write is DB-only — the Inventory-managed primary still gets no trading call.
    expect(res.listings[0]).toMatchObject({ lane: 'inventory', outcome: 'inventory-managed' })
    expect(mockCallTradingApi).not.toHaveBeenCalled()
    // ED v2 P5 — nothing was delivered, so nothing is stamped.
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('surfaces renderer/sanitizer warnings on the per-listing result', async () => {
    mockRender.mockResolvedValue({
      html: '<div>clean</div>',
      themed: true,
      themeId: 't1',
      themeName: 'Classic',
      warnings: ['sanitizer stripped a <script> tag'],
    })
    tradingEcho()
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: 'T', description: 'Body', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }],
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings[0].warnings).toContain('sanitizer stripped a <script> tag')
  })

  it('REFUSES to push an empty rendered body (never blanks a live description)', async () => {
    mockRender.mockResolvedValue({ html: '   ', themed: false, warnings: [] })
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: '', description: '', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }],
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings[0].outcome).toBe('skipped-empty-body')
    expect(mockCallTradingApi).not.toHaveBeenCalled()
  })

  it('maps an eBay inventory/magazzino revise rejection to the honest Lane-A answer', async () => {
    echoRender()
    mockCallTradingApi.mockRejectedValue(
      new Error('eBay ReviseFixedPriceItem Failure: operazione non consentita per gli oggetti del magazzino (code 21919474)'),
    )
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: 'T', description: 'Body', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }], // marker missed it — defensive path
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings[0]).toMatchObject({ lane: 'inventory', outcome: 'inventory-managed', message: LANE_A_SKIP_MESSAGE })
  })

  it('other revise failures report outcome=failed with the eBay message', async () => {
    echoRender()
    mockCallTradingApi.mockRejectedValue(new Error('eBay ReviseFixedPriceItem Failure: listing ended (code 291)'))
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: 'T', description: 'Body', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }],
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings[0].outcome).toBe('failed')
    expect(res.listings[0].message).toContain('listing ended')
    // ED v2 P5 — a failed revise delivered nothing: no staleness stamp.
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('dev dry-run (empty raw from the gate) reports dry-run and skips parity', async () => {
    echoRender()
    mockCallTradingApi.mockResolvedValue({ ack: 'Success', errors: [], raw: '' })
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: 'T', description: 'Body', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }],
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings[0].outcome).toBe('dry-run')
    expect(mockCallTradingApi.mock.calls.filter((c) => c[0] === 'GetItem')).toHaveLength(0)
    // ED v2 P5 — a dry-run delivered nothing: no staleness stamp.
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('child product id resolves up to the family root; unknown product reports a per-product error', async () => {
    echoRender()
    tradingEcho()
    const prisma = mockPrisma({
      products: [
        { id: 'child-1', sku: 'FAM-1-M', parentId: 'root-1' },
        { id: 'root-1', sku: 'FAM-1', parentId: null },
      ],
      parentCl: { id: 'cl-1', externalListingId: '2220000001', title: 'T', description: 'Body', platformAttributes: {}, flatFileSnapshot: null },
      familyCls: [{ platformAttributes: {} }],
    })

    const res = await pushDescriptions({ productIds: ['child-1', 'ghost'] }, ctxWith(prisma))
    expect(res.products[0].parentSku).toBe('FAM-1')
    expect(res.listings[0]).toMatchObject({ itemId: '2220000001', parentSku: 'FAM-1', outcome: 'revised' })
    expect(res.products[1].error).toMatch(/not found/)
  })

  it('a family with no primary and no memberships reports a per-product warning, no eBay calls', async () => {
    echoRender()
    const prisma = mockPrisma({
      products: [{ id: 'p1', sku: 'FAM-1', parentId: null }],
      parentCl: null,
      familyCls: [],
    })

    const res = await pushDescriptions({ productIds: ['p1'] }, ctxWith(prisma))
    expect(res.listings).toHaveLength(0)
    expect(res.products[0].warnings.some((w) => w.includes('no live eBay listings'))).toBe(true)
    expect(mockCallTradingApi).not.toHaveBeenCalled()
  })
})
