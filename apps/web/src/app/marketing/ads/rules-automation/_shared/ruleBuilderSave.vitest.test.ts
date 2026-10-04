/**
 * 4h (review 4.5, 4.9, 4.11) — the rule builder saves honestly: Create never asks for AUTO, the edit radio shows the
 * level the rule really has, "All markets" is sent as null, and a refused save shows the server's own sentence.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  AUTOMATE_HELD_AT_CREATE, beltToSave, controlForRule, levelNote, levelRefusedNotice, levelToSend, noAnswerNotice,
  refusalFrom, ruleLevel, saveFailed, saveRefusedNotice, scopeForSave,
} from './ruleBuilderSave'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const builder = read('./RuleBuilder.tsx')

/** 4b's and 4c's refusal body, as `invalidValuesBody` in ads-rule-values.ts writes it. */
const invalid = (problems: string[]) => ({ error: problems.join(' '), problems })

describe('the premises', () => {
  it('JSON drops a key set to undefined — "All markets" sent as undefined never reached the server', () => {
    expect(JSON.stringify({ scopeMarketplace: undefined })).toBe('{}')
    expect(JSON.stringify({ scopeMarketplace: scopeForSave('all') })).toBe('{"scopeMarketplace":null}')
  })
  it('the API refusal shapes this file reads are the ones the API writes', () => {
    expect(read('../../../../../../../api/src/services/advertising/ads-rule-values.ts'))
      .toContain("export const invalidValuesBody = (problems: string[]) => ({ error: problems.join(' '), problems })")
    const crud = read('../../../../../../../api/src/services/advertising/ads-rule-crud.service.ts')
    expect(crud).toMatch(/error: 'gate_not_open'[\s\S]{0,200}message: `/)
  })
})

describe('ruleLevel — the level a stored rule is at', () => {
  it('a switched-off rule is Off whatever its level says', () => {
    expect(ruleLevel({ enabled: false, autonomyLevel: 'AUTO', dryRun: false })).toBe('OFF')
  })
  it('reads autonomyLevel, not dryRun', () => {
    expect(ruleLevel({ enabled: true, autonomyLevel: 'PROPOSE', dryRun: false })).toBe('PROPOSE')
    expect(ruleLevel({ enabled: true, autonomyLevel: 'OBSERVE', dryRun: true })).toBe('OBSERVE')
    expect(ruleLevel({ enabled: true, autonomyLevel: 'AUTO', dryRun: false })).toBe('AUTO')
    expect(ruleLevel({ enabled: true, autonomyLevel: 'OFF', dryRun: true })).toBe('OFF')
  })
  it('only a row without a known level falls back to dryRun', () => {
    expect(ruleLevel({ enabled: true, autonomyLevel: null, dryRun: false })).toBe('AUTO')
    expect(ruleLevel({ enabled: true, dryRun: true })).toBe('PROPOSE')
  })
})

describe('controlForRule — what the edit radio shows', () => {
  const rule = (autonomyLevel: string, control?: string, enabled = true) => ({ enabled, autonomyLevel, dryRun: autonomyLevel !== 'AUTO', actions: [{ type: 'bid', ...(control ? { control } : {}) }] })
  it('🔴 a rule refused AUTO at create (PROPOSE, belt "automate") opens on Manual, not Automate', () => {
    expect(controlForRule(rule('PROPOSE', 'automate'))).toBe('manual')
  })
  it('Automate only when the rule really applies its actions', () => {
    expect(controlForRule(rule('AUTO', 'automate'))).toBe('automate')
    expect(controlForRule(rule('AUTO'))).toBe('automate')
    // the manual belt makes the engine propose at any level
    expect(controlForRule(rule('AUTO', 'manual'))).toBe('manual')
  })
  it('neither radio for a rule that is Off or on Observe, and the note says which', () => {
    expect(controlForRule(rule('OFF'))).toBeNull()
    expect(controlForRule(rule('OBSERVE'))).toBeNull()
    expect(controlForRule(rule('AUTO', 'automate', false))).toBeNull()
    expect(levelNote('OFF')).toMatch(/^This rule is Off now/)
    expect(levelNote('OBSERVE')).toMatch(/^This rule is on Observe now/)
  })
})

describe('levelToSend — the level set after the rule saved', () => {
  it('🔴 a new rule is never sent AUTO, whatever the radio says (D-R1)', () => {
    expect(levelToSend({ isEdit: false, initial: null, chosen: 'automate' })).toBe('PROPOSE')
    expect(levelToSend({ isEdit: false, initial: null, chosen: 'manual' })).toBe('PROPOSE')
  })
  it('an edit sets a level only when the radio changed', () => {
    expect(levelToSend({ isEdit: true, initial: 'manual', chosen: 'manual' })).toBeNull()
    expect(levelToSend({ isEdit: true, initial: null, chosen: null })).toBeNull() // an Off rule, renamed: stays Off
    expect(levelToSend({ isEdit: true, initial: 'manual', chosen: 'automate' })).toBe('AUTO')
    expect(levelToSend({ isEdit: true, initial: 'automate', chosen: 'manual' })).toBe('PROPOSE')
    expect(levelToSend({ isEdit: true, initial: null, chosen: 'manual' })).toBe('PROPOSE')
  })
})

describe('beltToSave — actions[0].control', () => {
  it('a new rule is belted Manual', () => {
    expect(beltToSave({ isEdit: false, initial: null, chosen: 'automate', stored: null })).toBe('manual')
  })
  it('an edit keeps the stored belt unless the radio changed', () => {
    expect(beltToSave({ isEdit: true, initial: 'manual', chosen: 'manual', stored: 'automate' })).toBe('automate')
    expect(beltToSave({ isEdit: true, initial: null, chosen: null, stored: 'automate' })).toBe('automate')
    expect(beltToSave({ isEdit: true, initial: 'manual', chosen: 'automate', stored: 'manual' })).toBe('automate')
    expect(beltToSave({ isEdit: true, initial: null, chosen: null, stored: null })).toBe('manual')
  })
})

describe('refusalFrom — the server says why', () => {
  it('🔴 4c: one problem is shown as its sentence', () => {
    const sentence = 'This rule is scoped to DE, but 3 of its picked campaigns are in ES, FR and IT. Remove those picks, or scope the rule to All markets.'
    expect(refusalFrom(400, invalid([sentence]))).toEqual({ sentence, problems: [] })
  })
  it('4b: more than one problem is a list, not one run-on line', () => {
    const problems = ['Max bid: "12,5,0" is not a number.', 'Decrease by: 120 is more than 100%.']
    expect(refusalFrom(400, invalid(problems))).toEqual({ sentence: 'The server named 2 things to fix:', problems })
  })
  it('an error that is its own summary is kept above the list', () => {
    expect(refusalFrom(400, { error: 'Two values cannot be saved.', problems: ['a b', 'c d'] }).sentence).toBe('Two values cannot be saved.')
  })
  it('🔴 a 409 from the level route shows its message, not its code', () => {
    const message = 'AUTO only after the graduation gate: 3 evaluations — need at least 10 to prove the rule has run.'
    expect(refusalFrom(409, { ok: false, error: 'gate_not_open', maxLevel: 'PROPOSE', failures: ['HAS_EVALUATIONS'], message })).toEqual({ sentence: message, problems: [] })
    expect(refusalFrom(400, { error: 'untranslatable_conditions', metrics: ['X'], message: 'No engine signal exists for: X.' }).sentence).toBe('No engine signal exists for: X.')
  })
  it('a bare code or no body still gets a sentence', () => {
    expect(refusalFrom(404, { error: 'not_found' }).sentence).toBe('This rule no longer exists. It may have been deleted.')
    expect(refusalFrom(502, {}).sentence).toMatch(/^The server failed while saving \(HTTP 502\)/)
    expect(refusalFrom(500, { statusCode: 500, error: 'Internal Server Error', message: 'boom at line 3' }).sentence).toBe('boom at line 3')
    expect(refusalFrom(422, { error: 'weird_code' }).sentence).toBe('The server refused the save (HTTP 422): weird_code.')
    expect(refusalFrom(400, { error: 'name + trigger required' }).sentence).toBe('name + trigger required')
  })
})

describe('saveFailed and the notices', () => {
  it('a 2xx with an error is a failure; a 2xx with the rule is not', () => {
    expect(saveFailed(true, { error: 'x' })).toBe(true)
    expect(saveFailed(true, { rule: { id: 'r1' } })).toBe(false)
    expect(saveFailed(false, {})).toBe(true)
    expect(saveFailed(true, null)).toBe(false)
  })
  it('a refused save is danger; a refused level after a save is a warning that names the mode kept', () => {
    expect(saveRefusedNotice(true, 400, invalid(['x y']))).toMatchObject({ tone: 'danger', title: 'Your changes were not saved', sentence: 'x y' })
    expect(saveRefusedNotice(false, 400, invalid(['x y'])).title).toBe('The rule was not created')
    expect(levelRefusedNotice({ isEdit: true, stays: 'PROPOSE', status: 409, body: { error: 'gate_not_open', message: 'AUTO only after the graduation gate: a b.' } }))
      .toEqual({ tone: 'warning', title: 'Your changes are saved, but the mode is still Manual', sentence: 'AUTO only after the graduation gate: a b.', problems: [] })
    expect(levelRefusedNotice({ isEdit: false, stays: 'OFF', status: 500, body: {} }).title).toBe('The rule is saved, but it is still off')
  })
  it('no answer never claims what was stored', () => {
    expect(noAnswerNotice('save', { isEdit: false, existing: false }).sentence).toMatch(/cannot tell whether the rule was created/)
    expect(noAnswerNotice('save', { isEdit: true, existing: true }).sentence).toMatch(/cannot tell whether your changes were saved/)
    expect(noAnswerNotice('level', { isEdit: true, existing: true }).title).toBe('Your changes are saved, but the mode may not have changed')
  })
})

describe('RuleBuilder uses them', () => {
  it('🔴 sends "All markets" as null on every save, and no silent 409 → PROPOSE fallback is left', () => {
    expect(builder).not.toMatch(/scopeMarketplace: scopeMarket === 'all' \? undefined/)
    expect(builder).not.toMatch(/if \(scopeMarket !== 'all'\) partial\.scopeMarketplace/)
    expect(builder.match(/scopeForSave\(scopeMarket\)/g)?.length).toBe(2)
    expect(builder).not.toMatch(/patchLevel\('PROPOSE'\)/)
    expect(builder).toContain('levelToSend({ isEdit, initial: initialControl.current, chosen: control })')
  })
  it('the edit radio is read from the level, never from actions[0].control', () => {
    expect(builder).not.toMatch(/setControl\(a\.control === 'automate'/)
    expect(builder).toContain('const ctl = controlForRule(rule)')
  })
  it('Automate is held on a new rule with the gate as its reason, and a refusal is a DS Banner', () => {
    expect(builder).toContain('? AUTOMATE_HELD_AT_CREATE')
    expect(AUTOMATE_HELD_AT_CREATE).toMatch(/14 days watched, at least 10 runs and 1 match/)
    expect(builder).toMatch(/<Banner tone=\{saveNotice\.tone\} title=\{saveNotice\.title\}/)
  })
  it('the third cap is named for what it counts, and the spend line says what the ceiling counts', () => {
    expect(builder).toContain('label="Max matches per day"')
    expect(builder).not.toContain('Max runs per day')
    expect(builder).toContain('Dry runs count nothing.')
  })
})
