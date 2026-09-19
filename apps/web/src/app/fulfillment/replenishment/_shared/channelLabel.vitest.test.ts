import { describe, expect, it } from 'vitest'
import { channelKeyLabel, channelLabel } from './channelLabel'

describe('shared stock step 7b — channel labels on the reorder page', () => {
  it('names pool demand for the borrowing business, and leaves real channels as they were shown', () => {
    expect(channelLabel('SHARED_POOL', 'Borrower B')).toBe('Shared stock · Borrower B')
    expect(channelLabel('AMAZON', 'IT')).toBe('AMAZON · IT')
    expect(channelKeyLabel('SHARED_POOL:Borrower B')).toBe('Shared stock · Borrower B')
    expect(channelKeyLabel('AMAZON:IT')).toBe('AMAZON·IT')
  })
})
