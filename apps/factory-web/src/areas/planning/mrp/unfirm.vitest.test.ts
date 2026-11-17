import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { unfirmLine, type PlanLine } from './api'
import { designScreen } from './fixtures'
import { MRP_NAMESPACE, unfirmHeld } from './model'

/**
 * W1-BGF (the W1 browser stages' repair) — "Plan it again (not firm)" on a Buy line of What to buy & make. B-W2a-22 carries a
 * firm planned order from the earlier plan, and Draft PO buys the firm quantity, not what the plan suggests for every order
 * (the golden world: the seeded order's 4 hides firm, 7 hides suggested). The API golden flow takes the firm order back
 * (POST /planning/requirements/:id/unfirm); the screen had no way to: the row's ⋯ now has it, held in words.
 */

const plan = designScreen.cases.find((item) => item.id === 'short-wo')!.model.model.plan
const LINES: PlanLine[] = plan.status === 'ready' ? plan.value.lines : []
const FIRM = LINES.find((line) => line.firm)!

function mockApi(answer: { status: number; body: unknown }): { api: ApiClient; calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> } {
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('Plan it again (not firm)', () => {
  it('is open on a firm, open line to a role that may change firm orders; held in words otherwise', () => {
    expect(FIRM.decision).toBe('OPEN')
    expect(unfirmHeld(FIRM, true)).toBeNull()
    expect(unfirmHeld(FIRM, false)).toBe('held.noFirm')
    expect(unfirmHeld({ ...FIRM, firm: null }, true)).toBe('held.notFirm')
    expect(unfirmHeld({ ...FIRM, decision: 'ORDERED' }, true)).toBe('held.lineNotOpen')
    for (const locale of ['en', 'it'] as const) {
      const w = createTranslator(locale, messagesFor(locale, [MRP_NAMESPACE])[MRP_NAMESPACE] ?? {})
      for (const key of ['held.noFirm', 'held.notFirm', 'held.lineNotOpen', 'unfirm.menu', 'notice.unfirmed']) expect(w(key, { material: 'X' }), `${locale} ${key}`).not.toBe(key)
      expect(w('unfirm.hint', { quantity: '7', unit: 'hides' })).toContain('7 hides')
    }
  })

  it('takes the firm order back as the API asks: the line and its version, with an idempotency key', async () => {
    const { api, calls } = mockApi({ status: 200, body: { line: { ...FIRM, firm: null, version: FIRM.version + 1 }, replayed: false } })
    const line = await unfirmLine(api, FIRM.id, FIRM.version)
    expect(line).toMatchObject({ id: FIRM.id, firm: null, version: FIRM.version + 1 })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/planning/requirements/${FIRM.id}/unfirm`, body: { version: FIRM.version } })
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy()
  })
})
