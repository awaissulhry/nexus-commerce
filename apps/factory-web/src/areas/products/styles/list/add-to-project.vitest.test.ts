import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROJECT_REFUSALS } from '@nexus/factory-domain/projects/rules'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import type { ProjectRow } from '../../projects/api'
import { ADD_TO_LIMIT, addToHeld, bulkBody, choicesOf, resultOf, skipReason, submitHeld } from '../../projects/add-to/model'
import { AddToProjectButton } from '../../projects/add-to/view/AddToProjectDialog'
import { designScreen } from './fixtures'
import type { StylesListViewModel } from './list-model'
import { StylesListView } from './view/StylesListView'

/**
 * B-TH-251 (X-PRD-STY-LIST.grid) — "Add to project" on Products › Styles: the bulk bar's button held with why without
 * projects.manage (and past 200 rows, offline), ONE body for every style picked (recordType Style, each id once), the answer said in
 * words with each skipped style by its code and its reason from its code (another outside company's style: words that name neither
 * company), the open projects to pick.
 */

const render = (model: StylesListViewModel) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(StylesListView, { model })))
const selectedCase = designScreen.cases.find((item) => item.id === 'selected')!.model

describe('the bulk bar’s Add to project', () => {
  it('shows on the selection bar with the count of styles picked', () => {
    const html = render({ ...selectedCase, addToProject: { manage: true, offline: false, dialog: null } })
    expect(html).toContain('Add 2 to project')
  })

  it('is absent where the page gives no Add to project (every other caller unchanged)', () => {
    expect(render(selectedCase)).not.toContain('Add 2 to project')
  })

  it('is held with the right in words without projects.manage; past 200 rows; offline', () => {
    expect(addToHeld({ manage: false, count: 2, offline: false })?.key).toBe('held.noManage')
    expect(addToHeld({ manage: true, count: ADD_TO_LIMIT + 1, offline: false })).toEqual({ key: 'addTo.held.tooMany', params: { count: 200 } })
    expect(addToHeld({ manage: true, count: 2, offline: true })).toEqual({ key: 'held.offline' })
    expect(addToHeld({ manage: true, count: 2, offline: false })).toBeNull()
    const held = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(AddToProjectButton, { count: 2, held: addToHeld({ manage: false, count: 2, offline: false }) })))
    expect(held).toContain('aria-disabled="true"')
    expect(held).toContain('Make projects')
  })
})

describe('ONE call for every style picked', () => {
  const styles = [
    { id: 's1', number: 'AX-100' },
    { id: 's2', number: 'AX-101' },
    { id: 's1', number: 'AX-100' },
  ]

  it('sends recordType Style with each id once, the note only when typed', () => {
    expect(bulkBody('Style', styles, '')).toEqual({ recordType: 'Style', recordIds: ['s1', 's2'] })
    expect(bulkBody('Style', styles, ' FW27 jackets ')).toEqual({ recordType: 'Style', recordIds: ['s1', 's2'], note: 'FW27 jackets' })
    expect(bulkBody('Style', Array.from({ length: 250 }, (_, index) => ({ id: `s${index}`, number: `AX-${index}` })), '').recordIds).toHaveLength(ADD_TO_LIMIT)
  })

  it('Add waits for a project picked and a note of one line', () => {
    expect(submitHeld({ picked: null, note: '', offline: false, records: styles })).toEqual({ key: 'addTo.held.pick' })
    expect(submitHeld({ picked: 'p1', note: 'two\nlines', offline: false, records: styles })).toEqual({ key: 'link.noteOneLine' })
    expect(submitHeld({ picked: 'p1', note: '', offline: false, records: styles })).toBeNull()
  })

  it('offers only open projects, each once, with its outside company or Office only', () => {
    const row = (over: Partial<ProjectRow>) => ({ id: 'p1', number: 'PRJ-26-012', name: 'FW27 airbag line', companyId: 'c1', party: { id: 'pa', code: BRAND_ALPHA.code, name: BRAND_ALPHA.tradeName }, lead: { id: 'u1', name: 'Marco Demo' }, status: 'ACTIVE', targetDate: '2026-12-01', target: { state: 'LATER', days: 14 }, seasonCode: null, lastMessageAt: null, newForMe: 0, muted: false, mine: true, linked: 3, version: 1, ...over }) as ProjectRow
    const choices = choicesOf([row({}), row({ id: 'p2', status: 'ON_HOLD', party: null }), row({ id: 'p3', status: 'CLOSED' }), row({})])
    expect(choices.map((choice) => [choice.id, choice.party])).toEqual([
      ['p1', BRAND_ALPHA.tradeName],
      ['p2', null],
    ])
  })
})

describe('the answer in words (W12, W38)', () => {
  const styles = [
    { id: 's1', number: 'AX-100' },
    { id: 's2', number: BRAND_BETA.numbers.style },
    { id: 's3', number: 'AX-099' },
  ]
  const project = { number: 'PRJ-26-012', name: 'FW27 airbag line', href: '/w/DEMO/products/projects/p1' }

  it('each skipped style by its code, its reason from its code', () => {
    const result = resultOf({ linked: 1, skipped: [{ recordId: 's2', code: 'LINK_PARTY' }, { recordId: 's3', code: 'ALREADY_LINKED' }] }, styles, project)
    expect(result.linked).toBe(1)
    expect(result.skipped).toEqual([
      { number: BRAND_BETA.numbers.style, reason: { key: 'addTo.skip.LINK_PARTY' } },
      { number: 'AX-099', reason: { key: 'addTo.skip.ALREADY_LINKED' } },
    ])
    expect(skipReason('MISSING')).toEqual({ key: 'addTo.skip.MISSING' })
    expect(skipReason('LINK_OFFICE_ONLY')).toEqual({ key: 'refusal.LINK_OFFICE_ONLY' })
    expect(skipReason('SOMETHING_NEW')).toEqual({ key: 'refusal.other' })
  })

  it('another outside company’s style is skipped in words that name neither company (it and en)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, CATALOGUE[locale]['products-projects-linked'] ?? {})
      const said = t('addTo.result.row', { number: BRAND_BETA.numbers.style, reason: t('addTo.skip.LINK_PARTY') })
      expect(said, locale).toContain(BRAND_BETA.numbers.style)
      for (const brand of [BRAND_ALPHA, BRAND_BETA]) for (const name of [brand.tradeName, brand.legalName, brand.code]) expect(said, `${locale} ${name}`).not.toContain(name)
      expect(t('addTo.result.linked', { count: 5 }), locale).not.toMatch(/addTo\./)
      expect(Object.keys(PROJECT_REFUSALS)).toContain('LINK_PARTY')
    }
  })
})
