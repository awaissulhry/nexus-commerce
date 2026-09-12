export const REFERENCE_FIELDS = {
  shipping_profile_id: { channel: 'ETSY', label: 'Shipping profile' },
  shop_section_id: { channel: 'ETSY', label: 'Shop section' },
  return_policy_id: { channel: 'ETSY', label: 'Return policy' },
  readiness_state_id: { channel: 'ETSY', label: 'Processing profile' },
  descriptionThemeId: { channel: 'EBAY', label: 'Description theme' },
  fulfillmentPolicyId: { channel: 'EBAY', label: 'Shipping policy' },
  paymentPolicyId: { channel: 'EBAY', label: 'Payment policy' },
  returnPolicyId: { channel: 'EBAY', label: 'Return policy' },
  merchant_shipping_group: { channel: 'AMAZON', label: 'Shipping template' },
  shippingTemplate: { channel: 'AMAZON', label: 'Shipping template' },
} as const
export type ReferenceField = keyof typeof REFERENCE_FIELDS
export const isReferenceField = (key: string): key is ReferenceField => Object.prototype.hasOwnProperty.call(REFERENCE_FIELDS, key)
export interface ReferenceChoice { id: string; name: string; active?: boolean }

/** Exact IDs win. Names are case-insensitive but must identify exactly one choice. */
export function resolveReferenceValue(field: ReferenceField, input: unknown, choices: ReferenceChoice[]): string | null {
  const label = REFERENCE_FIELDS[field].label
  if (input == null || typeof input === 'string' && !input.trim()) return null
  if (typeof input !== 'string') throw new Error(`${label}: enter a name or an ID as text.`)
  const text = input.trim()
  const exact = choices.filter(choice => choice.id === text)
  const matches = exact.length ? exact : choices.filter(choice => choice.name.trim().toLowerCase() === text.toLowerCase())
  const ids = new Set(matches.map(choice => choice.id))
  if (ids.size > 1) throw new Error(`${label}: "${text}" matches more than one choice. Select a specific choice or use its ID.`)
  if (!matches.length) throw new Error(`${label}: "${text}" is not an available choice for this scope. Refresh the choices and select a valid name or ID.`)
  if (matches.some(choice => choice.active === false)) throw new Error(`${label}: "${text}" is inactive. Select an active choice.`)
  return matches[0].id
}
