import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { order } from '../../_demo/fixtures'
import { abilitiesOf } from '../../model'
import { base } from '../fixtures'
import type { OrderRecordModel } from '../record-model'
import { PeopleCard } from '../view/overview/PeopleCard'
import { FAILED_STATE, LOADING_STATE, NO_WORK_READ, PEOPLE, PRODUCTION_READ, ready } from './fixtures'
import { peopleViewOf, placeWords } from './people'

/** F-OO-100 (order overview lane: one file per section) — People's rules, moved with people.ts out of overview.vitest.test.ts unchanged. */

describe('Overview’s facts (F-SA-233): People', () => {
  it('people: places only — a site · line · team, or an outside workshop; never an operator', () => {
    expect(placeWords({ site: { code: 'S1', name: 'Main site' }, line: { code: 'L2', name: 'Line 2' }, team: null, workshop: null })).toBe('Main site · Line 2')
    expect(placeWords({ site: null, line: null, team: null, workshop: { name: 'Workshop Beta Leather' } })).toBe('Workshop Beta Leather')
  })
})

// ---- F-OO-131 (order overview lane; 10-design §3): People as one aligned list ------------------------------------------------------
describe('F-OO-131: People — one aligned list, label | value | one door; Followers in the head; Made by and Told left', () => {
  const value = order('IN_PRODUCTION')
  const withPeople = ready({ ...PRODUCTION_READ, people: PEOPLE })
  const rights = (mayAssign: boolean, mayNote = true): NonNullable<OrderRecordModel['people']> => ({ mayAssign, mayNote, assign: null, note: null })
  const card = (record: OrderRecordModel, locale: 'en' | 'it' = 'en') => render(createElement(PeopleCard, { order: value, model: record }), locale)
  /** The card's rows, each as its own html (label first). */
  const rowsOf = (html: string) => html.split('<li class="fw-so-ov-row">').slice(1)
  const rowOf = (html: string, label: string) => rowsOf(html).find((row) => textOf(row).startsWith(label)) ?? ''
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the card’s state from the read: reading, failed, withheld (also a part the API did not keep: null), read', () => {
    expect(peopleViewOf(null)).toEqual({ status: 'loading' })
    expect(peopleViewOf(LOADING_STATE)).toEqual({ status: 'loading' })
    expect(peopleViewOf(FAILED_STATE)).toEqual({ status: 'failed', problem: 'problem.read.unavailable' })
    expect(peopleViewOf(ready(NO_WORK_READ))).toEqual({ status: 'withheld' })
    expect(peopleViewOf(ready({ ...PRODUCTION_READ, people: PEOPLE, withheld: ['people'] }))).toEqual({ status: 'withheld' })
    expect(peopleViewOf(ready(PRODUCTION_READ))).toEqual({ status: 'withheld' })
    expect(peopleViewOf(withPeople)).toEqual({ status: 'ready', people: PEOPLE })
  })

  it('Owner (every right): the four rows in order — Supervisor with Change… and Ask, Backup with its customer page, Answers the customer with Change…, Where it is made', () => {
    const { record } = base('owner', value, { tab: 'overview', production: withPeople, people: rights(true) })
    const html = card(record)
    expect(rowsOf(html).map((row) => textOf(row).split(' ')[0])).toEqual(['Supervisor', 'Backup', 'Answers', 'Where'])
    expect(html).toContain('<ul class="fw-so-people-list">')
    expect(textOf(rowOf(html, 'Supervisor'))).toContain('Bea Esempio · this order')
    expect(rowOf(html, 'Supervisor')).toContain('>Ask</button>')
    expect(rowOf(html, 'Supervisor')).not.toContain('aria-disabled')
    expect(textOf(rowOf(html, 'Backup'))).toContain('Carlo Prova · for every order of Moto Demo S.r.l.')
    expect(rowOf(html, 'Backup')).toMatch(/href="\/w\/DEMO\/sales\/customers\/[^"]+"/)
    expect(textOf(rowOf(html, 'Answers the customer'))).toContain('Bea Esempio')
    expect(textOf(rowOf(html, 'Answers the customer'))).toContain('Change…')
    expect(textOf(rowOf(html, 'Where it is made'))).toContain('Stabilimento Nord · Linea 2 · Laboratorio Esempio')
    // One place per fact: Made by is Order facts' (F-OO-209), Told about changes the foot of Requests & changes (F-OO-205).
    expect(textOf(html)).not.toContain('Made by')
    expect(textOf(html)).not.toContain('Told about changes')
    const it = textOf(card(record, 'it'))
    for (const words of ['Persone', 'Supervisore', 'Sostituto', 'Risponde al cliente', 'Dove si produce', 'Chiedi']) expect(it, words).toContain(words)
    expect(it).not.toContain('Creato da')
  })

  it('Sales without the supervisor’s right: Change… held in words (never hidden); Ask stays', () => {
    const { record } = base('sales', value, { tab: 'overview', production: withPeople, people: rights(false) })
    const supervisor = rowOf(card(record), 'Supervisor')
    expect(supervisor).toContain('aria-description="Setting a production supervisor needs the right to manage customers')
    expect(supervisor).toContain('>Ask</button>')
  })

  it('Read-only (no acting right on the page): the facts and the backup’s link, no Ask and no Change… on Answers the customer', () => {
    const { record } = base('sales', value, { tab: 'overview', production: withPeople, people: rights(false), can: abilitiesOf(['orders.view', 'workorders.view']) })
    const html = card(record)
    expect(rowOf(html, 'Supervisor')).not.toContain('>Ask</button>')
    expect(rowOf(html, 'Answers the customer')).not.toContain('<button')
    expect(textOf(rowOf(html, 'Backup'))).toContain('Change it on Moto Demo S.r.l.')
    expect(textOf(html)).toContain('Bea Esempio')
  })

  it('Finance (no workorders.view): only the card’s sentence — no row, never "Not set"; reading: no row; a failed read says so with Try again', () => {
    const finance = card(base('finance', value, { tab: 'overview', production: ready(NO_WORK_READ) }).record)
    expect(textOf(finance)).toContain('Who works on it is shown to people who follow production.')
    expect(finance).not.toContain('fw-so-people-list')
    expect(textOf(finance)).not.toContain('not set')
    expect(card(base('sales', value, { tab: 'overview', production: LOADING_STATE }).record)).not.toContain('fw-so-people-list')
    const failed = textOf(card(base('sales', value, { tab: 'overview', production: FAILED_STATE }).record))
    expect(failed).toContain("Couldn't load People")
    expect(failed).toContain('Try again')
  })

  it('the source: Followers in the head (its own words), the rows on the shared card row, no Made by and no Told line left', () => {
    const view = source('../view/overview/PeopleCard.tsx')
    expect(view.indexOf('<FollowersDoor />')).toBeGreaterThan(view.indexOf('<div className="fw-so-card-head">'))
    expect(view.indexOf('<FollowersDoor />')).toBeLessThan(view.indexOf('fw-so-people-list'))
    expect(view).toContain("import './people.css'")
    expect(view).not.toContain('madeBy')
    expect(view).not.toContain('told.aboutChanges')
    expect(view).not.toContain('KeyValue')
    const door = source('../view/Discuss.tsx')
    expect(door).toContain("{t('people.followers')}")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['people.supervisor', 'people.followers']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
    expect(createTranslator('it', messagesFor('it', ['orders']).orders!)('people.followers')).toBe('Chi segue ›')
  })

  it('375: below a 360 px card a row stacks (label, value, doors); the rows line up on the list’s columns; tokens only', () => {
    const css = source('../view/overview/people.css')
    expect(css).toMatch(/\.fw-so-people-list \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\) auto;/)
    expect(css).toMatch(/\.fw-so-people-list > \.fw-so-ov-row \{\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{\s*\.fw-so-people-list \{\s*grid-template-columns: max-content minmax\(0, 1fr\);/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 359px\) \{\s*\.fw-so-people-list \{\s*grid-template-columns: minmax\(0, 1fr\);/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    // The card declares no container of its own: the grid makes every Overview card one (overview.css).
    expect(css).not.toMatch(/container(-type)?:/)
  })
})
// ---- end F-OO-131

// ---- F-OO-132 (10-design §3.2; 13-backend B-OO-008): the supervisor row is SupervisorFact's row face, held by the order's status ----
describe('F-OO-132: People › Supervisor — the row face; Change… held in its own words by the order’s status; Read-only: no door', () => {
  const withPeople = ready({ ...PRODUCTION_READ, people: PEOPLE })
  const people = { mayAssign: true, mayNote: true, assign: null, note: null }
  const supervisorRow = (status: Parameters<typeof order>[0], over: Partial<OrderRecordModel> = {}, locale: 'en' | 'it' = 'en') => {
    const value = order(status)
    const html = render(createElement(PeopleCard, { order: value, model: base('owner', value, { tab: 'overview', production: withPeople, people, ...over }).record }), locale)
    return html.split('<li class="fw-so-ov-row">').slice(1).find((row) => textOf(row).startsWith(locale === 'en' ? 'Supervisor' : 'Supervisore')) ?? ''
  }

  it('the value without the icon or a second "Supervisor"; Change… and Ask as doors; in production nothing holds Change…', () => {
    const row = supervisorRow('IN_PRODUCTION')
    expect(textOf(row)).toBe('Supervisor Bea Esempio · this order Change… Ask')
    expect(row).toContain('<span class="fw-psv-doors">')
    expect(row).not.toContain('<svg')
    expect(row).not.toContain('aria-disabled')
  })

  it('a waiting order: "not yet" (B-OO-008’s words); after production: "no longer"; no right: the right’s words — never hidden', () => {
    expect(supervisorRow('PENDING_APPROVAL')).toContain('aria-description="This order waits for a yes: its supervisor is set once it is confirmed."')
    expect(supervisorRow('PENDING_APPROVAL', {}, 'it')).toContain('aria-description="Questo ordine aspetta un sì: il supervisore si sceglie quando è confermato."')
    for (const status of ['SHIPPED', 'CLOSED', 'CANCELLED'] as const) expect(supervisorRow(status), status).toContain('aria-description="This order is no longer in production: its supervisor stays."')
    expect(supervisorRow('IN_PRODUCTION', { people: { ...people, mayAssign: false } })).toContain('aria-description="Setting a production supervisor needs the right to manage customers')
  })

  it('Read-only: the supervisor’s value alone — no Change…, no Ask', () => {
    const row = supervisorRow('IN_PRODUCTION', { people: { ...people, mayAssign: false }, can: abilitiesOf(['orders.view', 'workorders.view']) })
    expect(textOf(row)).toBe('Supervisor Bea Esempio · this order')
    expect(row).not.toContain('<button')
  })

  it('the css: the supervisor’s doors wrap under the words below a 480 px card, as every row’s doors', () => {
    const css = readFileSync(new URL('../view/overview/people.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{[^@]*\.fw-so-people-list > \.fw-so-ov-row > \.fw-psv-doors \{\s*grid-column: 1 \/ -1;\s*justify-self: end;/)
  })
})
// ---- end F-OO-132
