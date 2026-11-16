import { describe, expect, it } from 'vitest'
import { isOwnAddress, outsideAddressWords, RECIPIENT_REFUSALS, recipientRule, type AddressOwnership } from './recipient-party'

/** B-TH-004: the one recipient rule of every mail on a party's record (pure). Made-up parties and addresses only. */

const ALPHA = 'party-alpha'
const BETA = 'party-beta'
const ownership = new Map<string, AddressOwnership>(
  [
    { address: 'anna@brand-alpha.example', parties: [ALPHA], ours: false },
    { address: 'bruno@brand-beta.example', parties: [BETA], ours: false },
    { address: 'agent@agency.example', parties: [ALPHA, BETA], ours: false },
    { address: 'sara@factory.example', parties: [], ours: true },
    { address: 'portal.beta@brand-beta.example', parties: [BETA], ours: false },
  ].map((entry) => [entry.address, entry]),
)

describe('recipientRule (B-TH-004)', () => {
  it('lets the party’s own addresses, a contact of both parties, ours and unknown ones through To and Cc', () => {
    expect(recipientRule({ recordParty: ALPHA, to: ['anna@brand-alpha.example'], cc: ['agent@agency.example', 'sara@factory.example', 'new@nobody.example'], ownership })).toEqual({ outside: [], hiddenOutside: [] })
  })

  it('holds back another party’s contact or portal person in To or Cc, at its field and place, naming whose it is', () => {
    const result = recipientRule({ recordParty: ALPHA, to: ['anna@brand-alpha.example', 'Bruno@Brand-Beta.example'], cc: ['portal.beta@brand-beta.example'], ownership })
    expect(result.outside).toEqual([
      { address: 'bruno@brand-beta.example', field: 'to', index: 1, parties: [BETA] },
      { address: 'portal.beta@brand-beta.example', field: 'cc', index: 0, parties: [BETA] },
    ])
    expect(result.hiddenOutside).toEqual([])
  })

  it('takes a blind copy only to our own people or the party’s own: another party’s or an unknown address is hidden outside', () => {
    const result = recipientRule({ recordParty: ALPHA, to: ['anna@brand-alpha.example'], bcc: ['sara@factory.example', 'anna@brand-alpha.example', 'bruno@brand-beta.example', 'new@nobody.example'], ownership })
    expect(result.hiddenOutside).toEqual([
      { address: 'bruno@brand-beta.example', field: 'bcc', index: 2, parties: [BETA] },
      { address: 'new@nobody.example', field: 'bcc', index: 3, parties: [] },
    ])
    expect(result.outside).toEqual([])
  })

  it('does not apply to a record without a party', () => {
    expect(recipientRule({ recordParty: null, to: ['bruno@brand-beta.example'], bcc: ['new@nobody.example'], ownership })).toEqual({ outside: [], hiddenOutside: [] })
  })

  it('says the reason for the office in words; the refusals have Italian and English', () => {
    expect(isOwnAddress(ALPHA, ownership.get('agent@agency.example'))).toBe(true)
    expect(isOwnAddress(ALPHA, undefined)).toBe(false)
    const names = new Map([[BETA, 'Brand Beta']])
    expect(outsideAddressWords({ address: 'bruno@brand-beta.example', field: 'cc', index: 0, parties: [BETA] }, (id) => names.get(id) ?? '')).toBe('bruno@brand-beta.example belongs to Brand Beta.')
    expect(outsideAddressWords({ address: 'new@nobody.example', field: 'bcc', index: 0, parties: [] }, () => '')).toBe('new@nobody.example is not one of ours nor of this customer.')
    for (const words of Object.values(RECIPIENT_REFUSALS)) {
      expect(words.it.length).toBeGreaterThan(20)
      expect(words.en.length).toBeGreaterThan(20)
    }
    expect(RECIPIENT_REFUSALS.OTHER_PARTY.en).toContain('Send outside this customer')
  })
})
