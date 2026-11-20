import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { askFactsOf, changeFactsOf, floorToldAt, NEAR_MS, toldOfHistory, toldParts, type ToldChange, type WhoWasTold } from './told'
import { WhoWasToldBody } from './view/WhoWasToldDialog'

/**
 * F-SA-244 — the conversation side of a change on the order page (sales page plan P5, P8', P21, R2, R7, R8; 14-change-flow §4.1, §5.2;
 * review WP-1, WP-2): the ask cards' live chips, each change line's Still to do and told times, History's Told line, Production's
 * "Told the floor at hh:mm", Overview's count, and Who was told — who was TOLD, never who read anything. Made-up names only.
 */

const change = (over: Partial<ToldChange> = {}): ToldChange => ({
  batchId: 'b1',
  messageId: 'line-1',
  occurredAt: '2026-11-18T09:42:00.000Z',
  at: '2026-11-18T09:42:02.000Z',
  eventType: 'order_change_request.answered',
  requestId: 'r1',
  people: 6,
  floor: { at: '2026-11-18T09:42:02.000Z', workOrders: [{ id: 'wo1', number: 'WO-0311' }, { id: 'wo2', number: 'WO-0312' }], leftOut: 0 },
  workshop: { at: null, told: 0, waiting: 0 },
  ...over,
})
const request = (over: Record<string, unknown> = {}) => ({ id: 'r1', status: 'OPEN', askMessageId: 'ask-1', waitingOn: 'US' as const, may: { accept: true, refuse: true, counter: true }, ...over })

describe('F-SA-244: the ask cards and the change lines of the order\'s conversation', () => {
  it('an ask by its own message: its state now, the Still to do it left, Answer… only while it waits for this reader', () => {
    const asks = askFactsOf([request(), request({ id: 'r2', status: 'ACCEPTED', askMessageId: 'ask-2' }), request({ id: 'r3', askMessageId: null }), request({ id: 'r4', askMessageId: 'ask-4', may: { accept: false, refuse: false, counter: false } })], [{ requestId: 'r2' }, { requestId: 'r2' }, { requestId: null }])
    expect(asks.get('ask-1')).toEqual({ requestId: 'r1', state: 'OPEN', stillToDo: 0, answer: true })
    expect(asks.get('ask-2')).toEqual({ requestId: 'r2', state: 'ACCEPTED', stillToDo: 2, answer: false })
    // Asked before the ask had its own message: no card to fill.
    expect([...asks.keys()]).not.toContain(null)
    expect(asks.has('ask-4') && asks.get('ask-4')!.answer).toBe(false)
    // A counter-offer waits on the customer: no Answer….
    expect(askFactsOf([request({ status: 'COUNTERED', waitingOn: 'CUSTOMER' })], []).get('ask-1')!.answer).toBe(false)
  })

  it('a change line: its Still to do by the request it carried out (an office change: the rows of no request); not read: no claim', () => {
    const facts = changeFactsOf([change(), change({ messageId: 'line-2', requestId: null, eventType: 'sales_order.amended', floor: { at: null, workOrders: [], leftOut: 0 }, workshop: { at: '2026-11-18T10:00:00.000Z', told: 1, waiting: 0 } })], [{ requestId: 'r1' }, { requestId: null }, { requestId: null }])
    expect(facts.get('line-1')).toEqual({ stillToDo: 1, floorAt: '2026-11-18T09:42:02.000Z', workshopAt: null })
    expect(facts.get('line-2')).toEqual({ stillToDo: 2, floorAt: null, workshopAt: '2026-11-18T10:00:00.000Z' })
    expect(changeFactsOf([change()], null).get('line-1')!.stillToDo).toBeNull()
  })
})

describe('F-SA-244: History\'s Told line, Production\'s floor time — never who read it', () => {
  it('a request answered finds its change; an office amendment the amendment change nearest it (≤ 10 min); others none', () => {
    const changes = [change(), change({ messageId: 'line-2', requestId: null, eventType: 'sales_order.amended', occurredAt: '2026-11-18T12:00:00.000Z' })]
    expect(toldOfHistory({ kind: 'requestAnswered', at: '2026-11-18T09:42:00.000Z', requestId: 'r1' }, changes)?.messageId).toBe('line-1')
    expect(toldOfHistory({ kind: 'amendment', at: '2026-11-18T12:03:00.000Z' }, changes)?.messageId).toBe('line-2')
    expect(toldOfHistory({ kind: 'amendment', at: new Date(Date.parse('2026-11-18T12:00:00.000Z') + NEAR_MS + 1).toISOString() }, changes)).toBeNull()
    // The Accept's own amendment is the request's change, never a second Told line.
    expect(toldOfHistory({ kind: 'amendment', at: '2026-11-18T09:42:00.000Z' }, changes)).toBeNull()
    expect(toldOfHistory({ kind: 'requestAsked', at: '2026-11-18T09:00:00.000Z', requestId: 'r1' }, changes)).toBeNull()
    expect(toldOfHistory({ kind: 'confirmationSent', at: '2026-11-18T09:42:00.000Z' }, changes)).toBeNull()
  })

  it('"Told: conversation · bell to 6 people · floor note on WO-0311, WO-0312 · workshop notice"; a work order out of reach is counted', () => {
    const say = (locale: 'en' | 'it', item: ToldChange) => toldParts(item).map((part) => {
      const words = CATALOGUE[locale].orders ?? {}
      const count = typeof part.params?.count === 'number' ? part.params.count : null
      const key = count === null ? part.key : `${part.key}_${count === 1 ? 'one' : 'other'}`
      return Object.entries(part.params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), words[key] ?? words[part.key] ?? part.key)
    }).join(' · ')
    expect(say('en', change({ workshop: { at: '2026-11-18T09:44:00.000Z', told: 1, waiting: 0 } }))).toBe('Told: conversation · bell to 6 people · floor note on WO-0311, WO-0312 · workshop notice')
    expect(say('it', change())).toBe('Avvisati: conversazione · campanella a 6 persone · nota per il reparto su WO-0311, WO-0312')
    expect(say('en', change({ floor: { at: 'x', workOrders: [{ id: 'wo1', number: 'WO-0311' }], leftOut: 1 } }))).toBe('Told: conversation · bell to 6 people · floor note on WO-0311 · 1 more work order')
    expect(say('en', change({ people: 0, floor: { at: 'x', workOrders: [], leftOut: 1 } }))).toBe('Told: conversation · floor note on 1 work order')
    // No read counts of any kind (review WP-2).
    for (const locale of ['en', 'it'] as const) expect(say(locale, change())).not.toMatch(/read|seen|letto|visto|1 of 2|su 2/i)
  })

  it('the floor of a work order: the newest floor note of the order\'s changes on it; none: nothing said', () => {
    const changes = [change(), change({ messageId: 'line-2', floor: { at: '2026-11-18T11:00:00.000Z', workOrders: [{ id: 'wo1', number: 'WO-0311' }], leftOut: 0 } })]
    expect(floorToldAt(changes, 'wo1')).toBe('2026-11-18T11:00:00.000Z')
    expect(floorToldAt(changes, 'wo2')).toBe('2026-11-18T09:42:02.000Z')
    expect(floorToldAt(changes, 'wo9')).toBeNull()
  })
})

describe('F-SA-244: Who was told — office people by name and why, the floor and the workshops by when; never who read it', () => {
  const told: WhoWasTold = {
    order: { id: 'o1', number: 'SO-2026-0142' },
    change: { batchId: 'b1', messageId: 'line-1', at: '2026-11-18T09:42:02.000Z', requestId: 'r1' },
    people: {
      count: 3,
      groups: [
        { why: 'SUPERVISOR', words: { it: 'Supervisore o sostituto', en: 'Supervisor or backup' }, people: [{ id: 'u1', name: 'Dario Prova', workOrder: null }] },
        { why: 'FOLLOWS_WORK_ORDER', words: { it: 'Segue un ordine di lavoro', en: 'Follows a work order' }, people: [{ id: 'u2', name: 'Carla Prova', workOrder: { id: 'wo1', number: 'WO-0311' } }, { id: 'u3', name: 'Sara Esempio', workOrder: null }] },
      ],
    },
    floor: { at: '2026-11-18T09:42:02.000Z', workOrders: [{ id: 'wo1', number: 'WO-0311' }], leftOut: 1 },
    workshop: { at: '2026-11-18T09:44:00.000Z', subcontractOrders: [{ id: 's1', number: 'SC-0007', toldAt: '2026-11-18T09:44:00.000Z' }], waiting: 1, leftOut: 0 },
  }

  it('draws the groups, the floor and the workshops in both languages, with no read words', () => {
    const en = textOf(render(createElement(WhoWasToldBody, { told }), 'en'))
    expect(en).toContain('In the office: 3 people')
    expect(en).toContain('Supervisor or backup')
    expect(en).toContain('Carla Prova (follows WO-0311)')
    expect(en).toMatch(/Told the floor at \d\d:\d\d · WO-0311 · 1 more work order/)
    expect(en).toMatch(/Told the workshop at \d\d:\d\d · SC-0007 at \d\d:\d\d/)
    expect(en).toContain('1 outside workshop not told yet')
    expect(en).toContain('Who was told, never who read it.')
    expect(en).not.toMatch(/\b(seen|shown|read by|not yet seen)\b/i)
    const italian = textOf(render(createElement(WhoWasToldBody, { told }), 'it'))
    expect(italian).toContain('In ufficio: 3 persone')
    expect(italian).toMatch(/Reparto avvisato alle \d\d:\d\d · WO-0311 · 1 altro ordine di lavoro/)
    expect(italian).toContain('Chi è stato avvisato, mai chi ha letto.')
  })

  it('nobody told in the office: "Nobody else follows this order"; no floor note: said plainly', () => {
    const none = { ...told, people: { count: 0, groups: [] }, floor: { at: null, workOrders: [], leftOut: 0 }, workshop: { at: null, subcontractOrders: [], waiting: 0, leftOut: 0 } }
    expect(textOf(render(createElement(WhoWasToldBody, { told: none }), 'en'))).toContain('Nobody else follows this order')
    expect(textOf(render(createElement(WhoWasToldBody, { told: none }), 'it'))).toContain('Nessun altro segue questo ordine')
    expect(textOf(render(createElement(WhoWasToldBody, { told: none }), 'en'))).toContain('The floor was not told')
  })

  it('every told word in both languages; the page reads the told lines and mounts the window', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale].orders ?? {}
      for (const key of ['told.title', 'told.nobody', 'told.floorAt', 'told.workshopAt', 'told.conversation', 'told.workshop', 'told.neverRead', 'told.aboutChanges_other', 'told.bell_other', 'told.floorMore_one']) expect(words[key]).toBeTruthy()
    }
    expect(CATALOGUE.it.orders?.['told.aboutChanges_other']).toBe('Avvisati delle modifiche: {count} persone')
    const record = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(record).toContain('readToldChanges(api, readyId)')
    expect(record).toContain('<WhoWasToldDialog orderId={readyId} messageId={toldOpen}')
    expect(record).toContain('changeSide={changeSide /* F-SA-244 */}')
    const changes = readFileSync(new URL('./changes/view/ChangesTab.tsx', import.meta.url), 'utf8')
    expect(changes).toContain('actions?.onWhoWasTold?.(change.messageId)')
    const production = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(production).toContain("t('told.floorAt', { time: formatTime(floorAt, { locale }) })")
    const overview = readFileSync(new URL('./view/overview/PeopleCard.tsx', import.meta.url), 'utf8') // F-OO-100: People is its own file
    expect(overview).toContain("t('told.aboutChanges', { count: model.told.value.people })")
  })
})
