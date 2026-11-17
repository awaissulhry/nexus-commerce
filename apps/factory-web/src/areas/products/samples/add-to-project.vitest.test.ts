import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { addToHeld, bulkBody, resultOf, skipReason } from '../projects/add-to/model'
import { writeProblem } from '../projects/model'
import { designScreen } from './fixtures'
import { SamplesListView, type SamplesListModel } from './view/SamplesListView'

/**
 * B-TH-251 (X-PRD-SMP-LIST.grid) — "Add to project" on Products › Samples & prototypes: the bulk bar's button beside Copy N (held
 * with why without projects.manage and offline), ONE body for every round picked (recordType SampleRound, each id once), each skipped
 * round by its number and its reason from its code (another outside company's round: words that name neither company), a refusal of
 * the whole call (a project closed meanwhile) said from its code.
 */

const listSelected = (designScreen.cases.find((item) => item.id === 'list-selected')!.model as { model: SamplesListModel }).model
const render = (model: SamplesListModel) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(SamplesListView, { model })))

describe('the bulk bar’s Add to project', () => {
  it('sits beside Copy N with the count of rounds picked', () => {
    const html = render({ ...listSelected, addToProject: { manage: true, offline: false, dialog: null } })
    expect(html).toContain('Add 2 to project')
  })

  it('is absent where the page gives none (every other case unchanged)', () => {
    expect(render(listSelected)).not.toContain('Add 2 to project')
  })

  it('is held with why: no projects.manage, the page offline', () => {
    const held = render({ ...listSelected, addToProject: { manage: false, offline: false, dialog: null } })
    expect(held).toContain('Add 2 to project')
    expect(held).toContain('Make projects')
    expect(addToHeld({ manage: true, count: 2, offline: true })).toEqual({ key: 'held.offline' })
  })
})

describe('ONE call for every round picked', () => {
  it('sends recordType SampleRound with each id once', () => {
    const rounds = [
      { id: 'r1', number: 'SR-0042' },
      { id: 'r2', number: 'SR-0043' },
      { id: 'r1', number: 'SR-0042' },
    ]
    expect(bulkBody('SampleRound', rounds, '')).toEqual({ recordType: 'SampleRound', recordIds: ['r1', 'r2'] })
  })

  it('a project closed meanwhile refuses the whole call, said from its code', () => {
    const closed = new ApiError('conflict', 409, 'invalid_state', 'The project is closed: reopen it before changing it.', null, [{ path: 'refusal/CLOSED', message: 'x' }])
    expect(writeProblem(closed)).toMatchObject({ key: 'refusal.CLOSED', stale: false })
  })
})

describe('each skipped round by its number and why (W12, W38)', () => {
  it('another outside company’s round, a round linked already, one not found', () => {
    const rounds = [
      { id: 'r1', number: 'SR-0042' },
      { id: 'r2', number: 'SR-0202' },
      { id: 'r3', number: 'SR-0044' },
    ]
    const result = resultOf({ linked: 1, skipped: [{ recordId: 'r2', code: 'LINK_PARTY' }, { recordId: 'r3', code: 'MISSING' }, { recordId: 'r9', code: 'ALREADY_LINKED' }] }, rounds, { number: 'PRJ-26-012', name: 'FW27 airbag line', href: '/w/DEMO/products/projects/p1' })
    expect(result.skipped).toEqual([
      { number: 'SR-0202', reason: skipReason('LINK_PARTY') },
      { number: 'SR-0044', reason: { key: 'addTo.skip.MISSING' } },
      // A row the list does not know says a dash, never an id.
      { number: '—', reason: { key: 'addTo.skip.ALREADY_LINKED' } },
    ])
  })

  it('the words name neither company and exist in Italian and English', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, CATALOGUE[locale]['products-projects-linked'] ?? {})
      for (const code of ['LINK_PARTY', 'ALREADY_LINKED', 'MISSING']) {
        const words = t(`addTo.skip.${code}`)
        expect(words, `${locale} ${code}`).not.toMatch(/addTo\./)
        for (const brand of [BRAND_ALPHA, BRAND_BETA]) for (const name of [brand.tradeName, brand.legalName, brand.code]) expect(words, `${locale} ${code}`).not.toContain(name)
      }
      expect(t('addTo.titleSampleRound', { count: 2 }), locale).not.toMatch(/addTo\./)
    }
  })
})
