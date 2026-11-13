import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ACCIDENT_OUTCOMES, HELD_CODES, REPORT_STATUSES, REPORT_VIEWS, revisionProblems, SAFETY_SOURCES } from '@nexus/factory-domain/sales/safety-reports/rules'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { asReadOnly, CLOSED_REPORT, LOG, NEW_REPORT, REPORT, ROWS } from './demo/fixtures'
import { designScreen as logScreen } from './log/fixtures'
import { periodFrom } from './log/view/AccidentLogView'
import {
  actionHeld,
  logAddressOf,
  logApiQuery,
  logQuery,
  logRows,
  NS,
  primaryOf,
  refusalOf,
  reportHref,
  reportsAddressOf,
  reportsCsv,
  reportsQuery,
  reviseBodyOf,
  reviseDraftOf,
  reviseProblems,
  toldInstant,
} from './model'
import { dialogFor, dialogHeld, factsPatchOf, toldDialogFor } from './record/dialogs'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as registerScreen } from './register/fixtures'
import { designScreen as reportsScreen } from './reports/fixtures'

/**
 * B-W2b-357 — the office's product-safety reports (SCR-421, SCR-421-record) and the accident log (SCR-422): the addresses,
 * the log's order (to tell first), the record's verbs held by the API's actions, the revision's rules against
 * factory-domain's, the bodies that send only what changed, no injury or reporter in a CSV, the record page in the map, and
 * every design case in both languages with no key on screen; every key the screens use is in the catalogue.
 */

const params = (query: string) => new URLSearchParams(query)
const params2 = (query: string) => ({ get: (name: string) => params(query).get(name) })

describe('addresses', () => {
  it('the reports’ terms round-trip; unknown ones fall back', () => {
    const address = reportsAddressOf(params2('view=closed&source=MAIL&q=L-1&new=1'))
    expect(address).toEqual({ view: 'closed', source: 'MAIL', q: 'L-1', isNew: true })
    expect(reportsQuery(address)).toBe('?view=closed&source=MAIL&q=L-1')
    expect(reportsAddressOf(params2('view=bogus&source=x'))).toEqual({ view: 'open', source: null, q: '', isNew: false })
  })

  it('the log’s terms round-trip; "to tell" asks the API for the rows not told', () => {
    const address = logAddressOf(params2('view=toTell&outcome=DEATH&from=2026-01-01&to=bad'))
    expect(address).toEqual({ from: '2026-01-01', to: null, outcome: 'DEATH', told: null, toTell: true })
    expect(logQuery(address)).toBe('?view=toTell&outcome=DEATH&from=2026-01-01')
    expect(logApiQuery(address).told).toBe('no')
    expect(periodFrom('year', '2026-11-12')).toBe('2026-01-01')
    expect(periodFrom('thirty', '2026-11-12')).toBe('2026-10-13')
    expect(periodFrom('all', '2026-11-12')).toBeNull()
  })

  it('the accidents to tell come first; "to tell" keeps only them', () => {
    expect(logRows([LOG[1]!, LOG[0]!, LOG[2]!], { toTell: false })[0]!.mustTell).toBe(true)
    expect(logRows(LOG, { toTell: true }).every((entry) => entry.mustTell)).toBe(true)
  })

  it('a report opens on its own page, in the map (RECORD_PAGES.ProductSafetyReport)', () => {
    expect(recordAddress({ type: 'ProductSafetyReport', id: 'r1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/compliance/register/accidents/reports/r1')
    expect(reportHref('/w/A', 'r1', 'accident', 'told')).toBe('/w/A/compliance/register/accidents/reports/r1?tab=accident&do=told')
    for (const page of ['/compliance/register/accidents', '/compliance/register/accidents/reports', '/compliance/register/accidents/reports/[id]']) expect(OFFICE_PAGES.has(page), page).toBe(true)
  })
})

describe('the record', () => {
  it('the one primary follows the status; a verb is held by the API’s actions', () => {
    expect(primaryOf(NEW_REPORT)).toBe('seen')
    expect(primaryOf({ status: 'NEW', seen: true })).toBe('assess')
    expect(primaryOf(REPORT)).toBe('close')
    expect(primaryOf(CLOSED_REPORT)).toBeNull()
    expect(actionHeld(REPORT, 'file')).toBe('held.FILED')
    expect(actionHeld(REPORT, 'close')).toBeNull()
    expect(actionHeld(REPORT, 'close', true)).toBe('held.offline')
    expect(actionHeld(CLOSED_REPORT, 'edit')).toBe('held.CLOSED')
    // A role that does not allow it: who may, in words (the product-safety role for the log and the injury).
    expect(actionHeld(asReadOnly(REPORT), 'logAccident')).toBe('held.NO_LOG')
    expect(actionHeld(asReadOnly(REPORT), 'openInjury')).toBe('held.NO_INJURY_ROLE')
    expect(actionHeld(asReadOnly(REPORT), 'close')).toBe('held.NO_MANAGE_ROLE')
  })

  it('a refusal in words: a held code, a stale version, the right', () => {
    expect(refusalOf(new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'held/FILED', message: 'x' }]))).toBe('held.FILED')
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('refused.stale')
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('refused.forbiddenOffice')
  })

  it('a revision says factory-domain’s rules, and sends only what changed', () => {
    const now = new Date('2026-11-12T10:00:00Z')
    const draft = { occurredOn: '2026-11-09', place: 'Track', outcome: 'SERIOUS_HARM' as const, toldOn: '2026-11-08', reference: '', note: '' }
    const ours = Object.keys(reviseProblems(draft, { first: false, receivedOn: '2026-11-11', today: '2026-11-12' })).sort()
    const theirs = revisionProblems({ first: false, occurredOn: draft.occurredOn, place: draft.place, outcome: draft.outcome, serial: null, batchNumber: null, authorityToldAt: new Date(toldInstant(draft.toldOn, now)), authorityReference: null, authorityNoticeId: null, note: null, receivedOn: '2026-11-11', today: '2026-11-12', now, authorityDay: draft.toldOn })
      .map((issue) => issue.path.replace('body/', ''))
      .map((path) => (path === 'authorityToldAt' ? 'toldOn' : path))
      .sort()
    expect(ours).toEqual(theirs)
    expect(ours).toEqual(['note', 'toldOn'])
    const newest = REPORT.accidentLog.newest!
    expect(reviseBodyOf({ ...reviseDraftOf(REPORT), note: 'why' }, newest)).toEqual({ note: 'why' })
    expect(reviseBodyOf({ ...reviseDraftOf(REPORT), outcome: 'DEATH', note: 'why' }, newest)).toEqual({ outcome: 'DEATH', note: 'why' })
    expect(Date.parse(toldInstant('2026-11-12', now))).toBeLessThanOrEqual(now.getTime())
    expect(toldInstant('2026-11-01', now)).toBe('2026-11-01T12:00:00.000Z')
    const told = toldDialogFor(REPORT, '2026-11-12')
    expect(told.kind === 'revise' && told.told && told.draft.toldOn).toBe('2026-11-12')
  })

  it('each dialog says why its button waits', () => {
    expect(dialogHeld({ kind: 'close', note: ' ' }, REPORT, '2026-11-12')).toBe('problem.closeNote')
    expect(dialogHeld({ kind: 'eraseReporter', reason: '' }, REPORT, '2026-11-12')).toBe('problem.reason')
    expect(dialogHeld({ kind: 'recordInjury', draft: { injured: null, consent: false, words: '' } }, REPORT, '2026-11-12')).toBe('problem.injured')
    expect(dialogHeld({ kind: 'recordInjury', draft: { injured: true, consent: false, words: 'cut' } }, REPORT, '2026-11-12')).toBe('problem.consent')
    expect(dialogHeld(dialogFor('facts', REPORT), REPORT, '2026-11-12')).toBe('problem.facts.nothing')
    expect(factsPatchOf({ serial: 'SN-NEW', batchNumber: '', size: '50', occurredOn: '2026-11-09', worn: 'yes' }, REPORT)).toEqual({ serial: 'SN-NEW' })
    expect(dialogHeld(dialogFor('file', NEW_REPORT), NEW_REPORT, '2026-11-12')).toBeNull()
  })

  it('a CSV of reports never carries the reporter, what happened or an injury', () => {
    const csv = reportsCsv(ROWS, { header: ['a'], source: (code) => code, status: (code) => code, outcome: (code) => code })
    expect(csv).not.toContain(REPORT.whatHappened)
    expect(csv).not.toContain('lettore@example.com')
    expect(csv).toContain('PSR-DEMO-0002')
  })
})

describe('words', () => {
  const root = dirname(fileURLToPath(import.meta.url))
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('vitest') ? [join(dir, entry.name)] : []))
  const folders = [root, join(root, '../../../../lib/safety-reports'), join(root, '../../../../links/public-doc/report'), join(root, '../../../../portal/customer/returns/safety')]

  it('every key a screen names is in both catalogues (families by their codes)', () => {
    const keys = new Set<string>()
    for (const file of folders.flatMap(sources)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\b(?:t|sr)\(\s*'([a-zA-Z]+\.[A-Za-z0-9_.]+)'/g)) keys.add(match[1]!)
    }
    for (const status of REPORT_STATUSES) keys.add(`status.${status}`)
    for (const source of SAFETY_SOURCES) keys.add(`source.${source}`)
    for (const outcome of ACCIDENT_OUTCOMES) keys.add(`outcome.${outcome}`)
    for (const code of [...HELD_CODES, 'NO_PERMISSION', 'OFF', 'NO_LOG', 'NO_INJURY_ROLE', 'NO_MANAGE_ROLE']) keys.add(`held.${code}`)
    for (const view of REPORT_VIEWS) keys.add(`viewName.${view}`)
    for (const kind of ['close', 'eraseReporter', 'eraseInjury', 'recordInjury', 'facts', 'file']) for (const part of ['title', 'confirm']) keys.add(`dialog.${kind}.${part}`)
    for (const id of ['notSeen', 'assessing', 'accidentsToTell']) for (const part of ['', 'Hint']) keys.add(`list.tile.${id}${part}`)
    for (const id of ['entries', 'toTell', 'told']) for (const part of ['', 'Hint']) keys.add(`log.tile.${id}${part}`)
    for (const period of ['all', 'year', 'twelve', 'thirty']) keys.add(`log.periodValue.${period}`)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NS] ?? {}
      const missing = [...keys].filter((key) => !(key in words) && !(`${key}_one` in words) && !key.startsWith('problem.forbidden') && !key.startsWith('problem.notFound') && !key.startsWith('problem.unavailable'))
      expect(missing, locale).toEqual([])
    }
  })
})

const LEFT_KEY = /\b(?:common|held|intake|review|problem|refused|dialog|photos|scan|public|portal|register|list|log|record|accident|authority|garment|status|source|outcome|viewName|new|row|keys|noAccess|read|receipt|tile|view)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [reportsScreen, recordScreen, logScreen, registerScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b(?:sales|product|compliance|parties|files|threads|example)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
            .replace(/\bart\.\s?\d+/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
