/**
 * E3 — `createEtsyDraftListing`: a NEW listing created on Etsy as a draft (createDraftListing, R1 §1). Form-encoded, the
 * shop from the account, through the write client (the gateway), never repeated, no push lock. The form is checked
 * against Etsy's published rules first (`etsyDraftListingFields`): a refusal sends nothing. The write client is stubbed,
 * so nothing leaves the process. Fake ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  answer: null as unknown,
  sendThrows: null as Error | null,
}))
vi.mock('./write-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./write-client.js')>()),
  etsyWriter: vi.fn(async () => ({
    shopId: '90000001',
    send: vi.fn(async (input: Record<string, unknown>) => {
      h.sends.push(input)
      if (h.sendThrows) throw h.sendThrows
      return structuredClone(h.answer)
    }),
  })),
}))

import { createEtsyDraftListing } from './listing-write.service.js'
import { EtsyListingContentError, etsyDraftListingFields } from './listing-content.js'
import { encodeEtsyForm, etsyWriter } from './write-client.js'

/** A complete draft form, as the studio's build makes it (`etsyCreateForm`). */
const form = (over: Record<string, unknown> = {}) => ({ quantity: 3, title: 'Guanti da moto', description: 'Pelle morbida', price: 49.9,
  who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 1234, is_supply: false, type: 'physical', tags: ['guanti', 'moto'], materials: ['pelle'],
  styles: ['Moderno'], shipping_profile_id: 70000001, readiness_state_id: 80000001, item_weight: 250, item_weight_unit: 'g', is_taxable: true, ...over })
const create = (over: Record<string, unknown> = {}, input: { acceptAutoRenewCharge?: boolean } = {}) =>
  createEtsyDraftListing({ accountId: 'etsy-account-1', form: form(over), ledger: { productId: 'family', triggeredBy: 'api' }, ...input })

beforeEach(() => { h.sends = []; h.answer = { listing_id: 9000000001, state: 'draft', shop_id: 90000001 }; h.sendThrows = null })
afterEach(() => { vi.clearAllMocks() })

describe('E3 createEtsyDraftListing — the POST', () => {
  it('ONE form-encoded POST to /shops/{the account\'s shop}/listings, kind write, the ledger, no push lock; returns Etsy\'s id and state', async () => {
    const created = await create()
    expect(created).toEqual({ listingId: '9000000001', state: 'draft' })
    expect(etsyWriter).toHaveBeenCalledWith('etsy-account-1')
    expect(h.sends).toHaveLength(1)
    const [sent] = h.sends
    expect(sent).toEqual({ path: '/shops/90000001/listings', method: 'POST', kind: 'write', operation: 'POST /shops/:id/listings',
      ledger: { productId: 'family', triggeredBy: 'api' }, form: form() })
    expect(sent).not.toHaveProperty('pushLock')
    expect(sent).not.toHaveProperty('body')
    // Lists go as repeated keys (OpenAPI's default for a form body; BELIEVED until the live test).
    const encoded = encodeEtsyForm(sent.form as never)
    expect(encoded).toContain('tags=guanti&tags=moto')
    expect(encoded).toContain('quantity=3')
    expect(encoded).toContain('price=49.9')
    expect(encoded).toContain('readiness_state_id=80000001')
  })

  it('a digit-string id is kept as text; a non-safe number, a zero, or no id at all is null (never a rounded 64-bit id)', async () => {
    h.answer = { listing_id: '12345678901234567890', state: 'draft' }
    expect(await create()).toEqual({ listingId: '12345678901234567890', state: 'draft' })
    h.answer = { listing_id: 2 ** 53 + 2, state: 'draft' }
    expect(await create()).toEqual({ listingId: null, state: 'draft' })
    h.answer = { listing_id: 0, state: 'draft' }
    expect((await create()).listingId).toBeNull()
    h.answer = { state: 'draft' }
    expect(await create()).toEqual({ listingId: null, state: 'draft' })
    h.answer = null
    expect(await create()).toEqual({ listingId: null, state: null })
    h.answer = { listing_id: 9000000001, state: '  ' }
    expect(await create()).toEqual({ listingId: '9000000001', state: null })
  })

  it('Etsy\'s refusal (or no answer) is thrown as the client raised it, and the POST was made exactly once', async () => {
    h.sendThrows = Object.assign(new Error('Etsy refused this change (HTTP 400): Invalid taxonomy.'), { name: 'EtsyWriteError', status: 400 })
    await expect(create()).rejects.toThrow('HTTP 400')
    expect(h.sends).toHaveLength(1)
  })
})

describe('E3 createEtsyDraftListing — 🔴 Etsy\'s rules before anything is sent', () => {
  it.each(['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id'])('Etsy\'s required %s missing → refused, nothing sent', async (key) => {
    await expect(create({ [key]: undefined })).rejects.toThrow(`Etsy needs ${key} to create a listing; nothing was sent.`)
    await expect(create({ [key]: null })).rejects.toThrow(`Etsy needs ${key} to create a listing; nothing was sent.`)
    expect(h.sends).toEqual([])
  })

  it.each([
    ['quantity 0', { quantity: 0 }, 'quantity from 1 to 999'],
    ['quantity 1000', { quantity: 1000 }, 'quantity from 1 to 999'],
    ['quantity 1.5', { quantity: 1.5 }, 'quantity from 1 to 999'],
    ['quantity as text', { quantity: '3' }, 'quantity from 1 to 999'],
    ['price 0', { price: 0 }, 'price above 0'],
    ['price NaN', { price: Number.NaN }, 'price above 0'],
    ['an empty description', { description: '   ' }, 'Etsy needs description'],
    ['an empty title', { title: '  ' }, 'title cannot be empty'],
    ['three styles', { styles: ['Moderno', 'Classico', 'Sportivo'] }, 'at most 2 styles'],
    ['a style over 45 characters', { styles: ['x'.repeat(46)] }, 'at most 45 characters'],
    ['a style with punctuation', { styles: ['Moderno!'] }, 'character «!» in a style'],
    ['a processing profile that is not an id', { readiness_state_id: 0 }, 'readiness_state_id'],
    ['state (a draft is what this makes)', { state: 'active' }, '«state»'],
    ['image_ids', { image_ids: [1] }, '«image_ids»'],
    ['sku', { sku: 'FAKE-SKU-1' }, '«sku»'],
    ['processing_min', { processing_min: 1 }, '«processing_min»'],
    ['a tag Etsy refuses', { tags: ['guanti!'] }, 'character «!» in a tag'],
    ['a when_made Etsy no longer takes', { when_made: '2020_2025' }, 'for when_made'],
    ['a listing type other than physical', { type: 'download' }, 'physical Etsy listings only'],
    ['classification without is_supply', { is_supply: undefined }, 'who_made, when_made and is_supply together'],
    ['a shipping profile that is not an id', { shipping_profile_id: -1 }, 'shipping_profile_id must be a positive whole number'],
    ['a weight of 0', { item_weight: 0 }, 'item_weight must be a number above 0'],
  ])('%s → refused, nothing sent', async (_name, over, words) => {
    const refused = await create(over).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(EtsyListingContentError)
    expect((refused as Error).message).toContain(words)
    expect((refused as Error).message).toMatch(/nothing was sent\.$/)
    expect(h.sends).toEqual([])
  })

  it('🔴 auto-renew (a recurring Etsy charge) needs the person\'s yes; turning it off needs none', async () => {
    await expect(create({ should_auto_renew: true })).rejects.toThrow('needs an explicit yes')
    expect(h.sends).toEqual([])
    await create({ should_auto_renew: true }, { acceptAutoRenewCharge: true })
    expect(h.sends[0].form).toMatchObject({ should_auto_renew: true })
    await create({ should_auto_renew: false })
    expect(h.sends).toHaveLength(2)
  })

  it('the shared keys get the update\'s own checks (one per-key checker): the title is trimmed, the update\'s refusals hold', () => {
    expect(etsyDraftListingFields(form({ title: '  Guanti da moto  ' })).title).toBe('Guanti da moto')
    expect(() => etsyDraftListingFields(form({ title: 'A & B & C' }))).toThrow('only once in a title')
    expect(() => etsyDraftListingFields(form({ production_partner_ids: [0] }))).toThrow('production partner ids')
    // The minimum Etsy takes: its seven required keys plus is_supply (classification together).
    expect(etsyDraftListingFields({ quantity: 1, title: 'T', description: 'D', price: 0.2, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 1, is_supply: false }))
      .toEqual({ quantity: 1, title: 'T', description: 'D', price: 0.2, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 1, is_supply: false })
  })
})
