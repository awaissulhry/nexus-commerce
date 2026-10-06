/**
 * CR rebuild 3 (= AA-W2-5) — Claude's kinds of ad change as Who acts rows, the watch level, the watch week, and the
 * tiles that count every row (engines, rules and Claude) so the tiles and the list never disagree.
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import type { ClaudeRule, ClaudeRules } from '@/app/settings/ai/claude/claudeWords'
import type { WatchKind, WatchSummary } from '@nexus/shared/approval-queue'
import { CLAUDE_AD_TOOLS, claudeLevelOptions, claudeLowerImpact, claudeRaises, claudeRow, claudeRows, watchReport, watchWeek } from './claudeKinds'
import { actorRows, rowCounts, rowMatches, NO_FILTER, type Engine, type Rule } from './whoActs'

const rule = (over: Partial<ClaudeRule> = {}): ClaudeRule => ({
  name: 'set-target-bid', title: 'Set a target bid', category: 'advertising', readOnly: false, openWorld: true,
  reversibility: 'full', ceiling: 'auto', levels: ['off', 'ask', 'confirm', 'watch', 'auto'], level: 'ask', stored: 'ask',
  limits: null, defaultLimits: null, limitsSchema: null,
  ...over,
})
const tally = (changes: number, over = {}) => ({ changes, approved: 0, rejected: 0, expired: 0, replaced: 0, waiting: 0, ...over })
const kind = (over: Partial<WatchKind> = {}): WatchKind => ({
  tool: 'set-target-bid', title: 'Set a target bid', level: 'watch', watchingSince: '2026-10-01T09:00:00.000Z',
  wouldRun: tally(12, { approved: 10, rejected: 1, waiting: 1 }),
  outside: { ...tally(2, { rejected: 2 }), byCheck: { limits: 2 }, topReasons: [{ why: 'A bid raise above 15 %', count: 2 }] },
  ...over,
})
const rules = (tools: ClaudeRule[], paused = false): ClaudeRules => ({
  autonomy: { paused, pausedAt: null, pausedBy: null, reason: null, dailyAutoCap: 200, autoRunsLastDay: 0 },
  tools,
})

describe('a Claude kind as a Who acts row', () => {
  it('the one scale, with Claude’s two ways of asking kept apart', () => {
    expect(claudeRow(rule({ level: 'ask' }), false, undefined)).toMatchObject({ kind: 'claude', setTo: 'Ask me', inForce: 'PROPOSE', bucket: 'asks' })
    expect(claudeRow(rule({ level: 'confirm' }), false, undefined)).toMatchObject({ setTo: 'Ask me + code', bucket: 'asks' })
    expect(claudeRow(rule({ level: 'off' }), false, undefined)).toMatchObject({ setTo: 'Off', inForce: 'OFF', bucket: 'quiet' })
    expect(claudeRow(rule({ level: 'auto' }), false, undefined)).toMatchObject({ setTo: 'Auto', inForce: 'AUTO', bucket: 'alone' })
  })

  it('Claude’s watch is a kind of Ask me (a person decides), not the Watch of engines; its week says what would have run', () => {
    const row = claudeRow(rule({ level: 'watch' }), false, kind())
    expect(row).toMatchObject({ setTo: 'Ask me + watch', inForceWord: 'Ask me + watch', inForce: 'PROPOSE', bucket: 'asks', week: '12 would run alone · 2 outside your limits' })
    expect(row.why).toBe('A person approves each change. Nexus also records whether Auto would have run it')
  })

  it('the pill says "Ask me + code" when that is the level, never a lower-looking "Ask me"', () => {
    expect(claudeRow(rule({ level: 'confirm' }), false, undefined).inForceWord).toBe('Ask me + code')
  })

  it('Claude paused, the account stopped, or the account level at Off: a kind at Auto asks a person, and says why', () => {
    expect(claudeRow(rule({ level: 'auto' }), true, undefined)).toMatchObject({ bucket: 'asks', inForceWord: 'Ask me', why: 'Claude’s changes by rule are paused, so a person decides each change' })
    const g = (over = {}) => ({ autonomy: 'AUTO', halted: false, envKill: false, ...over })
    expect(claudeRow(rule({ level: 'auto' }), false, undefined, g({ halted: true }))).toMatchObject({ bucket: 'asks', why: 'Ads automation is stopped, so a person decides each change' })
    expect(claudeRow(rule({ level: 'auto' }), false, undefined, g({ autonomy: 'OFF' })).bucket).toBe('asks')
    expect(claudeRow(rule({ level: 'auto' }), false, undefined, g()).bucket).toBe('alone')
  })

  it('the screen name, not the server’s title', () => {
    expect(claudeRow(rule({ name: 'set-campaign-live-writes', title: 'Allow live writes to a campaign' }), false, undefined).name).toBe('Let automation change a campaign')
  })

  it('only the ad tools, in the strategy’s order; a tool the server does not list is left out', () => {
    const rows = claudeRows(rules([rule({ name: 'undo-ad-change', title: 'Undo an ad change' }), rule(), rule({ name: 'set-price', title: 'Set price' })]), null)
    expect(rows.map((r) => r.claude?.rule.name)).toEqual(['set-target-bid', 'undo-ad-change'])
    expect(claudeRows(null, null)).toEqual([])
    expect(new Set(CLAUDE_AD_TOOLS.map((t) => t.tool)).size).toBe(CLAUDE_AD_TOOLS.length)
  })

  it('the Type filter finds Claude', () => {
    const row = claudeRow(rule(), false, undefined)
    expect(rowMatches(row, { ...NO_FILTER, kind: 'claude' })).toBe(true)
    expect(rowMatches(row, { ...NO_FILTER, kind: 'rule' })).toBe(false)
  })
})

describe('changing a Claude kind’s level', () => {
  it('the levels the server allows, in the one scale', () => {
    expect(claudeLevelOptions(rule({ levels: ['off', 'ask', 'confirm'] })).map((o) => o.label)).toEqual(['Off', 'Ask me', 'Ask me + code'])
  })
  it('a raise needs the code; lowering is a plain question the design system accepts', () => {
    expect(claudeRaises('watch', 'auto')).toBe(true)
    expect(claudeRaises('ask', 'watch')).toBe(true)
    expect(claudeRaises('auto', 'watch')).toBe(false)
    const impact = claudeLowerImpact('Set a target bid', 'auto', 'watch')
    expect(impact.title).toBe('Lower “Set a target bid” to Ask me + watch?')
    expect(impact.confirmLabel).toBe('Lower to Ask me + watch')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })
})

describe('the watch week', () => {
  it('requests watched, would have run alone and what a person did, outside the limits and why', () => {
    const r = watchReport(kind(), new Date('2026-10-08T09:00:00.000Z').getTime())
    expect(r?.since).toBe('Watching since 01 Oct (7 days)')
    expect(r?.lines).toEqual([
      { label: 'Requests watched', value: '14' },
      { label: 'Would have run alone', value: '12 — of those: 10 approved · 1 rejected · 1 waiting' },
      { label: 'Outside your limits', value: '2 — of those: 2 rejected' },
    ])
    expect(r?.reasons).toEqual([{ why: 'A bid raise above 15 %', count: 2 }])
    expect(watchReport(undefined)).toBeNull()
    expect(watchWeek(kind({ wouldRun: tally(0), outside: { ...tally(0), byCheck: {}, topReasons: [] } }))).toBe('Nothing asked while watched')
  })
})

describe('the tiles count every row of Who acts', () => {
  const g = { autonomy: 'AUTO', halted: false, envKill: false }
  const engine = (over: Partial<Engine>): Engine => ({
    key: 'e', name: 'Bid optimiser', what: '', mode: 'AUTO', modeReason: '', scope: null, cron: null, schedule: null,
    lastRunAt: null, lastRunStatus: null, lastRunSummary: null, runs7d: 0, failures7d: 0, warning: null, haltBehaviour: 'honours',
    exposure: { group: 'acts', label: '', start: null }, ...over,
  })
  const r = (over: Partial<Rule>): Rule => ({
    id: 'r', name: 'Harvest', marketplace: 'IT', level: 'PROPOSE', ceiling: 'AUTO', ceilingReason: '', actionTypes: [],
    caps: { perDay: null, perExecutionCents: null, perDayCents: null }, week: { acted: 0, proposed: 0, failed: 0 }, lastExecutedAt: null, ...over,
  })
  it('engines, rules and Claude in one split that adds up; a breaker on Auto with nothing to change is idle', () => {
    const watch: WatchSummary | null = null
    const rows = actorRows(
      [engine({}), engine({ key: 'b', name: 'Anomaly breaker', exposure: { group: 'never', label: '', start: null } }), engine({ key: 'o', name: 'Coverage', mode: 'OBSERVE', exposure: { group: 'held', label: '', start: null } })],
      [r({}), r({ id: 'r2', name: 'Cut waste', level: 'OFF' }), r({ id: 'r3', name: 'Manual', level: 'AUTO', runsAs: 'PROPOSE' })],
      g, new Map(),
      claudeRows(rules([rule({ level: 'watch' }), rule({ name: 'undo-ad-change', title: 'Undo', level: 'auto' })]), watch),
    )
    expect(rowCounts(rows)).toEqual({ total: 8, runsAlone: 2, asksFirst: 3, quiet: 3, quietSplit: { watch: 1, off: 1, idle: 1 } })
    // Claude's kinds come after the engines and rules of the same group.
    expect(rows.map((x) => `${x.kind}:${x.name}`).slice(0, 2)).toEqual(['engine:Bid optimiser', 'claude:Undo an ad change'])
  })
})
