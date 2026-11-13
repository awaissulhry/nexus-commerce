import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KEPT_CODES, MOVE_WHYS } from '@nexus/factory-domain/planning/schedule-depth/forward'
import { WHAT_IF_CONFLICTS } from '@nexus/factory-domain/planning/schedule-depth/whatif'
import { SKIP_CODES } from '@nexus/factory-domain/planning/schedule/refusals'
import { CHANGE_KINDS, UNDO_HOLDS } from '@nexus/factory-domain/planning/schedule-log/changes'
import { FLOOR_STATES } from '@nexus/factory-domain/planning/schedule-log/floor-status'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { BOARD, CHANGES, designScreen as boardScreen, ME, SLOTS, WHAT_IF, WORK_ORDERS } from '../fixtures'
import { NAMESPACE, planMove, refusalOf, refusalWords, DEFAULT_CONTROLS, type Words } from '../model'
import { getChanges, getDaySheetPdf, pinSlot, rescheduleBacklog, setWhatIfMoves, undoChange } from './api'
import { designScreen as sheetScreen } from './day-sheet/fixtures'
import {
  changeLabel,
  decorateCards,
  depthProblemRows,
  DEPTH_NAMESPACE,
  exportQuery,
  floorMark,
  materialAsk,
  myLatestUndoable,
  sheetIds,
  undoHeldWords,
  whatIfBoard,
  whatIfCardOf,
  whatIfInputs,
  withTriedMove,
  workshopDropHeld,
  workshopDropOf,
  type DepthWords,
} from './model'
import { designScreen as versionScreen } from './version/fixtures'

/**
 * Planning › Planning board in depth (SCR-122, SCR-407, SCR-408; B-W2b-337 on B-W2b-312, B-W2b-329 and B-W2b-321): the floor's
 * state and pins on the bars, a workshop drop that opens Move to a subcontractor (held while the approvals are read or in
 * what-if), the what-if board and the WHOLE list of moves it sends, the change log in words with why an undo is held, the
 * problems' three W2b kinds with their quick fixes, the material check asked only for an earlier start, the W2b refusals in
 * our words, the calls as the API takes them, and every new design case in Italian and English with no key on screen.
 */

const dwords = (locale: 'it' | 'en' = 'en'): DepthWords => ({ t: createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!), locale, timeZone: 'Europe/Rome' })
const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale, timeZone: 'Europe/Rome', td: dwords(locale).t })
const [WO101, WO102, WO103, , WO105] = WORK_ORDERS
const WORKSHOP_LANE = `WORKSHOP:${BOARD.lanes[4]!.id}`

describe('the bars in depth: the floor, pins, gates, a what-if try', () => {
  it('says the four floor states in words with their tone; running without a bundle worked is "under way"', () => {
    const w = dwords()
    expect(floorMark(SLOTS[0]!.floor, w)).toEqual({ label: 'Under way · 90/120 (75%)', tone: 'info' })
    expect(floorMark(SLOTS[1]!.floor, w)).toEqual({ label: 'Running · 30/120 (25%)', tone: 'info' })
    expect(floorMark(SLOTS[3]!.floor, w)).toEqual({ label: 'Paused · 10/80 (13%)', tone: 'warning' })
    expect(floorMark(SLOTS[2]!.floor, w)).toEqual({ label: 'Not started', tone: 'neutral' })
    expect(floorMark(SLOTS[5]!.floor, w)).toEqual({ label: 'Done', tone: 'success' })
    expect(floorMark(null, w)).toBeNull()
  })

  it('puts the pin, the floor state first, a gate not passed and a what-if try on the cards', () => {
    const cards = decorateCards(
      [{ id: SLOTS[4]!.id, label: 'WO-0103', minutes: 1, laneId: 'x', bucketId: 'y', marks: [{ label: 'Rush', tone: 'info' }] }, { id: SLOTS[1]!.id, label: 'WO-0101', minutes: 1, laneId: 'x', bucketId: 'y' }],
      BOARD,
      { gates: new Set([WO103!.id]), tried: new Set([SLOTS[1]!.id]) },
      dwords(),
    )
    expect(cards[0]!.pinned).toBe(true)
    expect(cards[0]!.marks!.map((mark) => mark.label)).toEqual(['Not started', 'Rush', 'Gate not passed'])
    expect(cards[1]!.pinned).toBe(false)
    expect(cards[1]!.marks!.map((mark) => mark.label)).toEqual(['Running · 30/120 (25%)', 'What-if'])
  })
})

describe('workshops as lanes', () => {
  const workshops = { status: 'ready' as const, value: { site: BOARD.site, today: BOARD.today, asOf: BOARD.asOf, window: { from: BOARD.from, to: BOARD.to }, workshops: [{ id: BOARD.lanes[4]!.id, code: 'LAB-B', name: 'Laboratorio Beta', location: { id: 'loc', code: 'SUB-BETA' }, active: true, supplierProblem: null, durc: { checked: true, state: 'EXPIRED' as const, expiresOn: '2026-11-05' }, capacity: [], qualifications: [] }], workOrders: [] } }
  const aw = { t: createTranslator('en', messagesFor('en', ['planning-allocation-depth'])['planning-allocation-depth']!), locale: 'en' as const }

  it('a bar dropped on a workshop opens Move to a subcontractor at that day instead of moving', () => {
    const plan = planMove(BOARD, DEFAULT_CONTROLS, { cardId: SLOTS[1]!.id, from: { laneId: `LINE:${BOARD.lanes[0]!.id}`, bucketId: '2026-11-17' }, to: { laneId: WORKSHOP_LANE, bucketId: '2026-11-18' } }, new Date('2026-11-16T08:42:00.000Z'))
    expect(workshopDropOf(BOARD, plan)).toEqual({ slotId: SLOTS[1]!.id, workOrderId: WO101!.id, operationId: WO101!.operations[1]!.id, partyId: BOARD.lanes[4]!.id, start: '2026-11-18' })
    // A part of an order already at the workshop moves in time on its lane.
    expect(workshopDropOf(BOARD, planMove(BOARD, DEFAULT_CONTROLS, { cardId: SLOTS[5]!.id, from: { laneId: WORKSHOP_LANE, bucketId: '2026-11-17' }, to: { laneId: WORKSHOP_LANE, bucketId: '2026-11-18' } }, new Date('2026-11-16T08:42:00.000Z')))).toBeNull()
  })

  it('holds a drop from another lane while the approvals are read, for a workshop that takes no work, and in what-if', () => {
    const card = { id: SLOTS[1]!.id, laneId: `LINE:${BOARD.lanes[0]!.id}` }
    const to = { laneId: WORKSHOP_LANE, bucketId: '2026-11-18' }
    expect(workshopDropHeld(BOARD, card, to, { status: 'loading' }, false, 'ST1', dwords(), aw)).toBe("Checking the workshops' approvals…")
    expect(workshopDropHeld(BOARD, card, to, workshops, false, 'ST1', dwords(), aw)).toMatch(/DURC/)
    expect(workshopDropHeld(BOARD, card, to, workshops, true, 'ST1', dwords(), aw)).toMatch(/not tried in what-if/)
    expect(workshopDropHeld(BOARD, { id: SLOTS[5]!.id, laneId: WORKSHOP_LANE }, to, workshops, false, 'ST1', dwords(), aw)).toBeNull()
  })
})

describe('what-if: the board with the tried moves, and the whole list it sends', () => {
  it('draws a moved bar at its new place, a placed operation as a bar of its own, and takes it out of the tray', () => {
    const tried = whatIfBoard(BOARD, WHAT_IF)
    const moved = tried.slots.find((slot) => slot.id === SLOTS[3]!.id)!
    expect(moved.lane).toEqual({ kind: 'LINE', id: BOARD.lanes[0]!.id })
    expect(moved.startAt).toBe(WHAT_IF.moves[0]!.to!.startAt)
    const placed = tried.slots.find((slot) => slot.id === whatIfCardOf(WO105!.id, WO105!.operations[0]!.id))!
    expect(placed.lane).toEqual({ kind: 'LINE', id: BOARD.lanes[1]!.id })
    expect(tried.tray.some((entry) => entry.workOrderId === WO105!.id)).toBe(false)
    expect(BOARD.slots.find((slot) => slot.id === SLOTS[3]!.id)!.lane.id).toBe(BOARD.lanes[1]!.id)
  })

  it('replaces a bar tried again, places again a placed one, and drops a placed one sent back to the tray', () => {
    const tried = whatIfBoard(BOARD, WHAT_IF)
    const inputs = whatIfInputs(WHAT_IF)
    expect(inputs[0]).toMatchObject({ kind: 'MOVE', slotId: SLOTS[3]!.id, endAt: WHAT_IF.moves[0]!.to!.endAt })
    const again = withTriedMove(inputs, { kind: 'move', slotId: SLOTS[3]!.id, version: 2, workOrderId: WO102!.id, startAt: '2026-11-20T07:00:00.000Z' }, tried)!
    expect(again).toHaveLength(2)
    expect(again[0]).toEqual({ kind: 'MOVE', slotId: SLOTS[3]!.id, lane: { kind: 'LINE', id: BOARD.lanes[0]!.id }, startAt: '2026-11-20T07:00:00.000Z' })
    const placedId = whatIfCardOf(WO105!.id, WO105!.operations[0]!.id)
    const moved = withTriedMove(inputs, { kind: 'move', slotId: placedId, version: 0, workOrderId: WO105!.id, startAt: '2026-11-18T07:00:00.000Z' }, tried)!
    expect(moved[1]).toMatchObject({ kind: 'PLACE', workOrderId: WO105!.id, startAt: '2026-11-18T07:00:00.000Z' })
    expect(withTriedMove(inputs, { kind: 'remove', slotId: placedId, version: 0, workOrderId: WO105!.id }, tried)).toHaveLength(1)
    expect(withTriedMove(inputs, { kind: 'remove', slotId: SLOTS[0]!.id, version: 2, workOrderId: WO101!.id }, tried)!.at(-1)).toEqual({ kind: 'REMOVE', slotId: SLOTS[0]!.id })
  })
})

describe('the change log in words', () => {
  it('says who, what and from → to; why Undo is held; ⌘Z takes my newest undoable change', () => {
    const w = dwords()
    const [mine, pin, moved, undone, older] = CHANGES.entries
    expect(changeLabel(mine!, w)).toBe('Moved Op 20 Cucito of WO-0101')
    expect(changeLabel(pin!, w)).toBe('Pinned Op 20 Cucito of WO-0103')
    expect(changeLabel(undone!, w)).toBe('Undid the move of Op 30 Controllo finale of WO-0101')
    expect(undoHeldWords(mine!, w)).toBeNull()
    expect(undoHeldWords(moved!, w)).toMatch(/only the latest change of a bar is undone/)
    expect(undoHeldWords(older!, w)).toMatch(/^Already undone by Anna Esempio/)
    expect(undoHeldWords(undone!, w)).toBe('A publish or an undo is not undone.')
    expect(myLatestUndoable(CHANGES.entries, ME)?.id).toBe(mine!.id)
    expect(myLatestUndoable(CHANGES.entries, null)).toBeNull()
    expect(changeLabel(mine!, dwords('it'))).toBe('Op 20 Cucito di WO-0101 spostata')
  })

  // B-W2b-F39: the record keeps a change whose operation left its work order, by its copy, and never undoes it.
  it('names an operation that left its work order by the record\'s copy, and says why its change is not undone', () => {
    const w = dwords()
    const [mine] = CHANGES.entries
    const gone = { ...mine!, kind: 'REMOVE' as const, onBoard: false, operation: { id: mine!.operation!.id, seq: 25, code: null, name: 'Cucito', onWorkOrder: false }, undo: { may: false, code: 'OPERATION_GONE' as const } }
    expect(changeLabel(gone, w)).toBe('Sent Op 25 Cucito of WO-0101 (no longer on the work order) back to the tray')
    expect(changeLabel(gone, dwords('it'))).toContain("Op 25 Cucito di WO-0101 (non più nell'ordine di lavoro)")
    expect(undoHeldWords(gone, w)).toBe('Its operation is no longer on the work order: the record keeps this change, but it is not undone.')
    const unnamed = { ...gone, operation: { ...gone.operation, seq: null, name: null } }
    expect(changeLabel(unnamed, w)).toBe('Sent an operation of WO-0101 (no longer on the work order) back to the tray')
    const refused = new ApiError('conflict', 409, 'conflict', '…', null, [{ path: 'refusal/OPERATION_GONE', message: '' }])
    expect(refusalOf(refused)).toEqual({ code: 'OPERATION_GONE' })
    expect(refusalWords({ code: 'OPERATION_GONE' }, words('en'))).toBe('Its operation is no longer on the work order: this change is kept, not undone.')
  })
})

describe('the problems list: three W2b kinds and their quick fixes', () => {
  it('says each kind from its facts; snap for a material day, reschedule for the past, none for a gate', () => {
    const rows = depthProblemRows(BOARD, dwords())
    expect(rows.map((row) => [row.kind, row.fix])).toEqual([
      ['IN_THE_PAST', 'backlog'],
      ['MATERIAL_NOT_IN_TIME', 'snap'],
      ['GATE_NOT_PASSED', null],
    ])
    expect(rows[1]!.words).toBe('WO-0102 starts on the board before its material: the earliest start with material is Thu 19 Nov.')
    expect(rows[0]!.words).toMatch(/^Op 10 Taglio of WO-0101 on Taglio was planned to end by Mon 16 Nov/)
  })
})

describe('the material check of a drop', () => {
  it('asks only for an earlier start of an order waiting on material, and for a tray drop of one', () => {
    const slot = SLOTS[3]!
    expect(materialAsk(BOARD, { kind: 'move', slotId: slot.id, version: 2, workOrderId: WO102!.id, startAt: '2026-11-17T07:00:00.000Z' })).toEqual({ workOrderId: WO102!.id, startAt: '2026-11-17T07:00:00.000Z', laneKind: 'LINE', laneId: BOARD.lanes[1]!.id })
    expect(materialAsk(BOARD, { kind: 'move', slotId: slot.id, version: 2, workOrderId: WO102!.id, startAt: '2026-11-20T07:00:00.000Z' })).toBeNull()
    expect(materialAsk(BOARD, { kind: 'move', slotId: SLOTS[1]!.id, version: 2, workOrderId: WO101!.id, startAt: '2026-11-16T07:00:00.000Z' })).toBeNull()
    expect(materialAsk(BOARD, { kind: 'place', workOrderId: WO105!.id, operationId: 'op', lane: { kind: 'LINE', id: 'l2' }, startAt: '2026-11-17T07:00:00.000Z' })).toBeNull()
  })
})

describe('day sheets and export addresses; the W2b refusals', () => {
  it('passes the picked lines and work centres apart; the export reads the board\'s window or a version', () => {
    expect(sheetIds([`LINE:a`, `WORK_CENTRE:b`, 'LINE:c', 'nope'])).toEqual({ lineIds: ['a', 'c'], workCentreIds: ['b'] })
    expect(exportQuery({ siteId: 's1', from: '2026-11-16', to: '2026-11-29' })).toBe('site=s1&from=2026-11-16&to=2026-11-29')
    expect(exportQuery({ versionId: 'v3' })).toBe('version=v3')
  })

  it('reads refusal/<CODE> of the W2b writes and says it in our words in both languages', () => {
    const pinned = new ApiError('conflict', 409, 'conflict', 'Op 20 … is pinned by Marta at …: unpin it to move it.', null, [{ path: 'refusal/PINNED', message: '' }])
    expect(refusalOf(pinned)).toEqual({ code: 'PINNED' })
    expect(refusalWords({ code: 'PINNED' }, words())).toBe('Not saved: the bar is pinned. Unpin it to move it.')
    expect(refusalWords({ code: 'CHANGED_SINCE' }, words('it'))).toBe('La barra è cambiata nel frattempo: si annulla solo la sua ultima modifica.')
    const changed = new ApiError('conflict', 409, 'conflict', '…', null, [{ path: 'refusal/CHANGED_SINCE', message: '' }])
    expect(refusalOf(changed)).toEqual({ code: 'CHANGED_SINCE' })
    // Without the depth words a W2b refusal says the generic sentence, never a key.
    expect(refusalWords({ code: 'PINNED' }, { ...words(), td: undefined })).not.toMatch(/refusal\./)
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function mockApi(answers: Array<{ status: number; body: unknown; pdf?: boolean }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    if (next.pdf) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } })
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('the calls as the API takes them', () => {
  it('pins with the slot version, tries the WHOLE list of moves with the scenario version, undoes a change, each with its own key', async () => {
    const scenario = { site: BOARD.site, asOf: BOARD.asOf, scenario: WHAT_IF, replayed: false }
    const entry = CHANGES.entries[0]!
    const { api, calls } = mockApi([
      { status: 200, body: { slot: { id: SLOTS[1]!.id, version: 3, pinned: true }, planVersion: 13, replayed: false } },
      { status: 200, body: scenario },
      { status: 200, body: { undo: { ...entry, kind: 'UNDO' }, undone: entry, slot: null, planVersion: 14, over: [], replayed: false } },
    ])
    await pinSlot(api, SLOTS[1]!.id, { version: 2, pinned: true })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/planning/schedule/slots/${SLOTS[1]!.id}/pin`, body: { version: 2, pinned: true } })
    await setWhatIfMoves(api, WHAT_IF.id, { version: 3, moves: whatIfInputs(WHAT_IF) })
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `/api/planning/schedule/what-ifs/${WHAT_IF.id}/moves`, body: { version: 3 } })
    expect((calls[1]!.body as { moves: unknown[] }).moves).toHaveLength(2)
    await undoChange(api, entry.id, 'Sabato')
    expect(calls[2]).toMatchObject({ method: 'POST', url: `/api/planning/schedule/changes/${entry.id}/undo`, body: { overloadReason: 'Sabato' } })
    expect(new Set(calls.map((call) => call.headers.get('idempotency-key'))).size).toBe(3)
  })

  it('reads the log with its filters, previews the backlog without a key, opens the day sheets as a PDF', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: CHANGES },
      { status: 200, body: { planVersion: 12, applied: false, mode: 'BACKLOG', moves: [], orders: [], kept: [], skipped: [], overbooked: 0, words: '', replayed: false } },
      { status: 200, body: null, pdf: true },
    ])
    await getChanges(api, { siteId: 's1', since: 'ALL', kinds: ['MOVE', 'PIN', 'UNPIN'], changedById: 'u1' })
    expect(calls[0]!.url).toBe('/api/planning/schedule/changes?siteId=s1&since=ALL&kinds=MOVE%2CPIN%2CUNPIN&changedById=u1')
    await rescheduleBacklog(api, { siteId: 's1', apply: false })
    expect(calls[1]!.headers.get('idempotency-key')).toBeNull()
    const bytes = await getDaySheetPdf(api, { siteId: 's1', date: '2026-11-17', lineIds: ['l1'], workCentreIds: [], plan: 'WORKING', language: 'it' })
    expect(bytes.byteLength).toBe(4)
    expect(calls[2]!.url).toBe('/api/planning/schedule/day-sheets?siteId=s1&date=2026-11-17&lineIds=l1&plan=WORKING&language=it')
  })
})

// ---- every design case, both languages, no key on screen ----------------------------------------------------------------------

const LEFT_KEY = /\b(?:band|plan|more|floor|mark|held|whatif|status|log|problems|problem|material|subcontract|print|sheet|backlog|export|laneKind|version|bar|legend|keys|versions|notice|refusal|error|dialog|al|lists|tools)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [boardScreen, versionScreen, sheetScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic depth words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = dwords(locale).t
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const state of FLOOR_STATES) {
        has(`floor.${state}`)
        has(`floor.sentence.${state}`)
      }
      for (const kind of CHANGE_KINDS) has(`log.undid.${kind}`)
      for (const kind of ['PLACE', 'MOVE', 'REMOVE', 'PIN', 'UNPIN', 'PUBLISH', 'UNDO']) has(`log.kind.${kind}`)
      for (const hold of UNDO_HOLDS) has(`log.undoHeld.${hold}`)
      for (const code of WHAT_IF_CONFLICTS) has(`whatif.conflict.${code}`)
      for (const why of MOVE_WHYS) has(`backlog.why.${why}`)
      for (const code of KEPT_CODES) has(`backlog.kept.${code}`)
      for (const code of SKIP_CODES) has(`backlog.skipped.${code}`)
      for (const code of ['PINNED', 'ALREADY_PINNED', 'NOT_PINNED', 'NOTHING_TO_PIN', 'NOTHING_TO_RESCHEDULE', 'WHAT_IF_CONFLICTS', 'WHAT_IF_CLOSED', 'NOT_UNDOABLE', 'ALREADY_UNDONE', 'CHANGED_SINCE', /* B-W2b-F39 */ 'OPERATION_GONE']) has(`refusal.${code}`)
      for (const status of ['LATE', 'AT_RISK', 'ON_TIME', 'NO_DUE_DATE', 'DONE']) has(`status.${status}`)
      for (const floor of ['CURRENT', 'UPCOMING', 'REPLACED']) has(`version.floor.${floor}`)
      for (const problem of ['forbidden', 'offline', 'failed', 'noSite']) has(`error.${problem}`)
      for (const plural of ['whatif.apply', 'whatif.orders', 'backlog.apply', 'notice.backlog', 'print.rows', 'version.added']) {
        has(plural, 1)
        has(plural, 2)
      }
    }
  })
})
