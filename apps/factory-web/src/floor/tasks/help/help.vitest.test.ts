import { describe, expect, it } from 'vitest'
import type { HelpCall, HelpStation } from './api'
import { callAskWords } from '../../../lib/line-board/model'
import { askOf, askReasons, callTone, callWords, closePayload, comingOf, detailsHeld, detailsOf, followUpOf, newlyOnTheWay, progressOf, queuedCalls, reasonPicked, sendPayload, tilePress } from './model'
import { designScreen } from './fixtures'

const type = { id: 'type-1', kind: 'MATERIAL', code: 'MATERIAL', labelIt: 'Materiale', labelEn: 'Material', labelI18n: { ro: 'Material' }, icon: null, colour: '#B87503' } as const
const person = (name: string | null, kind: 'WORKER' | 'USER' = 'WORKER') => ({ kind, name })
const call = (extra: Partial<HelpCall> = {}): HelpCall => ({ id: 'call-1', version: 1, status: 'SENT', open: true, type, station: { id: 's', code: 'SEW-01', name: 'Sew 1' }, line: null, responderTeam: null, note: null, reasonCode: null, requestedQuantity: null, sentAt: '2026-11-02T09:00:00.000Z', timeline: [{ step: 'SENT', at: '2026-11-02T09:00:00.000Z', by: null }], coming: null, ...extra })
const tile = (open: HelpCall | null = null): HelpStation['tiles'][number] => ({ type, open })

describe('Call for help (SCR-172)', () => {
  it('says a tile in the person’s language and takes its tone from the code’s colour', () => {
    expect(callWords(type, 'it')).toBe('Materiale')
    expect(callWords(type, 'en')).toBe('Material')
    expect(callTone(type)).toBe('warning')
    expect(callTone({ colour: null })).toBe('neutral')
  })

  it('never sends a second call: the open one, then the one on this tablet, else a new one (MES-143)', () => {
    expect(tilePress(tile(call()), [])).toEqual({ kind: 'open', callId: 'call-1' })
    expect(tilePress(tile(), [{ clientEventId: 'q-1', typeId: 'type-1', at: 'x' }])).toEqual({ kind: 'queued', clientEventId: 'q-1' })
    expect(tilePress(tile(), [{ clientEventId: 'q-1', typeId: 'other', at: 'x' }])).toEqual({ kind: 'send', type })
  })

  it('finds the calls still waiting on this tablet, and only those', () => {
    const item = (kind: string, state: string, clientEventId: string) => ({ kind, state, clientEventId, payload: { typeId: 'type-1' }, occurredAt: 'at' }) as never
    expect(queuedCalls([item('andon.call.send', 'waiting', 'a'), item('andon.call.send', 'recorded', 'b'), item('plant.report', 'waiting', 'c')])).toEqual([{ clientEventId: 'a', typeId: 'type-1', at: 'at' }])
  })

  it('queues the type alone and a close by its step', () => {
    expect(sendPayload(type)).toEqual({ typeId: 'type-1' })
    expect(closePayload(call(), 'CANCELLED')).toEqual({ callId: 'call-1', step: 'CANCELLED' })
  })

  it('shows Sent → Seen → On the way → Solved with times, and who took each step', () => {
    const rows = progressOf(call({ timeline: [{ step: 'SENT', at: 'a', by: null }, { step: 'ON_THE_WAY', at: 'b', by: person('Paolo') }] }))
    expect(rows.map((row) => [row.step, row.at])).toEqual([['SENT', 'a'], ['SEEN', null], ['ON_THE_WAY', 'b'], ['SOLVED', null]])
    expect(rows[2]!.by).toEqual({ name: 'Paolo', office: false })
  })

  it('names a floor responder and says "the office" for an office one (the floor reads no user table)', () => {
    expect(comingOf(call())).toBeNull()
    expect(comingOf(call({ coming: { step: 'ON_THE_WAY', by: person('Paolo'), team: { id: 't', code: 'A', name: 'Line 1 team' } } }))).toEqual({ who: { name: 'Paolo', office: false }, team: 'Line 1 team', step: 'ON_THE_WAY' })
    expect(comingOf(call({ coming: { step: 'SEEN', by: person(null, 'USER'), team: null } }))?.who).toEqual({ name: null, office: true })
  })

  it('plays the sound once, when a helper turns to on the way', () => {
    const before = [{ id: 'a', status: 'SEEN' as const }]
    expect(newlyOnTheWay(before, [{ id: 'a', status: 'ON_THE_WAY' }])).toBe(true)
    expect(newlyOnTheWay([{ id: 'a', status: 'ON_THE_WAY' }], [{ id: 'a', status: 'ON_THE_WAY' }])).toBe(false)
    expect(newlyOnTheWay([], [{ id: 'a', status: 'ON_THE_WAY' }])).toBe(false)
  })

  it('follows a machine call with the machine problem and a safety call with the incident report', () => {
    expect(followUpOf({ kind: 'MACHINE', code: 'MACHINE' })).toBe('machine')
    expect(followUpOf({ kind: 'MAINTENANCE', code: 'MAINTENANCE' })).toBe('machine')
    expect(followUpOf({ kind: 'OTHER', code: 'SAFETY' })).toBe('incident')
    expect(followUpOf({ kind: 'MATERIAL', code: 'MATERIAL' })).toBeNull()
  })

  it('holds the words without the network or without words', () => {
    expect(detailsHeld('x', false)).toBe('offline')
    expect(detailsHeld('  ', true)).toBe('empty')
    expect(detailsHeld('x', true)).toBeNull()
  })

  it('a material call asks why, then how much; only what it has not said; any other call asks for words (MES-137)', () => {
    expect(askOf(call())).toEqual({ stage: 'reason', reason: null, quantity: null, askQuantity: true })
    expect(askOf(call({ reasonCode: 'MATERIAL_SHORT' }))).toEqual({ stage: 'quantity', reason: null, quantity: null, askQuantity: true })
    expect(askOf(call({ requestedQuantity: '2' }))).toEqual({ stage: 'reason', reason: null, quantity: null, askQuantity: false })
    expect(askOf(call({ reasonCode: 'MATERIAL_SHORT', requestedQuantity: '2' }))).toBeNull()
    expect(askOf(call({ type: { ...type, kind: 'QUALITY' } }))).toBeNull()
    expect(reasonPicked(askOf(call())!, 'MATERIAL_WRONG')).toMatchObject({ stage: 'quantity', reason: 'MATERIAL_WRONG' })
    expect(reasonPicked(askOf(call({ requestedQuantity: '2' }))!, 'OTHER')).toMatchObject({ stage: 'words', reason: 'OTHER' })
    expect(askReasons().map((tile) => tile.code)).toEqual(['MATERIAL_SHORT', 'MATERIAL_DAMAGED', 'MATERIAL_WRONG', 'MATERIAL_RECUT', 'OTHER'])
  })

  it('sends only what was told, and holds Other without words (words on the call count)', () => {
    const ask = { stage: 'quantity', reason: 'OTHER', quantity: 2.5, askQuantity: true } as const
    expect(detailsOf('  Fodera  ', ask)).toEqual({ note: 'Fodera', reasonCode: 'OTHER', requestedQuantity: '2.5' })
    expect(detailsOf('', { ...ask, reason: 'MATERIAL_SHORT', quantity: null })).toEqual({ reasonCode: 'MATERIAL_SHORT' })
    expect(detailsHeld('', true, ask)).toBe('needsWords')
    expect(detailsHeld('', true, ask, true)).toBeNull()
    expect(detailsHeld('x', true, ask)).toBeNull()
    expect(detailsHeld('', true, { ...ask, reason: null, quantity: null })).toBe('empty')
    expect(detailsHeld('', false, ask)).toBe('offline')
  })

  it('says what a call asks in the screen’s language, for the card, Help calls and the line view', () => {
    expect(callAskWords({ reasonCode: 'MATERIAL_SHORT', requestedQuantity: '4' }, 'it')).toBe('Materiale finito · 4')
    expect(callAskWords({ reasonCode: 'MATERIAL_SHORT', requestedQuantity: '2.5' }, 'en')).toBe('Ran out · 2.5')
    expect(callAskWords({ reasonCode: 'MATERIAL_SHORT', requestedQuantity: '2.5' }, 'it')).toBe('Materiale finito · 2,5')
    expect(callAskWords({ reasonCode: null, requestedQuantity: '4' }, 'en')).toBe('4')
    expect(callAskWords({ reasonCode: 'SOMETHING_OLD', requestedQuantity: null }, 'en')).toBe('SOMETHING_OLD')
    expect(callAskWords({ reasonCode: null, requestedQuantity: null }, 'en')).toBeNull()
  })

  it('has the design cases, with no money anywhere', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['tiles', 'tiles-offline', 'tiles-open', 'call-coming', 'cancel-coming', 'details', 'details-offline', 'saved-offline', 'refused', 'problem', 'no-permission']) expect(ids).toContain(id)
    expect(JSON.stringify(designScreen.cases)).not.toMatch(/price|cost|margin|wage|€/i)
  })
})
