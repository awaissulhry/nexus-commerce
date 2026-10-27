/**
 * A review's language guessed from its words (live audit C04): "Translate to English" was offered on English text and
 * every row said "Language — Not known".
 */
import { describe, expect, it } from 'vitest'
import { guessLanguage } from './review-language.js'

describe('guessLanguage', () => {
  it.each([
    ['Order delivered on time with no issues', 'en'],
    ['Venditore serio', 'it'],
    ['Come da descrizione. Ok', 'it'],
    ['Buono ma non eccellente', 'it'],
    ['Bon rapport qualité prix', 'fr'],
    ['Alles gut, sehr schnell geliefert, danke', 'de'],
    ['Muy buen producto, llegó rápido', 'es'],
  ])('%s → %s', (text, lang) => {
    expect(guessLanguage(text)).toBe(lang)
  })

  it('says nothing when the words do not say (one word, a tie, no text)', () => {
    expect(guessLanguage('Top')).toBeNull()
    expect(guessLanguage('')).toBeNull()
    expect(guessLanguage(null)).toBeNull()
    expect(guessLanguage('👍👍')).toBeNull()
  })
})
