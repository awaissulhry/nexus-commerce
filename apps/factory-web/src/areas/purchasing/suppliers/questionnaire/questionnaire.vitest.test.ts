import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { designScreen } from './fixtures'
import { OTHER, refusalOf, reviewBodyOf, reviewHeld, reviewProblem, sendBodyOf, sendHeld, sendProblem, type SendForm } from './model'

const FORM: SendForm = { to: 'contact-1', email: '', mode: 'mail', language: 'it', days: 30, note: '' }
const DATA = designScreen.cases.find((entry) => entry.id === 'to-review')!.model.data!

describe("the supplier's Questionnaire tab (B-W2b-172)", () => {
  it('sends to a contact, to an address typed, or makes a link to pass on', () => {
    expect(sendBodyOf(FORM)).toEqual({ contactId: 'contact-1', send: true, language: 'it', expiresInDays: 30 })
    expect(sendBodyOf({ ...FORM, to: OTHER, email: ' anna@example.com ' })).toEqual({ email: 'anna@example.com', send: true, language: 'it', expiresInDays: 30 })
    expect(sendBodyOf({ ...FORM, mode: 'link', note: ' Grazie ' })).toEqual({ send: false, language: 'it', expiresInDays: 30, note: 'Grazie' })
    expect(sendProblem({ ...FORM, to: OTHER, email: 'nope' })).toEqual({ field: 'email', key: 'send.check.email' })
    expect(sendProblem({ ...FORM, days: 61 })).toEqual({ field: 'days', key: 'send.check.days' })
    expect(sendProblem(FORM)).toBeNull()
  })

  it('a review needs a choice, and words with questions back; held when reviewed or without the right', () => {
    expect(reviewProblem({ decision: null, questions: '', note: '' })).toEqual({ field: 'decision', key: 'review.check.decision' })
    expect(reviewProblem({ decision: 'QUESTIONS', questions: ' ', note: '' })).toEqual({ field: 'questions', key: 'review.check.questions' })
    expect(reviewBodyOf({ decision: 'ACCEPTED', questions: 'ignored', note: ' ' }, 3)).toEqual({ decision: 'ACCEPTED', note: null, questions: null, version: 3 })
    const [waiting, reviewed] = DATA.answers
    expect(reviewHeld(DATA, waiting!)).toBeNull()
    expect(reviewHeld(DATA, reviewed!)).toBe('held.reviewed')
    expect(reviewHeld({ ...DATA, may: { ...DATA.may, review: false } }, waiting!)).toBe('held.review')
    expect(sendHeld({ ...DATA, current: null })).toBe('held.noVersion')
    expect(sendHeld({ ...DATA, may: { ...DATA.may, send: false } })).toBe('held.send')
  })

  it("the API's refusals in our words", () => {
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SUPPRESSED', message: 'x' }]))).toEqual({ key: 'problem.suppressed', field: 'email', reload: false })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x'))).toMatchObject({ key: 'problem.changed', reload: true })
    expect(refusalOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/email', message: 'x' }]))).toMatchObject({ field: 'email' })
  })

  it('has its words in both languages and a design case for every state', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['purchasing-questionnaire'] ?? {}
      for (const key of ['title', 'state.WAITING', 'linkState.OPEN', 'review.check.questions', 'held.noVersion', 'section.labour']) expect(words[key], `${locale} ${key}`).toBeTruthy()
      expect(CATALOGUE[locale].parties?.['suppliers.tab.questionnaire']).toBeTruthy()
    }
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['to-review', 'answer', 'review', 'send', 'send-given', 'no-version', 'read-only', 'loading', 'error']))
  })
})
