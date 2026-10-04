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
