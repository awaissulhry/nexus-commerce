/**
 * Listing readiness, family view (rebuild 2026-10-23) — end to end on a real PostgreSQL (PGlite): the light pass, the
 * SQL problem aggregate (GROUPING SETS over `missing[]`), search, the state tile, the not-computed fill, members and
 * the Fix window. Ids invented. `NEXUS_READINESS_PERF=1` also times a business of production size (~11,300 rows).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { NOT_CHECKED_MESSAGE, readinessDetail, readinessFamilies, readinessFamilyMembers, studioHref } from './listing-readiness-families.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const key = (c: (string | null)[]) => JSON.stringify(c)
const SHARED = [null, null, null, null], AMAZON_IT = ['AMAZON', 'IT', 'lf-a1', null], AMAZON_IT_2 = ['AMAZON', 'IT', 'lf-a2', null]
const computedAt = new Date('2026-10-23T08:00:00Z')
const index = (productId: string, c: (string | null)[], language: string, s: string, missing: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language,
  label: c[0] ? `Amazon · IT${c[2] === 'lf-a2' ? ' · Gale' : ' · Xavia'}` : 'Shared product', pct: null, state: s, requiredFilled: 0, requiredTotal: 0,
  missing, note: null, computedAt, ...extra,
})

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'lf-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'seller-xavia' } as never })
  await prisma.channelConnection.create({ data: { id: 'lf-a2', channelType: 'AMAZON', isActive: true, displayName: 'Gale', externalAccountId: 'seller-gale' } as never })
  await prisma.product.create({ data: { id: 'lf-root', sku: 'STORM', name: 'Storm Parka', basePrice: 10, isParent: true, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'lf-v1', sku: 'STORM-M', name: 'Variant M', basePrice: 10, parentId: 'lf-root', status: 'DRAFT', ean: '8001234567890' } })
  await prisma.product.create({ data: { id: 'lf-v2', sku: 'STORM-L', name: 'Variant L', basePrice: 10, parentId: 'lf-root', status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'lf-solo', sku: 'SOLO', name: 'Alpha gloves', basePrice: 10, status: 'DRAFT' } })
  await prisma.productReadCache.create({ data: { id: 'lf-root', sku: 'STORM', name: 'Storm Parka', status: 'DRAFT', imageUrl: 'https://img.test/storm.jpg', photoCount: 4,
    syncChannels: [], channelKeys: [], rollupChannelKeys: [], categoryIds: [], createdAt: computedAt, updatedAt: computedAt } as never })
  await prisma.readinessIndex.createMany({ data: [
    index('lf-v1', SHARED, 'de', 'warn', [{ productId: 'lf-v1', field: 'item_name', label: 'Title', reason: 'de content is missing; showing it fallback.', kind: 'language-fallback' }]),
    ...['lf-root', 'lf-v1', 'lf-v2', 'lf-solo'].flatMap(id => ['it', 'de'].map(language => index(id, SHARED, language, 'ready'))),
    index('lf-root', AMAZON_IT, 'it', 'ready'),
    index('lf-v1', AMAZON_IT, 'it', 'blocked', [
      { productId: 'lf-v1', field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true, requiredBy: ['Amazon · IT'] },
      { productId: 'lf-v1', field: 'size', label: 'Size', reason: 'Two variants arrive the same', kind: 'collision' },
    ]),
    index('lf-solo', AMAZON_IT_2, 'it', 'absent', [], { note: 'Category metadata is incomplete: GLOVES' }),
  ].filter((row, i, all) => all.findIndex(o => o.productId === row.productId && o.coordinateKey === row.coordinateKey && o.language === row.language) === i) })
}), 120_000)
afterAll(async () => { await state.db?.close() })

it('one row per family, worst first; tiles count folded listings; chips name the stores that share a market', async () => {
  const page = await scoped(() => readinessFamilies({}, null))
  expect(page.destinations.map(d => d.label)).toEqual(['Shared', 'Amazon IT · Gale', 'Amazon IT · Xavia'])
  expect(page.rows.map(r => r.id)).toEqual(['lf-root', 'lf-solo'])
  // 4 Shared + root/v1 Amazon IT + v2 not computed there + solo's absent Amazon IT (its only family member) = 8.
  expect(page.stats).toEqual({ blocked: 1, warn: 1, notComputed: 1, absent: 1, ready: 4, all: 8 })
  expect(page).toMatchObject({ total: 2, listingCount: 8, productCount: 4, page: 1, pageSize: 50, pendingCount: 0, computedAt: computedAt.toISOString() })
  const [family, solo] = page.rows
  expect(family).toMatchObject({ sku: 'STORM', name: 'Storm Parka', imageUrl: 'https://img.test/storm.jpg', photoCount: 4, state: 'blocked', isParent: true,
    variantCount: 2, matchingCount: 3, editorHref: '/products/lf-root/edit/studio' })
  expect(family.chips.map(c => [c.destinationKey, c.state, c.issueCount, c.counts])).toEqual([
    [key(SHARED), 'warn', 1, { blocked: 0, warn: 1, notComputed: 0, absent: 0, ready: 2 }],
    [key(AMAZON_IT), 'blocked', 2, { blocked: 1, warn: 0, notComputed: 1, absent: 0, ready: 1 }],
  ])
  expect(family.nextStep).toEqual({ destinationKey: key(AMAZON_IT), field: 'brand', label: 'Brand', message: 'Required and empty', kind: 'required', affected: 1,
    productId: 'lf-v1', locale: 'it', href: studioHref('lf-v1', { channel: 'AMAZON', market: 'IT', accountId: 'lf-a1', aliasId: null }, 'it', 'brand') })
  expect(solo).toMatchObject({ isParent: false, variantCount: 0, imageUrl: null, photoCount: 0, state: 'absent',
    nextStep: { field: null, kind: 'setup', message: 'Category metadata is incomplete: GLOVES', href: '/products/lf-solo/edit/studio?scope=AMAZON&locale=it&tab=errors&market=IT&account=lf-a2' } })
})

it('the state tile filters rows after the fold but never the tiles; Not checked = absent + not computed', async () => {
  const blocked = await scoped(() => readinessFamilies({ state: 'blocked' }, null))
  expect(blocked.rows.map(r => [r.id, r.matchingCount])).toEqual([['lf-root', 1]])
  expect(blocked.stats.all).toBe(8)
  expect((await scoped(() => readinessFamilies({ state: 'notChecked' }, null))).rows.map(r => r.id)).toEqual(['lf-root', 'lf-solo'])
  expect((await scoped(() => readinessFamilies({ state: 'warn', channel: 'AMAZON' }, null))).total).toBe(0)
})

it('search: a variant hit shows that variant; a family hit (the root) brings the family; EAN counts; a selection still narrows', async () => {
  const variant = await scoped(() => readinessFamilies({ q: 'storm-l' }, null))
  expect(variant.rows.map(r => [r.id, r.matchingCount])).toEqual([['lf-root', 1]])
  expect(variant.productCount).toBe(1)
  expect((await scoped(() => readinessFamilies({ q: 'STORM PARKA' }, null))).rows[0].matchingCount).toBe(3)
  expect((await scoped(() => readinessFamilies({ q: '80012345' }, null))).productCount).toBe(1)
  expect((await scoped(() => readinessFamilies({ q: 'nothing like it' }, null))).rows).toEqual([])
  expect((await scoped(() => readinessFamilies({ productIds: 'lf-solo' }, null))).rows.map(r => r.id)).toEqual(['lf-solo'])
})

it('members: the parent listing first, then variants worst first; each with its own chips and next step', async () => {
  const members = await scoped(() => readinessFamilyMembers('lf-root', {}, null))
  expect(members).toMatchObject({ rootId: 'lf-root', shown: 3, total: 3, variantCount: 2 })
  expect(members.rows.map(r => [r.id, r.isParentListing, r.state, r.parentId])).toEqual([['lf-root', true, 'ready', null], ['lf-v1', false, 'blocked', 'lf-root'], ['lf-v2', false, 'notComputed', 'lf-root']])
  expect(members.rows[1].chips.map(c => c.issueCount)).toEqual([1, 2])
  expect(members.rows[2].nextStep).toMatchObject({ destinationKey: key(AMAZON_IT), field: null, message: NOT_CHECKED_MESSAGE, productId: 'lf-v2' })
  expect(members.rows[0].nextStep).toBeNull()
  const second = await scoped(() => readinessFamilyMembers('lf-root', { limit: '1', offset: '1' }, null))
  expect(second.rows.map(r => r.id)).toEqual(['lf-v1'])
  expect((await scoped(() => readinessFamilyMembers('lf-root', { state: 'notChecked' }, null))).rows.map(r => r.id)).toEqual(['lf-v2'])
})

it('the Fix window: one destination, problems most urgent first, the honest not-checked note, the store in its words', async () => {
  const detail = await scoped(() => readinessDetail({ productId: 'lf-root', family: '1', destination: key(AMAZON_IT) }, null))
  expect(detail).toMatchObject({ productId: 'lf-root', family: true, state: 'blocked', counts: { blocked: 1, ready: 1, notComputed: 1 }, pending: false,
    destination: { key: key(AMAZON_IT), label: 'Amazon IT · Xavia', channel: 'AMAZON', marketplace: 'IT', accountId: 'lf-a1' },
    languages: [{ locale: 'it', state: 'blocked' }], notes: [NOT_CHECKED_MESSAGE] })
  expect(detail.problems.map(p => [p.field, p.kind, p.productCount, p.requiredBy])).toEqual([['brand', 'required', 1, ['Amazon · IT']], ['size', 'rule', 1, []]])
  expect(detail.problems[0].href).toBe('/products/lf-v1/edit/studio?scope=AMAZON&locale=it&market=IT&account=lf-a1&rec=primary%3Alf-v1&cell=brand')
  const one = await scoped(() => readinessDetail({ productId: 'lf-v2', family: '0', destination: key(AMAZON_IT) }, null))
  expect(one).toMatchObject({ state: 'notComputed', counts: { notComputed: 1, blocked: 0 }, problems: [] })
  const shared = await scoped(() => readinessDetail({ productId: 'lf-v1', destination: key(SHARED) }, null))
  expect(shared).toMatchObject({ state: 'warn', languages: [{ locale: 'it', state: 'ready' }, { locale: 'de', state: 'warn' }], problems: [{ field: 'item_name', kind: 'translation', languages: ['de'] }] })
  await expect(scoped(() => readinessDetail({ productId: 'missing', destination: key(SHARED) }, null))).rejects.toMatchObject({ statusCode: 404 })
})

it.skipIf(process.env.NEXUS_READINESS_PERF !== '1')('a business of production size answers its first page quickly (timing printed)', async () => {
  const families = 40, variants = 9, coordinates = [SHARED, ...['IT', 'DE', 'FR', 'ES'].map(m => ['AMAZON', m, 'lf-a1', null]), ['EBAY', 'IT', 'lf-e1', null], ['SHOPIFY', 'GLOBAL', 'lf-s1', null], ['ETSY', 'GLOBAL', 'lf-t1', null], ['EBAY', 'IT', 'lf-e1', 'al2']]
  const languages = ['it', 'de', 'fr']
  await scoped(async () => {
    const products = Array.from({ length: families }, (_, f) => [{ id: `pf-${f}`, parentId: null }, ...Array.from({ length: variants }, (_, v) => ({ id: `pf-${f}-${v}`, parentId: `pf-${f}` }))]).flat()
    await prisma.product.createMany({ data: products.map(p => ({ id: p.id, sku: p.id.toUpperCase(), name: `Perf ${p.id}`, basePrice: 10, status: 'DRAFT', isParent: !p.parentId, parentId: p.parentId })) })
    const missing = (id: string) => Array.from({ length: 6 }, (_, i) => ({ productId: id, field: `field_${i}`, label: `Field ${i}`, reason: 'Required and empty — a sentence of ordinary length for the reason', requiredEmpty: true, ...(i % 2 ? { kind: 'language-fallback' } : {}) }))
    const rows = products.flatMap(p => coordinates.flatMap(c => languages.map(language => index(p.id, c, language, (p.id.length + language.length) % 3 ? 'blocked' : 'ready', missing(p.id)))))
    for (let i = 0; i < rows.length; i += 2000) await prisma.readinessIndex.createMany({ data: rows.slice(i, i + 2000) })
    // eslint-disable-next-line no-console
    console.log(`[readiness perf] ${rows.length} index rows for ${products.length} products`)
  })
  for (let run = 0; run < 3; run++) {
    const started = performance.now()
    const page = await scoped(() => readinessFamilies({}, null))
    const took = performance.now() - started
    const opened = performance.now()
    await scoped(() => readinessFamilyMembers('pf-0', {}, null))
    const members = performance.now() - opened
    const fixed = performance.now()
    await scoped(() => readinessDetail({ productId: 'pf-0', family: '1', destination: key(['AMAZON', 'IT', 'lf-a1', null]) }, null))
    // eslint-disable-next-line no-console
    console.log(`[readiness perf] run ${run + 1}: families ${took.toFixed(0)} ms (${page.rows.length} rows, ${page.listingCount} listings), members ${members.toFixed(0)} ms, detail ${(performance.now() - fixed).toFixed(0)} ms`)
    expect(page.rows.length).toBe(Math.min(50, page.total))
  }
}, 300_000)
