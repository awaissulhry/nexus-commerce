import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PPE_TEXT_KINDS } from '@nexus/factory-domain/compliance/ppe-texts/rules'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { StepUpCancelled } from '../../../quality/_shared/hooks'
import { DEMO_APPROVALS, DEMO_TEMPLATES, demoAnswer } from './fixtures'
import { approvalsOf, emptyRecordDraft, languagesTyped, PPE_NAMESPACE, ppeProblemOf, readProblemOf, recordBodyOf, recordHeld, templateKeyOf, templateOf, templatesShown, withdrawHeld } from './model'

/** B-W2b-288 (FU2:01) — Compliance › Rules & markets › Templates: the pure rules and the words. */

const answer = demoAnswer({ company: true, everyCompany: true })
const COMPANY = '0190f0e2-0001-7000-8000-000000000001'
const context = { mayCompany: true, mayEvery: true, offline: false, busy: false, companyId: COMPANY }
const file = new File([new Uint8Array([37, 80, 68, 70])], 'check.pdf', { type: 'application/pdf' })
const ready = { ...emptyRecordDraft('DOC:annex-ix.1', true), languages: 'IT, en', checkedBy: 'Demo consultant', file, fileName: 'check.pdf' }

describe('the templates and their approvals', () => {
  it('keeps the templates the kind and the words ask, in the API’s order', () => {
    expect(templatesShown(answer, { q: '', kind: null })?.map(templateKeyOf)).toEqual(DEMO_TEMPLATES.map(templateKeyOf))
    expect(templatesShown(answer, { q: '', kind: 'LABEL_WARNING' })).toHaveLength(2)
    expect(templatesShown(answer, { q: 'pantalone', kind: null })?.map((row) => row.templateKey)).toEqual(['DEMO-LBL-PNT-01'])
    expect(templatesShown(null, { q: '', kind: null })).toBeNull()
  })

  it('lists a template’s approvals in force first, then the newest', () => {
    const doc = templateOf(answer, 'DOC:annex-ix.1')!
    expect(approvalsOf(answer, doc).map((row) => [row.live, row.companyId])).toEqual([
      [true, COMPANY],
      [false, null],
    ])
    expect(templateOf(answer, 'DOC:annex-ix.9')).toBeNull()
  })
})

describe('recording a yes', () => {
  it('is held, with why, until the template, whose, languages, consultant and file are there', () => {
    expect(recordHeld(ready, context)).toBeNull()
    expect(recordHeld(ready, { ...context, mayCompany: false, mayEvery: false })).toBe('ppe.held.manage')
    expect(recordHeld(ready, { ...context, offline: true })).toBe('ppe.held.offline')
    expect(recordHeld({ ...ready, template: null }, context)).toBe('ppe.held.template')
    expect(recordHeld({ ...ready, scope: 'all' }, { ...context, mayEvery: false })).toBe('ppe.held.everyCompany')
    expect(recordHeld(ready, { ...context, companyId: null })).toBe('ppe.held.company')
    expect(recordHeld({ ...ready, languages: ' ' }, context)).toBe('ppe.held.languages')
    expect(recordHeld({ ...ready, languages: 'italiano' }, context)).toBe('ppe.held.languageCodes')
    expect(recordHeld({ ...ready, checkedBy: 'two\nlines' }, context)).toBe('ppe.held.checkedBy')
    expect(recordHeld({ ...ready, file: null }, context)).toBe('ppe.held.file')
  })

  it('asks for the template, the company (none for every company) and the languages typed, each once', () => {
    expect(languagesTyped('IT, en;it de')).toEqual(['it', 'en', 'de'])
    expect(recordBodyOf(ready, templateOf(answer, ready.template), COMPANY)).toEqual({ companyId: COMPANY, templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1, languages: ['it', 'en'], checkedBy: 'Demo consultant' })
    expect(recordBodyOf({ ...ready, scope: 'all' }, templateOf(answer, ready.template), COMPANY)?.companyId).toBeNull()
    expect(recordBodyOf(ready, null, COMPANY)).toBeNull()
  })
})

describe('withdrawing and refusals', () => {
  it('holds a withdrawal until a reason; never twice', () => {
    const live = DEMO_APPROVALS[0]!
    expect(withdrawHeld(live, 'no', { offline: false, busy: false })).toBe('ppe.held.reason')
    expect(withdrawHeld(live, 'The consultant asked again.', { offline: false, busy: false })).toBeNull()
    expect(withdrawHeld(DEMO_APPROVALS[1]!, 'The consultant asked again.', { offline: false, busy: false })).toBe('ppe.held.withdrawn')
    expect(withdrawHeld({ ...live, mayWithdraw: false }, 'The consultant asked again.', { offline: false, busy: false })).toBe('ppe.held.manage')
  })

  it('says each refusal in our words, never the API’s', () => {
    expect(ppeProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/RECORDED' }])).key).toBe('ppe.refusal.RECORDED')
    expect(ppeProblemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/languages/0' }])).key).toBe('ppe.problem.field.languages')
    expect(ppeProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/version' }])).key).toBe('ppe.problem.stale')
    expect(ppeProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('ppe.problem.forbidden')
    expect(ppeProblemOf(new StepUpCancelled()).key).toBe('ppe.problem.cancelled')
    expect(readProblemOf(new ApiError('unavailable', 503, 'x', 'x'))).toBe('problem.read')
  })
})

describe('the words', () => {
  it('every key the tab says is in it and en (the catalogue has the same keys in both)', () => {
    const en = CATALOGUE.en[PPE_NAMESPACE] ?? {}
    for (const locale of LOCALES) expect(Object.keys(CATALOGUE[locale][PPE_NAMESPACE] ?? {}).sort()).toEqual(Object.keys(en).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const source = (readdirSync(folder, { recursive: true }) as string[])
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.vitest.') && !name.includes('fixtures'))
      .map((name) => readFileSync(join(folder, name), 'utf8'))
      .join('\n')
    const used = [...new Set([...source.matchAll(/'(ppe\.[a-zA-Z0-9_.]+[a-zA-Z0-9_])'/g)].map((match) => match[1]!))]
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][PPE_NAMESPACE] ?? {}
      expect(used.filter((key) => !(key in words) && !(`${key}_one` in words)), locale).toEqual([])
      for (const kind of PPE_TEXT_KINDS) for (const prefix of ['ppe.kind', 'ppe.window.what']) expect(`${prefix}.${kind}` in words, `${locale} ${prefix}.${kind}`).toBe(true)
      for (const state of ['APPROVED', 'WITHDRAWN', 'NONE']) expect(`ppe.state.${state}` in words).toBe(true)
    }
  })
})
