/**
 * Review 2026-10-05 — the studio bar's listing picker offers the same aliases as the Publish window: ACTIVE ones with a
 * record of the family's main product (an archived alias's rows are still read for its Status cell, never offered).
 */
import { describe, expect, it } from 'vitest'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import { listingChoicesOf } from './useListingChoices'

const cell = (over: Partial<PublishActionCell>): PublishActionCell => ({
  listingId: 'cl-main', productId: 'fam', sku: 'FAM', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: '', aliasLabel: null, aliasPosition: null, aliasStatus: null,
  state: 'active', stateReason: null,
  send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
  status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
  sendOptions: [], statusOptions: [], ...over,
})

describe('the listing picker’s listings', () => {
  it('lists the main listing and the offered aliases only', () => {
    const choices = listingChoicesOf([
      cell({}),
      cell({ listingId: 'cl-child', productId: 'child' }),
      cell({ listingId: 'cl-1', aliasKey: 'a1', aliasLabel: 'First', aliasPosition: 1, aliasStatus: 'ACTIVE' }),
      cell({ listingId: 'cl-2', aliasKey: 'a2', aliasLabel: 'Archived', aliasPosition: 2, aliasStatus: 'ARCHIVED' }),
      // Only a variation holds a record of it: it could never be reviewed from the family.
      cell({ listingId: 'cl-3-child', productId: 'child', aliasKey: 'a3', aliasLabel: 'Orphan', aliasPosition: 3, aliasStatus: 'ACTIVE' }),
    ], 'fam')
    expect(choices.mainListingId).toBe('cl-main')
    expect(choices.aliases.map(alias => alias.id)).toEqual(['a1'])
    // The records of an alias that is not offered do not name it.
    expect(choices.aliasByRecord['cl-2']).toBeUndefined()
    expect(choices.aliasByRecord['cl-1']).toBe('a1')
  })
})
