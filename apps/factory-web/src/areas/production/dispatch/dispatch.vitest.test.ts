import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { createScopedTranslator, messagesFor } from '../../../lib/i18n/messages'
import { boardSchema, moveBodySchema, pickerSchema, type DispatchBoard, type DispatchCard, type LaneOperator } from './api'
import { C142, C143, DISPATCH_BOARD as BOARD, DRAFT, NOT1, PICKER } from './fixtures'
import {
  absentOf,
  addressOf,
  addressText,
  assignHeld,
  boardHeld,
  boardIdsOf,
  checkPhrase,
  dispatchCanOf,
  DISPATCH_NAMESPACE,
  drawBoard,
  dropHeldOf,
  laneStep,
  loadPhrase,
  moveBodyOf,
  moveBundlesBody,
  moveBundlesHeld,
  movedCard,
  moveTargets,
  namedOnCard,
  needsReason,
  operatorWords,
  pickerLabel,
  plannedWhy,
  presencePhrase,
  printAddressOf,
  printHrefOf,
  refusalOf,
  stationLabel,
  stationOf,
  touchesBoard,
} from './model'

const t = createScopedTranslator('en', messagesFor('en', [DISPATCH_NAMESPACE]), DISPATCH_NAMESPACE)
const it_ = createScopedTranslator('it', messagesFor('it', [DISPATCH_NAMESPACE]), DISPATCH_NAMESPACE)
const words = { t, locale: 'en' as const, timeZone: 'Europe/Rome' }
const say = (phrase: { key: string; params?: Readonly<Record<string, string | number>> } | null) => (phrase ? t(phrase.key, phrase.params) : null)
const refused = (code: string) => new ApiError('conflict', 409, 'conflict', 'refused', 'req', [{ path: `refusal/${code}`, message: 'x' }])
const placed = (card: DispatchCard): DispatchCard => BOARD.lines.flatMap((line) => line.stations).flatMap((row) => row.cards).find((entry) => entry.id === card.id)!

describe('Dispatch: the address and who may do what', () => {
  it('keeps the site, the line and a well-made day', () => {
    const address = addressOf(new URLSearchParams('site=a&line=b&date=2026-11-16'))
    expect(address).toEqual({ site: 'a', line: 'b', date: '2026-11-16' })
    expect(addressOf(new URLSearchParams('date=monday')).date).toBeNull()
    expect(addressText(address)).toBe('?site=a&line=b&date=2026-11-16')
    expect(addressText({ site: null, line: null, date: null })).toBe('')
  })

  it('the print window names each line, or one station, with the day', () => {
    const href = printHrefOf('/w/X', { lines: ['a', 'b'] }, '2026-11-16')
    expect(href).toBe('/w/X/production/dispatch/print?line=a&line=b&date=2026-11-16')
    expect(printAddressOf(new URL(href, 'http://x').searchParams)).toEqual({ lines: ['a', 'b'], station: null, date: '2026-11-16' })
    expect(printAddressOf(new URL(printHrefOf('/w/X', { station: 's' }, '2026-11-16'), 'http://x').searchParams).station).toBe('s')
  })

  it('reads the three abilities from the session', () => {
    expect(dispatchCanOf(['production.dispatch.view'])).toEqual({ view: true, manage: false, workOrders: false })
    expect(dispatchCanOf(['production.dispatch.view', 'production.dispatch.manage', 'workorders.view']).manage).toBe(true)
  })
})

describe('Dispatch: load against minutes', () => {
  const [one] = BOARD.lines
  it('says the design\'s sentence from the figures, over and spare (hand-checked)', () => {
    expect(say(loadPhrase(one!.load, 'en'))).toBe('Queued 2,410 min · available 2,160 min · 250 min over')
    expect(say(loadPhrase({ ...one!.load, queuedMinutes: 100, overMinutes: 0, spareMinutes: 2060 }, 'en'))).toBe('Queued 100 min · available 2,160 min · 2,060 min spare')
  })

  it('names why the minutes come from the planned people, in the API\'s order', () => {
    const load = { source: 'PLANNED' as const, people: 8 }
    expect(plannedWhy({ attendance: { open: false }, day: 'a', today: 'b' }, load)).toBe('ATTENDANCE_OFF')
    expect(plannedWhy({ attendance: { open: true }, day: 'a', today: 'b' }, load)).toBe('NOT_TODAY')
    expect(plannedWhy({ attendance: { open: true }, day: 'a', today: 'a' }, { source: 'PLANNED', people: null })).toBe('TOO_FEW')
    expect(plannedWhy({ attendance: { open: true }, day: 'a', today: 'a' }, load)).toBe('BEFORE_THE_SHIFT')
    expect(plannedWhy({ attendance: { open: true }, day: 'a', today: 'a' }, { source: 'CLOCKED_IN', people: 7 })).toBeNull()
  })

  it('shows absent only today, with the gate open, once the group is big enough', () => {
    const on = { attendance: { open: true }, day: 'a', today: 'a' }
    expect(absentOf(on, { absent: 2 })).toBe(2)
    expect(absentOf(on, { absent: null })).toBeNull()
    expect(absentOf({ ...on, attendance: { open: false } }, { absent: 0 })).toBeNull()
    expect(absentOf({ ...on, day: 'b' }, { absent: 2 })).toBeNull()
  })
})

describe('Dispatch: the DS board', () => {
  it('draws stations as lanes, Not assigned as the tray, and books nothing for a draft', () => {
    const drawn = drawBoard(BOARD, { line: null }, new Map(), words)
    expect(drawn.lanes.map((lane) => lane.label)).toEqual(['L1 › SEW-01', 'L1 › SEW-02', 'L1 › SEW-03', 'L2 › QC-01', 'CUT-01'])
    expect(drawn.lanes[0]!.detail).toBe('Cucitura 1 · Giulia · Expert')
    expect(drawn.lanes[2]!.detail).toBe('Cucitura 3 · No operator')
    const tray = drawn.cards.filter((card) => card.laneId === null).map((card) => card.label)
    expect(tray).toEqual(['WO-0146 · Op 20', 'WO-0147 · Op 10', 'WO-0148 · Op 20'])
    const draft = drawn.cards.find((card) => card.label === 'WO-0148 · Op 20')!
    expect(draft.load).toEqual([0])
    expect(draft.minutes).toBe(195)
    const rush = drawn.cards.find((card) => card.label === 'WO-0142 · Op 20')!
    expect(rush.detail).toBe('Cucitura maniche · Giacca Aero · 4 bundles · 80 pcs · due 18/11/2026')
    expect(rush.marks?.map((mark) => mark.label)).toEqual(['Rush', 'Material ready'])
  })

  it('marks late work, the sequence rule and the material in words', () => {
    const drawn = drawBoard(BOARD, { line: null }, new Map(), words)
    expect(drawn.cards.find((card) => card.label === 'WO-0144 · Op 20')!.late).toBe(true)
    expect(drawn.cards.find((card) => card.label === 'WO-0143 · Op 30')!.marks?.map((mark) => mark.label)).toEqual(['Op 20 not done yet', 'Material 18/11/2026'])
    expect(drawn.cards.find((card) => card.label === 'WO-0144 · Op 20')!.marks?.map((mark) => mark.label)).toEqual(['Material missing'])
  })

  it('narrows to one line and keeps that line\'s Not assigned', () => {
    const line = BOARD.lines[0]!.id
    const drawn = drawBoard(BOARD, { line }, new Map(), words)
    expect(drawn.lanes).toHaveLength(3)
    expect(drawn.cards.filter((card) => card.laneId === null).map((card) => card.label)).toEqual(['WO-0146 · Op 20', 'WO-0148 · Op 20'])
  })

  it('names nobody at a site whose floor records name the station', () => {
    const board: DispatchBoard = { ...BOARD, rules: { ...BOARD.rules, namesWorkers: false } }
    expect(drawBoard(board, { line: null }, new Map(), words).lanes[0]!.detail).toBe('Cucitura 1')
  })

  it('a card keeps the id the board knows it by, and no two cards share one', () => {
    const a = { ...C142, id: 'now' }
    const b = { ...C143, id: 'old' }
    expect(boardIdsOf([a, b], new Map([['now', 'old']])).map((entry) => entry.boardId)).toEqual(['old', 'old#2'])
    expect(boardIdsOf([a, { ...a }], new Map()).map((entry) => entry.boardId)).toEqual(['now', 'now#2'])
    const drawn = drawBoard(BOARD, { line: null }, new Map([[placed(C142).id, 'first-id']]), words)
    expect(drawn.byId.get('first-id')?.workOrder.number).toBe('WO-0142')
  })

  it('after a move finds the card by its operation and its key', () => {
    expect(movedCard(BOARD, NOT1.operation.id, 'REST')?.workOrder.number).toBe('WO-0146')
    expect(movedCard(BOARD, NOT1.operation.id, 'nowhere')).toBeNull()
  })

  it('a card names only the people on that work: a station\'s own stand on its lane', () => {
    const own: LaneOperator = { assignmentId: 'a', version: 1, kind: 'OPERATION_OPERATOR', workerId: 'w', name: 'Nina', level: 'CAN_DO', trainee: false, overridden: false, presence: null, reassign: false }
    expect(namedOnCard({ operators: [own, { ...own, kind: 'STATION_OPERATOR', name: 'Aldo' }] }).map((row) => row.name)).toEqual(['Nina'])
  })
})

describe('Dispatch: what a drop may do', () => {
  it('holds a draft and a station that does not do the work, in words', () => {
    expect(say(dropHeldOf(BOARD, DRAFT, { laneId: BOARD.lines[0]!.stations[0]!.id, bucketId: 'day' }))).toBe('A draft is not dispatched: release the work order first.')
    expect(say(dropHeldOf(BOARD, NOT1, { laneId: BOARD.lines[1]!.stations[0]!.id, bucketId: 'day' }))).toBe("QC-01 does not do this operation's work.")
    expect(dropHeldOf(BOARD, NOT1, { laneId: BOARD.lines[0]!.stations[2]!.id, bucketId: 'day' })).toBeNull()
    expect(dropHeldOf(BOARD, NOT1, { laneId: null, bucketId: null })).toBeNull()
  })

  it('holds the whole board: read-only first, then a past day, then offline', () => {
    expect(boardHeld({ past: true, mayManage: false }, true)?.key).toBe('held.readOnly')
    expect(boardHeld({ past: true, mayManage: true }, true)?.key).toBe('held.past')
    expect(boardHeld({ past: false, mayManage: true }, true)?.key).toBe('held.offline')
    expect(boardHeld({ past: false, mayManage: true }, false)).toBeNull()
  })

  it('a drop asks the API to move the whole card; the tray means back to Not assigned', () => {
    expect(moveBodyOf(NOT1, '2026-11-16', { laneId: 's', bucketId: 'day' })).toEqual({ date: '2026-11-16', workOrderOperationId: NOT1.operation.id, from: 'REST', to: { stationId: 's' } })
    expect(moveBodyOf(NOT1, '2026-11-16', { laneId: null, bucketId: null }).to).toEqual({ unplaced: true })
  })

  it('the API\'s undo goes back as it came', () => {
    const undo = { date: '2026-11-16', workOrderOperationId: 'op', from: 'station:s|all', to: { stationId: null, lineId: null, workerId: null, unplaced: true, clearWorker: false }, position: 2 }
    expect(moveBodySchema.parse(undo)).toEqual(undo)
  })
})

describe('Dispatch: Move bundles and the queue', () => {
  it('offers the lines with a station for the work and those stations, not the card\'s own', () => {
    const card = placed(C142)
    const labels = moveTargets(BOARD, card).map((target) => say(target.label))
    expect(labels).toEqual(['Line L1 · Linea 1 · Giacche (its first station for this work)', 'L1 › SEW-02 · Cucitura 2', 'L1 › SEW-03 · Cucitura 3'])
  })

  it('sends the bundles picked to a line or a station; held until both are chosen', () => {
    const card = placed(C142)
    expect(moveBundlesBody(card, 'd', 'line:L', ['b']).to).toEqual({ lineId: 'L' })
    expect(moveBundlesBody(card, 'd', 'station:S', ['b'])).toMatchObject({ bundleIds: ['b'], to: { stationId: 'S' }, from: card.key })
    expect(say(moveBundlesHeld(card, [], 'station:S'))).toBe('Pick at least one bundle.')
    expect(say(moveBundlesHeld(card, ['b'], null))).toBe('Pick where they go.')
    expect(moveBundlesHeld(card, ['b'], 'station:S')).toBeNull()
    expect(say(moveBundlesHeld({ ...card, bundles: [] }, [], null))).toBe('This card has no bundles to pick.')
  })

  it('steps a card through its queue by the API\'s position; rush work stays first', () => {
    const station = stationOf(BOARD, placed(C143).stationId)!
    const [first, second] = station.cards
    expect(laneStep(BOARD, second!, -1).body?.position).toBe(1)
    expect(laneStep(BOARD, first!, 1).body?.position).toBe(2)
    expect(laneStep(BOARD, first!, -1).held?.key).toBe('held.first')
    expect(laneStep(BOARD, second!, 1).held?.key).toBe('held.last')
    const rush = { ...second!, workOrder: { ...second!.workOrder, rush: true } }
    const board: DispatchBoard = { ...BOARD, lines: BOARD.lines.map((line) => ({ ...line, stations: line.stations.map((row) => (row.id === station.id ? { ...row, cards: [first!, rush] } : row)) })) }
    expect(laneStep(board, first!, 1).held?.key).toBe('held.rushFirst')
    expect(laneStep(BOARD, NOT1, 1).held?.key).toBe('held.noLane')
  })
})

describe('Dispatch: Assign operator', () => {
  const [allowed, warned, heldPerson] = PICKER.operators
  it('says the check in our words: a warning asks a reason, a hold never goes on', () => {
    expect(checkPhrase(allowed!)).toBeNull()
    expect(checkPhrase(warned!)?.key).toBe('assign.check.warn')
    expect(checkPhrase(heldPerson!)?.key).toBe('assign.check.notAuthorised')
    expect(checkPhrase({ decision: 'HOLD', overridable: true })?.key).toBe('assign.check.notQualified')
    expect(assignHeld(null, '', false)?.key).toBe('held.pickPerson')
    expect(assignHeld(allowed!, '', false)).toBeNull()
    expect(assignHeld(warned!, 'ab', false)?.key).toBe('held.reason')
    expect(assignHeld(warned!, 'covering', false)).toBeNull()
    expect(assignHeld(heldPerson!, 'covering', false)?.key).toBe('assign.check.notAuthorised')
    expect(assignHeld(allowed!, '', true)?.key).toBe('held.reason')
  })

  it('a line of the picker holds a name, a level and where they stand: no figure', () => {
    expect(pickerLabel(allowed!, t)).toBe('Giulia · Expert')
    expect(pickerLabel(warned!, t)).toBe('Nina · Learning · Trainee · On a break · needs a reason')
    expect(pickerLabel(heldPerson!, t)).toBe('Pietro · No level · held')
    for (const person of PICKER.operators) expect(pickerLabel(person, t)).not.toMatch(/\d/)
  })

  it('an operator is a name and a level; a state is a word, only when the board brought it', () => {
    expect(operatorWords({ name: 'Nina', level: 'LEARNING', trainee: true }, t)).toBe('Nina · Learning · Trainee')
    expect(operatorWords({ name: 'Nina', level: null, trainee: false }, t)).toBe('Nina')
    expect(presencePhrase({ presence: 'NOT_IN' })?.words.key).toBe('presence.NOT_IN')
    expect(presencePhrase({ presence: 'IN' })).toBeNull()
    expect(presencePhrase({ presence: 'UNKNOWN' })).toBeNull()
    expect(presencePhrase({ presence: null })).toBeNull()
  })
})

describe('Dispatch: refusals and live', () => {
  it('says each rule by its code, never the API\'s sentence', () => {
    for (const code of ['PAST_DAY', 'WRONG_WORK_CENTRE', 'SEQUENCE_ORDER', 'MOVED_ALREADY', 'NOT_QUALIFIED', 'NOT_AUTHORISED']) {
      const phrase = refusalOf(refused(code))
      expect(phrase.key).toBe(`refusal.${code}`)
      expect(t(phrase.key)).not.toBe(phrase.key)
      expect(it_(phrase.key)).not.toBe(phrase.key)
    }
    expect(refusalOf(refused('SOMETHING_NEW')).key).toBe('error.changed')
    expect(refusalOf(new Error('x')).key).toBe('error.write')
    expect(needsReason(refused('OVERRIDE_REASON_NEEDED'))).toBe(true)
    expect(needsReason(refused('NOT_QUALIFIED'))).toBe(false)
  })

  it('reads again on what changes the board, for this site', () => {
    expect(touchesBoard('dispatch.assignment_changed', 's', 's')).toBe(true)
    expect(touchesBoard('dispatch.assignment_changed', 'other', 's')).toBe(false)
    expect(touchesBoard('attendance.clock_event', undefined, 's')).toBe(true)
    expect(touchesBoard('clock.out', 's', 's')).toBe(true)
    expect(touchesBoard('production.scan_recorded', 'other', 's')).toBe(true)
    expect(touchesBoard('workorder.released', undefined, 's')).toBe(true)
    expect(touchesBoard('quality.hold_placed', 's', 's')).toBe(false)
  })
})

describe('Dispatch: the schemas keep no word of the API and no figure of a person', () => {
  it('drops the API\'s sentences', () => {
    const operators = [{ assignmentId: 'a', version: 1, kind: 'STATION_OPERATOR', workerId: 'w', name: 'Nina', level: null, levelLabel: 'x', trainee: false, overridden: false, presence: null, reassign: false, words: 'Not clocked in' }]
    const station = { id: 's', code: 'S', name: 'S', lineId: null, workCentreId: 'c', operators, queuedMinutes: '0.0', cards: [], reassign: false }
    const parsed = boardSchema.parse({ ...BOARD, words: 'Nothing queued for this shift', otherStations: [station], lines: [] })
    expect(JSON.stringify(parsed)).not.toContain('Not clocked in')
    expect(JSON.stringify(parsed)).not.toContain('Nothing queued')
    const picker = pickerSchema.parse({ ...PICKER, operators: [{ ...PICKER.operators[0]!, words: 'held', minutes: 5 }] })
    expect(JSON.stringify(picker)).not.toContain('minutes')
  })

  it('every station lane reads back to its label', () => {
    expect(stationLabel(BOARD, BOARD.lines[0]!.stations[0]!)).toBe('L1 › SEW-01')
    expect(stationLabel(BOARD, BOARD.otherStations[0]!)).toBe('CUT-01')
  })
})
