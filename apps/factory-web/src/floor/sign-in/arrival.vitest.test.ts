import { describe, expect, it } from 'vitest'
import type { OpenWork } from '../tasks/clock/model'
import { welcomeCards, type HandoverNews } from './arrival'

const news = (count: number): HandoverNews => ({
  line: { id: 'l', code: 'L1', name: 'Linea 1' },
  notes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, shiftDate: '2026-10-29', shiftLabel: 'Mattina', topics: [], text: 'x' })),
})
const item = { bundleId: 'b', bundleCode: 'B-000123', operation: { id: 'o', seq: 30, name: 'Collar' }, state: 'PAUSED', mine: true, pausedAtClockOut: true }
const open = (offered: boolean): OpenWork => ({ items: [item], offer: offered ? { bundleId: 'b', workOrderOperationId: 'o', words: 'x' } : null, clockOutWarning: null })

describe('the welcome cards after a sign-in (design floor.signin "Welcome and checks")', () => {
  it('the handover note first, then Continue bundle', () => {
    expect(welcomeCards(news(2), open(true)).map((card) => card.kind)).toEqual(['handover', 'continue'])
  })

  it('only when needed: nothing new goes straight to Home', () => {
    expect(welcomeCards(news(0), open(false))).toEqual([])
    expect(welcomeCards(null, null)).toEqual([])
    expect(welcomeCards(news(1), null).map((card) => card.kind)).toEqual(['handover'])
    expect(welcomeCards(null, open(true)).map((card) => card.kind)).toEqual(['continue'])
  })

  it('names the line of the notes', () => {
    expect(welcomeCards(news(1), null)[0]).toMatchObject({ kind: 'handover', line: 'Linea 1' })
    expect(welcomeCards({ line: null, notes: news(1).notes }, null)[0]).toMatchObject({ kind: 'handover', line: null })
  })
})
