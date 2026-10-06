import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E3 (Etsy publisher) — `sendEtsyCreate` and `etsyCreateResult`: a NEW listing created on Etsy as a draft. The gate and the
 * draft-only rule first; the studio's claim (the "creating" marker) before anything is sent; the journal before every
 * write; the POST made at most once and never repeated; the listing id stored on the family (`landed`) before anything
 * else is sent; an unknown outcome keeps the marker (`unknown`), a clear refusal removes it (`release`); VERIFIED only
 * on a matching read-back.
 *
 * The change plan, its compile, the create's inventory body, E2's step engine and the read-back comparison are REAL; the
 * gate, the live read and the Etsy writers are spies (the writers' own rules are tested in etsy/), and so are the
 * studio's hooks. Fake ids only: listing `9000000001`, SKUs `FAKE-SKU-…`; the shop id never appears (paths keep `{shop_id}`).
 */
const m = vi.hoisted(() => ({
  mode: 'live' as string,
  /** What happened, in order. */
  order: [] as string[],
  journal: [] as unknown[],
  read: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  setProperty: vi.fn(),
  deleteProperty: vi.fn(),
  translation: vi.fn(),
  inventory: vi.fn(),
}))
vi.mock('../etsy-publish-gate.service.js', () => ({ getEtsyPublishMode: () => m.mode }))
vi.mock('../live-read/etsy.js', () => ({ readEtsyLive: m.read }))
vi.mock('../etsy/listing-write.service.js', () => ({ createEtsyDraftListing: m.create, updateEtsyListingContent: m.patch, setEtsyListingProperty: m.setProperty,
  deleteEtsyListingProperty: m.deleteProperty, writeEtsyTranslation: m.translation }))
vi.mock('../etsy/inventory-write.service.js', () => ({ replaceEtsyInventory: m.inventory }))

import { ETSY_NEW_ACTIVE_NEEDS_PHOTO } from '@nexus/shared/listing-actions'
import type { EtsyInventoryWrite } from '../etsy/inventory.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { etsyCreateForm } from './studio-publication-etsy-build.js'
import { compileEtsyChanges, prepareEtsyChanges } from './studio-publication-etsy-changes.js'
import { etsyCreateResult, sendEtsyCreate, ETSY_CREATE_NO_FIELDS, ETSY_CREATE_NO_NUMBER, ETSY_CREATE_UNKNOWN, ETSY_NOT_A_CREATE } from './studio-publication-etsy-create.js'
import { ETSY_SEND_DISABLED } from './studio-publication-etsy-send.js'
import type { EtsyCompiled, EtsyCreateHooks, EtsyJournalRequest, EtsyListingValues, EtsyLiveListing, EtsyPublication, EtsySendReceipt } from './studio-publication-etsy-types.js'

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
/** Nexus's own rules for a listing it creates: each variation its own price, stock and SKU; one processing profile. */
const PER_VARIATION = { price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] }
const TRANSLATION = { language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] }
const STRUCTURE_PRODUCTS = [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 },
  { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5001 }]

/** A new family (main row FAKE-SKU-1, variations FAKE-SKU-2 and FAKE-SKU-3) to create as a draft. */
function createPublication(extra: Partial<EtsyPublication> = {}): EtsyPublication {
  const values = extra.values ?? VALUES
  return {
    kind: 'etsy', marketplace: 'GLOBAL', listingId: null, ownerProductId: 'p',
    products: [{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
    inventoryProducts: [{ productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
    values, form: etsyCreateForm(values, 5001, { price: 25, quantity: 6 }),
    inventory: { products: [COLOR('FAKE-SKU-2', 'Black', 1), COLOR('FAKE-SKU-3', 'Red', 2)], ...PER_VARIATION },
    structure: { properties: AXIS, products: STRUCTURE_PRODUCTS, ...PER_VARIATION },
    properties: [MATERIAL], translations: [TRANSLATION], create: { state: 'draft', price: 25, quantity: 6 }, live: null, liveRevision: null, currency: 'EUR', ...extra,
  }
}
/** The reviewed create, compiled (its one line ticked), exactly as the studio stores and sends it. */
function compiled(source = createPublication()): EtsyCompiled {
  const plan = prepareEtsyChanges(facts, source, new Map())
  return compileEtsyChanges(plan, [plan.changes[0].id])
}
/** Etsy after the create, holding exactly what Nexus sent (its own value ids, tags in its own order). */
const after = (extra: Partial<EtsyLiveListing> = {}): EtsyLiveListing => ({
  listingId: '9000000001', state: 'draft', language: 'en', values: { ...VALUES, tags: ['KNEE', 'moto'] }, unread: { production_partner_ids: 'Etsy does not report production partners.' },
  properties: [{ ...MATERIAL, value_ids: [999], values: ['leather'] }],
  inventory: { properties: AXIS, products: STRUCTURE_PRODUCTS, ...PER_VARIATION },
  offerings: { 'FAKE-SKU-2': { price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }, 'FAKE-SKU-3': { price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 } },
  unnamedProducts: 0, translations: [TRANSLATION], shop: { languages: ['en', 'it'], currencyCode: 'EUR' }, priceCurrencies: ['EUR'], revision: 'live-rev-1', ...extra,
})
/** A fresh draft's inventory, as the writer reads it under the lock: the one product Etsy makes with every new draft. */
const FRESH_DRAFT: EtsyInventoryWrite = { products: [{ offerings: [{ price: 25, quantity: 6, is_enabled: true, readiness_state_id: 5001 }] }],
  price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] }
const etsyError = (status: number, message: string) => Object.assign(new Error(message), { name: 'EtsyWriteError', status })
const noAnswer = () => Object.assign(new Error('Etsy did not answer (POST /shops/:id/listings): timeout'), { name: 'GatewayNoAnswer' })
const POST_FIELDS = ['title', 'description', 'tags', 'taxonomy_id', 'classification', 'type', 'shipping_profile_id']

const hooks = {
  claim: vi.fn<EtsyCreateHooks['claim']>(),
  beforeSend: vi.fn<EtsyCreateHooks['beforeSend']>(),
  landed: vi.fn<EtsyCreateHooks['landed']>(),
  unknown: vi.fn<EtsyCreateHooks['unknown']>(),
  release: vi.fn<EtsyCreateHooks['release']>(),
}
const send = (plan: EtsyCompiled) => sendEtsyCreate(plan, 'acc-etsy', 'review-1', hooks, { readBackDelayMs: 0 })
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e) as (Error & { notSent?: boolean }) | null
  expect(error).toBeInstanceOf(Error)
  expect(error!.notSent).toBe(true)
  return error!.message
}
const laterWrites = () => [m.patch, m.setProperty, m.deleteProperty, m.translation, m.inventory].reduce((sum, spy) => sum + spy.mock.calls.length, 0)

beforeEach(() => {
  m.mode = 'live'; m.order = []; m.journal = []
  hooks.claim.mockReset().mockImplementation(async () => { m.order.push('claim') })
  hooks.beforeSend.mockReset().mockImplementation(async (request: EtsyJournalRequest) => { m.journal.push(request); m.order.push(`journal ${request.method} ${request.path}`) })
  hooks.landed.mockReset().mockImplementation(async (listingId: string) => { m.order.push(`landed ${listingId}`) })
  hooks.unknown.mockReset().mockImplementation(async () => { m.order.push('unknown') })
  hooks.release.mockReset().mockImplementation(async () => { m.order.push('release') })
  m.read.mockReset().mockResolvedValue(after())
  m.create.mockReset().mockImplementation(async () => { m.order.push('write POST'); return { listingId: '9000000001', state: 'draft' } })
  m.patch.mockReset()
  m.deleteProperty.mockReset()
  m.setProperty.mockReset().mockImplementation(async () => { m.order.push('write property'); return { sent: true } })
  m.translation.mockReset().mockImplementation(async (input: { translation: { title: string; description: string; tags: string[] }; beforeSend: (method: 'POST' | 'PUT', form: Record<string, unknown>) => Promise<void> }) => {
    const { title, description, tags } = input.translation
    await input.beforeSend('POST', { title, description, tags })
    m.order.push('write translation')
    return { sent: true, method: 'POST' }
  })
  m.inventory.mockReset().mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite; beforeSend: (body: EtsyInventoryWrite) => Promise<void> }) => {
    const body = input.build(FRESH_DRAFT)
    await input.beforeSend(body)
    m.order.push('write inventory')
    return { sent: true, body, current: FRESH_DRAFT, drift: [], confirmed: true }
  })
})

describe('refused before anything reaches Etsy (FAILED, "Nothing was submitted.")', () => {
  it('sending off: not sent, and the marker is never written', async () => {
    m.mode = 'dry-run'
    expect(await refusal(send(compiled()))).toBe(ETSY_SEND_DISABLED)
    expect(hooks.claim).not.toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
  })

  it('Active is refused until photos can be sent: the photo sentence, the marker never written', async () => {
    expect(await refusal(send(compiled(createPublication({ create: { state: 'active', price: 25, quantity: 6 } }))))).toBe(ETSY_NEW_ACTIVE_NEEDS_PHOTO)
    expect(hooks.claim).not.toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
  })

  it('anything that is not a create, or a call that does not name its fields: not sent', async () => {
    const plan = compiled()
    expect(await refusal(send({ ...plan, listingId: '9000000001' }))).toBe(ETSY_NOT_A_CREATE)
    expect(await refusal(send({ ...plan, request: { ...plan.request!, operation: 'updateListing' } }))).toBe(ETSY_NOT_A_CREATE)
    expect(await refusal(send({ ...plan, request: { ...plan.request!, calls: plan.request!.calls.slice(1) } }))).toBe(ETSY_NOT_A_CREATE)
    expect(await refusal(send({ ...plan, request: null }))).toBe(ETSY_NOT_A_CREATE)
    expect(await refusal(send({ ...plan, create: null }))).toBe(ETSY_NOT_A_CREATE)
    expect(await refusal(send({ ...plan, request: { ...plan.request!, calls: plan.request!.calls.map((call, i) => i === 2 ? { ...call, fields: undefined } : call) } }))).toBe(ETSY_CREATE_NO_FIELDS)
    expect(ETSY_NOT_A_CREATE).toBe('This is not a new Etsy listing. Review again.')
    expect(ETSY_CREATE_NO_FIELDS).toBe('This Etsy request does not say which fields it writes. Review again.')
    expect(hooks.claim).not.toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
  })

  it('the claim refused (a create already open, a listing number already here): its words, no journal, no POST', async () => {
    hooks.claim.mockRejectedValue(new Error('This Etsy listing already has a listing number in Nexus. Review again. Nothing was sent.'))
    expect(await refusal(send(compiled()))).toBe('This Etsy listing already has a listing number in Nexus. Review again.')
    expect(hooks.beforeSend).not.toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
    expect(hooks.release).not.toHaveBeenCalled()
  })

  it('the POST\'s journal cannot be written: the marker is released, and the POST is never made', async () => {
    hooks.beforeSend.mockRejectedValueOnce(new Error('An exact destination listing is missing or ambiguous; nothing was sent.'))
    expect(await refusal(send(compiled()))).toBe('An exact destination listing is missing or ambiguous.')
    expect(m.create).not.toHaveBeenCalled()
    expect(m.order).toEqual(['claim', 'release'])
  })

  it('Etsy refuses the POST (400): the marker is released, not sent, in Etsy\'s words; nothing else is tried', async () => {
    m.create.mockRejectedValue(etsyError(400, 'Etsy refused this change (HTTP 400): There was a problem with /title/1 : cannot be more than 140 characters.'))
    expect(await refusal(send(compiled()))).toBe('Etsy refused this change (HTTP 400): There was a problem with /title/1 : cannot be more than 140 characters.')
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.order).toEqual(['claim', 'journal POST /shops/{shop_id}/listings', 'release'])
    expect(hooks.landed).not.toHaveBeenCalled()
    expect(hooks.unknown).not.toHaveBeenCalled()
    expect(laterWrites()).toBe(0)
    expect(m.read).not.toHaveBeenCalled()
  })

  it('Etsy\'s rate limit (429), the gateway\'s hold and the form\'s own checks: nothing was applied, so the marker is released', async () => {
    for (const error of [etsyError(429, 'Etsy refused this change (HTTP 429). Retry after the Etsy rate limit resets.'),
      Object.assign(new Error('Nothing was sent to Etsy: Etsy publishing is switched off.'), { name: 'GatewayRefusal', statusCode: 503 }),
      Object.assign(new Error('Etsy needs taxonomy_id to create a listing; nothing was sent.'), { name: 'EtsyListingContentError' })]) {
      hooks.release.mockClear(); m.create.mockReset().mockRejectedValue(error)
      await refusal(send(compiled()))
      expect(hooks.release).toHaveBeenCalledTimes(1)
      expect(m.create).toHaveBeenCalledTimes(1)
    }
    expect(hooks.unknown).not.toHaveBeenCalled()
    expect(hooks.landed).not.toHaveBeenCalled()
  })

  it('a release that cannot be written is only logged: the person still reads Etsy\'s refusal', async () => {
    m.create.mockRejectedValue(etsyError(403, 'Etsy refused this change (HTTP 403): Forbidden.'))
    hooks.release.mockRejectedValue(new Error('database unreachable'))
    expect(await refusal(send(compiled()))).toBe('Etsy refused this change (HTTP 403): Forbidden.')
  })
})

describe('sent', () => {
  it('claim → journal → POST once → the id on the family → the variations, the attribute, the translation, each journalled first → read back: VERIFIED', async () => {
    const plan = compiled()
    const receipt = await send(plan)
    expect(m.order).toEqual(['claim', 'journal POST /shops/{shop_id}/listings', 'write POST', 'landed 9000000001',
      'journal PUT /listings/9000000001/inventory', 'write inventory',
      'journal PUT /shops/{shop_id}/listings/9000000001/properties/47626759834', 'write property',
      'journal POST /shops/{shop_id}/listings/9000000001/translations/it', 'write translation'])
    // The marker records the publish, the title and the SKUs sent.
    expect(hooks.claim).toHaveBeenCalledWith({ reviewId: 'review-1', title: 'Leather knee slider', skus: ['FAKE-SKU-2', 'FAKE-SKU-3'] })
    // The POST: the review's exact form, journalled as createDraftListing; made once.
    const form = { ...createPublication().form, quantity: 6, price: 25 }
    expect(m.journal[0]).toEqual({ operation: 'createDraftListing', method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: form, fields: POST_FIELDS })
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.create).toHaveBeenCalledWith({ accountId: 'acc-etsy', form, acceptAutoRenewCharge: false, ledger: { productId: 'p', triggeredBy: 'api' } })
    expect(hooks.landed).toHaveBeenCalledWith('9000000001')
    // The variations: Nexus's own inventory replaces the draft's first product; the writer may waive the stock rule for a draft.
    expect(m.journal[1]).toEqual({ operation: 'createDraftListing', method: 'PUT', path: '/listings/9000000001/inventory', encoding: 'json', body: createPublication().inventory, fields: ['inventory'] })
    expect(m.inventory).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-etsy', listingId: '9000000001', allowDraftStock: true, priceCurrency: 'EUR', readBackDelayMs: 0,
      ledger: { productId: 'p', triggeredBy: 'api' } }))
    expect(m.setProperty).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: '9000000001', property: { propertyId: 47626759834, valueIds: [300], values: ['Leather'], scaleId: null },
      ledger: { productId: 'p', triggeredBy: 'api' } })
    expect(m.translation).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-etsy', listingId: '9000000001', translation: TRANSLATION }))
    expect((m.journal as EtsyJournalRequest[]).every(request => request.operation === 'createDraftListing')).toBe(true)
    // The shop is never named: paths keep the literal {shop_id}; the listing id Etsy answered replaces {listing_id}.
    expect(JSON.stringify(m.journal)).not.toContain('90000001')
    expect(JSON.stringify(m.journal)).not.toContain('{listing_id}')
    expect(m.read).toHaveBeenCalledTimes(1)
    expect(m.read).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: '9000000001' })
    expect(receipt).toEqual({ reference: '9000000001', verified: true, mismatches: [], created: { listingId: '9000000001', state: 'draft' }, steps: [
      { label: 'Create the draft listing', fields: POST_FIELDS, outcome: 'applied' },
      { label: 'Variations, SKUs and processing profile', fields: ['inventory'], outcome: 'applied' },
      { label: 'Material', fields: ['property:47626759834'], outcome: 'applied' },
      { label: 'Translation (it)', fields: ['translation:it'], outcome: 'applied' },
    ] })
    expect(hooks.unknown).not.toHaveBeenCalled()
    expect(hooks.release).not.toHaveBeenCalled()
    expect(etsyCreateResult('review-1', plan, receipt)).toEqual({ id: 'review-1', status: 'VERIFIED',
      message: 'Etsy created draft listing 9000000001, and the read-back matches. It is a draft: buyers cannot see it.',
      results: ['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'].map(sku => ({ sku, status: 'VERIFIED', message: 'Read back from Etsy', reference: '9000000001' })) })
  })

  it('a ticked Automatic renewal is the person\'s yes to Etsy\'s renewal fee', async () => {
    const values = { ...VALUES, should_auto_renew: true }
    m.read.mockResolvedValue(after({ values: { ...values, tags: ['KNEE', 'moto'] } }))
    await send(compiled(createPublication({ values })))
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ acceptAutoRenewCharge: true }))
  })

  it('production partners are sent, but Etsy never reports them: VERIFIED, and named as unconfirmed', async () => {
    const values = { ...VALUES, production_partner_ids: [55] }
    const plan = compiled(createPublication({ values }))
    const receipt = await send(plan)
    expect(receipt.steps[0].fields).toContain('production_partner_ids')
    expect(receipt).toMatchObject({ verified: true, unconfirmed: ['Production partner IDs'] })
    expect(etsyCreateResult('review-1', plan, receipt)).toMatchObject({ status: 'VERIFIED',
      warnings: ['Production partner IDs: sent; Etsy does not report them, so Nexus could not confirm them.'] })
  })
})

describe('the POST\'s outcome is unknown: the marker stays, and nothing more is sent', () => {
  it('no answer: unknown once, never released, never repeated; no later write and no read-back', async () => {
    m.create.mockRejectedValue(noAnswer())
    const plan = compiled()
    const receipt = await send(plan)
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(hooks.unknown).toHaveBeenCalledTimes(1)
    expect(hooks.unknown).toHaveBeenCalledWith('Etsy did not answer the create.')
    expect(hooks.release).not.toHaveBeenCalled()
    expect(hooks.landed).not.toHaveBeenCalled()
    expect(laterWrites()).toBe(0)
    expect(m.read).not.toHaveBeenCalled()
    expect(receipt).toEqual({ reference: '', verified: false, mismatches: [], created: { listingId: null, state: null }, createUnknown: 'Etsy did not answer the create.', steps: [
      { label: 'Create the draft listing', fields: POST_FIELDS, outcome: 'unknown', message: 'Etsy did not answer the create.' },
      { label: 'Variations, SKUs and processing profile', fields: ['inventory'], outcome: 'not-sent' },
      { label: 'Material', fields: ['property:47626759834'], outcome: 'not-sent' },
      { label: 'Translation (it)', fields: ['translation:it'], outcome: 'not-sent' },
    ] })
    // No listing number: the journals stay open (SUBMITTED, no reference), and the person is told what to do.
    expect(etsyCreateResult('review-1', plan, receipt)).toEqual({ id: 'review-1', status: 'UNVERIFIED', message: ETSY_CREATE_UNKNOWN, warnings: ['Etsy did not answer the create.'],
      results: ['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'].map(sku => ({ sku, status: 'SUBMITTED', message: 'No clear answer from Etsy' })) })
    expect(ETSY_CREATE_UNKNOWN).toBe('Etsy gave no clear answer to the create, so Nexus does not know whether Etsy made the draft. Nexus will not create a second one: in Publish history, open this publish and choose Mark as checked — Nexus first looks for the draft in this shop\'s Etsy drafts and links it.')
  })

  it('Etsy answering 5xx is unknown too (it may have made the draft)', async () => {
    m.create.mockRejectedValue(etsyError(503, 'Etsy refused this change (HTTP 503).'))
    const receipt = await send(compiled())
    expect(receipt).toMatchObject({ reference: '', createUnknown: 'Etsy answered the create with HTTP 503.' })
    expect(hooks.unknown).toHaveBeenCalledWith('Etsy answered the create with HTTP 503.')
    expect(hooks.release).not.toHaveBeenCalled()
    expect(m.create).toHaveBeenCalledTimes(1)
  })

  it('an answer without a listing number: unknown, with the state Etsy answered', async () => {
    m.create.mockResolvedValue({ listingId: null, state: 'draft' })
    const receipt = await send(compiled())
    expect(receipt).toMatchObject({ reference: '', verified: false, created: { listingId: null, state: 'draft' }, createUnknown: ETSY_CREATE_NO_NUMBER })
    expect(hooks.unknown).toHaveBeenCalledWith(ETSY_CREATE_NO_NUMBER)
    expect(hooks.landed).not.toHaveBeenCalled()
    expect(laterWrites()).toBe(0)
  })

  it('a marker that cannot be set to unknown is only logged: the receipt still says unknown', async () => {
    m.create.mockRejectedValue(noAnswer())
    hooks.unknown.mockRejectedValue(new Error('database unreachable'))
    await expect(send(compiled())).resolves.toMatchObject({ reference: '', createUnknown: 'Etsy did not answer the create.' })
  })

  it('Etsy made the draft but Nexus could not store its number: unknown with that number, nothing more sent', async () => {
    hooks.landed.mockRejectedValue(new Error('Etsy listing 9000000001 is already linked to another product in Nexus; Nexus did not link it again.'))
    const plan = compiled()
    const receipt = await send(plan)
    const message = 'Etsy created listing 9000000001, but Nexus could not record it: Etsy listing 9000000001 is already linked to another product in Nexus; Nexus did not link it again.'
    expect(hooks.unknown).toHaveBeenCalledWith(message, '9000000001')
    expect(hooks.release).not.toHaveBeenCalled()
    expect(laterWrites()).toBe(0)
    expect(m.read).not.toHaveBeenCalled()
    expect(receipt).toMatchObject({ reference: '9000000001', verified: false, created: { listingId: '9000000001', state: 'draft' }, createUnknown: message })
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'not-sent', 'not-sent', 'not-sent'])
    expect(etsyCreateResult('review-1', plan, receipt)).toEqual({ id: 'review-1', status: 'UNVERIFIED', warnings: [message],
      message: 'Etsy created draft listing 9000000001, but Nexus could not record it on this family. Nexus will not create a second one: mark this publication checked in Publish history and Nexus links listing 9000000001.',
      results: ['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'].map(sku => ({ sku, status: 'SUBMITTED', message: 'Created on Etsy; not recorded in Nexus', reference: '9000000001' })) })
  })
})

describe('after the draft exists: a later problem stops the send, the draft stays, UNVERIFIED', () => {
  it('Etsy refuses the variations (400): the attribute and the translation are not sent; the read-back still runs', async () => {
    m.inventory.mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite; beforeSend: (body: EtsyInventoryWrite) => Promise<void> }) => {
      await input.beforeSend(input.build(FRESH_DRAFT))
      throw etsyError(400, 'Etsy refused this change (HTTP 400): All offerings need quantity.')
    })
    m.read.mockResolvedValue(after({ inventory: { properties: [], products: [{ sku: '', values: [], readiness_state_id: 5001 }], price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] },
      offerings: {}, unnamedProducts: 1, properties: [], translations: [] }))
    const plan = compiled()
    const receipt = await send(plan)
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'refused', 'not-sent', 'not-sent'])
    expect(m.setProperty).not.toHaveBeenCalled()
    expect(m.translation).not.toHaveBeenCalled()
    expect(m.read).toHaveBeenCalledTimes(1)
    expect(receipt).toMatchObject({ reference: '9000000001', verified: false })
    expect(hooks.unknown).not.toHaveBeenCalled()
    expect(hooks.release).not.toHaveBeenCalled()
    const result = etsyCreateResult('review-1', plan, receipt)
    expect(result).toMatchObject({ status: 'UNVERIFIED',
      message: 'Etsy created draft listing 9000000001, but Nexus could not confirm every part of it. Check the draft on Etsy, mark this publication checked, then Publish again: Nexus sends only what still differs.' })
    expect(result.warnings).toEqual(['Sent and confirmed: Create the draft listing.', 'Not sent: Variations, SKUs and processing profile — Etsy refused this change (HTTP 400): All offerings need quantity.',
      'Not sent after that: Material and Translation (it).'])
    expect(result.results).toEqual(['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'].map(sku => ({ sku, status: 'ACCEPTED', message: 'Sent to Etsy; not confirmed', reference: '9000000001' })))
  })

  it('the new draft holds something Nexus did not make: the variations are refused before their journal, nothing replaces it', async () => {
    m.inventory.mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite }) => {
      input.build({ ...FRESH_DRAFT, products: [{ sku: 'FAKE-SKU-9', offerings: [{ price: 25, quantity: 1, is_enabled: true, readiness_state_id: 5001 }] }] })
      return null
    })
    const receipt = await send(compiled())
    expect(receipt.steps[1]).toEqual({ label: 'Variations, SKUs and processing profile', fields: ['inventory'], outcome: 'refused',
      message: 'Etsy\'s new draft holds variation FAKE-SKU-9 that Nexus did not send.' })
    expect((m.journal as EtsyJournalRequest[]).map(request => request.method)).toEqual(['POST'])
    expect(receipt.verified).toBe(false)
  })

  it('no answer to the variations: unknown (it may have landed), never sent again; the rest is not sent', async () => {
    m.inventory.mockImplementation(async (input: { build: (current: EtsyInventoryWrite) => EtsyInventoryWrite; beforeSend: (body: EtsyInventoryWrite) => Promise<void> }) => {
      await input.beforeSend(input.build(FRESH_DRAFT))
      throw Object.assign(new Error('Etsy did not answer (PUT /listings/:id/inventory): timeout'), { name: 'GatewayNoAnswer' })
    })
    const receipt = await send(compiled())
    expect(m.inventory).toHaveBeenCalledTimes(1)
    expect(receipt.steps.map(step => step.outcome)).toEqual(['applied', 'unknown', 'not-sent', 'not-sent'])
    expect(receipt.reference).toBe('9000000001')
  })

  it('a read-back that differs, cannot be read, or shows the listing not as a draft is never VERIFIED', async () => {
    m.read.mockResolvedValue(after({ values: { ...VALUES, title: 'Other' } }))
    expect(await send(compiled())).toMatchObject({ verified: false, mismatches: ['Title: Etsy holds something other than what Nexus sent.'] })
    m.read.mockResolvedValue(after({ state: 'active' }))
    expect(await send(compiled())).toMatchObject({ verified: false, mismatches: ['Etsy reports this new listing as active, not as a draft.'] })
    m.read.mockRejectedValue(new Error('Etsy could not read this resource (HTTP 500).'))
    const unread = await send(compiled())
    expect(unread).toMatchObject({ verified: false, readBackError: 'Nexus could not read the new draft back from Etsy: Etsy could not read this resource (HTTP 500).' })
    expect(etsyCreateResult('review-1', compiled(), unread).warnings).toEqual([
      'Sent: Create the draft listing, Variations, SKUs and processing profile, Material and Translation (it).',
      'Nexus could not read the new draft back from Etsy: Etsy could not read this resource (HTTP 500).'])
  })
})

describe('etsyCreateResult — every SKU exactly once, in each of its four shapes', () => {
  it('a SKU two rows share is named once (the records settle matches results by SKU)', () => {
    const plan = { ...compiled(), products: [{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c9', sku: 'FAKE-SKU-2' }] }
    const steps: EtsySendReceipt['steps'] = [{ label: 'Create the draft listing', fields: ['title'], outcome: 'applied' }]
    const receipts: EtsySendReceipt[] = [
      { reference: '', verified: false, steps, mismatches: [], created: { listingId: null, state: null }, createUnknown: 'Etsy did not answer the create.' },
      { reference: '9000000001', verified: false, steps, mismatches: [], created: { listingId: '9000000001', state: 'draft' }, createUnknown: 'Etsy created listing 9000000001, but Nexus could not record it: x.' },
      { reference: '9000000001', verified: true, steps, mismatches: [], created: { listingId: '9000000001', state: 'draft' } },
      { reference: '9000000001', verified: false, steps, mismatches: ['Title: Etsy holds something other than what Nexus sent.'], created: { listingId: '9000000001', state: 'draft' } },
    ]
    const statuses = receipts.map(receipt => {
      const result = etsyCreateResult('review-1', plan, receipt)
      expect(result.results.map(entry => entry.sku)).toEqual(['FAKE-SKU-1', 'FAKE-SKU-2'])
      return [result.status, result.results[0].status]
    })
    expect(statuses).toEqual([['UNVERIFIED', 'SUBMITTED'], ['UNVERIFIED', 'SUBMITTED'], ['VERIFIED', 'VERIFIED'], ['UNVERIFIED', 'ACCEPTED']])
  })
})
