import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { canAs, LOCK_AUGUST, LOCK_SEPTEMBER } from '../demo/fixtures'
import { lockHeld } from '../model'
import { designScreen } from './fixtures'
import { closeProblemCodes, hardConsequences, hardOpenHeld } from './model'

/**
 * B-W2b-426 — "Close August for good?" (SCR-481): what opens the pop-up and what holds its button (the permissions, the
 * month, closed already, the typed phrase in either language), what closing means, every problem a refused close names,
 * and every design case drawn in Italian and English with no message key or placeholder left on screen.
 */

const finance = canAs('finance')
const base = { month: '2026-09', current: LOCK_SEPTEMBER, can: finance, busy: false } as const

describe('opening "Close … for good?"', () => {
  it('needs the lock permission and accounting.close, a month, and a month not closed already', () => {
    expect(hardOpenHeld(base)).toBeNull()
    expect(hardOpenHeld({ ...base, can: canAs('financePrice') })).toEqual({ key: 'hard.held.noClose' })
    expect(hardOpenHeld({ ...base, can: canAs('reader') })).toEqual({ key: 'lock.held.noLock' })
    expect(hardOpenHeld({ ...base, month: null })).toEqual({ key: 'lock.held.chooseMonth' })
    expect(hardOpenHeld({ ...base, month: '2026-08', current: LOCK_AUGUST })).toEqual({ key: 'lock.held.alreadyHard' })
    expect(hardOpenHeld({ ...base, busy: true })).toEqual({ key: 'held.busy' })
  })

  it('its button holds until the phrase matches, in either language, case and spaces free', () => {
    const held = (phrase: string) => lockHeld({ ...base, level: 'HARD', phrase })
    expect(held('')).toEqual({ key: 'lock.held.phrase' })
    expect(held('close August 2026')).toEqual({ key: 'lock.held.phrase' })
    expect(held('Close  September 2026')).toBeNull()
    expect(held('chiudi settembre 2026')).toBeNull()
  })
})

describe('what closing means and why a close is refused', () => {
  it('nothing dated in the month changes; a correction in an open month; the owner lifts it; nothing sent', () => {
    expect(hardConsequences('August 2026').map((entry) => entry.key)).toEqual(['hard.what.nothing', 'hard.what.correct', 'hard.what.lift', 'hard.what.accountant'])
  })

  it('every problem of the month a 409 names, each once; anything else names none', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [
      { path: 'problem/INVOICE_REJECTED', message: 'English' },
      { path: 'problem/STOCK_NOT_VALUED', message: 'English' },
      { path: 'problem/INVOICE_REJECTED', message: 'again' },
      { path: 'problem/SOMETHING_NEW', message: 'no words' },
    ])
    expect(closeProblemCodes(refused)).toEqual(['INVOICE_REJECTED', 'STOCK_NOT_VALUED'])
    expect(closeProblemCodes(new ApiError('step_up', 403, 'forbidden', 'x'))).toEqual([])
    expect(closeProblemCodes(new Error('network'))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:hard|lock|lift|held|stepUp|refusal|common|integrity|mapping|journals|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:accounting\.(?:view|export|lock|unlock|close)|money\.(?:price|cost))\b/g

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  it(`SCR-481: ${screen.cases.length} cases × it, en`, () => {
    const View = screen.view as ComponentType<{ model: unknown }>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model }))).replace(SAID, '')
        expect(html.length, `SCR-481/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-481/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `SCR-481/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
