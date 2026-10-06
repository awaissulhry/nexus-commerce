import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLANS_PATH, planLine, planOutcome, planRevertRequest, planSwitchRequest, planTitle, revertImpact, sendPlanRequest, switchImpact,
  type ProductRankPlan,
} from './productPlans'

/**
 * OC (2026-10-06) — the "Product rank plans" section on Hourly Bids: its Switch on / Switch off and Put placement back
 * buttons reach the plan routes that stayed for them (the API side is apps/api/src/routes/rank-plans-control).
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
const routes = readFileSync(join(REPO, 'apps/api/src/routes/advertising.routes.ts'), 'utf8')

const plan = (over: Partial<ProductRankPlan> = {}): ProductRankPlan => ({
  id: 'plan-1', productId: 'prod-1', parentAsin: 'PARENT-ASIN', marketplace: 'IT', enabled: true, manualOnly: false,
  pausedAt: null, lastEvaluatedAt: null, ...over,
})

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('the plan buttons send the requests the routes answer', () => {
  it('Switch off / Switch on → PATCH /api/advertising/rank-plans/:id { enabled }', () => {
    expect(planSwitchRequest('plan-1', false)).toEqual({ method: 'PATCH', path: '/api/advertising/rank-plans/plan-1', body: { enabled: false } })
    expect(planSwitchRequest('plan-1', true).body).toEqual({ enabled: true })
  })

  it('Put placement back → POST /api/advertising/rank-plans/:id/revert', () => {
    expect(planRevertRequest('plan 1')).toEqual({ method: 'POST', path: '/api/advertising/rank-plans/plan%201/revert', body: {} })
  })

  it('the API still registers those routes, and the switch route takes `enabled`', () => {
    expect(PLANS_PATH).toBe('/api/advertising/rank-plans')
    expect(routes).toContain("fastify.get('/advertising/rank-plans',")
    expect(routes).toContain("fastify.patch('/advertising/rank-plans/:id',")
    expect(routes).toContain("fastify.post('/advertising/rank-plans/:id/revert',")
    const patch = routes.slice(routes.indexOf("fastify.patch('/advertising/rank-plans/:id',"))
    expect(patch.slice(0, patch.indexOf('fastify.', 10))).toMatch(/'enabled'/)
  })

  it('the panel wires each button to its request', () => {
    const panel = readFileSync(join(HERE, 'ProductPlansPanel.tsx'), 'utf8')
    expect(panel).toContain("planSwitchRequest(p.id, kind === 'on')")
    expect(panel).toContain('planRevertRequest(p.id)')
    expect(panel).toContain("act(p, p.enabled ? 'off' : 'on')")
    expect(panel).toContain("act(p, 'revert')")
    expect(panel).toContain('`${getBackendUrl()}${PLANS_PATH}`')
  })

  it('sends the switch to the API and reads a 200 as done', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://api.test')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'plan-1', enabled: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const a = await sendPlanRequest(planSwitchRequest('plan-1', false))
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/advertising/rank-plans/plan-1', expect.objectContaining({ method: 'PATCH', body: '{"enabled":false}' }))
    expect(a.ok).toBe(true)
  })

  it('a 404 is "nothing changed", with the reason', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://api.test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })))
    const a = await sendPlanRequest(planSwitchRequest('gone', false))
    expect(a.ok).toBe(false)
    expect(planOutcome(plan(), 'off', a)).toEqual({ tone: 'warning', text: 'Nothing changed on PARENT-ASIN · IT: not found' })
  })

  it('no answer is "nothing changed" too, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const a = await sendPlanRequest(planRevertRequest('plan-1'))
    expect(a).toEqual({ ok: false, reason: 'No answer from the server.', body: null })
  })
})

describe('what the section says', () => {
  it('names the plan by its parent ASIN (or product) and market', () => {
    expect(planTitle(plan())).toBe('PARENT-ASIN · IT')
    expect(planTitle(plan({ parentAsin: null }))).toBe('Product prod-1 · IT')
  })

  it('says whether the run applies it', () => {
    expect(planLine(plan())).toMatch(/^On: the hourly bid run applies it every 15 minutes while that engine is switched on\. Never run\.$/)
    expect(planLine(plan({ manualOnly: true }))).toMatch(/^On, but set to manual only: the hourly bid run reads it and writes nothing\./)
    expect(planLine(plan({ enabled: false }))).toMatch(/^Off: the hourly bid run leaves it alone\./)
  })

  it('says when the blast-radius guard switched it off, and warns before switching it back on', () => {
    const guarded = plan({ enabled: false, lastSummary: { autoPaused: true, reason: 'family resolved to 9 campaigns > maxCampaigns 4' } })
    expect(planLine(guarded)).toContain('The blast-radius guard switched it off: family resolved to 9 campaigns > maxCampaigns 4.')
    expect(switchImpact(guarded, true).consequences?.join(' ')).toContain('switches it off again')
    expect(switchImpact(plan(), true).consequences?.join(' ')).not.toContain('switches it off again')
  })

  it('asks before each change, and says a switched-on plan sets the placement again', () => {
    expect(switchImpact(plan(), false)).toMatchObject({ level: 'confirm', title: 'Switch off the product rank plan PARENT-ASIN · IT?', reach: 'channel' })
    expect(revertImpact(plan()).consequences?.join(' ')).toContain('its next run sets the hour\'s placement % again')
    expect(revertImpact(plan({ enabled: false })).consequences?.join(' ')).not.toContain('next run')
  })

  it('reports a revert by its count, and a partial one as a warning', () => {
    const p = plan()
    expect(planOutcome(p, 'revert', { ok: true, reason: null, body: { reverted: 2, campaigns: 2, toPct: 0 } }))
      .toEqual({ tone: 'success', text: 'Top-of-search set to 0% on 2 campaigns of PARENT-ASIN · IT.' })
    expect(planOutcome(p, 'revert', { ok: true, reason: null, body: { reverted: 1, campaigns: 3, toPct: 25 } }).tone).toBe('warning')
  })
})
