/**
 * Google Ads programme 2, G12 (2026-10-16) — the Merchant Center change builders (pure) and the live mappers: a product
 * input goes only into a supplemental data source Nexus made, as the whole input Nexus last wrote with the change; the
 * preview says from the live rule whether the value reaches the product and whether the next Shopify feed fetch overwrites
 * it; a pause or an ads exclusion that ends SPENDS MONEY; data sources are made, renamed, fetched and deleted (empty, Nexus's
 * own) only; a promotion changes the price buyers see and is ended at the moment the change runs. Every body is one the
 * gateway lets through.
 */
import { describe, expect, it } from 'vitest'
import { googleMerchantCall, googleMerchantCallBodyOf } from '../../gateway/google-merchant-calls.js'
import { MERCHANT_API_BASE, RUN_TIME, RUN_TIME_MINUS_MINUTE, merchantFailureSentence, type MerchantCallSpec } from './client.js'
import { dataSourceDraft, type DataSourceFacts } from './change-data-sources.js'
import { plainText, productDraft, productUndoArgs, type ProductFacts, type ProductRequest } from './change-products.js'
import { promotionDraft, promotionUndoArgs, type PromotionFacts, type PromotionState } from './change-promotions.js'
import { dataSourceOf, encodedKey, performanceQuery, productRowOf, productVerdict, promotionOf, type MerchantDataSource } from './live.js'
import type { MerchantChangeDraft } from './change-draft.js'

const M = '555'
const ds = (over: Partial<MerchantDataSource> & { dataSourceId: string }): MerchantDataSource => ({
  displayName: null, input: 'API', type: 'supplemental', feedLabel: null, contentLanguage: null, countries: [], destinations: [], defaultRule: [], linkedFrom: [], file: null, ...over,
})
const PRIMARY = ds({ dataSourceId: '11', displayName: 'Shop feed', type: 'primary', defaultRule: ['self', '71'] })
const SUPPLEMENTAL = ds({ dataSourceId: '71', displayName: 'Nexus A', linkedFrom: ['11'] })

/** The gateway's own judgement of a draft's call (the tools send nothing the gateway would refuse). */
function judged(call: MerchantCallSpec) {
  const q = new URLSearchParams(call.query ?? {}).toString()
  const url = `${MERCHANT_API_BASE}/${call.path}${q ? `?${q}` : ''}`
  const kind = googleMerchantCall(call.method, url)
  expect(kind, url).not.toBeNull()
  return googleMerchantCallBodyOf(kind!, call.body === undefined ? null : JSON.stringify(call.body))
}
const draftOf = (out: unknown): MerchantChangeDraft => { expect(out).not.toHaveProperty('refusal'); return out as MerchantChangeDraft }

describe('set-google-merchant-products (productDraft)', () => {
  const req: ProductRequest = { action: 'set', dataSourceId: '71', offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', attributes: { customLabel0: 'top' } }
  const facts = (over: Partial<ProductFacts> = {}): ProductFacts => ({
    merchantCenterId: M, dataSources: [PRIMARY, SUPPLEMENTAL], nexusMade: new Set(['71']), recorded: null,
    live: { exists: true, dataSourceId: '11', values: { title: 'Jacket A', customLabel0: 'old' } },
    nexus: { sku: 'SKU-A', name: 'Jacket A', values: { title: 'Jacket A', description: 'Warm', brand: 'Brand A', gtins: ['1234567890128'] } }, ...over,
  })

  it('a new input: the whole state sent to the Nexus data source, from → to the live value; undo deletes it', () => {
    const d = draftOf(productDraft(req, facts()))
    expect(d.call).toEqual({
      method: 'POST', path: `products/v1/accounts/${M}/productInputs:insert`, query: { dataSource: `accounts/${M}/dataSources/71` },
      body: { offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', productAttributes: { customLabel0: 'top' } },
    })
    expect(judged(d.call)).toEqual({ body: JSON.stringify(d.call.body) })
    expect(d.changes).toEqual({ customLabel0: { from: 'old', to: 'top' } })
    expect(d.spendsMoney).toEqual([])
    expect(d.before).toMatchObject({ key: 'it~IT~SKU-A', state: null })
    expect(d.after).toMatchObject({ key: 'it~IT~SKU-A', state: { customLabel0: 'top' } })
    // The live rule takes the primary feed FIRST: the next Shopify feed fetch keeps the feed's value.
    expect(d.warnings[0]).toMatch(/would be overwritten by the next Shopify feed fetch/)
    expect(d.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Custom labels decide/)]))
    expect(productUndoArgs(d.before, d.after)).toEqual({ args: { dataSourceId: '71', offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', action: 'delete' } })
  })

  it('a change merges onto what Nexus last wrote, takes attributes out; undo writes the old input back', () => {
    const recorded = { state: { customLabel0: 'top', pause: 'ADS' }, at: '2026-10-15T10:00:00.000Z' }
    const d = draftOf(productDraft({ ...req, attributes: { customLabel1: 'winter' }, clear: ['pause'] }, facts({ recorded })))
    expect((d.call.body as { productAttributes: unknown }).productAttributes).toEqual({ customLabel0: 'top', customLabel1: 'winter' })
    expect(Object.keys(d.changes).sort()).toEqual(['customLabel1', 'pause'])
    // The pause in this source ends: the product can show in paid ads again.
    expect(d.spendsMoney).toEqual([expect.stringMatching(/^SPENDS MONEY: .* no longer pauses the product/)])
    expect(productUndoArgs(d.before, d.after)).toEqual({ args: { dataSourceId: '71', offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', action: 'set', attributes: { customLabel0: 'top', pause: 'ADS' }, clear: ['customLabel1'] } })
    // The same values again: nothing to send.
    expect(productDraft({ ...req, attributes: { customLabel0: 'top' } }, facts({ recorded: { state: { customLabel0: 'top' }, at: recorded.at } }))).toEqual({ refusal: expect.stringMatching(/^Nothing to change/) })
  })

  it('fromNexus fills from the Nexus product (the product master); a value that differs from Nexus is said', () => {
    const d = draftOf(productDraft({ ...req, attributes: undefined, fromNexus: ['title', 'gtins'] }, facts()))
    expect((d.call.body as { productAttributes: unknown }).productAttributes).toEqual({ gtins: ['1234567890128'], title: 'Jacket A' })
    const other = draftOf(productDraft({ ...req, attributes: { title: 'Another title' } }, facts()))
    expect(other.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Nexus is the product master: title differs/)]))
    expect(productDraft({ ...req, fromNexus: ['brand'] }, facts({ nexus: null }))).toEqual({ refusal: expect.stringMatching(/No Nexus product has the SKU SKU-A/) })
    expect(plainText('<p>Warm &amp; dry</p><ul><li>One</li></ul>')).toBe('Warm & dry\nOne')
  })

  it('never into a data source Nexus did not make (the primary feed of Shopify\'s channel above all), never a primary', () => {
    expect(productDraft({ ...req, dataSourceId: '11' }, facts())).toEqual({ refusal: expect.stringMatching(/^Data source 11 is not one Nexus made .* never edits or deletes the primary feed/) })
    expect(productDraft({ ...req, dataSourceId: '11' }, facts({ nexusMade: new Set(['11', '71']) }))).toEqual({ refusal: expect.stringMatching(/primary data source: Nexus writes product inputs into its supplemental data sources only/) })
    expect(productDraft({ ...req, dataSourceId: '99' }, facts())).toEqual({ refusal: expect.stringMatching(/no data source 99/) })
    expect(productDraft(req, facts({ dataSources: [PRIMARY, { ...SUPPLEMENTAL, feedLabel: 'DE', contentLanguage: 'de' }] }))).toEqual({ refusal: expect.stringMatching(/takes only products in language de/) })
  })

  it('the preview says when the values reach nothing: not linked, not this product\'s primary, no such product', () => {
    expect(draftOf(productDraft(req, facts({ dataSources: [PRIMARY, { ...SUPPLEMENTAL, linkedFrom: [] }] }))).warnings[0]).toMatch(/not linked to any primary data source yet/)
    expect(draftOf(productDraft(req, facts({ live: { exists: false, dataSourceId: null, values: {} } }))).warnings[0]).toMatch(/has no product with this offer id/)
    expect(draftOf(productDraft(req, facts({ dataSources: [{ ...PRIMARY, defaultRule: ['71', 'self'] }, SUPPLEMENTAL] }))).warnings[0]).toMatch(/comes before the primary feed: its values win/)
  })

  it('a delete needs Nexus\'s record; the input goes, and an ads exclusion it held ending SPENDS MONEY', () => {
    expect(productDraft({ ...req, action: 'delete' }, facts())).toEqual({ refusal: expect.stringMatching(/no record of a product input it wrote/) })
    const d = draftOf(productDraft({ ...req, action: 'delete' }, facts({ recorded: { state: { excludedDestinations: ['SHOPPING_ADS'] }, at: '2026-10-15T10:00:00.000Z' } })))
    expect(d.call).toEqual({ method: 'DELETE', path: `products/v1/accounts/${M}/productInputs/${encodedKey('it~IT~SKU-A')}`, query: { dataSource: `accounts/${M}/dataSources/71` } })
    expect(judged(d.call)).toEqual({ body: null })
    expect(d.spendsMoney).toEqual([expect.stringMatching(/no longer excludes the product from SHOPPING_ADS/)])
    expect(productUndoArgs(d.before, d.after)).toEqual({ args: { dataSourceId: '71', offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', action: 'set', attributes: { excludedDestinations: ['SHOPPING_ADS'] } } })
  })
})

describe('set-google-merchant-data-sources (dataSourceDraft)', () => {
  const facts = (over: Partial<DataSourceFacts> = {}): DataSourceFacts => ({
    merchantCenterId: M, dataSources: [PRIMARY, SUPPLEMENTAL, ds({ dataSourceId: '81', input: 'FILE', file: { fileName: 'labels', type: 'GOOGLE_SHEETS', fetchEnabled: true, frequency: 'FREQUENCY_DAILY', fetchHost: 'docs.google.com' } })],
    nexusMade: new Set(['71']), held: 0, livePromotions: 0, ...over,
  })

  it('makes a supplemental or a promotion data source (API); says a person links it to the primary', () => {
    const s = draftOf(dataSourceDraft({ action: 'create-supplemental', displayName: 'Nexus B', feedLabel: 'IT', contentLanguage: 'it' }, facts()))
    expect(s.call).toEqual({ method: 'POST', path: `datasources/v1/accounts/${M}/dataSources`, body: { displayName: 'Nexus B', supplementalProductDataSource: { feedLabel: 'IT', contentLanguage: 'it' } } })
    expect(judged(s.call)).toMatchObject({ body: expect.any(String) })
    expect(s.warnings[0]).toMatch(/Nexus never changes the rules of the primary feed/)
    const p = draftOf(dataSourceDraft({ action: 'create-promotions', displayName: 'Nexus P', targetCountry: 'IT', contentLanguage: 'it' }, facts()))
    expect(p.call.body).toEqual({ displayName: 'Nexus P', promotionDataSource: { targetCountry: 'IT', contentLanguage: 'it' } })
    expect(judged(p.call)).toMatchObject({ body: expect.any(String) })
    expect(dataSourceDraft({ action: 'create-supplemental', displayName: 'X', feedLabel: 'IT' }, facts())).toEqual({ refusal: expect.stringMatching(/both its feed label and its language, or neither/) })
  })

  it('renames and deletes only one Nexus made; delete only when empty and unlinked', () => {
    expect(dataSourceDraft({ action: 'rename', dataSourceId: '11', displayName: 'X' }, facts())).toEqual({ refusal: expect.stringMatching(/not one Nexus made/) })
    const r = draftOf(dataSourceDraft({ action: 'rename', dataSourceId: '71', displayName: 'Nexus Z' }, facts()))
    expect(r.call).toEqual({ method: 'PATCH', path: `datasources/v1/accounts/${M}/dataSources/71`, query: { updateMask: 'displayName' }, body: { name: `accounts/${M}/dataSources/71`, displayName: 'Nexus Z' } })
    expect(judged(r.call)).toMatchObject({ body: expect.any(String) })
    expect(dataSourceDraft({ action: 'delete', dataSourceId: '71' }, facts())).toEqual({ refusal: expect.stringMatching(/needs confirmDelete/) })
    expect(dataSourceDraft({ action: 'delete', dataSourceId: '71', confirmDelete: true }, facts())).toEqual({ refusal: expect.stringMatching(/linked from primary data source 11/) })
    const unlinked = facts({ dataSources: [PRIMARY, { ...SUPPLEMENTAL, linkedFrom: [] }] })
    expect(dataSourceDraft({ action: 'delete', dataSourceId: '71', confirmDelete: true }, { ...unlinked, held: 2 })).toEqual({ refusal: expect.stringMatching(/still holds 2 product inputs/) })
    const d = draftOf(dataSourceDraft({ action: 'delete', dataSourceId: '71', confirmDelete: true }, unlinked))
    expect(d.call).toEqual({ method: 'DELETE', path: `datasources/v1/accounts/${M}/dataSources/71` })
    expect(judged(d.call)).toEqual({ body: null })
  })

  it('fetches a fetched file or Google Sheet now (any of the account\'s); never an API source such as Shopify\'s feed', () => {
    const f = draftOf(dataSourceDraft({ action: 'fetch-now', dataSourceId: '81' }, facts()))
    expect(f.call).toEqual({ method: 'POST', path: `datasources/v1/accounts/${M}/dataSources/81:fetch`, body: {} })
    expect(judged(f.call)).toEqual({ body: '{}' })
    expect(f.warnings[0]).toMatch(/cannot be undone/)
    expect(dataSourceDraft({ action: 'fetch-now', dataSourceId: '11' }, facts())).toEqual({ refusal: expect.stringMatching(/not a file data source Google fetches/) })
  })
})

describe('set-google-merchant-promotions (promotionDraft)', () => {
  const SOURCE = ds({ dataSourceId: '72', type: 'promotion', countries: ['IT'], contentLanguage: 'it' })
  const now = new Date('2026-10-16T10:00:00Z')
  const facts = (over: Partial<PromotionFacts> = {}): PromotionFacts => ({ merchantCenterId: M, dataSources: [SOURCE], nexusMade: new Set(['72']), live: null, recorded: null, now, ...over })
  const fields = { title: 'Ten off', type: 'PERCENT_OFF', percentOff: 10, products: 'all', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-08T00:00:00Z' }

  it('a new promotion: the whole body, the price buyers see said as its money line; undo ends it', () => {
    const d = draftOf(promotionDraft({ action: 'set', dataSourceId: '72', promotionId: 'PROMO-A', fields }, facts()))
    expect(judged(d.call)).toMatchObject({ body: expect.any(String) })
    expect(d.call.body).toMatchObject({ dataSource: `accounts/${M}/dataSources/72`, promotion: { promotionId: 'PROMO-A', targetCountry: 'IT', contentLanguage: 'it', attributes: { percentOff: '10', productApplicability: 'ALL_PRODUCTS', offerType: 'NO_CODE' } } })
    expect(d.spendsMoney).toEqual([expect.stringMatching(/^CHANGES THE PRICE BUYERS SEE: "Ten off" — 10% off on all products, for buyers in IT/)])
    expect(d.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Nexus does not make the Shopify discount here/)]))
    expect(promotionUndoArgs(d.before, d.after)).toEqual({ args: { dataSourceId: '72', promotionId: 'PROMO-A', action: 'end' } })
  })

  it('Google\'s rules: free shipping needs a code; a money off names its currency', () => {
    expect(promotionDraft({ action: 'set', dataSourceId: '72', promotionId: 'P', fields: { ...fields, type: 'FREE_SHIPPING_STANDARD', percentOff: null } }, facts())).toEqual({ refusal: expect.stringMatching(/free shipping promotion needs a code/) })
    const money = draftOf(promotionDraft({ action: 'set', dataSourceId: '72', promotionId: 'P', fields: { ...fields, type: 'MONEY_OFF', percentOff: null, moneyOffCents: 1000, currency: 'EUR' } }, facts()))
    expect(judged(money.call)).toMatchObject({ body: expect.any(String) })
    expect((money.call.body as any).promotion.attributes.moneyOffAmount).toEqual({ amountMicros: '10000000', currencyCode: 'EUR' })
    expect(promotionDraft({ action: 'set', dataSourceId: '72', promotionId: 'P', fields: { ...fields, type: 'MONEY_OFF', percentOff: null, moneyOffCents: 1000 } }, facts())).toEqual({ refusal: expect.stringMatching(/names its currency/) })
  })

  it('end: the end moves to the moment the change runs (a marker until then); undo puts the promotion back', () => {
    const recorded = { state: { ...fields, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-08T00:00:00Z' } as PromotionState, at: '2026-10-01T00:00:00Z' }
    const live = promotionOf({ promotionId: 'PROMO-A', contentLanguage: 'it', targetCountry: 'IT', dataSource: `accounts/${M}/dataSources/72` })
    const d = draftOf(promotionDraft({ action: 'end', dataSourceId: '72', promotionId: 'PROMO-A' }, facts({ recorded, live })))
    expect((d.call.body as any).promotion.attributes.promotionEffectiveTimePeriod).toEqual({ startTime: '2026-10-01T00:00:00Z', endTime: RUN_TIME })
    expect(d.spendsMoney).toEqual([])
    expect(d.changes).toEqual({ endsAt: { from: '2026-11-08T00:00:00Z', to: 'when this change runs' } })
    expect(promotionUndoArgs(d.before, { ...d.after, state: { ...recorded.state, endsAt: '2026-10-16T10:05:00Z' } })).toEqual({ args: { dataSourceId: '72', promotionId: 'PROMO-A', action: 'set', ...recorded.state } })
    // Not started yet: it starts a minute before it ends.
    const future = { state: { ...fields } as PromotionState, at: recorded.at }
    expect((draftOf(promotionDraft({ action: 'end', dataSourceId: '72', promotionId: 'PROMO-A' }, facts({ recorded: future, live }))).call.body as any).promotion.attributes.promotionEffectiveTimePeriod)
      .toEqual({ startTime: RUN_TIME_MINUS_MINUTE, endTime: RUN_TIME })
  })

  it('only in a promotion data source Nexus made; never a promotion it has no record of', () => {
    expect(promotionDraft({ action: 'set', dataSourceId: '73', promotionId: 'P', fields }, facts({ dataSources: [SOURCE, ds({ dataSourceId: '73', type: 'promotion', countries: ['IT'], contentLanguage: 'it' })] }))).toEqual({ refusal: expect.stringMatching(/not one Nexus made/) })
    const elsewhere = promotionOf({ promotionId: 'P', contentLanguage: 'it', targetCountry: 'IT', dataSource: `accounts/${M}/dataSources/90` })
    expect(promotionDraft({ action: 'set', dataSourceId: '72', promotionId: 'P', fields }, facts({ live: elsewhere }))).toEqual({ refusal: expect.stringMatching(/already lives in data source 90/) })
    const blind = promotionOf({ promotionId: 'P', contentLanguage: 'it', targetCountry: 'IT', dataSource: `accounts/${M}/dataSources/72` })
    expect(promotionDraft({ action: 'set', dataSourceId: '72', promotionId: 'P', fields }, facts({ live: blind }))).toEqual({ refusal: expect.stringMatching(/no record of what it holds/) })
  })
})

describe('the live mappers', () => {
  it('a product: its status per destination and country, its issues, its primary data source', () => {
    const row = productRowOf({
      offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', dataSource: `accounts/${M}/dataSources/11`,
      productAttributes: { title: 'Jacket A', price: { amountMicros: '49990000', currencyCode: 'EUR' }, customLabel0: 'top' },
      productStatus: {
        destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['IT'], disapprovedCountries: ['DE'] }],
        itemLevelIssues: [{ code: 'missing_gtin', severity: 'DISAPPROVED', attribute: 'gtin', reportingContext: 'SHOPPING_ADS', applicableCountries: ['DE'], description: 'Missing GTIN' }],
      },
    })!
    expect(row).toMatchObject({ key: 'it~IT~SKU-A', dataSourceId: '11', price: { cents: 4999, currency: 'EUR' }, customLabels: { customLabel0: 'top' } })
    expect(row.status).toEqual([{ context: 'SHOPPING_ADS', approved: ['IT'], pending: [], disapproved: ['DE'] }])
    expect(row.issues[0]).toMatchObject({ code: 'missing_gtin', severity: 'DISAPPROVED', countries: ['DE'] })
    expect(productVerdict(row)).toBe('disapproved')
    expect(encodedKey('en~US~sku/123')).toBe('ZW5-VVN-c2t1LzEyMw') // Google's own example (products_v1 Product.base64EncodedName)
  })

  it('a data source: its type, input, default rule order and links; a fetch link only by its host', () => {
    expect(dataSourceOf({ dataSourceId: '11', displayName: 'Shop feed', input: 'API', primaryProductDataSource: { countries: ['IT'], defaultRule: { takeFromDataSources: [{ self: true }, { supplementalDataSourceName: `accounts/${M}/dataSources/71` }] } } }))
      .toMatchObject({ type: 'primary', input: 'API', countries: ['IT'], defaultRule: ['self', '71'] })
    expect(dataSourceOf({ dataSourceId: '71', input: 'API', supplementalProductDataSource: { referencingPrimaryDataSources: [{ primaryDataSourceName: `accounts/${M}/dataSources/11` }] } }))
      .toMatchObject({ type: 'supplemental', linkedFrom: ['11'] })
    expect(dataSourceOf({ dataSourceId: '81', input: 'FILE', fileInput: { fileName: 'f.xml', fileInputType: 'FETCH', fetchSettings: { enabled: true, frequency: 'FREQUENCY_DAILY', fetchUri: 'https://user:secret@feeds.example/f.xml?token=abc' } } })?.file)
      .toEqual({ fileName: 'f.xml', type: 'FETCH', fetchEnabled: true, frequency: 'FREQUENCY_DAILY', fetchHost: 'feeds.example' })
  })

  it('the performance query asks a date range and a limit, nothing else', () => {
    expect(performanceQuery('2026-10-01', '2026-10-15', 50)).toBe(
      'SELECT offer_id, title, marketing_method, impressions, clicks, click_through_rate FROM product_performance_view '
      + "WHERE date BETWEEN '2026-10-01' AND '2026-10-15' ORDER BY clicks DESC LIMIT 50")
    expect(() => performanceQuery("2026-10-01' OR '1", '2026-10-15', 5)).toThrow()
  })

  it('Google\'s refusals in words: the Cloud project not registered, access, slow down', () => {
    expect(merchantFailureSentence(401, JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'GCP project with id x is not registered with the merchant account.' } })).sentence).toMatch(/has not registered the Nexus Google Cloud project/)
    expect(merchantFailureSentence(403, JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } })).sentence).toMatch(/^Merchant Center refused it \(PERMISSION_DENIED/)
    expect(merchantFailureSentence(429, '').sentence).toMatch(/slow down/)
  })
})
