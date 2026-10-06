/**
 * CR rebuild 2 — Who acts: one list for every engine and rule, one level scale, plain words, and filters that match
 * the top tiles.
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import { LEVEL_WORD, withoutServerNames } from './levelWords'
import type { AccountLevel } from './roomCounts'
import {
  actionWords, actorRows, countWords, engineRow, isFiltered, marketsOf, ruleLevelOptions, ruleMove, ruleRow, rowMatches, NO_FILTER,
  type Engine, type Rule,
} from './whoActs'

const g = (over: Partial<AccountLevel> = {}): AccountLevel => ({ autonomy: 'AUTO', halted: false, envKill: false, ...over })

const engine = (over: Partial<Engine> = {}): Engine => ({
  key: 'auto-bid', name: 'Bid optimiser', what: 'Moves target bids toward a target ACOS',
  mode: 'AUTO', modeReason: 'NEXUS_ENABLE_AMAZON_ADS_CRON is on', scope: null, cron: 'ads-auto-bid', schedule: 'every 6 h',
  lastRunAt: null, lastRunStatus: null, lastRunSummary: null, runs7d: 4, failures7d: 0, warning: null, haltBehaviour: 'honours',
  exposure: { group: 'acts', label: 'Changes Amazon on its own', start: null }, writes7d: 12,
  ...over,
})

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1', name: 'Harvest winners', marketplace: 'IT', level: 'PROPOSE', ceiling: 'AUTO', ceilingReason: '',
  actionTypes: ['create_keyword'], caps: { perDay: null, perExecutionCents: null, perDayCents: null },
  week: { acted: 0, proposed: 3, failed: 0 }, lastExecutedAt: null,
  ...over,
})

describe('the one level scale', () => {
  it('four words, one meaning each', () => {
    expect(LEVEL_WORD).toEqual({ OFF: 'Off', OBSERVE: 'Watch', PROPOSE: 'Ask me', AUTO: 'Auto' })
  })
})

describe('server sentences in plain words', () => {
  it('the sentences that name a server variable are left out; nothing left means the plain fallback', () => {
    expect(withoutServerNames('No budget changes in this window. NEXUS_ENABLE_AMAZON_ADS_CRON is off on this server — no engine runs.', 'Nothing recorded.'))
      .toBe('No budget changes in this window.')
    expect(withoutServerNames('Not offered while this engine is off: NEXUS_ENABLE_AMAZON_ADS_CRON is off.', 'It cannot be run by hand.')).toBe('It cannot be run by hand.')
    expect(withoutServerNames(null, 'Nothing recorded.')).toBe('Nothing recorded.')
    // A code file name is a developer word too; the plain clause before it stays.
    expect(withoutServerNames('Unclassified action — classify in ads-graduation.ts before trusting this unattended.', 'x')).toBe('Unclassified action.')
  })
})

describe('an engine row', () => {
  it('says what it may do now in plain words, never the server variable name', () => {
    const row = engineRow(engine(), g())
    expect(row).toMatchObject({ kind: 'engine', market: null, inForce: 'AUTO', bucket: 'alone', why: 'Changes your ads by itself', week: '4 runs · 12 changes' })
    const off = engineRow(engine({ mode: 'OFF', exposure: { group: 'server-off', label: 'Off by a server switch', start: null } }), g())
    expect(off).toMatchObject({ bucket: 'quiet', why: 'The server keeps it off' })
    expect(off.why).not.toMatch(/NEXUS_/)
  })

  it('a held engine says who holds it: a stop, the account level, or this business', () => {
    const held = engine({ mode: 'PROPOSE', exposure: { group: 'held', label: 'Held back in Nexus', start: null } })
    expect(engineRow(held, g({ halted: true })).why).toBe('Stopped — press Start again')
    // An engine never asks a person: at Ask me it only records what it would change — Watch, changes nothing.
    expect(engineRow(held, g({ autonomy: 'SUGGEST' }))).toMatchObject({ bucket: 'quiet', inForce: 'OBSERVE', why: 'The account level is Ask me, so it only records what it would change' })
    expect(engineRow(held, g()).why).toBe('Lowered for this business')
  })

  it('a busy week reads at a glance: thousands separators', () => {
    // Failures are said once, in the Problem column; the week keeps them only when a warning takes that column.
    expect(engineRow(engine({ runs7d: 670, writes7d: 10474, failures7d: 1 }), g())).toMatchObject({ week: '670 runs · 10,474 changes', problem: '1 run failed in 7 days' })
    expect(engineRow(engine({ runs7d: 9, writes7d: 0, failures7d: 2, warning: 'Still evaluating while stopped' }), g()).week).toBe('9 runs · 0 changes · 2 failed')
    expect(ruleRow(rule({ week: { acted: 1, proposed: 2, failed: 1 } }), g())).toMatchObject({ week: '1 acted · 2 asked', problem: '1 change failed this week' })
  })

  it('a warning or a failed run is its problem', () => {
    expect(engineRow(engine({ failures7d: 2 }), g()).problem).toBe('2 runs failed in 7 days')
    expect(engineRow(engine({ warning: 'Still evaluating while stopped' }), g()).problem).toBe('Still evaluating while stopped')
  })
})

describe('a rule row', () => {
  it('the account level and a stop hold it; a Manual builder rule at Auto asks first', () => {
    expect(ruleRow(rule({ level: 'AUTO' }), g())).toMatchObject({ inForce: 'AUTO', bucket: 'alone', setTo: 'Auto' })
    expect(ruleRow(rule({ level: 'AUTO' }), g({ autonomy: 'SUGGEST' }))).toMatchObject({ inForce: 'PROPOSE', bucket: 'asks', why: 'The account level holds it at Ask me' })
    expect(ruleRow(rule({ level: 'AUTO', runsAs: 'PROPOSE' }), g())).toMatchObject({ inForce: 'PROPOSE', why: 'The rule itself is set to ask first' })
    // A rule that only alerts changes nothing, at any level.
    expect(ruleRow(rule({ level: 'AUTO', writes: false }), g())).toMatchObject({ bucket: 'quiet', why: 'It only sends alerts. It changes nothing' })
    expect(ruleRow(rule(), g({ envKill: true }))).toMatchObject({ inForce: 'OFF', why: 'Stopped by the server' })
  })

  it('its action codes read as words when it has no description', () => {
    expect(ruleRow(rule(), g()).what).toBe('Add keywords')
    expect(actionWords(['bid_to_target_acos', 'some_new_action'])).toBe('Move bids toward the target ACoS · Some new action')
    expect(ruleRow(rule({ description: 'Turn converting search terms into exact keywords' }), g()).what).toBe('Turn converting search terms into exact keywords')
    expect(actionWords([])).toBe('Alerts only')
  })

  it('failed changes, or a failing graduation verdict, are its problem', () => {
    expect(ruleRow(rule({ week: { acted: 1, proposed: 0, failed: 1 } }), g()).problem).toBe('1 change failed this week')
    expect(ruleRow(rule(), g(), { ruleId: 'r1', verdict: 'failing', summary: '3 failures in 2 weeks', canGraduate: false }).problem).toBe('3 failures in 2 weeks')
  })
})

describe('the list and its filters', () => {
  const rows = actorRows(
    [engine(), engine({ key: 'tos', name: 'Top-of-Search defense', mode: 'OFF', exposure: { group: 'server-off', label: '', start: null }, writes7d: 0 })],
    [rule(), rule({ id: 'r2', name: 'Cut wasted spend', marketplace: 'DE', level: 'OFF' })],
    g(), new Map(),
  )

  it('what changes the ads by itself comes first, then what asks, then the rest', () => {
    expect(rows.map((r) => r.name)).toEqual(['Bid optimiser', 'Harvest winners', 'Cut wasted spend', 'Top-of-Search defense'])
  })

  it('Show matches the top tiles; a market keeps the rows for every market', () => {
    expect(rows.filter((r) => rowMatches(r, { ...NO_FILTER, show: 'alone' })).map((r) => r.name)).toEqual(['Bid optimiser'])
    expect(rows.filter((r) => rowMatches(r, { ...NO_FILTER, show: 'quiet' })).length).toBe(2)
    expect(rows.filter((r) => rowMatches(r, { ...NO_FILTER, market: 'IT' })).map((r) => r.name)).toEqual(['Bid optimiser', 'Harvest winners', 'Top-of-Search defense'])
    expect(rows.filter((r) => rowMatches(r, { ...NO_FILTER, kind: 'rule' })).length).toBe(2)
    expect(marketsOf(rows)).toEqual(['DE', 'IT'])
  })

  it('search reads the words the row shows', () => {
    expect(rows.filter((r) => rowMatches(r, { ...NO_FILTER, search: 'server keeps' })).map((r) => r.name)).toEqual(['Top-of-Search defense'])
    expect(rows.filter((r) => rowMatches(r, { ...NO_FILTER, search: 'harvest' })).map((r) => r.name)).toEqual(['Harvest winners'])
  })

  it('the count says when a filter hides rows', () => {
    expect(countWords(4, 4, isFiltered(NO_FILTER))).toBe('4 automations')
    expect(countWords(1, 4, isFiltered({ ...NO_FILTER, show: 'alone' }))).toBe('Showing 1 of 4 automations')
  })
})

describe('a rule’s level asks first', () => {
  it('THE REGRESSION: raising to Auto asks with the tick (the notch used to write at once)', () => {
    const move = ruleMove(rule(), 'AUTO')
    expect(move && 'impact' in move).toBe(true)
    const impact = (move as { impact: Parameters<typeof validateImpact>[0] }).impact
    expect(impact.title).toBe('Raise “Harvest winners” to Auto?')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(false)
  })

  it('lowering is a plain question; the same level asks nothing', () => {
    const move = ruleMove(rule({ level: 'AUTO' }), 'OFF') as { impact: Parameters<typeof validateImpact>[0] }
    expect(move.impact.title).toBe('Lower “Harvest winners” to Off?')
    expect(canConfirmAction(move.impact, '', false)).toBe(true)
    expect(ruleMove(rule(), 'PROPOSE')).toBeNull()
  })

  it('a level above the rule’s ceiling is refused in words, and listed but held in the control', () => {
    const capped = rule({ ceiling: 'PROPOSE', ceilingReason: 'it creates keywords' })
    expect(ruleMove(capped, 'AUTO')).toEqual({ refused: '“Harvest winners” cannot be set to Auto: it creates keywords' })
    expect(ruleLevelOptions(capped).map((o) => [o.label, o.disabled])).toEqual([
      ['Off', false], ['Watch', false], ['Ask me', false], ['Auto — not allowed for this rule', true],
    ])
  })
})
