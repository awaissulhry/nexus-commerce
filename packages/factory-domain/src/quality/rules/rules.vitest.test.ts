import { describe, expect, it } from 'vitest'
import { ROLE_TEMPLATES, templateOf } from '../../auth/roles/templates'
import { fourEyesWords, secondPersonReasons } from '../release/rules'
import {
  alertRuleProblems,
  alertRuleSentence,
  daysStepDue,
  durationWords,
  EVENT_FACTS,
  firingKey,
  firingTitle,
  missingStarterRules,
  QUALITY_ALERT_EVENTS,
  rulesInForce,
  shadowedFor,
  sortedDays,
  STARTER_ALERT_RULES,
  waitDue,
  type AlertRuleDraft,
} from './alerts'
import {
  dutiesChanged,
  dutiesInForce,
  dutiesLoosenings,
  EMPTY_DUTIES_ROW,
  fourEyesConditionsInForce,
  LOOSENING_WORDS,
  SEPARATIONS,
  separationProblems,
  SIGNING_RULES,
  type DutiesRow,
} from './duties'
import { benchUndoProblem, resultsChanged, resultsInForce } from './results'

const row = (over: Partial<DutiesRow> = {}): DutiesRow => ({ ...EMPTY_DUTIES_ROW, ...over })

describe('separations of duties (QHS-300: inspector, operator, maintenance and people, as permissions)', () => {
  it('every role template keeps every separation', () => {
    const problems = ROLE_TEMPLATES.flatMap((template) => separationProblems({ key: template.key, templateKey: template.key, permissions: template.permissions, grains: template.grains }))
    expect(problems).toEqual([])
  })

  it('names each broken separation: an operator who releases, a quality office that scans, a supervisor who signs a machine safe, quality that sees pay', () => {
    expect(separationProblems({ key: 'custom.op', templateKey: 'operator', permissions: ['production.scan', 'quality.garments.release'] })).toEqual([{ id: 'OPERATOR_SIGNS_NO_QUALITY', role: 'custom.op', permissions: ['quality.garments.release'] }])
    expect(separationProblems({ key: 'custom.qi', templateKey: 'quality_inspector', permissions: ['quality.inspections.record', 'production.cut'] }).map((problem) => problem.id)).toEqual(['QUALITY_MAKES_NOTHING'])
    expect(separationProblems({ key: 'custom.fs', templateKey: 'floor_supervisor', permissions: ['plant.signSafe'] }).map((problem) => problem.id)).toEqual(['ONLY_MAINTENANCE_SIGNS_SAFE'])
    expect(separationProblems({ key: 'custom.qi2', templateKey: 'quality_inspector', permissions: [], grains: ['wages'] })).toEqual([{ id: 'PEOPLE_SIGNS_NO_QUALITY', role: 'custom.qi2', permissions: ['money.wages'] }])
    expect(separationProblems({ key: 'custom.hr', templateKey: 'admin', permissions: ['people.employees.manage', 'quality.holds.release'] }).map((problem) => problem.id)).toEqual(['PEOPLE_SIGNS_NO_QUALITY'])
  })

  it('the owner holds everything by design; a custom role with no template is held to the "only these" rules', () => {
    expect(separationProblems({ key: 'owner', templateKey: 'owner', permissions: templateOf('owner')!.permissions })).toEqual([])
    expect(separationProblems({ key: 'custom.mix', templateKey: null, permissions: ['production.scan', 'quality.garments.release', 'plant.signSafe'] }).map((problem) => problem.id)).toEqual(['ONLY_MAINTENANCE_SIGNS_SAFE'])
    expect(separationProblems({ key: 'custom.reader', templateKey: null, permissions: ['quality.inspections.view', 'production.scan'] })).toEqual([])
  })

  it('names every separation and signing rule once, with Italian and English words; the locked amendment rule has its law', () => {
    expect(new Set(SEPARATIONS.map((rule) => rule.id)).size).toBe(SEPARATIONS.length)
    expect(new Set(SIGNING_RULES.map((rule) => rule.id)).size).toBe(SIGNING_RULES.length)
    for (const rule of [...SEPARATIONS, ...SIGNING_RULES]) expect(rule.words.it.length > 10 && rule.words.en.length > 10).toBe(true)
    expect(SIGNING_RULES.find((rule) => rule.id === 'AMENDMENT_SECOND_SIGNATURE')).toMatchObject({ kind: 'LOCKED', law: { name: 'Reg. (EU) 2016/425 art. 8(4)' } })
    expect(SIGNING_RULES.filter((rule) => rule.kind === 'SETTING').map((rule) => rule.id)).toEqual(['RELEASE_ALONE', 'FOUR_EYES_FOR', 'HOLD_RELEASE'])
  })
})

describe('four-eyes in force (the release trigger read in words)', () => {
  it('reads the conditions as the database does: no row both, else the company and the tenant together', () => {
    expect(fourEyesConditionsInForce(null, null)).toEqual(['CUSTOMER', 'OVERRIDE'])
    expect(fourEyesConditionsInForce([], null)).toEqual([])
    expect(fourEyesConditionsInForce([], ['OVERRIDE'])).toEqual(['OVERRIDE'])
    expect(fourEyesConditionsInForce(['CUSTOMER'], ['OVERRIDE'])).toEqual(['CUSTOMER', 'OVERRIDE'])
  })

  it('asks a second person only for what the conditions name (no conditions given: both, W1)', () => {
    expect(secondPersonReasons({ overridden: true, rule: 'WHEN_REQUIRED', customerListed: true })).toEqual(['OVERRIDE', 'CUSTOMER'])
    expect(secondPersonReasons({ overridden: true, rule: 'WHEN_REQUIRED', customerListed: true, conditions: ['CUSTOMER'] })).toEqual(['CUSTOMER'])
    expect(secondPersonReasons({ overridden: true, rule: 'ALWAYS', customerListed: false, conditions: [] })).toEqual(['ALWAYS'])
    expect(fourEyesWords('WHEN_REQUIRED', [])).toBe('An inspector who made none of the garments releases alone.')
    expect(fourEyesWords('WHEN_REQUIRED', ['OVERRIDE'])).toMatch(/only for overrides\.$/)
  })

  it('a company follows the tenant where it keeps nothing of its own, and cannot drop what every company asks', () => {
    const tenant = row({ releaseFourEyes: 'ALWAYS', fourEyesConditions: ['OVERRIDE'], secondPersonPartyIds: ['p1'] })
    const company = row({ fourEyesConditions: [], placerMayRelease: true })
    const inForce = dutiesInForce(company, tenant)
    expect(inForce.releaseFourEyes).toEqual({ rule: 'ALWAYS', source: 'TENANT' })
    expect(inForce.conditions).toEqual(['OVERRIDE'])
    expect(inForce.conditionsFromTenant).toEqual(['OVERRIDE'])
    expect(inForce.customers).toEqual(['p1'])
    expect(inForce.placerMayRelease).toEqual({ value: true, source: 'COMPANY' })
    // Tenant-wide: the tenant row alone.
    expect(dutiesInForce(undefined, null).conditions).toEqual(['CUSTOMER', 'OVERRIDE'])
  })
})

describe('loosening (design qs-loosen: a fresh code; tightening never asks)', () => {
  const before = dutiesInForce(null, row({ releaseFourEyes: 'ALWAYS', secondPersonPartyIds: ['p1', 'p2'] }))
  it('names what a change loosens, compared in force', () => {
    const after = dutiesInForce(null, row({ releaseFourEyes: 'WHEN_REQUIRED', fourEyesConditions: ['CUSTOMER'], secondPersonPartyIds: ['p1'], placerMayRelease: true }))
    expect(dutiesLoosenings(before, after)).toEqual(['RELEASE_ALONE', 'OVERRIDE_ALONE', 'CUSTOMERS_REMOVED', 'PLACER_RELEASES'])
    expect(dutiesLoosenings(before, dutiesInForce(null, row({ releaseFourEyes: 'ALWAYS', fourEyesConditions: ['OVERRIDE'], secondPersonPartyIds: ['p1', 'p2'] })))).toEqual(['CUSTOMER_ALONE'])
  })
  it('tightening, and a company untick of what every company asks, loosen nothing', () => {
    const tight = dutiesInForce(null, row({ releaseFourEyes: 'ALWAYS', secondPersonPartyIds: ['p1', 'p2', 'p3'] }))
    expect(dutiesLoosenings(before, tight)).toEqual([])
    const tenant = row({ fourEyesConditions: ['OVERRIDE', 'CUSTOMER'] })
    expect(dutiesLoosenings(dutiesInForce(row(), tenant), dutiesInForce(row({ fourEyesConditions: [] }), tenant))).toEqual([])
  })
  it('says each loosening from now on, in both languages', () => {
    expect(LOOSENING_WORDS.OVERRIDE_ALONE.en).toBe('From now on one person can release overridden results and conditional releases.')
    expect(LOOSENING_WORDS.PLACER_RELEASES.it).toMatch(/^D'ora in poi/)
    expect(dutiesChanged(row(), row({ placerMayRelease: false, fourEyesConditions: ['CUSTOMER', 'OVERRIDE'] }))).toEqual(['placerMayRelease'])
  })
})

describe('result rules', () => {
  it('reads the company row, then every company, then the default', () => {
    expect(resultsInForce(null, null)).toEqual({ stopAtRejectNumber: { value: false, source: 'DEFAULT' }, benchUndoSeconds: { value: 10, source: 'DEFAULT' } })
    expect(resultsInForce({ stopAtRejectNumber: null, benchUndoSeconds: 30 }, { stopAtRejectNumber: true, benchUndoSeconds: 5 })).toEqual({ stopAtRejectNumber: { value: true, source: 'TENANT' }, benchUndoSeconds: { value: 30, source: 'COMPANY' } })
  })
  it('keeps the undo window in 0..300 seconds', () => {
    expect(benchUndoProblem(0)).toBeNull()
    expect(benchUndoProblem(300)).toBeNull()
    expect(benchUndoProblem(301)?.path).toBe('benchUndoSeconds')
    expect(benchUndoProblem(2.5)?.path).toBe('benchUndoSeconds')
    expect(resultsChanged({ stopAtRejectNumber: null, benchUndoSeconds: 10 }, { stopAtRejectNumber: false, benchUndoSeconds: 10 })).toEqual(['stopAtRejectNumber'])
  })
})

describe('alert and escalation rules (QHS-154)', () => {
  const draft = (over: Partial<AlertRuleDraft> = {}): AlertRuleDraft => ({ event: 'INSPECTION_WAITING', audience: 'ROLE', roleId: 'r1', withinMinutes: 240, daysBefore: [], channels: ['IN_APP'], ...over })

  it('checks a rule as the database does, plus the bell and an owner the record names', () => {
    expect(alertRuleProblems(draft())).toEqual([])
    expect(alertRuleProblems(draft({ roleId: null })).map((issue) => issue.path)).toEqual(['roleId'])
    expect(alertRuleProblems(draft({ audience: 'OWNER' })).map((issue) => issue.path)).toEqual(['roleId'])
    expect(alertRuleProblems(draft({ event: 'CERTIFICATE_EXPIRING', withinMinutes: 0, daysBefore: [180, 90, 30], audience: 'OWNER_AND_ROLE' })).map((issue) => issue.path)).toEqual(['audience'])
    expect(alertRuleProblems(draft({ event: 'CERTIFICATE_EXPIRING', withinMinutes: 0, daysBefore: [] })).map((issue) => issue.path)).toEqual(['daysBefore'])
    expect(alertRuleProblems(draft({ event: 'CERTIFICATE_EXPIRING', withinMinutes: 60, daysBefore: [30] })).map((issue) => issue.path)).toEqual(['withinMinutes'])
    expect(alertRuleProblems(draft({ daysBefore: [30] })).map((issue) => issue.path)).toEqual(['daysBefore'])
    expect(alertRuleProblems(draft({ channels: ['EMAIL'] })).map((issue) => issue.path)).toEqual(['channels'])
    expect(alertRuleProblems(draft({ withinMinutes: 43_201 })).map((issue) => issue.path)).toEqual(['withinMinutes'])
    expect(sortedDays([30, 180, 90, 30])).toEqual([180, 90, 30])
  })

  it('says a rule as one sentence in the reader’s language', () => {
    expect(alertRuleSentence({ event: 'HOLD_PLACED', audience: 'OWNER', withinMinutes: 0, daysBefore: [], channels: ['IN_APP'] }, null, 'en')).toBe("When goods are put on hold, tell the hold's owner at once, by the bell.")
    expect(alertRuleSentence({ event: 'INSPECTION_WAITING', audience: 'ROLE', withinMinutes: 240, daysBefore: [], channels: ['IN_APP', 'EMAIL'] }, 'Floor supervisor', 'en')).toBe(
      "When an inspection waits more than 4 hours to be signed, tell everyone with the role Floor supervisor, by the bell and by e-mail in the person's digest.",
    )
    expect(alertRuleSentence({ event: 'CERTIFICATE_EXPIRING', audience: 'ROLE', withinMinutes: 0, daysBefore: [180, 90, 30], channels: ['IN_APP'] }, 'Ispettore qualità', 'it')).toBe(
      'Quando un certificato scade tra 180 / 90 / 30 giorni, avvisa chi ha il ruolo Ispettore qualità, con la campanella.',
    )
    expect(alertRuleSentence({ event: 'CRITICAL_NCR', audience: 'OWNER_AND_ROLE', withinMinutes: 90, daysBefore: [], channels: ['IN_APP'] }, 'Quality', 'en')).toMatch(/^When a critical NCR is still open 90 minutes after it was raised, tell the NCR's owner and everyone with the role Quality, by the bell\.$/)
    expect(alertRuleSentence({ event: 'CAPA_ACTION_OVERDUE', audience: 'OWNER', withinMinutes: 1440, daysBefore: [], channels: ['IN_APP', 'EMAIL'] }, null, 'en')).toMatch(/with a task in My tasks and the bell\.$/)
    expect(durationWords(60, 'it')).toBe('1 ora')
    expect(durationWords(2880, 'en')).toBe('2 days')
    expect(firingTitle({ event: 'CERTIFICATE_EXPIRING', withinMinutes: 0, step: 30, date: '2026-12-03' }, 'en')).toBe('the certificate expires in 30 days, on 03/12/2026 (quality rule)')
    for (const event of QUALITY_ALERT_EVENTS) expect(EVENT_FACTS[event].when.it && EVENT_FACTS[event].when.en).toBeTruthy()
  })

  it('applies a company’s own rules when it has any, else the rules of every company', () => {
    const rows = [
      { id: 'all', companyId: null, event: 'HOLD_PLACED' as const, enabled: true },
      { id: 'a-off', companyId: 'A', event: 'HOLD_PLACED' as const, enabled: false },
      { id: 'all-ncr', companyId: null, event: 'CRITICAL_NCR' as const, enabled: true },
    ]
    expect(rulesInForce(rows, 'A', 'HOLD_PLACED')).toEqual([])
    expect(rulesInForce(rows, 'B', 'HOLD_PLACED').map((rule) => rule.id)).toEqual(['all'])
    expect(rulesInForce(rows, 'A', 'CRITICAL_NCR').map((rule) => rule.id)).toEqual(['all-ncr'])
    expect(rulesInForce(rows, null, 'HOLD_PLACED').map((rule) => rule.id)).toEqual(['all'])
    expect(shadowedFor(rows[0]!, rows, 'A')).toBe(true)
    expect(shadowedFor(rows[0]!, rows, 'B')).toBe(false)
  })

  it('fires a wait once crossed (never older than a week), and a date rule at the latest step reached', () => {
    const now = new Date('2026-11-03T12:00:00Z')
    expect(waitDue(new Date('2026-11-03T07:00:00Z'), 240, now).due).toBe(true)
    expect(waitDue(new Date('2026-11-03T09:00:00Z'), 240, now).due).toBe(false)
    expect(waitDue(new Date('2026-10-20T09:00:00Z'), 240, now).due).toBe(false)
    expect(daysStepDue('2027-05-01', '2026-11-03', [180, 90, 30])).toBe(180)
    expect(daysStepDue('2026-11-23', '2026-11-03', [180, 90, 30])).toBe(30)
    expect(daysStepDue('2027-12-01', '2026-11-03', [180, 90, 30])).toBeNull()
    expect(daysStepDue('2026-11-02', '2026-11-03', [180, 90, 30])).toBeNull()
    expect(firingKey('r', 'x', 30, '2026-11-23')).toBe('quality-alert:r:x:30:2026-11-23')
  })

  it('offers the design’s rules for every company that are missing, each a valid rule', () => {
    expect(missingStarterRules(new Set(['HOLD_PLACED', 'CAPA_ACTION_OVERDUE'])).map((rule) => rule.event)).toEqual(['CRITICAL_NCR', 'SAFETY_COMPLAINT', 'INSPECTION_WAITING', 'CERTIFICATE_EXPIRING', 'RELEASE_WAITING_SECOND_PERSON'])
    for (const rule of STARTER_ALERT_RULES) expect(alertRuleProblems({ ...rule, roleId: rule.roleKey ? 'role' : null })).toEqual([])
    for (const rule of STARTER_ALERT_RULES) if (rule.roleKey) expect(templateOf(rule.roleKey)?.audience).toBe('office')
  })

  it('gives quality the rules page and the alert rules; production and the supervisor read them', () => {
    expect(templateOf('quality_inspector')!.permissions).toEqual(expect.arrayContaining(['quality.rules.view', 'quality.alerts.manage']))
    expect(templateOf('production_manager')!.permissions).toContain('quality.rules.view')
    expect(templateOf('floor_supervisor')!.permissions).toContain('quality.rules.view')
    expect(templateOf('read_only')!.permissions).toContain('quality.rules.view')
    expect(templateOf('read_only')!.permissions).not.toContain('quality.alerts.manage')
  })
})
