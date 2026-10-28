import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmPhraseField, PHRASE_STATE_TEXT, phraseMatchState, phraseMatches } from './ConfirmPhraseField'

describe('the typed confirmation', () => {
  it('matches the phrase exactly: no trimming, no case folding, never an empty phrase', () => {
    expect(phraseMatches('GALE-JACKET', 'GALE-JACKET')).toBe(true)
    for (const typed of ['gale-jacket', ' GALE-JACKET', 'GALE-JACKET ', 'GALE-JACKE', 'GALE–JACKET']) expect(phraseMatches(typed, 'GALE-JACKET')).toBe(false)
    expect(phraseMatches('', '')).toBe(false)
  })

  it('knows where the typing stands: empty, a correct start, a mistake, a match', () => {
    expect(phraseMatchState('', 'SKU-1')).toBe('empty')
    expect(phraseMatchState('SKU', 'SKU-1')).toBe('partial')
    expect(phraseMatchState('sku', 'SKU-1')).toBe('mismatch')
    expect(phraseMatchState('SKU-1', 'SKU-1')).toBe('match')
  })

  it('labels the field with the phrase, and describes it with a polite live line', () => {
    const html = render(createElement(ConfirmPhraseField, { phrase: 'GALE-JACKET', value: '', onChange: vi.fn(), id: 'confirm' }))
    expect(html).toContain('<label for="confirm">Type <strong class="nds-confirm-h">GALE-JACKET</strong> exactly to confirm</label>')
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    const escaped = describedBy!.replace(/[.*+?^$()|[\]\\{}]/g, (c) => `\\${c}`)
    expect(html).toMatch(new RegExp(`<span id="${escaped}" class="nds-field-hint" aria-live="polite" data-state="empty">${PHRASE_STATE_TEXT.empty}</span>`))
    expect(html).toMatch(/autocomplete="off"/i)
  })

  it('says "Matches." with a check glyph once the phrase is exact', () => {
    const html = render(createElement(ConfirmPhraseField, { phrase: 'GALE-JACKET', value: 'GALE-JACKET', onChange: vi.fn() }))
    expect(html).toContain('data-state="match"')
    expect(html).toMatch(/<svg[^>]*class="[^"]*nds-confirm-phrase-ok"[^>]*aria-hidden="true"/)
    expect(html).toContain('Matches.')
  })
})
