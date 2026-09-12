import prisma from '../../db.js'
import { REFERENCE_FIELDS, resolveReferenceValue, type ReferenceChoice, type ReferenceField } from '@nexus/shared/reference-values'

export interface ReferenceInput {
  field: ReferenceField; value: unknown; channel: string; marketplace: string; accountId?: string | null; productType?: string | null
}
export type ReferenceResolver = (input: ReferenceInput) => Promise<string | null>
type ThemeDb = Pick<typeof prisma, 'ebayDescriptionTheme'>

/** One request/review batch owns its choices. A later apply gets a fresh resolver. */
export function createReferenceResolver(db: ThemeDb = prisma): ReferenceResolver {
  const cache = new Map<string, Promise<ReferenceChoice[]>>()
  const policies = new Map<string, Promise<import('../ebay-account.service.js').EbayAccountSnapshot>>()
  return async input => {
    const { field, value, channel, marketplace, accountId, productType } = input
    const label = REFERENCE_FIELDS[field].label
    if (REFERENCE_FIELDS[field].channel !== channel) throw new Error(`${label}: edit this reference in its ${REFERENCE_FIELDS[field].channel} listing scope.`)
    // Clear does not need provider credentials. Follow/inherit is handled by the caller.
    if (value == null || typeof value === 'string' && !value.trim()) return null
    if (typeof value !== 'string') return resolveReferenceValue(field, value, [])
    const choiceField = field === 'shippingTemplate' ? 'merchant_shipping_group' : field
    const key = field === 'descriptionThemeId' ? field : JSON.stringify([choiceField, accountId, marketplace, productType])
    if (!cache.has(key)) cache.set(key, (async () => {
      if (field === 'descriptionThemeId') {
        const themes = await db.ebayDescriptionTheme.findMany({ select: { id: true, name: true, active: true } })
        return [{ id: 'none', name: 'No theme' }, { id: '', name: 'Default theme' }, ...themes]
      }
      if (!accountId || !marketplace) throw new Error(`${label}: choose an account and marketplace before assigning a reference.`)
      if (channel === 'ETSY') {
        const { etsyReferenceChoices, isEtsyReference } = await import('../etsy/information-references.js')
        if (!isEtsyReference(field)) throw new Error('Unsupported Etsy reference.')
        return etsyReferenceChoices(accountId, field)
      }
      if (channel === 'EBAY') {
        const market = `EBAY_${marketplace === 'UK' ? 'GB' : marketplace}`
        const scope = JSON.stringify([accountId, market])
        if (!policies.has(scope)) policies.set(scope, import('../ebay-account.service.js').then(({ ebayAccountService }) => ebayAccountService.getSnapshot(accountId, market, { forceRefresh: true, requireComplete: true })))
        const snapshot = await policies.get(scope)!
        const list = field === 'fulfillmentPolicyId' ? snapshot.fulfillmentPolicies : field === 'paymentPolicyId' ? snapshot.paymentPolicies : snapshot.returnPolicies
        if (!Array.isArray(list)) throw new Error('Incomplete policy response')
        // A null marketplace is not proof that this policy belongs to the requested market.
        return list.filter(policy => policy.marketplaceId === market).map(policy => ({ id: policy.id, name: policy.name }))
      }
      if (!productType) throw new Error('Choose a product type first')
      const { sellerShippingTemplateLabels } = await import('../categories/reference-labels.service.js')
      const names = await sellerShippingTemplateLabels({ marketplace, productType, accountId, refresh: true })
      return Object.entries(names).map(([id, name]) => ({ id, name }))
    })().then(choices => {
      if (choices.some(choice => typeof choice.id !== 'string' || typeof choice.name !== 'string' || !choice.name.trim())) throw new Error('Incomplete reference response')
      return choices
    }).catch(() => {
      throw new Error(`${label} choices could not be verified. ${field === 'descriptionThemeId' ? 'Reload and try again.' : 'Check the channel connection and try again.'} The existing value has been kept.`)
    }))
    const resolved = resolveReferenceValue(field, value, await cache.get(key)!)
    return resolved === '' ? null : resolved
  }
}
