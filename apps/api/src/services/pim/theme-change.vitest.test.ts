/**
 * VT.4 — the dry-run theme-change plan.
 *
 * Four properties are worth a test here; the rest is typing.
 *
 * 1. **plan payload ≡ live payload.** VX §8's own words: "A test pins preview payload ≡ live payload … and the
 *    test fails if a second composer appears." Each channel's arm calls the publish path's OWN composer with
 *    the plan's inputs and asserts byte equality with what the plan carries. If someone re-implements an
 *    envelope inside `theme-change.service.ts`, these three fail.
 * 2. **Zero provider calls, with a positive control in the same run.** `fetch`, `http.request` and
 *    `https.request` are replaced by COUNTING throwers before the service is imported
 *    (`reference_node_probe_pure_modules`: stub before the import). Building all three plans must leave the
 *    counter at 0 — and then the control arm calls out deliberately and the counter must move, so a 0 that
 *    came from a broken instrument cannot pass as a 0 that came from the code.
 * 3. **`dryRun` may only be `true`,** and a `kind` that contradicts the coordinate is refused by name.
 * 4. **The two collision computations agree.** `collisionsFor` (the sheet cell's) and `collisionReportFor`
 *    (the PATCH refusal's and now the projection read's) are two readers of one rule — the shape
 *    `reference_two_column_builders_drift` names. One test pins them equal on the same family.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

/* ── the network instrument, armed BEFORE any import of the service ─────────────────────────── */
const net = { calls: 0, targets: [] as string[] }
function armNetwork() {
  const boom = (what: string) => (...args: unknown[]) => {
    net.calls += 1
    net.targets.push(`${what}:${String(args[0]).slice(0, 80)}`)
    throw new Error(`VT.4 test: a provider call escaped (${what})`)
  }
  ;(globalThis as { fetch?: unknown }).fetch = boom('fetch')
  return boom
}
const boom = armNetwork()
vi.mock('node:http', () => ({ request: boom('http.request'), get: boom('http.get'), default: { request: boom('http.request') } }))
vi.mock('node:https', () => ({ request: boom('https.request'), get: boom('https.get'), default: { request: boom('https.request') } }))

/* ── prisma, narrowed to what the plan reads ────────────────────────────────────────────────── */
const { findMany, findUnique, categoryFindFirst, marketplaceFindFirst } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  categoryFindFirst: vi.fn(),
  marketplaceFindFirst: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    product: { findMany, findUnique },
    categorySchema: { findFirst: categoryFindFirst },
    marketplace: { findFirst: marketplaceFindFirst },
    channelListing: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  },
}))

/* ── the projection read, stubbed; every other export of that module stays real ──────────────── */
const { getProjectionRead } = vi.hoisted(() => ({ getProjectionRead: vi.fn() }))
vi.mock('./family-projection.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./family-projection.service.js')>()
  return { ...actual, getProjectionRead }
})

import { AmazonPublishAdapter } from '../listing-wizard/amazon-publish.adapter.js'
import { buildShopifyProductOptions } from '../shopify/content-publisher.js'
import { buildVariesBySpecifications, resolveVariationAxes } from '../ebay-variation-push.service.js'
import { buildThemeChangePlan, nextParentSku, PLAN_COPY } from './theme-change.service.js'
import { collisionReportFor, type ProjectionRead } from './family-projection.service.js'
import { collisionsFor, type VariationThemeCell } from './variation-rules.service.js'

/* ── the fixture: VX-TEST-3AX as it exists on the local Docker DB (measured 2026-09-13) ───────── */

const CHILDREN: Array<{ sku: string; axes: Record<string, string> }> = [
  { sku: 'VX-TEST-3AX-1', axes: { Taglia: 'M', Colore: 'Nero', 'Fit Type': 'Slim' } },
  { sku: 'VX-TEST-3AX-2', axes: { Taglia: 'M', Colore: 'Nero', 'Fit Type': 'Regular' } },
  { sku: 'VX-TEST-3AX-3', axes: { Taglia: 'L', Colore: 'Nero', 'Fit Type': 'Slim' } },
  { sku: 'VX-TEST-3AX-4', axes: { Taglia: 'L', Colore: 'Nero', 'Fit Type': 'Regular' } },
]

function readFor(channel: string, market: string, mapping: Array<[string, string | null]>, opts: {
  version?: number
  theme?: string | null
  externalId?: string | null
  locked?: boolean
} = {}): ProjectionRead {
  const axes = ['Taglia', 'Colore', 'Fit Type']
  return {
    version: opts.version ?? 3,
    coordinate: {
      channel, market, accountId: null, aliasKey: '',
      label: `${channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : 'Shopify'} · ${market}`,
      channelLabel: channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : 'Shopify',
      accountLabel: null,
    },
    vocabulary: { axisNoun: 'theme', axisNounPlural: 'themes', sectionTitle: 'Variation theme' } as never,
    limits: { axes: channel === 'SHOPIFY' ? 3 : 5, variants: null, source: { axes: 'test', variants: 'test' } } as never,
    mapping: mapping.map(([axisKey, target], order) => ({ axisKey, axisLabel: axisKey, target, order })),
    axisColumns: {},
    axes: axes.map((key) => ({
      key, label: key,
      valueOrder: { codes: [], from: null },
      values: [...new Set(CHILDREN.map((c) => c.axes[key]))].map((code) => ({ code, label: code, count: CHILDREN.filter((c) => c.axes[key] === code).length, suspectRows: 0 })),
      hasSuspectRows: false,
    })),
    targetOptions: [],
    targetOptionsState: 'ok',
    schemaMissing: [],
    freeform: channel === 'SHOPIFY',
    affectsAllMarkets: channel === 'EBAY',
    theme: channel === 'AMAZON' ? { value: opts.theme ?? null, options: [] } : null,
    order: { axes: [], valueOrder: {}, editorUrl: '', writableHere: false, reason: '' },
    split: { mode: 'single', listings: [{ aliasKey: '', label: 'Primary listing', count: 4 }], creatable: false, heldReason: 'held' },
    locked: opts.locked ? { reason: 'live', lockedAxisKeys: [] } : null,
    collisions: null,
    parent: {
      id: 'p-root', sku: 'VX-TEST-3AX', name: null, image: null, listings: 1,
      readiness: null, completeness: null,
      listing: { state: 'draft', externalId: opts.externalId ?? null, listingId: 'l-parent', reason: '' },
    },
    children: CHILDREN.map((c, i) => ({
      id: `c${i + 1}`, sku: c.sku, name: null, image: null, imageInherited: false,
      included: true, sharedAxisValues: c.axes, axisValuesSuspect: [],
      readiness: null, completeness: null, values: {},
      listing: { state: 'draft', externalId: null, listingId: `l${i + 1}`, reason: '' },
    })),
    counts: { rows: 5, includedChildren: 4, pinnedCells: 0, pinnedRows: 0, mappingErrorRows: 0 },
    meta: { tookMs: 1, phases: {} },
  } as unknown as ProjectionRead
}

/** The SUIT·IT properties the plan's binding runs against (the real cached shape, trimmed). */
const SUIT_PROPERTIES = {
  color: { title: 'Colore' },
  fit_type: { title: 'Tipo di forma' },
  style: { title: 'Stile' },
}

beforeEach(() => {
  net.calls = 0
  net.targets = []
  findMany.mockReset()
  findUnique.mockReset()
  categoryFindFirst.mockReset()
  marketplaceFindFirst.mockReset()
  getProjectionRead.mockReset()
  // The MEASURED local rows: `Marketplace(AMAZON, IT).marketplaceId = APJ6JRA9NG5V4`, `DE = A1PA6795UKMFR9`.
  marketplaceFindFirst.mockImplementation(async ({ where }: { where: { code: string } }) =>
    ({ IT: { marketplaceId: 'APJ6JRA9NG5V4' }, DE: { marketplaceId: 'A1PA6795UKMFR9' } } as Record<string, { marketplaceId: string }>)[where.code] ?? null)
  findMany.mockResolvedValue([])
  findUnique.mockResolvedValue({ productType: 'SUIT' })
  // 🔴 Keyed by the market CODE, exactly as the 174 local AMAZON rows are. The adapter asks by SP-API id, so
  // this stub answers `null` there — which is the live behaviour VT.4 measured and reports as a P0 to VT.1.
  categoryFindFirst.mockImplementation(async ({ where }: { where: { marketplace: string } }) =>
    (where.marketplace === 'IT' || where.marketplace === 'DE')
      ? { schemaDefinition: { properties: { ...SUIT_PROPERTIES, variation_theme: { items: { properties: { name: { enum: ['COLOR/SIZE'] } } } } } }, fetchedAt: new Date('2026-09-12T14:52:54.095Z') }
      : null)
})

describe('VT.4 — the theme-change plan is built from the publish path’s own composers', () => {
  it('amazon-new-parent: step 2 carries AmazonPublishAdapter#buildChildAttributes byte-for-byte', async () => {
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'IT', [['Taglia', 'size'], ['Colore', 'color']], { theme: 'SIZE/COLOR' }))
    const plan = await buildThemeChangePlan({
      productId: 'p-root', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: true,
      theme: 'COLOR/SIZE',
      mapping: [{ axisKey: 'Colore', target: 'color', order: 0 }, { axisKey: 'Taglia', target: 'size', order: 1 }],
    })
    expect(plan.kind).toBe('amazon-new-parent')

    // THE ≡ PIN. Same function, same arguments, on the publish path's own object.
    const live = new AmazonPublishAdapter().buildChildAttributes({
      parentSku: 'VX-TEST-3AX-P2',
      marketplaceId: 'APJ6JRA9NG5V4',
      variationTheme: 'COLOR/SIZE',
      variationAttributes: CHILDREN[0].axes,
      variationMapping: { Colore: 'color', Taglia: 'size' },
      // null, because that is what the adapter's OWN lookup key returns on this catalogue — see the
      // `categoryFindFirst` stub. The ≡ claim is about the COMPOSER; the argument divergence is a separate,
      // reported defect and this test would go green either way only if both sides use the same arguments.
      schemaProperties: null,
      price: null,
      quantity: null,
    })
    const step2 = plan.steps.find((s) => s.n === 2)!
    expect(step2.payload).toEqual(live.attributes)
    // …and the pin is not vacuous: the payload really does carry the theme and the relink.
    expect(step2.payload).toMatchObject({
      variation_theme: [{ marketplace_id: 'APJ6JRA9NG5V4', name: 'COLOR/SIZE' }],
      child_parent_sku_relationship: [{ child_relationship_type: 'variation', parent_sku: 'VX-TEST-3AX-P2' }],
    })
  })

  it('ebay-relist: the specifics are buildVariesBySpecifications(resolveVariationAxes(...)) verbatim', async () => {
    getProjectionRead.mockResolvedValue(readFor('EBAY', 'IT', [['Taglia', 'Taglia'], ['Colore', 'Colore'], ['Fit Type', 'Fit Type']]))
    const plan = await buildThemeChangePlan({
      productId: 'p-root', channel: 'EBAY', market: 'IT', expectedVersion: 3, dryRun: true,
      mapping: [{ axisKey: 'Taglia', target: 'Taglia', order: 0 }, { axisKey: 'Colore', target: 'Colore', order: 1 }],
    })
    expect(plan.kind).toBe('ebay-relist')

    const rows = CHILDREN.map((c) => ({ sku: c.sku, aspect_Taglia: c.axes.Taglia, aspect_Colore: c.axes.Colore }))
    const live = buildVariesBySpecifications(
      resolveVariationAxes(rows, ['Taglia', 'Colore'], { storedAxisOrder: ['Taglia', 'Colore'] }).validSpecs,
      {},
      rows.map((r) => r.sku),
    )
    const relist = plan.steps.find((s) => s.verb === 'RELIST')!
    expect(relist.payload).toEqual({ variesBy: { specifications: live } })
    // Not vacuous: Taglia really varies (M, L) and so the spec list is not the Custom Bundle fallback.
    expect(live.map((s) => s.name)).toContain('Taglia')
    expect(live.every((s) => s.name !== 'Custom Bundle')).toBe(true)
  })

  it('shopify-in-place: the option list is buildShopifyProductOptions, the same expression productSet sends', async () => {
    getProjectionRead.mockResolvedValue(readFor('SHOPIFY', 'GLOBAL', [['Taglia', 'Size'], ['Colore', 'Color'], ['Fit Type', null]]))
    const plan = await buildThemeChangePlan({
      productId: 'p-root', channel: 'SHOPIFY', market: 'GLOBAL', expectedVersion: 3, dryRun: true,
      mapping: [
        { axisKey: 'Taglia', target: 'Size', order: 0 },
        { axisKey: 'Colore', target: 'Color', order: 1 },
        { axisKey: 'Fit Type', target: 'Fit', order: 2 },
      ],
    })
    expect(plan.kind).toBe('shopify-in-place')

    const live = buildShopifyProductOptions(['Size', 'Color', 'Fit'], CHILDREN.map((c) => ({
      options: { Size: c.axes.Taglia, Color: c.axes.Colore, Fit: c.axes['Fit Type'] },
    })))
    const created = plan.steps.find((s) => s.verb === 'productOptionsCreate' && s.target === 'Fit')!
    expect(created.payload).toEqual(live.find((o) => o.name === 'Fit'))
    expect(live.find((o) => o.name === 'Fit')!.values.map((v) => v.name)).toEqual(['Slim', 'Regular'])
    // The three mutations are NAMED, never silently composed — and the plan says so out loud.
    expect(plan.warnings.join(' ')).toContain('not implemented in this codebase')
  })
})

describe('VT.4 — zero provider calls, with a positive control in the same run', () => {
  it('builds all three plans with the network counter at 0, then the control fires', async () => {
    for (const [channel, market, body] of [
      ['AMAZON', 'IT', { theme: 'COLOR/SIZE', mapping: [{ axisKey: 'Colore', target: 'color', order: 0 }] }],
      ['EBAY', 'IT', { mapping: [{ axisKey: 'Taglia', target: 'Taglia', order: 0 }] }],
      ['SHOPIFY', 'GLOBAL', { mapping: [{ axisKey: 'Taglia', target: 'Size', order: 0 }] }],
    ] as const) {
      getProjectionRead.mockResolvedValue(readFor(channel, market, [['Taglia', 'x'], ['Colore', 'y'], ['Fit Type', 'z']], { theme: 'SIZE/COLOR' }))
      await buildThemeChangePlan({ productId: 'p-root', channel, market, expectedVersion: 3, dryRun: true, ...body } as never)
    }
    expect(net.calls).toBe(0)
    expect(net.targets).toEqual([])

    // 🔴 POSITIVE CONTROL — the instrument is pointed at something that DOES call out. Without this the 0
    // above could be a stub that was never installed (`reference_could_not_measure_vs_measured_empty`).
    expect(() =>
      (globalThis as { fetch: (u: string) => unknown }).fetch('https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/X'),
    ).toThrow('a provider call escaped')
    expect(net.calls).toBe(1)
    expect(net.targets[0]).toContain('sellingpartnerapi')
  })
})

describe('VT.4 — the refusals', () => {
  it('accepts dryRun: true only', async () => {
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'IT', [['Taglia', 'size']], { theme: 'SIZE' }))
    await expect(buildThemeChangePlan({ productId: 'p', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: false as never }))
      .rejects.toThrow('dryRun must be true')
    // The refusal happens BEFORE any read, so a live executor cannot be reached by any argument.
    expect(getProjectionRead).not.toHaveBeenCalled()
  })

  it('refuses a kind that contradicts the coordinate instead of quietly using the coordinate’s', async () => {
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'IT', [['Taglia', 'size']], { theme: 'SIZE' }))
    await expect(buildThemeChangePlan({ productId: 'p', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: true, kind: 'ebay-relist', theme: 'COLOR/SIZE' }))
      .rejects.toThrow('asked for "ebay-relist"')
  })

  it('409s on a stale version and carries the fresh read', async () => {
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'IT', [['Taglia', 'size']], { version: 7, theme: 'SIZE' }))
    await expect(buildThemeChangePlan({ productId: 'p', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: true, theme: 'COLOR/SIZE' }))
      .rejects.toMatchObject({ code: 'version_conflict', statusCode: 409 })
  })

  it('refuses an eBay plan when the SET did not change — that is a revise, not a relist (VX §9)', async () => {
    getProjectionRead.mockResolvedValue(readFor('EBAY', 'IT', [['Taglia', 'Taglia'], ['Colore', 'Colore']]))
    await expect(buildThemeChangePlan({
      productId: 'p', channel: 'EBAY', market: 'IT', expectedVersion: 3, dryRun: true,
      // The same two names in the other order.
      mapping: [{ axisKey: 'Colore', target: 'Colore', order: 0 }, { axisKey: 'Taglia', target: 'Taglia', order: 1 }],
    })).rejects.toThrow('is a revise — not a relist')
  })

  it('refuses an Amazon plan with no target theme, and one that is already current', async () => {
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'IT', [['Taglia', 'size']], { theme: 'SIZE/COLOR' }))
    await expect(buildThemeChangePlan({ productId: 'p', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: true }))
      .rejects.toThrow('needs the theme it changes TO')
    await expect(buildThemeChangePlan({ productId: 'p', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: true, theme: 'SIZE/COLOR' }))
      .rejects.toThrow('already carries SIZE/COLOR')
  })

  it('names a channel with no theme-change operation rather than inventing one', async () => {
    getProjectionRead.mockResolvedValue(readFor('ETSY', 'GLOBAL', [['Taglia', 'x']]))
    await expect(buildThemeChangePlan({ productId: 'p', channel: 'ETSY', market: 'GLOBAL', expectedVersion: 3, dryRun: true }))
      .rejects.toThrow('has no theme-change operation in this programme')
  })
})

describe('VT.4 — the new parent SKU', () => {
  it('is -P2 on a family that has never been re-themed', async () => {
    findMany.mockResolvedValue([])
    expect(await nextParentSku('VX-TEST-3AX')).toBe('VX-TEST-3AX-P2')
  })

  it('skips every taken suffix instead of counting', async () => {
    findMany.mockResolvedValue([{ sku: 'VX-TEST-3AX-P2' }, { sku: 'VX-TEST-3AX-P3' }, { sku: 'VX-TEST-3AX-P9' }])
    expect(await nextParentSku('VX-TEST-3AX')).toBe('VX-TEST-3AX-P4')
  })
})

describe('VT.4 — the plan’s copy is the canvas’s', () => {
  it('titles, banner, keeps and loses come from the approved copy table', async () => {
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'DE', [['Taglia', 'size'], ['Colore', 'color']], { theme: 'SIZE/COLOR', externalId: 'B0F7J163XJ' }))
    const plan = await buildThemeChangePlan({
      productId: 'p-root', channel: 'AMAZON', market: 'DE', expectedVersion: 3, dryRun: true, theme: 'COLOR/SIZE',
      mapping: [{ axisKey: 'Colore', target: 'color', order: 0 }, { axisKey: 'Taglia', target: 'size', order: 1 }],
    })
    expect(plan.title).toBe('Change variation theme · Amazon · DE')
    expect(plan.subline).toBe('VX-TEST-3AX · 4 children · SIZE/COLOR → COLOR/SIZE')
    expect(plan.banner).toBe(PLAN_COPY.amazonBanner)
    expect(plan.steps.map((s) => s.verb)).toEqual(['PUT', 'PATCH ×4', 'WAIT 8 s', 'DELETE'])
    expect(plan.steps.map((s) => s.reversible)).toEqual([true, true, null, false])
    expect(plan.steps[3].target).toBe('VX-TEST-3AX (B0F7J163XJ)')
    expect(plan.keeps).toEqual([
      'child ASINs, reviews and sales history',
      'offers, prices, FBA stock',
      'the Nexus product and its children',
    ])
    expect(plan.loses[0]).toBe('the parent ASIN B0F7J163XJ and its URL')
    expect(plan.dryRun).toBe(true)
    expect(plan.meta.providerCalls).toBe(0)
  })

  it('warns that the LIVE run would be refused when a segment binds to nothing', async () => {
    // SUIT·IT declares no `size` attribute at all (VT.1's measurement). The adapter refuses; the plan says so.
    categoryFindFirst.mockResolvedValue({ schemaDefinition: { properties: { color: { title: 'Colore' } } }, fetchedAt: null })
    getProjectionRead.mockResolvedValue(readFor('AMAZON', 'IT', [['Taglia', null], ['Colore', 'color']], { theme: 'COLOR' }))
    const plan = await buildThemeChangePlan({
      productId: 'p-root', channel: 'AMAZON', market: 'IT', expectedVersion: 3, dryRun: true, theme: 'COLOR/SIZE',
      mapping: [{ axisKey: 'Colore', target: 'color', order: 0 }],
    })
    // `Taglia` and `Fit Type` are on the child but bind to nothing on this trimmed schema.
    expect(plan.warnings.join(' ')).toContain('would be REFUSED before the first parent or child PUT')
    expect(plan.warnings.join(' ')).toContain('SIZE (theme segment SIZE)')
  })
})

describe('VT.4 — one collision rule, two readers, proven equal', () => {
  /**
   * `collisionsFor` reads the SHEET's facts; `collisionReportFor` reads the PROJECTION. They must not disagree:
   * the cell's `n collisions` tag, the dock's summary and the PATCH's refusal all quote one of the two.
   */
  const cellFor = (dropped: string[]): VariationThemeCell => ({
    axes: ['Taglia', 'Colore', 'Fit Type'].map((familyKey) => ({
      axisKey: familyKey.toLowerCase().replace(' ', ''), familyKey, label: familyKey, channelName: familyKey,
      target: familyKey, included: !dropped.includes(familyKey),
    })),
    theme: null,
    source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
    candidates: null, masterCandidates: null,
    dropped: dropped.map((d) => d.toLowerCase().replace(' ', '')),
    collisions: null, locked: null, write: null, writable: false, writeBlockedReason: null,
    vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
    separator: ' · ',
  }) as unknown as VariationThemeCell

  for (const dropped of [['Fit Type'], ['Taglia'], ['Colore'], ['Taglia', 'Fit Type']]) {
    it(`agrees on VX-TEST-3AX with ${dropped.join(' + ')} dropped`, () => {
      const survivors: Array<[string, string | null]> = (['Taglia', 'Colore', 'Fit Type'] as const)
        .map((k) => [k, dropped.includes(k) ? null : k])
      const read = readFor('EBAY', 'IT', survivors)
      const fromProjection = collisionReportFor(read, survivors.filter(([, t]) => t).map(([k]) => k))
      const fromSheet = collisionsFor(cellFor(dropped), {
        coordinate: { channel: 'EBAY', market: 'IT', accountId: null, aliasKey: '', label: 'eBay · IT' },
        family: {
          variants: CHILDREN.map((c, i) => ({ id: `c${i + 1}`, sku: c.sku, included: true, axisValues: c.axes })),
        },
      } as never)
      expect(fromProjection).not.toBeNull()
      expect(fromSheet).not.toBeNull()
      expect(fromProjection!.unresolved).toBe(fromSheet!.unresolved)
      expect(fromProjection!.summary).toBe(fromSheet!.summary)
    })
  }

  it('reports the measured numbers the matrix is checked against', () => {
    const drop = (dropped: string[]) => {
      const survivors: Array<[string, string | null]> = (['Taglia', 'Colore', 'Fit Type'] as const)
        .map((k) => [k, dropped.includes(k) ? null : k])
      return collisionReportFor(readFor('EBAY', 'IT', survivors), survivors.filter(([, t]) => t).map(([k]) => k))
    }
    // Colore is 'Nero' on all four, so dropping it loses nothing: the measured ZERO, and the negative control.
    expect(drop(['Colore'])!.unresolved).toBe(0)
    expect(drop(['Colore'])!.groups).toEqual([])
    // Taglia and Fit Type each tell two pairs apart: dropping either collides 4 variants in 2 groups.
    for (const axis of ['Taglia', 'Fit Type']) {
      const report = drop([axis])!
      expect(report.unresolved).toBe(4)
      expect(report.groups).toHaveLength(2)
      expect(report.groups.every((g) => g.members.length === 2)).toBe(true)
    }
    // Dropping both leaves only Colore: all four collapse into ONE group.
    const both = drop(['Taglia', 'Fit Type'])!
    expect(both.unresolved).toBe(4)
    expect(both.groups).toHaveLength(1)
    // split is held (aliases); exclude always can run.
    expect(both.resolvers.find((r) => r.kind === 'split')).toMatchObject({ available: false })
    expect(both.resolvers.find((r) => r.kind === 'exclude')).toMatchObject({ available: true, reason: null })
    /**
     * 🔴 UPDATED by VT.4b, and the change is the POINT. VT.4 reported that `fold` answered `available: true`
     * whenever any axis survived, while the write it performs is a PIN on the child's axis cell — and on both
     * of this fixture's coordinates every `values[axis].write` is `null` with the server's own reason. VT.1b
     * closed it (`foldAvailability`), so the rule is now "a surviving axis AND a writable target cell", and
     * this arm pins the NEW behaviour: the fixture's children carry no axis cells, so fold is unavailable and
     * NAMES why on the cell rather than on the axis.
     */
    const fold = both.resolvers.find((r) => r.kind === 'fold')!
    expect(fold.available).toBe(false)
    expect(fold.reason).toContain('Folding writes a value on each variant’s')
    expect(fold.reason).toContain('cell')
  })
})
