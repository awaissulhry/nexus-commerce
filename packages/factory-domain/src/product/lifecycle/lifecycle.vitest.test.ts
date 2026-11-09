import { describe, expect, it } from 'vitest'
import { DEFAULT_EDIT_RULES, editAllowance, editKindOfFields, editRefusal, editRuleFor, editRuleTable, isBackward, LIFECYCLE_MOVES, moveRefusal, replacementRefusal, STYLE_LIFECYCLES, type MoveFacts } from './rules'

const facts = (from: MoveFacts['from'], extra: Partial<MoveFacts> = {}): MoveFacts => ({ code: 'TEST-JKT-01', status: 'ACTIVE', from, releasedRevision: true, ...extra })

describe('lifecycle moves (PRD-007)', () => {
  it('goes forward up to approved, into production only from approved with a released revision', () => {
    expect(moveRefusal(facts('CONCEPT'), 'DEVELOPMENT')).toBeNull()
    expect(moveRefusal(facts('CONCEPT'), 'APPROVED')).toBeNull()
    expect(moveRefusal(facts('CONCEPT'), 'IN_PRODUCTION')).toMatchObject({ code: 'MOVE_NOT_ALLOWED', message: expect.stringContaining('goes into production once it is approved') })
    expect(moveRefusal(facts('APPROVED', { releasedRevision: false }), 'IN_PRODUCTION')).toMatchObject({ code: 'NEEDS_RELEASED_REVISION', message: 'Style TEST-JKT-01 has no released revision: release its BOM and routing before it goes into production.' })
    expect(moveRefusal(facts('APPROVED'), 'IN_PRODUCTION')).toBeNull()
    expect(moveRefusal(facts('IN_PRODUCTION'), 'PHASE_OUT')).toBeNull()
    expect(moveRefusal(facts('PHASE_OUT'), 'DISCONTINUED')).toBeNull()
  })

  it('never goes back from production to development; a move back needs the reason', () => {
    expect(moveRefusal(facts('IN_PRODUCTION'), 'DEVELOPMENT')).toMatchObject({ code: 'MOVE_NOT_ALLOWED', message: expect.stringContaining('changes through a new revision') })
    expect(isBackward('SAMPLING', 'DEVELOPMENT')).toBe(true)
    expect(moveRefusal(facts('SAMPLING'), 'DEVELOPMENT')).toMatchObject({ code: 'REASON_NEEDED' })
    expect(moveRefusal(facts('SAMPLING', { reason: '  ' }), 'DEVELOPMENT')).toMatchObject({ code: 'REASON_NEEDED' })
    expect(moveRefusal(facts('SAMPLING', { reason: 'Fit sample failed' }), 'DEVELOPMENT')).toBeNull()
    expect(moveRefusal(facts('DISCONTINUED', { reason: 'Back by demand' }), 'IN_PRODUCTION')).toBeNull()
  })

  it('refuses the same state and an archived style', () => {
    expect(moveRefusal(facts('APPROVED'), 'APPROVED')).toMatchObject({ code: 'SAME_STATE', message: 'Style TEST-JKT-01 is already approved.' })
    expect(moveRefusal(facts('CONCEPT', { status: 'ARCHIVED' }), 'DEVELOPMENT')).toMatchObject({ code: 'STYLE_ARCHIVED' })
  })

  it('every state can be discontinued but discontinued itself, and no move goes to itself', () => {
    for (const state of STYLE_LIFECYCLES) {
      expect(LIFECYCLE_MOVES[state]).not.toContain(state)
      if (state !== 'DISCONTINUED') expect(LIFECYCLE_MOVES[state]).toContain('DISCONTINUED')
    }
  })

  it('names a replacing style only while phased out or discontinued, never itself, a dead style or a circle', () => {
    const replacement = { id: 'b', code: 'TEST-JKT-02', status: 'ACTIVE' as const, lifecycle: 'IN_PRODUCTION' as const, fitsCompany: true, chain: [] as string[] }
    const base = { code: 'TEST-JKT-01', styleId: 'a', state: 'PHASE_OUT' as const }
    expect(replacementRefusal({ ...base, replacement })).toBeNull()
    expect(replacementRefusal({ ...base, replacement: null })).toBeNull()
    expect(replacementRefusal({ ...base, state: 'IN_PRODUCTION', replacement })).toMatchObject({ code: 'REPLACEMENT_NOT_HERE' })
    expect(replacementRefusal({ ...base, replacement: { ...replacement, id: 'a' } })).toMatchObject({ code: 'REPLACEMENT_SELF' })
    expect(replacementRefusal({ ...base, replacement: { ...replacement, lifecycle: 'DISCONTINUED' } })).toMatchObject({ code: 'REPLACEMENT_UNUSABLE', message: 'Style TEST-JKT-02 is discontinued: it cannot replace TEST-JKT-01.' })
    expect(replacementRefusal({ ...base, replacement: { ...replacement, fitsCompany: false } })).toMatchObject({ code: 'REPLACEMENT_UNUSABLE' })
    expect(replacementRefusal({ ...base, replacement: { ...replacement, chain: ['c', 'a'] } })).toMatchObject({ code: 'REPLACEMENT_CIRCLE' })
  })
})

describe('the edit rule per state (PRD-182)', () => {
  it('reads the company row, then the tenant-wide row, then the default', () => {
    expect(editRuleFor('IN_PRODUCTION', null, null)).toEqual({ rule: DEFAULT_EDIT_RULES.IN_PRODUCTION, source: 'DEFAULT' })
    expect(editRuleFor('IN_PRODUCTION', { editRuleInProduction: null }, { editRuleInProduction: 'CHANGE_ORDER' })).toEqual({ rule: 'CHANGE_ORDER', source: 'TENANT' })
    expect(editRuleFor('IN_PRODUCTION', { editRuleInProduction: 'BLOCKED' }, { editRuleInProduction: 'CHANGE_ORDER' })).toEqual({ rule: 'BLOCKED', source: 'COMPANY' })
    expect(editRuleTable(null, { editRuleConcept: 'NEW_REVISION' }).map((entry) => entry.rule)).toEqual(['NEW_REVISION', 'FREE', 'FREE', 'NEW_REVISION', 'NEW_REVISION', 'NEW_REVISION', 'BLOCKED'])
  })

  it('tells words from spec', () => {
    expect(editKindOfFields(['name', 'season'])).toBe('DETAILS')
    expect(editKindOfFields(['name', 'sizes'])).toBe('SPEC')
    expect(editKindOfFields(['ppeClass'])).toBe('SPEC')
  })

  it('FREE allows all; BLOCKED none; NEW_REVISION wants a draft for the spec; CHANGE_ORDER refuses a new revision', () => {
    const open = { code: 'TEST-JKT-01', lifecycle: 'APPROVED' as const, draftRevision: 2 }
    const closed = { ...open, draftRevision: null }
    expect(Object.values(editAllowance('FREE', closed)).every((refusal) => refusal === null)).toBe(true)
    expect(Object.values(editAllowance('BLOCKED', open)).every((refusal) => refusal?.code === 'EDIT_BLOCKED')).toBe(true)
    expect(editRefusal('NEW_REVISION', 'DETAILS', closed)).toBeNull()
    expect(editRefusal('NEW_REVISION', 'SPEC', closed)).toMatchObject({ code: 'NEEDS_NEW_REVISION', message: 'Style TEST-JKT-01 is approved: its spec changes only with a new revision. Start a new revision first; the change goes out with it.' })
    expect(editRefusal('NEW_REVISION', 'SPEC', open)).toBeNull()
    expect(editRefusal('NEW_REVISION', 'NEW_REVISION', closed)).toBeNull()
    expect(editRefusal('CHANGE_ORDER', 'DETAILS', closed)).toBeNull()
    expect(editRefusal('CHANGE_ORDER', 'SPEC', closed)).toMatchObject({ code: 'NEEDS_CHANGE_ORDER' })
    expect(editRefusal('CHANGE_ORDER', 'NEW_REVISION', closed)).toMatchObject({ code: 'NEEDS_CHANGE_ORDER', message: expect.stringContaining('change orders are not available yet') })
    expect(editRefusal('CHANGE_ORDER', 'DRAFT', open)).toBeNull()
    expect(editRefusal('CHANGE_ORDER', 'RELEASE', open)).toBeNull()
  })
})
