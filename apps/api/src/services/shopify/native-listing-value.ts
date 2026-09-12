import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { storedChannelState } from '../pim/channel-value-mutation.js'

const fields = shopifyProductSpec().fields
/** Legacy imported keys and current sheet overrides share precedence and explicit clears. */
export function nativeListingValue(listing: unknown, id: string, inherited?: unknown): unknown {
  const field = fields.find(f => f.shopifyField?.id === id)
  if (!field) throw new Error(`Unknown Shopify attribute: ${id}`)
  const state = storedChannelState((listing ?? {}) as Record<string, unknown>, field.channelStore, [field.masterKey ?? field.key, field.key])
  return state.state === 'stored' ? state.value : inherited
}
