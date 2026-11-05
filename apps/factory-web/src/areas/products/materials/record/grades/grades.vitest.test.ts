import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen } from '../fixtures'
import { GRADE_ROWS, GRADES_VIEW } from './demo'
import { cellPlan, defaultHeld, defaultPlans, gradesCount, gradesHeld, historyOf, markKey, panelsProblem, parsePanels, parseShare, refusalOf, shareText, shownText, useAgainHeld } from './grades-model'

/** B-W2b-131 (SCR-048 › Properties & grades › Grades and usable area; PRD-031): the section's rules and words, made-up data. */

const [A, B, C, D] = GRADE_ROWS as [(typeof GRADE_ROWS)[number], (typeof GRADE_ROWS)[number], (typeof GRADE_ROWS)[number], (typeof GRADE_ROWS)[number]]

describe('a share and panels as people type and read them', () => {
  it('takes a decimal comma or point, a percent sign, and refuses what the API refuses', () => {
    expect(parseShare('74,5')).toBe('74.5')
    expect(parseShare(' 74.5 ')).toBe('74.5')
    expect(parseShare('74 %')).toBe('74')
    expect(parseShare('100')).toBe('100')
    expect(parseShare('0')).toBe('0')
    expect(parseShare('100.01')).toBeNull()
    expect(parseShare('72.555')).toBeNull()
    expect(parseShare('-3')).toBeNull()
    expect(parseShare('abc')).toBeNull()
    expect(parseShare('')).toBeNull()
  })

  it('reads a share exactly, without trailing zeros, with the language’s decimal mark', () => {
    expect(shareText('74.50', 'it')).toBe('74,5')
    expect(shareText('74.50', 'en')).toBe('74.5')
    expect(shareText('88.00', 'it')).toBe('88')
    expect(shareText('58.05', 'en')).toBe('58.05')
  })

  it('keeps panels trimmed, each once (any case), in the order typed; at most 20 of at most 60 characters', () => {
    expect(parsePanels(' Front , back; FRONT\nSleeve,, ')).toEqual(['Front', 'back', 'Sleeve'])
    expect(parsePanels('')).toEqual([])
    expect(panelsProblem(Array.from({ length: 21 }, (_, index) => `P${index}`))).toBe('material.grades.problem.panelsMany')
    expect(panelsProblem(['x'.repeat(61)])).toBe('material.grades.problem.panelLong')
    expect(panelsProblem(['Front'])).toBeNull()
  })
})

describe('what a cell typed becomes', () => {
  it('changes the article’s own rule at its version', () => {
    expect(cellPlan(A, 'share', '90')).toEqual({ kind: 'edit', rule: { id: A.rule!.id, version: A.rule!.version }, patch: { usableShare: '90' } })
    expect(cellPlan(C, 'panels', 'Sottocollo')).toEqual({ kind: 'edit', rule: { id: C.rule!.id, version: C.rule!.version }, patch: { panels: ['Sottocollo'] } })
  })

  it('creates the article’s rule on a grade that uses its default: the share typed with the default’s panels, or the default share with the panels typed', () => {
    expect(cellPlan(B, 'share', '72,5')).toEqual({ kind: 'create', body: { gradeId: B.grade.id, usableShare: '72.5', panels: [] } })
    expect(cellPlan(B, 'panels', 'Fianchi, Maniche')).toEqual({ kind: 'create', body: { gradeId: B.grade.id, usableShare: '74.00', panels: ['Fianchi', 'Maniche'] } })
  })

  it('does nothing for the same value, and says why it cannot be kept', () => {
    expect(cellPlan(A, 'share', '88')).toEqual({ kind: 'none' })
    expect(cellPlan(A, 'share', '88,00')).toEqual({ kind: 'none' })
    expect(cellPlan(C, 'panels', 'Sottocollo, Taschino interno')).toEqual({ kind: 'none' })
    expect(cellPlan(B, 'share', '120')).toEqual({ kind: 'problem', problem: 'material.grades.problem.share' })
    // A retired grade takes no new rule; its existing rule may still change.
    expect(cellPlan({ ...D, rule: null, source: 'GRADE', share: '40.00', panels: [] }, 'share', '50')).toEqual({ kind: 'problem', problem: 'material.grades.problem.retiredGrade' })
    expect(cellPlan(D, 'share', '50').kind).toBe('edit')
  })

  it('shows the text typed while it saves or waits, the stored value once refused', () => {
    const key = markKey(B.grade.id, 'share')
    expect(shownText(B, 'share', { [key]: { state: 'saving', value: '72,5' } }, 'it')).toBe('72,5')
    expect(shownText(B, 'share', { [key]: { state: 'waiting', value: '70' } }, 'it')).toBe('70')
    expect(shownText(B, 'share', { [key]: { state: 'refused', value: '120', problem: 'material.grades.problem.share' } }, 'it')).toBe('74')
    expect(shownText(C, 'panels', {}, 'en')).toBe('Sottocollo, Taschino interno')
  })
})

describe('who may change the section, and the row’s moves', () => {
  it('is read only when archived, for a material of every company without a grant over every company, without the edit right', () => {
    expect(gradesHeld(GRADES_VIEW, false, true)).toBeNull()
    expect(gradesHeld(GRADES_VIEW, true, true)).toBe('material.grades.readOnly.archived')
    expect(gradesHeld({ ...GRADES_VIEW, canManage: false, material: { ...GRADES_VIEW.material, companyId: null } }, false, true)).toBe('material.grades.readOnly.everyCompany')
    expect(gradesHeld({ ...GRADES_VIEW, canManage: false }, false, false)).toBe('material.grades.readOnly.noManage')
  })

  it('takes only grades with the article’s own rule back to the default', () => {
    expect(defaultPlans(GRADE_ROWS, [A.grade.id, B.grade.id]).map((plan) => plan.gradeId)).toEqual([A.grade.id])
    expect(defaultHeld(GRADE_ROWS, [B.grade.id], null, false)).toBe('material.grades.held.noRule')
    expect(defaultHeld(GRADE_ROWS, [A.grade.id], null, true)).toBe('held.busy')
    expect(defaultHeld(GRADE_ROWS, [A.grade.id], 'material.grades.readOnly.noManage', false)).toBe('material.grades.readOnly.noManage')
    expect(defaultHeld(GRADE_ROWS, [A.grade.id, C.grade.id], null, false)).toBeNull()
  })

  it('uses an earlier rule again only while the grade is active and has no rule of the article', () => {
    expect(useAgainHeld(C, null)).toBe('material.grades.held.activeExists')
    expect(useAgainHeld({ ...C, rule: null }, null)).toBeNull()
    expect(useAgainHeld({ ...D, rule: null }, null)).toBe('material.grades.held.gradeRetired')
    expect(historyOf(C).map((rule) => rule.usableShare)).toEqual(['60.00', '52.00'])
  })

  it('counts grades and the article’s own rules', () => {
    expect(gradesCount(GRADES_VIEW)).toEqual({ grades: 4, rules: 3 })
  })
})

describe('a refused write in our words', () => {
  const conflict = (path?: string) => new ApiError('conflict', 409, path ? 'version_conflict' : 'conflict', 'x', null, path ? [{ path }] : [])
  it('reads again when the rule changed meanwhile, the article got a rule, or another rule is active', () => {
    expect(refusalOf(conflict('version'), 'edit')).toEqual({ key: 'material.grades.problem.moved', reload: true })
    expect(refusalOf(conflict(), 'create')).toEqual({ key: 'material.grades.problem.ruleExists', reload: true })
    expect(refusalOf(conflict(), 'reactivate')).toEqual({ key: 'material.grades.problem.otherActive', reload: true })
    expect(refusalOf(conflict(), 'edit')).toEqual({ key: 'material.grades.problem.retiredRule', reload: true })
  })

  it('names the field a 400 refused, and falls back to the library’s words', () => {
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/usableShare' }]), 'create')).toEqual({ key: 'material.grades.problem.share', reload: false })
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/gradeId' }]), 'create')).toEqual({ key: 'material.grades.problem.retiredGrade', reload: true })
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'), 'edit').key).toBe('problem.write.forbidden')
    expect(refusalOf(new Error('offline'), 'edit').key).toBe('problem.write.internal')
  })
})

describe('the grades cases draw in both languages', () => {
  const render = (id: string, locale: 'it' | 'en') => {
    const item = designScreen.cases.find((entry) => entry.id === id)!
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
  }
  it('says the section, the rule in words, and why it is read only', () => {
    expect(render('grades', 'en')).toContain('Grades and usable area')
    expect(render('grades', 'it')).toContain('Scelte e area utilizzabile')
    expect(render('grades-read-only', 'en')).toContain('Read only: your role can view the grades')
    expect(render('grades-every-company', 'en')).toContain('shared by every company')
    expect(render('grades-not-leather', 'it')).toContain('non è seguita pelle per pelle')
    // The server render escapes the apostrophe of "Couldn't".
    expect(render('grades-error', 'en')).toContain('load grades')
  })
})
