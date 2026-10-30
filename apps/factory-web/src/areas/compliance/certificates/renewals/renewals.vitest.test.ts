import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WINDOW_PHASES } from '@nexus/factory-domain/compliance/renewals/rules'
import { CHANGE_KINDS, REVIEW_STATUSES } from '@nexus/factory-domain/compliance/type-changes/rules'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { abilitiesOf } from '../../../products/styles/model'
import { designScreen as complianceScreen } from '../../../products/styles/compliance/fixtures'
import { designScreen as listScreen } from '../fixtures'
import { CERTIFICATES, byNumber } from '../fixtures'
import { certCan, filterRows, inView, RECORD_TABS } from '../model'
import { designScreen as recordScreen } from '../record/fixtures'
import { REVIEWS, TOURING_RENEWAL, URBAN_RENEWAL, URBAN_RENEWED } from './fixtures'
import { appliedHeld, barOf, blankRenewalDraft, inWindow, linkHeld, reviewHeld, reviewsCsv, reviewVerbs, stageState, startHeld, waitingByCertificate, type RenewalDraft } from './model'

/**
 * B-W2a-66 — certificate renewals and changes to an approved type on the web: the Renewals tab's rules (the bar, the
 * stages, what is held and why), the register's "Changes waiting" view, the style compliance tab's change list, every
 * key in Italian and English, and every W2a design case drawn in both languages with no key left on screen.
 */

const MANAGE = certCan(['compliance.certificates.view', 'compliance.certificates.manage', 'files.upload'])
const VIEW = certCan(['compliance.certificates.view'])
const draft = (over: Partial<RenewalDraft> = {}): RenewalDraft => ({ ...blankRenewalDraft('2026-10-29', 'en'), ...over })

describe('the Renewals tab: the bar and the stages', () => {
  it('places the window, the alert stages and today on the five years', () => {
    const bar = barOf(URBAN_RENEWAL)
    expect(bar.elapsed).toBeGreaterThan(98)
    expect(bar.windowFrom).toBeGreaterThan(70)
    expect(bar.windowTo).toBeGreaterThan(bar.windowFrom)
    expect(bar.marks.map((mark) => mark.kind)).toEqual(['stage', 'stage', 'stage', 'today'])
    const before = barOf(TOURING_RENEWAL)
    expect(before.elapsed).toBeLessThan(before.windowFrom)
  })

  it('says what each stage did: waiting, fired, stopped, off, not set yet', () => {
    expect(URBAN_RENEWAL.stages.map(stageState)).toEqual(['fired', 'fired', 'fired'])
    expect(URBAN_RENEWED.stages.map(stageState)).toEqual(['fired', 'fired', 'cancelled'])
    expect(TOURING_RENEWAL.stages.map(stageState)).toEqual(['notSet', 'notSet', 'notSet'])
    expect(stageState({ ...TOURING_RENEWAL.stages[0]!, enabled: false })).toBe('off')
  })

  it('a day inside the window, one after it (recorded anyway), a day not typed', () => {
    expect(inWindow(URBAN_RENEWAL, '2026-03-01')).toBe(true)
    expect(inWindow(URBAN_RENEWAL, '2026-10-28')).toBe(false)
    expect(inWindow(URBAN_RENEWAL, '')).toBeNull()
  })
})

describe('the Renewals tab: what is held and why', () => {
  it('Start renewal: the right, a counting certificate, not renewed, no open task', () => {
    expect(startHeld(TOURING_RENEWAL, MANAGE)).toBeNull()
    expect(startHeld(TOURING_RENEWAL, VIEW)).toBe('held.manage')
    expect(startHeld(URBAN_RENEWAL, MANAGE)).toBe('ren.held.started')
    expect(startHeld(URBAN_RENEWED, MANAGE)).toBe('ren.held.renewed')
    expect(startHeld({ ...TOURING_RENEWAL, certificate: { ...TOURING_RENEWAL.certificate, status: 'EXPIRED' } }, MANAGE)).toBe('ren.held.notRenewable')
  })

  it('the application: a day that has come; the link: a registered certificate picked', () => {
    expect(appliedHeld(URBAN_RENEWAL, MANAGE, draft({ appliedOn: '2026-10-29' }))).toBeNull()
    expect(appliedHeld(URBAN_RENEWAL, MANAGE, draft({ appliedOn: '2026-10-30' }))).toBe('ren.held.future')
    expect(appliedHeld(URBAN_RENEWAL, MANAGE, draft({ appliedOn: '' }))).toBe('ren.held.day')
    expect(linkHeld(URBAN_RENEWAL, MANAGE, draft({ successorId: URBAN_RENEWAL.candidates[0]!.id }))).toBeNull()
    expect(linkHeld(URBAN_RENEWAL, MANAGE, draft({ successorId: '' }))).toBe('ren.held.pick')
    expect(linkHeld({ ...URBAN_RENEWAL, candidates: [] }, MANAGE)).toBe('ren.held.noCandidate')
    expect(linkHeld(URBAN_RENEWED, MANAGE)).toBe('ren.held.renewed')
  })

  it('a review: told or not needed while open, the answer once told, with its letter and a day between', () => {
    const [open, told, approved] = REVIEWS
    expect([open, told, approved].map((review) => reviewVerbs(review!))).toEqual([['notify', 'notNeeded'], ['answer'], []])
    expect(reviewHeld(VIEW, 'notify')).toBe('held.manage')
    expect(reviewHeld(MANAGE, 'notNeeded', draft({ reason: ' ' }))).toBe('ren.held.reason')
    expect(reviewHeld(MANAGE, 'notNeeded', draft({ reason: 'Same leather, another batch.' }))).toBeNull()
    expect(reviewHeld(MANAGE, 'answer', draft(), told, '2026-10-29')).toBe('ren.held.file')
    expect(reviewHeld(MANAGE, 'answer', draft({ fileName: 'answer.pdf' }), told, '2026-10-29')).toBeNull()
    expect(reviewHeld(MANAGE, 'answer', draft({ fileName: 'answer.pdf', answeredOn: '2026-10-19' }), told, '2026-10-29')).toBe('ren.held.beforeTold')
    expect(reviewHeld(MANAGE, 'answer', draft({ fileName: 'answer.pdf', answeredOn: '2026-10-30' }), told, '2026-10-29')).toBe('ren.held.future')
    expect(reviewHeld(certCan(['compliance.certificates.manage']), 'answer', draft({ fileName: 'answer.pdf' }), told, '2026-10-29')).toBe('ren.held.upload')
  })
})

describe('the register: changes waiting for the notified body', () => {
  it('counts the open and told reviews per certificate, and the view shows only those certificates', () => {
    const waiting = waitingByCertificate(REVIEWS)
    expect(waiting).toEqual({ [REVIEWS[0]!.certificate.id]: 2 })
    const rows = filterRows(CERTIFICATES, { view: 'changes', kind: 'all', q: '' }, waiting)
    expect(rows.map((row) => row.id)).toEqual([REVIEWS[0]!.certificate.id])
    expect(inView(byNumber('CERT-DEMO-0001'), 'changes')).toBe(false)
    expect(RECORD_TABS).toContain('renewals')
  })

  it('exports the changes one line per change (CSV)', () => {
    const lines = reviewsCsv(REVIEWS.slice(0, 2), ['style', 'rev', 'compared', 'kind', 'before', 'after', 'status', 'answered', 'reference'], { status: (review) => review.status, kind: (kind) => kind })
    expect(lines).toHaveLength(1 + 1 + 3)
    expect(lines[1]).toEqual([REVIEWS[0]!.style.code, 3, 2, 'LINING', 'DEMO-LIN-200 Fodera rete grigia', 'DEMO-LIN-210 Fodera rete leggera', 'OPEN', null, null])
  })

  it('"Tell Compliance" needs tasks.manage and threads.post', () => {
    expect(abilitiesOf(['tasks.manage', 'threads.post']).tellCompliance).toBe(true)
    expect(abilitiesOf(['tasks.manage']).tellCompliance).toBe(false)
  })
})

// ---- the words ------------------------------------------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../../../', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.vitest.') ? [join(dir, entry.name)] : []))
const has = (namespace: string, key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale][namespace] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })
const literalKeys = (dir: string, prefix: string): Set<string> => {
  const found = new Set<string>()
  const pattern = new RegExp(`['"\`](${prefix}\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  for (const file of sources(dir)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) found.add(match[1]!)
  return found
}

describe('every W2a key exists in it and en', () => {
  it('certificates: the Renewals tab and the register', () => {
    const literal = literalKeys(join(SRC, 'areas/compliance/certificates'), 'ren')
    const built = [
      ...CHANGE_KINDS.map((kind) => `ren.kind.${kind}`),
      ...REVIEW_STATUSES.flatMap((status) => [`ren.status.${status}`, `ren.needed.${status}`]),
      ...WINDOW_PHASES.map((phase) => `ren.window.${phase}`),
      ...['off', 'waiting', 'fired', 'cancelled', 'notSet'].map((state) => `ren.stage.state.${state}`),
      ...['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].map((state) => `ren.stage.alert.${state}`),
      ...['STARTED', 'APPLIED', 'RENEWED'].map((action) => `ren.log.${action}`),
      ...['OPEN', 'DONE', 'CANCELLED'].map((status) => `ren.task.${status}`),
      ...['notify', 'notNeeded', 'answer'].flatMap((verb) => [`ren.verb.${verb}`, `ren.${verb}.title`, `ren.${verb}.what`, `ren.${verb}.confirm`]),
      ...['APPROVED', 'REFUSED'].map((decision) => `ren.answerMeans.${decision}`),
      'tab.renewals',
      'view.changes',
      'row.renew',
      'list.col.changes',
      'list.changesNone',
      'list.changesWaiting',
    ]
    expect(literal.size).toBeGreaterThan(100)
    expect([...literal, ...built].filter((key) => !has('certificates', key))).toEqual([])
  })

  it('products: Changes that may need the notified body', () => {
    const literal = literalKeys(join(SRC, 'areas/products/styles'), 'typeChange')
    const built = [...CHANGE_KINDS.map((kind) => `typeChange.kind.${kind}`), ...REVIEW_STATUSES.map((status) => `typeChange.status.${status}`), 'notice.toldCompliance']
    expect(literal.size).toBeGreaterThan(15)
    expect([...literal, ...built].filter((key) => !has('products', key))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:ren|typeChange|tab|view|row|list|held|write|done|notice|common|record|state|action|status|kind|left)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
function render(view: ComponentType<{ model: unknown }>, model: unknown, locale: (typeof LOCALES)[number]): string {
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model })))
}
const clean = (html: string) => html.replace(/https?:\/\/[^"\s<]+/g, '').replace(/compliance\.certificates\.[a-z]+/g, '').replace(/\b(?:files|tasks|threads)\.[a-z]+/g, '').replace(/\b[\w-]+\.(csv|xlsx|pdf)\b/g, '')

describe('every W2a design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, complianceScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      const cases = screen.cases.filter((item) => item.label.startsWith('W2a'))
      it(`${screen.screen} in ${locale}: ${cases.length} W2a cases`, () => {
        expect(cases.length).toBeGreaterThan(3)
        for (const item of cases) {
          const html = clean(render(screen.view as ComponentType<{ model: unknown }>, item.model, locale))
          expect(html.length, item.id).toBeGreaterThan(100)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the Renewals tab says the window, the stages and the changes in both languages', () => {
    const tab = recordScreen.cases.find((item) => item.id === 'w2a-renewals')!
    const it = render(recordScreen.view as ComponentType<{ model: unknown }>, tab.model, 'it')
    const en = render(recordScreen.view as ComponentType<{ model: unknown }>, tab.model, 'en')
    expect(it).toContain('Modifiche al tipo approvato')
    expect(it).toContain('180 giorni prima della fine')
    expect(en).toContain('Changes to the approved type')
    expect(en).toContain('The renewal window closed on')
    expect(en).toContain('Link the new certificate')
  })
})
