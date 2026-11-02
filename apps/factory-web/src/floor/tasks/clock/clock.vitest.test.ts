import { CLOCK_REFUSAL_CODES } from '@nexus/factory-domain/people/clock/rules'
import { describe, expect, it } from 'vitest'
import { KeptClocks, memoryKeptStorage, type SendAnswer } from './kept'
import { keptSender } from './api'
import { afterAction, barOf, flagsOf, KNOWN_REFUSALS, mainActionOf, offeredItem, pausedAtClockOut, runningBundles, stateAfter, todayClock, type ClockView, type OpenItem, type OpenWork } from './model'
import type { ApiClient } from '../../../lib/api/client'
import { apiErrorFrom, networkError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE } from '../../../lib/i18n/messages'

const view = (over: Partial<ClockView> = {}): ClockView => ({
  person: { workerId: 'w', employeeId: 'e', name: 'Ada Demo' },
  state: 'IN',
  inSince: '2026-10-29T06:58:00.000Z',
  breakSince: null,
  forgottenSince: null,
  minutes: { worked: 252, present: 252, breaks: 0 },
  shift: null,
  breaks: { mode: 'CLOCKED', next: null, due: 'due' },
  autoClockOutAt: null,
  actions: ['OUT', 'BREAK_OUT'],
  next: 'OUT',
  events: [],
  serverTime: '2026-10-29T11:10:00.000Z',
  ...over,
})

describe('the refusals', () => {
  it('every refusal of the clock has its own words, in both languages', () => {
    expect([...KNOWN_REFUSALS].sort()).toEqual([...CLOCK_REFUSAL_CODES].sort())
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['floor-clock'] ?? {}
      for (const code of KNOWN_REFUSALS) for (const part of ['message', 'fix']) expect(words[`refusal.${code}.${part}`], `${locale} ${code} ${part}`).toBeTruthy()
    }
  })
})

describe('the bar of a state', () => {
  it('puts the API\'s main action last, under the thumb', () => {
    expect(barOf(view())).toEqual(['BREAK_OUT', 'OUT'])
    expect(mainActionOf(view())).toBe('OUT')
    expect(mainActionOf(view({ actions: ['BREAK_IN', 'OUT'] }))).toBe('BREAK_IN')
  })

  it('offers in and out when nothing is known on the tablet, Clock in as the main one', () => {
    expect(barOf(null)).toEqual(['OUT', 'IN'])
    expect(mainActionOf(null)).toBe('IN')
  })
})

describe('what the tablet knows after an action it saved itself', () => {
  it('clocked in: the state, the time and the next buttons move on, the minutes stay as last read', () => {
    const next = afterAction(view({ state: 'OUT', inSince: null, actions: ['IN'], next: 'IN' }), 'IN', '2026-10-29T07:00:00.000Z')
    expect(next).toMatchObject({ state: 'IN', inSince: '2026-10-29T07:00:00.000Z', actions: ['OUT', 'BREAK_OUT'], next: 'OUT', minutes: { worked: 252 } })
  })

  it('a break keeps the clock-in and offers the way back; fixed breaks offer Clock out alone', () => {
    expect(afterAction(view(), 'BREAK_OUT', '2026-10-29T10:00:00.000Z')).toMatchObject({ state: 'ON_BREAK', inSince: '2026-10-29T06:58:00.000Z', breakSince: '2026-10-29T10:00:00.000Z', actions: ['BREAK_IN', 'OUT'], next: 'BREAK_IN' })
    expect(afterAction(view({ breaks: { mode: 'FIXED', next: null, due: null } }), 'IN', '2026-10-29T07:00:00.000Z').actions).toEqual(['OUT'])
  })

  it('clock-out ends the break and drops the reminder', () => {
    expect(afterAction(view({ state: 'ON_BREAK', breakSince: '2026-10-29T10:00:00.000Z' }), 'OUT', '2026-10-29T11:00:00.000Z')).toMatchObject({ state: 'OUT', inSince: null, breakSince: null, actions: ['IN'], breaks: { due: null } })
  })

  it('says the state each action leads to', () => {
    expect((['IN', 'OUT', 'BREAK_OUT', 'BREAK_IN'] as const).map(stateAfter)).toEqual(['IN', 'OUT', 'ON_BREAK', 'IN'])
  })
})

describe('today\'s clock and flags', () => {
  it('counts from the moment of the read (the tablet\'s clock may be wrong), stops on a break, draws nothing when out', () => {
    expect(todayClock(view(), 1000)).toEqual({ since: 1000, carriedMs: 252 * 60_000, paused: false })
    expect(todayClock(view({ state: 'ON_BREAK' }), 1000)?.paused).toBe(true)
    expect(todayClock(view({ state: 'OUT' }), 1000)).toBeNull()
  })

  it('names each flag once', () => {
    expect(flagsOf([{ flags: ['FORGOT_BADGE'] }, { flags: ['FORGOT_BADGE', 'CLOCK_SKEW'] }, { flags: [] }])).toEqual(['FORGOT_BADGE', 'CLOCK_SKEW'])
  })
})

describe('open work at a clock-out', () => {
  const item = (over: Partial<OpenItem> = {}): OpenItem => ({ bundleId: 'b1', bundleCode: 'B-1', operation: { id: 'o1', seq: 30, name: 'Op' }, state: 'RUNNING', mine: true, pausedAtClockOut: false, ...over })
  const open = (items: OpenItem[], offer: OpenWork['offer'] = null): OpenWork => ({ items, offer, clockOutWarning: null })

  it('warns of the person\'s own running work only', () => {
    expect(runningBundles(open([item(), item({ bundleCode: 'B-2', state: 'PAUSED' }), item({ bundleCode: 'B-3', mine: false })]))).toEqual(['B-1'])
    expect(runningBundles(null)).toEqual([])
  })

  it('finds what the last clock-out paused and the item of the offer', () => {
    const paused = item({ state: 'PAUSED', pausedAtClockOut: true })
    expect(pausedAtClockOut(open([item({ bundleCode: 'B-2' }), paused]))).toEqual([paused])
    expect(offeredItem(open([paused], { bundleId: 'b1', workOrderOperationId: 'o1', words: 'x' }))).toEqual(paused)
    expect(offeredItem(open([paused]))).toBeNull()
    expect(offeredItem(open([], { bundleId: 'b1', workOrderOperationId: 'o1', words: 'x' }))).toBeNull()
  })
})

describe('badges kept at a kiosk while offline', () => {
  const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ0123'
  const keeper = (answer: () => SendAnswer, storage = memoryKeptStorage()) => {
    const sent: { badgeCode: string; occurredAt: string; sentAt: string; action: string; clientEventId: string }[] = []
    let now = new Date('2026-10-29T06:58:00.000Z')
    const kept = new KeptClocks(
      storage,
      async (item, sentAt) => {
        sent.push({ ...item, sentAt })
        return answer()
      },
      { now: () => now },
    )
    return { kept, sent, storage, later: (at: string) => (now = new Date(at)) }
  }

  it('never stores the code in clear, sends it with the tablet time and the clock at sending, then forgets it', async () => {
    const { kept, sent, storage, later } = keeper(() => ({ kind: 'done' }))
    await kept.start()
    expect(await kept.add(CODE, 'IN', 'clk-1')).toBe(true)
    expect(kept.getSnapshot().waiting).toBe(1)
    const stored = await storage.load()
    expect(new TextDecoder().decode(stored.items[0]!.sealed.data)).not.toContain(CODE)
    expect(JSON.stringify(kept.getSnapshot())).not.toContain(CODE)
    later('2026-10-29T07:30:00.000Z')
    await kept.flush()
    expect(sent).toEqual([{ badgeCode: CODE, clientEventId: 'clk-1', action: 'IN', occurredAt: '2026-10-29T06:58:00.000Z', sentAt: '2026-10-29T07:30:00.000Z' }])
    expect(kept.getSnapshot().waiting).toBe(0)
    expect((await storage.load()).items).toEqual([])
  })

  it('keeps it when the office cannot be reached, and sends again', async () => {
    let answer: SendAnswer = { kind: 'later' }
    const { kept, sent } = keeper(() => answer)
    await kept.start()
    await kept.add(CODE, 'OUT', 'clk-2')
    await kept.flush()
    expect(kept.getSnapshot().waiting).toBe(1)
    answer = { kind: 'done' }
    await kept.flush()
    expect(sent).toHaveLength(2)
    expect(sent[0]!.clientEventId).toBe(sent[1]!.clientEventId)
    expect(kept.getSnapshot().waiting).toBe(0)
  })

  it('a final refusal drops the code and keeps one line without it, gone after a day or when dismissed', async () => {
    const { kept, storage, later } = keeper(() => ({ kind: 'refused', code: 'MONTH_CLOSED' }))
    await kept.start()
    await kept.add(CODE, 'IN', 'clk-3')
    await kept.flush()
    const line = { clientEventId: 'clk-3', action: 'IN', occurredAt: '2026-10-29T06:58:00.000Z', code: 'MONTH_CLOSED' }
    expect(kept.getSnapshot()).toMatchObject({ waiting: 0, refused: [line] })
    expect((await storage.load()).items).toEqual([])
    expect(JSON.stringify(await storage.load())).not.toContain(CODE)

    const again = new KeptClocks(storage, async () => ({ kind: 'done' }), { now: () => new Date('2026-10-30T06:00:00.000Z') })
    await again.start()
    expect(again.getSnapshot().refused).toEqual([line])
    await again.dismiss('clk-3')
    expect(again.getSnapshot().refused).toEqual([])
    later('2026-10-29T08:00:00.000Z')
    await kept.add(CODE, 'IN', 'clk-4')
    await kept.flush()
    const old = new KeptClocks(storage, async () => ({ kind: 'done' }), { now: () => new Date('2026-10-31T09:00:00.000Z') })
    await old.start()
    expect(old.getSnapshot().refused).toEqual([])
    expect((await storage.load()).refused).toEqual([])
  })

  it('stops at the first that must wait, oldest first', async () => {
    const answers: SendAnswer[] = [{ kind: 'done' }, { kind: 'later' }]
    const { kept, sent, later } = keeper(() => answers.shift() ?? { kind: 'done' })
    await kept.start()
    await kept.add(CODE, 'IN', 'clk-5')
    later('2026-10-29T07:00:00.000Z')
    await kept.add(CODE, 'OUT', 'clk-6')
    later('2026-10-29T07:10:00.000Z')
    await kept.add(CODE, 'IN', 'clk-7')
    await kept.flush()
    expect(sent.map((item) => item.clientEventId)).toEqual(['clk-5', 'clk-6'])
    expect(kept.getSnapshot().waiting).toBe(2)
  })

  it('a tablet that cannot seal keeps nothing, and says so', async () => {
    const kept = new KeptClocks(null, async () => ({ kind: 'done' }))
    await kept.start()
    expect(kept.getSnapshot().available).toBe(false)
    expect(await kept.add(CODE, 'IN', 'clk-8')).toBe(false)
  })

  it('reads the office\'s answer: only a network problem keeps the code', async () => {
    const answerTo = async (error: unknown) => keptSender({ get: async () => ({}), post: async () => { throw error } } as unknown as ApiClient)({ badgeCode: CODE, clientEventId: 'clk-9', action: 'IN', occurredAt: '2026-10-29T06:58:00.000Z' }, '2026-10-29T07:00:00.000Z')
    const api = (status: number, issues: { path: string; message: string }[] = []) => apiErrorFrom(status, { error: { code: 'x', message: 'x', issues } })
    expect(await answerTo(networkError(new TypeError('network')))).toEqual({ kind: 'later' })
    expect(await answerTo(api(429))).toEqual({ kind: 'later' })
    expect(await answerTo(api(409, [{ path: 'refusal/MONTH_CLOSED', message: 'Closed.' }, { path: 'fix', message: 'Ask.' }]))).toEqual({ kind: 'refused', code: 'MONTH_CLOSED' })
    expect(await answerTo(api(409, [{ path: 'gate/ATTENDANCE', message: 'Closed.' }]))).toEqual({ kind: 'refused', code: 'CLOSED' })
    expect(await answerTo(api(401))).toEqual({ kind: 'refused', code: null })
  })
})
