/**
 * The family read's mapping onto the Variants page: an Amazon listing whose ASIN is pending arrives as `asin_pending`
 * and reads "Published · ASIN pending" — published, and never a Draft.
 */
import { describe, expect, it } from 'vitest'

import { projectionMeta } from '@/design-system/grid/renderers/projection'

import { projectionState } from './projections'
import { fromStudio, type StudioFamilyResponse } from './useFamilyProjections'

const body = (state: string, externalId: string | null): StudioFamilyResponse => ({
  version: 1,
  channels: [{ channel: 'AMAZON', market: 'IT', connected: true, label: 'Amazon · IT', accountId: 'account-a' }],
  parent: { id: 'parent', projections: { 'AMAZON:IT': { state, externalId, listings: 1 } } },
  children: [{ id: 'child', projections: { 'AMAZON:IT': { included: true, state, externalId } } }],
})

describe('fromStudio', () => {
  it('reads asin_pending as a published row with its own word', () => {
    const projections = fromStudio(body('asin_pending', null))
    const channel = projections.channels[0]
    for (const id of ['child', 'parent']) {
      const row = projections.byProduct[id]['AMAZON:IT']
      expect(row).toMatchObject({ included: true, published: true, projectionState: 'asin-pending', externalId: null })
      expect(projectionMeta(projectionState(channel, row)).label).toBe('Published · ASIN pending')
    }
  })

  it('keeps Listed and Draft as they were', () => {
    const listed = fromStudio(body('listed', 'B0TEST0001')).byProduct.child['AMAZON:IT']
    expect(listed).toMatchObject({ published: true, projectionState: 'listed' })
    const draft = fromStudio(body('draft', null)).byProduct.child['AMAZON:IT']
    expect(draft).toMatchObject({ published: false, projectionState: 'draft' })
  })

  it('reads the row vocabulary’s `pending` as published too', () => {
    const row = fromStudio(body('pending', null)).byProduct.child['AMAZON:IT']
    expect(row).toMatchObject({ published: true, state: 'pending', projectionState: undefined })
    expect(projectionState(fromStudio(body('pending', null)).channels[0], row)).toBe('asin-pending')
  })
})
