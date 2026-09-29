/**
 * Link (PR 4) on an in-process PostgreSQL (PGlite: the generated schema and the production row policies) against a
 * stand-in Shopify store that behaves as the development store did on 2026-09-30: `metafieldsSet` takes at most 25
 * fields and is all or nothing; `compareDigest` null means "must not exist", any other stale digest is STALE_OBJECT; the
 * digest follows the value; a list naming a deleted product is refused as a whole. The family's plan comes from the pure
 * planner; its confirmed colours are rows. No real Shopify call; every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/shopify/colour-products/link.vitest.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { planColourProducts, type ColourPlanFamily } from '@nexus/shared/shopify-colour-products'

const state = vi.hoisted(() => ({ db: null as any, destination: null as any, family: null as any, colours: [] as string[], store: new Map<string, any>(),
  definitions: {} as Record<string, string | null>, calls: [] as Array<{ name: string; variables: any }>, mode: 'live', afterRead: null as null | (() => void), refuseSet: 0, afterSet: {} as Record<number, () => void>,
  validations: {} as Record<string, Array<{ name: string; value: string }>>, accounts: [] as string[], beforeLinkRead: {} as Record<number, () => void> }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../content-workspace.service.js', async importOriginal => ({ ...await importOriginal<any>(), contentDestination: async () => state.destination }))
vi.mock('../admin-client.js', async importOriginal => ({ ...await importOriginal<any>(), shopifyAdmin: async (account: string) => { state.accounts.push(account); return { graphql: async (query: string, variables: any) => shopify(query, variables) } } }))
vi.mock('../../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => state.mode, acquireShopifyPublishToken: async () => ({ ok: true }) }))
vi.mock('./family.js', () => ({ loadColourPlan: async (_rootId: string, options: any = {}) => {
  const family: ColourPlanFamily = { ...state.family, variants: state.family.variants.filter((v: any) => state.colours.includes(v.values.color)), valueOrder: { ...state.family.valueOrder, color: state.colours } }
  return { plan: planColourProducts(family, { splitAxis: 'color', colourNames: options.colourNames }), rootId: family.familyId, sku: 'LV-JACKET' }
} }))

const VALUE = 'custom.variation_value', LIST = 'custom.variation_products'
const gid = (n: number) => `gid://shopify/Product/${n}`
const digest = (value: string) => `d:${value}`
const fieldOf = (id: string, address: string) => state.store.get(id)?.fields[address] ?? null
const valueOf = (id: string, address: string) => fieldOf(id, address)?.value ?? null
const put = (id: string, address: string, value: string, type = address === LIST ? 'list.product_reference' : 'single_line_text_field') => { state.store.get(id).fields[address] = { value, type, compareDigest: digest(value) } }
/** A product deleted in Shopify: gone, and (as Shopify does, T12) removed from every list that named it. */
const remove = (id: string) => { state.store.delete(id); for (const p of state.store.values()) { const f = p.fields[LIST]; if (f && f.value.includes(id)) p.fields[LIST] = { ...f, value: JSON.stringify(JSON.parse(f.value).filter((x: string) => x !== id)), compareDigest: digest(`${f.value}-${id}`) } } }
const mutations = () => state.calls.filter(c => c.name === 'NexusLinkedSet' || c.name === 'NexusLinkedClear')
const setInputs = () => state.calls.filter(c => c.name === 'NexusLinkedSet').map(c => c.variables.metafields.map((f: any) => `${f.ownerId.split('/').pop()}:${f.key}`))

/** The stand-in store: the link read, and the read / set / delete that `applyLinkedBatch` sends. */
function shopify(query: string, variables: any) {
  const name = query.trim().split(/[\s({]/)[1] ?? query
  state.calls.push({ name, variables: structuredClone(variables) })
  const field = (id: string, ns: string, key: string) => fieldOf(id, `${ns}.${key}`)
  if (name === 'NexusColourLinkRead') {
    state.beforeLinkRead[state.calls.filter(c => c.name === name).length]?.()
    const definition = (address: string) => ({ nodes: state.definitions[address] ? [{ id: `def-${address}`, name: address === VALUE ? 'Variation value' : 'Variation products', type: { name: state.definitions[address] }, validations: state.validations[address] ?? [] }] : [] })
    const result = { nodes: variables.ids.map((id: string) => state.store.has(id) ? { id, title: state.store.get(id).title, value: field(id, variables.vns, variables.vkey), list: field(id, variables.lns, variables.lkey) } : null),
      valueDefinition: definition(`${variables.vns}.${variables.vkey}`), listDefinition: definition(`${variables.lns}.${variables.lkey}`) }
    const hook = state.afterRead; state.afterRead = null; hook?.()
    return structuredClone(result)
  }
  if (name === 'NexusLinkedFieldValues') {
    const out: any = {}
    for (let i = 0; variables[`id${i}`]; i++) {
      const id = variables[`id${i}`], f = field(id, variables[`ns${i}`], variables[`key${i}`])
      out[`owner${i}`] = state.store.has(id) ? { id, metafield: f ? { id: 'mf', namespace: variables[`ns${i}`], key: variables[`key${i}`], ...f } : null } : null
    }
    return structuredClone(out)
  }
  if (name === 'NexusLinkedSet') {
    const inputs = variables.metafields as any[]
    if (inputs.length > 25) return { metafieldsSet: { metafields: null, userErrors: [{ field: ['metafields'], message: 'Exceeded the maximum metafields input limit of 25.', code: 'LESS_THAN_OR_EQUAL_TO', elementIndex: null }] } }
    if (state.refuseSet && --state.refuseSet === 0) return { metafieldsSet: { metafields: [], userErrors: [{ field: ['metafields', '0', 'value'], message: 'Refused for the test', code: 'INVALID_VALUE', elementIndex: null }] } }
    const errors = inputs.flatMap((f, i) => {
      if ((field(f.ownerId, f.namespace, f.key)?.compareDigest ?? null) !== f.compareDigest) return [{ field: ['metafields', String(i)], message: 'The resource has been updated since it was loaded.', code: 'STALE_OBJECT', elementIndex: null }]
      const dead = f.type === 'list.product_reference' ? (JSON.parse(f.value) as string[]).find(id => !state.store.has(id)) : undefined
      return dead ? [{ field: ['metafields', String(i), 'value'], message: `Value references non-existent resource ${dead}.`, code: 'INVALID_VALUE', elementIndex: null }] : []
    })
    if (errors.length) return { metafieldsSet: { metafields: [], userErrors: errors } }
    for (const f of inputs) put(f.ownerId, `${f.namespace}.${f.key}`, f.value, f.type)
    state.afterSet[state.calls.filter(c => c.name === 'NexusLinkedSet').length]?.()
    return { metafieldsSet: { metafields: inputs.map(() => ({ id: 'mf' })), userErrors: [] } }
  }
  if (name === 'NexusLinkedClear') {
    for (const f of variables.metafields) delete state.store.get(f.ownerId)?.fields[`${f.namespace}.${f.key}`]
    return { metafieldsDelete: { userErrors: [] } }
  }
  throw new Error(`unexpected Shopify call ${name}`)
}

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { linkColourProducts } from './link.service.js'
import { colourGrouping, DEFAULT_COLOUR_PRODUCT_SETTINGS } from './settings.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const link = () => scoped(() => linkColourProducts(ids.fam, { accountId: 'x' }))
/** 60 colours: `color:c1` … "Colore 1" …, each with two sizes; product N is colour N's Shopify product. */
const COLOURS = Array.from({ length: 60 }, (_, i) => `color:c${i + 1}`)
const N = (key: string) => Number(key.slice('color:c'.length))
const rowsOf = () => scoped(() => prisma.shopifyColourProduct.findMany({ where: { familyId: ids.fam, channelConnectionId: ids.account, aliasKey: '' }, orderBy: { valueKey: 'asc' } }))
const settings = (patch: object) => scoped(() => prisma.channelConnection.update({ where: { id: ids.account }, data: { connectionMetadata: { shopifyColourProducts: { ...DEFAULT_COLOUR_PRODUCT_SETTINGS, enabled: true, ...patch } } } }))

/** The family has these colours, in this order; each is confirmed (LINKED) with its product, named `names[i]` or not named. */
async function family(colours: string[], names: Array<string | null> = colours.map((_, i) => ['Black', 'Yellow', 'Grey'][i] ?? `Colour ${i + 1}`), state_ = 'LINKED') {
  state.colours = colours
  await scoped(() => prisma.shopifyColourProduct.createMany({ data: colours.map((valueKey, i) => ({ familyId: ids.fam, channelConnectionId: ids.account, marketplace: 'GLOBAL', aliasKey: '',
    splitAxis: 'color', valueKey, colourName: names[i], state: state_, shopifyProductId: state_ === 'LINKED' ? gid(N(valueKey)) : null, createdAt: new Date(Date.UTC(2026, 8, 30, 0, 0, i)) })) }))
  for (const key of colours) if (!state.store.has(gid(N(key)))) state.store.set(gid(N(key)), { title: `LV jacket ${N(key)}`, fields: {} })
}

afterAll(async () => { await state.db?.close() })
beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', currency: 'EUR', region: 'GLOBAL', language: 'en', languages: ['en'], isActive: true } })
    ids.account = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'dev', isActive: true, isPrimary: true, externalAccountId: 'shop-1', authStatus: 'connected', managedBy: 'oauth' } as never })).id
    ids.other = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'second', isActive: true, isPrimary: false, externalAccountId: 'shop-2', authStatus: 'connected', managedBy: 'oauth' } as never })).id
    ids.fam = (await prisma.product.create({ data: { sku: 'LV-JACKET', name: 'LV jacket', basePrice: 10, isParent: true } as never })).id
  })
  state.family = {
    familyId: ids.fam, axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
    variants: COLOURS.flatMap(c => ['s', 'm'].map(s => ({ productId: `${c}-${s}`, sku: `LV-${N(c)}-${s}`, values: { color: c, size: `size:${s}` } }))),
    valueOrder: { color: COLOURS, size: ['size:s', 'size:m'] },
    valueLabels: { ...Object.fromEntries(COLOURS.map(c => [c, `Colore ${N(c)}`])), 'size:s': 'S', 'size:m': 'M' }, unmapped: [],
  }
}, 60_000)
beforeEach(async () => {
  Object.assign(state, { store: new Map(), calls: [], mode: 'live', afterRead: null, refuseSet: 0, afterSet: {}, validations: {}, accounts: [], beforeLinkRead: {}, definitions: { [VALUE]: 'single_line_text_field', [LIST]: 'list.product_reference' } })
  state.destination = { familyId: ids.fam, accountId: ids.account, marketplace: 'GLOBAL', aliasKey: '' }
  await scoped(async () => { await prisma.shopifyColourProduct.deleteMany({}); await prisma.channelListing.deleteMany({ where: { channel: 'SHOPIFY' } }) })
  await settings({})
})

const [C1, C2, C3] = COLOURS
const list = (...keys: string[]) => JSON.stringify(keys.map(k => gid(N(k))))

describe('Link — the colour names and the colour lists, written and read back', () => {
  it('first link: 6 fields in one all-or-nothing call, names first, each new field guarded as "must not exist"; then "Linked ✓"', async () => {
    await family([C1, C2, C3])
    const view = await link()
    expect(state.calls.map(c => c.name)).toEqual(['NexusColourLinkRead', 'NexusLinkedFieldValues', 'NexusLinkedSet', 'NexusLinkedFieldValues', 'NexusColourLinkRead'])
    const [set] = mutations()
    expect(set.variables.metafields.map((f: any) => [f.ownerId, `${f.namespace}.${f.key}`, f.value, f.compareDigest])).toEqual([
      [gid(1), VALUE, 'Black', null], [gid(2), VALUE, 'Yellow', null], [gid(3), VALUE, 'Grey', null],
      [gid(1), LIST, list(C1, C2, C3), null], [gid(2), LIST, list(C1, C2, C3), null], [gid(3), LIST, list(C1, C2, C3), null],
    ])
    expect(view.link).toMatchObject({ grouped: true, members: 3, written: 6, cleared: 0, warnings: [] })
    expect((await rowsOf()).map(r => r.linkVerifiedAt?.toISOString())).toEqual(Array(3).fill(view.link.verifiedAt))
    expect(view.colourProducts.map((r: any) => r.linkVerifiedAt)).toEqual(Array(3).fill(view.link.verifiedAt))
  })

  it('a second run with nothing changed writes nothing; a live group that is already right (GALE) is only read', async () => {
    await family([C1, C2, C3])
    await link()
    state.calls = []
    const again = await link()
    expect(mutations()).toEqual([])
    expect(state.calls.map(c => c.name)).toEqual(['NexusColourLinkRead'])
    expect(again.link).toMatchObject({ written: 0, cleared: 0 })
    expect((await rowsOf()).map(r => r.linkVerifiedAt?.toISOString())).toEqual(Array(3).fill(again.link.verifiedAt))
  })

  it('a live list in another order: only the lists are rewritten, over what Shopify held (Nexus owns them)', async () => {
    await family([C1, C2], ['Black', 'Yellow'])
    for (const k of [C1, C2]) { put(gid(N(k)), LIST, list(C2, C1)); put(gid(N(k)), VALUE, N(k) === 1 ? 'Black' : 'Yellow') }
    await link()
    expect(setInputs()).toEqual([['1:variation_products', '2:variation_products']])
    expect(mutations()[0].variables.metafields.map((f: any) => f.compareDigest)).toEqual([digest(list(C2, C1)), digest(list(C2, C1))])
    expect([valueOf(gid(1), LIST), valueOf(gid(2), LIST)]).toEqual([list(C1, C2), list(C1, C2)])
  })

  it('renaming a colour writes its name only (scenario 13); reordering the colours writes every list only (scenario 14)', async () => {
    await family([C1, C2, C3])
    await link()
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C2 }, data: { colourName: 'Jet Black' } }))
    state.calls = []
    await link()
    expect(setInputs()).toEqual([['2:variation_value']])
    expect(valueOf(gid(2), VALUE)).toBe('Jet Black')
    state.colours = [C3, C1, C2]
    state.calls = []
    await link()
    expect(setInputs()).toEqual([['3:variation_products', '1:variation_products', '2:variation_products']])
    expect(valueOf(gid(2), LIST)).toBe(list(C3, C1, C2))
  })

  it('a colour with no name on Shopify gets the Nexus value; a Draft or Archived product stays in the lists (D2 b)', async () => {
    await family([C1, C2], [null, 'Yellow'])
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C2 }, data: { remoteStatus: 'DRAFT' } }))
    await link()
    expect([valueOf(gid(1), VALUE), valueOf(gid(2), VALUE)]).toEqual(['Colore 1', 'Yellow'])
    expect(valueOf(gid(1), LIST)).toBe(list(C1, C2))
  })

  it('a colour the family no longer has stays listed at the end, keeps its name, and gets the same list', async () => {
    await family([C1, C2, C3])
    await link()
    state.colours = [C2, C1]
    state.calls = []
    await link()
    expect(valueOf(gid(3), VALUE)).toBe('Grey')
    expect([1, 2, 3].map(n => valueOf(gid(n), LIST))).toEqual(Array(3).fill(list(C2, C1, C3)))
    expect(setInputs()).toEqual([['2:variation_products', '1:variation_products', '3:variation_products']])
  })
})

describe('Link — one colour, many colours', () => {
  it('one colour: no list and no name written (scenario 20); a list left from a larger group is deleted, the name stays', async () => {
    await family([C1])
    expect((await link()).link).toMatchObject({ grouped: false, members: 1, written: 0, cleared: 0 })
    expect(mutations()).toEqual([])
    put(gid(1), LIST, list(C1, C2)); put(gid(1), VALUE, 'Black')
    state.calls = []
    expect((await link()).link).toMatchObject({ grouped: false, cleared: 1 })
    expect(mutations().map(c => [c.name, c.variables.metafields])).toEqual([['NexusLinkedClear', [{ ownerId: gid(1), namespace: 'custom', key: 'variation_products' }]]])
    expect([valueOf(gid(1), LIST), valueOf(gid(1), VALUE)]).toEqual([null, 'Black'])
  })

  it('a colour that leaves the group (no longer confirmed, no longer in the family) loses its "Linked ✓"; the one left loses its list', async () => {
    await family([C1, C2])
    await link()
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C2 }, data: { state: 'NOT_FOUND' } }))
    state.colours = [C1]
    expect((await link()).link).toMatchObject({ grouped: false, members: 1, cleared: 1 })
    const [one, two] = await rowsOf()
    expect([one.linkVerifiedAt !== null, two.linkVerifiedAt]).toEqual([true, null])
    expect([valueOf(gid(1), LIST), valueOf(gid(1), VALUE)]).toEqual([null, 'Black'])
  })

  it('13 colours: 25 fields then 1 (never 26 in a call), names before lists; the whole group is verified at the end', async () => {
    const thirteen = COLOURS.slice(0, 13)
    await family(thirteen)
    const view = await link()
    const sets = state.calls.filter(c => c.name === 'NexusLinkedSet').map(c => c.variables.metafields)
    expect(sets.map(s => s.length)).toEqual([25, 1])
    expect(sets.flat().slice(0, 13).every((f: any) => f.key === 'variation_value')).toBe(true)
    expect(thirteen.every(k => valueOf(gid(N(k)), LIST) === list(...thirteen))).toBe(true)
    expect(view.link).toMatchObject({ members: 13, written: 26, warnings: [] })
  })

  it('the second call refused after the first wrote: no "Linked ✓", the message says how far it got, and a rerun writes only the rest', async () => {
    const thirteen = COLOURS.slice(0, 13)
    await family(thirteen)
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: {}, data: { linkVerifiedAt: new Date('2026-09-01T00:00:00Z') } }))
    state.refuseSet = 2
    await expect(link()).rejects.toThrow(/^Shopify did not save Variation products on "LV jacket 13" \(Colore 13\): Refused for the test\. The first 25 of 26 fields are written\. Run the link again: it writes only what is still missing\.$/)
    expect((await rowsOf()).map(r => r.linkVerifiedAt)).toEqual(Array(13).fill(null))
    state.calls = []
    await link()
    expect(setInputs()).toEqual([['13:variation_products']])
    expect((await rowsOf()).filter(r => r.linkVerifiedAt !== null)).toHaveLength(13)
  })

  it('another writer changes a colour of the first call while the second runs: the final read of the whole group refuses "Linked ✓"', async () => {
    const thirteen = COLOURS.slice(0, 13)
    await family(thirteen)
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: {}, data: { linkVerifiedAt: new Date('2026-09-01T00:00:00Z') } }))
    state.afterSet[2] = () => put(gid(1), LIST, list(C1))
    await expect(link()).rejects.toThrow('Shopify read back other colour fields for "Colore 1". Run the link again.')
    expect((await rowsOf()).map(r => r.linkVerifiedAt)).toEqual(Array(13).fill(null))
  })

  it('more than 50 colours: linked, with a warning that the theme shows 50 (scenario 25)', async () => {
    await family(COLOURS.slice(0, 51))
    const view = await link()
    expect(view.link.warnings).toEqual(['The theme shows at most 50 colours; this group has 51. The rest are grouped but not shown.'])
    expect(state.calls.filter(c => c.name === 'NexusLinkedSet').map(c => c.variables.metafields.length)).toEqual([25, 25, 25, 25, 2])
  })
})

describe('Link refuses, and names why', () => {
  it('store switch off, Shopify writes off on the server, links in Product family: no Shopify call at all', async () => {
    await family([C1, C2])
    await settings({ enabled: false })
    await expect(link()).rejects.toThrow('Switch on colour products for this Shopify store first. Nothing was changed.')
    await settings({})
    state.mode = 'dry-run'
    await expect(link()).rejects.toThrow('Shopify writes are switched off on this server. Nothing was changed.')
    state.mode = 'live'
    await scoped(() => prisma.channelListing.create({ data: { productId: ids.fam, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', channelConnectionId: ids.account, aliasKey: '',
      platformAttributes: { _nexusLinkedProducts: { version: 1, members: [], relationship: { namespace: 'custom', key: 'variation_products', includeSelf: true }, baselineLinks: [], edits: [] } } } as never }))
    await expect(link()).rejects.toThrow('This family has links in Product family. Remove them there first; then colour products link it. Nothing was changed.')
    expect(state.calls).toEqual([])
    // An empty Product family record (the live GALE has one) does not count as links.
    await scoped(() => prisma.channelListing.updateMany({ where: { productId: ids.fam }, data: { platformAttributes: { _nexusLinkedProducts: { version: 1, members: [], relationship: null, baselineLinks: [], edits: [] } } } }))
    state.calls = []
    await link()
    expect(mutations()).toHaveLength(1)
  })

  it('a colour not confirmed yet: nothing written, so a live list never gets shorter; a planner error refuses the same way', async () => {
    await family([C1], ['Black'])
    await family([C2], ['Yellow'], 'PROPOSED')
    state.colours = [C1, C2]
    put(gid(1), LIST, list(C1, C2))
    await expect(link()).rejects.toThrow('"Colore 2" has no confirmed Shopify product yet. Confirm it first. Nothing was changed.')
    expect(state.calls).toEqual([])
    expect(valueOf(gid(1), LIST)).toBe(list(C1, C2))
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C2 }, data: { state: 'LINKED', shopifyProductId: gid(2), colourName: 'black' } }))
    await expect(link()).rejects.toThrow('"Colore 1", "Colore 2" would all be called "Black" on Shopify. Give each colour its own name. Nothing was changed.')
    expect(state.calls).toEqual([])
  })

  it('a colour product deleted in Shopify: named, nothing written; a "Linked ✓" from before is withdrawn', async () => {
    await family([C1, C2, C3])
    await link()
    remove(gid(2))
    state.calls = []
    await expect(link()).rejects.toThrow('The Shopify product of "Colore 2" no longer exists. Nothing was changed.')
    expect(mutations()).toEqual([])
    expect((await rowsOf()).map(r => r.linkVerifiedAt)).toEqual([null, null, null])
  })

  it('a field changed in Shopify between the read and the write: refused before any write; the next run repairs it', async () => {
    await family([C1, C2])
    state.afterRead = () => put(gid(2), LIST, list(C2))
    await expect(link()).rejects.toThrow(/Shopify changed this field\..* Run the link again: it writes only what is still missing\.$/)
    expect(mutations()).toEqual([])
    await link()
    expect([valueOf(gid(1), LIST), valueOf(gid(2), LIST)]).toEqual([list(C1, C2), list(C1, C2)])
  })

  it('a missing field definition, a definition of another type, or a live value of another type: refused before any write', async () => {
    await family([C1, C2])
    state.definitions[LIST] = null
    await expect(link()).rejects.toThrow('The Shopify store has no product field custom.variation_products (list.product_reference). Create it in Shopify (Settings → Custom data → Products) first. Nothing was changed.')
    state.definitions[LIST] = 'list.collection_reference'
    await expect(link()).rejects.toThrow('The Shopify product field custom.variation_products is list.collection_reference; colour products need list.product_reference. Nothing was changed.')
    state.definitions[LIST] = 'list.product_reference'
    put(gid(1), VALUE, 'Black', 'multi_line_text_field')
    await expect(link()).rejects.toThrow('"LV jacket 1" (Colore 1): Shopify holds custom.variation_value as multi_line_text_field, not single_line_text_field. Nothing was changed.')
    expect(mutations()).toEqual([])
  })
})

describe('Link — per store and alias, and only its own two fields', () => {
  it('another alias and another store of the same family never enter the list, and keep their own "Linked ✓"', async () => {
    await family([C1, C2])
    const at = new Date('2026-09-01T00:00:00Z')
    await scoped(() => prisma.shopifyColourProduct.createMany({ data: [
      { familyId: ids.fam, channelConnectionId: ids.account, marketplace: 'GLOBAL', aliasKey: 'outlet', splitAxis: 'color', valueKey: C3, state: 'LINKED', shopifyProductId: gid(3), linkVerifiedAt: at },
      { familyId: ids.fam, channelConnectionId: ids.other, marketplace: 'GLOBAL', aliasKey: '', splitAxis: 'color', valueKey: C3, state: 'LINKED', shopifyProductId: gid(3), linkVerifiedAt: at },
    ] }))
    await link()
    expect([valueOf(gid(1), LIST), valueOf(gid(2), LIST)]).toEqual([list(C1, C2), list(C1, C2)])
    expect(state.calls.every(c => !JSON.stringify(c.variables).includes(gid(3)))).toBe(true)
    const others = await scoped(() => prisma.shopifyColourProduct.findMany({ where: { valueKey: C3 } }))
    expect(others.map(r => r.linkVerifiedAt?.toISOString())).toEqual([at.toISOString(), at.toISOString()])
    expect(state.accounts).toEqual([ids.account])
  })

  it('the store\'s own grouping fields are used, and nothing but them is ever written', async () => {
    await settings({ valueField: { namespace: 'theme', key: 'colour' }, listField: { namespace: 'theme', key: 'colours' } })
    state.definitions = { 'theme.colour': 'single_line_text_field', 'theme.colours': 'list.product_reference' }
    await family([C1, C2])
    await link()
    expect(mutations().flatMap(c => c.variables.metafields.map((f: any) => `${f.namespace}.${f.key}`))).toEqual(['theme.colour', 'theme.colour', 'theme.colours', 'theme.colours'])
    expect(state.calls.every(c => ['NexusColourLinkRead', 'NexusLinkedFieldValues', 'NexusLinkedSet'].includes(c.name))).toBe(true)
  })
})

describe('Link — review additions', () => {
  it('a list due for deletion that changes in Shopify after the read is not deleted (the delete has no compare-and-set; the pre-read guards it)', async () => {
    await family([C1])
    put(gid(1), LIST, list(C1, C2))
    state.afterRead = () => put(gid(1), LIST, list(C1, C3))
    await expect(link()).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^"LV jacket 1" \(Colore 1\): Shopify changed this field\. .* Run the link again: it writes only what is still missing\.$/) })
    expect(state.calls.some(c => c.name === 'NexusLinkedClear')).toBe(false)
    expect(valueOf(gid(1), LIST)).toBe(list(C1, C3))
    await link()
    expect(valueOf(gid(1), LIST)).toBeNull()
  })

  it('two colours drop to one while the other is still confirmed: it stays listed (U2 a), so nothing is deleted', async () => {
    await family([C1, C2])
    await link()
    state.colours = [C1]
    state.calls = []
    const view = await link()
    expect(view.link).toMatchObject({ grouped: true, members: 2, written: 0, cleared: 0 })
    expect(mutations()).toEqual([])
    expect([valueOf(gid(1), LIST), valueOf(gid(2), LIST), valueOf(gid(2), VALUE)]).toEqual([list(C1, C2), list(C1, C2), 'Yellow'])
    expect((await rowsOf()).map(r => r.linkVerifiedAt?.toISOString())).toEqual([view.link.verifiedAt, view.link.verifiedAt])
  })

  it('a live group of two gets a third colour: one call; new fields guarded "must not exist", live lists by the digest just read; live names untouched', async () => {
    await family([C1, C2, C3])
    for (const k of [C1, C2]) { put(gid(N(k)), VALUE, N(k) === 1 ? 'Black' : 'Yellow'); put(gid(N(k)), LIST, list(C1, C2)) }
    const view = await link()
    expect(mutations()).toHaveLength(1)
    expect(mutations()[0].variables.metafields.map((f: any) => [f.ownerId, `${f.namespace}.${f.key}`, f.compareDigest])).toEqual([
      [gid(3), VALUE, null], [gid(1), LIST, digest(list(C1, C2))], [gid(2), LIST, digest(list(C1, C2))], [gid(3), LIST, null]])
    expect([1, 2, 3].map(n => valueOf(gid(n), LIST))).toEqual(Array(3).fill(list(C1, C2, C3)))
    expect(view.link).toMatchObject({ members: 3, written: 4, cleared: 0 })
  })

  it('a live list naming a product outside the group: our lists are rewritten without it, and it is never read or written', async () => {
    await family([C1, C2])
    state.store.set(gid(99), { title: 'Foreign jacket', fields: {} })
    const foreign = JSON.stringify([gid(1), gid(99), gid(2)])
    for (const n of [1, 2, 99]) put(gid(n), LIST, foreign)
    await link()
    expect([valueOf(gid(1), LIST), valueOf(gid(2), LIST)]).toEqual([list(C1, C2), list(C1, C2)])
    expect(valueOf(gid(99), LIST)).toBe(foreign)
    expect(mutations().flatMap(c => c.variables.metafields.map((f: any) => f.ownerId))).not.toContain(gid(99))
    expect(state.calls.find(c => c.name === 'NexusColourLinkRead')!.variables.ids).toEqual([gid(1), gid(2)])
  })

  it('13 colours: a field of the second call changed after the first call wrote: 409 before that call, says how far it got; the next run repairs only it', async () => {
    const thirteen = COLOURS.slice(0, 13)
    await family(thirteen)
    state.afterSet[1] = () => put(gid(13), LIST, list(thirteen[12]))
    await expect(link()).rejects.toMatchObject({ statusCode: 409,
      message: '"LV jacket 13" (Colore 13): Shopify changed this field. Review the latest values before retrying. The first 25 of 26 fields are written. Run the link again: it writes only what is still missing.' })
    expect(state.calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(1)
    state.afterSet = {}
    state.calls = []
    await link()
    expect(setInputs()).toEqual([['13:variation_products']])
    expect(valueOf(gid(13), LIST)).toBe(list(...thirteen))
  })

  it('a member deleted during the writes: no "Nothing was changed", no "Linked ✓"; the next run names it before any write', async () => {
    const thirteen = COLOURS.slice(0, 13)
    await family(thirteen)
    state.afterSet[2] = () => remove(gid(5))
    const error = await link().catch((e: Error) => e)
    expect(error.message).toMatch(/Run the link again/)
    expect(error.message).not.toMatch(/Nothing was changed/)
    expect(mutations()).toHaveLength(2)
    expect((await rowsOf()).filter(r => r.linkVerifiedAt !== null)).toEqual([])
    state.afterSet = {}
    state.calls = []
    await expect(link()).rejects.toThrow('The Shopify product of "Colore 5" no longer exists. Nothing was changed.')
    expect(mutations()).toEqual([])
  })

  it('the final read-back of the whole group, when a member is gone by then, ends with "Run the link again", not "Nothing was changed"', async () => {
    await family([C1, C2])
    state.beforeLinkRead[2] = () => remove(gid(2))
    await expect(link()).rejects.toMatchObject({ statusCode: 409, message: 'The Shopify product of "Colore 2" no longer exists. Run the link again.' })
    expect(mutations()).toHaveLength(1)
  })

  it('"writes off on the server" keeps an earlier "Linked ✓" (nothing is read); the store switch off withdraws it; neither calls Shopify', async () => {
    await family([C1, C2])
    await link()
    state.calls = []
    state.mode = 'dry-run'
    await expect(link()).rejects.toThrow('Shopify writes are switched off on this server. Nothing was changed.')
    expect((await rowsOf()).map(r => r.linkVerifiedAt !== null)).toEqual([true, true])
    state.mode = 'live'
    await settings({ enabled: false })
    await expect(link()).rejects.toThrow('Switch on colour products for this Shopify store first. Nothing was changed.')
    expect(state.calls).toEqual([])
    expect((await rowsOf()).map(r => r.linkVerifiedAt)).toEqual([null, null])
  })

  it('a colour the family no longer has keeps its Shopify name, so a new name equal to it is refused before any write', async () => {
    await family([C1, C2, C3])
    await link()
    state.colours = [C1, C2]
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C2 }, data: { colourName: 'grey' } }))
    state.calls = []
    await expect(link()).rejects.toThrow('"Colore 2", "Grey" would all be called "grey" on Shopify. Give each colour its own name. Nothing was changed.')
    expect(mutations()).toEqual([])
  })

  it('a colour name the Shopify field\'s rules refuse (here: at most 5 characters) is refused before any write, with the field\'s name', async () => {
    state.validations[VALUE] = [{ name: 'max', value: '5' }]
    await family([C1, C2], ['Black', 'Yellow'])
    await expect(link()).rejects.toThrow(/^"LV jacket 2" \(Colore 2\): Variation value — .+ Nothing was changed\.$/)
    expect(mutations()).toEqual([])
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C2 }, data: { colourName: 'Gold' } }))
    await link()
    expect([valueOf(gid(1), VALUE), valueOf(gid(2), VALUE)]).toEqual(['Black', 'Gold'])
  })
})

describe('colourGrouping — who owns the grouping fields (the guard\'s database side)', () => {
  const here = () => ({ familyId: ids.fam, accountId: ids.account, marketplace: 'GLOBAL', aliasKey: '' })
  const grouping = (ownerIds: string[] = [], destination = here()) => scoped(() => colourGrouping(destination, ownerIds))
  it('null without a confirmed colour; the family and its products once one is confirmed; null with the store switch off', async () => {
    await family([C1, C2], ['Black', 'Yellow'], 'PROPOSED')
    expect(await grouping([gid(1)])).toBeNull()
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: C1 }, data: { state: 'LINKED', shopifyProductId: gid(1) } }))
    expect(await grouping()).toEqual({ fields: [{ namespace: 'custom', key: 'variation_value' }, { namespace: 'custom', key: 'variation_products' }], family: true, products: [gid(1)] })
    await settings({ enabled: false })
    expect(await grouping()).toBeNull()
  })
  it('another family, alias or store: only the colour products named, never the family; a product that is not one gives null', async () => {
    await family([C1, C2])
    const other = { ...here(), familyId: 'another-family' }
    expect(await grouping([gid(40)], other)).toBeNull()
    expect(await grouping([gid(2), gid(40)], other)).toMatchObject({ family: false, products: [gid(2)] })
    expect(await grouping([], { ...here(), aliasKey: 'outlet' })).toBeNull()
    expect(await grouping([gid(1)], { ...here(), accountId: ids.other })).toBeNull()
  })
})
