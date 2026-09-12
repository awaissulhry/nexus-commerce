import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
const runtime = vi.hoisted(() => ({ db: {} as Record<string, any> }))
vi.mock('../../db.js', () => ({ default: runtime.db }))
vi.mock('../ebay-category.service.js', () => ({ EbayCategoryService: class { async getCategoryAspectsRich() { return [{ name: 'Size', variantEligible: true }, { name: 'Brand', variantEligible: false }] } } }))
import { ProductPresetService, projectProductPreset } from './product-presets.js'
import { SubmissionService } from './submission.service.js'
import { VariationsService } from './variations.service.js'
import { productPresetTestStore } from './product-presets-test-store.js'
let fixture: ReturnType<typeof productPresetTestStore>, service: ProductPresetService
beforeEach(() => { fixture = productPresetTestStore(); Object.assign(runtime.db, fixture.db); service = new ProductPresetService(runtime.db as PrismaClient) })

describe('product preset destination and durable consumer', () => {
  it('reviews without writes, saves through the wizard, feeds actual variation/validation consumers and retries once', async () => {
    const existing = fixture.addDraft({ variations: { includedSkus: ['p1-S'] }, identifiers: { path: 'have-exemption' }, pricing: { basePrice: 0 } })
    const protectedRows = structuredClone({ products: fixture.data.product, listings: fixture.data.channelListing })
    const definition = structuredClone(fixture.data.wizardTemplate[0])
    const review = await service.review(fixture.scope, 'outerwear')
    expect(review).toMatchObject({ changed: true, before: { absent: true }, after: { value: 'SIZE_NAME' } })
    expect(review.excluded.join(' ')).toContain('AMAZON FR')
    expect(fixture.writes).toEqual([]) // Cancellation leaves no draft or usage mutation.
    const applied = await service.apply(fixture.scope, 'outerwear', review.reviewKey, review.wizardId!)
    expect(applied.wizard.id).toBe(existing.id)
    expect(applied.wizard.state).toMatchObject({ variations: { includedSkus: ['p1-S'], themeByChannel: { 'AMAZON:IT': 'SIZE_NAME' } }, pricing: { basePrice: 0 } })
    const consumer = new SubmissionService(runtime.db as PrismaClient).validateMultiChannel(applied.wizard as any)
    expect(consumer.channels[0]!.items.find(i => i.title === 'Variations')).toMatchObject({ status: 'complete', message: '1 included (theme: SIZE_NAME)' })
    const variations = await new VariationsService(runtime.db as PrismaClient).getMultiChannelVariationsPayload({ productId: 'p1', channels: applied.wizard.channels as any, productTypeByChannel: { 'AMAZON:IT': 'JACKET' }, selectedThemeByChannel: { 'AMAZON:IT': (applied.wizard.channelStates as any)['AMAZON:IT'].variations.theme } })
    expect(variations.selectedThemeByChannel).toEqual({ 'AMAZON:IT': 'SIZE_NAME' })
    expect(variations.children[0]!.missingByChannel['AMAZON:IT']).toEqual([])
    expect(await service.apply(fixture.scope, 'outerwear', review.reviewKey, existing.id)).toMatchObject({ replayed: true })
    expect(fixture.data.wizardTemplate[0]).toEqual({ ...definition, usageCount: 1, lastUsedAt: expect.any(Date) })
    expect({ products: fixture.data.product, listings: fixture.data.channelListing }).toEqual(protectedRows)
    expect(fixture.writes.sort()).toEqual(['listingWizard', 'wizardTemplate'])
  })
  it('creates only the reviewed single-destination draft, without selecting variants or copying SKU strategy', async () => {
    const review = await service.review(fixture.scope, 'outerwear')
    expect(fixture.data.listingWizard).toHaveLength(0)
    const { wizard } = await service.apply(fixture.scope, 'outerwear', review.reviewKey)
    expect(wizard.channels).toEqual([{ platform: 'AMAZON', marketplace: 'IT' }])
    expect(wizard.state).not.toHaveProperty('skuStrategy')
    expect(wizard.state).not.toHaveProperty('variations.includedSkus')
    expect(wizard.channelStates).toMatchObject({ 'AMAZON:IT': { productType: { productType: 'JACKET' }, variations: { theme: 'SIZE_NAME' } } })
  })
  it('applies consumed future SKU settings to an explicitly unlisted Amazon draft, without rewriting product or listing identities', async () => {
    fixture.data.channelListing = fixture.data.channelListing.filter(row => row.id !== fixture.scope.listingId)
    fixture.data.wizardTemplate[0]!.defaults = { skuStrategy: { parentSku: 'per-marketplace', childSku: 'per-marketplace', fbaFbm: 'suffixed' } }
    const scope = { ...fixture.scope, listingId: null }
    const before = structuredClone({ products: fixture.data.product, listings: fixture.data.channelListing })
    const review = await service.review(scope, 'outerwear')
    expect(review.skuFields).toHaveLength(2)
    expect(review.excluded).toContain('Fulfilment SKU suffix: not consumed by this listing workflow')
    const { wizard } = await service.apply(scope, 'outerwear', review.reviewKey)
    expect(wizard.state).toMatchObject({ skuStrategy: { parentSku: 'per-marketplace', childSku: 'per-marketplace' } })
    expect(wizard.state).not.toHaveProperty('skuStrategy.fbaFbm')
    expect({ products: fixture.data.product, listings: fixture.data.channelListing }).toEqual(before)
    expect(wizard.channelStates).toEqual({})
  })
  it.each(['', null, false])('preserves an explicit future SKU setting %j', value => {
    const result = projectProductPreset({ skuStrategy: { parentSku: value } }, {}, { skuStrategy: { parentSku: 'per-marketplace', childSku: 'shared' } }, 'AMAZON:IT', true)
    expect(result.state.skuStrategy).toEqual({ parentSku: value, childSku: 'shared' })
    expect(result.skuFields[0]!.changed).toBe(false)
  })
  it('does not expose future SKU settings to an eBay consumer that ignores them', () => {
    const result = projectProductPreset({}, {}, { skuStrategy: { parentSku: 'per-marketplace', childSku: 'per-marketplace' } }, 'EBAY:IT', true)
    expect(result.changed).toBe(false)
    expect(result.state).not.toHaveProperty('skuStrategy')
  })
  it.each(['', null, false, 0, []])('preserves explicit theme %j and all existing defaults', async value => {
    const draft = fixture.addDraft({ variations: { commonTheme: value, includedSkus: [] } })
    const original = structuredClone(draft)
    const review = await service.review(fixture.scope, 'outerwear')
    expect(review.changed).toBe(false)
    await expect(service.apply(fixture.scope, 'outerwear', review.reviewKey)).rejects.toThrow('no missing')
    expect(fixture.data.listingWizard[0]).toEqual(original)
    expect(fixture.writes).toEqual([])
  })
  it.each([null, false, ''])('preserves an explicit variations container %j', value => {
    const result = projectProductPreset({ variations: value }, {}, { variations: { commonTheme: 'SIZE_NAME' } }, 'AMAZON:IT')
    expect(result.changed).toBe(false); expect(result.state.variations).toEqual(value)
  })
  it('preserves a consumer override even if the old selection map is absent', async () => {
    const draft = fixture.addDraft(); draft.channelStates['AMAZON:IT'].variations = { theme: false, customAttributes: [] }
    expect((await service.review(fixture.scope, 'outerwear')).changed).toBe(false)
    expect(fixture.writes).toEqual([])
  })
  it('preserves a stored listing theme and refuses account-qualified preset tuples', async () => {
    fixture.data.channelListing[0]!.variationTheme = 'COLOR_NAME'
    const review = await service.review(fixture.scope, 'outerwear')
    expect(review).toMatchObject({ changed: false, before: { value: 'COLOR_NAME' }, after: { value: 'COLOR_NAME' } })
    fixture.data.wizardTemplate[0]!.channels[0].accountId = 'account-b'
    await expect(service.review(fixture.scope, 'outerwear')).rejects.toThrow('cannot represent')
    expect(fixture.writes).toEqual([])
  })
  it('uses the actual eBay variation schema projection for a classified primary listing', async () => {
    fixture.data.channelConnection.forEach(row => { row.channelType = 'EBAY' })
    fixture.data.channelListing.forEach(row => { row.channel = 'EBAY'; row.platformAttributes = { categoryId: '12345' } })
    fixture.data.wizardTemplate[0]!.channels = [{ platform: 'EBAY', marketplace: 'IT' }]
    fixture.data.wizardTemplate[0]!.defaults = { variations: { commonTheme: 'SIZE' } }
    const scope = { ...fixture.scope, channel: 'EBAY' as const }
    const review = await service.review(scope, 'outerwear')
    const { wizard } = await service.apply(scope, 'outerwear', review.reviewKey)
    expect(wizard.channelStates).toMatchObject({ 'EBAY:IT': { productType: { productType: '12345' }, variations: { theme: 'SIZE' } } })
  })
  it.each(['account', 'product', 'listing', 'preset', 'draft', 'schema'])('refuses a stale %s revision without writes', async kind => {
    const draft = fixture.addDraft()
    const review = await service.review(fixture.scope, 'outerwear')
    const target = { account: fixture.data.channelConnection[0], product: fixture.data.product[0], listing: fixture.data.channelListing[0], preset: fixture.data.wizardTemplate[0], draft, schema: fixture.data.categorySchema[0] }[kind]!
    if (kind === 'schema') target.variationThemes = ['COLOR_NAME']
    else target.updatedAt = new Date('2026-09-06T12:01:00Z')
    await expect(service.apply(fixture.scope, 'outerwear', review.reviewKey)).rejects.toThrow(/changed|not supported/)
    expect(fixture.writes).toEqual([])
  })
  it('refuses account changes, inactive/foreign listings, aliases and wrong-product draft resumes', async () => {
    const review = await service.review(fixture.scope, 'outerwear')
    for (const patch of [ { accountId: 'account-b', listingId: 'p1:account-b:IT:primary' }, { aliasKey: 'alias-one', listingId: 'p1:account-a:IT:alias-one' }, { listingId: 'p2:account-a:IT:primary' }, { market: 'FR', listingId: 'p1:account-a:FR:primary' } ]) {
      await expect(service.apply({ ...fixture.scope, ...patch }, 'outerwear', review.reviewKey)).rejects.toThrow()
    }
    const draft = fixture.addDraft({}, { productId: 'p2' })
    await expect(service.review(fixture.scope, 'outerwear', draft.id)).rejects.toThrow('another product')
    fixture.data.channelListing[0]!.listingStatus = 'INACTIVE'
    await expect(service.review(fixture.scope, 'outerwear')).rejects.toThrow('inactive')
    expect(fixture.writes).toEqual([])
  })
  it('refuses a new primary account instead of collapsing into the old bound draft', async () => {
    const review = await service.review(fixture.scope, 'outerwear')
    await service.apply(fixture.scope, 'outerwear', review.reviewKey)
    fixture.data.channelConnection[0]!.isPrimary = false; fixture.data.channelConnection[1]!.isPrimary = true
    await expect(service.review({ ...fixture.scope, accountId: 'account-b', listingId: 'p1:account-b:IT:primary' }, 'outerwear')).rejects.toThrow('different account')
  })
  it('refuses incompatible themes, unrelated destinations and absent classification', async () => {
    fixture.data.wizardTemplate[0]!.defaults = { variations: { commonTheme: 'BOGUS' } }
    await expect(service.review(fixture.scope, 'outerwear')).rejects.toThrow('not supported')
    fixture.data.wizardTemplate[0]!.channels = [{ platform: 'EBAY', marketplace: 'IT' }]
    await expect(service.review(fixture.scope, 'outerwear')).rejects.toThrow('does not include')
    fixture.data.wizardTemplate[0]!.channels = [{ platform: 'AMAZON', marketplace: 'IT' }]
    fixture.data.channelListing[0]!.platformAttributes = {}
    await expect(service.review(fixture.scope, 'outerwear')).rejects.toThrow('product type or category')
    expect(fixture.writes).toEqual([])
  })
  it('binds reviewed listing absence and refuses a concurrently created draft', async () => {
    fixture.addDraft()
    const scope = { ...fixture.scope, listingId: null }
    fixture.data.channelListing = fixture.data.channelListing.filter(r => r.id !== fixture.scope.listingId)
    const review = await service.review(scope, 'outerwear')
    fixture.data.listingWizard[0]!.version++
    await expect(service.apply(scope, 'outerwear', review.reviewKey)).rejects.toThrow('changed')
    expect(fixture.writes).toEqual([])
  })
})
