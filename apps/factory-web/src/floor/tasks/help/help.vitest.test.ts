import { describe, expect, it } from 'vitest'
import type { HelpCall, HelpStation } from './api'
import { callTone, callWords, closePayload, comingOf, detailsHeld, followUpOf, newlyOnTheWay, progressOf, queuedCalls, sendPayload, tilePress } from './model'
import { designScreen } from './fixtures'

const type = { id: 'type-1', kind: 'MATERIAL', code: 'MATERIAL', labelIt: 'Materiale', labelEn: 'Material', labelI18n: { ro: 'Material' }, icon: null, colour: '#B87503' } as const
const person = (name: string | null, kind: 'WORKER' | 'USER' = 'WORKER') => ({ kind, name })
const call = (extra: Partial<HelpCall> = {}): HelpCall => ({ id: 'call-1', version: 1, status: 'SENT', open: true, type, station: { id: 's', code: 'SEW-01', name: 'Sew 1' }, line: null, responderTeam: null, note: null, sentAt: '2026-11-02T09:00:00.000Z', timeline: [{ step: 'SENT', at: '2026-11-02T09:00:00.000Z', by: null }], coming: null, ...extra })
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

  it('has the design cases, with no money anywhere', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['tiles', 'tiles-offline', 'tiles-open', 'call-coming', 'cancel-coming', 'details', 'details-offline', 'saved-offline', 'refused', 'problem', 'no-permission']) expect(ids).toContain(id)
    expect(JSON.stringify(designScreen.cases)).not.toMatch(/price|cost|margin|wage|€/i)
  })
})
