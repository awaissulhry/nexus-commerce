import { describe, expect, it } from 'vitest'
import {
  ANSWER_TEMPLATES,
  answerDraftProblems,
  answerHeld,
  complaintLetter,
  investigationHeld,
  investigationProblems,
  letterFingerprintText,
  letterMailBody,
  letterMailSubject,
  sendHeld,
  templateName,
  templateText,
  type LetterInput,
} from './answer'
import { CHANGED_FIELDS, complaintActions, COMPLAINT_ACTIONS, HELD_CODES, type ComplaintAction } from './rules'

/** B-W2b-113 (QHS-116): the complaint's investigation and answer letter. */
describe('investigation and answer: when', () => {
  it('the investigation from TRIAGED on, never once closed', () => {
    expect(investigationHeld('NEW')).toBe('NOT_TRIAGED')
    expect(investigationHeld('CLOSED')).toBe('CLOSED')
    expect(investigationHeld('ANSWERED')).toBeNull()
  })

  it('the letter is frozen while answered; a send needs words and a language', () => {
    expect(answerHeld('ANSWERED')).toBe('ANSWER_SENT')
    expect(answerHeld('INVESTIGATING')).toBeNull()
    expect(sendHeld({ status: 'TRIAGED', answerText: ' ', answerLanguage: 'it' })).toBe('NO_ANSWER')
    expect(sendHeld({ status: 'TRIAGED', answerText: 'Gentile…', answerLanguage: null })).toBe('NO_ANSWER')
    expect(sendHeld({ status: 'INVESTIGATING', answerText: 'Gentile…', answerLanguage: 'it' })).toBeNull()
    expect(HELD_CODES).toContain('ANSWER_SENT')
    expect(HELD_CODES).toContain('NO_ANSWER')
  })

  it('the record offers investigate, write and send by the same rules', () => {
    const may = Object.fromEntries(COMPLAINT_ACTIONS.map((action) => [action, true])) as Record<ComplaintAction, boolean>
    const facts = { status: 'INVESTIGATING' as const, styleId: null, inRegister: false, safetyRaisedAt: null, safetyAcknowledgedAt: null, may }
    const of = (action: ComplaintAction, extra: object = {}) => complaintActions({ ...facts, ...extra }).find((entry) => entry.action === action)!
    expect(of('sendAnswer').held).toBe('NO_ANSWER')
    expect(of('sendAnswer', { answerText: 'Dear…', answerLanguage: 'en' }).allowed).toBe(true)
    expect(of('writeAnswer', { status: 'ANSWERED' }).held).toBe('ANSWER_SENT')
    expect(of('investigate', { status: 'NEW' }).held).toBe('NOT_TRIAGED')
    expect(of('investigate', { may: { ...may, investigate: false } }).held).toBe('NO_PERMISSION')
    for (const field of ['findings', 'rootCause', 'answer']) expect(CHANGED_FIELDS).toContain(field)
  })
})

describe('what a person types', () => {
  it('limits and the template list', () => {
    expect(investigationProblems({ findings: 'x'.repeat(4001) }).map((issue) => issue.path)).toEqual(['body/findings'])
    expect(investigationProblems({ findings: '', rootCause: null })).toEqual([])
    expect(answerDraftProblems({ template: 'NOPE', language: 'de', fileIds: ['a', 'a'] }).map((issue) => issue.path)).toEqual(['body/template', 'body/language', 'body/fileIds'])
    expect(answerDraftProblems({ template: 'REPAIR', language: 'it', text: 'Gentile…', fileIds: ['a'] })).toEqual([])
  })

  it('every template has words in both languages, filled with the complaint', () => {
    const facts = { customer: 'Moto Esempio Srl', number: 'CMP-2026-0001', customerRef: 'R-7', receivedOn: '2026-10-28', garment: 'JK-100, taglia M' }
    for (const template of ANSWER_TEMPLATES) {
      for (const language of ['it', 'en'] as const) {
        expect(templateName(template, language)).toBeTruthy()
        const text = templateText(template, language, facts)
        expect(text).toContain('Moto Esempio Srl')
        expect(text).not.toMatch(/\{|\}|undefined|null/)
      }
    }
    expect(templateText('REPAIR', 'it', facts)).toContain('28/10/2026')
    expect(templateText('REPAIR', 'it', facts)).toContain('Vs. rif. R-7')
    expect(templateText('NOT_ACCEPTED', 'en', { ...facts, customerRef: null, garment: null })).not.toContain('reference')
  })
})

describe('the answer letter (cmp-letter)', () => {
  const input: LetterInput = {
    language: 'it',
    date: '2026-11-03',
    company: { name: 'Fabbrica Esempio Srl', lines: ['Via Esempio 1'], legal: 'Fabbrica Esempio Srl - P.IVA 00000000000' },
    number: 'CMP-2026-0001',
    customer: { name: 'Moto Esempio Srl', address: 'Via Cliente 2, Milano', contact: 'Mario Rossi' },
    customerRef: 'R-7',
    receivedOn: '2026-10-28',
    text: 'Gentile Moto Esempio Srl,\n\nripareremo il capo.',
    attachments: ['rapporto-ispezione.pdf'],
    signedBy: 'Quality Lead',
    sample: false,
  }

  it('prints the addressee, the words, the signature and the attachments', () => {
    const letter = complaintLetter(input)
    expect(letter.facts[0]).toEqual({ label: 'Spett.le', value: 'Moto Esempio Srl - Via Cliente 2, Milano' })
    expect(letter.sections[0]!.heading).toBe('Oggetto: il Vostro reclamo del 28/10/2026 (CMP-2026-0001)')
    expect(letter.sections[0]!.lines).toEqual(['Gentile Moto Esempio Srl,', 'ripareremo il capo.', 'Cordiali saluti', 'Quality Lead', 'Fabbrica Esempio Srl'])
    expect(letter.sections[1]!.lines).toEqual(['- rapporto-ispezione.pdf'])
    expect(letter.fileName).toBe('Risposta-reclamo-CMP-2026-0001-it.pdf')
    expect(complaintLetter({ ...input, attachments: [] }).sections).toHaveLength(1)
    expect(complaintLetter({ ...input, sample: true }).sample).toMatch(/ANTEPRIMA/)
  })

  it('the fingerprint leaves out the date; the mail carries its own short words', () => {
    expect(letterFingerprintText(complaintLetter(input))).toBe(letterFingerprintText(complaintLetter({ ...input, date: '2026-12-24' })))
    expect(letterFingerprintText(complaintLetter(input))).not.toBe(letterFingerprintText(complaintLetter({ ...input, text: 'Altro' })))
    expect(letterMailSubject('en', 'CMP-2026-0001', 'R-7')).toBe('Answer to your complaint CMP-2026-0001 (your reference R-7)')
    expect(letterMailBody('it', 'Mario Rossi', 'CMP-2026-0001')).toMatch(/^Gentile Mario Rossi,/)
  })
})
