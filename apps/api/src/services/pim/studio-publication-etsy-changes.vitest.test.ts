import { describe, expect, it } from 'vitest'

/**
 * E1 (Etsy publisher) — the change plan and the exact request, PURE. A new listing is one `__create__` line whose value is
 * the whole request; a listing that exists is compared field by field with the live read (Etsy's own equality: tags as a
 * set, a description's line ends, properties and variations by their text, never by Etsy's value ids). Fake ids only.
 */
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { etsyCreateForm } from './studio-publication-etsy-build.js'
import { compileEtsyChanges, etsyPublicationRequest, prepareEtsyChanges, ETSY_EMPTY_KEPT, ETSY_LIVE_READ_NEEDED, ETSY_STYLES_CREATE_ONLY } from './studio-publication-etsy-changes.js'
import type { EtsyChangePlan, EtsyInventoryStructure, EtsyListingValues, EtsyLiveListing, EtsyPublication } from './studio-publication-etsy-types.js'

const value = (v: unknown): StudioPublishValue => ({ state: 'value', value: v })
/** `ETSY_LIVE_SKIPPED` (studio-publication-etsy.ts), word for word; that module reads the database, so it is not loaded here. */
const ETSY_LIVE_SKIPPED = 'The review reads the live Etsy listing only when sending to Etsy is on.'
const facts = {} as PublicationFacts
const VALUES: EtsyListingValues = {
  title: 'Leather knee slider', description: 'A hand-stitched knee slider.', tags: ['moto', 'knee'], materials: ['leather'], taxonomy_id: 1234,
  classification: { who_made: 'i_did', when_made: '2020_2026', is_supply: false }, type: 'physical', shop_section_id: null, shipping_profile_id: 7001, return_policy_id: null,
  item_weight: { value: 120, unit: 'g' }, item_dimensions: { length: null, width: null, height: null, unit: null }, is_taxable: null, should_auto_renew: null,
  production_partner_ids: [55], styles: ['Racing'],
}
const COLOR = (sku: string, text: string, id: number) => ({ sku, property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [id], values: [text], scale_id: null }],
  offerings: [{ price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }] })
const STRUCTURE: EtsyInventoryStructure = { properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }], products: [
  { sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 },
  { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5001 },
] }
const MATERIAL = { property_id: 47626759834, property_name: 'Material', value_ids: [300], values: ['Leather'], scale_id: null }

/** Etsy holds an older title, the tags in another order and case, the attribute and colours under its own value ids. */
function live(extra: Partial<EtsyLiveListing> = {}): EtsyLiveListing {
  return {
    listingId: '9000000001', state: 'active', language: 'en',
    values: { ...VALUES, title: 'Old title', tags: ['knee', 'MOTO'], description: 'A hand-stitched knee slider.\r\n', production_partner_ids: [], styles: ['Vintage'] },
    unread: { production_partner_ids: 'Etsy does not report production partners when Nexus reads a listing.' },
    properties: [{ property_id: 200, property_name: 'Primary color', value_ids: [91], values: ['Black'], scale_id: null }, { ...MATERIAL, value_ids: [999], values: ['leather'] }],
    inventory: { properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }], products: [
      { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['red'] }], readiness_state_id: 5001 },
      { sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['BLACK'] }], readiness_state_id: 5001 },
    ] },
    offerings: { 'FAKE-SKU-2': { price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5009 }, 'FAKE-SKU-3': { price: 24, quantity: 1, is_enabled: true, readiness_state_id: 5009 } },
    unnamedProducts: 0, translations: [], shop: { languages: ['en', 'it'], currencyCode: 'EUR' }, priceCurrencies: ['EUR'], revision: 'live-rev-1', ...extra,
  }
}
function publication(extra: Partial<EtsyPublication> = {}): EtsyPublication {
  return {
    kind: 'etsy', marketplace: 'GLOBAL', listingId: '9000000001', ownerProductId: 'p',
    products: [{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
    inventoryProducts: [{ productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
    values: VALUES, form: etsyCreateForm(VALUES, 5001, null),
    inventory: { products: [COLOR('FAKE-SKU-2', 'Black', 1), COLOR('FAKE-SKU-3', 'Red', 2)], price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] },
    structure: STRUCTURE, properties: [MATERIAL], translations: [{ language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] }],
    create: null, live: live(), liveRevision: 'live-rev-1', ...extra,
  }
}
const created = (extra: Partial<EtsyPublication> = {}) => publication({ listingId: null, live: null, liveRevision: null, create: { state: 'draft', price: 25, quantity: 6 },
  form: etsyCreateForm(VALUES, 5001, { price: 25, quantity: 6 }), ...extra })
/** The title was last published as "Old title"; the description as Nexus holds it now. */
const baseline = () => new Map<string, StudioPublishValue>([
  [publicationChangeId('p', 'title'), value('Old title')],
  [publicationChangeId('p', 'description'), value('A hand-stitched knee slider.')],
])
const changeOf = (plan: EtsyChangePlan, field: string) => plan.changes.find(change => change.field === field)!
const idsOf = (plan: EtsyChangePlan, ...fields: string[]) => fields.map(field => changeOf(plan, field).id)

describe('a new listing', () => {
  it('is ONE ticked create line whose value is the whole request', () => {
    const source = created()
    const plan = prepareEtsyChanges(facts, source, new Map())
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({ field: '__create__', label: 'Create Etsy listing (draft)', productId: 'p', sku: 'FAKE-SKU-1', status: 'SEND', selectable: true, selectedByDefault: true,
      current: { state: 'value', value: etsyPublicationRequest(source, 'all') }, lastAccepted: { state: 'unknown', reason: 'No listing exists.' }, channel: { state: 'absent' } })
    expect(plan).toMatchObject({ kind: 'etsy-changes', remoteRevision: 'new', ownerProductId: 'p', products: source.products })
    // The field writes the accepted create records: one per line Nexus holds, never one it holds empty.
    expect(plan.createWrites.p.map(write => write.field)).toEqual(['title', 'description', 'tags', 'materials', 'taxonomy_id', 'classification', 'type', 'shipping_profile_id',
      'item_weight', 'production_partner_ids', 'styles', 'property:47626759834', 'translation:it', 'inventory'])
  })

  it('compiles to createDraftListing, the inventory, each attribute and each translation — paths keep {shop_id} and {listing_id}', () => {
    const source = created()
    const plan = prepareEtsyChanges(facts, source, new Map())
    const compiled = compileEtsyChanges(plan, [plan.changes[0].id])
    expect(compiled.products).toEqual(source.products)
    expect(compiled.fieldWrites).toEqual(plan.createWrites)
    expect(compiled.request).toEqual({ operation: 'createDraftListing', listingId: null, calls: [
      { method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: { ...source.form, quantity: 6, price: 25 } },
      { method: 'PUT', path: '/listings/{listing_id}/inventory', encoding: 'json', body: source.inventory },
      { method: 'PUT', path: '/shops/{shop_id}/listings/{listing_id}/properties/47626759834', encoding: 'form', body: { value_ids: [300], values: ['Leather'] } },
      { method: 'POST', path: '/shops/{shop_id}/listings/{listing_id}/translations/it', encoding: 'form', body: { title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] } },
    ] })
    expect(compiled.request!.calls[0].body).toMatchObject({ quantity: 6, title: 'Leather knee slider', description: 'A hand-stitched knee slider.', price: 25,
      who_made: 'i_did', when_made: '2020_2026', taxonomy_id: 1234, is_supply: false })
  })

  it('needs no read: sending off (liveSkipped) leaves the create line as it is', () => {
    const plan = prepareEtsyChanges(facts, created({ liveSkipped: ETSY_LIVE_SKIPPED }), new Map())
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({ field: '__create__', selectable: true })
  })
})

describe('a listing that exists', () => {
  it('SAME, SEND, DIFFERS with what it replaces, CANNOT_COMPARE, and styles refused', () => {
    const source = publication()
    source.live!.values.description = 'Changed on Etsy.'
    const plan = prepareEtsyChanges(facts, source, baseline())
    expect(plan.remoteRevision).toBe('live-rev-1')
    expect(changeOf(plan, 'title')).toMatchObject({ status: 'SEND', selectedByDefault: true })
    expect(changeOf(plan, 'description')).toMatchObject({ status: 'DIFFERS', selectedByDefault: true, replaces: { kind: 'channel_changed' } })
    // Tags in another order and case are the same tags.
    expect(changeOf(plan, 'tags')).toMatchObject({ status: 'SAME', selectable: false })
    // Etsy does not report production partners: they cannot be compared, and are never ticked.
    expect(changeOf(plan, 'production_partner_ids')).toMatchObject({ status: 'CANNOT_COMPARE', selectedByDefault: false,
      channel: { state: 'unknown', reason: 'Etsy does not report production partners when Nexus reads a listing.' } })
    // A field empty in Nexus is never a clear on Etsy.
    expect(changeOf(plan, 'shop_section_id')).toMatchObject({ status: 'CANNOT_COMPARE', selectable: false, current: { state: 'unknown', reason: ETSY_EMPTY_KEPT } })
    expect(changeOf(plan, 'styles')).toMatchObject({ selectable: false, selectedByDefault: false, reason: ETSY_STYLES_CREATE_ONLY })
    expect(plan.changes.every(change => change.productId === 'p' && change.sku === 'FAKE-SKU-1')).toBe(true)
  })

  it('a description differing only by Etsy\'s line ends and trailing space is the same', () => {
    expect(changeOf(prepareEtsyChanges(facts, publication(), baseline()), 'description')).toMatchObject({ status: 'SAME' })
  })

  it('attributes and variations compare by their text and scale, never by Etsy\'s value ids; a variation property is not an attribute line', () => {
    const plan = prepareEtsyChanges(facts, publication(), new Map())
    expect(changeOf(plan, 'property:47626759834')).toMatchObject({ status: 'SAME' })
    expect(changeOf(plan, 'inventory')).toMatchObject({ status: 'SAME', label: 'Variations, SKUs and processing profile' })
    expect(plan.changes.some(change => change.field === 'property:200')).toBe(false)
    const renamed = live({ inventory: { ...live().inventory, products: [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Green'] }], readiness_state_id: 5001 }, live().inventory.products[0]] } })
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: renamed }), new Map()), 'inventory')).toMatchObject({ status: 'DIFFERS', selectedByDefault: true,
      replaces: { sentence: 'Not published from Nexus before. Etsy has 2 variations by Primary color — Publish sets Nexus\'s version.' } })
    const scaled = live({ inventory: { ...live().inventory, properties: [{ property_id: 200, property_name: 'Primary color', scale_id: 7 }] } })
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: scaled }), new Map()), 'inventory').status).toBe('DIFFERS')
  })

  it('m3 — variations Etsy holds and Nexus does not (named, or without a SKU) make the variation set unselectable: a send would delete them', () => {
    // A product Etsy holds without a SKU (the reader keeps it as sku '') is a real difference, and refuses the line.
    const unnamed = live({ unnamedProducts: 1, inventory: { ...live().inventory, products: [...live().inventory.products, { sku: '', values: [{ property_id: 200, values: ['Blue'] }], readiness_state_id: 5001 }] } })
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: unnamed }), new Map()), 'inventory')).toMatchObject({ status: 'DIFFERS', selectable: false, selectedByDefault: false,
      reason: 'Etsy holds 1 variation without a SKU; sending the variations would delete it on Etsy.' })
    const extra = live({ inventory: { ...live().inventory, products: [...live().inventory.products,
      { sku: 'FAKE-SKU-8', values: [{ property_id: 200, values: ['Green'] }], readiness_state_id: 5001 }, { sku: 'FAKE-SKU-9', values: [{ property_id: 200, values: ['Blue'] }], readiness_state_id: 5001 }] } })
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: extra }), new Map()), 'inventory')).toMatchObject({ selectable: false,
      reason: 'Etsy holds variations FAKE-SKU-8 and FAKE-SKU-9 that Nexus does not; sending the variations would delete them on Etsy. Add them to the family in Nexus, or remove them on Etsy first.' })
  })

  it('M1 — a variation still without a processing profile (Nexus\'s and Etsy\'s both empty) makes the variation set unselectable', () => {
    const structure = { ...STRUCTURE, products: STRUCTURE.products.map((product, index) => index ? product : { ...product, readiness_state_id: null }) }
    const line = changeOf(prepareEtsyChanges(facts, publication({ structure }), new Map()), 'inventory')
    expect(line).toMatchObject({ status: 'DIFFERS', selectable: false,
      reason: 'Processing profile is not set. Etsy needs one for every variation: choose it on the main row (or on each row). FAKE-SKU-2 has no processing profile.' })
    // N4 — every SKU without one is named.
    const both = { ...STRUCTURE, products: STRUCTURE.products.map(product => ({ ...product, readiness_state_id: null })) }
    expect(changeOf(prepareEtsyChanges(facts, publication({ structure: both }), new Map()), 'inventory').reason)
      .toBe('Processing profile is not set. Etsy needs one for every variation: choose it on the main row (or on each row). FAKE-SKU-2 and FAKE-SKU-3 have no processing profile.')
  })

  it('an attribute changed on Etsy says what Publish replaces, in words', () => {
    const plan = prepareEtsyChanges(facts, publication({ live: live({ properties: [{ ...MATERIAL, values: ['Suede'] }] }) }),
      new Map([[publicationChangeId('p', 'property:47626759834'), value(MATERIAL)]]))
    expect(changeOf(plan, 'property:47626759834').replaces?.sentence).toBe('Changed on Etsy since the last publish. Etsy has Suede — Publish sets Leather.')
  })

  it('an attribute only Etsy holds is kept (Nexus never clears it from here); a translation Etsy lacks is offered', () => {
    const plan = prepareEtsyChanges(facts, publication({ properties: [] }), new Map())
    expect(changeOf(plan, 'property:47626759834')).toMatchObject({ status: 'CANNOT_COMPARE', selectable: false, current: { state: 'unknown', reason: ETSY_EMPTY_KEPT } })
    expect(changeOf(plan, 'translation:it')).toMatchObject({ status: 'DIFFERS', selectedByDefault: true, label: 'Translation (it)', channel: { state: 'absent' } })
  })

  it('never a price or a quantity line (D3)', () => {
    const fields = prepareEtsyChanges(facts, publication(), baseline()).changes.map(change => change.field)
    expect(fields.filter(field => /price|quantity/.test(field))).toEqual([])
  })

  it('a failed read refuses every line, with the reason', () => {
    const plan = prepareEtsyChanges(facts, publication({ live: null, liveRevision: null, liveReadError: 'Etsy answered 503.' }), baseline())
    expect(plan.remoteRevision).toBe('unavailable')
    expect(plan.changes.length).toBeGreaterThan(16)
    for (const change of plan.changes) expect(change).toMatchObject({ selectable: false, selectedByDefault: false, reason: 'Etsy answered 503.', channel: { state: 'unknown', reason: 'Etsy answered 503.' } })
  })

  it('sending off (liveSkipped) refuses every line with its own sentence (A1)', () => {
    const plan = prepareEtsyChanges(facts, publication({ live: null, liveRevision: null, liveSkipped: ETSY_LIVE_SKIPPED }), baseline())
    for (const change of plan.changes) expect(change).toMatchObject({ selectable: false, reason: ETSY_LIVE_SKIPPED, channel: { state: 'unknown', reason: ETSY_LIVE_SKIPPED } })
  })
})

describe('compiling a selection', () => {
  it('nothing selected sends nothing', () => {
    const plan = prepareEtsyChanges(facts, publication(), baseline())
    expect(compileEtsyChanges(plan, [])).toMatchObject({ products: [], fieldWrites: {}, request: null })
  })

  it('PATCHes only the selected keys: the title, and the three keys Etsy takes together', () => {
    const source = publication({ values: { ...VALUES, classification: { who_made: 'someone_else', when_made: 'made_to_order', is_supply: true } } })
    const plan = prepareEtsyChanges(facts, source, baseline())
    const compiled = compileEtsyChanges(plan, idsOf(plan, 'title', 'classification'))
    expect(compiled.request).toEqual({ operation: 'updateListing', listingId: '9000000001', calls: [{ method: 'PATCH', path: '/shops/{shop_id}/listings/9000000001', encoding: 'form',
      body: { title: 'Leather knee slider', who_made: 'someone_else', when_made: 'made_to_order', is_supply: true } }] })
    expect(compiled.fieldWrites).toEqual({ p: [{ field: 'title', value: value('Leather knee slider') },
      { field: 'classification', value: value({ who_made: 'someone_else', when_made: 'made_to_order', is_supply: true }) }] })
    expect(compiled.products).toEqual(source.products)
  })

  it('the inventory keeps Etsy\'s own price and stock with Nexus\'s processing profile; a variation new on Etsy takes Nexus\'s offering', () => {
    const source = publication({
      inventory: { ...publication().inventory, products: [COLOR('FAKE-SKU-2', 'Black', 1), COLOR('FAKE-SKU-3', 'Red', 2), COLOR('FAKE-SKU-4', 'White', 3)] },
      structure: { ...STRUCTURE, products: [...STRUCTURE.products, { sku: 'FAKE-SKU-4', values: [{ property_id: 200, values: ['White'] }], readiness_state_id: 5001 }] },
    })
    const plan = prepareEtsyChanges(facts, source, new Map())
    const call = compileEtsyChanges(plan, idsOf(plan, 'inventory')).request!.calls
    expect(call).toHaveLength(1)
    expect(call[0]).toMatchObject({ method: 'PUT', path: '/listings/9000000001/inventory', encoding: 'json', note: 'new variation FAKE-SKU-4' })
    const body = call[0].body as { products: Array<{ sku: string; offerings: unknown[] }>; readiness_state_on_property: number[] }
    expect(body.products.map(p => [p.sku, p.offerings])).toEqual([
      ['FAKE-SKU-2', [{ price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5001 }]],
      ['FAKE-SKU-3', [{ price: 24, quantity: 1, is_enabled: true, readiness_state_id: 5001 }]],
      ['FAKE-SKU-4', [{ price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }]],
    ])
    expect(body).toMatchObject({ price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] })
  })

  it('a translation Etsy lacks is created (POST); one it holds is replaced (PUT); an attribute is set by its own PUT', () => {
    expect(etsyPublicationRequest(publication(), new Set(['translation:it'])).calls[0]).toMatchObject({ method: 'POST', path: '/shops/{shop_id}/listings/9000000001/translations/it' })
    const holds = publication({ live: live({ translations: [{ language: 'it', title: 'Vecchio', description: 'Vecchia.', tags: [] }] }) })
    expect(etsyPublicationRequest(holds, new Set(['translation:it'])).calls[0]).toMatchObject({ method: 'PUT' })
    expect(etsyPublicationRequest(publication(), new Set(['property:47626759834'])).calls).toEqual([
      { method: 'PUT', path: '/shops/{shop_id}/listings/9000000001/properties/47626759834', encoding: 'form', body: { value_ids: [300], values: ['Leather'] } },
    ])
  })

  it('a title or a description is never cleared; styles are never sent to a listing that exists', () => {
    expect(() => etsyPublicationRequest(publication({ values: { ...VALUES, title: null } }), new Set(['title']))).toThrow('Title cannot be cleared.')
    expect(() => etsyPublicationRequest(publication(), new Set(['styles']))).toThrow(ETSY_STYLES_CREATE_ONLY)
  })

  it('an unknown value is never sent: not selectable, and refused even in a stored plan that says otherwise', () => {
    const plan = prepareEtsyChanges(facts, publication(), baseline())
    expect(() => compileEtsyChanges(plan, idsOf(plan, 'shop_section_id'))).toThrow('cannot be selected')
    const tampered: EtsyChangePlan = { ...plan, changes: plan.changes.map(change => change.field === 'shop_section_id' ? { ...change, selectable: true } : change) }
    expect(() => compileEtsyChanges(tampered, idsOf(plan, 'shop_section_id'))).toThrow('An unknown value cannot be sent to Etsy.')
  })

  it('a listing that exists needs a successful read to send', () => {
    const plan = prepareEtsyChanges(facts, publication(), baseline())
    expect(() => compileEtsyChanges({ ...plan, publication: { ...plan.publication, live: null } }, idsOf(plan, 'title'))).toThrow(ETSY_LIVE_READ_NEEDED)
  })

  it('every path names the shop as {shop_id}, never a number', () => {
    const paths = [...etsyPublicationRequest(created(), 'all').calls, ...etsyPublicationRequest(publication(), 'all').calls].map(call => call.path)
    for (const path of paths) expect(path).toMatch(/^\/(shops\/\{shop_id\}\/listings|listings\/)/)
  })

  it('a stored plan survives a JSON round trip unchanged, and compiles the same', () => {
    for (const source of [created(), publication()]) {
      const plan = prepareEtsyChanges(facts, source, baseline())
      const stored: EtsyChangePlan = JSON.parse(JSON.stringify(plan))
      expect(stored).toStrictEqual(plan)
      const ids = plan.changes.filter(change => change.selectedByDefault).map(change => change.id)
      expect(compileEtsyChanges(stored, ids)).toStrictEqual(compileEtsyChanges(plan, ids))
    }
  })
})
