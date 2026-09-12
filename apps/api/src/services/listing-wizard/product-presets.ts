import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { resolveChannelConnectionId, isPrimaryChannelConnection } from '../connection-resolver.service.js'
import { channelsHash, normalizeChannels } from './channels.js'
import { fillPresetDefaults, reusablePresetDefaults } from './preset-defaults.js'
import { VariationsService } from './variations.service.js'

type Bag = Record<string, any>
type Db = Prisma.TransactionClient
const bag = (v: unknown): Bag => v && typeof v === 'object' && !Array.isArray(v) ? v as Bag : {}
const owns = (v: Bag, key: string) => Object.prototype.hasOwnProperty.call(v, key)
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v)) ?? 'undefined').digest('hex')
export const PRODUCT_PRESET_SCOPE = 'productPresetScope'
export class ProductPresetError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message) }
}
export interface ProductPresetScope {
  productId: string; channel: 'AMAZON' | 'EBAY'; accountId: string; market: string; listingId: string | null; aliasKey: string
}
export function parseProductPresetScope(input: unknown): ProductPresetScope {
  const v = bag(input)
  if (Object.keys(v).some(key => !['productId', 'channel', 'accountId', 'market', 'listingId', 'aliasKey'].includes(key))) throw new ProductPresetError('Unsupported destination coordinates. Use the exact product account/listing scope.', 400)
  if (!['productId', 'channel', 'accountId', 'market', 'aliasKey'].every(k => typeof v[k] === 'string') || !v.productId || !v.accountId || !v.market || !['AMAZON', 'EBAY'].includes(v.channel) || !(v.listingId === null || typeof v.listingId === 'string' && !!v.listingId)) {
    throw new ProductPresetError('Choose an explicit product, channel, account, market and listing scope.', 400)
  }
  if (v.aliasKey !== '') throw new ProductPresetError('Listing presets currently support the primary listing only. This alias was not changed.')
  return { productId: v.productId, channel: v.channel, accountId: v.accountId, market: v.market.toUpperCase(), listingId: v.listingId, aliasKey: '' }
}
export const productPresetScopeOf = (wizard: { state: unknown }) => bag(wizard.state)[PRODUCT_PRESET_SCOPE] as ProductPresetScope | undefined
export const sameProductPresetScope = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b)

/** The canonical resolver remains the only account decision. Never put an account in the old tuple/hash. */
export async function validateProductPresetScope(db: Db, scope: ProductPresetScope) {
  await resolveChannelConnectionId(scope.channel, scope.accountId)
  if (!await isPrimaryChannelConnection(scope.channel, scope.accountId)) throw new ProductPresetError('The listing wizard supports the primary account only. This account was not changed.')
  const [product, account, listings] = await Promise.all([
    db.product.findUnique({ where: { id: scope.productId }, select: { id: true, name: true, sku: true, parentId: true, isParent: true, deletedAt: true, updatedAt: true } }),
    db.channelConnection.findUnique({ where: { id: scope.accountId }, select: { id: true, displayName: true, channelType: true, isActive: true, isPrimary: true, updatedAt: true } }),
    db.channelListing.findMany({ where: { productId: scope.productId, channel: scope.channel, marketplace: scope.market, channelConnectionId: scope.accountId, aliasKey: '' }, take: 2 }),
  ])
  if (!product || product.deletedAt) throw new ProductPresetError('The selected product is unavailable.', 404)
  if (!account?.isActive || account.channelType !== scope.channel) throw new ProductPresetError('The selected account changed or is inactive.')
  // Exact absence is a reviewed target too. Never adopt a listing created after review.
  if (listings.length > 1 || (scope.listingId ? listings.length !== 1 || listings[0]!.id !== scope.listingId : listings.length !== 0)) throw new ProductPresetError('The listing no longer matches this product and destination. Refresh the product scope.')
  const listing = listings[0] ?? null
  if (listing && (['INACTIVE', 'ENDED', 'ARCHIVED', 'DELETED'].includes(listing.listingStatus) || !listing.offerActive || !listing.isPublished)) throw new ProductPresetError('The selected listing is inactive.')
  return { product, account, listing }
}

/** Project into BOTH the step's selection state and the existing submission/read consumer. */
export function projectProductPreset(stateInput: unknown, channelStatesInput: unknown, defaultsInput: unknown, key: string, unlisted = false) {
  const state = structuredClone(bag(stateInput)), channelStates = structuredClone(bag(channelStatesInput))
  const reusable = reusablePresetDefaults(defaultsInput), defaults = bag(reusable.defaults.variations)
  const labels: Record<string, string> = { pricing: 'Prices', identifiers: 'Product identifiers', attributes: 'Product attributes', productType: 'Product classification', images: 'Images', content: 'Listing content', 'variations.includedSkus': 'Selected variants' }
  const excluded = reusable.excluded.map(key => labels[key] ?? key)
  const skuFields: Array<{ label: string; before: { absent?: boolean; value?: unknown }; after: { absent?: boolean; value?: unknown }; changed: boolean }> = []
  if (reusable.defaults.skuStrategy) {
    if (!unlisted) excluded.push('Listing SKU strategy: existing listing identities are preserved')
    else if (!key.startsWith('AMAZON:')) excluded.push('Listing SKU strategy: this channel does not consume these defaults')
    else {
      const original = bag(state.skuStrategy)
      const compatible = { ...bag(reusable.defaults.skuStrategy) }
      if (owns(compatible, 'fbaFbm')) { delete compatible.fbaFbm; excluded.push('Fulfilment SKU suffix: not consumed by this listing workflow') }
      const filled = fillPresetDefaults(state, { skuStrategy: compatible })
      const after = bag(filled.skuStrategy)
      const skuLabels: Record<string, string> = { parentSku: 'Future parent listing SKU', childSku: 'Future variant listing SKUs', fbaFbm: 'Future fulfilment listing SKUs' }
      for (const key of Object.keys(compatible)) {
        const changed = !owns(original, key) && owns(after, key)
        skuFields.push({ label: skuLabels[key]!, before: owns(original, key) ? { value: original[key] } : owns(state, 'skuStrategy') && state.skuStrategy !== original ? { value: state.skuStrategy } : { absent: true }, after: owns(after, key) ? { value: after[key] } : owns(filled, 'skuStrategy') && filled.skuStrategy !== after ? { value: filled.skuStrategy } : { absent: true }, changed })
      }
      if (skuFields.some(field => field.changed)) state.skuStrategy = filled.skuStrategy
    }
  }
  for (const k of Object.keys(bag(defaults.themeByChannel))) if (k !== key) excluded.push(`Variation theme for ${k}`)
  for (const k of Object.keys(bag(defaults.customAttributesByChannel))) excluded.push(`Custom variation axes for ${k}: choose these in the wizard`)
  const variation = bag(state.variations), slice = bag(channelStates[key]), consumer = bag(slice.variations)
  const perChannel = bag(variation.themeByChannel)
  const proposal = owns(bag(defaults.themeByChannel), key) ? defaults.themeByChannel[key] : defaults.commonTheme
  // Explicit container null/false/blank is owned too, as are all three theme representations.
  const containerOwned = (owns(state, 'variations') && state.variations !== variation) || (owns(channelStates, key) && channelStates[key] !== slice) || (owns(slice, 'variations') && slice.variations !== consumer) || (owns(variation, 'themeByChannel') && variation.themeByChannel !== perChannel)
  const explicit = containerOwned || owns(consumer, 'theme') || owns(perChannel, key) || owns(variation, 'commonTheme')
  const before = owns(consumer, 'theme') ? consumer.theme : owns(perChannel, key) ? perChannel[key] : variation.commonTheme
  const themeChanged = !explicit && typeof proposal === 'string' && proposal.length > 0
  if (themeChanged) {
    state.variations = { ...variation, themeByChannel: { ...perChannel, [key]: proposal } }
    channelStates[key] = { ...slice, variations: { ...consumer, theme: proposal } }
  }
  return { state, channelStates, excluded, changed: themeChanged || skuFields.some(field => field.changed), themeChanged, skuFields, before: before === undefined ? { absent: true } : { value: before }, after: themeChanged ? { value: proposal } : before === undefined ? { absent: true } : { value: before }, proposal }
}

export class ProductPresetService {
  constructor(private readonly db: PrismaClient) {}

  private async plan(db: Db, scope: ProductPresetScope, presetId: string, wizardId?: string) {
    if (wizardId !== undefined && (typeof wizardId !== 'string' || !wizardId)) throw new ProductPresetError('A draft ID must be a non-empty string.', 400)
    const target = await validateProductPresetScope(db, scope)
    const channels = [{ platform: scope.channel, marketplace: scope.market }], key = `${scope.channel}:${scope.market}`
    const hash = channelsHash(channels)
    const [preset, wizard] = await Promise.all([
      db.wizardTemplate.findUnique({ where: { id: presetId } }),
      wizardId ? db.listingWizard.findUnique({ where: { id: wizardId } }) : db.listingWizard.findFirst({ where: { productId: scope.productId, channelsHash: hash, status: 'DRAFT' } }),
    ])
    if (!preset) throw new ProductPresetError('The preset is unavailable.', 404)
    if (Array.isArray(preset.channels) && preset.channels.some(c => ['accountId', 'channelConnectionId', 'aliasId', 'aliasKey', 'listingId'].some(k => owns(bag(c), k)))) throw new ProductPresetError('This preset contains account or alias destinations that the wizard cannot represent safely.')
    if (wizardId && !wizard) throw new ProductPresetError('The requested draft is unavailable.', 404)
    if (wizard && (wizard.productId !== scope.productId || wizard.status !== 'DRAFT' || wizard.channelsHash !== hash || fingerprint(wizard.channels) !== fingerprint(channels))) throw new ProductPresetError('This draft belongs to another product or destination set.')
    if (wizard && (bag(wizard.state) !== wizard.state || bag(wizard.channelStates) !== wizard.channelStates)) throw new ProductPresetError('The draft has an unsupported state shape. Its explicit values were preserved.')
    if (wizard && productPresetScopeOf(wizard) && !sameProductPresetScope(productPresetScopeOf(wizard), scope)) throw new ProductPresetError('This draft was reviewed for a different account or listing. It cannot be resumed here.')
    if (wizard?.expiresAt && wizard.expiresAt <= new Date()) throw new ProductPresetError('This draft has expired. Prepare a current listing draft first.')
    const destinations = normalizeChannels(preset.channels)
    if (!destinations.some(c => c.platform === scope.channel && c.marketplace === scope.market)) throw new ProductPresetError('This preset does not include the selected destination.')
    const state = bag(wizard?.state), channelStates = bag(wizard?.channelStates)
    const projected = projectProductPreset(state, channelStates, preset.defaults, key, !target.listing)
    if (target.listing?.variationTheme !== null && target.listing?.variationTheme !== undefined && projected.themeChanged) {
      // Stored listing choices also remain owned. Do not suggest replacing them via a draft default.
      projected.changed = false
      projected.themeChanged = false
      projected.before = { value: target.listing.variationTheme }
      projected.after = { value: target.listing.variationTheme }
      projected.excluded.push('Existing listing variation theme: preserved')
    }
    projected.excluded.push(...destinations.filter(c => c.platform !== scope.channel || c.marketplace !== scope.market).map(c => `Destination ${c.platform} ${c.marketplace}`))
    // Classification comes from the draft's existing selection or this exact listing, never the preset hint.
    const listingAttributes = bag(target.listing?.platformAttributes)
    const slice = bag(channelStates[key])
    const type = owns(slice, 'productType') ? bag(slice.productType).productType : owns(state, 'productType') ? bag(state.productType).productType : scope.channel === 'AMAZON' ? listingAttributes.productType : listingAttributes.categoryId
    let themes: Array<{ id: string; label: string; requiredAttributes: string[] }> = []
    if (projected.themeChanged) {
      if (typeof type !== 'string' || !type) throw new ProductPresetError('Choose a product type or category in the listing draft first, or classify this listing in Information, then review the preset again.')
      const variations = await new VariationsService(db as PrismaClient).getMultiChannelVariationsPayload({ productId: scope.productId, channels, productTypeByChannel: { [key]: type }, selectedThemeByChannel: {} })
      themes = variations.themesByChannel[key] ?? []
      if (!themes.some(t => t.id === projected.proposal)) throw new ProductPresetError('The preset theme is not supported by this product type and destination. Choose a compatible preset.')
    }
    if (!wizard && typeof type === 'string' && type) projected.channelStates[key] = { ...bag(projected.channelStates[key]), productType: { productType: type } }
    const reviewKey = fingerprint({ scope, preset: { id: preset.id, updatedAt: preset.updatedAt, defaults: preset.defaults, channels: preset.channels }, target, wizard: wizard ?? null, themes, projected })
    return { scope, target, preset, wizard, channels, hash, key, projected, reviewKey }
  }

  async review(scopeInput: unknown, presetId: string, wizardId?: string) {
    const plan = await this.plan(this.db, parseProductPresetScope(scopeInput), presetId, wizardId)
    return this.reviewResult(plan)
  }
  private reviewResult(plan: Awaited<ReturnType<ProductPresetService['plan']>>) {
    return { scope: plan.scope, reviewKey: plan.reviewKey, wizardId: plan.wizard?.id ?? null, preset: { id: plan.preset.id, name: plan.preset.name, updatedAt: plan.preset.updatedAt.toISOString() }, product: plan.target.product, account: { id: plan.target.account.id, name: plan.target.account.displayName }, listing: plan.target.listing ? { id: plan.target.listing.id, title: plan.target.listing.title } : null, before: plan.projected.before, after: plan.projected.after, skuFields: plan.projected.skuFields, changed: plan.projected.changed, excluded: plan.projected.excluded, operation: 'apply-once', persistence: 'wizard-draft', publication: 'separate' }
  }
  async apply(scopeInput: unknown, presetId: string, reviewKey: string, wizardId?: string) {
    if (!reviewKey) throw new ProductPresetError('Review the preset before applying it.', 400)
    const scope = parseProductPresetScope(scopeInput)
    try {
      return await this.db.$transaction(async tx => {
        const plan = await this.plan(tx, scope, presetId, wizardId)
        const receipt = bag(bag(plan.wizard?.state).productPresetReceipt)
        if (receipt.reviewKey === reviewKey && receipt.presetId === presetId && receipt.version === plan.wizard?.version) return { wizard: plan.wizard!, applied: true, replayed: true }
        if (plan.reviewKey !== reviewKey) throw new ProductPresetError('The product, account, listing, preset or draft changed. Review the current values again.')
        if (!plan.projected.changed) throw new ProductPresetError('Existing choices are preserved; there are no missing compatible defaults to apply.')
        const state: Prisma.InputJsonObject = { ...plan.projected.state, [PRODUCT_PRESET_SCOPE]: { ...scope }, productPresetReceipt: { reviewKey, presetId, version: (plan.wizard?.version ?? 0) + 1, appliedAt: new Date().toISOString() } }
        let saved
        if (plan.wizard) {
          const result = await tx.listingWizard.updateMany({ where: { id: plan.wizard.id, status: 'DRAFT', version: plan.wizard.version, updatedAt: plan.wizard.updatedAt }, data: { state, channelStates: plan.projected.channelStates, version: { increment: 1 } } })
          if (!result.count) throw new ProductPresetError('The draft changed while saving. Review again.')
          saved = await tx.listingWizard.findUniqueOrThrow({ where: { id: plan.wizard.id } })
        } else {
          saved = await tx.listingWizard.create({ data: { productId: scope.productId, channels: plan.channels, channelsHash: plan.hash, state, channelStates: plan.projected.channelStates, status: 'DRAFT', currentStep: 1, expiresAt: new Date(Date.now() + 30 * 86400000) } })
        }
        const used = await tx.wizardTemplate.updateMany({ where: { id: presetId, updatedAt: plan.preset.updatedAt }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date(), updatedAt: plan.preset.updatedAt } })
        if (!used.count) throw new ProductPresetError('The preset changed while saving. Review again.')
        return { wizard: saved, applied: true, replayed: false }
      }, { isolationLevel: 'Serializable', timeout: 20000 })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034'].includes(String(error.code))) throw new ProductPresetError('The draft changed concurrently. Reload and review again.')
      throw error
    }
  }
}

/** Recheck a bound draft before route-specific actions or telemetry. */
export async function validateProductPresetDraft(db: Db, id: string): Promise<boolean> {
  const wizard = await db.listingWizard.findUnique({ where: { id } })
  const scope = wizard && productPresetScopeOf(wizard)
  if (!scope) return false
  if (wizard.status !== 'DRAFT' || wizard.expiresAt <= new Date()) throw new ProductPresetError('This product draft is no longer active. Open the current product destination and review again.')
  await validateProductPresetScope(db, parseProductPresetScope(scope))
  return true
}
