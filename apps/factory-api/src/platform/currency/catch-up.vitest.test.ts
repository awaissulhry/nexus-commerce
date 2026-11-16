import { describe, expect, it } from 'vitest'
import type { EcbDay, EcbFileKind } from '@nexus/factory-domain/money/currency/ecb'
import type { CommandCaller } from '../../core/command'
import { readWithCatchUp, type EcbOutcome, type EcbRuntime } from './feed'

/**
 * B-W2b-GB02 (G058): a missed ECB day is caught up from the 90-day file. The runtime and the newest day kept are stubs
 * (made-up rates); the rows the read keeps and the job: platform/currency's PG test.
 */

const day = (date: string): EcbDay => ({ day: date, rates: [{ currency: 'JPY', rate: '160.00000000' }] })

function stubs(newestKept: string | null, answers: Partial<Record<EcbFileKind, EcbOutcome>>) {
  const asked: EcbFileKind[] = []
  const runtime: EcbRuntime = {
    fake: null,
    read: async (_caller, _account, file = 'daily') => (asked.push(file), answers[file]!),
  }
  const caller = {
    withClient: async (work: (client: unknown) => Promise<unknown>) =>
      work({ exchangeRate: { findFirst: async () => (newestKept ? { rateDate: new Date(`${newestKept}T00:00:00.000Z`) } : null) } }),
  } as unknown as CommandCaller
  return { runtime, caller, asked }
}

describe('a missed ECB day (G058)', () => {
  it('reads only today\'s file when nothing was missed, or nothing was kept yet', async () => {
    const onTime = stubs('2026-11-13', { daily: { ok: true, days: [day('2026-11-16')] } })
    expect(await readWithCatchUp(onTime.runtime, onTime.caller, 'acc')).toEqual({ ok: true, days: [day('2026-11-16')] })
    expect(onTime.asked).toEqual(['daily'])
    const first = stubs(null, { daily: { ok: true, days: [day('2026-11-16')] } })
    await readWithCatchUp(first.runtime, first.caller, 'acc')
    expect(first.asked).toEqual(['daily'])
  })

  it('reads the 90-day file after a missed working day and keeps its days with today\'s, each once', async () => {
    const late = stubs('2026-11-11', { daily: { ok: true, days: [day('2026-11-16')] }, last90: { ok: true, days: [day('2026-11-16'), day('2026-11-13'), day('2026-11-12'), day('2026-11-11')] } })
    expect(await readWithCatchUp(late.runtime, late.caller, 'acc')).toEqual({
      ok: true,
      days: [day('2026-11-16'), day('2026-11-13'), day('2026-11-12'), day('2026-11-11')],
      missed: ['2026-11-12', '2026-11-13'],
    })
    expect(late.asked).toEqual(['daily', 'last90'])
  })

  it('keeps today\'s file when the 90-day file fails, and says so; a failed daily file asks nothing more', async () => {
    const broken = stubs('2026-11-11', { daily: { ok: true, days: [day('2026-11-16')] }, last90: { ok: false, problem: 'The ECB answered HTTP 503.' } })
    expect(await readWithCatchUp(broken.runtime, broken.caller, 'acc')).toEqual({ ok: true, days: [day('2026-11-16')], missed: ['2026-11-12', '2026-11-13'], catchUpProblem: 'The ECB answered HTTP 503.' })
    const down = stubs('2026-11-11', { daily: { ok: false, problem: 'The ECB answered HTTP 503.' } })
    expect(await readWithCatchUp(down.runtime, down.caller, 'acc')).toEqual({ ok: false, problem: 'The ECB answered HTTP 503.' })
    expect(down.asked).toEqual(['daily'])
  })
})
