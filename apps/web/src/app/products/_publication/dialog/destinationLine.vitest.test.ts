import { expect, it } from 'vitest'
import { publicationDestinationParts } from './PublishDialog'

const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' }

it('names account, listing and market with no stray separator', () => {
  expect(publicationDestinationParts({ accountLabel: 'Xavia store', aliasLabel: 'Primary listing', scope })).toEqual({ lead: 'Xavia store', rest: 'Primary listing · IT' })
})

it('falls back to the channel when the account has no name, and skips empty parts', () => {
  expect(publicationDestinationParts({ accountLabel: '', aliasLabel: 'Primary listing', scope })).toEqual({ lead: 'Amazon', rest: 'Primary listing · IT' })
  expect(publicationDestinationParts({ accountLabel: '  ', aliasLabel: '', scope })).toEqual({ lead: 'Amazon', rest: 'IT' })
  expect(publicationDestinationParts({ accountLabel: 'Store', aliasLabel: 'Second listing', scope }, false)).toEqual({ lead: 'Store', rest: 'IT' })
  for (const line of [publicationDestinationParts({ accountLabel: '', aliasLabel: '', scope: { ...scope, marketplace: '' } })]) {
    expect(line.lead).not.toMatch(/^\s*·|·\s*$/); expect(line.rest).not.toMatch(/^\s*·|·\s*$/)
  }
})

it('names a listing alias with the sheet band’s mark when the window gives it (aliases, 2026-10-05)', () => {
  const alias = { accountLabel: 'Store', aliasLabel: 'normal-knee-slider-ALT1', scope: { ...scope, listingId: 'alias-1' } }
  expect(publicationDestinationParts(alias, true, '① normal-knee-slider-ALT1')).toEqual({ lead: 'Store', rest: '① normal-knee-slider-ALT1 · IT' })
  expect(publicationDestinationParts({ accountLabel: 'Store', aliasLabel: 'Primary listing', scope }, true, '★ Primary')).toEqual({ lead: 'Store', rest: '★ Primary · IT' })
  // No listing name from the window (a market's only listing): the review's own words, as before.
  expect(publicationDestinationParts(alias, true, null)).toEqual({ lead: 'Store', rest: 'normal-knee-slider-ALT1 · IT' })
})
