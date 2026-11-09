import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { answerProblems, cleanAnswers, filesOf, sectionOfIssue, vatProblem, viesTarget, type AnswerForm } from './answers'
import { QUESTIONNAIRE_PERMISSIONS } from './permissions'
import { codeOfConduct, questionProblems, questionsOf } from './questions'
import { answerReport, codeReport } from './report'
import { questionnaireMail, reviewDueOf, reviewProblems, reviewTaskWords } from './rules'
import { STARTER_QUESTIONS } from './starter'

const TODAY = '2026-11-09'
const FILE_ID = '01960000-0000-7000-8000-000000000001'

/** A whole, valid answer to the starter set. */
function fullForm(): AnswerForm {
  const answers: Record<string, { value?: unknown; explain?: string | null }> = {}
  for (const question of STARTER_QUESTIONS) {
    if (question.kind === 'TEXT' || question.kind === 'ADDRESS' || question.kind === 'LONG_TEXT') answers[question.key] = { value: 'Made-up words' }
    if (question.kind === 'VAT') answers[question.key] = { value: 'IT 0000000002 6' }
    if (question.kind === 'URL') answers[question.key] = { value: 'www.example.com' }
    if (question.kind === 'CONTACT') answers[question.key] = { value: { name: 'Anna Example', email: 'Anna@Example.com', phone: '+39 055 000 000' } }
    if (question.kind === 'CHOICE') answers[question.key] = { value: question.options![0]!.code }
    if (question.kind === 'SIGN') answers[question.key] = { value: 'SIGNED' }
    if (question.kind === 'YES_NO') answers[question.key] = question.explain === 'YES' ? { value: 'NO' } : { value: 'YES' }
  }
  answers['certs.lwg'] = { value: { fileId: FILE_ID, issuer: 'LWG', number: 'A-1', issuedOn: '2026-01-10', expiresOn: '2027-01-09' } }
  return { answers, sites: [{ name: 'Main tannery', country: 'IT', town: 'Santa Croce', steps: ['TANNING', 'FINISHING'] }], subTierSites: [], signedName: 'Anna Example', signedRole: 'Quality manager', truthful: true }
}

describe('the supplier questionnaire (B-W2b-172)', () => {
  it('the starter set is a valid version, with the code of conduct to sign', () => {
    expect(questionProblems(STARTER_QUESTIONS)).toEqual([])
    expect(new Set(STARTER_QUESTIONS.map((question) => question.section))).toEqual(new Set(['company', 'contacts', 'sites', 'certifications', 'labour']))
    expect(codeOfConduct(STARTER_QUESTIONS)?.key).toBe('labour.code-of-conduct')
    expect(codeOfConduct(STARTER_QUESTIONS)?.document.paragraphs.it.length).toBe(codeOfConduct(STARTER_QUESTIONS)?.document.paragraphs.en.length)
  })

  it("reads the seed's version 1 (B-W2b-158's eight questions) as questions", () => {
    const seed = [
      { key: 'company.vat', section: 'company', kind: 'VAT', required: true, text: { it: 'Partita IVA', en: 'VAT number' } },
      { key: 'sites.own', section: 'sites', kind: 'SITES', required: true, text: { it: 'Siti', en: 'Sites' } },
      { key: 'labour.code-of-conduct', section: 'labour', kind: 'SIGN', required: true, text: { it: 'Codice', en: 'Code' } },
    ]
    expect(questionProblems(seed)).toEqual([])
    expect(questionsOf([...seed, { key: 'x', section: 'nowhere' }, 'junk'])).toHaveLength(3)
    expect(codeOfConduct(questionsOf(seed))).toBeNull()
  })

  it('refuses a version with a doubled key, a bad kind or a choice without choices, at the place', () => {
    const bad = [
      { key: 'a.one', section: 'company', kind: 'TEXT', required: true, text: { it: 'Uno', en: 'One' } },
      { key: 'a.one', section: 'company', kind: 'TEXT', required: true, text: { it: 'Uno', en: 'One' } },
      { key: 'B', section: 'labour', kind: 'WHAT', required: 'yes', text: { it: '', en: 'x' } },
      { key: 'c', section: 'labour', kind: 'CHOICE', required: true, text: { it: 'C', en: 'C' }, options: [{ code: 'ONLY', text: { it: 'x', en: 'x' } }] },
      { key: 'd', section: 'labour', kind: 'TEXT', required: true, text: { it: 'D', en: 'D' }, explain: 'YES' },
    ]
    const paths = questionProblems(bad).map((issue) => issue.path)
    expect(paths).toEqual(expect.arrayContaining(['body/questions/1/key', 'body/questions/2/key', 'body/questions/2/kind', 'body/questions/2/required', 'body/questions/2/text/it', 'body/questions/3/options', 'body/questions/4/explain']))
    expect(questionProblems([])).toEqual([{ path: 'body/questions', message: 'At least one question.' }])
  })

  it('a whole answer passes; the documents it names and the kept form', () => {
    const form = fullForm()
    expect(answerProblems(STARTER_QUESTIONS, form, TODAY)).toEqual([])
    expect(filesOf(STARTER_QUESTIONS, form.answers).map((file) => [file.key, file.fileId])).toEqual([['certs.lwg', FILE_ID]])
    const kept = cleanAnswers(STARTER_QUESTIONS, form.answers)
    expect(kept['company.vat']).toEqual({ value: 'IT00000000026' })
    expect(kept['contacts.orders']).toEqual({ value: { name: 'Anna Example', email: 'anna@example.com', phone: '+39 055 000 000' } })
    expect(kept['certs.iso-9001']).toBeUndefined()
  })

  it('says what is missing, at the field, and which step it is on', () => {
    const form = fullForm()
    const answers = { ...form.answers, 'labour.recruitment-fees': { value: 'YES' }, 'contacts.quality': { value: { name: 'Q', email: 'not-mail' } }, 'certs.lwg-rating': { value: 'PLATINUM' }, stray: { value: 'x' } }
    const problems = answerProblems(STARTER_QUESTIONS, { ...form, answers, sites: [], signedRole: ' ', truthful: false }, TODAY)
    const paths = problems.map((issue) => issue.path)
    expect(paths).toEqual(['answers/stray', 'answers/contacts.quality/value/email', 'sites', 'answers/certs.lwg-rating/value', 'answers/labour.recruitment-fees/explain', 'signedRole', 'truthful'])
    expect(sectionOfIssue(STARTER_QUESTIONS, 'answers/labour.recruitment-fees/explain')).toBe('labour')
    expect(sectionOfIssue(STARTER_QUESTIONS, 'sites')).toBe('sites')
    expect(sectionOfIssue(STARTER_QUESTIONS, 'truthful')).toBe('sign')
  })

  it('an expired certificate is refused; one document answers one question', () => {
    const form = fullForm()
    const expired = { ...form.answers, 'certs.lwg': { value: { fileId: FILE_ID, issuedOn: '2025-01-01', expiresOn: '2026-01-01' } } }
    expect(answerProblems(STARTER_QUESTIONS, { ...form, answers: expired }, TODAY).map((issue) => issue.path)).toEqual(['answers/certs.lwg/value/expiresOn'])
    const twice = { ...form.answers, 'certs.lwg': { value: { fileId: FILE_ID, issuedOn: '2026-06-01', expiresOn: '2026-12-01' } }, 'certs.iso-9001': { value: { fileId: FILE_ID } } }
    expect(answerProblems(STARTER_QUESTIONS, { ...form, answers: twice }, TODAY).map((issue) => issue.path)).toEqual(['answers'])
  })

  it('VAT numbers: an EU number keeps its shape and Italy its check digit; VIES only outside Italy', () => {
    expect(vatProblem('IT00000000026')).toBeNull()
    expect(vatProblem('IT00000000023')).toMatch(/check digit/)
    expect(vatProblem('DE12345')).toMatch(/DE/)
    expect(vatProblem('CHE-123.456.789')).toBeNull()
    expect(viesTarget('DE 123456789')).toEqual({ countryCode: 'DE', vatNumber: '123456789' })
    expect(viesTarget('IT00000000026')).toBeNull()
  })

  it('a review: questions back need words; accepted takes none', () => {
    expect(reviewProblems({ decision: 'ACCEPTED' })).toEqual([])
    expect(reviewProblems({ decision: 'QUESTIONS', questions: ' ' }).map((issue) => issue.path)).toEqual(['body/questions'])
    expect(reviewProblems({ decision: 'ACCEPTED', questions: 'Why?' }).map((issue) => issue.path)).toEqual(['body/questions'])
    expect(reviewProblems({ decision: 'MAYBE' }).map((issue) => issue.path)).toEqual(['body/decision'])
    expect(reviewDueOf('2026-12-29')).toBe('2027-01-03')
  })

  it('the words of the mail and the task, in both languages', () => {
    const it2 = questionnaireMail('it', { companyName: 'Esempio Srl', expiresOn: '2026-12-09', note: null }, 'https://example.com/l#token=x')
    expect(it2.subject).toBe('Questionario fornitore — Esempio Srl')
    expect(it2.body).toContain('09/12/2026')
    expect(questionnaireMail('en', { companyName: 'Example', expiresOn: '2026-12-09', note: 'Thanks!' }, 'u').body).toContain('Thanks!')
    expect(reviewTaskWords('en', { party: 'SUP-01', revision: 2 }).title).toBe('Review the supplier questionnaire of SUP-01')
  })

  it('declares its permissions, gives them to the administrator and the buyer, and its events', () => {
    for (const name of QUESTIONNAIRE_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const buyer = ROLE_TEMPLATES.find((template) => template.key === 'buyer')!
    expect(buyer.permissions).toEqual(expect.arrayContaining([...QUESTIONNAIRE_PERMISSIONS]))
    const quality = ROLE_TEMPLATES.find((template) => template.key === 'quality_inspector')!
    expect(quality.permissions).toContain('purchasing.questionnaire.view')
    expect(quality.permissions).not.toContain('purchasing.questionnaire.review')
    for (const type of ['supplier_questionnaire.published', 'supplier_questionnaire.link_sent', 'supplier_questionnaire.answered', 'supplier_questionnaire.reviewed']) expect(EVENT_CATALOGUE.find(type, 1)?.context).toBe('supplier-questionnaire')
  })

  it("the answer's report: every section in the version's order, the answers in words, the signed statement", () => {
    const form = fullForm()
    const report = answerReport({
      locale: 'it',
      companyName: 'Officina Demo',
      supplier: { code: 'SUP-1', name: 'Conceria Demo' },
      revision: 2,
      title: 'Due diligence',
      questions: STARTER_QUESTIONS,
      answers: cleanAnswers(STARTER_QUESTIONS, form.answers),
      sites: form.sites,
      subTierSites: [],
      signedName: 'Anna Example',
      signedRole: 'Quality manager',
      sentWords: '10/11/2026 09:20',
      sentAt: '2026-11-10T08:20:00.000Z',
      viaLink: true,
      fileNames: new Map([[FILE_ID, 'lwg.pdf']]),
    })
    expect(report.title).toBe('Questionario fornitore — versione 2')
    expect(report.sections.map((section) => section.heading)).toEqual(['1 · Azienda', '2 · Contatti', '3 · Stabilimenti e subfornitori', '4 · Certificazioni e prove', '5 · Lavoro e aspetti sociali'])
    const labour = report.sections[4]!.rows
    expect(labour.find((row) => row.question.startsWith('Qualche lavoratore'))?.answer).toBe('No')
    expect(report.sections[3]!.rows.find((row) => row.question === 'Certificato LWG')?.answer).toContain('lwg.pdf · emesso il 10/01/2026 · scade il 09/01/2027')
    expect(report.sections[2]!.tables[0]!.rows).toEqual([['Main tannery', 'IT', 'Santa Croce', 'Concia, Rifinizione']])
    expect(report.statement.signed).toBe('Anna Example, Quality manager — 10/11/2026 09:20')
    expect(codeReport(STARTER_QUESTIONS.find((question) => question.kind === 'SIGN')!.document!, 'en', 'Officina Demo').title).toBe('Supplier code of conduct')
  })
})
