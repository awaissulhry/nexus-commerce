import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order } from '../../_demo/fixtures'
import { languageOf } from './facts'

/**
 * F-OO-100 (order overview lane: one file per section) — Order facts' one rule, moved out of the card unchanged: the order's
 * language in words, English for `en` and Italian for any other code (as the card said it before the move).
 */

describe('Order facts (F-SA-233): the language in words', () => {
  it('en reads English, it reads Italian, any other code reads Italian (the card\'s rule before the move)', () => {
    expect(languageOf({ language: 'en' })).toEqual({ key: 'overview.facts.lang.en' })
    expect(languageOf({ language: 'it' })).toEqual({ key: 'overview.facts.lang.it' })
    expect(languageOf({ language: 'de' })).toEqual({ key: 'overview.facts.lang.it' })
    expect(languageOf(order('IN_PRODUCTION')).key).toMatch(/^overview\.facts\.lang\.(en|it)$/)
  })

  it('both words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['overview.facts.lang.en', 'overview.facts.lang.it']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
