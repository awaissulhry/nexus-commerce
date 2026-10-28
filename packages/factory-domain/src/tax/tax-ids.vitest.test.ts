import { describe, expect, it } from 'vitest'
import {
  isValidCodiceFiscale,
  isValidForeignTaxId,
  isValidIban,
  isValidPartitaIva,
  isValidPersonalCodiceFiscale,
  normalizeTaxId,
} from './tax-ids'

// All numbers here are FAKE, made up for the tests with a correct check character.

describe('Partita IVA', () => {
  it('accepts 11 digits with a correct check digit', () => {
    expect(isValidPartitaIva('12345670009')).toBe(true) // fake
    expect(isValidPartitaIva('76543210009')).toBe(true) // fake
  })

  it('refuses a wrong check digit, a wrong length or letters', () => {
    expect(isValidPartitaIva('12345670008')).toBe(false)
    expect(isValidPartitaIva('1234567000')).toBe(false)
    expect(isValidPartitaIva('IT12345670009')).toBe(false)
    expect(isValidPartitaIva('1234567000A')).toBe(false)
  })

  it('catches every single-digit change', () => {
    const valid = '12345670009'
    for (let i = 0; i < 11; i++) {
      for (let d = 0; d <= 9; d++) {
        const changed = valid.slice(0, i) + String(d) + valid.slice(i + 1)
        if (changed !== valid) expect(isValidPartitaIva(changed)).toBe(false)
      }
    }
  })
})

describe('codice fiscale', () => {
  it('accepts a 16-character personal code with a correct check letter', () => {
    expect(isValidPersonalCodiceFiscale('TSTPRV80A41Z999I')).toBe(true) // fake: place code Z999 does not exist
    expect(isValidPersonalCodiceFiscale('FNTCLN75C12Z999M')).toBe(true) // fake
  })

  it('refuses a wrong check letter, a wrong month letter or a wrong shape', () => {
    expect(isValidPersonalCodiceFiscale('TSTPRV80A41Z999J')).toBe(false)
    expect(isValidPersonalCodiceFiscale('TSTPRV80F41Z999I')).toBe(false) // F is not a month letter
    expect(isValidPersonalCodiceFiscale('TSTPRV80A41Z99')).toBe(false)
  })

  it('accepts omocodia (digits replaced by letters) when the check letter matches', () => {
    // The last digit 9 of the place code replaced by V (omocodia), check letter recomputed: still a valid code.
    expect(isValidPersonalCodiceFiscale('TSTPRV80A41Z99VX')).toBe(true) // fake
  })

  it('a company codice fiscale is 11 digits with the Partita IVA check digit', () => {
    expect(isValidCodiceFiscale('12345670009')).toBe(true)
    expect(isValidCodiceFiscale('12345670008')).toBe(false)
    expect(isValidCodiceFiscale('TSTPRV80A41Z999I')).toBe(true)
  })
})

describe('foreign tax ids and IBAN', () => {
  it('a foreign tax id is 1 to 28 letters or digits', () => {
    expect(isValidForeignTaxId('999999999')).toBe(true)
    expect(isValidForeignTaxId(normalizeTaxId('che 999 999 999'))).toBe(true)
    expect(isValidForeignTaxId('')).toBe(false)
    expect(isValidForeignTaxId('A'.repeat(29))).toBe(false)
    expect(isValidForeignTaxId('99-99')).toBe(false)
  })

  it('checks IBAN digits with mod 97', () => {
    expect(isValidIban('IT47X9999999999000000000001')).toBe(true) // fake
    expect(isValidIban('IT48X9999999999000000000001')).toBe(false)
    expect(isValidIban('IT47X999999999900000000000')).toBe(false)
  })
})
