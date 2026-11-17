import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { NOTE_RECORDS_MAX as DOMAIN_RECORDS_MAX, NOTE_WORDS, NAMES_NO_OTHER_CUSTOMER } from '@nexus/factory-domain/production-brand/notes'
import { ISSUE_WORDS } from '@nexus/factory-domain/production-brand/issues'
import { MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { leftKeys, render, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen as listScreen } from '../../work-orders/fixtures'
import { designScreen as recordScreen } from '../../work-orders/record/fixtures'
import { rowWords } from '../../../home/notifications/words'
import type { Notification } from '../../../home/notifications/model'
import { NOTE_CHECK, NOTE_CHECK_HOLD, NOTE_PEOPLE, NOTE_RESULT, NOTE_TARGETS, noteModel } from './fixtures'
import {
  API_SENTENCES,
  bodyOf,
  checkLines,
  checkOf,
  customersOf,
  draftAfter,
  draftKeyOf,
  lastAnswerOf,
  mergePeople,
  NEW_DRAFT,
  NOTE_BODY_MAX,
  NOTE_RECORDS_MAX,
  NOTES_NS,
  notRaisedKeyOf,
  openHeld,
  PEOPLE_READS_MAX,
  peopleSources,
  recordsOf,
  resultOf,
  salesOrdersHeld,
  sendHeld,
  skipKeyOf,
  targetsOfRecord,
  targetsOfRows,
  titleOf,
  writeProblemOf,
  type CheckState,
  type NoteRecord,
} from './model'
import { NoteDialogBody } from './view/NoteDialog'

/**
 * F-PR-22 — Ask the supervisor / Note to N (production plan §1, §3; lead picks L23, R-47, R-54, R-55): ONE dialog from the work order
 * band and Work orders (a row's ⋯, a selection's "Note to N…", up to 100) on B-PR-43a/b's routes. Wall tests (web side):
 *   PW-13   a record the API does not name to this reader is counted, never named (check and result); the text that names another
 *           customer holds Send until the text changes or "This text names no other customer" is ticked (R-47), and a new text takes
 *           the tick away; every note is an Office note (the yellow box says "never shown to a customer")
 *   PW-12   a selection's records are only the rows the API gave (each sales order once); a refused row is named only as the API
 *           named it; the rest counted
 *   PW-17   "Needs an answer" is a tick on the office's own note; a record with no supervisor (or of no customer) is said, and a task
 *           nobody may be given is said as such — never a person the API did not assign
 */

const t = (locale: 'it' | 'en' = 'en') => createTranslator(locale, messagesFor(locale, [NOTES_NS])[NOTES_NS]!)
const body = (model = noteModel(), locale: 'it' | 'en' = 'en') => textOf(render(createElement(NoteDialogBody, { model }), locale))
const ALPHA = { id: 'party-alpha', code: 'ALPHA', name: 'Brand Alpha' }
const BETA = { id: 'party-beta', code: 'BETA', name: 'Brand Beta' }
const row = (id: string, customer: typeof ALPHA | null, orders: { id: string; number: string }[], companyId = 'company-1') => ({ id, number: id.toUpperCase(), companyId, customer, orders })
const ready = (answer = NOTE_CHECK, key = 'k'): CheckState => ({ status: 'ready', key, answer })

describe('F-PR-22 — what the dialog writes on', () => {
  it('a selection: each work order, and each of their sales orders once; a work order of no order counted; the customer by name or code', () => {
    const rows = [row('wo-1', ALPHA, [{ id: 'so-1', number: 'SO-1' }]), row('wo-2', ALPHA, [{ id: 'so-1', number: 'SO-1' }, { id: 'so-2', number: 'SO-2' }]), row('wo-3', BETA, [], 'company-2')]
    const targets = targetsOfRows(rows, true)
    expect(targets.workOrders.map((record) => [record.type, record.label, record.partyName])).toEqual([
      ['WorkOrder', 'WO-1', 'Brand Alpha'],
      ['WorkOrder', 'WO-2', 'Brand Alpha'],
      ['WorkOrder', 'WO-3', 'Brand Beta'],
    ])
    expect(targets.salesOrders.map((record) => record.label)).toEqual(['SO-1', 'SO-2'])
    expect(targets.withoutOrder).toBe(1)
    expect(targetsOfRows(rows, false).workOrders[0]!.partyName).toBe('ALPHA')
    expect(customersOf(targets.workOrders)).toEqual({ count: 2, name: null })
    expect(customersOf(targets.salesOrders)).toEqual({ count: 1, name: 'Brand Alpha' })
  })

  it('the band: the work order, and its sales orders once (their own customer)', () => {
    const record = { id: 'wo-9', number: 'WO-9', companyId: 'c1', partyId: ALPHA.id, customer: ALPHA, orders: [{ id: 'so-1', number: 'SO-1', partyId: ALPHA.id, partyName: ALPHA.name }, { id: 'so-1', number: 'SO-1', partyId: ALPHA.id, partyName: ALPHA.name }] }
    const targets = targetsOfRecord(record, true)
    expect(targets.workOrders).toEqual([{ type: 'WorkOrder', id: 'wo-9', label: 'WO-9', partyId: ALPHA.id, partyName: 'Brand Alpha', companyId: 'c1' }])
    expect(targets.salesOrders).toHaveLength(1)
    expect(recordsOf(targets, 'salesOrders')[0]!.type).toBe('SalesOrder')
    expect(titleOf({ from: 'band', targets, draft: NEW_DRAFT })).toEqual({ key: 'title.ask', params: { number: 'WO-9' } })
    expect(titleOf({ from: 'selection', targets: NOTE_TARGETS, draft: { ...NEW_DRAFT, on: 'salesOrders' } })).toEqual({ key: 'title.salesOrders', params: { count: 9 } })
  })

  it('their sales orders: held in words with none, or over 100', () => {
    expect(salesOrdersHeld({ workOrders: [], salesOrders: [], withoutOrder: 2 })).toEqual({ key: 'on.noOrder' })
    const many: NoteRecord[] = Array.from({ length: 101 }, (_, index) => ({ type: 'SalesOrder', id: `so-${index}`, label: `SO-${index}`, partyId: ALPHA.id, partyName: ALPHA.name, companyId: 'c1' }))
    expect(salesOrdersHeld({ workOrders: [], salesOrders: many, withoutOrder: 0 })).toEqual({ key: 'on.tooMany', params: { count: 101, max: 100 } })
    expect(salesOrdersHeld(NOTE_TARGETS)).toBeNull()
  })

  it('mirrors the domain and the API: at most 100 records, the body limit, the sentences of `why`', () => {
    expect(NOTE_RECORDS_MAX).toBe(DOMAIN_RECORDS_MAX)
    expect(NOTE_BODY_MAX).toBe(MAX_BODY_LENGTH)
    expect(API_SENTENCES.CANNOT_POST).toBe(NOTE_WORDS.CANNOT_POST.en)
    expect(API_SENTENCES.THREAD_CLOSED).toBe(NOTE_WORDS.THREAD_CLOSED.en)
    expect(API_SENTENCES.NOT_A_PERSON).toBe(NOTE_WORDS.NOT_A_PERSON.en)
    expect(API_SENTENCES.NO_CUSTOMER).toBe(ISSUE_WORDS.NO_CUSTOMER.en)
    expect(t('it')('check.namesOtherTick')).toBe(NAMES_NO_OTHER_CUSTOMER.it)
    expect(t('en')('check.namesOtherTick')).toBe(NAMES_NO_OTHER_CUSTOMER.en)
    const contract = readFileSync(new URL('../../../../../../factory-api/src/modules/production/notes/contract.ts', import.meta.url), 'utf8')
    for (const field of ['records:', 'mentions:', 'askSupervisor:', 'namesNoOtherCustomer:', 'needsAnswer:', 'namesOtherCustomer:', 'noSupervisor:', 'noIssue:', 'notMentioned:', 'held:']) expect(contract).toContain(field)
    const manifest = readFileSync(new URL('../../../../../../factory-api/src/modules/production/notes/manifest.ts', import.meta.url), 'utf8')
    expect(manifest).toContain("'POST /production/notes': { audiences: ['office'], permission: 'threads.post'")
    expect(manifest).toContain("'POST /production/notes/check': { audiences: ['office'], permission: 'threads.post'")
  })
})

describe('F-PR-22 — the @ list (the threads MentionInput)', () => {
  it('one people read per customer and company of the records (at most six; more: said partial)', () => {
    const { sources, complete } = peopleSources(NOTE_TARGETS.workOrders)
    expect(sources.map((record) => record.partyName)).toEqual(['Brand Alpha', 'Brand Beta'])
    expect(complete).toBe(true)
    const many: NoteRecord[] = Array.from({ length: PEOPLE_READS_MAX + 2 }, (_, index) => ({ type: 'WorkOrder', id: `wo-${index}`, label: `WO-${index}`, partyId: `party-${index}`, partyName: null, companyId: 'c1' }))
    expect(peopleSources(many)).toMatchObject({ complete: false })
    expect(peopleSources(many).sources).toHaveLength(PEOPLE_READS_MAX)
  })

  it('the lists crossed into one: each person once, the supervisor tag kept and first', () => {
    const merged = mergePeople([
      [{ id: 'u-dora', name: 'Dora Campione' }, { id: 'u-bea', name: 'Bea Esempio' }],
      [{ id: 'u-bea', name: 'Bea Esempio', tag: 'Supervisor' }, { id: 'u-alex', name: 'Alex Demo' }],
    ])
    expect(merged.map((person) => [person.name, person.tag ?? null])).toEqual([
      ['Bea Esempio', 'Supervisor'],
      ['Alex Demo', null],
      ['Dora Campione', null],
    ])
  })

  it('the draft the check and the write take: the records of the choice, the @mentions of readers only, the ticks', () => {
    const draft = { ...NEW_DRAFT, body: 'Please look @Dora Campione and @Nobody Here', needsAnswer: true }
    const sent = bodyOf(NOTE_TARGETS, draft, NOTE_PEOPLE)
    expect(sent.records).toHaveLength(12)
    expect(sent.records[0]).toEqual({ type: 'WorkOrder', id: NOTE_TARGETS.workOrders[0]!.id })
    expect(sent.mentions).toEqual([NOTE_PEOPLE[2]!.id])
    expect(sent).toMatchObject({ askSupervisor: true, needsAnswer: true, namesNoOtherCustomer: false })
    expect(bodyOf(NOTE_TARGETS, { ...draft, on: 'salesOrders' }, NOTE_PEOPLE).records.every((record) => record.type === 'SalesOrder')).toBe(true)
    expect(draftKeyOf(sent)).not.toBe(draftKeyOf({ ...sent, body: `${sent.body}.` }))
  })
})

describe('F-PR-22 — before Send: the check (PW-13 + the other-customer hold, R-47)', () => {
  it('names who cannot read some records ("not mentioned there"), several customers plainly, records with no supervisor', () => {
    const lines = checkLines(NOTE_CHECK, NEW_DRAFT)
    const en = t('en')
    expect(lines.people.map((phrase) => en(phrase.key, phrase.params))).toEqual(['Dora Campione cannot read 2 of 12: not mentioned there (WO-0309, WO-0310). The note is still written.'])
    expect(en(lines.customers!.key, lines.customers!.params)).toBe('These records belong to 2 customers. Office notes never reach a customer.')
    expect(lines.noSupervisor).toEqual({ key: 'check.noSupervisor', params: { records: 'WO-0311, WO-0312' } })
    expect(checkLines(NOTE_CHECK, { askSupervisor: false, needsAnswer: true }).noSupervisor?.key).toBe('check.noSupervisorTask')
    expect(checkLines(NOTE_CHECK, { askSupervisor: false, needsAnswer: false }).noSupervisor).toBeNull()
    expect(lines.namesOther).toBeNull()
    // PW-13: records the writer does not see are counted, never named.
    expect(checkLines({ ...NOTE_CHECK, unknown: 3 }, NEW_DRAFT).unknown).toEqual({ key: 'check.unknown', params: { count: 3 } })
  })

  it('the text names another customer: those records named (with the names the writer may know); Send held until the tick', () => {
    const lines = checkLines(NOTE_CHECK_HOLD, NEW_DRAFT)
    expect(lines.namesOther!.lead).toEqual({ key: 'check.namesOther', params: { records: 'WO-0301, WO-0302' } })
    expect(lines.namesOther!.records.map((phrase) => t('en')(phrase.key, phrase.params))).toEqual(['WO-0301 names Brand Beta', 'WO-0302 names Brand Beta'])
    const held = sendHeld({ can: true, records: 12, body: 'x', offline: false, busy: false, check: ready(NOTE_CHECK_HOLD) })
    expect(held).toEqual({ key: 'held.namesOther' })
    // Ticked, the check is read again and lets it go.
    expect(sendHeld({ can: true, records: 12, body: 'x', offline: false, busy: false, check: ready({ ...NOTE_CHECK_HOLD, held: false }) })).toBeNull()
  })

  it('a new text takes the tick away (the tick confirmed the text that was there)', () => {
    const ticked = draftAfter({ ...NEW_DRAFT, body: 'Ask Brand Beta?' }, { namesNoOtherCustomer: true })
    expect(ticked.namesNoOtherCustomer).toBe(true)
    expect(draftAfter(ticked, { body: 'Ask Brand Beta? Today.' }).namesNoOtherCustomer).toBe(false)
    expect(draftAfter(ticked, { needsAnswer: true }).namesNoOtherCustomer).toBe(true)
  })

  it('an answer of another draft is no answer: "checking", the last one kept to draw', () => {
    expect(checkOf(ready(NOTE_CHECK, 'a'), 'a')).toMatchObject({ status: 'ready' })
    const moved = checkOf(ready(NOTE_CHECK, 'a'), 'b')
    expect(moved).toMatchObject({ status: 'checking', key: 'b' })
    expect(lastAnswerOf(moved)).toBe(NOTE_CHECK)
    expect(checkOf({ status: 'idle' }, 'b')).toEqual({ status: 'idle' })
  })

  it('why Send waits, in order: the right, nothing, over 100, no text, offline, busy, the check, nothing writable, the hold', () => {
    const base = { can: true, records: 12, body: 'Note', offline: false, busy: false, check: ready() }
    expect(sendHeld({ ...base, can: false })).toEqual({ key: 'held.noRight' })
    expect(sendHeld({ ...base, records: 0 })).toEqual({ key: 'held.noRecords' })
    expect(sendHeld({ ...base, records: 101 })).toEqual({ key: 'held.tooMany', params: { count: 101, max: 100 } })
    expect(sendHeld({ ...base, body: '   ' })).toEqual({ key: 'held.empty' })
    expect(sendHeld({ ...base, offline: true })).toEqual({ key: 'held.offline' })
    expect(sendHeld({ ...base, busy: true })).toEqual({ key: 'held.busy' })
    expect(sendHeld({ ...base, check: { status: 'failed', key: 'k' } })).toEqual({ key: 'held.checkFailed' })
    expect(sendHeld({ ...base, check: { status: 'checking', key: 'k' } })).toEqual({ key: 'held.checking' })
    expect(sendHeld({ ...base, check: { status: 'idle' } })).toEqual({ key: 'held.checking' })
    expect(sendHeld({ ...base, check: ready({ ...NOTE_CHECK, records: NOTE_CHECK.records.map((record) => ({ ...record, canWrite: false })) }) })).toEqual({ key: 'held.noneWritable' })
    expect(sendHeld(base)).toBeNull()
    expect(openHeld(true, 101)).toEqual({ key: 'held.tooMany', params: { count: 101, max: 100 } })
    expect(openHeld(false, 1)).toEqual({ key: 'held.noRight' })
    expect(openHeld(true, 0)).toEqual({ key: 'held.noRecords' })
  })
})

describe('F-PR-22 — after Send: one result per record (PW-12, PW-13, PW-17)', () => {
  const answer = {
    batchId: 'b1',
    written: [{ type: 'WorkOrder' as const, id: NOTE_TARGETS.workOrders[0]!.id, label: 'WO-0301', messageId: 'm1', mentioned: ['u-bea', 'u-dora'], supervisorAsked: true, issueId: 'i1' }],
    skipped: [{ type: 'WorkOrder' as const, id: NOTE_TARGETS.workOrders[1]!.id, label: 'WO-0302', why: NOTE_WORDS.THREAD_CLOSED.en }],
    notMentioned: [{ userId: NOTE_PEOPLE[2]!.id, records: [{ type: 'WorkOrder' as const, id: NOTE_TARGETS.workOrders[0]!.id, label: 'WO-0301' }] }],
    unknown: 1,
    issues: { tasks: [{ taskId: 't1', type: 'SalesOrder', id: 'so-1', label: 'SO-DEMO-0141', assigned: false, records: 2 }], notRaised: [{ type: 'WorkOrder', id: 'wo-x', label: 'WO-00002', why: ISSUE_WORDS.NO_CUSTOMER.en }] },
  }

  it('lines in the dialog’s order; a skipped row said from its code; records the API did not name only counted', () => {
    const result = resultOf(answer, NOTE_TARGETS.workOrders.slice(0, 4), new Map(NOTE_PEOPLE.map((person) => [person.id, person.name])))
    expect(result.lines).toEqual([
      { key: `WorkOrder:${NOTE_TARGETS.workOrders[0]!.id}`, label: 'WO-0301', state: 'written', mentioned: 2, supervisorAsked: true, issue: true },
      { key: `WorkOrder:${NOTE_TARGETS.workOrders[1]!.id}`, label: 'WO-0302', state: 'skipped', why: 'skip.THREAD_CLOSED' },
    ])
    // Two records the answer does not name (another customer's, or gone): counted, never named.
    expect(result.unknown).toBe(2)
    expect(JSON.stringify(result.lines)).not.toContain('WO-0303')
    expect(t('en')(result.notMentioned[0]!.key, result.notMentioned[0]!.params)).toBe('Dora Campione was not mentioned on WO-0301: cannot read them.')
    // PW-17: a task nobody may be given there yet is said so (never a person the API did not assign).
    expect(t('en')(result.tasks[0]!.key, result.tasks[0]!.params)).toBe('A task on SO-DEMO-0141 (2 records): nobody may be given it there yet.')
    expect(result.notRaised[0]).toEqual({ key: 'result.notRaised', params: { record: 'WO-00002', why: 'issue.noCustomer' } })
    expect(skipKeyOf('Something new.')).toBe('skip.other')
    expect(notRaisedKeyOf('Something new.')).toBe('issue.other')
  })

  it('a refused Send in words; the other-customer hold reads the check again', () => {
    expect(writeProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/NAMES_OTHER_CUSTOMER', message: NOTE_WORDS.NAMES_OTHER_CUSTOMER.en }, { path: 'body/records/0', message: 'WO-0301: Here the text names another customer.' }]))).toEqual({ key: 'problem.namesOther', recheck: true })
    expect(writeProblemOf(new ApiError('not_found', 404, 'not_found', NOTE_WORDS.NONE_FOUND.en))).toEqual({ key: 'problem.noneFound', recheck: false })
    expect(writeProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toMatchObject({ key: 'problem.cannotPost' })
    expect(writeProblemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/mentions/0', message: NOTE_WORDS.NOT_A_PERSON.en }]))).toMatchObject({ key: 'problem.notAPerson' })
    expect(writeProblemOf(new ApiError('invalid', 400, 'invalid', 'x', null, []))).toMatchObject({ key: 'problem.invalid' })
    expect(writeProblemOf(new ApiError('unavailable', 0, 'network', 'x'))).toMatchObject({ key: 'problem.offline' })
    expect(writeProblemOf(new Error('boom'))).toMatchObject({ key: 'problem.failed' })
  })
})

describe('F-PR-22 — THE note dialog on screen', () => {
  it('the records and customers, Write on, the yellow Office note never shown to a customer, the supervisor ticked, Needs an answer', () => {
    const text = body()
    expect(text).toContain('WO-0301, WO-0302, WO-0303')
    expect(text).toContain('Show all 12')
    expect(text).toContain('2 customers')
    expect(text).toContain('each work order (12)')
    expect(text).toContain('their sales orders (9)')
    expect(text).toContain('Office note · never shown to a customer')
    expect(text).toContain("Each record's supervisor")
    expect(text).toContain('Needs an answer')
    expect(text).toContain('Dora Campione cannot read 2 of 12: not mentioned there')
    expect(text).toContain('These records belong to 2 customers. Office notes never reach a customer.')
    const html = render(createElement(NoteDialogBody, { model: noteModel() }), 'en')
    expect(html).toContain('role="combobox"') // the threads MentionInput
    expect(html).toMatch(/type="checkbox"[^>]*checked/)
  })

  it('the hold: the records named, the tick offered; Italian says "Nota d’ufficio · mai mostrata a un cliente"', () => {
    const hold = body(noteModel({ answer: NOTE_CHECK_HOLD }))
    expect(hold).toContain('The text names another customer on WO-0301, WO-0302')
    expect(hold).toContain('WO-0301 names Brand Beta')
    expect(hold).toContain('This text names no other customer')
    const it = body(noteModel({ answer: NOTE_CHECK_HOLD }), 'it')
    expect(it).toContain("Nota d'ufficio · mai mostrata a un cliente")
    expect(it).toContain('Questo testo non nomina altri clienti')
  })

  it('offline, a refused Send and the check failing are said in words; the text stays', () => {
    expect(body(noteModel({ offline: true }))).toContain('You are offline: the note waits here until the network is back.')
    expect(body(noteModel({ problem: 'problem.offline' }))).toContain('Your text is kept: try again.')
    expect(body({ ...noteModel(), check: { status: 'failed', key: 'x' } })).toContain('Could not check who can read them.')
    expect(render(createElement(NoteDialogBody, { model: noteModel({ problem: 'problem.offline' }) }))).toContain('Hides for lot 44 arrive Thursday.')
  })

  it('the result: one line per record, a refused one with why, the rest counted (never named)', () => {
    const text = body(noteModel({ result: NOTE_RESULT }))
    expect(text).toContain('Written on 9 records')
    expect(text).toContain('WO-0310 · Not written: its thread is closed: reopen it to write a note')
    expect(text).toContain('2 more you cannot see: counted, not named.')
    expect(text).not.toContain('WO-0311')
  })

  it('every word in both languages, no key and no placeholder left (the dialog and its design cases)', () => {
    for (const locale of LOCALES) {
      for (const model of [noteModel(), noteModel({ answer: NOTE_CHECK_HOLD, draft: { needsAnswer: true } }), noteModel({ result: NOTE_RESULT }), noteModel({ offline: true, problem: 'problem.failed' })]) {
        const html = render(createElement(NoteDialogBody, { model }), locale)
        expect(leftKeys(html, ['open', 'title', 'records', 'on', 'box', 'needsAnswer', 'people', 'check', 'held', 'problem', 'result', 'skip', 'issue'])).toEqual([])
        expect(textOf(html)).not.toMatch(/\{[a-z]+\}/i)
      }
    }
    const cases = [...listScreen.cases.filter((item) => item.id.startsWith('note-')).map((item) => [listScreen, item] as const), ...recordScreen.cases.filter((item) => item.id.startsWith('note-')).map((item) => [recordScreen, item] as const)]
    expect(cases.length).toBeGreaterThanOrEqual(12)
    for (const [screen, item] of cases) {
      for (const locale of LOCALES) {
        const html = renderView(screen.view as ComponentType<{ model: unknown }>, item.model, locale)
        expect(leftKeys(html, ['open', 'held', 'check', 'box']), `${item.id} (${locale})`).toEqual([])
      }
    }
  })

  it('the band: Ask beside the supervisor fact and ⋯ Ask the supervisor; held in words without threads.post', () => {
    const band = textOf(renderView(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === 'note-ask-band')!.model))
    expect(band).toContain('Supervisor Bea Esempio · this order')
    expect(band).toMatch(/Change…\s+Ask\b/)
    expect(t('en')('open.selection', { count: 2 })).toBe('Note to 2…')
    expect(t('it')('open.ask')).toBe('Chiedi al supervisore')
    const held = render(createElement(NoteDialogBody, { model: noteModel({ can: false }) }))
    expect(textOf(held)).toContain('Office note · never shown to a customer')
    expect(t('en')('held.noRight')).toBe('Your role does not write office notes.')
  })
})

describe('F-PR-22 — the bell: one row for a note batch on several orders (threads T6, B-TH-045)', () => {
  const mention = (records: number): Notification => ({
    id: 'n1',
    category: 'MENTION',
    eventType: 'thread.user_mentioned',
    record: { type: 'WorkOrder', id: 'wo1', label: 'WO-0301' },
    companyId: 'c1',
    anchor: 'message:m1',
    messageKey: 'notifications.mentioned',
    params: { actorId: 'u1' },
    sentence: 'Alex Demo mentioned you on WO-0301',
    actor: { id: 'u1', name: 'Alex Demo' },
    people: { u1: 'Alex Demo' },
    state: 'OPEN',
    read: false,
    readAt: null,
    doneAt: null,
    snoozed: null,
    createdAt: '2026-11-17T09:00:00.000Z',
    group: { key: 'batch:b1:MENTION', count: records, ids: [], records },
  })
  const words = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale]['home-notifications']!)

  it('"Alex Demo mentioned you on 12 orders" (the records this reader may read); one record: its sentence as before', () => {
    expect(rowWords(mention(12), words('en'), 'en')).toBe('Alex Demo mentioned you on 12 orders')
    expect(rowWords(mention(12), words('it'), 'it')).toBe('Alex Demo ti ha menzionato su 12 ordini')
    expect(rowWords(mention(1), words('en'), 'en')).toBe('Alex Demo mentioned you on WO-0301')
    expect(rowWords({ ...mention(12), messageKey: 'notifications.following.note' }, words('en'), 'en')).toBe('Alex Demo wrote a note on WO-0301, which you follow')
  })
})
