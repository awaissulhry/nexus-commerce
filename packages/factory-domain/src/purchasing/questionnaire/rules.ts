import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * The questionnaire's rules beside its questions and answers (B-W2b-172; SCM-023): the buyer's review, the words of the
 * link mail and of the buyer's review task, and the states the office reads.
 *
 * The review is set ONCE per answer (the database holds it: decision + time + who): ACCEPTED (the answer and its
 * documents are in order: each document is tagged with its kind and expiry, so the required-document rules and the expiry
 * reminders see it) or QUESTIONS (the buyer's questions go on the supplier's thread; the supplier answers again with a new
 * link: a new answer, never a change of this one).
 */

export const REVIEW_DECISIONS = ['ACCEPTED', 'QUESTIONS'] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

/** How the office reads an answer: waiting for the buyer, accepted, or questions sent back. */
export const ANSWER_STATES = ['WAITING', 'ACCEPTED', 'QUESTIONS'] as const
export type AnswerState = (typeof ANSWER_STATES)[number]

/** How the office reads a link it sent: open, answered, expired unanswered, withdrawn. */
export const LINK_STATES = ['OPEN', 'ANSWERED', 'EXPIRED', 'WITHDRAWN'] as const
export type QuestionnaireLinkState = (typeof LINK_STATES)[number]

export const REVIEW_LIMITS = Object.freeze({ note: 1000, questions: 2000, minQuestions: 3, mailNote: 1000 })

/** The buyer has this many days to review an answer (the review task's due day). */
export const REVIEW_DAYS = 5

export const answerStateOf = (decision: ReviewDecision | null): AnswerState => decision ?? 'WAITING'

/** What is wrong with a review: questions back need the words the supplier reads; the note is the office's. */
export function reviewProblems(body: { readonly decision: string; readonly note?: string | null | undefined; readonly questions?: string | null | undefined }): Issue[] {
  const issues: Issue[] = []
  if (!(REVIEW_DECISIONS as readonly string[]).includes(body.decision)) issues.push({ path: 'body/decision', message: 'ACCEPTED or QUESTIONS.' })
  const note = body.note?.trim() ?? ''
  if (note.length > REVIEW_LIMITS.note) issues.push({ path: 'body/note', message: `At most ${REVIEW_LIMITS.note} characters.` })
  const questions = body.questions?.trim() ?? ''
  if (body.decision === 'QUESTIONS' && questions.length < REVIEW_LIMITS.minQuestions) issues.push({ path: 'body/questions', message: 'Write the questions the supplier reads on its thread.' })
  if (questions.length > REVIEW_LIMITS.questions) issues.push({ path: 'body/questions', message: `At most ${REVIEW_LIMITS.questions} characters.` })
  if (body.decision === 'ACCEPTED' && questions !== '') issues.push({ path: 'body/questions', message: 'Questions go back only with QUESTIONS.' })
  return issues
}

/** The review task's due day: REVIEW_DAYS calendar days after the answer. */
export function reviewDueOf(answeredOn: BusinessDate): BusinessDate {
  const day = new Date(`${answeredOn}T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() + REVIEW_DAYS)
  return day.toISOString().slice(0, 10)
}

type Locale = 'it' | 'en'

const dayWords = (day: BusinessDate, locale: Locale): string => (locale === 'it' ? day.split('-').reverse().join('/') : day)

/** The link's mail: who asks, why (the regulation), how long it takes, until when the link works, and the buyer's note. */
export function questionnaireMail(locale: Locale, input: { readonly companyName: string; readonly expiresOn: BusinessDate; readonly note: string | null }, url: string): { readonly subject: string; readonly body: string } {
  const note = input.note?.trim() ? ['', input.note.trim()] : []
  if (locale === 'it') {
    return {
      subject: `Questionario fornitore — ${input.companyName}`,
      body: [
        'Buongiorno,',
        '',
        `${input.companyName} vi chiede di compilare il questionario fornitore: i vostri dati, i contatti, gli stabilimenti e i subfornitori, le certificazioni e alcune domande sul lavoro (due diligence per il Regolamento (UE) 2024/3015 sul lavoro forzato).`,
        'Servono circa 20 minuti; potete salvare e continuare più tardi dallo stesso link:',
        url,
        ...note,
        '',
        `Il link vale fino al ${dayWords(input.expiresOn, 'it')} ed è solo per voi: non inoltratelo.`,
      ].join('\n'),
    }
  }
  return {
    subject: `Supplier questionnaire — ${input.companyName}`,
    body: [
      'Hello,',
      '',
      `${input.companyName} asks you to fill in its supplier questionnaire: your company, contacts, sites and sub-suppliers, certifications and a few questions about labour (due diligence for the Forced Labour Regulation (EU) 2024/3015).`,
      'It takes about 20 minutes; you can save and go on later from the same link:',
      url,
      ...note,
      '',
      `The link works until ${dayWords(input.expiresOn, 'en')} and is for you only: please do not forward it.`,
    ].join('\n'),
  }
}

/** The buyer's review task, in the buyer's language. */
export function reviewTaskWords(locale: Locale, input: { readonly party: string; readonly revision: number }): { readonly title: string; readonly description: string } {
  if (locale === 'it') {
    return {
      title: `Rivedi il questionario fornitore di ${input.party}`,
      description: `${input.party} ha inviato il questionario (versione ${input.revision}). Leggilo in Fornitori › ${input.party} › Questionario: accettalo, oppure manda le domande sulla conversazione del fornitore.`,
    }
  }
  return {
    title: `Review the supplier questionnaire of ${input.party}`,
    description: `${input.party} sent the questionnaire (version ${input.revision}). Read it in Suppliers › ${input.party} › Questionnaire: accept it, or send your questions on the supplier's thread.`,
  }
}

/** The words the supplier reads on its thread when the buyer sends questions back. */
export function questionsMessage(locale: Locale, input: { readonly questions: string; readonly revision: number }): string {
  return locale === 'it'
    ? `Domande sul vostro questionario fornitore (versione ${input.revision}):\n\n${input.questions.trim()}\n\nVi manderemo un nuovo link per rispondere.`
    : `Questions about your supplier questionnaire (version ${input.revision}):\n\n${input.questions.trim()}\n\nWe will send you a new link to answer.`
}
