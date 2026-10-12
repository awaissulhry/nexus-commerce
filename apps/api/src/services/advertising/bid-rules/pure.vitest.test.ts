/**
 * Bid page — the pure half of the bid-rules API: the honest mode, the sentence, the next run and the effect. Made-up
 * numbers only (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  actionOutcome, autoGateHold, brainMode, brainNextFullRun, brainStopOf, brainScheduleWords, effectOf, effectUnchanged, effectWindows, HOLDS, isBidRule, nextQuarter,
  ruleMode, ruleNextRun, ruleRunTimes, ruleSentence, scheduleWords, shortDay,
  type Hold, type RuleModeFacts,
} from './pure.js'
import { scheduleIsDue } from '../ads-rule-schedule.js'

/** Only kind and label: the reasons are checked on their own below. */
const chip = (h: Hold | null) => (h ? { kind: h.kind, label: h.label } : null)
const chips = <M extends { heldBy: Hold | null; also: Hold[]; autoLocked: Hold | null }>(m: M) => ({ ...m, heldBy: chip(m.heldBy), also: m.also.map(chip), autoLocked: chip(m.autoLocked) })

const split = (total: number, open: number, locked: number, brain: number, market = 0, brainStopped = 0) => ({ total, open, locked, brain, market, brainStopped })
const facts = (over: Partial<RuleModeFacts> = {}): RuleModeFacts => ({
  level: 'AUTO', archived: false,
  account: { autonomy: 'AUTO', halted: false, killed: false, degraded: false },
  adsLive: true, ceiling: 'AUTO', manualBelt: false, matchesCapHit: false, writeCapHit: false, valueCapZero: false,
  campaigns: { total: 2, open: 2, locked: 0, market: 0, brain: 0, brainStopped: 0 }, autoGate: null,
  ...over,
})

describe('ruleMode — what the Owner set against what really acts', () => {
  it('Auto that nothing holds acts Auto', () => {
    expect(ruleMode(facts())).toEqual({ set: 'AUTO', acts: 'AUTO', heldBy: null, also: [], autoLocked: null })
  })
  it('the account dial on Ask me turns Auto into Ask, and leaves Watch and Ask alone', () => {
    const suggest = { autonomy: 'SUGGEST' as const, halted: false, killed: false, degraded: false }
    expect(ruleMode(facts({ account: suggest }))).toMatchObject({ set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'Account: Ask me' } })
    expect(ruleMode(facts({ level: 'PROPOSE', account: suggest }))).toMatchObject({ set: 'ASK', acts: 'ASK', heldBy: null })
    expect(ruleMode(facts({ level: 'OBSERVE', account: suggest }))).toMatchObject({ set: 'WATCH', acts: 'WATCH', heldBy: null })
  })
  it('a stopped account stops every level; Off stays Off with nothing holding it', () => {
    expect(ruleMode(facts({ account: { autonomy: 'AUTO', halted: true, killed: false, degraded: false } }))).toMatchObject({ acts: 'OFF', heldBy: { kind: 'stopped', label: 'Ads halted' } })
    expect(ruleMode(facts({ level: 'PROPOSE', account: { autonomy: 'OFF', halted: false, killed: false, degraded: false } }))).toMatchObject({ acts: 'OFF', heldBy: { kind: 'dial', label: 'Account: Off' } })
    expect(ruleMode(facts({ level: 'OFF', account: { autonomy: 'OFF', halted: true, killed: true, degraded: false } }))).toMatchObject({ set: 'OFF', acts: 'OFF', heldBy: null })
  })
  it('the graduation ceiling, the Manual belt and the daily caps', () => {
    expect(ruleMode(facts({ ceiling: 'PROPOSE' }))).toMatchObject({ acts: 'ASK', heldBy: { kind: 'graduation' } })
    expect(ruleMode(facts({ manualBelt: true }))).toMatchObject({ acts: 'ASK', heldBy: { kind: 'manual' } })
    // The belt makes a Watch rule ask (evaluateRule proposes whenever the belt is Manual).
    expect(ruleMode(facts({ level: 'OBSERVE', manualBelt: true }))).toMatchObject({ set: 'WATCH', acts: 'ASK', heldBy: { kind: 'manual' } })
    expect(ruleMode(facts({ writeCapHit: true }))).toMatchObject({ acts: 'ASK', heldBy: { kind: 'cap', label: 'Change limit reached' } })
    expect(ruleMode(facts({ level: 'PROPOSE', matchesCapHit: true }))).toMatchObject({ acts: 'OFF', heldBy: { kind: 'cap', label: 'Daily limit reached' } })
    expect(ruleMode(facts({ level: 'PROPOSE', valueCapZero: true }))).toMatchObject({ set: 'ASK', acts: 'WATCH', heldBy: { kind: 'cap', label: 'Run limit 0' } })
    // The reasons name the limit.
    expect(ruleMode(facts({ writeCapHit: true, caps: { writesPerDay: 5 } })).heldBy?.reason).toBe('It made its 5 changes a day; until tomorrow (UTC) it asks you instead.')
    expect(ruleMode(facts({ level: 'PROPOSE', matchesCapHit: true, caps: { matchesPerDay: 1 } })).heldBy?.reason).toBe('It reached its 1 keyword a day; it runs again tomorrow (UTC).')
    // The ceiling's reason follows what sets it.
    expect(ruleMode(facts({ ceiling: 'PROPOSE', ceilingBlockedBy: ['pause_target'] })).heldBy).toMatchObject({ label: 'Always asks', reason: 'Pausing or unpausing a keyword always waits for your yes.' })
    expect(ruleMode(facts({ ceiling: 'PROPOSE', ceilingBlockedBy: ['add_negative_exact'] })).heldBy).toMatchObject({ label: 'Always asks', reason: 'One of its actions always waits for your yes.' })
  })
  it('the first hold is the one named; the holds behind it are kept in `also`', () => {
    const suggest = { autonomy: 'SUGGEST' as const, halted: false, killed: false, degraded: false }
    expect(ruleMode(facts({ account: suggest, writeCapHit: true }))).toMatchObject({ acts: 'ASK', heldBy: { kind: 'dial', label: 'Account: Ask me' } })
    expect(chips(ruleMode(facts({ account: suggest, campaigns: split(1, 0, 1, 0) })))).toEqual({
      set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'Account: Ask me' }, also: [{ kind: 'allowlist', label: 'Campaigns locked' }], autoLocked: null,
    })
    expect(ruleMode(facts({ ceiling: 'PROPOSE', adsLive: false })).also.map(chip)).toEqual([{ kind: 'gate', label: 'Amazon test mode' }])
  })
  it('the write gate: test mode, every campaign locked, some locked, the brain\'s campaigns', () => {
    expect(ruleMode(facts({ adsLive: false }))).toMatchObject({ acts: 'WATCH', heldBy: { kind: 'gate', label: 'Amazon test mode' } })
    expect(ruleMode(facts({ campaigns: split(2, 0, 2, 0) }))).toMatchObject({ acts: 'WATCH', heldBy: { kind: 'allowlist', label: 'Campaigns locked' } })
    expect(ruleMode(facts({ level: 'PROPOSE', campaigns: split(2, 0, 2, 0) }))).toMatchObject({ acts: 'ASK', heldBy: { kind: 'allowlist' } })
    expect(chips(ruleMode(facts({ campaigns: split(3, 1, 1, 1) })))).toMatchObject({ acts: 'AUTO', heldBy: null, also: [{ kind: 'brain', label: '1 brain campaign' }, { kind: 'allowlist', label: '1 campaign locked' }] })
    expect(chips(ruleMode(facts({ campaigns: split(2, 0, 0, 2) })))).toMatchObject({ acts: 'AUTO', heldBy: { kind: 'brain', label: 'Brain decides' }, also: [] })
    expect(chips(ruleMode(facts({ campaigns: split(4, 0, 2, 2) })))).toMatchObject({ acts: 'AUTO', heldBy: { kind: 'brain', label: 'Brain decides' }, also: [{ kind: 'allowlist', label: '2 campaigns locked' }] })
    expect(ruleMode(facts({ campaigns: split(0, 0, 0, 0) }))).toMatchObject({ acts: 'OFF', heldBy: { kind: 'scope', label: 'No campaigns' } })
  })
  it('the reasons say which campaigns: the first three by name, then how many more', () => {
    const names = { locked: ['Alpha exact', 'Beta broad', 'Gamma phrase', 'Delta auto', 'Epsilon exact'], brain: ['Zeta exact'] }
    const m = ruleMode(facts({ campaigns: { ...split(7, 1, 5, 1), names } }))
    expect(m.also).toEqual([
      { kind: 'brain', label: '1 brain campaign', reason: 'The brain sets the bids there, so this rule\'s change goes to the brain: Zeta exact.' },
      { kind: 'allowlist', label: '5 campaigns locked', reason: 'Not on the live-change list, bids held by hand, or the account takes no changes: Alpha exact, Beta broad, Gamma phrase +2.' },
    ])
    expect(ruleMode(facts({ campaigns: { ...split(5, 0, 5, 0), names } })).heldBy?.reason).toMatch(/: Alpha exact, Beta broad, Gamma phrase \+2\.$/)
  })
  it('a market Nexus has no Amazon bid limits for and a brain the kill switch stops: nothing moves there', () => {
    expect(chips(ruleMode(facts({ campaigns: split(1, 0, 0, 0, 1) })))).toMatchObject({ acts: 'WATCH', heldBy: { kind: 'gate', label: 'Market not set up' }, also: [] })
    expect(chips(ruleMode(facts({ campaigns: split(3, 1, 0, 0, 2) })))).toMatchObject({ acts: 'AUTO', heldBy: null, also: [{ kind: 'gate', label: '2 campaigns not set up' }] })
    // Every campaign the brain's, its bids stopped: not "Brain decides" on Auto — it only watches.
    expect(chips(ruleMode(facts({ campaigns: split(2, 0, 0, 0, 0, 2) })))).toMatchObject({ acts: 'WATCH', heldBy: { kind: 'stopped', label: 'Brain off' } })
    expect(chips(ruleMode(facts({ campaigns: split(3, 0, 0, 1, 0, 2) })))).toMatchObject({ acts: 'AUTO', heldBy: { kind: 'brain', label: 'Brain decides' }, also: [{ kind: 'stopped', label: '2 stopped campaigns' }] })
  })
  it('Auto locked: shown only for a rule not on Auto; an archived rule is Off with no hold and no Auto lock (the row says archived)', () => {
    const gate = HOLDS.autoAfterRuns(4, 10)
    expect(ruleMode(facts({ level: 'PROPOSE', autoGate: gate })).autoLocked).toEqual(gate)
    expect(ruleMode(facts({ autoGate: gate })).autoLocked).toBeNull()
    expect(ruleMode(facts({ archived: true, autoGate: gate }))).toEqual({ set: 'OFF', acts: 'OFF', heldBy: null, also: [], autoLocked: null })
  })
  it('R15 — an Off rule has no Auto lock: no "Turn on first" chip, whatever the dial says', () => {
    const turnOn = HOLDS.autoTurnOn()
    expect(ruleMode(facts({ level: 'OFF', autoGate: turnOn }))).toEqual({ set: 'OFF', acts: 'OFF', heldBy: null, also: [], autoLocked: null })
    expect(ruleMode(facts({ level: 'OFF', autoGate: HOLDS.autoAfterRuns(4, 10) })).autoLocked).toBeNull()
    // Watch and Ask me still say why Auto cannot be picked.
    expect(ruleMode(facts({ level: 'OBSERVE', autoGate: turnOn })).autoLocked).toEqual(turnOn)
  })
})

describe('brainMode — the brain\'s pseudo-row', () => {
  const account = { autonomy: 'AUTO' as const, halted: false, killed: false, degraded: false }
  it('shadow everywhere watches; a campaign enrolled live is Auto, held by the server switch or the dial', () => {
    expect(chips(brainMode({ serverMode: 'shadow', enrolledLive: 0, account, adsLive: true }))).toEqual({ set: 'WATCH', acts: 'WATCH', heldBy: null, also: [], autoLocked: { kind: 'server', label: 'Auto off (server)' } })
    expect(brainMode({ serverMode: 'live', enrolledLive: 2, account, adsLive: true })).toEqual({ set: 'AUTO', acts: 'AUTO', heldBy: null, also: [], autoLocked: null })
    expect(chips(brainMode({ serverMode: 'shadow', enrolledLive: 1, account: { ...account, autonomy: 'SUGGEST' }, adsLive: true }))).toEqual({
      set: 'AUTO', acts: 'WATCH', heldBy: { kind: 'server', label: 'Server: no changes' }, also: [{ kind: 'dial', label: 'Account: Ask me' }], autoLocked: null,
    })
    expect(brainMode({ serverMode: 'off', enrolledLive: 0, account, adsLive: true })).toMatchObject({ acts: 'OFF', heldBy: { kind: 'server', label: 'Brain off (server)' } })
    expect(brainMode({ serverMode: 'live', enrolledLive: 1, account: { ...account, halted: true }, adsLive: true })).toMatchObject({ acts: 'OFF', heldBy: { kind: 'stopped', label: 'Ads halted' } })
  })
  it('the Owner\'s kill switch on its bids: all its live campaigns stopped is Off, some is said', () => {
    expect(brainMode({ serverMode: 'live', enrolledLive: 2, account, adsLive: true, killed: 2 })).toMatchObject({ set: 'AUTO', acts: 'OFF', heldBy: { kind: 'stopped', label: 'Brain off' } })
    expect(chips(brainMode({ serverMode: 'live', enrolledLive: 3, account, adsLive: true, killed: 1 }))).toMatchObject({ acts: 'AUTO', heldBy: null, also: [{ kind: 'stopped', label: '1 stopped campaign' }] })
  })
})

describe('brainStopOf — the stop the Brain row\'s Stop / Start again names', () => {
  const kill = (over: Partial<{ lever: string; productId: string | null; market: string | null; at: string; reason: string }> = {}) => ({
    lever: 'bids', productId: null, market: 'IT', at: '2026-01-10T08:00:00.000Z', reason: 'Stopped on the Bid page', ...over,
  })
  it('one market: its own stop first, else the stop of every market; nothing else is this stop', () => {
    expect(brainStopOf([kill()], 'IT')).toEqual({ market: 'IT', at: '2026-01-10T08:00:00.000Z', reason: 'Stopped on the Bid page' })
    expect(brainStopOf([kill({ market: null, reason: 'everywhere' }), kill()], 'it')).toMatchObject({ market: 'IT' })
    expect(brainStopOf([kill({ market: null, reason: 'everywhere' })], 'DE')).toMatchObject({ market: null, reason: 'everywhere' })
    expect(brainStopOf([kill({ market: 'DE' })], 'IT')).toBeNull()
    // One product's kill, or another lever's, is not the Brain's stop.
    expect(brainStopOf([kill({ productId: 'p1' }), kill({ lever: 'budgets' })], 'IT')).toBeNull()
  })
  it('All markets: only the stop of every market; the newest wins', () => {
    expect(brainStopOf([kill()], null)).toBeNull()
    expect(brainStopOf([kill({ market: null, at: '2026-01-09T08:00:00.000Z', reason: 'old' }), kill({ market: null, reason: 'new' })], null)).toMatchObject({ market: null, reason: 'new' })
  })
})

describe('autoGateHold — the level dial\'s refusal as a hold', () => {
  const gate = { observationDays: 14, evaluations: { have: 4, need: 10 } }
  const made = new Date('2026-03-01T23:30:00Z')
  const refused = (failures: string[]) => chip(autoGateHold({ error: 'gate_not_open', failures }, made, gate))
  it('reads the first failing check in the gate\'s order', () => {
    expect(autoGateHold(null, made, gate)).toBeNull()
    expect(autoGateHold({ error: 'not_found' }, made, gate)).toBeNull()
    expect(autoGateHold({ error: 'above_ceiling', blockedBy: ['pause_target'] }, made, gate)).toEqual(HOLDS.alwaysAsks(['pause_target']))
    expect(chip(autoGateHold({ error: 'contested_by_rank_engine' }, made, gate))).toEqual({ kind: 'gate', label: 'Hourly plan' })
    expect(refused(['HAS_EVALUATIONS (4/10)'])).toEqual({ kind: 'graduation', label: '6 more runs' })
    expect(refused(['RULE_ENABLED', 'OBSERVATION_WINDOW (1/14 days)'])).toEqual({ kind: 'graduation', label: 'Turn on first' })
    expect(refused(['HAS_MATCHES'])).toEqual({ kind: 'graduation', label: 'No match yet' })
    expect(refused(['WRITES_ENABLED', 'LIVE_MODE_ENV'])).toEqual({ kind: 'gate', label: 'Market not live' })
    expect(refused(['LIVE_MODE_ENV'])).toEqual({ kind: 'gate', label: 'Amazon test mode' })
    // A check with no words of its own is never called a market problem.
    expect(refused(['RULE_DRY_RUN'])).toEqual({ kind: 'graduation', label: 'Not allowed' })
  })
  it('the age check says the day Auto opens, in Rome: created + 14 days', () => {
    // 01 Mar 23:30 UTC + 14 days = 15 Mar 23:30 UTC = 16 Mar 00:30 in Rome.
    expect(autoGateHold({ error: 'gate_not_open', failures: ['OBSERVATION_WINDOW (3/14 days)', 'HAS_EVALUATIONS (4/10)'] }, made, gate)).toEqual({
      kind: 'graduation', label: 'Auto from 16 Mar', reason: 'A new rule first runs 14 days, at least 10 times and matches a keyword once.',
    })
    expect(shortDay(new Date('2026-10-24T10:00:00Z'))).toBe('24 Oct')
  })
})

describe('HOLDS — the words on screen', () => {
  const every: Hold[] = [
    ...Object.entries(HOLDS).map(([key, make]) => {
      const args: Record<string, unknown[]> = { autoFrom: ['24 Oct', 14, 10], autoAfterRuns: [3, 10], brainCampaigns: [2, ['A', 'B']], stoppedCampaigns: [2], lockedCampaigns: [1], unsupportedCampaigns: [2] }
      return (make as (...a: unknown[]) => Hold)(...(args[key] ?? []))
    }),
    HOLDS.alwaysAsks(['add_negative_exact']), HOLDS.dailyCap(10), HOLDS.changeCap(3),
  ]
  it('every hold has a short chip label and a one-line reason', () => {
    for (const h of every) {
      expect(h.reason, h.label).toMatch(/^[A-Z"].*\.$/)
      expect(h.reason.length, h.label).toBeLessThanOrEqual(140)
      // At most three words (a number is not a word); "Market not set up" is the page's own word for it (audit §2).
      const words = h.label.split(/\s+/).filter((w) => !/^\d+$/.test(w))
      if (!/not set up$/.test(h.label)) expect(words.length, h.label).toBeLessThanOrEqual(3)
    }
  })
  it('no jargon, ever', () => {
    const jargon = /\b(shadow|sandbox|graduat\w*|allowlist|lever|observe|propose|cycle|directive|gate)\b/i
    for (const h of every) expect(`${h.label} ${h.reason}`, h.label).not.toMatch(jargon)
  })
})

describe('ruleSentence — one line', () => {
  it('a builder rule: its first block, its lookback, its THEN, and how many blocks more', () => {
    const rule = {
      trigger: 'TARGET_PERFORMANCE',
      actions: [{ type: 'bid', windowDays: 14, campaigns: [{ id: 'c1' }] }],
      conditions: [
        { conditions: [{ metric: 'ACOS', op: 'gt', value: '20' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'targetAcos', value: '20' } },
        { conditions: [{ metric: 'Orders', op: 'eq', value: '0' }], action: { op: 'decPct', value: '15' } },
      ],
    }
    expect(ruleSentence(rule)).toBe('If ACoS > 20 % and clicks ≥ 10 over 14 d → bid toward 20 % (+1)')
    expect(ruleSentence({ ...rule, conditions: [rule.conditions[1]] })).toBe('If orders = 0 over 14 d → bid −15 %')
    expect(ruleSentence({ ...rule, conditions: [{ conditions: [{ metric: 'Spend', op: 'gte', value: '5,5' }], action: { op: 'set', value: '0.3' } }] })).toBe('If spend ≥ €5.5 over 14 d → bid €0.3')
  })
  it('an engine rule: its conditions, or its trigger', () => {
    expect(ruleSentence({ trigger: 'KEYWORD_WASTED_SPEND', conditions: [], actions: [{ type: 'bid_down', percent: 20 }] })).toBe('If spend, no sales → bid −20 %')
    expect(ruleSentence({ trigger: 'KEYWORD_HIGH_ACOS', conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.4 }], actions: [{ type: 'notify' }, { type: 'bid_down', percent: 10 }] })).toBe('If ACoS > 40 % → bid −10 %')
    expect(ruleSentence({ trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'bid_to_target_acos', targetAcos: 0.25 }] })).toBe('If on schedule → bid toward 25 %')
  })
  it('bid rules are told by any action, the builder slug included', () => {
    expect(isBidRule([{ type: 'notify' }, { type: 'bid_up' }])).toBe(true)
    expect(isBidRule([{ type: 'bid' }])).toBe(true)
    expect(isBidRule([{ type: 'budget' }])).toBe(false)
    expect(isBidRule(null)).toBe(false)
  })
})

describe('the next run', () => {
  const now = new Date('2026-03-02T10:07:00Z')
  it('an engine rule runs at the next 15-minute tick; a daily rule at its time', () => {
    expect(nextQuarter(now).toISOString()).toBe('2026-03-02T10:15:00.000Z')
    expect(ruleNextRun(null, null, now)?.toISOString()).toBe('2026-03-02T10:15:00.000Z')
    // Daily at 12:00 Rome (UTC+1 in March before DST): 11:00 UTC; it ran yesterday.
    const daily = { frequency: 'Daily', time: '12:00', timezone: 'cet' }
    expect(ruleNextRun(daily, new Date('2026-03-01T11:00:00Z'), now)?.toISOString()).toBe('2026-03-02T11:00:00.000Z')
    // Already ran today after its time: tomorrow.
    expect(ruleNextRun(daily, new Date('2026-03-02T11:05:00Z'), new Date('2026-03-02T12:00:00Z'))?.toISOString()).toBe('2026-03-03T11:00:00.000Z')
  })
  it('a rule that has never run: its first run on the next tick, said apart; then the next run by the same gate', () => {
    const daily = { frequency: 'Daily', time: '06:00', timezone: 'cet' }
    // 2026-03-02 21:07 UTC = 22:07 Rome: first run on the next tick; its schedule's half-day slack puts the next at 09:15 UTC
    // (12 h after the first, 10:15 Rome) — not 06:00 Rome — and the one after on time.
    const late = new Date('2026-03-02T21:07:00Z')
    const t = ruleRunTimes(daily, null, late)
    expect(t.nextRunAt?.toISOString()).toBe('2026-03-02T21:15:00.000Z')
    expect(t.firstRunAt?.toISOString()).toBe('2026-03-02T21:15:00.000Z')
    expect(t.thenRunAt?.toISOString()).toBe('2026-03-03T09:15:00.000Z')
    expect(ruleNextRun(daily, t.thenRunAt, t.thenRunAt!)?.toISOString()).toBe('2026-03-04T05:00:00.000Z')
    // Run before: no first run; the next by its schedule.
    expect(ruleRunTimes(daily, new Date('2026-03-02T05:00:00Z'), late)).toEqual({ nextRunAt: new Date('2026-03-03T05:00:00.000Z'), firstRunAt: null, thenRunAt: null })
    // An engine rule (no schedule) never run: first run on the next tick, then every tick (no "then" time to say).
    expect(ruleRunTimes(null, null, late)).toEqual({ nextRunAt: new Date('2026-03-02T21:15:00.000Z'), firstRunAt: new Date('2026-03-02T21:15:00.000Z'), thenRunAt: null })
  })
  it('the schedule in words, in the zone the evaluator reads it in', () => {
    expect(scheduleWords(null)).toBe('Every 15 min')
    expect(scheduleWords({ frequency: 'Daily', time: '6:00', timezone: 'cet' })).toBe('Daily · 06:00 · Rome')
    expect(scheduleWords({ frequency: 'Weekly', onDay: 'Monday', time: '07:30', timezone: 'utc' })).toBe('Weekly · 07:30 · UTC')
    expect(scheduleWords({ frequency: 'Custom', everyN: '2', interval: 'Weeks', onDay: 'Friday', time: '05:00', timezone: 'pst' })).toBe('Every 2 weeks · Friday · 05:00 · Los Angeles')
    expect(scheduleWords({ frequency: 'Custom', everyN: '', interval: 'Days', time: '05:00', timezone: 'est' })).toBe('Every day · 05:00 · New York')
    expect(scheduleWords({ frequency: 'Hourly' })).toBe('Hourly')
    // An unknown or missing frequency runs on every tick; an unknown zone is read as Rome.
    expect(scheduleWords({ time: '06:00' })).toBe('Every 15 min')
    expect(scheduleWords({ frequency: 'Daily', time: '06:00', timezone: 'gmt' })).toBe('Daily · 06:00 · Rome')
    expect(brainScheduleWords(true)).toBe('Every 15 min')
    expect(brainScheduleWords(false)).toBe('Every 6 h')
  })
  it('the zone words agree with the evaluator: each zone\'s 06:00 is when scheduleIsDue first lets a daily rule run', () => {
    const at = (iso: string) => new Date(iso)
    const zones: Array<[string, string, string]> = [['cet', 'Rome', '2026-07-02T04:00:00Z'], ['utc', 'UTC', '2026-07-02T06:00:00Z'], ['pst', 'Los Angeles', '2026-07-02T13:00:00Z'], ['est', 'New York', '2026-07-02T10:00:00Z'], ['gmt', 'Rome', '2026-07-02T04:00:00Z']]
    for (const [key, word, fire] of zones) {
      const s = { frequency: 'Daily', time: '06:00', timezone: key }
      expect(scheduleWords(s)).toBe(`Daily · 06:00 · ${word}`)
      const last = at('2026-07-01T00:00:00Z')
      expect(scheduleIsDue(s, last, new Date(at(fire).getTime() - 60_000)), key).toBe(false)
      expect(scheduleIsDue(s, last, at(fire)), key).toBe(true)
    }
  })
  it('the brain\'s full run is the :45 tick of every sixth UTC hour', () => {
    expect(brainNextFullRun(now).toISOString()).toBe('2026-03-02T12:45:00.000Z')
    expect(brainNextFullRun(new Date('2026-03-02T18:50:00Z')).toISOString()).toBe('2026-03-03T00:45:00.000Z')
  })
})

describe('the effect — equal days before and after each keyword\'s first change', () => {
  const day = (s: string) => new Date(`${s}T00:00:00Z`)
  const settled = day('2026-03-20')
  it('windows: the anchor day is in neither side; too-early keywords are counted apart', () => {
    const { windows, tooEarly } = effectWindows(new Map([
      ['t1', new Date('2026-03-10T09:00:00Z')],
      ['t2', new Date('2026-03-19T09:00:00Z')],
      ['t3', new Date('2026-02-20T09:00:00Z')],
    ]), settled)
    expect(tooEarly).toBe(1)
    const t1 = windows.find((w) => w.targetId === 't1')!
    expect([t1.beforeFrom, t1.beforeTo, t1.afterFrom, t1.afterTo].map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-02-28', '2026-03-09', '2026-03-11', '2026-03-20'])
    expect(t1.days).toBe(10)
    // Capped at 14 days each side.
    expect(windows.find((w) => w.targetId === 't3')!.days).toBe(14)
  })
  it('sums each side; ACoS = spend ÷ sales; two currencies give no effect', () => {
    const { windows, tooEarly } = effectWindows(new Map([['t1', new Date('2026-03-10T09:00:00Z')]]), settled)
    const row = (date: string, spendCents: number, salesCents: number, currency = 'EUR') => ({ targetId: 't1', date: day(date), clicks: 10, orders: salesCents ? 1 : 0, spendCents, salesCents, currency })
    const effect = effectOf(windows, tooEarly, [row('2026-03-05', 400, 1000), row('2026-03-10', 999, 0), row('2026-03-12', 200, 1000), row('2026-03-25', 999, 0)], settled)
    expect(effect).toMatchObject({ keywords: 1, tooEarly: 0, days: 10, currency: 'EUR', before: { clicks: 10, orders: 1, spendCents: 400, salesCents: 1000, acosPct: 40 }, after: { clicks: 10, orders: 1, spendCents: 200, salesCents: 1000, acosPct: 20 } })
    expect(effectOf(windows, tooEarly, [row('2026-03-05', 400, 1000), row('2026-03-12', 200, 1000, 'GBP')], settled)).toBeNull()
    expect(effectOf([], 0, [], settled)).toBeNull()
    // Nothing changed at the page's precision (ACoS 0.1 %, spend in cents, orders): no effect, not "ACoS 40 → 40 %".
    expect(effectOf(windows, tooEarly, [row('2026-03-05', 400, 1000), row('2026-03-12', 400, 1000)], settled)).toBeNull()
    // The same ACoS but more spend and orders is a change.
    expect(effectOf(windows, tooEarly, [row('2026-03-05', 400, 1000), row('2026-03-12', 400, 1000), row('2026-03-13', 400, 1000)], settled)).toMatchObject({ before: { acosPct: 40, orders: 1 }, after: { acosPct: 40, orders: 2 } })
    expect(effectUnchanged({ clicks: 1, orders: 1, spendCents: 400, salesCents: 1000, acosPct: 40 }, { clicks: 9, orders: 1, spendCents: 400, salesCents: 1001, acosPct: 40 })).toBe(true)
    // Every keyword too early: no sides yet, the count kept.
    expect(effectOf([], 2, [], settled)).toMatchObject({ keywords: 0, tooEarly: 2, days: 0, before: { clicks: 0, acosPct: null }, after: { clicks: 0, acosPct: null } })
  })
})

describe('actionOutcome — each bid action type\'s own dry-run shape', () => {
  const move = (o: ReturnType<typeof actionOutcome>) => o.moves[0]
  it('bid_apply, bid_down and bid_up: from → to in cents, a keyword or an ad group', () => {
    expect(move(actionOutcome({ type: 'bid_apply', ok: true, output: { dryRun: true, adTargetId: 't1', wouldChange: '45¢ → 60¢' } }))).toEqual({ targetId: 't1', adGroupId: null, field: 'bid', fromCents: 45, toCents: 60 })
    expect(move(actionOutcome({ type: 'bid_down', ok: true, output: { dryRun: true, target: 'ad_target', id: 't1', wouldChange: '45→36 cents' } }))).toMatchObject({ targetId: 't1', fromCents: 45, toCents: 36 })
    expect(move(actionOutcome({ type: 'bid_up', ok: true, output: { dryRun: true, target: 'ad_group', id: 'g1', wouldChange: '40→46 cents' } }))).toMatchObject({ targetId: null, adGroupId: 'g1', fromCents: 40, toCents: 46 })
  })
  it('lower_bid_to_floor: the floor, from the keyword\'s bid now', () => {
    expect(actionOutcome({ type: 'lower_bid_to_floor', ok: true, output: { dryRun: true, adTargetId: 't1', bidCents: 5 } })).toMatchObject({ moves: [{ targetId: 't1', field: 'bid', fromCents: null, toCents: 5 }], counted: 0 })
  })
  it('raise_bids_for_rank_defense: its targets, counted', () => {
    expect(actionOutcome({ type: 'raise_bids_for_rank_defense', ok: true, output: { dryRun: true, targets: 3, raisePct: 20 } })).toMatchObject({ moves: [], counted: 3 })
    expect(actionOutcome({ type: 'raise_bids_for_rank_defense', ok: true, output: { dryRun: true, targets: 0, raisePct: 20 } })).toMatchObject({ moves: [], counted: 0, brain: 0, refused: 0 })
  })
  it('bid_to_target_acos: its number, its sample, the keywords it leaves to the brain, counted once', () => {
    const o = actionOutcome({ type: 'bid_to_target_acos', ok: true, output: { dryRun: true, wouldChange: 7, sample: [{ targetId: 't1', currentBidCents: 40, proposedBidCents: 30 }, { targetId: 't2', currentBidCents: 20, proposedBidCents: 25 }], brainOwned: 2 } })
    expect(o).toMatchObject({ counted: 5, brain: 2, moves: [{ targetId: 't1', fromCents: 40, toCents: 30 }, { targetId: 't2', fromCents: 20, toCents: 25 }] })
    expect(o.onceKey).toBe('bid_to_target_acos:7:t1,t2')
  })
  it('pause_target and enable_target: the state from → to', () => {
    expect(move(actionOutcome({ type: 'pause_target', ok: true, output: { dryRun: true, adTargetId: 't1', wouldSet: 'PAUSED', from: 'ENABLED' } }))).toEqual({ targetId: 't1', adGroupId: null, field: 'state', from: 'ENABLED', to: 'PAUSED' })
    expect(move(actionOutcome({ type: 'enable_target', ok: true, output: { dryRun: true, adTargetId: 't1', wouldSet: 'ENABLED', from: 'PAUSED' } }))).toMatchObject({ field: 'state', to: 'ENABLED' })
    expect(actionOutcome({ type: 'pause_target', ok: true, output: { adTargetId: 't1', noChange: true, status: 'PAUSED' } })).toMatchObject({ moves: [], counted: 0, brain: 0, refused: 0 })
  })
  it('a brain input, a lever left to the brain, a skip and a refusal', () => {
    expect(actionOutcome({ type: 'bid_down', ok: true, output: { dryRun: true, campaignId: 'c1', wouldChange: 'a bid brain input: a ceiling', bidBrain: { directives: 1, sample: [] } } })).toMatchObject({ moves: [], brain: 1 })
    expect(actionOutcome({ type: 'pause_target', ok: true, output: { skipped: 'brain-lever', brainSkip: { lever: 'state' } } })).toMatchObject({ moves: [], brain: 1 })
    expect(actionOutcome({ type: 'bid_apply', ok: true, output: { skipped: 'suppressed_flag', adTargetId: 't1' } })).toMatchObject({ moves: [], counted: 0, brain: 0, refused: 0 })
    expect(actionOutcome({ type: 'bid_apply', ok: false, error: 'no sales' })).toMatchObject({ refused: 1 })
  })
})
