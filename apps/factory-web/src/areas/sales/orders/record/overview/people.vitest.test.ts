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
import { peopleViewOf } from './people'
// ---- F-OO-133: the real answerer, its held door, and the re-read after the owner changed ----
import type { ComponentType } from 'react'
import { renderView } from '../../../../../lib/record-thread/parts/testing'
import { rightRef } from '../../../../../lib/i18n/rights'
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { designScreen } from '../fixtures'
import { answererWordsOf, answerHeldOf, OWNER_WORDS_NS } from './people'
// ---- F-OO-134: where it is made, one line per place; Open in Planning › ----
import { formatDate } from '../../../../../lib/i18n/format'
import { dayInstant } from '../../model'
import type { WorkOrderActsModel } from '../../../../../lib/production/work-order-acts/use-work-order-acts'
import { placeLinesOf, placeLineWords, planningWorkOrderOf } from './people'
// ---- F-OO-135: the Followers count in the card's head ----
import { FollowersLink } from '../view/Discuss'

/** F-OO-100 (order overview lane: one file per section) — People's rules, moved with people.ts out of overview.vitest.test.ts unchanged. */

// F-OO-134: placeWords became placeLinesOf (one line per place, plant or outside told apart) — its test is F-OO-134's below.

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
    expect(html).toContain('<ul class="fw-so-ov-list">') // F-CO-K2: the kit's ONE list (People's has no name: no aria-label)
    expect(textOf(rowOf(html, 'Supervisor'))).toContain('Bea Esempio · this order')
    expect(rowOf(html, 'Supervisor')).toContain('>Ask</button>')
    expect(rowOf(html, 'Supervisor')).not.toContain('aria-disabled')
    expect(textOf(rowOf(html, 'Backup'))).toContain('Carlo Prova · for every order of Moto Demo S.r.l.')
    expect(rowOf(html, 'Backup')).toMatch(/href="\/w\/DEMO\/sales\/customers\/[^"]+"/)
    expect(textOf(rowOf(html, 'Answers the customer'))).toContain('Bea Esempio')
    expect(textOf(rowOf(html, 'Answers the customer'))).toContain('Change…')
    // F-OO-134: one line per place (a plant line, an outside workshop), "(from the plan)".
    expect(textOf(rowOf(html, 'Where it is made'))).toContain('Stabilimento Nord › Linea 2 Outside: Laboratorio Esempio')
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
    // Walk #12: the backup's link says where it goes — never "Change" (a link to the customer's page) — and it wraps, never cut.
    expect(textOf(rowOf(html, 'Backup'))).toContain('Open the customer ›')
    expect(textOf(rowOf(html, 'Backup'))).not.toMatch(/Change/)
    expect(rowOf(html, 'Backup')).not.toContain('fw-so-cell-sub')
    expect(textOf(html)).toContain('Bea Esempio')
  })

  it('Finance (no workorders.view): only the card’s sentence — no row, never "Not set"; reading: no row; a failed read says so with Try again', () => {
    const finance = card(base('finance', value, { tab: 'overview', production: ready(NO_WORK_READ) }).record)
    expect(textOf(finance)).toContain('Who works on it is shown to people who follow production.')
    expect(finance).not.toContain('fw-so-ov-list') // F-CO-K2: the kit's ONE list
    expect(textOf(finance)).not.toContain('not set')
    expect(card(base('sales', value, { tab: 'overview', production: LOADING_STATE }).record)).not.toContain('fw-so-ov-list')
    const failed = textOf(card(base('sales', value, { tab: 'overview', production: FAILED_STATE }).record))
    expect(failed).toContain("Couldn't load People")
    expect(failed).toContain('Try again')
  })

  it('the source: Followers in the head (its own words), the rows on the shared card row, no Made by and no Told line left', () => {
    const view = source('../view/overview/PeopleCard.tsx')
    // F-CO-K1 (K1.3): the head is the kit's card's — Followers is its right side (`aside`).
    expect(view.indexOf('<OverviewCard ')).toBeGreaterThan(-1)
    expect(view.indexOf('<FollowersDoor />')).toBeGreaterThan(view.indexOf('<OverviewCard '))
    expect(view).toContain('aside={<FollowersDoor />}')
    expect(view.indexOf('<FollowersDoor />')).toBeLessThan(view.indexOf('<RowList>')) // F-CO-K2: the rows are the kit's ONE list
    expect(view).toContain("import './people.css'")
    expect(view).not.toContain('madeBy')
    expect(view).not.toContain('told.aboutChanges')
    expect(view).not.toContain('KeyValue')
    const door = source('../view/Discuss.tsx')
    // F-OO-135: the words with the reported count, or without one while none is known.
    expect(door).toContain("{count === null ? t('people.followers') : t('people.followersCount', { count })}")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['people.supervisor', 'people.followers']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
    expect(createTranslator('it', messagesFor('it', ['orders']).orders!)('people.followers')).toBe('Chi segue ›')
  })

  // F-CO-K2 (settle S3): People's list rules and Linked records' identical ones are the kit's ONE list now (record-overview.css,
  // .fw-so-ov-list); people.css keeps only the supervisor's own doors. The same four rules, read on the kit's list block.
  it('375: below a 360 px card a row stacks (label, value, doors); the rows line up on the list’s columns; tokens only', () => {
    const kit = source('../../../../_shared/record-overview/record-overview.css')
    const css = kit.slice(kit.indexOf("/* ── F-CO-K2 (the shared overview kit's rows): the ONE list"), kit.indexOf('/* ── end F-CO-K2 (the ONE list) ── */'))
    expect(css.length).toBeGreaterThan(100)
    expect(css).toMatch(/\.fw-so-ov-list \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\) auto;/)
    expect(css).toMatch(/\.fw-so-ov-list > \.fw-so-ov-row \{\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{\s*\.fw-so-ov-list \{\s*grid-template-columns: max-content minmax\(0, 1fr\);/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 359px\) \{\s*\.fw-so-ov-list \{\s*grid-template-columns: minmax\(0, 1fr\);/)
    expect(css).toMatch(/\.fw-so-ov-label \{\s*color: var\(--nds-text-muted\);/)
    // The list declares no container of its own (the kit makes every Overview card one); tokens only — in the kit's list block and in
    // what is left of people.css.
    for (const sheet of [css, source('../view/overview/people.css')]) {
      expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
      expect(sheet).not.toMatch(/container(-type)?:/)
    }
    // people.css names no list rule of its own any more (the kit's list is the ONE list: never restyled by a host).
    expect(source('../view/overview/people.css')).not.toMatch(/\.fw-so-(?:people|ov)-(?:list|label) \{/)
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
    // F-CO-K2: the list is the kit's ONE list (.fw-so-ov-list); this rule stays the card's own (people.css).
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{[^@]*\.fw-so-ov-list > \.fw-so-ov-row > \.fw-psv-doors \{\s*grid-column: 1 \/ -1;\s*justify-self: end;/)
  })
})
// ---- end F-OO-132

// ---- F-OO-133 (10-design §3.2, review F1; B-OO-008): Answers the customer — the real answerer and why; Change… held; read again ------
describe('F-OO-133: People › Answers the customer — who and why in the thread head’s words, Change… held in words, People read again after the owner changed', () => {
  const value = order('IN_PRODUCTION')
  const head = (locale: 'en' | 'it') => createTranslator(locale, messagesFor(locale, [OWNER_WORDS_NS])[OWNER_WORDS_NS]!)
  const bea = { id: '0190f0e2-9191-7000-8000-000000000001', name: 'Bea Esempio', active: true } as const
  const rights = (mayNote: boolean): NonNullable<OrderRecordModel['people']> => ({ mayAssign: true, mayNote, assign: null, note: null })
  const answersRow = (html: string, locale: 'en' | 'it' = 'en') => html.split('<li class="fw-so-ov-row">').slice(1).find((row) => textOf(row).startsWith(locale === 'en' ? 'Answers the customer' : 'Risponde al cliente')) ?? ''
  const people = (answersCustomer: (typeof PEOPLE)['answersCustomer']) => ready({ ...PRODUCTION_READ, people: { ...PEOPLE, answersCustomer } })
  const band = { back: createElement('a', { href: '/w/DEMO/sales/orders' }, 'Orders'), title: 'SO-2026-0142 · Moto Demo S.r.l.' }
  /** The card inside the order page's frame: with the conversation docked (the frame's doors), or none for this person. */
  const inFrame = (record: OrderRecordModel, thread: boolean, locale: 'en' | 'it' = 'en') =>
    render(createElement(RecordFrame, { recordType: 'SalesOrder', personId: 'u1', band, thread: thread ? createElement('div', null, 'thread') : null, threadLabel: 'The order’s thread', record: { type: 'SalesOrder', id: value.id }, children: createElement(PeopleCard, { order: value, model: record }) }), locale)
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  /** Words as the server writes them inside an attribute. */
  const attr = (words: string) => words.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

  it('who and why: each step of the owner chain in the head’s words, en + it; an inactive person stays named; an older answer: the name; nobody: "No owner yet"', () => {
    const en = head('en')
    const it = head('it')
    expect(answererWordsOf({ ...bea, source: 'SUPERVISOR' }, en)).toBe("Bea Esempio · the order's supervisor")
    expect(answererWordsOf({ ...bea, source: 'SET' }, en)).toBe('Bea Esempio · chosen')
    expect(answererWordsOf({ ...bea, source: 'MAKER' }, en)).toBe('Bea Esempio · who made the record')
    expect(answererWordsOf({ ...bea, source: 'ASSIGNEE' }, en)).toBe("Bea Esempio · the request's assignee")
    expect(answererWordsOf({ ...bea, source: 'SUPERVISOR' }, it)).toBe("Bea Esempio · supervisore dell'ordine")
    expect(answererWordsOf({ ...bea, source: 'SET' }, it)).toBe('Bea Esempio · scelto')
    expect(answererWordsOf({ ...bea, source: 'MAKER' }, it)).toBe('Bea Esempio · chi ha creato il record')
    expect(answererWordsOf({ ...bea, active: false, source: 'SET' }, en)).toBe('Bea Esempio (inactive) · chosen')
    expect(answererWordsOf({ ...bea, active: false, source: 'SET' }, it)).toBe('Bea Esempio (non attivo) · scelto')
    expect(answererWordsOf({ ...bea }, en)).toBe('Bea Esempio')
    expect(answererWordsOf(null, en)).toBe('No owner yet')
    expect(answererWordsOf(null, it)).toBe('Nessun responsabile')
  })

  it('the card: "Bea Esempio · the order’s supervisor" with Change…; nobody reads "No owner yet", never "—"; in Italian too', () => {
    const owner = (production: ReturnType<typeof ready>) => base('owner', value, { tab: 'overview', production, people: rights(true) }).record
    expect(textOf(answersRow(render(createElement(PeopleCard, { order: value, model: owner(people(PEOPLE.answersCustomer)) }))))).toBe("Answers the customer Bea Esempio · the order's supervisor Change…")
    expect(textOf(answersRow(render(createElement(PeopleCard, { order: value, model: owner(people({ ...bea, source: 'SET' })) }), 'it'), 'it'))).toBe('Risponde al cliente Bea Esempio · scelto Cambia…')
    const nobody = textOf(answersRow(render(createElement(PeopleCard, { order: value, model: owner(people(null)) }))))
    expect(nobody).toBe('Answers the customer No owner yet Change…')
    expect(nobody).not.toContain('—')
    // The words come from the thread head's catalogue, which the card brings itself (the design index draws it without the dock).
    const view = source('../view/overview/PeopleCard.tsx')
    expect(view).toContain('<WithMessages namespaces={[OWNER_WORDS_NS]}>')
    expect(view).toContain('{answererWordsOf(view.people.answersCustomer, head)}')
    expect(view).not.toContain("answersCustomer?.name ?? '—'")
  })

  it('Change… held in words, never hidden: no conversation on the page; no right to write in it (the dock’s own words); with both: free', () => {
    expect(answerHeldOf({ thread: false, mayWrite: true })).toEqual({ ns: 'orders', key: 'waiting.noThread' })
    expect(answerHeldOf({ thread: true, mayWrite: false })).toEqual({ ns: OWNER_WORDS_NS, key: 'held.noRight', params: { right: rightRef('threads.post') } })
    expect(answerHeldOf({ thread: true, mayWrite: true })).toBeNull()
    expect(answerHeldOf({ thread: true, mayWrite: null })).toBeNull()
    // No conversation for this person on the page (no frame doors): held with the page's sentence.
    const sales = (mayNote: boolean) => base('sales', value, { tab: 'overview', production: people(PEOPLE.answersCustomer), people: rights(mayNote) }).record
    expect(answersRow(inFrame(sales(true), false))).toContain('aria-description="The conversation is not on this page"')
    // The conversation docked, but no right to write in it: the dock's words for the same door ("You need the right “…”"), en + it.
    for (const locale of ['en', 'it'] as const) {
      const words = head(locale)('held.noRight', { right: rightRef('threads.post') })
      expect(words, locale).not.toContain('right:')
      expect(answersRow(inFrame(sales(false), true, locale), locale), locale).toContain(`aria-description="${attr(words)}"`)
    }
    // Docked and allowed: Change… opens the owner door, nothing holds it.
    const free = answersRow(inFrame(sales(true), true))
    expect(free).toContain('>Change…</button>')
    expect(free).not.toContain('aria-disabled')
    // The dock refuses the same door in the same words when it is asked anyway (one wording).
    expect(source('../../../../_shared/record-thread/DockedOfficeThread.tsx')).toContain("key: 'held.noRight', params: { right: rightRef('threads.post') }")
  })

  it('Read-only: the answerer and why, no Change…', () => {
    // End check fix wave: the people rights as the page builds them for Read-only (use-band-acts: mayAssign = production.brand.manage,
    // mayNote = threads.post — neither held). This block's rights() always lets the reader assign the supervisor, which is a move on
    // the page (readOnlyOnPage), so it never drew a Read-only reader.
    const readOnlyPeople = { mayAssign: false, mayNote: false, assign: null, note: null }
    const record = base('sales', value, { tab: 'overview', production: people(PEOPLE.answersCustomer), people: readOnlyPeople, can: abilitiesOf(['orders.view', 'workorders.view']) }).record
    const row = answersRow(inFrame(record, true))
    expect(textOf(row)).toBe("Answers the customer Bea Esempio · the order's supervisor")
    expect(row).not.toContain('<button')
  })

  it('a re-read after the owner changed (no event comes): the dock tells its host, the order dock passes it to This order’s conversation only, the page reads People alone', () => {
    const docked = source('../../../../_shared/record-thread/DockedOfficeThread.tsx')
    expect(docked).toContain('onOwnerChanged?: () => void')
    const pick = docked.slice(docked.indexOf('const pickOwner = async'), docked.indexOf('} catch (error) {', docked.indexOf('const pickOwner = async')))
    // Only after the API took the new owner (a refusal keeps the dialog open with its words; nothing is read again).
    expect(pick.indexOf('host.onOwnerChanged?.()')).toBeGreaterThan(pick.indexOf('await setThreadOwner(api, key, ownerId)'))
    const dock = source('../dock/OrderDock.tsx')
    const mounts = dock.split('\n').filter((line) => line.includes('<OfficeRecordThread key='))
    expect(mounts).toHaveLength(4)
    for (const line of mounts) expect(line.includes('onOwnerChanged'), line.slice(0, 60)).toBe(line.includes('key="order"'))
    const container = source('../OrderRecord.tsx')
    expect(container).toContain("const rereadPeople = () => production.again(['people'])")
    // Both of the page's conversations of the order (with a customer: the order dock; without: the thread alone) pass it.
    expect(container.match(/onOwnerChanged=\{rereadPeople /g)).toHaveLength(2)
  })

  it('the design index’s overview case draws the real card (W05 follow-up): the four rows, never the withheld sentence', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const html = renderView(view, designScreen.cases.find((item) => item.id === 'overview')!.model)
    expect(html).toContain('<ul class="fw-so-ov-list">') // F-CO-K2: the kit's ONE list
    expect(textOf(html)).not.toContain('Who works on it is shown to people who follow production.')
    expect(textOf(answersRow(html))).toContain("Bea Esempio · the order's supervisor")
  })
})
// ---- end F-OO-133

// ---- F-OO-134 (10-design §3.2; B-OO-008): Where it is made — one line per place, plant or outside told apart; Open in Planning › ------
describe('F-OO-134: People › Where it is made — a plant line or an outside workshop since its day, "(from the plan)", Open in Planning › with planning.view', () => {
  const named = (code: string, name: string) => ({ code, name })
  const plant = (over: Partial<(typeof PEOPLE)['places'][number]> = {}) => ({ site: named('A1', 'Seed plant A1'), line: named('L2', 'Line 2'), team: named('BLU', 'Team Blu'), workshop: null, kind: 'PLANT' as const, since: null, ...over })
  const outside = (name: string, since: string | null) => ({ site: null, line: null, team: null, workshop: { name }, kind: 'WORKSHOP' as const, since })
  const t = (locale: 'en' | 'it') => createTranslator(locale, messagesFor(locale, ['orders']).orders!)
  const day = (locale: 'en' | 'it') => (value: string) => formatDate(dayInstant(value), { locale })
  const value = order('IN_PRODUCTION')
  const LIVE_WO = value.chain.workOrders[0]!.id
  const acts = (planning: boolean) => ({ can: { view: true, qualityHold: false, reopen: false, planning } }) as unknown as WorkOrderActsModel
  const people = { mayAssign: true, mayNote: true, assign: null, note: null }
  const whereRow = (html: string, locale: 'en' | 'it' = 'en') => html.split('<li class="fw-so-ov-row">').slice(1).find((row) => textOf(row).startsWith(locale === 'en' ? 'Where it is made' : 'Dove si produce')) ?? ''
  const card = (over: Partial<OrderRecordModel>, locale: 'en' | 'it' = 'en', status: Parameters<typeof order>[0] = 'IN_PRODUCTION') => {
    const shown = order(status)
    return whereRow(render(createElement(PeopleCard, { order: shown, model: base('owner', shown, { tab: 'overview', production: ready({ ...PRODUCTION_READ, people: PEOPLE }), people, ...over }).record }), locale), locale)
  }

  it('placeLinesOf: a plant line "site › line · team" (a part not planned left out, its code without a name); an outside workshop with its day; none: no line', () => {
    expect(placeLinesOf([plant()])).toEqual([{ kind: 'PLANT', words: 'Seed plant A1 › Line 2 · Team Blu' }])
    expect(placeLinesOf([plant({ team: null })])).toEqual([{ kind: 'PLANT', words: 'Seed plant A1 › Line 2' }])
    expect(placeLinesOf([plant({ line: null, team: null })])).toEqual([{ kind: 'PLANT', words: 'Seed plant A1' }])
    expect(placeLinesOf([plant({ site: null })])).toEqual([{ kind: 'PLANT', words: 'Line 2 · Team Blu' }])
    expect(placeLinesOf([plant({ line: named('L3', '') })])[0]).toEqual({ kind: 'PLANT', words: 'Seed plant A1 › L3 · Team Blu' })
    expect(placeLinesOf([outside('Seed Leather Supplier S.p.A.', '2026-11-18')])).toEqual([{ kind: 'WORKSHOP', name: 'Seed Leather Supplier S.p.A.', since: '2026-11-18' }])
    expect(placeLinesOf([outside('Laboratorio Esempio', null)])).toEqual([{ kind: 'WORKSHOP', name: 'Laboratorio Esempio', since: null }])
    // Plant first, then outside — in the API's order (B-OO-008), one line each.
    expect(placeLinesOf(PEOPLE.places).map((line) => line.kind)).toEqual(['PLANT', 'WORKSHOP'])
    // An older answer without the kind: a place with a workshop is outside.
    expect(placeLinesOf([{ site: null, line: null, team: null, workshop: { name: 'Workshop Beta Leather' } }])).toEqual([{ kind: 'WORKSHOP', name: 'Workshop Beta Leather', since: null }])
    expect(placeLinesOf([{ site: named('S1', 'Main site'), line: named('L2', 'Line 2'), team: null, workshop: null }])).toEqual([{ kind: 'PLANT', words: 'Main site › Line 2' }])
    expect(placeLinesOf([])).toEqual([])
  })

  it('the words: "Outside: {name} · since {date}" (no day: "Outside: {name}"), en + it; a plant line as it is', () => {
    expect(placeLineWords({ kind: 'WORKSHOP', name: 'Seed Leather Supplier S.p.A.', since: '2026-11-18' }, t('en'), day('en'))).toBe(`Outside: Seed Leather Supplier S.p.A. · since ${day('en')('2026-11-18')}`)
    expect(placeLineWords({ kind: 'WORKSHOP', name: 'Seed Leather Supplier S.p.A.', since: '2026-11-18' }, t('it'), day('it'))).toBe(`Esterno: Seed Leather Supplier S.p.A. · dal ${day('it')('2026-11-18')}`)
    expect(placeLineWords({ kind: 'WORKSHOP', name: 'Laboratorio Esempio', since: null }, t('en'), day('en'))).toBe('Outside: Laboratorio Esempio')
    expect(placeLineWords({ kind: 'WORKSHOP', name: 'Laboratorio Esempio', since: null }, t('it'), day('it'))).toBe('Esterno: Laboratorio Esempio')
    expect(placeLineWords({ kind: 'PLANT', words: 'Seed plant A1 › Line 2 · Team Blu' }, t('en'), day('en'))).toBe('Seed plant A1 › Line 2 · Team Blu')
    for (const locale of LOCALES) for (const key of ['people.outside', 'people.outsideSince', 'dates.fromPlan', 'wo.link.planning']) expect(t(locale)(key, { name: 'x', date: 'y' }), `${locale} ${key}`).not.toBe(key)
  })

  it('planningWorkOrderOf: the first live work order with planning.view; none without the right, on a final order, or with no live work order', () => {
    const rows = [{ id: 'w0', status: 'CANCELLED' }, { id: 'w1', status: 'CLOSED' }, { id: 'w2', status: 'IN_PROGRESS' }, { id: 'w3', status: 'RELEASED' }]
    expect(planningWorkOrderOf(rows, { plan: true, final: false })).toBe('w2')
    expect(planningWorkOrderOf(rows, { plan: false, final: false })).toBeNull()
    expect(planningWorkOrderOf(rows, { plan: true, final: true })).toBeNull()
    expect(planningWorkOrderOf(rows.slice(0, 2), { plan: true, final: false })).toBeNull()
    expect(planningWorkOrderOf([], { plan: true, final: false })).toBeNull()
  })

  it('the card: one line per place, "(from the plan)", Open in Planning › at the first live work order (planning.view), en + it', () => {
    const row = card({ workOrderActs: acts(true) })
    expect(textOf(row)).toBe(`Where it is made Stabilimento Nord › Linea 2 Outside: Laboratorio Esempio · since ${day('en')('2026-11-10')} (from the plan) Open in Planning ›`)
    expect(row).toContain(`href="/w/DEMO/planning/board?wo=${encodeURIComponent(LIVE_WO)}"`)
    expect(row.match(/<span>[^<]+<\/span>/g)?.length, 'one line per place').toBe(2)
    expect(textOf(card({ workOrderActs: acts(true) }, 'it'))).toBe(`Dove si produce Stabilimento Nord › Linea 2 Esterno: Laboratorio Esempio · dal ${day('it')('2026-11-10')} (dal piano) Apri in Pianificazione ›`)
    // Derived: no Change… on this row, ever.
    expect(row).not.toContain('<button')
  })

  it('without planning.view, or on a final order: no Planning link; Read-only keeps the link (a link, not a move); nothing planned: "Not planned yet", no "(from the plan)"', () => {
    expect(card({ workOrderActs: acts(false) })).not.toContain('/planning/board')
    expect(card({ workOrderActs: null })).not.toContain('/planning/board')
    for (const status of ['CLOSED', 'CANCELLED'] as const) expect(card({ workOrderActs: acts(true) }, 'en', status), status).not.toContain('/planning/board')
    const readOnly = card({ workOrderActs: acts(true), people: { ...people, mayAssign: false }, can: abilitiesOf(['orders.view', 'workorders.view', 'planning.view']) })
    expect(readOnly).toContain('/planning/board?wo=')
    const none = whereRow(render(createElement(PeopleCard, { order: value, model: base('owner', value, { tab: 'overview', production: ready({ ...PRODUCTION_READ, people: { ...PEOPLE, places: [] } }), people, workOrderActs: acts(true) }).record })))
    expect(textOf(none)).toBe('Where it is made Not planned yet Open in Planning ›')
    expect(textOf(none)).not.toContain('(from the plan)')
  })

  it('the source: the rules in people.ts (placeWords is gone), the card never sets a place', () => {
    const rules = readFileSync(new URL('./people.ts', import.meta.url), 'utf8')
    expect(rules).not.toContain('export function placeWords(')
    expect(rules).toContain("const NO_PLACE_STATUSES: readonly string[] = ['CANCELLED', 'CLOSED']")
    const view = readFileSync(new URL('../view/overview/PeopleCard.tsx', import.meta.url), 'utf8')
    expect(view).toContain('{placeLineWords(line, t, day)}')
    expect(view).toContain("{t('dates.fromPlan')}")
    expect(view).toContain('planningHref(model.prefix, planning)')
  })
})
// ---- end F-OO-134

// ---- F-OO-135 (10-design §3.1): the People head says "Followers · N ›" — the count the dock reported through the frame; no thread: no door ---
describe('F-OO-135: People › "Followers · N ›" — the reported count shown; before a report "Followers ›"; no conversation here: no door', () => {
  const value = order('IN_PRODUCTION')
  const band = { back: createElement('a', { href: '/w/DEMO/sales/orders' }, 'Orders'), title: 'SO-2026-0142 · Moto Demo S.r.l.' }
  const record = base('sales', value, { tab: 'overview', production: ready({ ...PRODUCTION_READ, people: PEOPLE }), people: { mayAssign: false, mayNote: true, assign: null, note: null } }).record
  const inFrame = (thread: boolean, locale: 'en' | 'it' = 'en') =>
    render(createElement(RecordFrame, { recordType: 'SalesOrder', personId: 'u1', band, thread: thread ? createElement('div', null, 'thread') : null, threadLabel: 'The order’s thread', record: { type: 'SalesOrder', id: value.id }, children: createElement(PeopleCard, { order: value, model: record }) }), locale)
  /** The card's head (title and its link), before the rows. */
  const headOf = (html: string) => html.slice(html.indexOf('<div class="fw-ro-head">') /* F-CO-K1: the kit's card head */, html.indexOf('<ul class="fw-so-ov-list">') /* F-CO-K2: the kit's ONE list */)

  it('the reported count is shown: "Followers · 4 ›" / "Chi segue · 4 ›"; none known yet: "Followers ›"; a count of 0 is said too', () => {
    const link = (count: number | null, locale: 'en' | 'it' = 'en') => textOf(render(createElement(FollowersLink, { count, onOpen: () => undefined }), locale))
    expect(link(4)).toBe('Followers · 4 ›')
    expect(link(4, 'it')).toBe('Chi segue · 4 ›')
    expect(link(null)).toBe('Followers ›')
    expect(link(null, 'it')).toBe('Chi segue ›')
    expect(link(0)).toBe('Followers · 0 ›')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('people.followersCount', { count: 3 }), locale).toContain('3')
    }
  })

  it('in the order page\'s frame with its conversation: the head\'s link (the frame\'s count; on the server none is reported yet); no conversation: no door', () => {
    for (const locale of ['en', 'it'] as const) {
      const head = textOf(headOf(inFrame(true, locale)))
      expect(head, locale).toBe(locale === 'en' ? 'People Followers ›' : 'Persone Chi segue ›')
    }
    const none = headOf(inFrame(false))
    expect(textOf(none)).toBe('People')
    expect(none).not.toContain('<button')
    // Outside any frame (a design case without the page): no door either.
    expect(textOf(headOf(render(createElement(PeopleCard, { order: value, model: record }))))).toBe('People')
  })

  it('the door reads the frame\'s count (no second read of the followers) and opens the frame\'s followers door', () => {
    const door = readFileSync(new URL('../view/Discuss.tsx', import.meta.url), 'utf8')
    expect(door).toContain("if (!frame?.discuss || !frame.openDoor) return null")
    expect(door).toContain("<FollowersLink count={frame.followers ?? null} onOpen={() => frame.openDoor?.('followers')} />")
    expect(door).not.toContain('readFollowers')
  })
})
// ---- end F-OO-135
