/**
 * Ads brain page A2a — brainLeverState (brain/lever-state.ts): what the brain really does with one lever now, from its
 * resolved level, the server switches, the lever's own gate, the Owner's kill and the account — one row per lever.
 *
 *   level     not enrolled, excluded, locked and OFF do nothing; OBSERVE watches with the lever's own words
 *   switch    under a shadow NEXUS_BID_BRAIN_MODE an AUTO lever watches and says so; PROPOSE asks where its writer asks
 *             whatever the switch (state, hours, bidding strategy)
 *   gates     negatives: their shadow days; harvest and structure: their own switches; bidding strategy: the product
 *             cycle and the N4 clock
 *   holds     the Owner's kill switch; a halted account (every AUTO writer); SUGGEST (the writers that read the posture)
 *   loads     the runtime from the real switches (vi.stubEnv)
 *
 * Values are made up (public repo).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))
vi.mock('../ads-automation-state.service.js', () => ({
  getAutomationState: async () => ({ degraded: false, halted: false, haltReason: null, autonomy: 'AUTO' }),
}))

const { brainLeverState, loadLeverRuntime } = await import('./lever-state.js')
type Runtime = Parameters<typeof brainLeverState>[1]

const LIVE: Runtime = {
  ceiling: 'live', ceilingLive: true, cycleOn: true, hoursOn: true,
  harvest: { live: true, why: 'the harvest\'s env ceiling is live' },
  structure: { live: true, why: 'the structure\'s env ceiling is live' },
  posture: { posture: 'auto', why: 'the account ads dial is AUTO' },
}
const SHADOW: Runtime = {
  ...LIVE, ceiling: 'shadow', ceilingLive: false,
  harvest: { live: false, why: 'the brain\'s env ceiling NEXUS_BID_BRAIN_MODE is not live' },
  structure: { live: false, why: 'the brain\'s env ceiling NEXUS_BID_BRAIN_MODE is not live' },
}
const PAST_SHADOW = { inShadow: false, why: null }

describe('the level', () => {
  it('not enrolled, excluded, locked and OFF do nothing; OBSERVE watches in the lever\'s own words', () => {
    expect(brainLeverState({ lever: 'negatives', effective: 'NOT_ENROLLED' }, LIVE)).toEqual({ state: 'off', why: 'the product is not enrolled in the brain: today\'s engines run it' })
    expect(brainLeverState({ lever: 'negatives', effective: 'EXCLUDED' }, LIVE).state).toBe('off')
    expect(brainLeverState({ lever: 'budgets', effective: 'LOCKED' }, LIVE).why).toMatch(/Owner's own value/)
    expect(brainLeverState({ lever: 'state', effective: 'OFF' }, LIVE).state).toBe('off')
    const observe = brainLeverState({ lever: 'harvest', effective: 'OBSERVE' }, LIVE)
    expect(observe.state).toBe('watches')
    expect(observe.why).toMatch(/^OBSERVE: AB-11: OBSERVE logs each harvest in shadow/)
  })
})

describe('the server switch', () => {
  it('under a shadow switch every AUTO lever watches and names the switch', () => {
    for (const lever of ['bids', 'state', 'budgets', 'portfolioCap'] as const) {
      const s = brainLeverState({ lever, effective: 'AUTO' }, SHADOW)
      expect(s.state, lever).toBe('watches')
      expect(s.why, lever).toContain('NEXUS_BID_BRAIN_MODE is shadow')
    }
    expect(brainLeverState({ lever: 'negatives', effective: 'AUTO', negativesShadow: { inShadow: true, why: 'the server switch NEXUS_BID_BRAIN_MODE is not live: the brain decides and logs, and writes and asks nothing' } }, SHADOW).state).toBe('watches')
  })

  it('PROPOSE asks where its writer asks whatever the switch; the money levers wait for the live switch', () => {
    expect(brainLeverState({ lever: 'state', effective: 'PROPOSE' }, SHADOW).state).toBe('asks')
    expect(brainLeverState({ lever: 'hours', effective: 'PROPOSE' }, SHADOW).state).toBe('asks')
    expect(brainLeverState({ lever: 'biddingStrategy', effective: 'PROPOSE' }, SHADOW).state).toBe('asks')
    expect(brainLeverState({ lever: 'budgets', effective: 'PROPOSE' }, SHADOW).state).toBe('watches')
    expect(brainLeverState({ lever: 'budgets', effective: 'PROPOSE' }, LIVE)).toEqual({ state: 'asks', why: 'PROPOSE: the brain asks a person for each change in the Approvals page (AB-8)' })
  })

  it('under the live switch and a running account every AUTO writer acts', () => {
    const facts = { negativesShadow: PAST_SHADOW, strategyAsks: null }
    for (const lever of ['bids', 'state', 'budgets', 'portfolioCap', 'negatives', 'harvest', 'biddingStrategy'] as const) {
      expect(brainLeverState({ lever, effective: 'AUTO', ...facts }, LIVE).state, lever).toBe('acts')
    }
  })
})

describe('each lever\'s own gate', () => {
  it('negatives: inside the shadow days they watch, naming them; not measured counts as shadow', () => {
    const shadow = brainLeverState({ lever: 'negatives', effective: 'AUTO', negativesShadow: { inShadow: true, why: 'the negatives lever runs 14 days in shadow first: 5 days run' } }, LIVE)
    expect(shadow).toEqual({ state: 'watches', why: 'AUTO, but in shadow for now: the negatives lever runs 14 days in shadow first: 5 days run' })
    expect(brainLeverState({ lever: 'negatives', effective: 'PROPOSE', negativesShadow: PAST_SHADOW }, LIVE).state).toBe('asks')
    expect(brainLeverState({ lever: 'negatives', effective: 'AUTO' }, LIVE).why).toMatch(/could not measure/)
  })

  it('harvest and structure: their own switches, named', () => {
    const harvest = brainLeverState({ lever: 'harvest', effective: 'AUTO' }, { ...LIVE, harvest: { live: false, why: 'the harvest\'s env ceiling NEXUS_ADS_BRAIN_HARVEST_MODE is shadow' } })
    expect(harvest.state).toBe('watches')
    expect(harvest.why).toContain('NEXUS_ADS_BRAIN_HARVEST_MODE is shadow')
    const structure = brainLeverState({ lever: 'structure', effective: 'PROPOSE' }, { ...LIVE, structure: { live: false, why: 'the structure\'s env ceiling NEXUS_ADS_BRAIN_STRUCTURE_MODE is shadow' } })
    expect(structure).toMatchObject({ state: 'watches', why: expect.stringContaining('NEXUS_ADS_BRAIN_STRUCTURE_MODE') })
  })

  it('bidding strategy: only in the product cycle; N4 asks first; then it acts', () => {
    expect(brainLeverState({ lever: 'biddingStrategy', effective: 'AUTO', strategyAsks: null }, { ...LIVE, cycleOn: false })).toMatchObject({ state: 'off', why: expect.stringContaining('NEXUS_ADS_BRAIN_CYCLE is off') })
    const n4 = 'AUTO, but for the first 30 days the lever is the brain\'s (since 2026-10-01) every switch asks a person (N4) — it switches alone from 2026-10-31'
    expect(brainLeverState({ lever: 'biddingStrategy', effective: 'AUTO', strategyAsks: { why: n4 } }, LIVE)).toEqual({ state: 'asks', why: n4 })
    expect(brainLeverState({ lever: 'biddingStrategy', effective: 'AUTO' }, LIVE)).toMatchObject({ state: 'asks', why: expect.stringContaining('could not measure the N4') })
    expect(brainLeverState({ lever: 'biddingStrategy', effective: 'AUTO', strategyAsks: null }, SHADOW).state).toBe('watches')
  })

  it('hours: nothing paints the plan when its cron is off and the cycle is off', () => {
    expect(brainLeverState({ lever: 'hours', effective: 'PROPOSE' }, { ...LIVE, hoursOn: false, cycleOn: false }).state).toBe('off')
    expect(brainLeverState({ lever: 'hours', effective: 'PROPOSE' }, { ...LIVE, hoursOn: false, cycleOn: true }).state).toBe('asks')
  })
})

describe('what holds a lever the Owner gave the brain', () => {
  it('the Owner\'s kill switch: it only watches, in his words', () => {
    const killed = 'stopped by the Owner\'s kill switch (user:owner, 2026-10-09, product p1 in IT): "testing"'
    expect(brainLeverState({ lever: 'budgets', effective: 'AUTO', killed }, LIVE)).toEqual({ state: 'watches', why: `AUTO, but ${killed}: the brain decides and logs, and writes and asks nothing` })
    expect(brainLeverState({ lever: 'state', effective: 'PROPOSE', killed }, LIVE).state).toBe('watches')
  })

  it('a halted account holds every AUTO writer; SUGGEST holds the ones that read the posture', () => {
    const halted = { ...LIVE, posture: { posture: 'stopped' as const, why: 'halted: a test' } }
    for (const lever of ['bids', 'state', 'budgets', 'negatives', 'harvest', 'biddingStrategy'] as const) {
      expect(brainLeverState({ lever, effective: 'AUTO', negativesShadow: PAST_SHADOW, strategyAsks: null }, halted).state, lever).toBe('watches')
    }
    const suggest = { ...LIVE, posture: { posture: 'suggest' as const, why: 'the account ads dial is SUGGEST' } }
    expect(brainLeverState({ lever: 'state', effective: 'AUTO' }, suggest).state).toBe('watches')
    expect(brainLeverState({ lever: 'negatives', effective: 'AUTO', negativesShadow: PAST_SHADOW }, suggest).state).toBe('acts')
    // Asking a person is not stopped by the account: an approved change runs as that person's own edit.
    expect(brainLeverState({ lever: 'state', effective: 'PROPOSE' }, halted).state).toBe('asks')
  })

  it('a lever with no writer of the brain yet never claims to act', () => {
    for (const lever of ['adGroupBids', 'placements', 'offAmazon'] as const) {
      expect(brainLeverState({ lever, effective: 'AUTO' }, LIVE).state, lever).toBe('watches')
    }
  })
})

describe('loadLeverRuntime — the real switches', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reads each switch with its own reader', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_ADS_BRAIN_HARVEST_MODE', 'live')
    vi.stubEnv('NEXUS_ADS_BRAIN_STRUCTURE_MODE', '')
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    vi.stubEnv('NEXUS_ADS_BRAIN_HOURS', '0')
    vi.stubEnv('NEXUS_ADS_AUTOMATION_KILL', '')
    const rt = await loadLeverRuntime()
    expect(rt).toMatchObject({ ceiling: 'live', ceilingLive: true, cycleOn: true, hoursOn: false, harvest: { live: true }, structure: { live: false }, posture: { posture: 'auto' } })
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
    expect(await loadLeverRuntime()).toMatchObject({ ceiling: 'shadow', ceilingLive: false, harvest: { live: false } })
  })
})
