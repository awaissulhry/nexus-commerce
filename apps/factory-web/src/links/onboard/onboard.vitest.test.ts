import { describe, expect, it } from 'vitest'
import { CHECK_CODES } from '@nexus/factory-domain/purchasing/questionnaire/answers'
import { STARTER_QUESTIONS } from '@nexus/factory-domain/purchasing/questionnaire/starter'
import { ApiError } from '../../lib/api/errors'
import { CATALOGUE } from '../../lib/i18n/messages'
import type { OnboardPage, QuestionView } from './api'
import { designScreen } from './fixtures'
import { bodyOf, draftDataOf, STEPS, firstBlocked, formFromDraft, prefilled, problemsIn, problemsOf, sendRefusal, stepOfPath, vatWords, worthKeeping, type OnboardForm } from './model'

const ID = '0190f0e2-7272-7000-8000-000000000020'
const PAGE: OnboardPage = {
  sender: { companyName: 'Officina Demo' },
  reviewer: { name: 'Paolo Esempio' },
  note: null,
  supplier: { code: 'SUP-1', legalName: 'Conceria Demo S.r.l.', vatNumber: 'IT00000000026', address: 'Via Demo 1, Seedville', website: null },
  questionnaire: { id: 'q1', revision: 1, title: 'Due diligence', questions: STARTER_QUESTIONS as unknown as QuestionView[], hasCode: true },
  uploaded: [{ id: ID, name: 'lwg.pdf', contentType: 'application/pdf', sizeBytes: 10, status: 'AVAILABLE' }],
  link: { expiresAt: '2026-12-10T17:00:00.000Z', usesLeft: 1 },
  locale: 'it',
}
const TODAY = '2026-11-10'

describe('the supplier questionnaire page (SCR-269)', () => {
  it('starts from the supplier as we hold it, and has nothing worth keeping until the person answers', () => {
    const form = prefilled(PAGE)
    expect(form.answers['company.legal-name']).toEqual({ value: 'Conceria Demo S.r.l.' })
    expect(form.answers['company.vat']).toEqual({ value: 'IT00000000026' })
    expect(form.answers['company.address']).toEqual({ value: 'Via Demo 1, Seedville' })
    expect(worthKeeping(form, PAGE)).toBe(false)
    expect(worthKeeping({ ...form, signedRole: 'Owner' }, PAGE)).toBe(true)
  })

  it('checks each step with the domain rules; Continue stops at the first step with something to fix', () => {
    const problems = problemsOf(prefilled(PAGE), PAGE, TODAY)
    expect(problemsIn(problems, 'company')).toEqual([])
    expect(problemsIn(problems, 'contacts').map((problem) => problem.code)).toEqual(['required', 'required', 'required'])
    expect(problemsIn(problems, 'sites')).toEqual([{ step: 'sites', path: 'sites', code: 'sites' }])
    expect(firstBlocked(problems, 'labour')).toBe('contacts')
    expect(stepOfPath(PAGE, 'answers/labour.wages/value')).toBe('labour')
    expect(stepOfPath(PAGE, 'truthful')).toBe('sign')
  })

  it('a draft comes back fitted to the version: unknown keys and documents not of this link dropped', () => {
    const form: OnboardForm = { ...prefilled(PAGE), answers: { ...prefilled(PAGE).answers, 'certs.lwg': { value: { fileId: ID } }, 'certs.iso-9001': { value: { fileId: 'gone' } } } }
    const data = { ...draftDataOf(form, 'certifications', PAGE), answers: { ...form.answers, 'old.question': { value: 'x' } } }
    const restored = formFromDraft(data, PAGE)!
    expect(restored.step).toBe('certifications')
    expect(Object.keys(restored.form.answers)).toEqual(expect.arrayContaining(['certs.lwg', 'company.vat']))
    expect(restored.form.answers['certs.iso-9001']).toBeUndefined()
    expect(restored.form.answers['old.question']).toBeUndefined()
    expect(restored.form.truthful).toBe(false)
    expect(formFromDraft({ nothing: true }, PAGE)).toBeNull()
  })

  it('the send body leaves out empty answers; the VAT check is said for the number shown', () => {
    const body = bodyOf({ ...prefilled(PAGE), answers: { ...prefilled(PAGE).answers, 'company.website': { value: '' } } }, PAGE)
    expect(Object.keys(body.answers)).toEqual(['company.legal-name', 'company.vat', 'company.address'])
    const vat = { status: 'done' as const, for: 'DE123456789', result: { result: 'VALID' as const, nameMatches: true, vatNumber: 'DE123456789' } }
    expect(vatWords({ vat }, 'DE 123 456 789')).toBe('vat.validName')
    expect(vatWords({ vat }, 'DE999')).toBeNull()
  })

  it("the server's refusals in our words: fields at their step, a new version read again, a lost answer keeps its key", () => {
    const invalid = new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/answers/certs.lwg/value', message: 'not arrived' }])
    expect(sendRefusal(invalid, PAGE)).toMatchObject({ key: 'problem.fields', issues: [{ step: 'certifications', path: 'answers/certs.lwg/value', code: 'file' }], keepKey: false })
    expect(sendRefusal(new ApiError('conflict', 409, 'conflict', 'x'), PAGE)).toMatchObject({ key: 'problem.changed', reload: true })
    expect(sendRefusal(new ApiError('not_found', 404, 'LINK_UNAVAILABLE', 'x'), PAGE)).toMatchObject({ link: 'unavailable' })
    expect(sendRefusal(new Error('offline'), PAGE)).toMatchObject({ key: 'problem.network', keepKey: true })
  })

  it('every check code and every step has its words in both languages; the design route has every state', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['link-onboard'] ?? {}
      for (const code of CHECK_CODES) expect(words[`check.${code}`], `${locale} check.${code}`).toBeTruthy()
      for (const step of STEPS) expect(words[`step.${step}.title`], `${locale} step.${step}`).toBeTruthy()
    }
    const ids = designScreen.cases.map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining(['company', 'contacts', 'sites', 'certifications', 'labour', 'review', 'done', 'loading', 'error', 'gone', 'wrong-person', 'draft-restored', 'uploads-closed']))
  })
})
