import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Lane C — the Product media pop-up's save (docs/product-media-popup/PLAN-2026-09-28.md §4.2). The pop-up keeps a draft
 * and Enter sends ONE `replace` (or `follow`) bound by `expect` to what the layer held when the pop-up opened. Proven here
 * with the real schema, tenant policies and plan logic: a stale `expect` is refused and writes nothing, and two pop-ups
 * saving the same set at the same moment give ONE winner — never a silent overwrite. On PGlite (one connection) the two
 * saves run one after the other; scripts/run-real-postgres-tests.mjs runs this file on PostgreSQL 17, where they race.
 */
const state = vi.hoisted(() => ({ db: null as any, events: [] as Array<{ type: string; productId: string; layer: string }>, failNextEvent: false }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: { type: string; productId: string; layer: string }) => {
  if (state.failNextEvent) { state.failNextEvent = false; throw new Error('the event bus is down') }
  state.events.push(event)
} }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: async () => undefined } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyMediaPlanOps } from './media-plan.service.js'
import { readProductMedia, saveProductMedia } from './product-media.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const img: Record<string, string> = {}
const SHARED = { layer: 'SHARED' as const }
const sharedSet = async (ref: string) => {
  const row = await scoped(() => prisma.productMediaPlan.findFirst({ where: { productId: ids.root, layer: 'SHARED' }, select: { plan: true } }))
  const sets = (row?.plan as { sets: { common?: Array<{ assetId: string }>; values?: Record<string, Array<{ assetId: string }>> } } | undefined)?.sets
  const items = ref === 'common' ? sets?.common : sets?.values?.[ref.slice('value:'.length)]
  return items?.map(i => i.assetId) ?? null
}

beforeAll(async () => {
  await scoped(async () => {
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', sortOrder: 1 } as never })
    const root = await prisma.product.create({ data: { sku: 'LAB', name: 'Lab jacket', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'] } as never })
    ids.root = root.id
    for (const [key, sku] of [['s', 'LAB-NERO-S'], ['m', 'LAB-NERO-M']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: root.id, categoryAttributes: { variations: { Colore: 'Nero' } } } as never })).id
    for (const name of ['front', 'back', 'side'])
      img[name] = (await prisma.productImage.create({ data: { productId: root.id, url: `https://cdn.example/${name}.jpg`, alt: name, type: 'ALT', width: 1600, height: 1600 } as never })).id
  })
  // A second product NOT on the plan: the older gallery (C2), with its own three photos.
  await scoped(async () => {
    ids.cap = (await prisma.product.create({ data: { sku: 'LAB-CAP', name: 'Lab cap', basePrice: 10 } as never })).id
    for (const name of ['cap-front', 'cap-back', 'cap-side'])
      img[name] = (await prisma.productImage.create({ data: { productId: ids.cap, url: `https://cdn.example/${name}.jpg`, alt: name, type: 'ALT', width: 1600, height: 1600 } as never })).id
  })
  // The family goes onto the plan with one colour set of three photos (the pop-up edits this set).
  await scoped(() => applyMediaPlanOps(ids.s, { address: SHARED, ops: [{ op: 'replace', set: 'value:color:black', assetIds: [img.front, img.back, img.side], expect: null }] }, null))
}, 120_000)
afterAll(async () => { await state.db?.close() })

describe('the pop-up\'s one save', () => {
  it('lands when the set is still what the pop-up opened with, and is refused (writing nothing) when it is not', async () => {
    const opened = await sharedSet('value:color:black')
    expect(opened).toEqual([img.front, img.back, img.side])
    await scoped(() => applyMediaPlanOps(ids.m, { address: SHARED, ops: [{ op: 'replace', set: 'value:color:black', assetIds: [img.back, img.front, img.side], expect: opened }] }, null))
    expect(await sharedSet('value:color:black')).toEqual([img.back, img.front, img.side])
    // A second pop-up that opened before that save still holds the old order: refused, nothing written.
    await expect(scoped(() => applyMediaPlanOps(ids.s, { address: SHARED, ops: [{ op: 'replace', set: 'value:color:black', assetIds: [img.side], expect: opened }] }, null)))
      .rejects.toThrow(/changed since your edit/)
    expect(await sharedSet('value:color:black')).toEqual([img.back, img.front, img.side])
  })

  it('two pop-ups saving the same set at the same moment: one wins, the other is refused, nothing is overwritten', async () => {
    const opened = await sharedSet('value:color:black')
    const mine = [img.side, img.back, img.front], theirs = [img.front, img.side]
    const results = await Promise.allSettled([
      scoped(() => applyMediaPlanOps(ids.s, { address: SHARED, ops: [{ op: 'replace', set: 'value:color:black', assetIds: mine, expect: opened }] }, null)),
      scoped(() => applyMediaPlanOps(ids.m, { address: SHARED, ops: [{ op: 'replace', set: 'value:color:black', assetIds: theirs, expect: opened }] }, null)),
    ])
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(String(lost[0].reason?.message)).toMatch(/changed since your edit|at the same moment/)
    const winner = results[0].status === 'fulfilled' ? mine : theirs
    expect(await sharedSet('value:color:black')).toEqual(winner)
  })
})

describe('the older gallery\'s one save (C2)', () => {
  const context = { scope: 'MASTER', market: 'GLOBAL', locale: 'it' } as const
  it('two pop-ups saving the same list at the same moment: one wins, the other is refused with the plain sentence', async () => {
    const opened = await scoped(() => readProductMedia({ ...context, productId: ids.cap }))
    const mine = [img['cap-side'], img['cap-front']], theirs = [img['cap-back']]
    const body = (items: string[]) => ({ expectedRevision: opened.revision, collection: { version: 1, items: items.map(assetId => ({ assetId })) } })
    const results = await Promise.allSettled([
      scoped(() => saveProductMedia({ ...context, productId: ids.cap }, body(mine))),
      scoped(() => saveProductMedia({ ...context, productId: ids.cap }, body(theirs))),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(lost).toHaveLength(1)
    expect(String(lost[0].reason?.message)).toMatch(/Media changed (since this editor opened|while saving)/)
    const now = await scoped(() => readProductMedia({ ...context, productId: ids.cap }))
    expect(now.collection.items.map(i => i.assetId)).toEqual(results[0].status === 'fulfilled' ? mine : theirs)
  })
})

describe('real time for the older gallery (C3, Owner D2 = a)', () => {
  const context = { scope: 'MASTER', market: 'GLOBAL', locale: 'it' } as const
  it('a save tells every open screen (the family root, layer GALLERY); a refused save tells nobody; a variant\'s save names its parent; an event that cannot be sent never fails the save', async () => {
    const opened = await scoped(() => readProductMedia({ ...context, productId: ids.cap }))
    state.events.length = 0
    await scoped(() => saveProductMedia({ ...context, productId: ids.cap }, { expectedRevision: opened.revision, collection: { version: 1, items: [{ assetId: img['cap-front'] }] } }))
    expect(state.events).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: ids.cap, layer: 'GALLERY' })])
    state.events.length = 0
    await expect(scoped(() => saveProductMedia({ ...context, productId: ids.cap }, { expectedRevision: opened.revision, collection: { version: 1, items: [] } })))
      .rejects.toThrow(/Media changed since this editor opened/)
    expect(state.events).toEqual([])
    // A variant's own list names its PARENT: every open screen of the family listens on the family root.
    const variant = (await scoped(() => prisma.product.create({ data: { sku: 'LAB-CAP-RED', name: 'Lab cap red', basePrice: 10, parentId: ids.cap } as never }))).id
    const read = await scoped(() => readProductMedia({ ...context, productId: variant }))
    expect(read.assets.length).toBeGreaterThan(0)
    await scoped(() => saveProductMedia({ ...context, productId: variant }, { expectedRevision: read.revision, collection: { version: 1, items: [{ assetId: read.assets[0].id }] } }))
    expect(state.events).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: ids.cap, layer: 'GALLERY' })])
    // The event cannot be sent: the save is committed, so it still answers the saved list — never "not saved".
    const now = await scoped(() => readProductMedia({ ...context, productId: variant }))
    state.failNextEvent = true
    const saved = await scoped(() => saveProductMedia({ ...context, productId: variant }, { expectedRevision: now.revision, collection: { version: 1, items: [] } }))
    expect(saved.collection.items).toEqual([])
    expect((await scoped(() => readProductMedia({ ...context, productId: variant }))).revision).toBe(saved.revision)
  })
})
