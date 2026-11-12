import { describe, expect, it } from 'vitest'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { APPROVALS_PERMISSIONS } from './permissions'
import {
  approvalFingerprint,
  askersOf,
  changedFacts,
  chooseRules,
  conditionHolds,
  conditionProblems,
  isOwnRequest,
  ownRequestWords,
  parseCondition,
  ruleSentence,
  storedCondition,
  type ApprovalField,
  type RuleCandidate,
  type RuleCondition,
} from './rules'

const FIELDS: ApprovalField[] = [
  { id: 'orderValue', label: { en: 'order value', it: "valore dell'ordine" }, kind: 'number', grain: 'cost', min: 0 },
  { id: 'discountPct', label: { en: 'discount', it: 'sconto' }, kind: 'number', unit: '%', min: 0, max: 100 },
  { id: 'supplierStatus', label: { en: 'supplier status', it: 'stato del fornitore' }, kind: 'choice', options: [{ value: 'ACTIVE', label: { en: 'Active', it: 'Attivo' } }, { value: 'BLOCKED', label: { en: 'Blocked', it: 'Bloccato' } }] },
  { id: 'supplierCode', label: { en: 'supplier code', it: 'codice fornitore' }, kind: 'text' },
  { id: 'overLimit', label: { en: 'over the credit limit', it: 'oltre il fido' }, kind: 'yesNo' },
]

const when = (combinator: 'and' | 'or', ...rows: Array<[string, RuleCondition['rows'][number]['operator'], string | string[] | null]>): RuleCondition => ({
  combinator,
  rows: rows.map(([field, operator, value]) => ({ field, operator, value })),
})

describe('the condition (PLT-086)', () => {
  it('compares numbers as decimals, texts without case, choices exactly, yes / no; no row holds for every request', () => {
    const facts = { orderValue: '6200.50', discountPct: 12, supplierStatus: 'ACTIVE', supplierCode: 'Seed-Leather', overLimit: true }
    expect(conditionHolds(when('and', ['orderValue', 'gt', '6200,5']), FIELDS, facts)).toBe(false)
    expect(conditionHolds(when('and', ['orderValue', 'gte', '6200,5']), FIELDS, facts)).toBe(true)
    expect(conditionHolds(when('and', ['orderValue', 'gt', '5000'], ['discountPct', 'gt', '10']), FIELDS, facts)).toBe(true)
    expect(conditionHolds(when('and', ['orderValue', 'gt', '5000'], ['discountPct', 'gt', '15']), FIELDS, facts)).toBe(false)
    expect(conditionHolds(when('or', ['orderValue', 'gt', '9000'], ['discountPct', 'gt', '10']), FIELDS, facts)).toBe(true)
    expect(conditionHolds(when('and', ['supplierStatus', 'in', ['BLOCKED', 'ACTIVE']]), FIELDS, facts)).toBe(true)
    expect(conditionHolds(when('and', ['supplierStatus', 'notIn', ['ACTIVE']]), FIELDS, facts)).toBe(false)
    expect(conditionHolds(when('and', ['supplierStatus', 'eq', 'active']), FIELDS, facts)).toBe(false)
    expect(conditionHolds(when('and', ['supplierCode', 'contains', 'LEATHER']), FIELDS, facts)).toBe(true)
    expect(conditionHolds(when('and', ['overLimit', 'isTrue', null]), FIELDS, facts)).toBe(true)
    expect(conditionHolds(when('and', ['overLimit', 'isFalse', null]), FIELDS, facts)).toBe(false)
    expect(conditionHolds(when('and'), FIELDS, {})).toBe(true)
  })

  it('never holds on a fact the subject does not have, nor on a fact the kind does not expose', () => {
    expect(conditionHolds(when('and', ['orderValue', 'gt', '0']), FIELDS, { orderValue: null })).toBe(false)
    expect(conditionHolds(when('and', ['orderValue', 'ne', '5']), FIELDS, {})).toBe(false)
    expect(conditionHolds(when('or', ['nothing', 'eq', 'x']), FIELDS, { nothing: 'x' })).toBe(false)
  })

  it('says in words what a condition gets wrong for the kind, and refuses a money fact the writer may not see', () => {
    const paths = (condition: RuleCondition, held = new Set<string>()) => conditionProblems(condition, FIELDS, held).map((problem) => problem.path)
    expect(paths(when('and', ['orderValue', 'gt', '5000'], ['supplierStatus', 'in', ['ACTIVE']]))).toEqual([])
    expect(paths(when('and', ['margin', 'gt', '5']))).toEqual(['condition/rows/0/field'])
    expect(paths(when('and', ['orderValue', 'contains', '5']))).toEqual(['condition/rows/0/operator'])
    expect(paths(when('and', ['orderValue', 'gt', 'lots']))).toEqual(['condition/rows/0/value'])
    expect(paths(when('and', ['discountPct', 'gt', '120']))).toEqual(['condition/rows/0/value'])
    expect(paths(when('and', ['supplierStatus', 'eq', 'GONE']))).toEqual(['condition/rows/0/value'])
    expect(paths(when('and', ['overLimit', 'isTrue', 'yes']))).toEqual(['condition/rows/0/value'])
    expect(paths(when('and', ['orderValue', 'gt', '5000']), new Set(['orderValue']))).toEqual(['condition/rows/0/field'])
    expect(conditionProblems(when('and', ['orderValue', 'gt', 'x']), FIELDS)[0]!.message).toBe('Condition 1: order value needs a number.')
  })

  it('keeps a number in its plain decimal form and reads a stored condition back', () => {
    const stored = storedCondition(when('and', ['orderValue', 'gt', ' 5000,50 '], ['supplierCode', 'eq', ' SEED ']), FIELDS)
    expect(stored).toEqual({ combinator: 'and', rows: [{ field: 'orderValue', operator: 'gt', value: '5000.50' }, { field: 'supplierCode', operator: 'eq', value: 'SEED' }] })
    expect(parseCondition(stored)).toEqual(stored)
    expect(parseCondition({ combinator: 'xor', rows: [] })).toBeNull()
    expect(parseCondition({ combinator: 'and', rows: [{ field: 'a', operator: 'like', value: 'x' }] })).toBeNull()
  })
})

describe('which rules ask (PLT-086, PLT-042)', () => {
  const at = new Date('2026-11-11T10:00:00Z')
  const rule = (id: string, data: Partial<RuleCandidate> = {}): RuleCandidate => ({
    id,
    companyId: null,
    sequence: 100,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    active: true,
    effectiveFrom: null,
    condition: when('and', ['orderValue', 'gt', '5000']),
    approverRoleId: 'role-finance',
    approverUserId: null,
    ...data,
  })
  const subject = (askers: string[] = ['buyer']) => ({ companyId: 'A', facts: { orderValue: '6200' }, askers })

  it('reads the rules in force in order; every rule that holds asked, the first names the approver; none: no approval', () => {
    const rules = [
      rule('late', { sequence: 20 }),
      rule('first', { sequence: 10, createdAt: new Date('2026-11-05T00:00:00Z') }),
      rule('older', { sequence: 10 }),
      rule('off', { sequence: 1, active: false }),
      rule('future', { sequence: 1, effectiveFrom: new Date('2026-12-01T00:00:00Z') }),
      rule('companyB', { sequence: 1, companyId: 'B' }),
      rule('small', { sequence: 1, condition: when('and', ['orderValue', 'lt', '100']) }),
    ]
    const choice = chooseRules(rules, subject(), FIELDS, at)
    expect(choice.matched.map((entry) => entry.id)).toEqual(['older', 'first', 'late'])
    expect(choice.deciding?.id).toBe('older')
    expect(chooseRules([rule('small', { condition: when('and', ['orderValue', 'lt', '100']) })], subject(), FIELDS, at)).toEqual({ matched: [], deciding: null, skippedSelf: [] })
  })

  it('skips a rule that names the person asking (nobody approves their own request) for the next one; none left: no approver', () => {
    const rules = [rule('names-buyer', { sequence: 1, approverRoleId: null, approverUserId: 'buyer' }), rule('finance', { sequence: 2 })]
    const choice = chooseRules(rules, subject(), FIELDS, at)
    expect(choice.deciding?.id).toBe('finance')
    expect(choice.skippedSelf.map((entry) => entry.id)).toEqual(['names-buyer'])
    expect(chooseRules([rules[0]!], subject(), FIELDS, at)).toMatchObject({ deciding: null, matched: [{ id: 'names-buyer' }] })
    // The Owner included: a rule naming the Owner skips the Owner's own request.
    expect(chooseRules([rule('owner', { approverRoleId: null, approverUserId: 'owner' })], subject(['owner']), FIELDS, at).deciding).toBeNull()
  })
})

describe('the fingerprint and the re-check (PLT-093)', () => {
  const base = { kind: 'PURCHASE_ORDER', recordType: 'PurchaseOrder', recordId: '019a0000-0000-7000-8000-000000000001', changes: [{ field: 'status', from: 'DRAFT', to: 'SENT' }] }

  it('is the SHA-256 of the change as it will be written: the same for the same content in any key order, another for any change', () => {
    const a = approvalFingerprint({ ...base, subject: { b: 1, a: { d: new Date('2026-11-11T00:00:00Z'), c: null } } })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalFingerprint({ ...base, subject: { a: { c: null, d: '2026-11-11T00:00:00.000Z' }, b: 1 } })).toBe(a)
    expect(approvalFingerprint({ ...base, subject: { b: 2, a: { d: new Date('2026-11-11T00:00:00Z'), c: null } } })).not.toBe(a)
    expect(approvalFingerprint({ ...base, changes: [{ field: 'status', from: 'DRAFT', to: 'CANCELLED' }], subject: { b: 1, a: { d: new Date('2026-11-11T00:00:00Z'), c: null } } })).not.toBe(a)
  })

  it('says which facts changed since it was asked', () => {
    expect(changedFacts([{ field: 'orderValue', value: '6200', grain: 'cost' }, { field: 'lineCount', value: 1 }], [{ field: 'orderValue', value: '6500', grain: 'cost' }, { field: 'lineCount', value: 1 }])).toEqual([
      { field: 'orderValue', was: '6200', now: '6500', grain: 'cost' },
    ])
  })
})

describe('nobody approves their own request (PLT-042, Owner answer Q3 = A)', () => {
  it('names who asked, who wrote it and the floor worker’s office account; says who else can decide', () => {
    expect(askersOf({ requestedById: 'owner', createdById: 'owner' })).toEqual(['owner'])
    expect(askersOf({ requestedById: null, createdById: 'clerk' }, 'worker-account')).toEqual(['clerk', 'worker-account'])
    expect(isOwnRequest(['owner'], 'owner')).toBe(true)
    expect(isOwnRequest(['owner'], 'finance')).toBe(false)
    expect(ownRequestWords(['Lucia', 'Marco'])).toBe('You asked for this: nobody approves their own request, the Owner included. Lucia or Marco can approve it.')
    expect(ownRequestWords([])).toMatch(/Nobody else can approve it yet/)
  })
})

describe('the rule in words (design admin.automation "Rule sentence")', () => {
  it('reads like the design, hides a money threshold the reader may not see, names the signature', () => {
    const input = { kindLabel: { en: 'Purchase order', it: "Ordine d'acquisto" }, condition: when('or', ['orderValue', 'gt', '5000'], ['supplierStatus', 'in', ['BLOCKED']]), fields: FIELDS, approver: 'Finance', meaning: 'RELEASED' as const }
    expect(ruleSentence(input, 'en')).toBe("Purchase order: order value over 5000 or supplier status is one of Blocked → Finance, signed 'Released'")
    expect(ruleSentence({ ...input, hiddenFields: new Set(['orderValue']), meaning: null }, 'it')).toBe("Ordine d'acquisto: valore dell'ordine oltre … o stato del fornitore è uno tra Bloccato → Finance")
    expect(ruleSentence({ ...input, condition: when('and'), meaning: null }, 'en')).toBe('Purchase order: every request → Finance')
  })
})

describe('permissions, roles and events', () => {
  it('every office template that asks or is named may ask and decide; the administrator keeps the rules; read-only only reads', () => {
    expect(templateOf('owner')!.permissions).toEqual(expect.arrayContaining([...APPROVALS_PERMISSIONS]))
    expect(templateOf('admin')!.permissions).toEqual(expect.arrayContaining([...APPROVALS_PERMISSIONS]))
    for (const key of ['finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor']) {
      expect(templateOf(key)!.permissions).toEqual(expect.arrayContaining(['approvals.view', 'approvals.request', 'approvals.decide']))
      expect(templateOf(key)!.permissions).not.toContain('approvals.rules.manage')
    }
    expect(templateOf('read_only')!.permissions.filter((permission) => permission.startsWith('approvals.'))).toEqual(['approvals.view'])
    expect(templateOf('operator')!.permissions.filter((permission) => permission.startsWith('approvals.'))).toEqual([])
  })

  it('declares its events with a live rule for approvals.view and no money', () => {
    for (const type of ['approval.requested', 'approval.decided', 'approval.withdrawn', 'approval.stale', 'approval.rule_changed']) {
      expect(EVENT_CATALOGUE.definitions.find((definition) => definition.type === type)?.live?.permission).toBe('approvals.view')
    }
  })
})
