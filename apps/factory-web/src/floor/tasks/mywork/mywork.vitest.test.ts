import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import { dispatchSchema, helpSchema, messagesSchema, mineSchema } from './api'
import { designScreen } from './fixtures'
import { arranged, changedRows, emptyOf, excerptOf, helpHeld, helpPayload, leftOf, listChanged, listOf, materialTile, messagesOf, putLastIn, readPutLast, readSeen, signatureOf, unreadCount, withPutLast, withSeen, type DispatchEntry, type DispatchList, type PutLast, type StationHelp, type WorkMessage } from './model'
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

describe('the material flag (MES-026)', () => {
  const flagged = (state: 'IN_STOCK' | 'ON_THE_WAY' | 'MISSING' | 'NOT_KNOWN', date: string | null = null) => entry('m', 'READY', { material: { state, date } })
  const render = (extra: Partial<DispatchEntry>) => {
    const words = (locale: 'it' | 'en') => {
      const model = { ...designScreen.cases.find((item) => item.id === 'queue')!.model, list: { ...LIST, entries: [entry('a', 'READY', extra)] } }
      return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(MyWorkView, { model })))
    }
    return words
  }

  it('says on the card whose flag it is, the expected day when there is one, and nothing changes the status word', () => {
    const html = render({ material: { state: 'ON_THE_WAY', date: '2026-11-20' } })('en')
    expect(html).toContain('Material for this work order: on the way, expected')
    expect(html).toContain('Ready')
    expect(render({ material: { state: 'MISSING', date: null } })('it')).toContain('Materiale di quest&#x27;ordine: manca qualcosa')
  })

  it('reads the flag from the API and a fresher flag waits behind List changed', () => {
    const answer = { ...LIST, entries: [{ ...entry('a', 'READY'), sequence: { rule: 'WARN', state: 'CLEAR', words: null }, material: { state: 'MISSING', word: 'NOT_ENOUGH', label: 'Not enough', date: null, words: 'English', icon: 'alert-triangle', tone: 'danger' } }] }
    const parsed = dispatchSchema.parse(answer)
    expect(parsed.entries[0]!.material).toEqual({ state: 'MISSING', date: null })
    const before = { ...LIST, entries: [flagged('ON_THE_WAY', '2026-11-20')] }
    const after = { ...LIST, entries: [flagged('IN_STOCK')] }
    expect(listChanged(before, after)).toBe(true)
    expect(changedRows(before, after)).toBe(1)
    expect(listChanged(before, { ...before, asOf: '2026-11-17T09:00:00.000Z' })).toBe(false)
  })
})

describe('my list across stations (MES-022)', () => {
  const version = LIST.version
  const mine = (...entries: DispatchEntry[]) => ({ version, entries })

  it('is the list when it holds open work; else, or when it cannot be read, the station\'s queue', () => {
    expect(listOf(LIST, mine(entry('x', 'READY'))).person).toBe(true)
    expect(listOf(LIST, mine(entry('x', 'READY'))).entries.map((row) => row.slotId)).toEqual(['x'])
    expect(listOf(LIST, mine(entry('x', 'DONE')))).toBe(LIST)
    expect(listOf(LIST, mine())).toBe(LIST)
    expect(listOf(LIST, null)).toBe(LIST)
  })

  it('puts the running work on top as Next, then the first ready one; at a FREE site work still waiting can be next', () => {
    const list = { entries: [entry('a', 'READY'), entry('b', 'WAITING_FOR_PREVIOUS', { current: true })] }
    expect(arranged(list, []).next?.entry.slotId).toBe('b')
    expect(arranged({ entries: [entry('a', 'WAITING_FOR_PREVIOUS', { sequence: { rule: 'FREE', state: 'CLEAR', words: null } })] }, []).next?.entry.slotId).toBe('a')
    expect(arranged({ entries: [entry('a', 'WAITING_FOR_PREVIOUS', { sequence: { rule: 'WARN', state: 'WARN', words: null } })] }, []).next).toBeNull()
  })

  it('a person\'s list is never "no station", and a change of view waits behind List changed', () => {
    expect(emptyOf({ ...LIST, target: null, person: true, entries: [entry('a', 'READY')] })).toBeNull()
    expect(listChanged(LIST, listOf(LIST, mine(...LIST.entries)))).toBe(true)
  })

  it('reads the API\'s answer', () => {
    const parsed = mineSchema.parse({ site: LIST.site, asOf: LIST.asOf, day: '2026-11-17', version, current: null, next: null, entries: [{ ...entry('a', 'READY'), station: { id: 's', code: 'SEW-02', name: 'Sewing 2' }, bundles: 1, current: true }], words: null })
    expect(parsed.entries[0]).toMatchObject({ station: { code: 'SEW-02' }, bundles: 1, current: true })
  })
})

describe('the warehouse variant (B-W2b-308: the task inbox is My work at the warehouse)', () => {
  it('a tablet with no station here is a misplaced one: "not at a station" (a warehouse tablet opens the inbox: warehouse/entry.tsx)', () => {
    expect(emptyOf({ ...LIST, target: null, entries: [] })).toBe('noStation')
  })
})

describe('For your work: the messages on my work orders (COL-036)', () => {
  it('counts what was not opened on this tablet: hidden at zero', () => {
    expect(unreadCount([{ id: 'a' }, { id: 'b' }], [])).toBe(2)
    expect(unreadCount([{ id: 'a' }, { id: 'b' }], ['a'])).toBe(1)
    expect(unreadCount([{ id: 'a' }], ['a'])).toBe(0)
  })

  it('keeps the marks small and reads anything unreadable as none', () => {
    expect(withSeen(['a'], 'a')).toEqual(['a'])
    expect(withSeen(['a'], 'b')).toEqual(['a', 'b'])
    let many: string[] = []
    for (let index = 0; index < 305; index += 1) many = withSeen(many, `m${index}`)
    expect(many).toHaveLength(300)
    expect(many[0]).toBe('m5')
    expect(readSeen(JSON.stringify(['a', 1, 'b']))).toEqual(['a', 'b'])
    expect(readSeen('nonsense')).toEqual([])
    expect(readSeen(null)).toEqual([])
  })

  it('a row shows the first words on one line', () => {
    expect(excerptOf('one\n  two')).toBe('one two')
    expect(excerptOf('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('reads where a message comes from, never who', () => {
    const parsed = messagesSchema.parse({ asOf: LIST.asOf, messages: [{ id: 'm', workOrder: { id: 'w', number: 'WO-1' }, from: 'OFFICE', text: 'Hello', cut: false, at: LIST.asOf, authorName: 'Someone' }] })
    expect(Object.keys(parsed.messages[0]!).sort()).toEqual(['at', 'cut', 'from', 'id', 'text', 'workOrder'])
  })

  const chip = (id: string) => {
    const screen = designScreen.cases.find((item) => item.id === id)!
    return renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', FLOOR_NAMESPACES) }, createElement(MyWorkView, { model: screen.model })))
  }

  it('shows the chip with the count, and nothing at zero', () => {
    expect(chip('for-your-work')).toContain('For your work')
    expect(chip('for-your-work')).toContain('3 messages to read')
    expect(chip('queue')).not.toContain('For your work')
    expect(chip('messages-failed')).toContain('The messages could not be read')
  })

  it('one message says where from and when, never a person', () => {
    const html = chip('message')
    expect(html).toContain('From the office')
    expect(chip('message-cut')).toContain('The rest of this message is in the office')
    expect(chip('message-gone')).toContain('This message is no longer open')
  })
})

describe('Call for help: Material (design mywork.cant-find)', () => {
  const tile = (kind: string, open: { id: string } | null = null) => ({ type: { id: `t-${kind}`, code: kind, kind, labelIt: kind, labelEn: kind }, open })
  const help = (extra: Partial<StationHelp> = {}): StationHelp => ({ station: { id: 'st', code: 'SEW-01' }, tiles: [tile('MAINTENANCE'), tile('MATERIAL')], ...extra })

  it('calls the first active material type, in the office\'s order', () => {
    expect(materialTile(help())?.type.id).toBe('t-MATERIAL')
    expect(materialTile({ ...help(), tiles: [tile('MATERIAL'), { ...tile('MATERIAL'), type: { ...tile('MATERIAL').type, id: 'second' } }] })?.type.id).toBe('t-MATERIAL')
    expect(materialTile(null)).toBeNull()
  })

  it('goes in one tap; each reason it cannot go has its word', () => {
    expect(helpHeld({ help: help(), problem: null })).toBeNull()
    expect(helpHeld({ help: null, problem: 'reading' })).toBe('reading')
    expect(helpHeld({ help: null, problem: 'offline' })).toBe('offline')
    expect(helpHeld({ help: null, problem: null })).toBe('failed')
    expect(helpHeld({ help: help({ station: null }), problem: null })).toBe('noStation')
    expect(helpHeld({ help: help({ tiles: [tile('MAINTENANCE')] }), problem: null })).toBe('noType')
    expect(helpHeld({ help: help({ tiles: [tile('MATERIAL', { id: 'open' })] }), problem: null })).toBe('open')
    // Kept from earlier in the visit: offline, the call still goes through the queue.
    expect(helpHeld({ help: help(), problem: 'offline' })).toBeNull()
  })

  it('queues the type, the work order and the operation in words', () => {
    expect(helpPayload('type', entry('a', 'READY'))).toEqual({ typeId: 'type', workOrderId: 'wo-a', note: 'Op 20 Sew' })
  })

  it('reads the API\'s answer, strips what it does not need', () => {
    const parsed = helpSchema.parse({ subject: 'WORKER', station: { id: 'st', code: 'SEW-01', name: 'x', line: null }, tiles: [{ type: { id: 't', code: 'MATERIAL', kind: 'MATERIAL', labelIt: 'Materiale', labelEn: 'Material', labelI18n: {}, icon: 'package', colour: null, sortOrder: 1 }, open: { id: 'c', status: 'SENT' } }], open: [] })
    expect(parsed.tiles[0]).toEqual({ type: { id: 't', code: 'MATERIAL', kind: 'MATERIAL', labelIt: 'Materiale', labelEn: 'Material' }, open: { id: 'c' } })
  })
})

// ---- B-TH-278 (threads plan PL8, X-FLOOR-WO.notes; the wall agreed with the production lane 2026-11-17) ----------------------------
describe('B-TH-278 floor notes on the tablet: as written, on their own work order only, no read record, no money, no customer', () => {
  const screen = (id: string, locale: 'it' | 'en' = 'en') => {
    const item = designScreen.cases.find((entry) => entry.id === id)
    if (!item) throw new Error(`no design case ${id}`)
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(MyWorkView, { model: item.model })))
  }
  const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const note = (id: string, workOrderId: string, number: string): WorkMessage => ({ id, workOrder: { id: workOrderId, number }, from: 'OFFICE', text: `Note ${id}`, cut: false, at: LIST.asOf })

  it('a work order\'s card lists its own notes and no other work order\'s', () => {
    const notes = [note('a', 'wo-1', 'WO-1'), note('b', 'wo-2', 'WO-2'), note('c', 'wo-1', 'WO-1')]
    expect(messagesOf(notes, 'wo-1').map((row) => row.id)).toEqual(['a', 'c'])
    expect(messagesOf(notes, 'wo-3')).toEqual([])
    expect(messagesOf(notes, undefined).map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(textOf(screen('th-278-card'))).toContain('2 messages on this work order')
    expect(textOf(screen('th-278-card', 'it'))).toContain('2 messaggi su quest')
    const one = textOf(screen('th-278-one-work-order'))
    expect(one).toContain('Messages on WO-DEMO-0051')
    expect(one).toContain('Left sleeve first on this one')
    expect(one).toContain('Per questa commessa usate il filo rinforzato')
    // The other work orders' notes stay on their own cards.
    expect(one).not.toMatch(/WO-DEMO-0042|WO-DEMO-0047|Cuciture diverse|Le taglie 52/)
    // A card with no note of its own shows no button.
    expect(textOf(screen('entry'))).not.toMatch(/on this work order/)
  })

  it('shows a note as written: never translated, never changed, its lines kept; the screen\'s own words in the worker\'s language', () => {
    const written = 'Prima la manica sinistra, poi la destra.\n«Attenzione» al nastro: 3 mm — non di più.'
    const parsed = messagesSchema.parse({ asOf: LIST.asOf, messages: [{ ...note('m', 'wo-1', 'WO-1'), text: written }] })
    expect(parsed.messages[0]!.text).toBe(written)
    for (const locale of ['it', 'en'] as const) {
      const html = screen('th-278-as-written', locale)
      expect(html, locale).toContain('Left sleeve first on this one, please (demo).\nThe pattern changed on Monday.')
      expect(textOf(html), locale).toContain(locale === 'it' ? 'Come è stato scritto, senza traduzione.' : 'Shown as written, not translated.')
      expect(textOf(html), locale).toContain(locale === 'it' ? "Dall'ufficio" : 'From the office')
    }
  })

  it('keeps no read record: an unopened note says New, an opened one says nothing (no Read, no Seen), and nothing goes back', () => {
    for (const locale of ['it', 'en'] as const) {
      const text = textOf(screen('th-278-one-work-order', locale))
      expect(text, locale).toContain(locale === 'it' ? 'Nuovo' : 'New')
      expect(text, locale).not.toMatch(/\bRead\b|\bLetto\b|\bLetti\b|\bSeen\b|\bVisto\b|Visualizzat|\bopened by\b|\baperto da\b/i)
      // The catalogue holds no word for it any more.
      expect(JSON.stringify(messagesFor(locale, ['floor-mywork'])), locale).not.toMatch(/"read":|"Letto"|"Read"/)
    }
    // The tablet keeps the ids it opened, never a person or a time; anything else in its storage is dropped.
    expect(readSeen(JSON.stringify(['m1', { id: 'm2', by: 'Someone', at: LIST.asOf }]))).toEqual(['m1'])
    // The messages are only ever read (a GET through floorRead): no route, queue kind or write tells the office a note was opened.
    const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    const api = read('./api.ts')
    expect(api).toContain("floorRead(api, '/production/dispatch/mine/messages'")
    expect(api).not.toMatch(/messages[^\n]*(floorWrite|enqueue|method:\s*'(POST|PUT|PATCH|DELETE)')/)
    const screenCode = read('./MyWork.tsx')
    const opened = screenCode.slice(screenCode.indexOf('const openMessage'), screenCode.indexOf('const onAction'))
    expect(opened).toContain('saveSeen')
    expect(opened).not.toMatch(/api\.|queue\.|fetch\(|enqueue/)
  })

  it('never shows money, a customer or who wrote it: the read keeps the work order, where from, the words and the time only', () => {
    const parsed = messagesSchema.parse({
      asOf: LIST.asOf,
      messages: [{ ...note('m', 'wo-1', 'WO-1'), amount: { value: 15800, currency: 'EUR' }, customer: { code: 'C-ALPHA', name: 'Brand Alpha' }, partyName: 'Brand Alpha', authorName: 'Someone' }],
    })
    expect(Object.keys(parsed.messages[0]!).sort()).toEqual(['at', 'cut', 'from', 'id', 'text', 'workOrder'])
    expect(Object.keys(parsed.messages[0]!.workOrder).sort()).toEqual(['id', 'number'])
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['th-278-card', 'th-278-one-work-order', 'th-278-as-written']) {
        const text = textOf(screen(id, locale))
        expect(text, `${id} (${locale})`).not.toMatch(/€|\bEUR\b|Brand Alpha|Brand Beta|C-ALPHA/)
      }
      // The screen's own words about notes name no money, pay or customer.
      const words = messagesFor(locale, ['floor-mywork'])['floor-mywork'] as Record<string, unknown>
      const own = JSON.stringify([words.messages, words.message])
      expect(own, locale).not.toMatch(/€|prezz|price|cost|paga|\bpay|stipend|salar|client|customer|brand|marchio/i)
    }
  })
})
// ---- end B-TH-278
