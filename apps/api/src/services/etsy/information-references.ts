import type { ReferenceChoice } from '@nexus/shared/reference-values'
import { etsyReader } from './read-client.js'

export const ETSY_REFERENCE_PATHS = {
  shipping_profile_id: 'shipping-profiles', shop_section_id: 'sections',
  return_policy_id: 'policies/return', readiness_state_id: 'readiness-state-definitions',
} as const
export type EtsyReferenceField = keyof typeof ETSY_REFERENCE_PATHS
export const isEtsyReference = (field: string): field is EtsyReferenceField => Object.prototype.hasOwnProperty.call(ETSY_REFERENCE_PATHS, field)

export function etsyReferenceChoice(field: EtsyReferenceField, row: Record<string, unknown>): ReferenceChoice {
  const id = row[field]
  if (!Number.isSafeInteger(id) || Number(id) < 1) throw new Error('Etsy returned an invalid resource ID.')
  let name: string
  if (field === 'return_policy_id') {
    if (typeof row.accepts_returns !== 'boolean' || typeof row.accepts_exchanges !== 'boolean') throw new Error('Etsy returned an incomplete return policy.')
    name = `${row.accepts_returns ? `Returns${row.return_deadline ? ` within ${row.return_deadline} days` : ''}` : 'No returns'} · ${row.accepts_exchanges ? 'exchanges accepted' : 'no exchanges'}`
  } else if (field === 'readiness_state_id') {
    if (!['ready_to_ship', 'made_to_order'].includes(String(row.readiness_state)) || typeof row.processing_days_display_label !== 'string') throw new Error('Etsy returned an incomplete processing profile.')
    name = `${row.readiness_state === 'ready_to_ship' ? 'Ready to ship' : 'Made to order'} · ${row.processing_days_display_label}`
  } else name = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : `Shipping profile ${id}`
  return { id: String(id), name, active: row.is_deleted !== true }
}

/** Read the selected shop only. Reject incomplete pages instead of presenting a truncated picker. */
export async function etsyReferenceChoices(accountId: string, field: EtsyReferenceField): Promise<ReferenceChoice[]> {
  const { shopId, get } = await etsyReader(accountId)
  const choices: ReferenceChoice[] = []
  const paged = field === 'readiness_state_id'
  let count = 0
  do {
    const body = await get<{ count: number; results: Array<Record<string, unknown>> }>(`/shops/${shopId}/${ETSY_REFERENCE_PATHS[field]}${paged ? `?limit=100&offset=${choices.length}` : ''}`)
    if (!Number.isSafeInteger(body.count) || body.count < 0 || !Array.isArray(body.results) || body.results.length > body.count || (count && body.count !== count)) throw new Error('Etsy returned an incomplete resource list. Retry the lookup.')
    count = body.count
    if (!body.results.length && choices.length < count) throw new Error('Etsy returned an incomplete resource page.')
    choices.push(...body.results.map(row => etsyReferenceChoice(field, row)))
    if (new Set(choices.map(choice => choice.id)).size !== choices.length || choices.length > count) throw new Error('Etsy returned inconsistent resource pages.')
    if (!paged && choices.length !== count) throw new Error('Etsy returned an incomplete resource list.')
  } while (choices.length < count)
  return choices
}
