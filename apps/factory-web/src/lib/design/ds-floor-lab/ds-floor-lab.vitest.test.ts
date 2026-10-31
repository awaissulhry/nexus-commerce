import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { LOCALES } from '../../i18n/locales'
import { designScreen } from './fixtures'

/**
 * B-W2b-28 — the floor and people parts lab: every case draws in both languages with no catalogue key on screen and no
 * DS English on the Italian page.
 */
const render = (locale: (typeof LOCALES)[number], model: unknown) =>
  renderToString(
    createElement(
      I18nProvider,
      { locale, messages: messagesFor(locale, ['shell', 'ds-words', 'ds-floor-lab']) },
      createElement(designScreen.view as ComponentType<{ model: unknown }>, { model }),
    ),
  )

describe('the /design/ds-floor-parts lab', () => {
  it('has the cases the review needs', () => {
    expect(designScreen.screen).toBe('ds-floor-parts')
    expect(designScreen.cases.map((c) => c.id)).toEqual([
      'parts', 'card-cached', 'names-offline', 'names-empty', 'list-changed', 'sign-locked', 'sign-held', 'sign-done', 'gate-on', 'gate-on-open', 'no-role', 'display',
    ])
  })

  it('draws every case in both languages without a key on screen', () => {
    for (const locale of LOCALES) {
      for (const c of designScreen.cases) {
        const html = render(locale, c.model)
        expect(html, `${locale}/${c.id}`).not.toMatch(/>(?:ds-floor-lab|ds-words|part|card|gate|sign|seal|day|due|law|privacy|names|list|elapsed)\.[a-zA-Z.]+</)
      }
    }
  })

  it('the Italian page shows no DS English', () => {
    const html = render('it', {})
    for (const word of ['Firmi come Marta Demo', 'Hanno lavorato qui di recente', 'Totali di linea', 'Mancano 3 condizioni', 'Scade tra 12 giorni', 'Impronta SHA-256', 'Turno 08:00–17:00']) expect(html).toContain(word)
    expect(html).not.toMatch(/Signing as|Worked here recently|conditions missing|Due in \d|SHA-256 fingerprint|Shift 08:00/)
  })

  it('each held state says why', () => {
    expect(render('en', designScreen.cases.find((c) => c.id === 'names-offline')!.model)).toContain('Name and PIN need the network. Use your badge.')
    expect(render('en', designScreen.cases.find((c) => c.id === 'sign-locked')!.model)).toContain('Locked until 10:47.')
    expect(render('en', designScreen.cases.find((c) => c.id === 'sign-held')!.model)).toContain('Signing needs the network.')
    expect(render('en', designScreen.cases.find((c) => c.id === 'gate-on-open')!.model)).toContain('On, but 1 condition is no longer met')
    expect(render('en', designScreen.cases.find((c) => c.id === 'no-role')!.model)).toContain('Only HR and safety roles see it')
    expect(render('en', designScreen.cases.find((c) => c.id === 'display')!.model)).toContain('data-density="display"')
  })
})
