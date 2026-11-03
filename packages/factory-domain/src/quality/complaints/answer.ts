import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { EightDCompany, EightDReport, EightDSection } from '../capa/report'
import type { ComplaintStatus, HeldCode } from './rules'

/**
 * A complaint's investigation and its answer to the customer (B-W2b-113; QHS-116 "Investigation and reply, with CAPA";
 * design quality.complaints record tabs "Investigation" — findings, the returned garment's inspection, root cause, links to
 * NCR and CAPA — and "Answer" — "Reply letter from a template in the customer's language … Template Listbox, language,
 * PdfViewer preview, attachments (inspection report, 8D) … Send = review then send (email or portal); never autosent", and
 * the new tab "Answer letter (PDF)": "the letter as sent, for the file"). Pure: what may be written when, the templates'
 * words in Italian and English, and the letter as the PDF prints it (laid out as the 8D report, painted by the same A4
 * renderer). The …_quality_problems_w2b_guards trigger (Complaint_answer_guard) holds the same rules for every login.
 *
 *   investigation  findings and the root cause, in words, from TRIAGED on (not while NEW, never once CLOSED). Office only:
 *                  never printed, never sent (the letter says what the customer reads).
 *   the letter     template, language (it | en), words and the files that go with it (files of the complaint), written
 *                  from TRIAGED on; frozen while the complaint stays ANSWERED (back to investigating opens it again).
 *   send           a person reviews the letter and sends it by e-mail (the portal is W2b-3): the version kept (a
 *                  GeneratedDocument COMPLAINT_ANSWER), who and how, with the complaint ANSWERED in the same step.
 *
 * No money (the order's value stays on the screen by the price grain), no worker, no internal words: the letter carries
 * only what the person wrote in it.
 */

export const ANSWER_TEMPLATES = ['REPAIR', 'REPLACEMENT', 'CREDIT', 'NOT_ACCEPTED', 'UPDATE', 'FREE'] as const
export type AnswerTemplate = (typeof ANSWER_TEMPLATES)[number]
export const isAnswerTemplate = (value: unknown): value is AnswerTemplate => typeof value === 'string' && (ANSWER_TEMPLATES as readonly string[]).includes(value)

/** How a letter goes (factory-db ComplaintAnswerChannel); the office sends by e-mail (the portal comes with W2b-3). */
export const ANSWER_VIAS = ['EMAIL', 'PORTAL'] as const
export type AnswerVia = (typeof ANSWER_VIAS)[number]

export const ANSWER_LIMITS = Object.freeze({
  findings: 4000,
  rootCause: 2000,
  text: 8000,
  /** Files of the complaint that go with the letter. */
  files: 10,
  subject: 200,
  /** People a letter is mailed to (the customer's contacts) and in copy. */
  recipients: 10,
})

/** Why the investigation may not be written now (null: it may). */
export function investigationHeld(status: ComplaintStatus): HeldCode | null {
  if (status === 'CLOSED') return 'CLOSED'
  if (status === 'NEW') return 'NOT_TRIAGED'
  return null
}

/** Why the letter may not be written now (null: it may). Frozen while ANSWERED. */
export function answerHeld(status: ComplaintStatus): HeldCode | null {
  if (status === 'CLOSED') return 'CLOSED'
  if (status === 'NEW') return 'NOT_TRIAGED'
  if (status === 'ANSWERED') return 'ANSWER_SENT'
  return null
}

/** Why the letter may not be sent now (null: it may): written first, in its language. */
export function sendHeld(facts: { readonly status: ComplaintStatus; readonly answerText: string | null; readonly answerLanguage: string | null }): HeldCode | null {
  const held = answerHeld(facts.status)
  if (held) return held
  if (!facts.answerText || facts.answerText.trim() === '' || !facts.answerLanguage) return 'NO_ANSWER'
  return null
}

const words = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** The investigation as typed: problems at body/<field>. An empty text clears it. */
export function investigationProblems(input: { readonly findings?: string | null | undefined; readonly rootCause?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if ((words(input.findings) ?? '').length > ANSWER_LIMITS.findings) problems.push({ path: 'body/findings', message: `At most ${ANSWER_LIMITS.findings} characters.` })
  if ((words(input.rootCause) ?? '').length > ANSWER_LIMITS.rootCause) problems.push({ path: 'body/rootCause', message: `At most ${ANSWER_LIMITS.rootCause} characters.` })
  return problems
}

export interface AnswerDraft {
  readonly template?: string | null | undefined
  readonly language?: string | null | undefined
  readonly text?: string | null | undefined
  readonly fileIds?: readonly string[] | undefined
}

/** The letter as typed: problems at body/<field>. */
export function answerDraftProblems(draft: AnswerDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.template !== undefined && draft.template !== null && !isAnswerTemplate(draft.template)) problems.push({ path: 'body/template', message: `A template: ${ANSWER_TEMPLATES.join(', ')}.` })
  if (draft.language !== undefined && draft.language !== null && draft.language !== 'it' && draft.language !== 'en') problems.push({ path: 'body/language', message: 'The letter is written in Italian (it) or English (en).' })
  if ((words(draft.text) ?? '').length > ANSWER_LIMITS.text) problems.push({ path: 'body/text', message: `At most ${ANSWER_LIMITS.text} characters.` })
  if (draft.fileIds) {
    if (draft.fileIds.length > ANSWER_LIMITS.files) problems.push({ path: 'body/fileIds', message: `At most ${ANSWER_LIMITS.files} files go with a letter.` })
    if (new Set(draft.fileIds).size !== draft.fileIds.length) problems.push({ path: 'body/fileIds', message: 'Each file goes with the letter once.' })
  }
  return problems
}

// ---- the templates ---------------------------------------------------------------------------------------------------

/** What the templates fill in: the complaint's own facts, never an internal note. */
export interface TemplateFacts {
  readonly customer: string
  readonly number: string
  readonly customerRef: string | null
  readonly receivedOn: BusinessDate
  /** The garment as the customer knows it ("JK-100 Giacca Rider, size M, serial SN-0001"), or null. */
  readonly garment: string | null
}

type TemplateWords = { readonly name: string; readonly body: (facts: TemplateFacts, day: string, ref: string) => string }

const TEMPLATE_WORDS: Readonly<Record<DocumentLanguage, Readonly<Record<AnswerTemplate, TemplateWords>>>> = Object.freeze({
  it: {
    REPAIR: {
      name: 'Riparazione',
      body: (f, day, ref) =>
        `Gentile ${f.customer},\n\nla ringraziamo per la segnalazione del ${day}${ref}. Abbiamo esaminato il caso${f.garment ? ` (${f.garment})` : ''} e ripareremo il capo a nostre spese. Le invieremo il capo riparato appena il lavoro sarà concluso.\n\nRestiamo a disposizione per qualsiasi chiarimento.`,
    },
    REPLACEMENT: {
      name: 'Sostituzione',
      body: (f, day, ref) =>
        `Gentile ${f.customer},\n\nla ringraziamo per la segnalazione del ${day}${ref}. Abbiamo esaminato il caso${f.garment ? ` (${f.garment})` : ''} e sostituiremo il capo. Le confermeremo la spedizione del nuovo capo.\n\nRestiamo a disposizione per qualsiasi chiarimento.`,
    },
    CREDIT: {
      name: 'Nota di credito',
      body: (f, day, ref) =>
        `Gentile ${f.customer},\n\nla ringraziamo per la segnalazione del ${day}${ref}. Abbiamo esaminato il caso${f.garment ? ` (${f.garment})` : ''} e riconosciamo il reclamo: emetteremo una nota di credito.\n\nRestiamo a disposizione per qualsiasi chiarimento.`,
    },
    NOT_ACCEPTED: {
      name: 'Reclamo non accolto',
      body: (f, day, ref) =>
        `Gentile ${f.customer},\n\nla ringraziamo per la segnalazione del ${day}${ref}. Abbiamo esaminato con attenzione il caso${f.garment ? ` (${f.garment})` : ''}: il capo risulta conforme alle specifiche e il difetto segnalato non dipende dalla produzione. Per questo motivo non possiamo accogliere il reclamo.\n\nRestiamo a disposizione per qualsiasi chiarimento.`,
    },
    UPDATE: {
      name: 'Aggiornamento',
      body: (f, day, ref) =>
        `Gentile ${f.customer},\n\nla ringraziamo per la segnalazione del ${day}${ref}. Stiamo ancora analizzando il caso${f.garment ? ` (${f.garment})` : ''} e le daremo una risposta definitiva appena l'analisi sarà conclusa.\n\nRestiamo a disposizione per qualsiasi chiarimento.`,
    },
    FREE: { name: 'Testo libero', body: (f) => `Gentile ${f.customer},\n\n` },
  },
  en: {
    REPAIR: {
      name: 'Repair',
      body: (f, day, ref) =>
        `Dear ${f.customer},\n\nThank you for telling us on ${day}${ref}. We have looked into it${f.garment ? ` (${f.garment})` : ''} and will repair the garment at our cost. We will send it back to you as soon as the repair is done.\n\nPlease let us know if you have any question.`,
    },
    REPLACEMENT: {
      name: 'Replacement',
      body: (f, day, ref) =>
        `Dear ${f.customer},\n\nThank you for telling us on ${day}${ref}. We have looked into it${f.garment ? ` (${f.garment})` : ''} and will replace the garment. We will confirm when the new one is shipped.\n\nPlease let us know if you have any question.`,
    },
    CREDIT: {
      name: 'Credit note',
      body: (f, day, ref) =>
        `Dear ${f.customer},\n\nThank you for telling us on ${day}${ref}. We have looked into it${f.garment ? ` (${f.garment})` : ''} and accept the complaint: we will issue a credit note.\n\nPlease let us know if you have any question.`,
    },
    NOT_ACCEPTED: {
      name: 'Complaint not accepted',
      body: (f, day, ref) =>
        `Dear ${f.customer},\n\nThank you for telling us on ${day}${ref}. We have looked into it carefully${f.garment ? ` (${f.garment})` : ''}: the garment meets its specification and the fault reported does not come from its making. For this reason we cannot accept the complaint.\n\nPlease let us know if you have any question.`,
    },
    UPDATE: {
      name: 'Update',
      body: (f, day, ref) =>
        `Dear ${f.customer},\n\nThank you for telling us on ${day}${ref}. We are still looking into it${f.garment ? ` (${f.garment})` : ''} and will give you our answer as soon as we have finished.\n\nPlease let us know if you have any question.`,
    },
    FREE: { name: 'Free text', body: (f) => `Dear ${f.customer},\n\n` },
  },
})

/** The template's name in a language (the Listbox). */
export const templateName = (template: AnswerTemplate, language: DocumentLanguage): string => TEMPLATE_WORDS[language][template].name

/** The words a template starts the letter with, filled in with the complaint's facts. The person edits them before sending. */
export function templateText(template: AnswerTemplate, language: DocumentLanguage, facts: TemplateFacts): string {
  const day = formatDate(facts.receivedOn, language)
  const ref = facts.customerRef ? (language === 'it' ? ` (Vs. rif. ${facts.customerRef})` : ` (your reference ${facts.customerRef})`) : ''
  return TEMPLATE_WORDS[language][template].body(facts, day, ref)
}

// ---- the letter ------------------------------------------------------------------------------------------------------

export interface LetterInput {
  readonly language: DocumentLanguage
  /** The letter's date. */
  readonly date: BusinessDate
  readonly company: EightDCompany
  readonly number: string
  readonly customer: { readonly name: string; readonly address: string | null; readonly contact: string | null }
  readonly customerRef: string | null
  readonly receivedOn: BusinessDate
  readonly text: string
  /** The names of the files that go with it. */
  readonly attachments: readonly string[]
  /** Who signs it for the company (the office person who sends it), or null. */
  readonly signedBy: string | null
  /** A preview, not a version kept: a banner says so. */
  readonly sample: boolean
}

const LETTER_WORDS = {
  it: {
    title: 'Risposta al reclamo',
    sample: 'ANTEPRIMA - lettera non inviata',
    to: 'Spett.le',
    attention: "All'attenzione di",
    date: 'Data',
    ours: 'Ns. riferimento',
    yours: 'Vs. riferimento',
    subject: (number: string, day: string) => `Oggetto: il Vostro reclamo del ${day} (${number})`,
    attachments: 'Allegati',
    regards: 'Cordiali saluti',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Risposta-reclamo',
  },
  en: {
    title: 'Answer to your complaint',
    sample: 'PREVIEW - letter not sent',
    to: 'To',
    attention: 'For the attention of',
    date: 'Date',
    ours: 'Our reference',
    yours: 'Your reference',
    subject: (number: string, day: string) => `Your complaint of ${day} (${number})`,
    attachments: 'Attachments',
    regards: 'Kind regards',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'Complaint-answer',
  },
} as const

/** Lines of free text: one paragraph per line written, blank lines dropped. */
const paragraphs = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')

/** The letter as the PDF prints it (the 8D report's layout: our letterhead, the facts, the words, the attachments). */
export function complaintLetter(input: LetterInput): EightDReport {
  const w = LETTER_WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const facts = [
    { label: w.to, value: [input.customer.name, input.customer.address].filter(Boolean).join(' - ') },
    ...(input.customer.contact ? [{ label: w.attention, value: input.customer.contact }] : []),
    { label: w.ours, value: input.number },
    ...(input.customerRef ? [{ label: w.yours, value: input.customerRef }] : []),
    { label: w.date, value: day(input.date) },
  ]
  const sections: EightDSection[] = [
    { heading: w.subject(input.number, day(input.receivedOn)), lines: [...paragraphs(input.text), w.regards, ...(input.signedBy ? [input.signedBy] : []), input.company.name], table: null },
    ...(input.attachments.length > 0 ? [{ heading: w.attachments, lines: input.attachments.map((name) => `- ${name}`), table: null }] : []),
  ]
  return {
    language: input.language,
    meta: { title: `${w.title} ${input.number}`, subject: w.subject(input.number, day(input.receivedOn)), createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.number}-${input.language}.pdf`,
  }
}

/** The text a letter's version fingerprint is taken of: everything it says but its date and the preview banner. */
export function letterFingerprintText(letter: EightDReport): string {
  return JSON.stringify({ language: letter.language, title: letter.title, company: letter.company, facts: letter.facts.filter((fact) => fact.label !== LETTER_WORDS[letter.language].date), sections: letter.sections })
}

/** The subject of the mail that carries the letter. */
export const letterMailSubject = (language: DocumentLanguage, number: string, customerRef: string | null): string =>
  language === 'it' ? `Risposta al reclamo ${number}${customerRef ? ` (Vs. rif. ${customerRef})` : ''}` : `Answer to your complaint ${number}${customerRef ? ` (your reference ${customerRef})` : ''}`

/** The mail's own words (the letter is attached as a PDF). */
export const letterMailBody = (language: DocumentLanguage, recipient: string | null, number: string): string =>
  language === 'it'
    ? `${recipient ? `Gentile ${recipient},` : 'Buongiorno,'}\n\nin allegato la nostra risposta al Vostro reclamo ${number}.\n\nCordiali saluti`
    : `${recipient ? `Dear ${recipient},` : 'Hello,'}\n\nPlease find attached our answer to your complaint ${number}.\n\nKind regards`
