import { describe, expect, it } from 'vitest'
import { alertRuleSentence } from '@nexus/factory-domain/quality/rules/alerts'
import { LOOSENING_WORDS, LOOSENINGS } from '@nexus/factory-domain/quality/rules/duties'
import en from '../../../../messages/en/quality-rules.json'
import it_ from '../../../../messages/it/quality-rules.json'
import { ALERTS, COMPANY_FRESH, COMPANY_RULES, RULES_FOR_COMPANY, TENANT_RULES } from './demo'
import {
  addressOf,
  bulkHeld,
  changeHeld,
  conditionInherited,
  draftSentence,
  dutiesBody,
  dutiesChanges,
  dutiesDraftOf,
  dutiesLooseningsOf,
  dutiesPreview,
  queryOf,
  removedCustomers,
  resultsBody,
  resultsChanges,
  resultsDraftOf,
  resultsPreview,
  resultsProblem,
  ruleBody,
  ruleDraftOf,
  ruleEdit,
  ruleProblems,
  waitOf,
  withCondition,
  withEvent,
} from './model'

const params = (query: string) => new URLSearchParams(query)

describe('Quality rules (SCR-260): the address', () => {
  it('reads and writes whose rules and the rule dialog', () => {
    expect(addressOf(params(''))).toEqual({ scope: 'company', rule: null })
    expect(addressOf(params('scope=all&rule=new'))).toEqual({ scope: 'all', rule: 'new' })
    expect(queryOf({ scope: 'all', rule: 'r1' })).toBe('?scope=all&rule=r1')
    expect(queryOf({ scope: 'company', rule: null })).toBe('')
  })
})

describe('who may sign what: the card as factory-domain decides it', () => {
  it('starts from the scope’s own row; a company with none follows every company in everything', () => {
    expect(dutiesDraftOf(COMPANY_FRESH)).toEqual({ releaseFourEyes: null, conditions: [], customers: [], placerMayRelease: null })
    expect(dutiesDraftOf({ ...TENANT_RULES, duties: { ...TENANT_RULES.duties, own: null } })).toEqual({ releaseFourEyes: null, conditions: ['CUSTOMER', 'OVERRIDE'], customers: [], placerMayRelease: null })
    expect(dutiesChanges(COMPANY_RULES, dutiesDraftOf(COMPANY_RULES))).toBe(0)
  })

  it('shows what is in force after the draft, with what every company asks kept on', () => {
    const draft = dutiesDraftOf(COMPANY_RULES)
    expect(dutiesPreview(COMPANY_RULES, TENANT_RULES, draft)).toMatchObject({ releaseFourEyes: { rule: 'WHEN_REQUIRED', source: 'TENANT' }, conditions: ['CUSTOMER', 'OVERRIDE'], placerMayRelease: { value: true, source: 'COMPANY' } })
    expect(conditionInherited(COMPANY_RULES, 'OVERRIDE')).toBe(true)
    expect(conditionInherited(TENANT_RULES, 'OVERRIDE')).toBe(false)
    // Unticking at the company level loosens nothing: every company still asks it.
    expect(dutiesLooseningsOf(COMPANY_RULES, TENANT_RULES, withCondition(draft, 'OVERRIDE', false))).toEqual([])
  })

  it('names what a change loosens (the confirm and the code); tighter asks nothing', () => {
    const tenant = dutiesDraftOf(TENANT_RULES)
    expect(dutiesLooseningsOf(TENANT_RULES, TENANT_RULES, { ...tenant, releaseFourEyes: 'ALWAYS' })).toEqual([])
    const looser = { ...tenant, conditions: ['CUSTOMER' as const], customers: [], placerMayRelease: true }
    expect(dutiesLooseningsOf(TENANT_RULES, TENANT_RULES, looser)).toEqual(['OVERRIDE_ALONE', 'CUSTOMERS_REMOVED', 'PLACER_RELEASES'])
    expect(removedCustomers(TENANT_RULES, looser)).toBe(1)
    expect(dutiesBody(TENANT_RULES, looser, 'Night shift')).toEqual({ companyId: null, version: 3, releaseFourEyes: 'WHEN_REQUIRED', fourEyesConditions: ['CUSTOMER'], secondPersonPartyIds: [], placerMayRelease: true, reason: 'Night shift' })
    // Tightening the hold rule at the company asks nothing.
    expect(dutiesLooseningsOf(COMPANY_RULES, TENANT_RULES, { ...dutiesDraftOf(COMPANY_RULES), placerMayRelease: false })).toEqual([])
  })

  it('holds a change with its reason before the click', () => {
    expect(changeHeld(null, false)).toBe('held.reading')
    expect(changeHeld({ ...COMPANY_RULES, mayChange: false }, false)).toBe('held.noRight')
    expect(changeHeld({ ...TENANT_RULES, mayChange: false }, false)).toBe('held.noRightAll')
    expect(changeHeld(COMPANY_RULES, false, true)).toBe('held.offline')
    expect(changeHeld(COMPANY_RULES, true)).toBe('held.busy')
    expect(changeHeld(COMPANY_RULES, false)).toBeNull()
  })

  it('says each loosening in the words factory-domain keeps, in both languages', () => {
    for (const code of LOOSENINGS) {
      expect(en.loosen.code[code]).toBe(LOOSENING_WORDS[code].en)
      expect(it_.loosen.code[code]).toBe(LOOSENING_WORDS[code].it)
    }
  })
})

describe('result rules', () => {
  it('follows, sets and holds the undo window in 0..300 seconds', () => {
    const draft = resultsDraftOf(COMPANY_RULES)
    expect(resultsPreview(COMPANY_RULES, TENANT_RULES, draft)).toEqual({ stopAtRejectNumber: { value: false, source: 'TENANT' }, benchUndoSeconds: { value: 30, source: 'COMPANY' } })
    expect(resultsProblem({ ...draft, benchUndoSeconds: 400 })).toBe('results.undoRange')
    expect(resultsChanges(COMPANY_RULES, { ...draft, stopAtRejectNumber: true })).toBe(1)
    expect(resultsBody(COMPANY_RULES, { ...draft, benchUndoSeconds: null })).toEqual({ companyId: COMPANY_RULES.companyId, version: 2, stopAtRejectNumber: null, benchUndoSeconds: null })
  })
})

describe('alert rules', () => {
  it('reads a rule into the dialog and sends only what changed', () => {
    const rule = RULES_FOR_COMPANY[4]!
    const draft = ruleDraftOf(rule, { companyId: null, roleId: null })
    expect(draft).toMatchObject({ event: 'INSPECTION_WAITING', wait: '4', unit: 'hours', email: false })
    expect(ruleEdit(rule, { ...draft, wait: '2' })).toEqual({ withinMinutes: 120 })
    expect(ruleEdit(rule, { ...draft, email: true, enabled: false })).toEqual({ channels: ['IN_APP', 'EMAIL'], enabled: false })
    expect(waitOf(1440)).toEqual({ wait: '1', unit: 'days' })
    expect(waitOf(45)).toEqual({ wait: '45', unit: 'minutes' })
  })

  it('checks the draft with factory-domain at its fields, and says it as the API does', () => {
    const fresh = ruleDraftOf(null, { companyId: null, roleId: null })
    expect(ruleProblems(fresh)).toEqual({})
    expect(ruleProblems({ ...fresh, event: 'CRITICAL_NCR', audience: 'ROLE', roleId: null })).toEqual({ roleId: 'ruleDialog.problem.roleId' })
    expect(ruleProblems({ ...fresh, wait: '45', unit: 'days' })).toEqual({ wait: 'ruleDialog.problem.wait' })
    const cert = withEvent(fresh, 'CERTIFICATE_EXPIRING', 'r1')
    expect(cert).toMatchObject({ audience: 'ROLE', roleId: 'r1', wait: '0' })
    expect(ruleProblems({ ...cert, days: '30, 30' })).toEqual({ days: 'ruleDialog.problem.days' })
    expect(ruleBody({ ...cert, days: '30, 180 90' })).toMatchObject({ event: 'CERTIFICATE_EXPIRING', audience: 'ROLE', roleId: 'r1', withinMinutes: 0, daysBefore: [180, 90, 30], channels: ['IN_APP'] })
    const rule = RULES_FOR_COMPANY[5]!
    expect(draftSentence(ruleDraftOf(rule, { companyId: null, roleId: null }), ALERTS.roles, 'en')).toBe(alertRuleSentence(rule, rule.role?.name ?? null, 'en'))
    expect(draftSentence(ruleDraftOf(rule, { companyId: null, roleId: null }), ALERTS.roles, 'it')).toBe(rule.sentence.it)
  })

  it('holds a bulk switch with its reason', () => {
    expect(bulkHeld(RULES_FOR_COMPANY, [], true, true, false)).toBe('held.pickRows')
    expect(bulkHeld(RULES_FOR_COMPANY, [RULES_FOR_COMPANY[0]!.id], true, true, false)).toBe('held.allOn')
    expect(bulkHeld(RULES_FOR_COMPANY, [RULES_FOR_COMPANY[6]!.id], true, true, false)).toBeNull()
    expect(bulkHeld(RULES_FOR_COMPANY, [RULES_FOR_COMPANY[6]!.id], true, false, false)).toBe('held.noAlertRight')
  })
})
