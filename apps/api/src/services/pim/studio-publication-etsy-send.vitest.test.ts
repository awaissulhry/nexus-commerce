import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E2 (Etsy publisher) — `sendEtsyPublication` and `etsyPublicationResult`: the gate and a fresh read whose revision must
 * equal the review's, one write per call in the review's order with the journal written before each, never a repeated
 * write, a stop at the first problem, and VERIFIED only on a matching read-back.
 *
 * The change plan, its compile, the inventory body and the read-back comparison are REAL; the gate, the live read and
 * the Etsy writers are spies (the writers' own rules are tested in etsy/). Fake ids only: listing `9000000001`, SKUs
 * `FAKE-SKU-…`; the shop id never appears (paths keep `{shop_id}`).
 */
const m = vi.hoisted(() => ({
  mode: 'live' as string,
  /** What happened, in order: `journal <method> <fields>` and `write <what>`. */
  order: [] as string[],
  journal: [] as unknown[],
  read: vi.fn(),
  patch: vi.fn(),
  setProperty: vi.fn(),
  deleteProperty: vi.fn(),
  translation: vi.fn(),
  inventory: vi.fn(),
}))
vi.mock('../etsy-publish-gate.service.js', () => ({ getEtsyPublishMode: () => m.mode }))
vi.mock('../live-read/etsy.js', () => ({ readEtsyLive: m.read }))
vi.mock('../etsy/listing-write.service.js', () => ({ updateEtsyListingContent: m.patch, setEtsyListingProperty: m.setProperty,
  deleteEtsyListingProperty: m.deleteProperty, writeEtsyTranslation: m.translation }))
vi.mock('../etsy/inventory-write.service.js', () => ({ replaceEtsyInventory: m.inventory }))

import type { EtsyInventoryWrite } from '../etsy/inventory.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { etsyCreateForm } from './studio-publication-etsy-build.js'
import { compileEtsyChanges, prepareEtsyChanges, ETSY_LIVE_READ_NEEDED } from './studio-publication-etsy-changes.js'
import { etsyPublicationResult, sendEtsyPublication, ETSY_ALREADY_HOLDS, ETSY_CHANGED_AFTER_REVIEW, ETSY_CREATE_ELSEWHERE, ETSY_NOTHING_SELECTED, ETSY_SEND_DISABLED } from './studio-publication-etsy-send.js'
import type { EtsyChangePlan, EtsyCompiled, EtsyJournalRequest, EtsyListingValues, EtsyLiveListing, EtsyPublication } from './studio-publication-etsy-types.js'

const facts = {} as PublicationFacts
const VALUES: EtsyListingValues = {
  title: 'Leather knee slider', description: 'A hand-stitched knee slider.', tags: ['moto', 'knee'], materials: [], taxonomy_id: 1234,
  classification: { who_made: 'i_did', when_made: '2020_2026', is_supply: false }, type: 'physical', shop_section_id: null, shipping_profile_id: 7001, return_policy_id: null,
  item_weight: { value: null, unit: null }, item_dimensions: { length: null, width: null, height: null, unit: null }, is_taxable: null, should_auto_renew: null,
  production_partner_ids: [], styles: [],
}
const MATERIAL = { property_id: 47626759834, property_name: 'Material', value_ids: [300], values: ['Leather'], scale_id: null }
const COLOR = (sku: string, text: string, id: number) => ({ sku, property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [id], values: [text], scale_id: null }],
  offerings: [{ price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }] })
const AXIS = [{ property_id: 200, property_name: 'Primary color', scale_id: null }]
/** Each variation its own price, stock and SKU; one processing profile (the rules the live read states). */
const PER_VARIATION = { price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] }
const TRANSLATION = { language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] }

/** Etsy before the send: an older title, another material, no Italian text, and its own processing profile 5009. */
function before(extra: Partial<EtsyLiveListing> = {}): EtsyLiveListing {
  return {
    listingId: '9000000001', state: 'active', language: 'en', values: { ...VALUES, title: 'Old title' }, unread: { production_partner_ids: 'Etsy does not report production partners.' },
    properties: [{ ...MATERIAL, value_ids: [999], values: ['Suede'] }],
    inventory: { properties: AXIS, products: [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5009 },
      { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5009 }], ...PER_VARIATION },
    offerings: { 'FAKE-SKU-2': { price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5009 }, 'FAKE-SKU-3': { price: 24, quantity: 1, is_enabled: true, readiness_state_id: 5009 } },
    unnamedProducts: 0, translations: [], shop: { languages: ['en', 'it'], currencyCode: 'EUR' }, priceCurrencies: ['EUR'], revision: 'live-rev-1', ...extra,
  }
}
/** Etsy after the send, holding exactly what Nexus sent (its own value ids, tags in its own order). */
const after = (extra: Partial<EtsyLiveListing> = {}) => before({ values: { ...VALUES, tags: ['KNEE', 'moto'] }, properties: [{ ...MATERIAL, value_ids: [999], values: ['leather'] }],
  translations: [TRANSLATION], inventory: { properties: AXIS, products: [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 },
    { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5001 }], ...PER_VARIATION }, revision: 'live-rev-2', ...extra })

function publication(extra: Partial<EtsyPublication> = {}): EtsyPublication {
  return {
    kind: 'etsy', marketplace: 'GLOBAL', listingId: '9000000001', ownerProductId: 'p',
    products: [{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
    inventoryProducts: [{ productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
    values: VALUES, form: etsyCreateForm(VALUES, 5001, null),
    inventory: { products: [COLOR('FAKE-SKU-2', 'Black', 1), COLOR('FAKE-SKU-3', 'Red', 2)], price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] },
    structure: { properties: AXIS, products: [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 },
      { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5001 }], ...PER_VARIATION },
    properties: [MATERIAL], translations: [TRANSLATION], create: null, live: before(), liveRevision: 'live-rev-1', currency: 'EUR', ...extra,
  }
}
const lineIds = (plan: EtsyChangePlan, ...fields: string[]) => fields.map(field => plan.changes.find(change => change.field === field)!.id)
/** The reviewed plan compiled with these lines ticked (default: the title, the attribute, the translation and the variations). */
function compiled(fields = ['title', 'property:47626759834', 'translation:it', 'inventory'], source = publication(), options: { full?: boolean } = {}): EtsyCompiled {
  const plan = prepareEtsyChanges(facts, source, new Map(), options)
  return compileEtsyChanges(plan, options.full ? plan.changes.filter(change => change.selectedByDefault).map(change => change.id) : lineIds(plan, ...fields))
}
/** Etsy's inventory as the writer reads it under the lock (`toInventoryWrite`). */
const etsyInventory = (...skus: string[]): EtsyInventoryWrite => ({ products: skus.map((sku, i) => ({ sku,
  property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [90 + i], values: [sku === 'FAKE-SKU-2' ? 'Black' : sku === 'FAKE-SKU-3' ? 'Red' : 'Green'], scale_id: null }],
  offerings: [{ price: 24, quantity: 2 + i, is_enabled: true, readiness_state_id: 5009 }] })), price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] })
const etsyError = (status: number, message: string) => Object.assign(new Error(message), { name: 'EtsyWriteError', status })
const noAnswer = () => Object.assign(new Error('Etsy did not answer (PATCH /shops/:id/listings/:id): timeout'), { name: 'GatewayNoAnswer' })
const beforeSend = vi.fn(async (request: EtsyJournalRequest) => { m.journal.push(request); m.order.push(`journal ${request.method} ${request.fields.join('+')}`) })
const send = (plan: EtsyCompiled) => sendEtsyPublication(plan, 'acc-etsy', 'review-1', beforeSend, { readBackDelayMs: 0 })
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e) as (Error & { notSent?: boolean }) | null
  expect(error).toBeInstanceOf(Error)
  expect(error!.notSent).toBe(true)
  return error!.message
}
const writes = () => [m.patch, m.setProperty, m.deleteProperty, m.translation, m.inventory].reduce((sum, spy) => sum + spy.mock.calls.length, 0)

beforeEach(() => {
  m.mode = 'live'; m.order = []; m.journal = []
  beforeSend.mockClear().mockImplementation(async (request: EtsyJournalRequest) => { m.journal.push(request); m.order.push(`journal ${request.method} ${request.fields.join('+')}`) })
  m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after())
  m.patch.mockReset().mockImplementation(async () => { m.order.push('write listing'); return { sent: true, fields: {} } })
  m.setProperty.mockReset().mockImplementation(async () => { m.order.push('write property'); return { sent: true } })
  m.deleteProperty.mockReset().mockImplementation(async () => { m.order.push('write property delete'); return { sent: true } })
  m.translation.mockReset().mockImplementation(async (input: { translation: { language: string; title: string; description: string; tags: string[] }; beforeSend: (method: 'POST' | 'PUT', form: Record<string, unknown>) => Promise<void> }) => {
    const { title, description, tags } = input.translation
    await input.beforeSend('POST', { title, description, tags })
    m.order.push('write translation')
    return { sent: true, method: 'POST' }
  })
  m.inventory.mockReset().mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite; beforeSend: (body: EtsyInventoryWrite) => Promise<void> }) => {
    const current = etsyInventory('FAKE-SKU-2', 'FAKE-SKU-3')
    const body = input.build(current)
    await input.beforeSend(body)
    m.order.push('write inventory')
    return { sent: true, body, current, drift: [], confirmed: true }
  })
})

describe('refused before anything reaches Etsy (FAILED, "Nothing was submitted.")', () => {
  it('sending off, a new listing, no field, no review read, or a listing someone changed since the review: no write and no journal', async () => {
    m.mode = 'dry-run'
    expect(await refusal(send(compiled()))).toBe(ETSY_SEND_DISABLED)
    m.mode = 'live'
    // E3 — a create is the create step's (studio-publication-etsy-create.ts); this send refuses it, in plain words.
    expect(await refusal(send({ ...compiled(), listingId: null }))).toBe(ETSY_CREATE_ELSEWHERE)
    expect(ETSY_CREATE_ELSEWHERE).toBe('This review creates a new Etsy listing; the create step sends it.')
    expect(await refusal(send({ ...compiled(), request: null }))).toBe(ETSY_NOTHING_SELECTED)
    expect(await refusal(send({ ...compiled(), liveRevision: null }))).toBe(ETSY_LIVE_READ_NEEDED)
    expect(m.read).not.toHaveBeenCalled()
    m.read.mockReset().mockResolvedValue(before({ revision: 'live-rev-other' }))
    expect(await refusal(send(compiled()))).toBe(ETSY_CHANGED_AFTER_REVIEW)
    m.read.mockReset().mockRejectedValue(new Error('Etsy could not read this resource (HTTP 503).'))
    expect(await refusal(send(compiled()))).toBe('Nexus could not read the Etsy listing just before sending: Etsy could not read this resource (HTTP 503).')
    expect(writes()).toBe(0)
    expect(beforeSend).not.toHaveBeenCalled()
  })

  it('the first write refused by Etsy: not sent, in Etsy\'s words; nothing after it is tried', async () => {
    m.patch.mockRejectedValue(etsyError(400, 'Etsy refused this change (HTTP 400): There was a problem with /title/1 : cannot be more than 140 characters.'))
    expect(await refusal(send(compiled()))).toBe('Etsy refused this change (HTTP 400): There was a problem with /title/1 : cannot be more than 140 characters.')
    expect(m.order).toEqual(['journal PATCH title'])
    expect(writes()).toBe(1)
    expect(m.read).toHaveBeenCalledTimes(1)
  })

  it('the variations alone, refused by their build (Etsy gained a variation since the review): not sent, said once', async () => {
    m.inventory.mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite }) => { input.build(etsyInventory('FAKE-SKU-2', 'FAKE-SKU-3', 'FAKE-SKU-9')); return null })
    expect(await refusal(send(compiled(['inventory'])))).toBe('Etsy now holds variation FAKE-SKU-9 that Nexus does not; sending the variations would delete it. Review again.')
    expect(beforeSend).not.toHaveBeenCalled()
  })

  it('the variations alone, which Etsy already holds: not sent', async () => {
    m.inventory.mockImplementation(async () => ({ sent: false, body: etsyInventory('FAKE-SKU-2'), current: etsyInventory('FAKE-SKU-2'), drift: [], confirmed: true }))
    expect(await refusal(send(compiled(['inventory'])))).toBe(ETSY_ALREADY_HOLDS)
    expect(beforeSend).not.toHaveBeenCalled()
  })

  it('a journal that cannot be written before the first write: nothing is sent', async () => {
    beforeSend.mockRejectedValueOnce(new Error('An exact destination listing is missing or ambiguous; nothing was sent.'))
    expect(await refusal(send(compiled()))).toBe('An exact destination listing is missing or ambiguous.')
    expect(writes()).toBe(0)
  })
})

describe('sent', () => {
  it('each write is journalled first, in the review\'s order, with the exact body; the read-back matches: VERIFIED', async () => {
    const plan = compiled()
    const receipt = await send(plan)
    expect(m.order).toEqual(['journal PATCH title', 'write listing', 'journal PUT property:47626759834', 'write property',
      'journal POST translation:it', 'write translation', 'journal PUT inventory', 'write inventory'])
    expect(m.journal).toEqual([
      { operation: 'updateListing', method: 'PATCH', path: '/shops/{shop_id}/listings/9000000001', encoding: 'form', body: { title: 'Leather knee slider' }, fields: ['title'] },
      { operation: 'updateListing', method: 'PUT', path: '/shops/{shop_id}/listings/9000000001/properties/47626759834', encoding: 'form', body: { value_ids: [300], values: ['Leather'] },
        fields: ['property:47626759834'] },
      { operation: 'updateListing', method: 'POST', path: '/shops/{shop_id}/listings/9000000001/translations/it', encoding: 'form',
        body: { title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] }, fields: ['translation:it'] },
      // The body PUT exactly: Etsy's own values, price, stock and on/off read just now, Nexus's processing profile, Etsy's rules.
      { operation: 'updateListing', method: 'PUT', path: '/listings/9000000001/inventory', encoding: 'json', fields: ['inventory'], body: {
        products: [
          { sku: 'FAKE-SKU-2', property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [90], values: ['Black'], scale_id: null }], offerings: [{ price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5001 }] },
          { sku: 'FAKE-SKU-3', property_values: [{ property_id: 200, property_name: 'Primary color', value_ids: [91], values: ['Red'], scale_id: null }], offerings: [{ price: 24, quantity: 3, is_enabled: true, readiness_state_id: 5001 }] },
        ], price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] } },
    ])
    const ledger = { productId: 'p', triggeredBy: 'api' }
    expect(m.patch).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: '9000000001', content: { listing: { title: 'Leather knee slider' }, acceptAutoRenewCharge: false }, ledger })
    expect(m.setProperty).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: '9000000001', property: { propertyId: 47626759834, valueIds: [300], values: ['Leather'], scaleId: null }, ledger })
    expect(m.translation).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-etsy', listingId: '9000000001', ledger, translation: TRANSLATION }))
    // E3 — the writer may waive the stock rule only when Etsy itself says the listing is a draft (its own read, under the lock).
    expect(m.inventory).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-etsy', listingId: '9000000001', ledger, priceCurrency: 'EUR', readBackDelayMs: 0, allowDraftStock: true }))
    expect(m.read).toHaveBeenCalledTimes(2)
    expect(m.read).toHaveBeenLastCalledWith({ accountId: 'acc-etsy', listingId: '9000000001' })
    expect(receipt).toEqual({ reference: '9000000001', verified: true, mismatches: [], steps: [
      { label: 'Title', fields: ['title'], outcome: 'applied' }, { label: 'Material', fields: ['property:47626759834'], outcome: 'applied' },
      { label: 'Translation (it)', fields: ['translation:it'], outcome: 'applied' }, { label: 'Variations, SKUs and processing profile', fields: ['inventory'], outcome: 'applied' },
    ] })
    // Every journalled SKU exactly once.
    expect(etsyPublicationResult('review-1', plan, receipt)).toEqual({ id: 'review-1', status: 'VERIFIED', message: 'Etsy took the change to listing 9000000001, and the read-back matches.',
      results: ['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'].map(sku => ({ sku, status: 'VERIFIED', message: 'Read back from Etsy', reference: '9000000001' })) })
  })

  it('a refusal after a write landed stops the send: the rest is not sent, and the result is UNVERIFIED with each step named', async () => {
    m.setProperty.mockRejectedValue(etsyError(400, 'Etsy refused this change (HTTP 400): Property 47626759834 is not valid.'))
    const plan = compiled()
    const receipt = await send(plan)
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'refused', 'not-sent', 'not-sent'])
    expect(m.translation).not.toHaveBeenCalled()
    expect(m.inventory).not.toHaveBeenCalled()
    expect(m.read).toHaveBeenCalledTimes(2)
    expect(receipt.verified).toBe(false)
    const result = etsyPublicationResult('review-1', plan, receipt)
    expect(result).toMatchObject({ status: 'UNVERIFIED',
      message: 'Etsy took part of this change, or Nexus could not confirm it. Check listing 9000000001 on Etsy, mark this publication checked, then Publish again: Nexus sends only what still differs.' })
    expect(result.warnings).toEqual(['Sent and confirmed: Title.', 'Not sent: Material — Etsy refused this change (HTTP 400): Property 47626759834 is not valid.',
      'Not sent after that: Translation (it) and Variations, SKUs and processing profile.'])
    expect(result.results).toEqual(['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'].map(sku => ({ sku, status: 'ACCEPTED', message: 'Sent to Etsy; not confirmed', reference: '9000000001' })))
  })

  it('no answer to the PATCH: unknown (it may have landed), never sent again; the read-back still runs; UNVERIFIED', async () => {
    m.patch.mockRejectedValue(noAnswer())
    const plan = compiled()
    const receipt = await send(plan)
    expect(m.patch).toHaveBeenCalledTimes(1)
    expect(receipt.steps.map(step => step.outcome)).toEqual(['unknown', 'not-sent', 'not-sent', 'not-sent'])
    expect(m.read).toHaveBeenCalledTimes(2)
    expect(etsyPublicationResult('review-1', plan, receipt).warnings).toEqual(['Not confirmed by Etsy: Title — Etsy did not answer. It may have landed.',
      'Not sent after that: Material, Translation (it) and Variations, SKUs and processing profile.'])
  })

  it('Etsy answering 5xx or 429 is unknown too; a translation with no answer is called once', async () => {
    m.patch.mockRejectedValue(etsyError(503, 'Etsy refused this change (HTTP 503).'))
    expect((await send(compiled(['title']))).steps[0]).toEqual({ label: 'Title', fields: ['title'], outcome: 'unknown', message: 'Etsy answered HTTP 503.' })
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after())
    m.translation.mockImplementation(async (input: { beforeSend: (method: 'POST' | 'PUT', form: Record<string, unknown>) => Promise<void> }) => { await input.beforeSend('PUT', {}); throw etsyError(429, 'Etsy refused this change (HTTP 429).') })
    const receipt = await send(compiled(['translation:it']))
    expect(receipt.steps[0]).toMatchObject({ outcome: 'unknown', message: 'Etsy answered HTTP 429.' })
    expect(m.translation).toHaveBeenCalledTimes(1)
  })

  it('a translation whose GET fails (before any write) is refused, not unknown', async () => {
    m.translation.mockRejectedValue(Object.assign(new Error('Etsy did not answer (GET /shops/:id/listings/:id/translations/:lang): timeout'), { name: 'GatewayNoAnswer' }))
    const receipt = await send(compiled(['title', 'translation:it']))
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'refused'])
  })

  it('a journal that fails at the second step stops the send there: that write is never made; UNVERIFIED', async () => {
    beforeSend.mockImplementationOnce(async (request: EtsyJournalRequest) => { m.journal.push(request) }).mockRejectedValueOnce(new Error('The publication journal identity or destination changed.'))
    const receipt = await send(compiled())
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'refused', 'not-sent', 'not-sent'])
    expect(receipt.steps[1].message).toBe('The publication journal identity or destination changed.')
    expect(m.setProperty).not.toHaveBeenCalled()
    expect(receipt.verified).toBe(false)
  })

  it('a read-back that differs, or cannot be read, is never VERIFIED', async () => {
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after({ values: { ...VALUES, title: 'Old title' } }))
    const plan = compiled()
    const receipt = await send(plan)
    expect(receipt).toMatchObject({ verified: false, mismatches: ['Title: Etsy holds something other than what Nexus sent.'] })
    expect(etsyPublicationResult('review-1', plan, receipt).warnings).toEqual(['Sent: Title, Material, Translation (it) and Variations, SKUs and processing profile.',
      'Title: Etsy holds something other than what Nexus sent.'])
    m.read.mockReset().mockResolvedValueOnce(before()).mockRejectedValue(new Error('Etsy could not read this resource (HTTP 500).'))
    const unread = await send(compiled(['title']))
    expect(unread).toMatchObject({ verified: false, readBackError: 'Nexus could not read the listing back from Etsy: Etsy could not read this resource (HTTP 500).' })
  })

  it('the variations\' own read-back (price, stock, on/off) and a read-back the writer could not make are mismatches', async () => {
    m.inventory.mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite; beforeSend: (body: EtsyInventoryWrite) => Promise<void> }) => {
      const body = input.build(etsyInventory('FAKE-SKU-2', 'FAKE-SKU-3'))
      await input.beforeSend(body)
      return { sent: true, body, current: body, confirmed: false, drift: [{ product: 'FAKE-SKU-2', offering: 1, field: 'quantity', sent: 2, found: 1 },
        { product: 'FAKE-SKU-3', offering: 1, field: 'is_enabled', sent: true, found: false }, { product: 'FAKE-SKU-3', offering: 1, field: 'price', sent: 24, found: 0 }] }
    })
    expect((await send(compiled(['inventory']))).mismatches).toEqual(['FAKE-SKU-2: stock sent 2, Etsy holds 1.', 'FAKE-SKU-3: sent shown, Etsy holds it hidden.', 'FAKE-SKU-3: price sent 24, Etsy holds 0.'])
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after())
    m.inventory.mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite; beforeSend: (body: EtsyInventoryWrite) => Promise<void> }) => {
      const body = input.build(etsyInventory('FAKE-SKU-2', 'FAKE-SKU-3'))
      await input.beforeSend(body)
      return { sent: true, body, current: body, confirmed: false, drift: null }
    })
    const receipt = await send(compiled(['inventory']))
    expect(receipt).toMatchObject({ verified: false, mismatches: ['The variations could not be read back.'] })
  })

  it('the variations Etsy already holds, beside a field that changed: the PUT is "unchanged", and the send is VERIFIED', async () => {
    m.inventory.mockImplementation(async () => ({ sent: false, body: etsyInventory('FAKE-SKU-2'), current: etsyInventory('FAKE-SKU-2'), drift: [], confirmed: true }))
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after({ inventory: before().inventory }))
    const receipt = await send(compiled(['title', 'inventory']))
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'unchanged'])
    expect(receipt.verified).toBe(true)
  })

  it('a Full update removes an attribute only Etsy holds (DELETE, journalled with no body); unchanged variations are not sent', async () => {
    const source = publication({ properties: [], live: before({ inventory: { ...before().inventory, products: before().inventory.products.map(p => ({ ...p, readiness_state_id: 5001 })) } }) })
    const plan = compiled([], source, { full: true })
    m.read.mockReset().mockResolvedValueOnce(source.live).mockResolvedValue(after({ properties: [] }))
    const receipt = await send(plan)
    expect(m.deleteProperty).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: '9000000001', propertyId: 47626759834, ledger: { productId: 'p', triggeredBy: 'api' } })
    expect(m.journal).toContainEqual({ operation: 'updateListing', method: 'DELETE', path: '/shops/{shop_id}/listings/9000000001/properties/47626759834', encoding: 'none', body: null, fields: ['property:47626759834'] })
    expect(receipt.steps.find(step => step.fields[0] === 'property:47626759834')).toEqual({ label: 'Material', fields: ['property:47626759834'], outcome: 'applied' })
    expect(receipt.verified).toBe(true)
    // E2 review B1 — the variations already match: no inventory PUT, and only the main row is journalled and named.
    expect(m.inventory).not.toHaveBeenCalled()
    expect(etsyPublicationResult('review-1', plan, receipt).results.map(result => result.sku)).toEqual(['FAKE-SKU-1'])
  })

  it('a ticked Automatic renewal is the person\'s yes to Etsy\'s renewal fee', async () => {
    const source = publication({ values: { ...VALUES, should_auto_renew: true } })
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after({ values: { ...VALUES, should_auto_renew: true } }))
    await send(compiled(['should_auto_renew'], source))
    expect(m.patch).toHaveBeenCalledWith(expect.objectContaining({ content: { listing: { should_auto_renew: true }, acceptAutoRenewCharge: true } }))
  })

  it('only the main row is journalled and named when the variations are not sent', async () => {
    const plan = compiled(['title'])
    const receipt = await send(plan)
    expect(etsyPublicationResult('review-1', plan, receipt).results).toEqual([{ sku: 'FAKE-SKU-1', status: 'VERIFIED', message: 'Read back from Etsy', reference: '9000000001' }])
    // The shop is never named: a path keeps the literal {shop_id} (the writer reads the shop from the account).
    expect(JSON.stringify(m.journal)).not.toContain('90000001')
    for (const request of m.journal as EtsyJournalRequest[]) expect(request.path).toMatch(/^\/(shops\/\{shop_id\}\/listings|listings)\/9000000001(\/|$)/)
  })
})

describe('E2 review m3 — a PUT or DELETE the write client may have repeated after no answer', () => {
  it('a DELETE answered 404 is already gone: applied, the send goes on, and the read-back decides', async () => {
    const source = publication({ properties: [], live: before({ inventory: { ...before().inventory, products: before().inventory.products.map(p => ({ ...p, readiness_state_id: 5001 })) } }) })
    const plan = compiled([], source, { full: true })
    m.read.mockReset().mockResolvedValueOnce(source.live).mockResolvedValue(after({ properties: [] }))
    m.deleteProperty.mockRejectedValue(etsyError(404, 'Etsy refused this change (HTTP 404): Not found.'))
    const receipt = await send(plan)
    expect(receipt.steps.find(step => step.fields[0] === 'property:47626759834')).toEqual({ label: 'Material', fields: ['property:47626759834'], outcome: 'applied',
      message: 'Etsy no longer holds it (HTTP 404).' })
    expect(receipt.steps.at(-1)!.outcome).toBe('applied')
    expect(receipt.verified).toBe(true)
    // Still there on the read-back: not verified.
    m.read.mockReset().mockResolvedValueOnce(source.live).mockResolvedValue(after())
    expect((await send(plan)).mismatches).toContain('Material: Etsy still holds it after Nexus removed it.')
  })

  it('any other 4xx to a PUT may answer a repeat of a call that landed: unknown, never "not sent" — even as the first step', async () => {
    m.setProperty.mockRejectedValue(etsyError(409, 'Etsy refused this change (HTTP 409): Conflict.'))
    const plan = compiled(['property:47626759834'])
    const receipt = await send(plan)
    expect(receipt.steps[0]).toEqual({ label: 'Material', fields: ['property:47626759834'], outcome: 'unknown',
      message: 'Etsy answered HTTP 409, possibly to a repeat of a call it had already applied.' })
    expect(etsyPublicationResult('review-1', plan, receipt)).toMatchObject({ status: 'UNVERIFIED',
      warnings: ['Not confirmed by Etsy: Material — Etsy answered HTTP 409, possibly to a repeat of a call it had already applied. It may have landed.'] })
  })

  it('a refusal Etsy makes before applying anything (400, 401, 403) stays refused; a PATCH or a POST is never repeated, so its 4xx is refused', async () => {
    m.setProperty.mockRejectedValue(etsyError(400, 'Etsy refused this change (HTTP 400): Invalid value.'))
    expect(await refusal(send(compiled(['property:47626759834'])))).toBe('Etsy refused this change (HTTP 400): Invalid value.')
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after())
    m.patch.mockRejectedValue(etsyError(404, 'Etsy refused this change (HTTP 404): Not found.'))
    expect(await refusal(send(compiled(['title'])))).toBe('Etsy refused this change (HTTP 404): Not found.')
    // A translation: a PUT (Etsy held the language) may be a repeat; a POST never is.
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after())
    m.translation.mockImplementation(async (input: { beforeSend: (method: 'POST' | 'PUT', form: Record<string, unknown>) => Promise<void> }) => { await input.beforeSend('PUT', {}); throw etsyError(409, 'Etsy refused this change (HTTP 409).') })
    expect((await send(compiled(['translation:it']))).steps[0].outcome).toBe('unknown')
    m.read.mockReset().mockResolvedValueOnce(before()).mockResolvedValue(after())
    m.translation.mockImplementation(async (input: { beforeSend: (method: 'POST' | 'PUT', form: Record<string, unknown>) => Promise<void> }) => { await input.beforeSend('POST', {}); throw etsyError(409, 'Etsy refused this change (HTTP 409).') })
    expect(await refusal(send(compiled(['translation:it'])))).toBe('Etsy refused this change (HTTP 409).')
  })
})
