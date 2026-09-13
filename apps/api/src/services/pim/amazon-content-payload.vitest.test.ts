import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixtures = vi.hoisted(() => ({ market: vi.fn(), provider: vi.fn(() => { throw new Error('Provider forbidden') }) }))
vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: fixtures.market } } }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { putListingsItem: fixtures.provider, patchListingsItem: fixtures.provider } }))
import { buildAmazonContentAttributes, buildAmazonContentEntries } from './amazon-content-payload.js'
import { publishContentIssues, publishUntranslatedIssues, resolvePublishContent } from './publish-review-gate.js'
import { buildMarketplaceAmazonAttributes } from '../../routes/marketplaces.routes.js'
import { buildAmazonListingPatch } from '../outbound-sync.service.js'
const product = { id: 'product', name: 'Source title', description: 'Source description', translations:
  ['de', 'nl', 'fr', 'en'].map(language => ({ language, name: `Title ${language}`, description: `Description ${language}`, bulletPoints: [`Bullet ${language}`], source: 'manual' as const })) }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', fixtures.provider)
  fixtures.market.mockImplementation(async ({ where }) => { expect(where.channel).toBe('AMAZON'); return { languages: where.code === 'BE' ? ['nl', 'fr'] : where.code === 'DE' ? ['de'] : ['en'] } })
})
afterEach(() => { expect(fixtures.provider).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
it.each([['DE', 'de', 'de_DE'], ['BE', 'nl', 'nl_BE'], ['BE', 'fr', 'fr_BE'], ['UK', 'en', 'en_GB']])('builds resolved %s %s entries in both real builders', async (marketplace, language, tag) => {
  const content = { product }
  const attributes = await buildMarketplaceAmazonAttributes({ marketplace, marketplaceId: 'fixture', attributes: {}, content })
  expect(attributes.item_name).toContainEqual({ value: `Title ${language}`, marketplace_id: 'fixture', language_tag: tag })
  const patch = await buildAmazonListingPatch({ title: 'stale queue snapshot' }, marketplace, 'OUTERWEAR', null, content)
  expect(patch.patches.find((p: any) => p.path === '/attributes/item_name').value).toEqual(attributes.item_name.map((v: any) => ({ ...v, marketplace_id: expect.any(String) })))
  expect(attributes.item_name).toHaveLength(marketplace === 'BE' ? 2 : 1)
  expect(attributes.product_description.map((v: any) => v.value)).toContain(`Description ${language}`)
})
// R-LX-6 (on LX.R P0-1/P1-7) corrects what this arm asserted. It used to pin
// `language_tag: 'it_DE'` — honest about the language, but it published Italian
// text to a German audience and, on a two-language market, twice. The ruling:
// omit the untranslated language and let the preflight name it.
it('omits an untranslated market instead of stamping the source text with a tag (R-LX-6)', async () => {
  const untranslated = { id: 'source', name: 'Italian', description: 'Descrizione' }
  const attributes = await buildAmazonContentAttributes({ product: untranslated, marketplace: 'DE', marketplaceId: 'fixture' })
  expect(attributes.item_name).toBeUndefined()
  expect(attributes.product_description).toBeUndefined()
  const issues = publishUntranslatedIssues(await resolvePublishContent({ product: untranslated, marketplace: 'DE' }))
  expect(issues.map(issue => `${issue.severity} ${issue.language} ${issue.field}`)).toEqual(['WARNING de title', 'WARNING de description'])
  expect(issues[0].message).toBe('The German (de) title is not translated — the Italian text is shown in the studio but is omitted from the payload.')
})

it('a two-language market with neither language translated emits NO duplicate entry (R-LX-6, LX.R P0-1)', async () => {
  const untranslated = { id: 'source', name: 'Giacca', description: 'Descrizione' }
  const attributes = await buildAmazonContentAttributes({ product: untranslated, marketplace: 'BE', marketplaceId: 'fixture' })
  // Before the fix: item_name = [{it_BE},{it_BE}] and product_description the same.
  expect(attributes).toEqual({})
  const issues = publishContentIssues(await resolvePublishContent({ product: untranslated, marketplace: 'BE' }))
  expect(issues.filter(issue => issue.field === 'title').map(issue => issue.language)).toEqual(['nl', 'fr'])
})

it('a half-translated two-language market emits exactly the translated language', async () => {
  const dutchOnly = { id: 'half', name: 'Giacca', description: 'Descrizione',
    translations: [{ language: 'nl', name: 'Titel nl', description: 'Beschrijving nl', source: 'manual' as const }] }
  const attributes = await buildAmazonContentAttributes({ product: dutchOnly, marketplace: 'BE', marketplaceId: 'fixture' })
  expect(attributes.item_name).toEqual([{ value: 'Titel nl', marketplace_id: 'fixture', language_tag: 'nl_BE' }])
  expect(attributes.product_description).toHaveLength(1)
  expect(publishUntranslatedIssues(await resolvePublishContent({ product: dutchOnly, marketplace: 'BE' })).map(issue => `${issue.language} ${issue.field}`))
    .toEqual(['fr title', 'fr description'])
})

// The tuple rule, exercised directly: `marketLanguages` de-duplicates its own
// array, so two rows resolving to one language cannot be produced through
// `resolvePublishContent` any more — this fixture is synthetic on purpose, and
// the arm that must NOT collapse (an array field) is measured beside it.
it('emits one contribution per (attribute, marketplace_id, language_tag) and keeps array elements', () => {
  const row = (language: string, value: unknown, field = 'title') => ({ language,
    fields: { [field]: { value, tier: 'language' as const, language, requested: language, provenance: { member: 'own' as const, from: null } } } })
  const collapsed = buildAmazonContentEntries([row('de', 'Deutsch'), row('de', 'Deutsch')], { marketplace: 'DE', marketplaceId: 'fixture' })
  expect(collapsed.item_name).toHaveLength(1)
  const distinct = buildAmazonContentEntries([row('nl', 'Titel nl'), row('fr', 'Titre fr')], { marketplace: 'BE', marketplaceId: 'fixture' })
  expect(distinct.item_name.map((entry: any) => entry.language_tag)).toEqual(['nl_BE', 'fr_BE'])
  const bullets = buildAmazonContentEntries([row('de', ['one', 'two', 'three'], 'bulletPoints')], { marketplace: 'DE', marketplaceId: 'fixture' })
  expect(bullets.bullet_point).toHaveLength(3)
})
it('names the unreviewed French language before a payload can reach a provider', async () => {
  const draft = { ...product, translations: product.translations.map(row => row.language === 'fr' ? { ...row, source: 'ai' as const, reviewedAt: null } : row) }
  await expect(buildAmazonContentAttributes({ product: draft, marketplace: 'BE', marketplaceId: 'fixture' })).rejects.toThrow('French (fr) title')
})

it('a following legacy snapshot cannot conceal an unreviewed German draft', async () => {
  const draft = { ...product, translations: [{ language: 'de', name: 'German draft', source: 'ai' as const, reviewedAt: null }] }
  await expect(buildAmazonContentAttributes({ product: draft, listing: { id: 'listing', productId: product.id, channel: 'AMAZON', marketplace: 'DE', title: 'Old listing snapshot', followMasterTitle: true }, marketplace: 'DE', marketplaceId: 'fixture' })).rejects.toThrow('German (de) title')
})
