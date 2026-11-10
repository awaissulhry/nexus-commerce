import type { PackPaper, PaperLanguage } from '../techfiles/paper'
import type { AuthorityChannel, NoticeDecision, NoticeStatus } from './rules'
import { RECALL_LIMITS, RECALL_LAW } from './rules'

/**
 * The authority notice as paper (B-W2b-260; design compliance.register › tab rg-notice-pdf "Authority notice (PDF): draft to
 * submit on the authority's site"), in the shape of the evidence pack's paper (compliance/techfiles/paper) so the same A4
 * painter prints it: the company and its lines, the title, the facts (authority, market, way, decision, register entry,
 * state, sent on and reference) and the notice's own words in the language asked. Headings in Italian or English. Pure.
 */

export interface NoticePaperInput {
  readonly language: string
  readonly company: { readonly name: string; readonly lines: readonly string[]; readonly legal: string }
  readonly authorityName: string
  readonly market: string
  readonly channel: AuthorityChannel
  readonly decision: NoticeDecision
  readonly status: NoticeStatus
  readonly entryReference: string
  readonly styleCode: string
  readonly sentOn: string | null
  readonly reference: string | null
  /** The notice's words in that language (the person's own). */
  readonly words: string
  /** When the paper is made (ISO instant): its creation date. */
  readonly madeAt: string
}

const H = {
  it: {
    title: 'Comunicazione all’autorità di vigilanza del mercato',
    draft: 'BOZZA — da inviare a cura di una persona',
    authority: 'Autorità',
    market: 'Mercato',
    channel: 'Canale',
    decision: 'Decisione',
    entry: 'Registro DPI',
    product: 'Modello',
    state: 'Stato',
    sentOn: 'Inviata il',
    reference: 'Riferimento dell’autorità',
    law: 'Base giuridica',
    words: 'Testo della comunicazione',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    channels: { SAFETY_BUSINESS_GATEWAY: 'Safety Business Gateway', AUTHORITY_SITE: 'Sito dell’autorità', PEC: 'PEC', EMAIL: 'E-mail', POST: 'Posta', INSPECTION: 'Ispezione', OTHER: 'Altro' } satisfies Record<AuthorityChannel, string>,
    decisions: { NOT_CONFORMING: 'DPI non conforme', RISK: 'DPI che presenta un rischio' } satisfies Record<NoticeDecision, string>,
    states: { DRAFT: 'Bozza', SENT: 'Inviata', CANCELLED: 'Annullata' } satisfies Record<NoticeStatus, string>,
  },
  en: {
    title: 'Notice to the market surveillance authority',
    draft: 'DRAFT — to be sent by a person',
    authority: 'Authority',
    market: 'Market',
    channel: 'Way',
    decision: 'Decision',
    entry: 'PPE register',
    product: 'Style',
    state: 'State',
    sentOn: 'Sent on',
    reference: "Authority's reference",
    law: 'Legal basis',
    words: 'Words of the notice',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    channels: { SAFETY_BUSINESS_GATEWAY: 'Safety Business Gateway', AUTHORITY_SITE: "The authority's site", PEC: 'PEC (certified e-mail)', EMAIL: 'E-mail', POST: 'Post', INSPECTION: 'Inspection', OTHER: 'Other' } satisfies Record<AuthorityChannel, string>,
    decisions: { NOT_CONFORMING: 'PPE not in conformity', RISK: 'PPE presenting a risk' } satisfies Record<NoticeDecision, string>,
    states: { DRAFT: 'Draft', SENT: 'Sent', CANCELLED: 'Cancelled' } satisfies Record<NoticeStatus, string>,
  },
} as const

const languageOf = (language: string): PaperLanguage => (language.toLowerCase().startsWith('it') ? 'it' : 'en')

/** A file name of plain characters: `authority-notice-REG-2026-0007-DE-it.pdf`. */
const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'notice'

export function noticePaper(input: NoticePaperInput): PackPaper {
  const language = languageOf(input.language)
  const h = H[language]
  const facts = [
    ...(input.status === 'DRAFT' ? [{ label: '', value: h.draft }] : []),
    { label: h.authority, value: input.authorityName },
    { label: h.market, value: input.market },
    { label: h.channel, value: h.channels[input.channel] },
    { label: h.decision, value: h.decisions[input.decision] },
    { label: h.entry, value: input.entryReference },
    { label: h.product, value: input.styleCode },
    { label: h.state, value: h.states[input.status] },
    ...(input.sentOn ? [{ label: h.sentOn, value: input.sentOn }] : []),
    ...(input.reference ? [{ label: h.reference, value: input.reference }] : []),
    { label: h.law, value: RECALL_LAW.authorityNotice },
  ]
  const lines = input.words.slice(0, RECALL_LIMITS.noticeWords).split(/\r?\n/)
  return {
    language,
    meta: { title: `${h.title} — ${input.entryReference}`, subject: `${input.authorityName} (${input.market})`, createdAt: input.madeAt },
    title: h.title,
    company: input.company,
    facts,
    sections: [{ heading: h.words, lines, table: null }],
    page: h.page,
    fileName: `authority-notice-${safe(input.entryReference)}-${safe(input.market)}-${safe(input.language)}.pdf`,
  }
}
