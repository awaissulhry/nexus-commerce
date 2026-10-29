import { describe, expect, it } from 'vitest'
import { decideVatTreatment } from '../tax/vat-treatment'
import { checkTaxIdentity, customerTaxProfile, euVatNumberProblem, identityAt, suggestTaxMode, taxKeysOf, type TaxIdentityInput } from './tax'
import { viesRequesterOf, viesStanding, viesTargetOf, zeroRatingProof, type ViesCheckFacts } from './vies'

/**
 * Tax identities and the VIES proof (SAL-005, SAL-006; D.Lgs. 127/2015, art. 41 DL 331/1993). Every number here is
 * made up: Italian ones with a correct check digit that names no real business (the tax/tax-ids tests' fakes), EU ones
 * in the right shape only.
 */
const IT_VAT = '12345670009'
const DAY = '2026-10-01'
const it_b2b = (extra: Partial<TaxIdentityInput> = {}): TaxIdentityInput => ({ country: 'IT', taxMode: 'IT_B2B', vatNumber: IT_VAT, validFrom: DAY, ...extra })

describe('a tax identity (SAL-005)', () => {
  it('keeps one canonical form: the prefix added, spaces and dots gone, capitals, PEC in lower case', () => {
    expect(checkTaxIdentity(it_b2b({ vatNumber: ' 123 456 700 09 ', fiscalCode: '12345670009', sdiRecipientCode: 'abc1234', pec: ' Fatture@PEC.Example.IT ' }))).toEqual({
      ok: true,
      identity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: `IT${IT_VAT}`, fiscalCode: IT_VAT, sdiRecipientCode: 'ABC1234', pec: 'fatture@pec.example.it', validFrom: DAY },
    })
    expect(checkTaxIdentity({ country: 'DE', taxMode: 'EU_B2B', vatNumber: 'de 100.000.000', validFrom: DAY })).toMatchObject({ ok: true, identity: { vatNumber: 'DE100000000' } })
    expect(checkTaxIdentity({ country: 'GR', taxMode: 'EU_B2B', vatNumber: '100000000', validFrom: DAY })).toMatchObject({ ok: true, identity: { vatNumber: 'EL100000000' } })
    expect(checkTaxIdentity({ country: 'AT', taxMode: 'EU_B2B', vatNumber: 'U10000000', validFrom: DAY })).toMatchObject({ ok: true, identity: { vatNumber: 'ATU10000000' } })
  })

  it("checks an Italian Partita IVA's check digit and a codice fiscale's check character", () => {
    expect(checkTaxIdentity(it_b2b({ vatNumber: '12345670008' }))).toMatchObject({ ok: false, issues: [{ path: 'vatNumber', message: expect.stringContaining('check digit') }] })
    expect(checkTaxIdentity(it_b2b({ fiscalCode: 'TSTPRV80A41Z999J' }))).toMatchObject({ ok: false, issues: [{ path: 'fiscalCode' }] })
    // A sole trader: a Partita IVA and a person's codice fiscale.
    expect(checkTaxIdentity(it_b2b({ fiscalCode: 'tstprv80a41z999i' })).ok).toBe(true)
  })

  it('checks each EU state\'s VAT number shape and its prefix against the country', () => {
    expect(euVatNumberProblem('DE10000000', 'DE')).toBe('A VAT number of DE is DE and 9 digits.')
    expect(euVatNumberProblem('FR100000000', 'DE')).toBe('A VAT number of DE starts with DE.')
    expect(euVatNumberProblem('GR100000000', 'GR')).toBe('A VAT number of GR starts with EL.')
    expect(euVatNumberProblem('NL100000000B01', 'NL')).toBeNull()
    expect(euVatNumberProblem('ESB10000000', 'ES')).toBeNull()
    expect(euVatNumberProblem('ES100000000', 'ES')).not.toBeNull()
    expect(euVatNumberProblem('SE100000000001', 'SE')).toBeNull()
    expect(checkTaxIdentity({ country: 'DE', taxMode: 'EU_B2B', vatNumber: null, validFrom: DAY })).toMatchObject({ ok: false, issues: [{ path: 'vatNumber' }] })
  })

  it('fits the tax mode to the country and keeps Italian fields Italian', () => {
    expect(checkTaxIdentity({ country: 'DE', taxMode: 'IT_B2B', vatNumber: IT_VAT, validFrom: DAY })).toMatchObject({ ok: false, issues: [{ path: 'country', message: 'Tax mode IT_B2B is for IT.' }] })
    expect(checkTaxIdentity({ country: 'DE', taxMode: 'EU_B2B', vatNumber: '100000000', sdiRecipientCode: 'ABC1234', pec: 'x@pec.example.it', validFrom: DAY })).toMatchObject({
      ok: false,
      issues: [{ path: 'sdiRecipientCode' }, { path: 'pec' }],
    })
    // XXXXXXX on a foreign identity is what FatturaPA carries anyway: stored as nothing.
    expect(checkTaxIdentity({ country: 'CH', taxMode: 'EXTRA_EU', vatNumber: 'CHE-100.000.000', sdiRecipientCode: 'XXXXXXX', validFrom: DAY })).toMatchObject({
      ok: true,
      identity: { vatNumber: 'CHE100000000', sdiRecipientCode: null },
    })
  })

  it('invoices an Italian consumer with the codice fiscale, never a VAT number', () => {
    expect(checkTaxIdentity({ country: 'IT', taxMode: 'IT_B2C', fiscalCode: 'TSTPRV80A41Z999I', sdiRecipientCode: '0000000', validFrom: DAY }).ok).toBe(true)
    expect(checkTaxIdentity({ country: 'IT', taxMode: 'IT_B2C', validFrom: DAY })).toMatchObject({ ok: false, issues: [{ path: 'fiscalCode' }] })
    expect(checkTaxIdentity({ country: 'IT', taxMode: 'IT_B2C', vatNumber: IT_VAT, fiscalCode: 'TSTPRV80A41Z999I', validFrom: DAY })).toMatchObject({ ok: false, issues: [{ path: 'vatNumber' }] })
  })

  it('refuses a public administration office code (6 characters) and a malformed SDI code', () => {
    expect(checkTaxIdentity(it_b2b({ sdiRecipientCode: 'UFABCD' }))).toMatchObject({ ok: false, issues: [{ path: 'sdiRecipientCode', message: expect.stringContaining('public administration') }] })
    expect(checkTaxIdentity(it_b2b({ sdiRecipientCode: 'AB-12' }))).toMatchObject({ ok: false, issues: [{ path: 'sdiRecipientCode' }] })
    expect(checkTaxIdentity(it_b2b({ sdiRecipientCode: '0000000' })).ok).toBe(true)
  })

  it('takes the identity in force on a day: the newest validFrom on or before it', () => {
    const identities = [{ id: 'a', validFrom: '2026-01-01' }, { id: 'c', validFrom: '2027-01-01' }, { id: 'b', validFrom: '2026-07-01' }]
    expect(identityAt(identities, '2025-12-31')).toBeNull()
    expect(identityAt(identities, '2026-06-30')?.id).toBe('a')
    expect(identityAt(identities, '2026-07-01')?.id).toBe('b')
    expect(identityAt(identities, '2027-03-01')?.id).toBe('c')
  })

  it('suggests a tax mode and makes the duplicate keys of a company (its VAT digits are its codice fiscale)', () => {
    expect(suggestTaxMode({ country: 'IT', hasVatNumber: true })).toBe('IT_B2B')
    expect(suggestTaxMode({ country: 'FR', hasVatNumber: false })).toBe('EU_B2C')
    expect(suggestTaxMode({ country: 'US', hasVatNumber: true })).toBe('EXTRA_EU')
    expect(taxKeysOf({ vatNumber: `IT${IT_VAT}`, fiscalCode: null })).toEqual({ vatNumbers: [`IT${IT_VAT}`], fiscalCodes: [IT_VAT] })
    expect(taxKeysOf({ vatNumber: null, fiscalCode: IT_VAT })).toEqual({ vatNumbers: [`IT${IT_VAT}`], fiscalCodes: [IT_VAT] })
    expect(taxKeysOf({ vatNumber: 'DE100000000', fiscalCode: null })).toEqual({ vatNumbers: ['DE100000000'], fiscalCodes: [] })
  })
})

describe('the VIES proof (SAL-006; art. 41 DL 331/1993)', () => {
  const EU = { country: 'DE', vatNumber: 'DE100000000' }
  const at = (iso: string) => new Date(iso)
  let n = 0
  const check = (result: ViesCheckFacts['result'], iso: string, extra: Partial<ViesCheckFacts> = {}): ViesCheckFacts => ({
    id: `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    countryCode: 'DE',
    vatNumber: '100000000',
    requestedAt: at(iso),
    result,
    consultationNumber: result === 'VALID' ? `WAPIAAAA${n}` : null,
    errorCode: result === 'ERROR' ? 'MS_UNAVAILABLE' : null,
    ...extra,
  })

  it('checks EU numbers outside Italy only, with the member-state code (EL for Greece)', () => {
    expect(viesTargetOf(EU)).toEqual({ countryCode: 'DE', vatNumber: '100000000' })
    expect(viesTargetOf({ country: 'GR', vatNumber: 'EL100000000' })).toEqual({ countryCode: 'EL', vatNumber: '100000000' })
    expect(viesTargetOf({ country: 'IT', vatNumber: `IT${IT_VAT}` })).toBeNull()
    expect(viesTargetOf({ country: 'CH', vatNumber: 'CHE100000000' })).toBeNull()
    expect(viesTargetOf({ country: 'DE', vatNumber: null })).toBeNull()
    expect(viesRequesterOf(`IT${IT_VAT}`)).toEqual({ countryCode: 'IT', vatNumber: IT_VAT })
    expect(viesRequesterOf(null)).toBeNull()
  })

  it('proves a sale with a valid identified check at most 30 days old', () => {
    const valid = check('VALID', '2026-10-01T09:00:00Z')
    const standing = viesStanding(EU, [valid], at('2026-10-20T00:00:00Z'))
    expect(standing).toMatchObject({ state: 'VALID', proof: valid, validUntil: at('2026-10-31T09:00:00Z') })
    expect(zeroRatingProof(EU, [valid], at('2026-10-31T09:00:00Z'))).toEqual({ ok: true, check: valid })
    expect(viesStanding(EU, [valid], at('2026-10-31T09:00:01Z')).state).toBe('EXPIRED')
    // A check made after the moment is no proof for it.
    expect(viesStanding(EU, [valid], at('2026-09-30T00:00:00Z')).state).toBe('UNCHECKED')
  })

  it('never passes on a check that gave no answer: HELD, with the reason', () => {
    const error = check('ERROR', '2026-10-02T09:00:00Z')
    expect(viesStanding(EU, [error], at('2026-10-03T00:00:00Z'))).toMatchObject({ state: 'HELD', proof: null, latest: error })
    expect(zeroRatingProof(EU, [error], at('2026-10-03T00:00:00Z'))).toMatchObject({ ok: false, state: 'HELD' })
    // A valid proof stays when a later check gets no answer…
    const valid = check('VALID', '2026-10-01T09:00:00Z')
    expect(viesStanding(EU, [valid, error], at('2026-10-03T00:00:00Z')).state).toBe('VALID')
    // …but an expired one with a failed refresh is held.
    expect(viesStanding(EU, [valid, error], at('2026-11-15T00:00:00Z')).state).toBe('HELD')
    // An anonymous valid answer (no consultation number) is no proof.
    expect(viesStanding(EU, [check('VALID', '2026-10-01T09:00:00Z', { consultationNumber: null })], at('2026-10-03T00:00:00Z')).state).toBe('HELD')
  })

  it('lets a newer INVALID answer cancel an older proof, and a newer VALID one restore it', () => {
    const valid = check('VALID', '2026-10-01T09:00:00Z')
    const invalid = check('INVALID', '2026-10-05T09:00:00Z')
    expect(viesStanding(EU, [valid, invalid], at('2026-10-06T00:00:00Z')).state).toBe('INVALID')
    const again = check('VALID', '2026-10-07T09:00:00Z')
    expect(viesStanding(EU, [valid, invalid, again], at('2026-10-08T00:00:00Z'))).toMatchObject({ state: 'VALID', proof: again })
  })

  it('counts only checks of the number in force: a corrected number starts unchecked', () => {
    const valid = check('VALID', '2026-10-01T09:00:00Z')
    expect(viesStanding({ country: 'DE', vatNumber: 'DE100000010' }, [valid], at('2026-10-02T00:00:00Z')).state).toBe('UNCHECKED')
    expect(viesStanding({ country: 'IT', vatNumber: `IT${IT_VAT}` }, [valid], at('2026-10-02T00:00:00Z')).state).toBe('NOT_APPLICABLE')
  })

  it('feeds the VAT decision: zero-rated only with the proof (decideVatTreatment)', () => {
    const party = { kind: 'ORGANISATION' as const }
    const identity = { taxMode: 'EU_B2B' as const, vatNumber: 'DE100000000' }
    const proven = decideVatTreatment({ customer: customerTaxProfile(party, identity, true), supply: 'GOODS', rate: 22 })
    expect(proven.treatment).toMatchObject({ kind: 'NON_TAXABLE', natura: 'N3.2' })
    const held = decideVatTreatment({ customer: customerTaxProfile(party, identity, false), supply: 'GOODS', rate: 22 })
    expect(held.treatment).toMatchObject({ kind: 'TAXABLE', rate: 22 })
    expect(customerTaxProfile({ kind: 'PERSON' }, { taxMode: 'EXTRA_EU', vatNumber: null }, false)).toEqual({ taxMode: 'EXTRA_EU', extraEuBusiness: false })
  })
})
