/**
 * 3A (Owner decided 2026-10-06) — his own limits warn, they never block his own edits. A write the API answers 409
 * `needsConfirmation` waits for his "Send anyway": yes sends the same body again with `confirmOwnLimits`, no (or no
 * dialog on the page) sends nothing and says why. Writes that wait together are one question.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))

import { askSendAnyway, confirmed, notSentPastLimits, readNeedsConfirmation, setSendAnywayAsker, type SendAnywayAsk } from './sendAnyway'
import { adsWrite } from './adsWrite'

const LIMIT = { limit: 'entity_bounds', reason: 'budget €40.00 exceeds your €30.00 maximum' }
const waiting = { ok: false, error: 'This goes past your bid or budget limit', needsConfirmation: { limits: [LIMIT] } }

afterEach(() => {
  setSendAnywayAsker(null)
  vi.unstubAllGlobals()
})

describe('readNeedsConfirmation', () => {
  it('only a 409 that names its limits waits; anything else is the usual answer', () => {
    expect(readNeedsConfirmation(409, waiting)).toEqual([LIMIT])
    expect(readNeedsConfirmation(200, waiting)).toBeNull()
    expect(readNeedsConfirmation(409, { error: 'command conflict' })).toBeNull()
    expect(readNeedsConfirmation(409, null)).toBeNull()
  })
  it('confirmed() and the not-sent sentence', () => {
    expect(confirmed({ dailyBudget: 40 })).toEqual({ dailyBudget: 40, confirmOwnLimits: true })
    expect(notSentPastLimits([LIMIT])).toBe(`Not sent — it goes past your own limits: ${LIMIT.reason}. Choose "Send anyway" to send it.`)
  })
})

describe('askSendAnyway', () => {
  it('no dialog on the page → no: nothing goes past a limit unseen', async () => {
    expect(await askSendAnyway([LIMIT])).toBe(false)
  })
  it('writes that wait together are ONE question, each limit once', async () => {
    const asks: SendAnywayAsk[] = []
    setSendAnywayAsker(async (ask) => { asks.push(ask); return true })
    const answers = await Promise.all([askSendAnyway([LIMIT]), askSendAnyway([LIMIT]), askSendAnyway([{ limit: 'value_cap', reason: 'over the cap' }])])
    expect(answers).toEqual([true, true, true])
    expect(asks).toEqual([{ changes: 3, limits: [LIMIT, { limit: 'value_cap', reason: 'over the cap' }] }])
  })
})

describe('adsWrite — his edit past his own limit', () => {
  const server = (...answers: Array<[number, unknown]>) => {
    const sent: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body))
      const [status, body] = answers[Math.min(sent.length - 1, answers.length - 1)]
      return { status, json: async () => body }
    }))
    return sent
  }

  it('"Send anyway" → the same body again with confirmOwnLimits, and its answer is the result', async () => {
    const sent = server([409, waiting], [200, { ok: true, outboundQueueId: 'q1', error: null }])
    setSendAnywayAsker(async () => true)
    expect(await adsWrite('/api/advertising/campaigns/c-1', { dailyBudget: 40 })).toEqual({ ok: true, outcome: 'queued', reason: null })
    expect(sent).toEqual([{ dailyBudget: 40 }, { dailyBudget: 40, confirmOwnLimits: true }])
  })

  it('Cancel → nothing more is sent, and the screen says why', async () => {
    const sent = server([409, waiting])
    setSendAnywayAsker(async () => false)
    expect(await adsWrite('/api/advertising/campaigns/c-1', { dailyBudget: 40 })).toEqual({ ok: false, outcome: 'refused', reason: notSentPastLimits([LIMIT]) })
    expect(sent).toHaveLength(1)
  })

  it('an Amazon refusal is not a question: it is shown as a refusal', async () => {
    server([200, { ok: false, error: "Not sent to Amazon: bid 1¢ is below Amazon's minimum of €0.02 in IT" }])
    const asker = vi.fn(async () => true)
    setSendAnywayAsker(asker)
    expect(await adsWrite('/api/advertising/ad-targets/t-1', { bidCents: 1 })).toMatchObject({ ok: false, outcome: 'refused' })
    expect(asker).not.toHaveBeenCalled()
  })
})
