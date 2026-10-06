/**
 * W2-B — every builder's launch is one keyed command (CC-24), and the review step reads the server's checks
 * (CC-13, CC-14, CC-21): refusals keep Launch off, warnings never do. The campaign manager's adds are keyed too (CM-33).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandKey, IDEMPOTENCY_KEY_HEADER } from '@/lib/command-key'
import { LAUNCH_UNANSWERED, launchBlocked, launchOutcome, readChecks, sendLaunch } from './launchChecks'
import { adsAdd } from '../_shared/adsWrite'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const counter = () => { let n = 0; return () => `k${++n}` }
afterEach(() => { vi.unstubAllGlobals() })

describe('the review step\'s checks', () => {
  it('reads refusals and warnings from a dry-run answer; anything else is no checks', () => {
    expect(readChecks({ ok: true, dryRun: true, checks: { refusals: ['A campaign needs at least one product.'], warnings: ['Your bid policy …'] } }))
      .toEqual({ refusals: ['A campaign needs at least one product.'], warnings: ['Your bid policy …'] })
    expect(readChecks({ ok: true, checks: { refusals: [1, '', 'x'] } })).toEqual({ refusals: ['x'], warnings: [] })
    expect(readChecks({ ok: true })).toBeNull()
    expect(readChecks(null)).toBeNull()
  })

  it('🔴 a refusal keeps Launch off; warnings alone never do (his settings are not a block)', () => {
    expect(launchBlocked({ refusals: ['IT already has a campaign named "X"'], warnings: [] })).toBe(true)
    expect(launchBlocked({ refusals: [], warnings: ['Your spend ceiling …', 'Your bid policy …'] })).toBe(false)
    expect(launchBlocked(null)).toBe(false) // checks not loaded: the server checks again at launch
  })
})

describe('CC-24 — one launch press, one key', () => {
  it('a launch sends an Idempotency-Key; a lost answer keeps it, so pressing Launch again cannot build twice', async () => {
    const slot = new CommandKey(counter())
    const keys: Array<string | null> = []
    const answers = [() => { throw new TypeError('Failed to fetch') }, () => json(504, {}), () => json(200, { ok: true, created: [] })]
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER))
      return answers.shift()!()
    }))
    expect(await sendLaunch(slot, 'http://api.test/api/advertising/campaign-builder/sp-super-wizard/launch', { market: 'IT' })).toEqual({ ok: false, error: LAUNCH_UNANSWERED })
    expect(await sendLaunch(slot, 'http://api.test/api/advertising/campaign-builder/sp-super-wizard/launch', { market: 'IT' })).toEqual({ ok: false, error: LAUNCH_UNANSWERED })
    expect(await sendLaunch(slot, 'http://api.test/api/advertising/campaign-builder/sp-super-wizard/launch', { market: 'IT' })).toEqual({ ok: true, body: { ok: true, created: [] } })
    expect(keys).toEqual(['k1', 'k1', 'k1'])
    expect(slot.pending).toBeNull() // done: the next press is a new launch
  })

  it('the answer in words: the run still going, the server\'s own refusal, a crash', () => {
    expect(launchOutcome(409, { error: 'The same request is still running. Wait for its result before sending it again.' }, 'running'))
      .toEqual({ ok: false, error: expect.stringMatching(/Your earlier launch is still running on the server/) })
    expect(launchOutcome(400, { ok: false, error: 'A campaign needs at least one product.' }, null)).toEqual({ ok: false, error: 'A campaign needs at least one product.' })
    expect(launchOutcome(200, { ok: false, error: 'no' }, null)).toEqual({ ok: false, error: 'no' })
    expect(launchOutcome(500, { ok: false }, null)).toEqual({ ok: false, error: 'Launch failed (the server answered 500).' })
    expect(launchOutcome(502, null, null)).toEqual({ ok: false, error: LAUNCH_UNANSWERED })
  })
})

describe('CM-33 — a campaign-manager add is one keyed command', () => {
  it('the same add re-sent after a lost answer carries the same key; a different add another one', async () => {
    const keys: Array<string | null> = []
    const answers = [() => json(502, {}), () => json(200, { ok: true, outcome: 'created' }), () => json(200, { ok: true, outcome: 'created' })]
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER))
      return answers.shift()!()
    }))
    const body = { adGroupId: 'g-w2b', keywordText: 'w2b gloves', matchType: 'EXACT', bidEur: 0.4 }
    expect((await adsAdd('/api/advertising/keywords/create', body)).added).toBe(false)
    expect((await adsAdd('/api/advertising/keywords/create', body)).added).toBe(true)
    expect((await adsAdd('/api/advertising/keywords/create', { ...body, keywordText: 'w2b boots' })).added).toBe(true)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
  })
})
