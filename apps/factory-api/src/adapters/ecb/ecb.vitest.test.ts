import { describe, expect, it } from 'vitest'
import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import { ecbFileOf } from '@nexus/factory-domain/money/currency/ecb'
import { fixedClock } from '@nexus/factory-domain/core/time'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { FakeEcb, fakeDay, fakeLast90, lastWeekday } from './fake'
import { ECB_DAILY_URL, ECB_LAST90_URL, ecbHttpAdapter } from './http'

/**
 * The ECB adapters (B-W2b-389) without the network: the HTTP one over a scripted transport (the ECB's file shape, made-up
 * rates), and the FAKE. The gateway around them, the rows they write and the daily job: platform/currency's PG tests.
 */

function callFor(mode: IntegrationMode): GatewayCall & { answers: unknown[] } {
  const answers: unknown[] = []
  return {
    account: { id: '00000000-0000-7000-8000-000000000001', tenantId: '00000000-0000-7000-8000-000000000002', companyId: null, provider: 'ECB', mode, settings: null },
    attempt: 1,
    signal: new AbortController().signal,
    idempotencyKey: null,
    credentials: async () => null,
    answer: (details) => answers.push(details),
    answers,
  }
}

const file = ecbFileOf([{ day: '2026-11-13', rates: [{ currency: 'USD', rate: '1.0861' }, { currency: 'GBP', rate: '0.8512' }] }])

describe('the HTTP adapter', () => {
  it('reads the public daily file and keeps the body hash', async () => {
    const asked: string[] = []
    const adapter = ecbHttpAdapter({ fetch: async (input) => (asked.push(String(input)), new Response(file, { status: 200 })) })
    const call = callFor('LIVE')
    const answer = await adapter.daily(call)
    expect(asked).toEqual([ECB_DAILY_URL])
    expect(answer.days).toEqual([{ day: '2026-11-13', rates: [{ currency: 'USD', rate: '1.08610000' }, { currency: 'GBP', rate: '0.85120000' }] }])
    expect(answer.responseSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(call.answers).toEqual([{ httpStatus: 200, response: { days: [{ day: '2026-11-13', rates: 2 }] } }])
  })

  // ---- B-W2b-GB02 (G058)
  it('reads the 90-day file when asked (a missed day caught up)', async () => {
    const asked: string[] = []
    const adapter = ecbHttpAdapter({ fetch: async (input) => (asked.push(String(input)), new Response(file, { status: 200 })) })
    await adapter.daily(callFor('LIVE'), 'last90')
    await adapter.daily(callFor('LIVE'))
    expect(asked).toEqual([ECB_LAST90_URL, ECB_DAILY_URL])
  })
  // ---- end B-W2b-GB02

  it('fails in words: a 5xx may pass later, an unreadable file does not, a FAKE account never calls out', async () => {
    const busy = ecbHttpAdapter({ fetch: async () => new Response('busy', { status: 503 }) })
    await expect(busy.daily(callFor('LIVE'))).rejects.toMatchObject({ name: 'ProviderError', retryable: true, httpStatus: 503 })
    const broken = ecbHttpAdapter({ fetch: async () => new Response('<html>maintenance</html>', { status: 200 }) })
    await expect(broken.daily(callFor('SANDBOX'))).rejects.toMatchObject({ retryable: false, message: 'The ECB file has no day of rates.' })
    let called = false
    const never = ecbHttpAdapter({ fetch: async () => ((called = true), new Response(file)) })
    await expect(never.daily(callFor('FAKE'))).rejects.toBeInstanceOf(ProviderError)
    expect(called).toBe(false)
  })
})

describe('the FAKE file', () => {
  it('answers the last weekday with made-up rates, the same each time, and scripted answers', async () => {
    expect(lastWeekday('2026-11-14')).toBe('2026-11-13')
    expect(lastWeekday('2026-11-16')).toBe('2026-11-16')
    const fake = new FakeEcb(fixedClock('2026-11-15T10:00:00.000Z'))
    const first = await fake.daily(callFor('FAKE'))
    expect(first.days).toHaveLength(1)
    expect(first.days[0]!.day).toBe('2026-11-13')
    expect(first.days[0]!.rates).toHaveLength(29)
    // USD is the first made-up figure: 1.0000 × 1.013.
    expect(first.days[0]!.rates[0]).toEqual({ currency: 'USD', rate: '1.01300000' })
    expect(fakeDay('2026-11-13')).toEqual(fakeDay('2026-11-13'))
    fake.answerNext([{ day: '2026-11-12', rates: [{ currency: 'USD', rate: '1.0850' }] }])
    expect((await fake.daily(callFor('FAKE'))).days).toEqual([{ day: '2026-11-12', rates: [{ currency: 'USD', rate: '1.08500000' }] }])
    fake.failNext(1)
    await expect(fake.daily(callFor('FAKE'))).rejects.toMatchObject({ httpStatus: 503, retryable: true })
    expect(fake.reads).toBe(3)
    // B-W2b-GB02 (G058): the fake's 90-day file: every weekday of the last 90 days, newest first.
    const last90 = await fake.daily(callFor('FAKE'), 'last90')
    expect(last90.days[0]!.day).toBe('2026-11-13')
    expect(last90.days.map((entry) => entry.day)).toEqual(fakeLast90('2026-11-15').map((entry) => entry.day))
    expect(last90.days.every((entry) => ![0, 6].includes(new Date(`${entry.day}T00:00:00.000Z`).getUTCDay()))).toBe(true)
    expect(last90.days.length).toBeGreaterThan(60)
    expect(fake.files).toEqual(['daily', 'daily', 'daily', 'last90'])
    await expect(fake.daily(callFor('LIVE'))).rejects.toMatchObject({ retryable: false })
  })
})
