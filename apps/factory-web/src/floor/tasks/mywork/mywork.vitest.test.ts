import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import { dispatchSchema } from './api'
import { designScreen } from './fixtures'
import { arranged, emptyOf, leftOf, listChanged, putLastIn, readPutLast, signatureOf, withPutLast, type DispatchEntry, type DispatchList, type PutLast } from './model'
import { MyWorkView } from './view/MyWorkView'

/**
 * SCR-089 My work (B-W2a-74): the next task and the queue from the published plan, work put last on this tablet, why a
 * list is empty, when a fresher list waits behind "List changed · Show", and that the screen names nobody.
 */

const entry = (slotId: string, state: DispatchEntry['state'], extra: Partial<DispatchEntry> = {}): DispatchEntry => ({
  slotId,
  workOrder: { id: `wo-${slotId}`, number: `WO-${slotId}`, status: 'IN_PROGRESS', priority: 0, rush: false, dueDate: '2026-11-20', style: { code: 'S', name: 'Style' }, holdReason: null },
  operation: { id: `op-${slotId}`, seq: 20, code: 'SEW', name: 'Sew' },
  previous: { seq: 10, code: 'CUT', name: 'Cut' },
  startAt: '2026-11-17T08:00:00.000Z',
  endAt: '2026-11-17T09:00:00.000Z',
  garments: 10,
  minutes: '50.0',
  state,
  words: '',
  arrived: 0,
  waiting: 0,
  done: state === 'DONE' ? 10 : 0,
  ...extra,
})

const LIST: DispatchList = {
  site: { id: 's', code: 'A1', name: 'Plant', timeZone: 'Europe/Rome' },
  target: { kind: 'STATION', id: 'st', code: 'SEW-01', name: 'SEW-01', line: null, workCentre: null },
  asOf: '2026-11-17T08:00:00.000Z',
  version: { id: 'v1', number: 1, coversFrom: '2026-11-16', coversTo: '2026-11-20', effectiveFrom: '2026-11-16T05:00:00.000Z', publishedAt: '2026-11-13T10:00:00.000Z' },
  upcoming: null,
  next: null,
  entries: [entry('a', 'WAITING_FOR_PREVIOUS'), entry('b', 'READY'), entry('c', 'READY'), entry('d', 'DONE'), entry('e', 'ON_HOLD')],
  words: null,
}

const mark = (slotId: string, code = 'MATERIAL_WAIT'): PutLast => ({ slotId, code, labelIt: 'Attesa materiale', labelEn: 'Waiting for material', at: '2026-11-17T08:05:00.000Z' })

describe('the next task and the queue', () => {
  it('Next is the first ready task in the list\'s order; the rest follow; finished tasks leave the queue', () => {
    const view = arranged(LIST, [])
    expect(view.next?.entry.slotId).toBe('b')
    expect(view.queue.map((row) => row.entry.slotId)).toEqual(['a', 'c', 'e'])
    expect(view.done).toBe(1)
  })

  it('work put last goes to the end in the order it was put last; it comes back as Next only when nothing else is ready', () => {
    const one = arranged(LIST, [mark('b')])
    expect(one.next?.entry.slotId).toBe('c')
    expect(one.queue.map((row) => row.entry.slotId)).toEqual(['a', 'e', 'b'])
    expect(one.queue.at(-1)?.putLast?.code).toBe('MATERIAL_WAIT')
    const both = arranged(LIST, [mark('c'), mark('b')])
    expect(both.next?.entry.slotId).toBe('c')
    expect(both.queue.map((row) => row.entry.slotId)).toEqual(['a', 'e', 'b'])
  })

  it('putting a task last again moves it to the very end with the new reason; marks of tasks gone drop off', () => {
    const marks = withPutLast(withPutLast([mark('b')], mark('c')), mark('b', 'BREAK'))
    expect(marks.map((item) => [item.slotId, item.code])).toEqual([
      ['c', 'MATERIAL_WAIT'],
      ['b', 'BREAK'],
    ])
    expect(putLastIn(LIST, [mark('d'), mark('zz'), mark('b')]).map((item) => item.slotId)).toEqual(['b'])
  })

  it('reads the tablet\'s marks back and drops anything unreadable', () => {
    expect(readPutLast(JSON.stringify([mark('b'), { slotId: 1 }, 'x']))).toEqual([mark('b')])
    expect(readPutLast('not json')).toEqual([])
    expect(readPutLast(null)).toEqual([])
  })

  it('counts the garments left at the operation, never below zero', () => {
    expect(leftOf({ garments: 10, done: 3 })).toBe(7)
    expect(leftOf({ garments: 10, done: 12 })).toBe(0)
  })
})

describe('why a list is empty, and when a fresher one waits', () => {
  it('names each empty case in order: no station, nothing published, the first plan later, nothing queued, all done', () => {
    expect(emptyOf({ ...LIST, target: null })).toBe('noStation')
    expect(emptyOf({ ...LIST, version: null, upcoming: null })).toBe('nothingPublished')
    expect(emptyOf({ ...LIST, version: null, upcoming: { id: 'v2', number: 2, effectiveFrom: '2026-11-18T05:00:00.000Z' } })).toBe('firstUpcoming')
    expect(emptyOf({ ...LIST, entries: [] })).toBe('nothingQueued')
    expect(emptyOf({ ...LIST, entries: [entry('d', 'DONE')] })).toBe('allDone')
    expect(emptyOf(LIST)).toBeNull()
  })

  it('a list that moved (a new plan, a state, a count, a hold) waits behind "List changed · Show"; the same list does not', () => {
    expect(listChanged(null, LIST)).toBe(false)
    expect(listChanged(LIST, { ...LIST, asOf: '2026-11-17T09:00:00.000Z' })).toBe(false)
    expect(listChanged(LIST, { ...LIST, entries: LIST.entries.map((row) => (row.slotId === 'a' ? { ...row, state: 'READY' as const, waiting: 4 } : row)) })).toBe(true)
    expect(listChanged(LIST, { ...LIST, version: { ...LIST.version!, id: 'v2', number: 2 } })).toBe(true)
    expect(signatureOf(LIST)).toBe(signatureOf({ ...LIST }))
  })
})

describe('the read and the screen', () => {
  it('takes the dispatch answer as the API gives it (with the operation before), and refuses a broken one', () => {
    expect(dispatchSchema.safeParse({ ...LIST, next: LIST.entries[1] }).success).toBe(true)
    expect(dispatchSchema.safeParse({ ...LIST, entries: [{ ...LIST.entries[0], state: 'SOMETHING' }] }).success).toBe(false)
  })

  it('names nobody and shows no money or pace in any case, in either language (Statuto art. 4, F2)', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(MyWorkView, { model: item.model })))
        const text = html.replace(/<[^>]+>/g, ' ')
        // The operator chip is the frame's (the person signed in on this tablet); the queue itself never names anyone.
        expect(text.replace(/Ada Demo/g, ''), `${item.id} (${locale})`).not.toMatch(/Bea Esempio|Demo Worker|worker/i)
        expect(text, item.id).not.toMatch(/€|minut|\bmin\b|efficien/i)
      }
    }
  })
})
