import { describe, expect, it } from 'vitest'
import { CATALOGUE } from './messages'
import { LOCALES } from './locales'

/**
 * B-TH-215 (threads plan TH-1b, PR-22; design kit §5 "one word per thing"): a note only the office reads is an "Office note" —
 * "Nota d'ufficio" — in every factory catalogue, so the old record panels on the pages not yet moved say the same word as the
 * new record thread (pictures 2 and 3). The old words "Internal note" / "Nota interna" (and their plurals) are gone everywhere.
 */

const OLD: Readonly<Record<(typeof LOCALES)[number], RegExp>> = {
  en: /\binternal notes?\b/i,
  it: /\bnot[ae] intern[ae]\b/i,
}

const NEW: Readonly<Record<(typeof LOCALES)[number], string>> = { en: 'Office note', it: "Nota d'ufficio" }
const PLURAL: Readonly<Record<(typeof LOCALES)[number], string>> = { en: 'office notes', it: "note d'ufficio" }

describe('one word for a note only the office reads (B-TH-215)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: no catalogue line says the old word`, () => {
      const found = Object.entries(CATALOGUE[locale]).flatMap(([namespace, dictionary]) =>
        Object.entries(dictionary)
          .filter(([, text]) => OLD[locale].test(text))
          .map(([key, text]) => `${namespace}:${key} = ${text}`),
      )
      expect(found).toEqual([])
    })

    it(`${locale}: the record panels, the permission and the new order say "${NEW[locale]}"`, () => {
      expect(CATALOGUE[locale].records['composer.mode.note']).toBe(NEW[locale])
      expect(CATALOGUE[locale].records['message.kind.note']).toBe(NEW[locale])
      expect(CATALOGUE[locale].orders['newOrder.note']).toBe(NEW[locale])
      expect(CATALOGUE[locale].admin['perm.threads_post']).toContain(PLURAL[locale])
    })
  }
})
