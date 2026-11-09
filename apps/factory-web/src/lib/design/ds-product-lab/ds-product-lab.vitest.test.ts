import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { LOCALES } from '../../i18n/locales'
import { designScreen } from './fixtures'

/**
 * B-W2b-207 — the product parts lab: every case draws in both languages with no catalogue key on screen and no DS English
 * on the Italian page; each held state says why.
 */
const render = (locale: (typeof LOCALES)[number], model: unknown) =>
  renderToString(
    createElement(
      I18nProvider,
      { locale, messages: messagesFor(locale, ['shell', 'ds-words', 'ds-product-lab']) },
      createElement(designScreen.view as ComponentType<{ model: unknown }>, { model }),
    ),
  )
const caseModel = (id: string) => designScreen.cases.find((c) => c.id === id)!.model

describe('the /design/ds-product-parts lab', () => {
  it('has the cases the review needs', () => {
    expect(designScreen.screen).toBe('ds-product-parts')
    expect(designScreen.cases.map((c) => c.id)).toEqual([
      'parts', 'compare-same', 'compare-decided', 'rule-incomplete', 'rule-options', 'rule-offline', 'rule-readonly', 'sizes-missing', 'sizes-released', 'zones-held', 'zones-heat',
    ])
  })

  it('draws every case in both languages without a key on screen', () => {
    for (const locale of LOCALES) {
      for (const c of designScreen.cases) {
        const html = render(locale, c.model)
        expect(html, `${locale}/${c.id}`).not.toMatch(/>(?:ds-product-lab|ds-words|section|compare|rules|sizes|zones|versionCompare|ruleBuilder|sizeColumns|garmentZoneMap)\.[a-zA-Z.]+</)
      }
    }
  })

  it('the Italian page shows no DS English', () => {
    const html = render('it', {})
    for (const word of ['Rev 3 a confronto con Rev 4', 'Usa come nota di modifica', 'Assente in Rev 3', 'Un preventivo va approvato quando il margine è sotto 20 %', 'Almeno una (O)', 'Aggiungi una condizione', 'Riempi dalla taglia base…', 'Nessuna zona scelta', 'Difetti per zona negli ultimi 30 giorni', 'Impatto (livello 2)'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/compared with|Use as change note|Not in Rev|is under|Any of them|Add a condition|No zone picked|Marked zones|Jacket, front/)
  })

  it('each held state says why', () => {
    expect(render('en', caseModel('compare-same'))).toContain('The two versions are the same.')
    expect(render('en', caseModel('compare-same'))).toContain('Nothing changed between the two versions.')
    expect(render('en', caseModel('compare-decided'))).toContain('The change is approved: its note no longer changes.')
    expect(render('en', caseModel('rule-incomplete'))).toContain('Condition 2: enter a value')
    expect(render('en', caseModel('rule-offline'))).toContain('Offline — your changes are kept on this page')
    const read = render('en', caseModel('rule-readonly'))
    expect(read).toContain('Read-only: the rule is used by 3 open quotes.')
    expect(read).not.toContain('<select')
    expect(render('en', caseModel('rule-options'))).toContain('When the option is Perforation and made to measure is no — the thermal liner is excluded (block)')
    expect(render('en', caseModel('sizes-released'))).toContain('Rev 3 is released and frozen.')
    expect(render('en', caseModel('zones-held'))).toContain('Signed: it no longer changes.')
    expect(render('en', caseModel('zones-heat'))).toContain('Defects by zone in the last 30 days')
  })
})
