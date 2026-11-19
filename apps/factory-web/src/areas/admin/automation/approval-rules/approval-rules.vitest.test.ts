import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { automationAddress, BUILT, viewOf } from '../model'
import { approvalRulesModel, DEMO_APPROVAL_RULES, DEMO_HELD_RULE, DEMO_KINDS, DEMO_RETIRED_RULE } from './demo'
import { bodyOf, builderOf, changesOf, conditionOf, draftOf, fieldsOf, isRetired, newDraft, newHeld, offeredKinds, saveHeld, sortedRules, stateWords, switchHeld } from './model'
import { newRuleKindOf } from './new-kind/new-kind'
import { rulesProblem } from './use-approval-rules'

/** Admin › Automation › Approval rules (B-W2b-307; PLT-086, PLT-042, PLT-105): the pop-up's draft and every held reason. */

const ON = DEMO_APPROVAL_RULES[0]!
const OFF = DEMO_APPROVAL_RULES[1]!
const UNREGISTERED = DEMO_APPROVAL_RULES[2]!
const free = { manage: true, offline: false, busy: false, rule: null, builderHeld: null }

describe('the list of rules', () => {
  it('is built in Admin › Automation (`?view=approvals`), its pop-up in the address', () => {
    expect(BUILT.has('approvals')).toBe(true)
    expect(viewOf('approvals')).toBe('approvals')
    expect(automationAddress({ view: 'approvals', rule: ON.id })).toBe(`?view=approvals&rule=${ON.id}`)
  })

  it('the switch is held with the reason: no right, a rule I may not change, offline, saving, a kind with no checker', () => {
    const state = { manage: true, offline: false, saving: [] as string[] }
    expect(switchHeld(ON, state)).toBeNull()
    expect(switchHeld(ON, { ...state, manage: false })).toBe('rules.held.noManage')
    expect(switchHeld(DEMO_HELD_RULE, state)).toBe('rules.held.cannotChange')
    expect(switchHeld(ON, { ...state, offline: true })).toBe('rules.held.offline')
    expect(switchHeld(ON, { ...state, saving: [ON.id] })).toBe('inbox.held.busy')
    expect(switchHeld(UNREGISTERED, state)).toBe('rules.held.notRegistered')
  })

  it('New rule is held until the rules and kinds are read, and for a reader', () => {
    expect(newHeld(approvalRulesModel())).toBeNull()
    expect(newHeld(approvalRulesModel({ manage: false }))).toBe('rules.held.noManage')
    expect(newHeld(approvalRulesModel({ kinds: { status: 'loading' } }))).toBe('rules.held.reading')
    expect(newHeld(approvalRulesModel({ kinds: { status: 'ready', data: { ...DEMO_KINDS, kinds: [] } } }))).toBe('rules.held.noKinds')
  })

  it('rules by area in the kinds’ order, then by their order', () => {
    expect(sortedRules(DEMO_APPROVAL_RULES, DEMO_KINDS.kinds).map((rule) => rule.name)).toEqual(['New suppliers', 'Orders over 5,000', 'Price rises'])
  })
})

describe('the rule pop-up', () => {
  it('RuleBuilder ⇄ the API: rows as they were; a held threshold is never shown', () => {
    expect(conditionOf(builderOf(ON.condition))).toEqual({ combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '5000' }] })
    expect(builderOf(DEMO_HELD_RULE.condition).rows[0]!.value).toBeNull()
    // An unfinished row is not sent.
    expect(conditionOf({ combinator: 'or', rows: [{ id: 'x', field: null, operator: null, value: null }] })).toEqual({ combinator: 'or', rows: [] })
  })

  it('the kind’s facts in the person’s language; a money fact without its grain is listed, held', () => {
    const kind = { ...DEMO_KINDS.kinds[0]!, fields: DEMO_KINDS.kinds[0]!.fields.map((field) => (field.id === 'orderValue' ? { ...field, heldReason: 'cost' } : field)) }
    const fields = fieldsOf(kind, 'it', 'Non puoi vederlo')
    expect(fields[0]).toMatchObject({ id: 'orderValue', label: "valore dell'ordine", kind: 'number', min: 0, heldReason: 'Non puoi vederlo' })
    expect(fields[3]!.options).toEqual([{ value: 'PROSPECT', label: 'Potenziale' }, { value: 'ACTIVE', label: 'Attivo' }])
  })

  it('Save is held in order: no right, offline, the rule’s own hold, busy, kind, name, approver, a row, the order, the time', () => {
    const draft = { ...newDraft('PURCHASE_ORDER', null), name: 'Big orders', approver: { kind: 'ROLE' as const, id: 'r' } }
    expect(saveHeld(draft, free)).toBeNull()
    expect(saveHeld(draft, { ...free, manage: false })).toBe('rules.held.noManage')
    expect(saveHeld(draft, { ...free, offline: true })).toBe('rules.held.offline')
    expect(saveHeld(draftOf(DEMO_HELD_RULE), { ...free, rule: DEMO_HELD_RULE })).toBe('rules.held.cannotChange')
    expect(saveHeld({ ...draft, kind: null }, free)).toBe('rules.held.kind')
    expect(saveHeld({ ...draft, name: ' ' }, free)).toBe('rules.held.name')
    expect(saveHeld({ ...draft, approver: null }, free)).toBe('rules.held.approver')
    expect(saveHeld(draft, { ...free, builderHeld: 'Row 1: enter a value' })).toBe('rules.held.condition')
    expect(saveHeld({ ...draft, sequence: '0' }, free)).toBe('rules.held.sequence')
    expect(saveHeld({ ...draft, dueHours: '3000' }, free)).toBe('rules.held.dueHours')
  })

  it('the body: a code only with a meaning; an edit sends what changed (never a held condition)', () => {
    const draft = { ...draftOf(ON), meaning: null, stepUp: true }
    expect(bodyOf(draft)).toMatchObject({ approver: { roleId: ON.approver.id }, signatureMeaning: null, requireStepUp: false, sequence: 100, dueHours: 24 })
    expect(changesOf(ON, draftOf(ON))).toEqual({})
    expect(changesOf(ON, { ...draftOf(ON), name: 'Orders over 6,000', dueHours: '' })).toEqual({ name: 'Orders over 6,000', dueHours: null })
    expect(Object.keys(changesOf(DEMO_HELD_RULE, { ...draftOf(DEMO_HELD_RULE), name: 'Renamed' }))).toEqual(['name'])
    expect(OFF.active).toBe(false)
  })

  it('a refusal in words: the approver, the condition, a rule that moved, a held threshold', () => {
    expect(rulesProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/approver/roleId' }]))).toBe('rules.problem.approver')
    expect(rulesProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/condition' }]))).toBe('rules.held.money')
    expect(rulesProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toBe('rules.problem.moved')
    expect(rulesProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('problem.forbidden')
    expect(rulesProblem('nope')).toBe('problem.internal')
  })
})

// ── B-OP-010 (order page plan N2, decision D2; review R-3): office changes apply at once ──
describe('a kind nothing asks any more: the sales order change (B-OP-010)', () => {
  it('is not offered for a new rule — not in the pop-up, not from `&kind=`, and New rule holds when no other kind is left', () => {
    expect(offeredKinds(DEMO_KINDS.kinds).map((kind) => kind.kind)).toEqual(['PURCHASE_ORDER'])
    expect(newRuleKindOf('SALES_ORDER_CHANGE', DEMO_KINDS.kinds)).toBeNull()
    expect(newRuleKindOf('PURCHASE_ORDER', DEMO_KINDS.kinds)).toBe('PURCHASE_ORDER')
    const onlyRetired = { ...DEMO_KINDS, kinds: DEMO_KINDS.kinds.filter((kind) => kind.kind === 'SALES_ORDER_CHANGE') }
    expect(newHeld(approvalRulesModel({ kinds: { status: 'ready', data: onlyRetired } }))).toBe('rules.held.noKinds')
  })

  it('an existing rule of it reads "Off: office changes apply at once" whatever its switch, is only switched off, and is never edited', () => {
    expect(isRetired(DEMO_RETIRED_RULE)).toBe(true)
    expect(isRetired(DEMO_APPROVAL_RULES[0]!)).toBe(false)
    expect(stateWords(DEMO_RETIRED_RULE, 'en')).toEqual({ key: null, words: 'Off: office changes apply at once' })
    expect(stateWords(DEMO_RETIRED_RULE, 'it')).toEqual({ key: null, words: "Disattivata: le modifiche dell'ufficio si applicano subito" })
    expect(stateWords(DEMO_APPROVAL_RULES[0]!, 'en')).toEqual({ key: 'rules.on', words: null })
    const state = { manage: true, offline: false, saving: [] as string[] }
    // Switched on (kept from before): it may be switched off; once off it never goes on again.
    expect(switchHeld(DEMO_RETIRED_RULE, state)).toBeNull()
    expect(switchHeld({ ...DEMO_RETIRED_RULE, active: false }, state)).toBe('rules.held.retired')
    expect(saveHeld(draftOf(DEMO_RETIRED_RULE), { ...free, rule: DEMO_RETIRED_RULE })).toBe('rules.held.retired')
  })

  it("the API's refusal of a new rule or a switch on is said in the page's words", () => {
    expect(rulesProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/RULE_RETIRED' }]))).toBe('rules.held.retired')
  })
})
// ── end B-OP-010 ──
