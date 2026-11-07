import { describe, expect, it } from 'vitest'
import { supplierChangeWords } from './words'

/** B-W2b-F15: Today's SUPPLIER_CHANGE row names a change of the supplier's website (B-W2b-F13a's COMPANY target). */
describe("a supplier's profile change in Today's words", () => {
  it('says the website changed, instead of "addresses: 0, contacts: 0"', () => {
    expect(supplierChangeWords({ supplier: 'Seed Tannery', addresses: 0, contacts: 0, website: true }).sentence).toMatchObject({
      key: 'SUPPLIER_CHANGE.WAITING_WEBSITE',
      params: { supplier: 'Seed Tannery' },
      text: 'Seed Tannery sent a change of its website for our check.',
    })
    expect(supplierChangeWords({ supplier: 'Seed Tannery', addresses: 1, contacts: 0, website: true }).sentence.text).toBe('Seed Tannery sent changes of its profile for our check (website, addresses: 1, contacts: 0).')
    expect(supplierChangeWords({ supplier: 'Seed Tannery', addresses: 1, contacts: 2 }).sentence).toMatchObject({ key: 'SUPPLIER_CHANGE.WAITING', text: 'Seed Tannery sent changes of its profile for our check (addresses: 1, contacts: 2).' })
  })
})
