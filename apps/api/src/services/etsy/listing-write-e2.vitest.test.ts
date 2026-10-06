/**
 * E2 — the Etsy writers a studio send uses on a listing Etsy already holds: every `updateListing` field Nexus holds
 * (`listing`), one attribute (PUT / DELETE), one translation (GET decides POST or PUT). Etsy's rules come from its
 * OpenAPI document (R1 §1–§6); the write and read clients are stubbed, so nothing leaves the process. Fake ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  sends: [] as Array<Record<string, unknown>>,
  gets: [] as string[],
  /** The translation GET's answer: a status Etsy refuses with, or null for a 200. */
  readStatus: null as number | null,
}))
vi.mock('./write-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./write-client.js')>()),
  etsyWriter: vi.fn(async () => ({
    shopId: '90000001',
    send: vi.fn(async (input: Record<string, unknown>) => { h.order.push(`send ${String(input.method)}`); h.sends.push(input); return {} }),
  })),
}))
vi.mock('./read-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./read-client.js')>()
  return {
    ...original,
    etsyReader: vi.fn(async () => ({
      shopId: '90000001',
      get: vi.fn(async (path: string) => {
        h.order.push('get'); h.gets.push(path)
        if (h.readStatus !== null) throw new original.EtsyReadError(h.readStatus)
        return { listing_id: 9000000001, language: 'de', title: 'Alt', description: 'Alt', tags: [] }
      }),
    })),
  }
})

import { deleteEtsyListingProperty, setEtsyListingProperty, updateEtsyListingContent, writeEtsyTranslation } from './listing-write.service.js'
import { EtsyListingContentError, etsyListingContentFields } from './listing-content.js'
import { encodeEtsyForm } from './write-client.js'

beforeEach(() => { h.order = []; h.sends = []; h.gets = []; h.readStatus = null })
afterEach(() => { vi.clearAllMocks() })

const base = { accountId: 'etsy-account-1', listingId: '9000000001' }
const fields = (listing: Record<string, unknown>, extra: Record<string, unknown> = {}) => etsyListingContentFields({ listing: listing as never, ...extra })

describe('E2 — updateListing fields (`listing`)', () => {
  it('every field Nexus holds passes with Etsy\'s values', () => {
    const listing = { title: '  Guanti da moto  ', description: 'Pelle', tags: ['guanti', 'moto'], materials: ['pelle'], taxonomy_id: 1234,
      who_made: 'i_did', when_made: 'made_to_order', is_supply: false, type: 'physical', shop_section_id: 7, shipping_profile_id: 70000001,
      return_policy_id: 3, item_weight: 250, item_weight_unit: 'g', item_length: 30, item_width: 20, item_height: 1.5, item_dimensions_unit: 'cm',
      is_taxable: true, should_auto_renew: false, production_partner_ids: [11, 12] }
    expect(fields(listing)).toEqual({ ...listing, title: 'Guanti da moto' })
  })

  it('a unit may be "" (Etsy\'s clear); every other unit outside Etsy\'s list is refused, by name', () => {
    expect(fields({ item_weight: 1, item_weight_unit: '' })).toEqual({ item_weight: 1, item_weight_unit: '' })
    expect(fields({ item_length: 1, item_dimensions_unit: 'inches' })).toEqual({ item_length: 1, item_dimensions_unit: 'inches' })
    expect(() => fields({ item_weight_unit: 'ton' })).toThrow('Etsy does not take "ton" for item_weight_unit (it takes oz, lb, g, kg, or nothing to clear it); nothing was sent.')
    expect(() => fields({ item_dimensions_unit: 'km' })).toThrow('for item_dimensions_unit')
  })

  it.each([
    ['taxonomy_id', 0], ['taxonomy_id', 1.5], ['taxonomy_id', '1234'], ['shop_section_id', -1], ['shipping_profile_id', null], ['return_policy_id', 0],
  ])('%s = %p is refused: an id is a positive whole number', (key, value) => {
    expect(() => fields({ [key]: value })).toThrow(`Etsy ${key} must be a positive whole number; nothing was sent.`)
  })

  it.each([['item_weight', 0], ['item_length', -2], ['item_width', Number.NaN], ['item_height', Number.POSITIVE_INFINITY], ['item_weight', '250']])(
    '%s = %p is refused: a measure is a number above 0', (key, value) => {
      expect(() => fields({ [key]: value })).toThrow(`Etsy ${key} must be a number above 0; nothing was sent.`)
    })

  it.each([['is_supply', 'false'], ['is_taxable', 1], ['should_auto_renew', null]])('%s = %p is refused: true or false only', (key, value) => {
    expect(() => fields({ [key]: value, ...(key === 'is_supply' ? { who_made: 'i_did', when_made: 'made_to_order' } : {}) })).toThrow(`Etsy ${key} must be true or false; nothing was sent.`)
  })

  it('who_made and when_made are Etsy\'s own enums (its OpenAPI document, which rotates when_made yearly)', () => {
    expect(() => fields({ who_made: 'robot', when_made: 'made_to_order', is_supply: false })).toThrow('Etsy does not take "robot" for who_made')
    expect(() => fields({ who_made: 'i_did', when_made: '2020_2025', is_supply: false })).toThrow('Etsy does not take "2020_2025" for when_made')
  })

  it('who_made, when_made and is_supply go together (R1 §1) — one alone is refused', () => {
    expect(() => fields({ who_made: 'i_did' })).toThrow('Etsy takes who_made, when_made and is_supply together, and this change has only who_made; nothing was sent.')
    expect(fields({ who_made: 'someone_else', when_made: '2020_2026', is_supply: true })).toEqual({ who_made: 'someone_else', when_made: '2020_2026', is_supply: true })
  })

  it('type is physical only; production partners are positive whole numbers', () => {
    expect(() => fields({ type: 'download' })).toThrow('Nexus sends physical Etsy listings only, not "download"; nothing was sent.')
    expect(() => fields({ production_partner_ids: [1, 0] })).toThrow('Etsy production partner ids must be positive whole numbers; nothing was sent.')
    expect(() => fields({ production_partner_ids: 5 })).toThrow('production partner ids')
  })

  it('the text fields inside `listing` get the top level\'s checks (one helper)', () => {
    expect(() => fields({ title: 'Mug $9' })).toThrow('Etsy does not allow the character «$» in a title; nothing was sent.')
    expect(() => fields({ title: 'A & B & C' })).toThrow('only once in a title')
    expect(() => fields({ title: '   ' })).toThrow('An Etsy title cannot be empty; nothing was sent.')
    expect(() => fields({ tags: ['hand.made'] })).toThrow('in a tag')
    expect(() => fields({ materials: ['hand-made'] })).toThrow('in a material')
    expect(() => fields({ tags: ['ok', 3] })).toThrow('Etsy tags must be a list of words; nothing was sent.')
    expect(() => fields({ description: 5 })).toThrow('An Etsy description must be text; nothing was sent.')
  })

  it('the same key at both levels is refused: neither may silently win', () => {
    expect(() => etsyListingContentFields({ title: 'Mug', listing: { title: 'Cup' } })).toThrow('title came twice in one Etsy change; nothing was sent.')
    expect(() => etsyListingContentFields({ tags: null, listing: { tags: ['a'] } })).toThrow('tags came twice')
    // Different keys at the two levels are one change.
    expect(etsyListingContentFields({ title: 'Mug', listing: { description: 'Nice' } })).toEqual({ title: 'Mug', description: 'Nice' })
  })

  it('🔴 auto-renew ON needs the person\'s yes (a recurring Etsy charge); OFF needs none', () => {
    expect(() => fields({ should_auto_renew: true })).toThrow('Turning on auto-renew commits the shop to a recurring Etsy charge, so it needs an explicit yes; nothing was sent.')
    expect(() => fields({ should_auto_renew: true }, { acceptAutoRenewCharge: false })).toThrow(EtsyListingContentError)
    expect(fields({ should_auto_renew: true }, { acceptAutoRenewCharge: true })).toEqual({ should_auto_renew: true })
    expect(fields({ should_auto_renew: false })).toEqual({ should_auto_renew: false })
  })

  it.each(['state', 'image_ids', 'price', 'quantity', 'readiness_state_id', 'styles', 'sku', 'featured_rank'])(
    '🔴 «%s» is refused, never quietly dropped', (key) => {
      expect(() => fields({ title: 'Mug', [key]: key === 'state' ? 'active' : 1 })).toThrow(`Etsy's listing update does not take «${key}» from a content change; nothing was sent.`)
    })

  it('every refusal is the content error type, so a caller can tell it from Etsy\'s own refusal', () => {
    expect(() => fields({ taxonomy_id: 0 })).toThrow(EtsyListingContentError)
    expect(() => fields({ state: 'active' })).toThrow(EtsyListingContentError)
  })

  it('an empty `listing` is still "nothing to change"', () => {
    expect(() => fields({})).toThrow('There is nothing to change on this Etsy listing; nothing was sent.')
  })
})

describe('E2 — the PATCH on the wire', () => {
  it('one form-encoded PATCH; tags as repeated keys, booleans and numbers as text', async () => {
    await updateEtsyListingContent({ ...base, content: { listing: { tags: ['guanti', 'moto'], is_taxable: true, taxonomy_id: 1234, item_weight_unit: '' } } })
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]).toMatchObject({ path: '/shops/90000001/listings/9000000001', method: 'PATCH', kind: 'write', operation: 'PATCH /shops/:id/listings/:id',
      form: { tags: ['guanti', 'moto'], is_taxable: true, taxonomy_id: 1234, item_weight_unit: '' } })
    expect(h.sends[0].body).toBeUndefined()
    expect(h.sends[0].pushLock).toBeUndefined()
    expect(encodeEtsyForm(h.sends[0].form as never)).toBe('tags=guanti&tags=moto&is_taxable=true&taxonomy_id=1234&item_weight_unit=')
  })

  it('a refused field sends nothing', async () => {
    await expect(updateEtsyListingContent({ ...base, content: { listing: { title: 'Mug', state: 'active' } as never } })).rejects.toThrow(EtsyListingContentError)
    await expect(updateEtsyListingContent({ ...base, content: { listing: { should_auto_renew: true } } })).rejects.toThrow('explicit yes')
    expect(h.sends).toEqual([])
  })

  it('auto-renew with the yes is sent', async () => {
    await updateEtsyListingContent({ ...base, content: { listing: { should_auto_renew: true }, acceptAutoRenewCharge: true } })
    expect(h.sends[0].form).toEqual({ should_auto_renew: true })
  })
})

describe('E2 — one attribute', () => {
  it('PUT on the shop path, form value_ids + values + scale_id; one call, the gateway\'s write kind, no push lock', async () => {
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [1, 2], values: ['Black', 'Red'], scaleId: 5 } })).resolves.toEqual({ sent: true })
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]).toMatchObject({ path: '/shops/90000001/listings/9000000001/properties/200', method: 'PUT', kind: 'write',
      operation: 'PUT /shops/:id/listings/:id/properties/:id', form: { value_ids: [1, 2], values: ['Black', 'Red'], scale_id: 5 } })
    expect(h.sends[0].body).toBeUndefined()
    expect(h.sends[0].pushLock).toBeUndefined()
    expect(encodeEtsyForm(h.sends[0].form as never)).toBe('value_ids=1&value_ids=2&values=Black&values=Red&scale_id=5')
  })

  it('scale_id is left out when there is none (null or absent); a custom value goes with no value id', async () => {
    await setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [1], values: ['Black'], scaleId: null } })
    await setEtsyListingProperty({ ...base, property: { propertyId: 513, valueIds: [], values: ['Taglia unica'] } })
    expect(h.sends[0].form).toEqual({ value_ids: [1], values: ['Black'] })
    expect(h.sends[1].form).toEqual({ value_ids: [], values: ['Taglia unica'] })
  })

  it('( and ) in a custom value (no value ids) are refused by name; bad ids and empty values too — nothing sent', async () => {
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [], values: ['Nero (lucido)'] } }))
      .rejects.toThrow('Etsy does not take ( or ) in a custom property value, and "Nero (lucido)" has one; nothing was sent.')
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 0, valueIds: [1], values: ['Black'] } })).rejects.toThrow('That is not an Etsy property id; nothing was sent.')
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [0], values: ['Black'] } })).rejects.toThrow('a value id must be a positive whole number')
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [1], values: [] } })).rejects.toThrow('needs at least one value')
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [1], values: ['Black'], scaleId: 0 } })).rejects.toThrow('the scale id must be a positive whole number')
    await expect(setEtsyListingProperty({ ...base, listingId: '0', property: { propertyId: 200, valueIds: [1], values: ['Black'] } })).rejects.toThrow('That is not an Etsy listing id; nothing was sent.')
    expect(h.sends).toEqual([])
  })

  it('a value that carries Etsy\'s own value ids is sent exactly as Etsy names it, brackets and all (the review\'s rule)', async () => {
    await expect(setEtsyListingProperty({ ...base, property: { propertyId: 200, valueIds: [7], values: ['Nero (lucido)'] } })).resolves.toEqual({ sent: true })
    expect(h.sends[0].form).toEqual({ value_ids: [7], values: ['Nero (lucido)'] })
  })

  it('DELETE on the same path, no body', async () => {
    await expect(deleteEtsyListingProperty({ ...base, propertyId: 200 })).resolves.toEqual({ sent: true })
    expect(h.sends[0]).toMatchObject({ path: '/shops/90000001/listings/9000000001/properties/200', method: 'DELETE', kind: 'write', operation: 'DELETE /shops/:id/listings/:id/properties/:id' })
    expect(h.sends[0].body).toBeUndefined()
    expect(h.sends[0].form).toBeUndefined()
    await expect(deleteEtsyListingProperty({ ...base, propertyId: 1.5 })).rejects.toThrow('That is not an Etsy property id')
    expect(h.sends).toHaveLength(1)
  })
})

describe('E2 — one translation', () => {
  const translation = { language: 'de', title: 'Motorradhandschuhe', description: 'Weiches Leder', tags: ['handschuhe', 'motorrad'] }

  it('Etsy holds it (GET 200) → PUT, form-encoded title, description and tags', async () => {
    await expect(writeEtsyTranslation({ ...base, translation })).resolves.toEqual({ sent: true, method: 'PUT' })
    expect(h.gets).toEqual(['/shops/90000001/listings/9000000001/translations/de'])
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]).toMatchObject({ path: '/shops/90000001/listings/9000000001/translations/de', method: 'PUT', kind: 'write',
      operation: 'PUT /shops/:id/listings/:id/translations/:language', form: { title: 'Motorradhandschuhe', description: 'Weiches Leder', tags: ['handschuhe', 'motorrad'] } })
    expect(h.sends[0].pushLock).toBeUndefined()
    expect(encodeEtsyForm(h.sends[0].form as never)).toBe('title=Motorradhandschuhe&description=Weiches+Leder&tags=handschuhe&tags=motorrad')
  })

  it('Etsy does not hold it (GET 404) → POST', async () => {
    h.readStatus = 404
    await expect(writeEtsyTranslation({ ...base, translation })).resolves.toEqual({ sent: true, method: 'POST' })
    expect(h.sends[0]).toMatchObject({ method: 'POST', operation: 'POST /shops/:id/listings/:id/translations/:language' })
  })

  it.each([500, 429, 403])('any other read answer (%i) throws as it came, and nothing is written', async (status) => {
    h.readStatus = status
    await expect(writeEtsyTranslation({ ...base, translation })).rejects.toThrow(`Etsy could not read this resource (HTTP ${status}).`)
    expect(h.sends).toEqual([])
  })

  it('beforeSend gets the method and the exact form BEFORE the write', async () => {
    const beforeSend = vi.fn(async () => { h.order.push('beforeSend') })
    h.readStatus = 404
    await writeEtsyTranslation({ ...base, translation, beforeSend })
    expect(beforeSend).toHaveBeenCalledTimes(1)
    expect(beforeSend).toHaveBeenCalledWith('POST', { title: 'Motorradhandschuhe', description: 'Weiches Leder', tags: ['handschuhe', 'motorrad'] })
    expect((beforeSend.mock.calls[0] as unknown[])[1]).toEqual(h.sends[0].form)
    expect(h.order).toEqual(['get', 'beforeSend', 'send POST'])
  })

  it('a beforeSend that throws sends nothing', async () => {
    await expect(writeEtsyTranslation({ ...base, translation, beforeSend: async () => { throw new Error('journal unavailable') } })).rejects.toThrow('journal unavailable')
    expect(h.gets).toHaveLength(1)
    expect(h.sends).toEqual([])
  })

  it('the language, title and description are checked before any call', async () => {
    for (const language of ['DE', 'deu', 'de-', 'de/../x', '']) {
      await expect(writeEtsyTranslation({ ...base, translation: { ...translation, language } })).rejects.toThrow('is not a language Etsy takes for a translation; nothing was sent.')
    }
    await expect(writeEtsyTranslation({ ...base, translation: { ...translation, language: 'pt-BR', title: '  ' } })).rejects.toThrow('The pt-BR translation needs a title; nothing was sent.')
    await expect(writeEtsyTranslation({ ...base, translation: { ...translation, description: '' } })).rejects.toThrow('The de translation needs a description; nothing was sent.')
    await expect(writeEtsyTranslation({ ...base, listingId: 'x', translation })).rejects.toThrow('That is not an Etsy listing id; nothing was sent.')
    expect(h.gets).toEqual([])
    expect(h.sends).toEqual([])
  })
})
