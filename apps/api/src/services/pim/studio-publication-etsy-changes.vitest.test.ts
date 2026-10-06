import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * E1 (Etsy publisher) — the change plan and the exact request, PURE. A new listing is one `__create__` line whose value is
 * the whole request; a listing that exists is compared field by field with the live read (Etsy's own equality: tags as a
 * set, a description's line ends, properties and variations by their text, never by Etsy's value ids). Fake ids only.
 *
 * E2 — the calls in task order with the fields each writes, the variations built again at send from Etsy's fresh
 * inventory, the read-back judged field by field, Full update from the main row, and the review revision that a sale on
 * Etsy does not move.
 */
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { etsyCreateForm, etsyFitReadiness, etsyKeptRules, etsyOwnRules, etsyRuleConflicts, ETSY_NEEDS_READINESS, type EtsyRuleProduct } from './studio-publication-etsy-build.js'
import { compileEtsyChanges, etsyCreateInventoryBody, etsyDraftPlaceholder, etsyInventoryReplaceBody, etsyPublicationRequest, etsyReadBackMismatches, etsyRevisionView,
  prepareEtsyChanges, ETSY_EMPTY_KEPT, ETSY_FULL_KEEPS_VARIATIONS, ETSY_INVENTORY_REPLACE_NOTE, ETSY_LIVE_READ_NEEDED, ETSY_PARTNERS_CREATE_ONLY, ETSY_READINESS_RULE_CHANGE,
  ETSY_STYLES_CREATE_ONLY } from './studio-publication-etsy-changes.js'
import { ETSY_KEPT_AT_SEND, type EtsyChangePlan, type EtsyCompiled, type EtsyInventoryStructure, type EtsyListingValues, type EtsyLiveListing,
  type EtsyPublication } from './studio-publication-etsy-types.js'
import type { EtsyInventoryWrite } from '../etsy/inventory.js'

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
/** Each variation its own price, stock and SKU (the rules Nexus gives a listing it creates, and the live read states). */
const PER_VARIATION = { price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] }
const STRUCTURE: EtsyInventoryStructure = { properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }], products: [
  { sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 },
  { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5001 },
], ...PER_VARIATION }
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
    ], ...PER_VARIATION },
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
    create: null, live: live(), liveRevision: 'live-rev-1', currency: 'EUR', ...extra,
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
    // E3 — each call names the change fields it writes (the studio journals each call's field writes by them).
    expect(compiled.request).toEqual({ operation: 'createDraftListing', listingId: null, calls: [
      { method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: { ...source.form, quantity: 6, price: 25 },
        fields: ['title', 'description', 'tags', 'materials', 'taxonomy_id', 'classification', 'type', 'shipping_profile_id', 'item_weight', 'production_partner_ids', 'styles'] },
      { method: 'PUT', path: '/listings/{listing_id}/inventory', encoding: 'json', body: source.inventory, fields: ['inventory'] },
      { method: 'PUT', path: '/shops/{shop_id}/listings/{listing_id}/properties/47626759834', encoding: 'form', body: { value_ids: [300], values: ['Leather'] }, fields: ['property:47626759834'] },
      { method: 'POST', path: '/shops/{shop_id}/listings/{listing_id}/translations/it', encoding: 'form', body: { title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] },
        fields: ['translation:it'] },
    ] })
    // Every field write of the create belongs to exactly one call.
    expect(compiled.request!.calls.flatMap(call => call.fields ?? []).sort()).toEqual(plan.createWrites.p.map(write => write.field).sort())
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
      body: { title: 'Leather knee slider', who_made: 'someone_else', when_made: 'made_to_order', is_supply: true }, fields: ['title', 'classification'] }] })
    expect(compiled.fieldWrites).toEqual({ p: [{ field: 'title', value: value('Leather knee slider') },
      { field: 'classification', value: value({ who_made: 'someone_else', when_made: 'made_to_order', is_supply: true }) }] })
    // E2 — without the variations, only the main row is journalled; the stored read is dropped (the send reads Etsy again).
    expect(compiled.products).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1' }])
    expect(compiled).toMatchObject({ live: null, liveRevision: 'live-rev-1', removeSkus: [], removeUnnamed: false, addedSkus: [] })
  })

  it('the inventory shows Etsy\'s own price, stock and on/off as read at send, with Nexus\'s processing profile; a variation new on Etsy takes Nexus\'s offering', () => {
    const source = publication({
      inventory: { ...publication().inventory, products: [COLOR('FAKE-SKU-2', 'Black', 1), COLOR('FAKE-SKU-3', 'Red', 2), COLOR('FAKE-SKU-4', 'White', 3)] },
      structure: { ...STRUCTURE, products: [...STRUCTURE.products, { sku: 'FAKE-SKU-4', values: [{ property_id: 200, values: ['White'] }], readiness_state_id: 5001 }] },
    })
    const plan = prepareEtsyChanges(facts, source, new Map())
    const compiled = compileEtsyChanges(plan, idsOf(plan, 'inventory'))
    const call = compiled.request!.calls
    expect(call).toHaveLength(1)
    expect(call[0]).toMatchObject({ method: 'PUT', path: '/listings/9000000001/inventory', encoding: 'json', note: 'new variation FAKE-SKU-4', fields: ['inventory'] })
    const body = call[0].body as { products: Array<{ sku: string; offerings: unknown[] }>; readiness_state_on_property: number[] }
    const kept = { price: ETSY_KEPT_AT_SEND, quantity: ETSY_KEPT_AT_SEND, is_enabled: ETSY_KEPT_AT_SEND, readiness_state_id: 5001 }
    expect(body.products.map(p => [p.sku, p.offerings])).toEqual([
      ['FAKE-SKU-2', [kept]],
      ['FAKE-SKU-3', [kept]],
      ['FAKE-SKU-4', [{ price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }]],
    ])
    expect(body).toMatchObject({ price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] })
    expect(JSON.stringify(compiled.request)).not.toMatch(/"quantity":[12],/)
    // The main row and every variation are journalled; FAKE-SKU-4 is the one the PUT adds.
    expect(compiled.products).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }])
    expect(compiled.addedSkus).toEqual(['FAKE-SKU-4'])
  })

  it('a translation Etsy lacks is created (POST); one it holds is replaced (PUT); an attribute is set by its own PUT', () => {
    expect(etsyPublicationRequest(publication(), new Set(['translation:it'])).calls[0]).toMatchObject({ method: 'POST', path: '/shops/{shop_id}/listings/9000000001/translations/it' })
    const holds = publication({ live: live({ translations: [{ language: 'it', title: 'Vecchio', description: 'Vecchia.', tags: [] }] }) })
    expect(etsyPublicationRequest(holds, new Set(['translation:it'])).calls[0]).toMatchObject({ method: 'PUT' })
    expect(etsyPublicationRequest(publication(), new Set(['property:47626759834'])).calls).toEqual([
      { method: 'PUT', path: '/shops/{shop_id}/listings/9000000001/properties/47626759834', encoding: 'form', body: { value_ids: [300], values: ['Leather'] }, fields: ['property:47626759834'] },
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

// ── E2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `publicationDigest`'s rule (studio-publication-plan.ts), kept here so this pure test loads no studio module. */
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex')
/** Nexus holds FAKE-SKU-2, FAKE-SKU-3 and FAKE-SKU-4 (new on Etsy); Etsy holds FAKE-SKU-2 and FAKE-SKU-3. */
const withNew = (extra: Partial<EtsyPublication> = {}) => publication({
  inventory: { ...publication().inventory, products: [COLOR('FAKE-SKU-2', 'Black', 1), COLOR('FAKE-SKU-3', 'Red', 2), COLOR('FAKE-SKU-4', 'White', 3)] },
  structure: { ...STRUCTURE, products: [...STRUCTURE.products, { sku: 'FAKE-SKU-4', values: [{ property_id: 200, values: ['White'] }], readiness_state_id: 5001 }] },
  inventoryProducts: [...publication().inventoryProducts, { productId: 'c3', sku: 'FAKE-SKU-4' }], ...extra,
})
const selectedIds = (plan: EtsyChangePlan) => plan.changes.filter(change => change.selectedByDefault).map(change => change.id)
/** Etsy's inventory as `toInventoryWrite` gives it: Etsy's own value ids, prices, stock and processing profile. */
const etsyProduct = (sku: string | undefined, text: string, offering: Partial<{ price: number; quantity: number; is_enabled: boolean; readiness_state_id: number | null }> = {}) => ({
  ...(sku !== undefined ? { sku } : {}), property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [90], values: [text], scale_id: null }],
  offerings: [{ price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5009, ...offering }] })
const current = (...products: ReturnType<typeof etsyProduct>[]): EtsyInventoryWrite => ({ products, price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] })

describe('E2 — what the plan says a send would do', () => {
  it('production partners are refused on a listing that exists (Etsy never reports them, so a send could not be confirmed)', () => {
    const plan = prepareEtsyChanges(facts, publication(), baseline())
    expect(changeOf(plan, 'production_partner_ids')).toMatchObject({ selectable: false, selectedByDefault: false, reason: ETSY_PARTNERS_CREATE_ONLY })
    expect(ETSY_PARTNERS_CREATE_ONLY).toBe('Etsy does not report production partners, so Nexus could not confirm a change; it sends them only when it creates a listing.')
    expect(() => etsyPublicationRequest(publication(), new Set(['production_partner_ids']))).toThrow(ETSY_PARTNERS_CREATE_ONLY)
    expect(etsyPublicationRequest(publication(), 'all').calls[0].body).not.toHaveProperty('production_partner_ids')
  })

  it('a new variation\'s stock refusal (Etsy order import) refuses the variations line', () => {
    const refusal = 'FAKE-SKU-4: new on Etsy, so Publish would send its stock. Etsy order import is off.'
    const line = changeOf(prepareEtsyChanges(facts, withNew({ newVariationStockRefusal: refusal }), new Map()), 'inventory')
    expect(line).toMatchObject({ status: 'DIFFERS', selectable: false, selectedByDefault: false, reason: refusal })
    expect(changeOf(prepareEtsyChanges(facts, withNew(), new Map()), 'inventory')).toMatchObject({ selectable: true, selectedByDefault: true })
  })

  it('the full-replace warning shows only when the variations line can be sent and differs', () => {
    const replaceNote = (plan: EtsyChangePlan) => (plan.fullIssues ?? []).filter(issue => issue.message === ETSY_INVENTORY_REPLACE_NOTE)
    expect(replaceNote(prepareEtsyChanges(facts, publication(), new Map()))).toEqual([])
    expect(replaceNote(prepareEtsyChanges(facts, withNew(), new Map()))).toEqual([{ severity: 'warning', field: 'inventory', message: ETSY_INVENTORY_REPLACE_NOTE }])
    const noProfile = withNew({ structure: { ...withNew().structure, products: withNew().structure.products.map(p => ({ ...p, readiness_state_id: null })) } })
    expect(replaceNote(prepareEtsyChanges(facts, noProfile, new Map()))).toEqual([])
    expect(ETSY_INVENTORY_REPLACE_NOTE).not.toMatch(/\.ts|:\d/)
  })

  it('the calls go in task order — the listing PATCH, each attribute, each translation, the variations last — each naming its fields', () => {
    const source = withNew({ live: live({ properties: [{ ...MATERIAL, values: ['Suede'] }] }) })
    const plan = prepareEtsyChanges(facts, source, new Map())
    const ids = idsOf(plan, 'inventory', 'translation:it', 'property:47626759834', 'title')
    const compiled = compileEtsyChanges(plan, ids)
    expect(compiled.request!.calls.map(call => [call.method, call.path, call.fields])).toEqual([
      ['PATCH', '/shops/{shop_id}/listings/9000000001', ['title']],
      ['PUT', '/shops/{shop_id}/listings/9000000001/properties/47626759834', ['property:47626759834']],
      ['POST', '/shops/{shop_id}/listings/9000000001/translations/it', ['translation:it']],
      ['PUT', '/listings/9000000001/inventory', ['inventory']],
    ])
    expect(compiled.fieldWrites.p.map(write => write.field)).toEqual(['title', 'property:47626759834', 'translation:it', 'inventory'])
  })
})

describe('E2 — Full update (the main row)', () => {
  it('every line Nexus can send is ticked and locked; what it cannot send stays as Etsy holds it, named once', () => {
    const plan = prepareEtsyChanges(facts, publication(), baseline(), { full: true })
    expect(plan).toMatchObject({ full: true, products: publication().products })
    for (const field of ['title', 'tags', 'description', 'property:47626759834', 'translation:it'])
      expect(changeOf(plan, field)).toMatchObject({ selectable: true, selectedByDefault: true, locked: true })
    expect(changeOf(plan, 'tags').reason).toBe('Full update sends it again (it already matches the channel).')
    // E2 review B1 — never an inventory PUT without a real change (each one risks Etsy's domestic-price fault).
    expect(changeOf(plan, 'inventory')).toMatchObject({ status: 'SAME', selectable: false, selectedByDefault: false, reason: ETSY_FULL_KEEPS_VARIATIONS })
    expect(ETSY_FULL_KEEPS_VARIATIONS).toBe('Full update does not send unchanged variations again: each send replaces Etsy\'s whole inventory.')
    expect(changeOf(plan, 'inventory').locked).toBeUndefined()
    expect(compileEtsyChanges(plan, selectedIds(plan)).request!.calls.some(call => call.fields?.includes('inventory'))).toBe(false)
    expect((plan.fullIssues ?? []).some(issue => issue.message === ETSY_INVENTORY_REPLACE_NOTE)).toBe(false)
    // Empty in Nexus (never cleared), create-only, and unread: kept.
    for (const field of ['shop_section_id', 'styles', 'production_partner_ids']) expect(changeOf(plan, field).locked).toBeUndefined()
    expect(plan.fullIssues).toContainEqual({ productId: 'p', sku: 'FAKE-SKU-1', severity: 'warning',
      message: 'FAKE-SKU-1: Full update leaves these 2 fields as Etsy holds them: Production partner IDs, Styles.' })
    expect(plan.removals).toBeUndefined()
  })

  it('an attribute only Etsy holds is removed: listed, and sent as a DELETE', () => {
    const plan = prepareEtsyChanges(facts, publication({ properties: [] }), new Map(), { full: true })
    expect(changeOf(plan, 'property:47626759834')).toMatchObject({ current: { state: 'absent' }, locked: true, reason: 'Full update removes it: Nexus holds no value here.' })
    expect(plan.removals).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1', field: 'property:47626759834', label: 'Material', value: { ...MATERIAL, value_ids: [999], values: ['leather'] } }])
    const compiled = compileEtsyChanges(plan, selectedIds(plan))
    expect(compiled.request!.calls.find(call => call.method === 'DELETE')).toEqual({ method: 'DELETE', path: '/shops/{shop_id}/listings/9000000001/properties/47626759834',
      encoding: 'none', body: null, fields: ['property:47626759834'], note: 'Full update removes it: Nexus holds no value here.' })
    expect(compiled.fieldWrites.p).toContainEqual({ field: 'property:47626759834', value: { state: 'absent' } })
  })

  it('variations Etsy holds and Nexus does not are removed: the line can be sent, each is listed, and the PUT may drop exactly them', () => {
    const extra = live({ unnamedProducts: 1, inventory: { ...live().inventory, products: [...live().inventory.products,
      { sku: 'FAKE-SKU-9', values: [{ property_id: 200, values: ['Green'] }], readiness_state_id: 5001 }, { sku: '', values: [{ property_id: 200, values: ['Blue'] }], readiness_state_id: 5001 }] } })
    const plan = prepareEtsyChanges(facts, publication({ live: extra }), new Map(), { full: true })
    expect(changeOf(plan, 'inventory')).toMatchObject({ selectable: true, locked: true })
    expect(plan.removals).toEqual([
      { productId: 'p', sku: 'FAKE-SKU-9', field: 'variation', label: 'Variation removed from the listing', value: [{ property_id: 200, values: ['Green'] }] },
      { productId: 'p', sku: '', field: 'variation', label: '1 variation without a SKU removed', value: 1 },
    ])
    const compiled = compileEtsyChanges(plan, selectedIds(plan))
    expect(compiled).toMatchObject({ removeSkus: ['FAKE-SKU-9'], removeUnnamed: true, addedSkus: [] })
    expect(compiled.request!.calls.at(-1)).toMatchObject({ fields: ['inventory'], note: 'removes variation FAKE-SKU-9; removes 1 variation without a SKU' })
    // A Partial update still refuses the line (m3).
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: extra }), new Map()), 'inventory').selectable).toBe(false)
  })

  it('a variation still without a processing profile, or a new variation\'s stock refusal, blocks the Full update by name', () => {
    const structure = { ...STRUCTURE, products: STRUCTURE.products.map((product, index) => index ? product : { ...product, readiness_state_id: null }) }
    const plan = prepareEtsyChanges(facts, publication({ structure, newVariationStockRefusal: 'FAKE-SKU-4: new on Etsy, so Publish would send its stock.' }), new Map(), { full: true })
    expect(plan.fullIssues?.filter(issue => issue.severity === 'error').map(issue => issue.message)).toEqual([
      `FAKE-SKU-1: Full update cannot be sent: ${ETSY_NEEDS_READINESS} FAKE-SKU-2 has no processing profile.`,
      'FAKE-SKU-1: Full update cannot be sent: FAKE-SKU-4: new on Etsy, so Publish would send its stock.',
    ])
    expect(changeOf(plan, 'inventory')).toMatchObject({ selectable: false })
  })

  it('without a live read a Full update cannot be checked', () => {
    const plan = prepareEtsyChanges(facts, publication({ live: null, liveRevision: null, liveReadError: 'Etsy answered 503.' }), new Map(), { full: true })
    expect(plan.fullIssues).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1', severity: 'error',
      message: 'FAKE-SKU-1: Etsy could not be read just now, so a Full update cannot be checked (Etsy answered 503.). Review again, or use Partial update.' }])
    expect(plan.changes.every(change => !change.selectable && !change.locked)).toBe(true)
  })

  it('a translation Etsy holds that Nexus does not stays on Etsy (no delete), said by language; the listing\'s own language is not one', () => {
    const plan = prepareEtsyChanges(facts, publication({ live: live({ translations: [{ language: 'en', title: 'Own', description: 'Own.', tags: [] },
      { language: 'de', title: 'Knieschleifer', description: 'Genäht.', tags: [] }] }) }), new Map(), { full: true })
    expect(plan.fullIssues?.filter(issue => /translation/.test(issue.message)).map(issue => issue.message)).toEqual(['de: Etsy keeps its translation (Etsy has no delete for translations).'])
  })

  it('a Full plan survives a JSON round trip and compiles the same', () => {
    const plan = prepareEtsyChanges(facts, publication({ properties: [] }), baseline(), { full: true })
    const stored: EtsyChangePlan = JSON.parse(JSON.stringify(plan))
    expect(stored).toStrictEqual(plan)
    expect(compileEtsyChanges(stored, selectedIds(plan))).toStrictEqual(compileEtsyChanges(plan, selectedIds(plan)))
  })
})

describe('E2 — a sale on Etsy does not force a new review', () => {
  const restock = (extra: Partial<EtsyLiveListing> = {}) => live({ offerings: { 'FAKE-SKU-2': { price: 19, quantity: 0, is_enabled: false, readiness_state_id: 5009 },
    'FAKE-SKU-3': { price: 30, quantity: 7, is_enabled: true, readiness_state_id: 5009 } }, ...extra })

  it('the revision view is the same across Etsy\'s price, stock and on/off and the sold-out flip; a processing profile change moves it', () => {
    const view = (listing: EtsyLiveListing) => digest(etsyRevisionView(prepareEtsyChanges(facts, withNew({ live: listing }), new Map())))
    expect(view(restock())).toBe(view(live()))
    expect(view(restock({ state: 'sold_out' }))).toBe(view(live()))
    expect(view(live({ state: 'inactive' }))).not.toBe(view(live()))
    expect(view(live({ offerings: { ...live().offerings, 'FAKE-SKU-2': { ...live().offerings['FAKE-SKU-2'], readiness_state_id: 5010 } } }))).not.toBe(view(live()))
  })

  it('the compiled selection (its digest) is the same when only Etsy\'s stock differs', () => {
    const compiled = (listing: EtsyLiveListing) => { const plan = prepareEtsyChanges(facts, withNew({ live: listing }), new Map()); return compileEtsyChanges(plan, idsOf(plan, 'inventory', 'title')) }
    expect(digest(compiled(restock()))).toBe(digest(compiled(live())))
    expect(compiled(live()).live).toBeNull()
  })
})

describe('E2 — the variations PUT, built at send from Etsy\'s fresh inventory', () => {
  const compiledOf = (source: EtsyPublication, options: { full?: boolean } = {}) => {
    const plan = prepareEtsyChanges(facts, source, new Map(), options)
    return compileEtsyChanges(plan, options.full ? selectedIds(plan) : idsOf(plan, 'inventory'))
  }
  const refusalOf = (plan: EtsyCompiled, inventory: EtsyInventoryWrite) => { const out = etsyInventoryReplaceBody(plan, inventory); return 'refusal' in out ? out.refusal : null }

  it('Etsy\'s variations in Etsy\'s order with Etsy\'s own values (same text), price, stock and on/off and Nexus\'s processing profile; a new variation takes Nexus\'s offering', () => {
    const out = etsyInventoryReplaceBody(compiledOf(withNew()), current(etsyProduct('FAKE-SKU-3', 'red', { price: 31, quantity: 0, is_enabled: false }), etsyProduct('FAKE-SKU-2', 'BLACK', { quantity: 9 })))
    expect(out).toEqual({ body: {
      products: [
        { sku: 'FAKE-SKU-3', property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [90], values: ['red'], scale_id: null }], offerings: [{ price: 31, quantity: 0, is_enabled: false, readiness_state_id: 5001 }] },
        { sku: 'FAKE-SKU-2', property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [90], values: ['BLACK'], scale_id: null }], offerings: [{ price: 24, quantity: 9, is_enabled: true, readiness_state_id: 5001 }] },
        { sku: 'FAKE-SKU-4', property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [3], values: ['White'], scale_id: null }], offerings: [{ price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }] },
      ],
      price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [],
    } })
    // A value Nexus renamed is sent as Nexus holds it.
    const renamed = etsyInventoryReplaceBody(compiledOf(withNew()), current(etsyProduct('FAKE-SKU-2', 'Nero'), etsyProduct('FAKE-SKU-3', 'Red')))
    if (!('body' in renamed)) throw new Error(renamed.refusal)
    expect(renamed.body.products[0].property_values).toEqual([{ property_id: 200, property_name: 'Primary color', value_ids: [1], values: ['Black'], scale_id: null }])
  })

  it('a processing profile Nexus does not hold keeps Etsy\'s; a new variation set Inactive stays hidden (§10.6); profiles that differ must fit Etsy\'s rule', () => {
    const plan = compiledOf(withNew())
    const tampered: EtsyCompiled = { ...plan, structure: { ...plan.structure, products: plan.structure.products.map(p => p.sku === 'FAKE-SKU-2' ? { ...p, readiness_state_id: null } : p) },
      inventory: { ...plan.inventory, products: plan.inventory.products.map(p => p.sku === 'FAKE-SKU-4' ? { ...p, offerings: [{ ...p.offerings[0], is_enabled: false }] } : p) } }
    // Etsy's processing profile varies by colour here, so FAKE-SKU-2 keeps 5009 beside the others' 5001.
    const out = etsyInventoryReplaceBody(tampered, { ...current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-3', 'Red')), readiness_state_on_property: [200] })
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body.products.map(p => [p.sku, p.offerings[0].readiness_state_id, p.offerings[0].is_enabled])).toEqual([['FAKE-SKU-2', 5009, true], ['FAKE-SKU-3', 5001, true], ['FAKE-SKU-4', 5001, false]])
    expect(out.body.readiness_state_on_property).toEqual([200])
    // R2-n3 — one profile shared by every variation on Etsy: the processing-profile rule is widened (no price or stock
    // rides on it); the price, stock and SKU rules stay Etsy's.
    const widened = etsyInventoryReplaceBody(tampered, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-3', 'Red')))
    if (!('body' in widened)) throw new Error(widened.refusal)
    expect(widened.body).toMatchObject({ price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [200] })
  })

  it('refuses whatever a full replace would delete without the review\'s yes, and whatever Etsy would refuse — each ending "Nothing was sent."', () => {
    const partial = compiledOf(withNew())
    expect(refusalOf(partial, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-3', 'Red'), etsyProduct('FAKE-SKU-9', 'Green'))))
      .toBe('Etsy now holds variation FAKE-SKU-9 that Nexus does not; sending the variations would delete it. Review again. Nothing was sent.')
    expect(refusalOf(partial, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct(undefined, 'Blue'), etsyProduct('', 'Green'))))
      .toBe('Etsy now holds 2 variations without a SKU; sending the variations would delete them. Review again. Nothing was sent.')
    expect(refusalOf(partial, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-2', 'Red'))))
      .toBe('Etsy holds FAKE-SKU-2 on more than one variation, so Nexus cannot tell which is which. Nothing was sent.')
    const twoOfferings = etsyProduct('FAKE-SKU-3', 'Red')
    twoOfferings.offerings.push({ ...twoOfferings.offerings[0], price: 26 })
    expect(refusalOf(partial, current(etsyProduct('FAKE-SKU-2', 'Black'), twoOfferings)))
      .toBe('Etsy holds more than one offering (price and stock) for FAKE-SKU-3; Nexus sends one per variation. Nothing was sent.')
    const noProfile: EtsyCompiled = { ...partial, structure: { ...partial.structure, products: partial.structure.products.map(p => ({ ...p, readiness_state_id: null })) },
      inventory: { ...partial.inventory, products: partial.inventory.products.map(p => ({ ...p, offerings: [{ ...p.offerings[0], readiness_state_id: null }] })) } }
    expect(refusalOf(noProfile, current(etsyProduct('FAKE-SKU-2', 'Black', { readiness_state_id: null }), etsyProduct('FAKE-SKU-3', 'Red'))))
      .toBe(`${ETSY_NEEDS_READINESS} FAKE-SKU-2 and FAKE-SKU-4 have no processing profile. Nothing was sent.`)
    const unpriced: EtsyCompiled = { ...partial, inventory: { ...partial.inventory, products: partial.inventory.products.map(p => p.sku === 'FAKE-SKU-4' ? { ...p, offerings: [{ ...p.offerings[0], price: 0 }] } : p) } }
    expect(refusalOf(unpriced, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-3', 'Red'))))
      .toBe('FAKE-SKU-4: a new variation needs a price above 0 on Etsy. Nothing was sent.')
  })

  it('a Full update drops exactly the variations it listed', () => {
    const extra = live({ unnamedProducts: 1, inventory: { ...live().inventory, products: [...live().inventory.products,
      { sku: 'FAKE-SKU-9', values: [{ property_id: 200, values: ['Green'] }], readiness_state_id: 5001 }, { sku: '', values: [{ property_id: 200, values: ['Blue'] }], readiness_state_id: 5001 }] } })
    const plan = compiledOf(publication({ live: extra }), { full: true })
    const out = etsyInventoryReplaceBody(plan, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-3', 'Red'), etsyProduct('FAKE-SKU-9', 'Green'), etsyProduct('', 'Blue')))
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body.products.map(p => p.sku)).toEqual(['FAKE-SKU-2', 'FAKE-SKU-3'])
    // Another variation Etsy gained since the review is still refused.
    expect(refusalOf(plan, current(etsyProduct('FAKE-SKU-2', 'Black'), etsyProduct('FAKE-SKU-3', 'Red'), etsyProduct('FAKE-SKU-8', 'Pink'))))
      .toBe('Etsy now holds variation FAKE-SKU-8 that Nexus does not; sending the variations would delete it. Review again. Nothing was sent.')
  })
})

describe('E2 — the read-back', () => {
  /** Everything Nexus can send (a Full update), compiled. */
  const compiled = (source: EtsyPublication) => { const plan = prepareEtsyChanges(facts, source, new Map(), { full: true }); return compileEtsyChanges(plan, selectedIds(plan)) }
  const asSent = live({ values: { ...VALUES, tags: ['KNEE', 'moto'], description: 'A hand-stitched knee slider.\r\n' } })

  it('tags in another order and case, a description\'s line ends, the same attribute under Etsy\'s value ids: no difference', () => {
    const plan = compiled(publication())
    expect(etsyReadBackMismatches(plan, new Set(['title', 'tags', 'description', 'property:47626759834', 'inventory']), asSent)).toEqual([])
  })

  it('a title Etsy does not hold as sent is named; a field whose call was not applied is not judged', () => {
    const plan = compiled(publication())
    const after = live({ values: { ...asSent.values, title: 'Old title' } })
    expect(etsyReadBackMismatches(plan, new Set(['title']), after)).toEqual(['Title: Etsy holds something other than what Nexus sent.'])
    expect(etsyReadBackMismatches(plan, new Set(['tags']), after)).toEqual([])
  })

  it('a removed attribute must be gone; a translation and the variations are compared by their texts and structure', () => {
    const removedPlan = compiled(publication({ properties: [] }))
    expect(etsyReadBackMismatches(removedPlan, new Set(['property:47626759834']), asSent)).toEqual(['Material: Etsy still holds it after Nexus removed it.'])
    expect(etsyReadBackMismatches(removedPlan, new Set(['property:47626759834']), live({ properties: [] }))).toEqual([])
    const plan = compiled(publication())
    expect(etsyReadBackMismatches(plan, new Set(['translation:it']), live({ translations: [{ language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.\r\n', tags: ['MOTO'] }] }))).toEqual([])
    expect(etsyReadBackMismatches(plan, new Set(['translation:it']), live({ translations: null }))).toEqual(['Translation (it): Etsy did not return its translations, so Nexus could not confirm it.'])
    const renamed = live({ inventory: { ...live().inventory, products: [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Green'] }], readiness_state_id: 5001 }, live().inventory.products[0]] } })
    expect(etsyReadBackMismatches(plan, new Set(['inventory']), renamed)).toEqual(['Variations, SKUs and processing profile: Etsy holds something other than what Nexus sent.'])
  })

  it('Item size is judged on the measures Nexus sent: a width Etsy keeps on its own is not a difference', () => {
    const plan = compiled(publication({ values: { ...VALUES, item_dimensions: { length: 10, width: null, height: null, unit: 'cm' } } }))
    const after = live({ values: { ...asSent.values, item_dimensions: { length: 10, width: 5, height: null, unit: 'cm' } } })
    expect(etsyReadBackMismatches(plan, new Set(['item_dimensions']), after)).toEqual([])
    expect(etsyReadBackMismatches(plan, new Set(['item_dimensions']), live({ values: { ...asSent.values, item_dimensions: { length: 12, width: 5, height: null, unit: 'cm' } } })))
      .toEqual(['Item size: Etsy holds something other than what Nexus sent.'])
  })
})

describe('E2 review B1 — the listing\'s own price, stock, SKU and processing-profile rules are kept', () => {
  /** On Etsy every variation shares one price and one stock number (5); the SKU varies by colour. */
  const SHARED = { price_on_property: [], quantity_on_property: [], sku_on_property: [200], readiness_state_on_property: [] }
  const sharedLive = () => live({ inventory: { ...live().inventory, ...SHARED },
    offerings: { 'FAKE-SKU-2': { price: 24, quantity: 5, is_enabled: true, readiness_state_id: 5001 }, 'FAKE-SKU-3': { price: 24, quantity: 5, is_enabled: true, readiness_state_id: 5001 } } })
  /** Nexus's side carries Etsy's rules (prepare keeps them); FAKE-SKU-4 is new, with Nexus's price and stock. */
  const sharedNew = (price: number, quantity: number) => withNew({ live: sharedLive(), structure: { ...withNew().structure, ...SHARED },
    inventory: { ...withNew().inventory, products: withNew().inventory.products.map(p => p.sku === 'FAKE-SKU-4' ? { ...p, offerings: [{ ...p.offerings[0], price, quantity }] } : p) } })
  const compiledInventory = (source: EtsyPublication) => { const plan = prepareEtsyChanges(facts, source, new Map()); return compileEtsyChanges(plan, idsOf(plan, 'inventory')) }
  const compiledOf = compiledInventory
  const refusalOf = (plan: EtsyCompiled, inventory: EtsyInventoryWrite) => { const out = etsyInventoryReplaceBody(plan, inventory); return 'refusal' in out ? out.refusal : null }

  it('an unchanged listing reads SAME with the rules on both sides; a rule that differs reads DIFFERS', () => {
    expect(changeOf(prepareEtsyChanges(facts, publication(), new Map()), 'inventory')).toMatchObject({ status: 'SAME', selectable: false })
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: sharedLive(), structure: { ...STRUCTURE, ...SHARED } }), new Map()), 'inventory').status).toBe('SAME')
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: sharedLive() }), new Map()), 'inventory').status).toBe('DIFFERS')
  })

  it('a new variation with its own price or stock on a listing that shares them is refused by name, in plain words (the line, the review, a Full update)', () => {
    const sentences = [
      'FAKE-SKU-4: this Etsy listing shares one price across its variations, and Nexus does not change that rule. Nexus holds 25 for FAKE-SKU-4; the listing holds 24. Change the rule on Etsy first, then review again.',
      'FAKE-SKU-4: this Etsy listing shares one stock number across its variations, and Nexus does not change that rule. Nexus holds 3 for FAKE-SKU-4; the listing holds 5. Change the rule on Etsy first, then review again.',
    ]
    const plan = prepareEtsyChanges(facts, sharedNew(25, 3), new Map())
    expect(changeOf(plan, 'inventory')).toMatchObject({ status: 'DIFFERS', selectable: false, selectedByDefault: false, reason: sentences.join(' ') })
    expect(plan.fullIssues).toEqual(sentences.map(message => ({ severity: 'warning', field: 'inventory', message })))
    const full = prepareEtsyChanges(facts, sharedNew(25, 3), new Map(), { full: true })
    expect(full.fullIssues?.filter(issue => issue.severity === 'error').map(issue => issue.message)).toEqual(sentences.map(sentence => `FAKE-SKU-1: Full update cannot be sent: ${sentence}`))
    // The listing's own price and stock: it fits, and can be sent.
    expect(changeOf(prepareEtsyChanges(facts, sharedNew(24, 5), new Map()), 'inventory')).toMatchObject({ selectable: true, selectedByDefault: true })
  })

  it('a shared stock number stays ONE shared number after the PUT (Etsy 5 → still 5, never summed or repeated per variation), and a shared price one price', () => {
    const sharedNow = (quantity: number) => ({ ...current(etsyProduct('FAKE-SKU-2', 'Black', { quantity, readiness_state_id: 5001 }), etsyProduct('FAKE-SKU-3', 'Red', { quantity, readiness_state_id: 5001 })), ...SHARED })
    const out = etsyInventoryReplaceBody(compiledInventory(sharedNew(24, 5)), sharedNow(5))
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body).toMatchObject(SHARED)
    expect(out.body.products.map(p => [p.sku, p.offerings[0].price, p.offerings[0].quantity])).toEqual([['FAKE-SKU-2', 24, 5], ['FAKE-SKU-3', 24, 5], ['FAKE-SKU-4', 24, 5]])
    // A sale since the review (5 → 4): FAKE-SKU-4's 5 no longer fits the shared number, so nothing is sent.
    expect(refusalOf(compiledInventory(sharedNew(24, 5)), sharedNow(4))).toBe('FAKE-SKU-4: this Etsy listing shares one stock number across its variations, and Nexus does '
      + 'not change that rule. Nexus holds 5 for FAKE-SKU-4; the listing holds 4. Change the rule on Etsy first, then review again. Nothing was sent.')
  })

  it('nothing changed on Etsy\'s side: the body IS Etsy\'s inventory, so the writer sends no PUT', () => {
    const reviewed = live({ inventory: { ...live().inventory, products: live().inventory.products.map(p => ({ ...p, readiness_state_id: 5009 })) } })
    const plan = compiledInventory(publication({ live: reviewed }))
    // Someone set the processing profile on Etsy since the review: Etsy already holds what Nexus would send.
    const already = current(etsyProduct('FAKE-SKU-3', 'red', { readiness_state_id: 5001 }), etsyProduct('FAKE-SKU-2', 'BLACK', { readiness_state_id: 5001 }))
    expect(etsyInventoryReplaceBody(plan, already)).toEqual({ body: already })
  })

  it('a listing with no variation property on Etsy has no rule to keep: its first variations take Nexus\'s rules', () => {
    const single: EtsyInventoryWrite = { products: [{ sku: 'FAKE-SKU-2', offerings: [{ price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5001 }] }],
      price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] }
    const out = etsyInventoryReplaceBody(compiledOf(withNew()), single)
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body).toMatchObject({ price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] })
    expect(out.body.products[0]).toMatchObject({ sku: 'FAKE-SKU-2', property_values: [{ property_id: 200, values: ['Black'] }], offerings: [{ price: 24, quantity: 2 }] })
  })

  it('Etsy\'s rules map onto Nexus\'s variation properties: none stays none, every one stays every one, a few stay those few — or the line is refused', () => {
    const own = etsyOwnRules([100, 200], [5001, 5001])
    expect(own).toEqual({ price_on_property: [100, 200], quantity_on_property: [100, 200], sku_on_property: [100, 200], readiness_state_on_property: [] })
    expect(etsyKeptRules({ price_on_property: [200], quantity_on_property: [513, 200], sku_on_property: [200, 513] }, [200, 513], [100, 200], own))
      .toEqual({ rules: { price_on_property: [200], quantity_on_property: [100, 200], sku_on_property: [100, 200], readiness_state_on_property: [] } })
    expect(etsyKeptRules({ quantity_on_property: [513] }, [200, 513], [100, 200], own)).toEqual({ refusal: 'On Etsy this listing\'s stock number varies by a property '
      + 'its variations in Nexus no longer have, and Nexus does not change that rule. Change it on Etsy first, then review again.' })
    expect(etsyKeptRules({}, [], [100, 200], own)).toEqual({ rules: own })
  })

  it('a rule over some properties groups the variations by those values; a SKU Etsy shares cannot take Nexus\'s own SKUs', () => {
    const names = new Map([[100, 'Size'], [200, 'Primary color']])
    const row = (sku: string, color: string, size: string, quantity: number, isNew = false): EtsyRuleProduct => ({ sku, values: [{ property_id: 200, values: [color] }, { property_id: 100, values: [size] }],
      price: 24, quantity, readiness: 5001, sets: { price: isNew, quantity: isNew, sku: isNew, readiness: isNew } })
    const rows = [row('FAKE-SKU-11', 'Black', 'S', 5), row('FAKE-SKU-12', 'Black', 'M', 5), row('FAKE-SKU-13', 'Red', 'S', 2), row('FAKE-SKU-14', 'black', 'L', 4, true), row('FAKE-SKU-15', 'Green', 'S', 9, true)]
    expect(etsyRuleConflicts(rows, { price_on_property: [], quantity_on_property: [200], sku_on_property: [100, 200], readiness_state_on_property: [] }, names)).toEqual([
      'FAKE-SKU-14: this Etsy listing shares one stock number across variations with the same Primary color, and Nexus does not change that rule. Nexus holds 4 for FAKE-SKU-14; '
        + 'the others with the same Primary color hold 5. Change the rule on Etsy first, then review again.'])
    expect(etsyRuleConflicts([row('FAKE-SKU-11', 'Black', 'S', 5), row('FAKE-SKU-14', 'Red', 'S', 5, true)], { price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] }, names))
      .toEqual(['FAKE-SKU-14: this Etsy listing shares one SKU across its variations, and Nexus does not change that rule. Nexus gives each variation its own SKU. Change the rule on Etsy first, then review again.'])
  })

  it('the read-back checks the rules too', () => {
    const plan = compileEtsyChanges(prepareEtsyChanges(facts, publication({ properties: [] }), new Map(), { full: true }), selectedIds(prepareEtsyChanges(facts, publication({ properties: [] }), new Map(), { full: true })))
    expect(etsyReadBackMismatches(plan, new Set(['inventory']), live())).toEqual([])
    expect(etsyReadBackMismatches(plan, new Set(['inventory']), live({ inventory: { ...live().inventory, quantity_on_property: [] } })))
      .toEqual(['Variations, SKUs and processing profile: Etsy holds something other than what Nexus sent.'])
  })
})

describe('E2 review round 2 — the processing-profile rule may widen; price, stock and SKU rules never', () => {
  const ONE_PROFILE = { price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] }
  /** Etsy shares one processing profile (5001); Nexus gives FAKE-SKU-3 its own (5002), and its side widens the rule (prepare does). */
  const twoProfiles = (structureRule: number[]) => publication({ live: live({ inventory: { ...live().inventory, ...ONE_PROFILE },
    offerings: { 'FAKE-SKU-2': { price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5001 }, 'FAKE-SKU-3': { price: 24, quantity: 1, is_enabled: true, readiness_state_id: 5001 } } }),
    structure: { ...STRUCTURE, ...ONE_PROFILE, readiness_state_on_property: structureRule, products: STRUCTURE.products.map(p => p.sku === 'FAKE-SKU-3' ? { ...p, readiness_state_id: 5002 } : p) } })

  it('a profile per variation on a listing that shares one is not refused: the line DIFFERS, can be sent, and the review says the rule changes', () => {
    const plan = prepareEtsyChanges(facts, twoProfiles([200]), new Map())
    expect(changeOf(plan, 'inventory')).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: true })
    expect(plan.fullIssues).toContainEqual({ severity: 'warning', field: 'inventory', message: ETSY_READINESS_RULE_CHANGE })
    expect(ETSY_READINESS_RULE_CHANGE).toBe('The variations\' processing profiles differ, and this Etsy listing shares one: Publish lets the processing profile vary by variation on Etsy. Prices and stock do not change.')
    // No rule change (one profile for all): no sentence.
    expect(prepareEtsyChanges(facts, publication(), new Map()).fullIssues ?? []).not.toContainEqual(expect.objectContaining({ message: ETSY_READINESS_RULE_CHANGE }))
  })

  it('the widening only where Etsy allows it: another rule over some properties keeps the refusal, in plain words', () => {
    const names = new Map([[100, 'Size'], [200, 'Primary color']])
    // Two Etsy variations whose processing profile Nexus changes to two different ones.
    const row = (sku: string, color: string, readiness: number): EtsyRuleProduct => ({ sku, values: [{ property_id: 200, values: [color] }, { property_id: 100, values: ['S'] }],
      price: 24, quantity: 2, readiness, sets: { price: false, quantity: false, sku: false, readiness: true } })
    const rows = [row('FAKE-SKU-11', 'Black', 5001), row('FAKE-SKU-12', 'Red', 5002)]
    const open = { price_on_property: [], quantity_on_property: [100, 200], sku_on_property: [100, 200], readiness_state_on_property: [] }
    expect(etsyFitReadiness(open, rows, [100, 200])).toEqual({ rules: { ...open, readiness_state_on_property: [100, 200] }, widened: true })
    const bySize = { ...open, quantity_on_property: [100] }
    expect(etsyFitReadiness(bySize, rows, [100, 200])).toEqual({ rules: bySize, widened: false })
    expect(etsyRuleConflicts(rows, bySize, names)).toEqual(['FAKE-SKU-11 and FAKE-SKU-12: this Etsy listing shares one processing profile across its variations, and Etsy does not let it vary '
      + 'beside this listing\'s price, stock and SKU rules. Nexus holds 5001 for FAKE-SKU-11 and 5002 for FAKE-SKU-12. Change the rule on Etsy first, then review again.'])
  })

  it('a shared price or stock number is still refused exactly as before', () => {
    const shared = { price_on_property: [], quantity_on_property: [], sku_on_property: [200], readiness_state_on_property: [] }
    const row = (sku: string, color: string, quantity: number, isNew: boolean): EtsyRuleProduct => ({ sku, values: [{ property_id: 200, values: [color] }], price: 24, quantity, readiness: 5001,
      sets: { price: isNew, quantity: isNew, sku: isNew, readiness: isNew } })
    expect(etsyRuleConflicts([row('FAKE-SKU-2', 'Black', 5, false), row('FAKE-SKU-4', 'White', 3, true)], shared, new Map([[200, 'Primary color']])))
      .toEqual(['FAKE-SKU-4: this Etsy listing shares one stock number across its variations, and Nexus does not change that rule. Nexus holds 3 for FAKE-SKU-4; the listing holds 5. Change the rule on Etsy first, then review again.'])
  })
})

// ── E3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('E3 — a new listing is created as an Etsy draft', () => {
  /** The create, compiled (its one line ticked). */
  const createCompiled = (source = created()) => { const plan = prepareEtsyChanges(facts, source, new Map()); return compileEtsyChanges(plan, [plan.changes[0].id]) }
  /** A fresh draft's inventory as the writer reads it: the one product Etsy makes with every new draft (no SKU, no property). */
  const placeholderProduct = { offerings: [{ price: 25, quantity: 6, is_enabled: true, readiness_state_id: 5001 }] }
  const freshDraft: EtsyInventoryWrite = { products: [placeholderProduct], price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] }

  it('the draft\'s inventory is Nexus\'s own, exactly: its price, stock, on/off and processing profile per variation, and Nexus\'s rules', () => {
    const plan = createCompiled()
    expect(etsyCreateInventoryBody(plan, freshDraft)).toEqual({ body: created().inventory })
    // A copy: the plan's own inventory is never handed to the writer.
    const out = etsyCreateInventoryBody(plan, freshDraft)
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body).not.toBe(plan.inventory)
    expect(out.body.products[0]).not.toBe(plan.inventory.products[0])
    // A SKU Nexus sends is no stranger either (and the draft's SKU-less first product goes).
    expect(etsyCreateInventoryBody(plan, current(etsyProduct('FAKE-SKU-2', 'Black')))).toEqual({ body: created().inventory })
  })

  it('anything else on the new draft is something Nexus did not make: refused by name, and nothing is sent', () => {
    const plan = createCompiled()
    expect(etsyCreateInventoryBody(plan, current(etsyProduct('FAKE-SKU-9', 'Green'))))
      .toEqual({ refusal: 'Etsy\'s new draft holds variation FAKE-SKU-9 that Nexus did not send. Nothing was sent.' })
    expect(etsyCreateInventoryBody(plan, current(etsyProduct('FAKE-SKU-9', 'Green'), etsyProduct('FAKE-SKU-8', 'Pink'), etsyProduct('FAKE-SKU-9', 'Blue'))))
      .toEqual({ refusal: 'Etsy\'s new draft holds variations FAKE-SKU-9 and FAKE-SKU-8 that Nexus did not send. Nothing was sent.' })
  })

  it('never applies a listing\'s "shared price or stock" rule: a fresh draft has nothing shared to multiply', () => {
    // Variations with different prices and stock: the update path would refuse them against a listing that shares one
    // price and one stock number; the create sends them as Nexus holds them, with Nexus's per-variation rules.
    const source = created({ inventory: { ...created().inventory, products: [COLOR('FAKE-SKU-2', 'Black', 1), { ...COLOR('FAKE-SKU-3', 'Red', 2), offerings: [{ price: 31, quantity: 9, is_enabled: true, readiness_state_id: 5001 }] }] } })
    const shared: EtsyInventoryWrite = { ...freshDraft, price_on_property: [], quantity_on_property: [] }
    const out = etsyCreateInventoryBody(createCompiled(source), shared)
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body.products.map(p => [p.sku, p.offerings[0].price, p.offerings[0].quantity])).toEqual([['FAKE-SKU-2', 25, 3], ['FAKE-SKU-3', 31, 9]])
    expect(out.body).toMatchObject(PER_VARIATION)
  })
})

describe('E3 — a listing that is a draft on Etsy, still holding Etsy\'s placeholder product', () => {
  /** What Etsy holds after a create whose variations step did not land: one product, no SKU, no property. */
  const placeholderLive = (extra: Partial<EtsyLiveListing> = {}) => live({ state: 'draft', unnamedProducts: 1, offerings: {},
    inventory: { properties: [], products: [{ sku: '', values: [], readiness_state_id: 5001 }], price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] }, ...extra })
  const placeholderInventory: EtsyInventoryWrite = { products: [{ offerings: [{ price: 25, quantity: 1, is_enabled: true, readiness_state_id: 5001 }] }],
    price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] }

  it('is recognised only as the one SKU-less, property-less product of a draft', () => {
    expect(etsyDraftPlaceholder(placeholderLive())).toBe(true)
    expect(etsyDraftPlaceholder(placeholderLive({ state: 'active' }))).toBe(false)
    expect(etsyDraftPlaceholder(placeholderLive({ unnamedProducts: 2, inventory: { ...placeholderLive().inventory, products: [placeholderLive().inventory.products[0], placeholderLive().inventory.products[0]] } }))).toBe(false)
    expect(etsyDraftPlaceholder(placeholderLive({ inventory: { ...placeholderLive().inventory, properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }] } }))).toBe(false)
    expect(etsyDraftPlaceholder(live({ state: 'draft' }))).toBe(false)
  })

  it('the variations line is not refused, and the PUT replaces the placeholder (said in its note) — no Full update needed', () => {
    const source = publication({ live: placeholderLive() })
    const plan = prepareEtsyChanges(facts, source, new Map())
    const line = changeOf(plan, 'inventory')
    expect(line).toMatchObject({ selectable: true, selectedByDefault: true })
    expect(line.reason ?? '').not.toContain('without a SKU')
    const compiled = compileEtsyChanges(plan, idsOf(plan, 'inventory'))
    expect(compiled).toMatchObject({ removeUnnamed: true, removeSkus: [], addedSkus: ['FAKE-SKU-2', 'FAKE-SKU-3'] })
    expect(compiled.request!.calls.at(-1)!.note).toBe('new variations FAKE-SKU-2 and FAKE-SKU-3. Publish replaces this draft\'s one product without a SKU (Etsy\'s first product, if the draft still holds it).')
    // At send: the placeholder goes and Nexus's variations take its place with Nexus's own offering and rules.
    const out = etsyInventoryReplaceBody(compiled, placeholderInventory)
    if (!('body' in out)) throw new Error(out.refusal)
    expect(out.body.products.map(p => [p.sku, p.offerings[0].price, p.offerings[0].quantity])).toEqual([['FAKE-SKU-2', 25, 3], ['FAKE-SKU-3', 25, 3]])
    expect(out.body).toMatchObject(PER_VARIATION)
    // A Full update says it once too (the placeholder, not "a variation without a SKU" as well).
    const fullPlan = prepareEtsyChanges(facts, source, new Map(), { full: true })
    const full = compileEtsyChanges(fullPlan, selectedIds(fullPlan))
    expect(full.removeUnnamed).toBe(true)
    expect(full.request!.calls.at(-1)!.note).toBe('new variations FAKE-SKU-2 and FAKE-SKU-3. Publish replaces this draft\'s one product without a SKU (Etsy\'s first product, if the draft still holds it).')
  })

  it('a SKU-less product on a listing that is not a draft is still refused (a send would delete it)', () => {
    const active = placeholderLive({ state: 'active' })
    const plan = prepareEtsyChanges(facts, publication({ live: active }), new Map())
    expect(changeOf(plan, 'inventory')).toMatchObject({ selectable: false, reason: expect.stringContaining('Etsy holds 1 variation without a SKU; sending the variations would delete it on Etsy.') })
    // And a draft holding more than the placeholder keeps E2's rule too.
    const more = placeholderLive({ unnamedProducts: 1, inventory: { ...placeholderLive().inventory, products: [...placeholderLive().inventory.products, { sku: 'FAKE-SKU-9', values: [], readiness_state_id: 5001 }] } })
    expect(changeOf(prepareEtsyChanges(facts, publication({ live: more }), new Map()), 'inventory')).toMatchObject({ selectable: false })
  })
})

describe('E3 — the create\'s read-back skips what Etsy never reports', () => {
  it('skipUnread leaves out a listing field Etsy\'s read does not report (production partners), only when asked', () => {
    const plan = compileEtsyChanges(prepareEtsyChanges(facts, created(), new Map()), [prepareEtsyChanges(facts, created(), new Map()).changes[0].id])
    const after = live({ values: { ...VALUES, production_partner_ids: [] } })
    expect(etsyReadBackMismatches(plan, new Set(['production_partner_ids', 'title']), after)).toEqual(['Production partner IDs: Etsy holds something other than what Nexus sent.'])
    expect(etsyReadBackMismatches(plan, new Set(['production_partner_ids', 'title']), after, { skipUnread: true })).toEqual([])
    // A field Etsy does report is still judged.
    expect(etsyReadBackMismatches(plan, new Set(['title']), live({ values: { ...VALUES, title: 'Other' } }), { skipUnread: true })).toEqual(['Title: Etsy holds something other than what Nexus sent.'])
  })
})
