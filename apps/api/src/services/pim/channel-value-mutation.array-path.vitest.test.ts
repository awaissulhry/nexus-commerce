/**
 * Amazon sheet gaps (bug 6) — a generic channel-value write never goes through a list. It used to replace the list with
 * `{}`: a write to `fulfillment_availability/0/lead_time_to_ship_max_days` destroyed `fulfillment_channel_code`, the
 * code the FBA guard reads.
 */
import { describe, expect, it } from 'vitest'
import { applyPlatformMutations, channelValuePatch } from './channel-value-mutation.js'

const bag = () => ({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }], keep: 1 })

describe('array path segments', () => {
  it('a SET through an existing list is refused, and the bag is left as it was', () => {
    const before = bag()
    expect(() => applyPlatformMutations(before, [{ path: ['fulfillment_availability', '0', 'lead_time_to_ship_max_days'], value: 3, remove: false }]))
      .toThrow('cannot be written inside a list')
    expect(before).toEqual(bag())
  })

  it('the fulfilment column\'s own store cannot be written by the generic writer', () => {
    const store = { kind: 'platformAttributes' as const, path: ['fulfillment_availability', '0', 'fulfillment_channel_code'] }
    expect(() => channelValuePatch({ platformAttributes: bag() }, store, ['fulfillment_availability__fulfillment_channel_code'], 'SET', 'DEFAULT')).toThrow('inside a list')
  })

  it('a removal through a list stays a no-op (it never rewrites the list) — the mirror fallback paths rely on it', () => {
    expect(applyPlatformMutations(bag(), [{ path: ['fulfillment_availability', '0', 'lead_time_to_ship_max_days'], value: null, remove: true }])).toEqual(bag())
    const store = { kind: 'platformAttributes' as const, path: ['amazonFulfillment', 'lead_time_to_ship_max_days'], legacyPaths: [['fulfillment_availability', '0', 'lead_time_to_ship_max_days']] }
    const patch = channelValuePatch({ platformAttributes: bag() }, store, ['fulfillment_availability__lead_time_to_ship_max_days'], 'SET', 3)
    expect(patch.platformAttributes).toEqual({ ...bag(), amazonFulfillment: { lead_time_to_ship_max_days: 3 } })
  })

  it('numeric keys of an OBJECT are ordinary keys (Etsy properties by id) and still written', () => {
    expect(applyPlatformMutations({}, [{ path: ['etsyProperties', '200', 'scale_id'], value: 5, remove: false }])).toEqual({ etsyProperties: { '200': { scale_id: 5 } } })
  })
})
