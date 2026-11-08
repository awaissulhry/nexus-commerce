import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { LOCALES } from '../../i18n/locales'
import { designScreen } from './fixtures'

/**
 * B-W2b-78 — the quality and floor parts lab: every case draws in both languages with no catalogue key on screen and no
 * DS English on the Italian page; each held state says why.
 */
const render = (locale: (typeof LOCALES)[number], model: unknown) =>
  renderToString(
    createElement(
      I18nProvider,
      { locale, messages: messagesFor(locale, ['shell', 'ds-words', 'ds-quality-lab']) },
      createElement(designScreen.view as ComponentType<{ model: unknown }>, { model }),
    ),
  )
const caseModel = (id: string) => designScreen.cases.find((c) => c.id === id)!.model

describe('the /design/ds-quality-parts lab', () => {
  it('has the cases the review needs', () => {
    expect(designScreen.screen).toBe('ds-quality-parts')
    expect(designScreen.cases.map((c) => c.id)).toEqual([
      'parts', 'gate-unknown', 'gate-open', 'gate-frozen', 'gate-none', 'signoff-rejected', 'checklist-partly', 'checklist-done', 'checklist-held', 'checklist-empty',
    ])
  })

  it('draws every case in both languages without a key on screen', () => {
    for (const locale of LOCALES) {
      for (const c of designScreen.cases) {
        const html = render(locale, c.model)
        expect(html, `${locale}/${c.id}`).not.toMatch(/>(?:ds-quality-lab|ds-words|gate|sign|limit|measure|checklist|group|item|reason|floor|list|part|section)\.[a-zA-Z.]+</)
      }
    }
  })

  it('the Italian page shows no DS English', () => {
    const html = render('it', {})
    for (const word of ['Bloccato', 'Chi può sbloccarlo: Responsabile conformità', 'Deroga', 'Hai firmato un passaggio precedente', 'limite 3', 'Sotto il limite di rilevabilità', 'oltre di 1,3 cm', 'Gruppo conforme', 'Da controllare'])
      expect(html).toContain(word)
    expect(html).not.toMatch(/Blocked|Who can clear|You signed an earlier|limit 3|Below detection|over by|Group passes|Not checked|Signed by/)
  })

  it('each held state says why', () => {
    expect(render('en', caseModel('parts'))).toContain('1 check not met: The certificate covers every size of the lot')
    expect(render('en', caseModel('gate-unknown'))).toContain('1 check not known yet: Cr VI of the leather lots PASS (now: PENDING)')
    expect(render('en', caseModel('gate-none'))).toContain('No checks are listed for this gate')
    expect(render('en', caseModel('gate-frozen'))).toContain('As it stood on 3 Nov 2026, 10:42')
    expect(render('en', caseModel('gate-open'))).toContain('Nothing is blocking')
    expect(render('en', caseModel('parts'))).toContain('You signed an earlier step: a second person must sign this one (four-eyes)')
    expect(render('en', caseModel('signoff-rejected'))).toContain('Rejected by Paolo Prova')
    expect(render('en', caseModel('checklist-partly'))).toContain('Failed: Unreadable · with photo')
    expect(render('en', caseModel('checklist-partly'))).toContain('required checks left:')
    expect(render('en', caseModel('checklist-done'))).not.toContain('required checks left')
    expect(render('en', caseModel('checklist-held'))).toContain('The work order is on hold: release the hold first.')
    expect(render('en', caseModel('checklist-empty'))).toContain('No checks are listed')
  })
})
