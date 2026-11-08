import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { LOCALES } from '../../i18n/locales'
import { designScreen } from './fixtures'

/**
 * B-W2b-155 — the portal and link parts lab: every case draws in both languages with no catalogue key on screen and no
 * DS English on the Italian page.
 */
const render = (locale: (typeof LOCALES)[number], model: unknown) =>
  renderToString(
    createElement(
      I18nProvider,
      { locale, messages: messagesFor(locale, ['shell', 'ds-words', 'ds-portal-lab', 'production']) },
      createElement(designScreen.view as ComponentType<{ model: unknown }>, { model }),
    ),
  )
const model = (id: string) => designScreen.cases.find((c) => c.id === id)!.model

describe('the /design/ds-portal-parts lab', () => {
  it('has the cases the review needs', () => {
    expect(designScreen.screen).toBe('ds-portal-parts')
    expect(designScreen.cases.map((c) => c.id)).toEqual([
      'parts', 'branded', 'end-accepted', 'end-dead', 'end-error', 'code-wrong', 'code-locked', 'actions-empty', 'lines-answered',
      'thread-readonly', 'thread-error', 'pay-waiting', 'pay-failed', 'pay-held', 'sheet-open', 'sheet-branded', 'phone-bar',
    ])
  })

  it('draws every case in both languages without a key on screen', () => {
    for (const locale of LOCALES) {
      for (const c of designScreen.cases) {
        const html = render(locale, c.model)
        expect(html, `${locale}/${c.id}`).not.toMatch(/>(?:ds-portal-lab|ds-words|section|end|code|refs|actions|lines|thread|pay|sizes|popups|bar|endState|codeInput|refPair|milestoneTracker|paymentPanel|actionList|partnerThread|lineResponseList|portalActionBar|sizeGridStacked)\.[a-zA-Z.]+</)
      }
    }
  })

  it('the Italian page shows no DS English', () => {
    const html = render('it', {})
    for (const word of ['Cosa succede ora', 'Domande?', 'Vostro rif.', 'Promesso per il 14/11/2026', 'Ordini da confermare', 'Tutte come richiesto', 'Conferma tutto come richiesto', 'Tutti i colori', 'Scarica la vostra copia'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/What happens next|Questions\?|Your ref\.|Promised for|Nothing waits|All as asked|All colourways|Download your copy|Send a new code/)
  })

  it('each held or failed state says why', () => {
    expect(render('en', model('code-locked'))).toContain('Too many tries. Ask for a new code.')
    expect(render('en', model('code-wrong'))).toContain('That code is not right.')
    expect(render('en', model('thread-readonly'))).toContain('Your access lets you read this conversation, not write in it.')
    expect(render('en', model('pay-held'))).toContain('Card payments are not switched on for this company.')
    expect(render('en', model('pay-failed'))).toContain('Your bank declined the card. Nothing was charged.')
    expect(render('en', model('phone-bar'))).toContain('Answer line 20 first: pick what you send instead.')
    expect(render('en', model('end-dead'))).toContain('Ask for a new link')
  })

  it('the branded cases mark the subtree with the brand roles', () => {
    expect(render('en', model('branded'))).toMatch(/data-brand="primary-light accent-light primary-dark accent-dark"/)
    expect(render('en', model('parts'))).not.toContain('data-brand')
  })
})
