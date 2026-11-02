import { describe, expect, it } from 'vitest'
import type { LineBoard } from '../../../lib/line-board/schema'
import type { BehalfOptions, BlockRow, Conflict, ScrapRow } from './api'
import {
  behalfHeld,
  behalfPayload,
  countsHeld,
  decisionHeld,
  EMPTY_BEHALF,
  EMPTY_HANDOVER,
  EMPTY_OVERRIDE,
  handoverHeld,
  handoverPayload,
  isOverridable,
  lineCan,
  lineNumbers,
  nextItem,
  openOperations,
  overrideBody,
  overrideHeld,
  queuedAnswers,
  rejectHeld,
  selectedCall,
  stationStates,
  toggleTopic,
  waitingItems,
  withDefects,
  type BehalfDraft,
} from './model'
import { designScreen } from './fixtures'

const scrap = (at: string, extra: Partial<ScrapRow> = {}) => ({ scanId: `scan-${at}`, at, own: false, scrapQuantity: 5, ...extra }) as ScrapRow
const block = (startedAt: string, lineId: string | null, extra: Partial<BlockRow> = {}) => ({ id: `block-${startedAt}`, startedAt, version: 1, own: false, line: lineId ? { id: lineId, code: 'L', name: 'L' } : null, ...extra }) as BlockRow
const conflict = (serverTime: string, state: Conflict['state'] = 'OPEN') => ({ id: `conflict-${serverTime}`, state, version: 1, refused: { serverTime } }) as Conflict

const station = (id: string, extra: Partial<LineBoard['stations'][number]> = {}) => ({ id, code: id, name: id, call: 'CLEAR', material: false, machineDown: false, state: 'CLEAR', look: { icon: 'check', tone: 'success', shape: 'SQUARE' }, ...extra }) as LineBoard['stations'][number]

describe('Line view (SCR-168)', () => {
  it('reads the team leader’s rights from the session', () => {
    expect(lineCan(['floor.lead', 'production.scan.behalf'])).toEqual({ lead: true, answer: false, reassign: false, handover: false, behalf: true })
  })

  it('makes My line now from line totals only', () => {
    const board = { output: { done: 86, target: 192, pace: 'BEHIND' }, wip: { bundles: 21, stuck: 2 }, quality: { dhu: '3.4', defects: 3 }, stations: [station('a', { machineDown: true }), station('b', { call: 'CALLING' })] } as unknown as LineBoard
    expect(lineNumbers(board, { calls: [{}, {}, {}] as never })).toEqual({ done: 86, target: 192, pace: 'BEHIND', wip: 21, stuck: 2, calls: 3, machinesDown: 1, dhu: '3.4', defects: 3 })
    expect(lineNumbers(board, null).calls).toBe(1)
  })

  it('merges what waits, oldest first, this line only, what is with the office last', () => {
    const items = waitingItems([scrap('2026-11-02T10:00:00.000Z')], [block('2026-11-02T09:00:00.000Z', 'L1'), block('2026-11-02T08:00:00.000Z', 'L2'), block('2026-11-02T08:30:00.000Z', null)], [conflict('2026-11-02T07:00:00.000Z', 'WITH_OFFICE'), conflict('2026-11-02T09:30:00.000Z')], 'L1')
    expect(items.map((item) => item.kind)).toEqual(['block', 'block', 'conflict', 'scrap', 'conflict'])
    expect(items.at(-1)).toMatchObject({ kind: 'conflict', row: { state: 'WITH_OFFICE' } })
  })

  it('holds one’s own work and what is with the office, and opens the next that may be decided', () => {
    const items = waitingItems([scrap('2026-11-02T08:00:00.000Z'), scrap('2026-11-02T09:00:00.000Z', { own: true }), scrap('2026-11-02T10:00:00.000Z')], [], [conflict('2026-11-02T11:00:00.000Z', 'WITH_OFFICE')], null)
    expect(decisionHeld(items[1]!)).toBe('own')
    expect(decisionHeld(items[3]!)).toBe('withOffice')
    expect(nextItem(items, items[0]!)?.id).toBe(items[2]!.id)
    expect(nextItem(items.slice(1, 2), items[1]!)).toBeNull()
  })

  it('asks a tile for scrap, words for "Other" and for a time block', () => {
    const [item] = waitingItems([scrap('2026-11-02T08:00:00.000Z')], [], [], null)
    const [time] = waitingItems([], [block('2026-11-02T08:00:00.000Z', null)], [], null)
    expect(rejectHeld({ item: item!, tile: null, words: '' })).toBe('tile')
    expect(rejectHeld({ item: item!, tile: { needsDetail: true }, words: ' ' })).toBe('words')
    expect(rejectHeld({ item: item!, tile: { needsDetail: false }, words: '' })).toBeNull()
    expect(rejectHeld({ item: time!, tile: null, words: '' })).toBe('words')
    expect(rejectHeld({ item: time!, tile: null, words: 'Wrong code' })).toBeNull()
  })

  it('answers the call picked, else the first; a queued answer is not offered twice', () => {
    const calls = [{ id: 'a' }, { id: 'b' }]
    expect(selectedCall(calls, 'b')?.id).toBe('b')
    expect(selectedCall(calls, 'gone')?.id).toBe('a')
    expect(selectedCall([], null)).toBeNull()
    const item = (kind: string, state: string) => ({ kind, state, clientEventId: 'q', payload: { callId: 'a', step: 'ON_THE_WAY' } }) as never
    expect(queuedAnswers([item('andon.call.answer', 'waiting'), item('andon.call.answer', 'recorded'), item('plant.report', 'waiting')])).toEqual([{ clientEventId: 'q', callId: 'a', step: 'ON_THE_WAY' }])
  })

  it('says per station only a call, a machine, material and who is signed in: never output, never who (F2)', () => {
    const states = stationStates({ stations: [station('a', { machineDown: true }), station('b', { call: 'COMING' }), station('c'), station('d')] }, { stations: [{ id: 'a', code: 'a', name: 'a', signedIn: true, reassign: [] }, { id: 'b', code: 'b', name: 'b', signedIn: true, reassign: [] }, { id: 'c', code: 'c', name: 'c', signedIn: false, reassign: [] }] })
    expect(states.map((entry) => [entry.id, entry.tone, entry.signedIn])).toEqual([['a', 'danger', true], ['b', 'info', true], ['c', 'neutral', false], ['d', 'success', null]])
    expect(Object.keys(states[0]!).sort()).toEqual(['call', 'code', 'id', 'machineDown', 'material', 'name', 'reassign', 'signedIn', 'tone'])
  })

  it('keeps one handover note per line and shift, at the version read', () => {
    expect(handoverHeld(EMPTY_HANDOVER)).toBe('empty')
    const draft = toggleTopic(EMPTY_HANDOVER, 'MACHINES')
    expect(handoverHeld(draft)).toBeNull()
    expect(toggleTopic(draft, 'MACHINES').topics).toEqual([])
    expect(handoverPayload('L1', 'Morning', { topics: ['MACHINES'], text: '  ' }, null)).toEqual({ lineId: 'L1', shiftLabel: 'Morning', topics: ['MACHINES'], text: null })
    expect(handoverPayload('L1', 'Morning', { topics: [], text: 'Note' }, { version: 3, shiftLabel: 'Night' })).toEqual({ lineId: 'L1', shiftLabel: 'Night', topics: [], text: 'Note', version: 3 })
  })

  const card = { bundle: { code: 'B-1', quantity: 20 }, next: 'op-2', operations: [{ id: 'op-1', seq: 10, scanRequired: true, state: 'OPEN', expected: 20 }, { id: 'op-2', seq: 20, scanRequired: true, state: 'OPEN', expected: 18 }, { id: 'op-3', seq: 30, scanRequired: false, state: 'OPEN', expected: 18 }, { id: 'op-4', seq: 40, scanRequired: true, state: 'DONE', expected: 18 }] } as unknown as NonNullable<BehalfDraft['card']>
  const options: Pick<BehalfOptions, 'subject' | 'reasons'> = { subject: 'WORKER', reasons: [{ code: 'BADGE_MISSING', label: { it: '', en: '' }, needsNote: false }, { code: 'OTHER', label: { it: '', en: '' }, needsNote: true }] }

  it('offers the open scanned operations, the next one first', () => {
    expect(openOperations(card).map((operation) => operation.id)).toEqual(['op-2', 'op-1'])
  })

  it('balances Good against the bundle and refuses too many pieces', () => {
    const draft = { ...EMPTY_BEHALF, card, operationId: 'op-2', good: 18 }
    expect(withDefects(draft, 'scrap', { STAIN: 2 }).good).toBe(16)
    expect(countsHeld(withDefects(draft, 'scrap', { STAIN: 2 }))).toBeNull()
    expect(countsHeld({ ...draft, good: 18, scrap: { STAIN: 1 } })).toBe('atMost')
    expect(countsHeld({ ...draft, good: 0 })).toBe('nothing')
  })

  it('walks an entry on behalf: station, person, bundle, reason, words for Other', () => {
    expect(behalfHeld(EMPTY_BEHALF, options)).toBe('station')
    expect(behalfHeld({ ...EMPTY_BEHALF, stationId: 's' }, options)).toBe('person')
    expect(behalfHeld({ ...EMPTY_BEHALF, stationId: 's' }, { ...options, subject: 'STATION' })).toBe('bundle')
    const ready = { ...EMPTY_BEHALF, stationId: 's', personId: 'p', card, operationId: 'op-2', good: 18 }
    expect(behalfHeld(ready, options)).toBe('reason')
    expect(behalfHeld({ ...ready, reason: 'OTHER' }, options)).toBe('note')
    expect(behalfHeld({ ...ready, reason: 'BADGE_MISSING' }, options)).toBeNull()
  })

  it('names the person only where the site names workers', () => {
    const ready = { ...EMPTY_BEHALF, stationId: 's', personId: 'p', card, operationId: 'op-2', good: 18, scrap: { STAIN: 0 }, rework: { SEAM: 1 }, reason: 'BADGE_MISSING' }
    expect(behalfPayload(ready, 'WORKER')).toEqual({ code: 'B-1', workOrderOperationId: 'op-2', good: 18, rework: [{ reason: 'SEAM', quantity: 1 }], stationId: 's', workerId: 'p', reasonCode: 'BADGE_MISSING' })
    expect(behalfPayload(ready, 'STATION')).not.toHaveProperty('workerId')
  })

  it('sends a held entry to another team leader with the same report', () => {
    expect(isOverridable('PREVIOUS_NOT_REPORTED')).toBe(true)
    expect(isOverridable('BEHALF_SELF')).toBe(false)
    expect(overrideHeld(EMPTY_OVERRIDE)).toBe('reason')
    expect(overrideHeld({ reason: 'OTHER', note: '', badge: null })).toBe('note')
    expect(overrideHeld({ reason: 'COUNTED_AGAIN', note: '', badge: null })).toBe('badge')
    expect(overrideHeld({ reason: 'COUNTED_AGAIN', note: '', badge: 'B' })).toBeNull()
    expect(overrideBody({ clientScanId: 'c' }, { reason: 'COUNTED_AGAIN', note: '', badge: 'B' }, '246810')).toEqual({ report: { clientScanId: 'c' }, lead: { badgeCode: 'B', pin: '246810' }, overrideReasonCode: 'COUNTED_AGAIN' })
  })

  it('has every state of the design, with no money and no figure per person', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['now', 'quiet', 'updates', 'offline', 'parts-unknown', 'no-line', 'problem', 'no-permission', 'scrap', 'pin', 'conflict', 'reassign', 'handover', 'behalf-station', 'behalf-override', 'behalf-done']) expect(ids).toContain(id)
    expect(JSON.stringify(designScreen.cases)).not.toMatch(/price|cost|margin|wage|€/i)
  })
})
