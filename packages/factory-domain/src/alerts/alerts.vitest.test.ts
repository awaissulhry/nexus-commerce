import { describe, expect, it } from 'vitest'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { KINDS, RECHECK_EVENTS, RULE_KINDS, kindsOf, readThreshold, recheckOf, thresholdOf } from './kinds'
import { ALERTS_PERMISSIONS } from './permissions'
import {
  ALERT_TEMPLATES,
  alertPhrase,
  cooldownWords,
  dedupeKeyOf,
  isForMe,
  isRecipient,
  placeCovers,
  planEvaluation,
  phraseText,
  resolveNote,
  roleReaches,
  ruleSentence,
  snoozeProblem,
  verbsOf,
  type EvaluatedRule,
  type Finding,
  type KeyState,
} from './rules'
import { alertRowPhrase, alertWhyPhrase, RULE_ALERT_WHY, TODAY_SEVERITY } from './today'

const NOW = new Date('2026-10-30T09:00:00.000Z')
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000)
const A = '018f0000-0000-7000-8000-00000000000a'
const B = '018f0000-0000-7000-8000-00000000000b'
const SITE = '018f0000-0000-7000-8000-0000000000a1'
const ME = '018f0000-0000-7000-8000-0000000000ee'
const ROLE = '018f0000-0000-7000-8000-000000000001'
const rec = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`

const rule = (id: string, place: { companyId?: string | null; siteId?: string | null } = {}, extra: Partial<EvaluatedRule> = {}): EvaluatedRule => ({
  id,
  companyId: place.companyId ?? null,
  siteId: place.siteId ?? null,
  severity: 'WARNING',
  cooldownMinutes: 60,
  createdAt: minutes(-1000),
  ...extra,
})
const finding = (n: number, scope: Partial<Finding['scope']> = {}): Finding => ({ recordType: 'QualityHold', recordId: rec(n), label: `H${n}`, scope: { companyId: A, siteId: SITE, partyId: null, ...scope }, facts: { hours: 30 } })
const state = (n: number, extra: Partial<KeyState> = {}): KeyState => ({ alertId: rec(900 + n), dedupeKey: dedupeKeyOf('HOLD_TOO_LONG', rec(n)), recordId: rec(n), occurrence: 1, raisedAt: minutes(-120), resolved: false, ...extra })

describe('the kinds of rule', () => {
  it('ship a built-in rule each, whose numbers their own schema reads, and refuse numbers out of range', () => {
    expect(RULE_KINDS).toHaveLength(7)
    expect(kindsOf('DATE')).toEqual(['CERTIFICATE_EXPIRING', 'INVOICE_DEADLINE'])
    for (const kind of RULE_KINDS) {
      const read = readThreshold(kind, KINDS[kind].builtIn.threshold)
      expect(read, kind).toEqual({ ok: true, threshold: KINDS[kind].builtIn.threshold })
      expect(templateOf(KINDS[kind].builtIn.recipientRole), kind).toBeDefined()
      // The recipient role may see the record: an alert reaches only who can open it.
      expect(templateOf(KINDS[kind].builtIn.recipientRole)!.permissions, kind).toContain(KINDS[kind].view)
      expect(Boolean(KINDS[kind].timer), kind).toBe(KINDS[kind].trigger === 'DATE')
    }
    expect(readThreshold('HOLD_TOO_LONG', { hours: 0 }).ok).toBe(false)
    expect(readThreshold('HOLD_TOO_LONG', { hours: 24, extra: 1 }).ok).toBe(false)
    expect(readThreshold('ORDER_LATE_RISK', {})).toEqual({ ok: true, threshold: { daysBeforePromise: 3 } })
    // A stored rule never stops working: unreadable numbers fall back to the kind's.
    expect(thresholdOf('PO_NOT_CONFIRMED', { days: 'two' })).toEqual({ days: 2 })
  })

  it('recheck on declared events whose payload names the record', () => {
    for (const type of RECHECK_EVENTS) {
      const definition = EVENT_CATALOGUE.find(type, 1)
      expect(definition, type).toBeDefined()
      for (const { key } of recheckOf(type)) expect(Object.keys((definition!.payload as unknown as { shape: Record<string, unknown> }).shape), type).toContain(key)
    }
    expect(recheckOf('quality.hold_released')).toEqual([{ kind: 'HOLD_TOO_LONG', key: 'holdId' }])
  })

  it('are given to the office templates that see Today; the rules to the administrator and the production manager', () => {
    for (const key of ['finance', 'sales', 'planner', 'buyer', 'warehouse', 'quality_inspector', 'floor_supervisor']) {
      expect(templateOf(key)!.permissions, key).toEqual(expect.arrayContaining(['alerts.view', 'alerts.handle']))
      expect(templateOf(key)!.permissions, key).not.toContain('alerts.rules.manage')
    }
    for (const key of ['admin', 'production_manager', 'owner']) expect(templateOf(key)!.permissions, key).toEqual(expect.arrayContaining([...ALERTS_PERMISSIONS]))
    expect(templateOf('read_only')!.permissions).toContain('alerts.view')
    expect(templateOf('read_only')!.permissions).not.toContain('alerts.handle')
    for (const template of ['operator', 'team_leader']) expect(templateOf(template)?.permissions ?? [], template).not.toContain('alerts.view')
  })

  it('declare their events, with live rules naming no money and no person', () => {
    for (const type of ['alert.raised', 'alert.acknowledged', 'alert.assigned', 'alert.snoozed', 'alert.resolved', 'alert.rule_changed']) {
      expect(EVENT_CATALOGUE.find(type, 1)?.live?.permission, type).toBe('alerts.view')
    }
    expect(EVENT_CATALOGUE.find('timer.fired', 1)?.live).toBeNull()
  })
})

describe('an evaluation (planEvaluation)', () => {
  const kind = 'HOLD_TOO_LONG'
  it('raises what is newly found, keeps what is open, clears what no rule finds', () => {
    const plan = planEvaluation({ kind, findings: new Map([['r1', [finding(1), finding(2)]]]), rules: [rule('r1')], latest: [state(2), state(3)], now: NOW, raise: true })
    expect(plan.raise.map((entry) => [entry.dedupeKey, entry.occurrence, entry.rule.id])).toEqual([[`HOLD_TOO_LONG:${rec(1)}`, 1, 'r1']])
    expect(plan.kept).toBe(1)
    expect(plan.clear).toEqual([rec(903)])
  })

  it('raises again after a resolution only when the cooldown passed, as the next occurrence', () => {
    const found = new Map([['r1', [finding(1)]]])
    const resolved = state(1, { resolved: true, occurrence: 2, raisedAt: minutes(-30) })
    expect(planEvaluation({ kind, findings: found, rules: [rule('r1')], latest: [resolved], now: NOW, raise: true })).toMatchObject({ raise: [], cooling: 1 })
    const later = planEvaluation({ kind, findings: found, rules: [rule('r1')], latest: [{ ...resolved, raisedAt: minutes(-61) }], now: NOW, raise: true })
    expect(later.raise.map((entry) => entry.occurrence)).toEqual([3])
    // Cooldown 0: every evaluation that finds it (once resolved).
    expect(planEvaluation({ kind, findings: found, rules: [rule('r1', {}, { cooldownMinutes: 0 })], latest: [resolved], now: NOW, raise: true }).raise).toHaveLength(1)
  })

  it('raises ONE alert per record when several rules of a kind find it: the most specific place wins', () => {
    const found = new Map([
      ['everywhere', [finding(1)]],
      ['site', [finding(1)]],
      ['company', [finding(1)]],
    ])
    const rules = [rule('everywhere'), rule('company', { companyId: A }), rule('site', { companyId: A, siteId: SITE }, { severity: 'CRITICAL' })]
    const plan = planEvaluation({ kind, findings: found, rules, latest: [], now: NOW, raise: true })
    expect(plan.raise.map((entry) => [entry.rule.id, entry.rule.severity])).toEqual([['site', 'CRITICAL']])
  })

  it('a recheck looks only at its records; a DATE pass only clears', () => {
    const plan = planEvaluation({ kind, findings: new Map([['r1', [finding(1), finding(4)]]]), rules: [rule('r1')], latest: [state(2), state(3)], now: NOW, raise: true, only: new Set([rec(1), rec(2)]) })
    expect(plan.raise.map((entry) => entry.finding.recordId)).toEqual([rec(1)])
    expect(plan.clear).toEqual([rec(902)])
    const dates = planEvaluation({ kind: 'CERTIFICATE_EXPIRING', findings: new Map([['r1', []]]), rules: [rule('r1')], latest: [{ ...state(5), dedupeKey: `CERTIFICATE_EXPIRING:${rec(5)}` }], now: NOW, raise: false })
    expect(dates).toEqual({ raise: [], clear: [rec(905)], kept: 0, cooling: 0 })
  })

  it("a rule's place: a company's records and the shared ones; a site's, and its company's records of no site", () => {
    expect(placeCovers({ companyId: null, siteId: null }, { companyId: B, siteId: null })).toBe(true)
    expect(placeCovers({ companyId: A, siteId: null }, { companyId: B, siteId: null })).toBe(false)
    expect(placeCovers({ companyId: A, siteId: null }, { companyId: null, siteId: null })).toBe(true)
    expect(placeCovers({ companyId: A, siteId: SITE }, { companyId: A, siteId: rec(77) })).toBe(false)
    expect(placeCovers({ companyId: A, siteId: SITE }, { companyId: A, siteId: null })).toBe(true)
  })
})

describe('whom an alert is for, and what people do', () => {
  const scope = { companyId: A, siteId: SITE, partyId: null }
  const held = (extra: Partial<{ allCompanies: boolean; companyIds: string[]; siteIds: string[]; partyIds: string[] }> = {}) => ({ roleId: ROLE, scope: { allCompanies: false, companyIds: [A], siteIds: [], partyIds: [], ...extra } })

  it('the holders of the rule role at the record place; assigned: only the assignee', () => {
    expect(roleReaches(held(), scope)).toBe(true)
    expect(roleReaches(held({ companyIds: [B] }), scope)).toBe(false)
    expect(roleReaches(held({ siteIds: [rec(77)] }), scope)).toBe(false)
    expect(roleReaches(held({ allCompanies: true, companyIds: [] }), scope)).toBe(true)
    expect(isRecipient([held()], ROLE, scope)).toBe(true)
    expect(isRecipient([held()], null, scope)).toBe(false)
    const open = { state: 'OPEN', snoozedUntil: null, assignedToId: null }
    expect(isForMe(open, ME, true, NOW)).toBe(true)
    expect(isForMe(open, ME, false, NOW)).toBe(false)
    expect(isForMe({ ...open, assignedToId: ME }, ME, false, NOW)).toBe(true)
    expect(isForMe({ ...open, assignedToId: rec(5) }, ME, true, NOW)).toBe(false)
    expect(isForMe({ ...open, snoozedUntil: minutes(10) }, ME, true, NOW)).toBe(false)
    expect(isForMe({ ...open, snoozedUntil: minutes(-10) }, ME, true, NOW)).toBe(true)
    expect(isForMe({ ...open, state: 'RESOLVED' }, ME, true, NOW)).toBe(false)
  })

  it('snooze at most 30 days ahead, resolve with a note, verbs by state', () => {
    expect(snoozeProblem(minutes(-1), NOW)).toMatch(/later than now/)
    expect(snoozeProblem(minutes(31 * 24 * 60), NOW)).toMatch(/30 days/)
    expect(snoozeProblem(minutes(60), NOW)).toBeNull()
    expect(resolveNote('   ')).toEqual({ problem: 'Say what was done: a resolution needs a note.' })
    expect(resolveNote(' Released after the retest. ')).toEqual({ note: 'Released after the retest.' })
    expect(verbsOf({ state: 'OPEN' }, true)).toEqual(['ACKNOWLEDGE', 'ASSIGN', 'SNOOZE', 'RESOLVE'])
    expect(verbsOf({ state: 'ACKNOWLEDGED' }, true)).toEqual(['ASSIGN', 'SNOOZE', 'RESOLVE'])
    expect(verbsOf({ state: 'RESOLVED' }, true)).toEqual([])
    expect(verbsOf({ state: 'OPEN' }, false)).toEqual([])
  })
})

describe('words', () => {
  it('a rule as one sentence, in English and Italian', () => {
    const hold = { ruleKind: 'HOLD_TOO_LONG' as const, threshold: { hours: 24 }, channels: ['IN_APP' as const], cooldownMinutes: 1440 }
    expect(ruleSentence(hold, { place: 'Plant 1', recipient: 'Quality inspector' })).toBe('When goods are on hold longer than 24 h at Plant 1, tell Quality inspector by the bell at most once a day.')
    expect(ruleSentence(hold, { place: null, recipient: 'Ispettore qualità' }, 'it')).toBe('Quando qualcosa resta bloccato più di 24 h, avvisa Ispettore qualità con la campanella al massimo una volta al giorno.')
    expect(ruleSentence({ ruleKind: 'INVOICE_DEADLINE', threshold: { daysBefore: 3, workingDays: true }, channels: ['IN_APP', 'EMAIL'], cooldownMinutes: 0 }, { place: null, recipient: null })).toBe(
      "3 working days before the deadline to invoice a DDT's goods, tell nobody by role by the bell and e-mail every time it is found.",
    )
    expect(cooldownWords(60)).toBe('at most once an hour')
    expect(cooldownWords(180, 'it')).toBe('al massimo una volta ogni 3 ore')
    expect(cooldownWords(45)).toBe('at most once every 45 minutes')
  })

  it("an alert's sentence per kind, the same placeholders in both languages", () => {
    for (const [key, words] of Object.entries(ALERT_TEMPLATES)) expect(words.en.match(/\{\w+\}/g)?.sort(), key).toEqual(words.it.match(/\{\w+\}/g)?.sort())
    expect(phraseText(alertPhrase('ORDER_LATE_RISK', 'SO-1', { promiseDate: '2026-10-28', daysLeft: -2, late: true }), 'SO-1')).toBe('Order SO-1 is 2 days late: it was promised for 2026-10-28.')
    expect(phraseText(alertPhrase('ORDER_LATE_RISK', 'SO-1', { promiseDate: '2026-11-02', daysLeft: 3, late: false }), 'SO-1', 'it')).toBe("L'ordine SO-1 è promesso per il 02/11/2026 (mancano 3 giorni) e non è pronto.")
    expect(phraseText(alertPhrase('INVOICE_DEADLINE', '12/2026', { dueDate: '2026-11-15', daysLeft: -1 }), '12/2026')).toBe('The goods of DDT 12/2026 were due to be invoiced by 2026-11-15: 1 days late.')
    expect(phraseText(alertPhrase('NOPE', 'X', {}), 'X')).toBe('Alert on X.')
    for (const kind of RULE_KINDS) expect(alertPhrase(kind, 'L', {}), kind).not.toBeNull()
  })

  it('a Today row: the alert phrase, why it is mine, its severity', () => {
    expect(alertRowPhrase('HOLD_TOO_LONG', 'HD-1', { hours: 30, threshold: 24 })).toMatchObject({ key: 'alerts.HOLD_TOO_LONG', text: 'HD-1 has been on hold for 30 hours (the rule says 24 h).' })
    expect(alertWhyPhrase(true, 'Hold').text).toBe(RULE_ALERT_WHY['why.RULE_ALERT.assigned'])
    expect(alertWhyPhrase(false, 'Hold longer than 24 hours')).toMatchObject({ key: 'why.RULE_ALERT.recipient', params: { rule: 'Hold longer than 24 hours' }, text: 'The rule "Hold longer than 24 hours" tells you.' })
    expect(TODAY_SEVERITY).toEqual({ CRITICAL: 'HIGH', WARNING: 'MEDIUM', INFO: 'LOW' })
  })
})
