import type { BusinessDate } from '../../core/time'
import type { NoticeDecision, PublicNoticeWords, RecallKind } from './rules'

/**
 * The first drafts a person edits (B-W2b-260): the notice to an authority from the register entry (PPE Reg. art. 8(8):
 * "giving details, in particular, of the non-compliance and of any corrective measures taken"), the message to a
 * distributor, and a recall's public notice (GPSR art. 36: what is wrong, what to do, whom to contact). Italian and
 * English words; any other language gets the English draft to translate. The entry's own words (what happened, the
 * corrective action) are put in as typed: nothing is translated by itself. Pure.
 */

type Lang = 'it' | 'en'
const langOf = (language: string): Lang => (language.toLowerCase().startsWith('it') ? 'it' : 'en')

/** The facts a draft is made from (the register entry, its style and what the action calls back). */
export interface DraftFacts {
  readonly companyName: string
  readonly entryReference: string
  readonly reportedOn: BusinessDate
  readonly styleCode: string
  readonly styleName: string
  /** The batches (or "the whole style") the entry or the action names. */
  readonly wholeStyle: boolean
  readonly batchNumbers: readonly string[]
  readonly serialCount: number
  readonly description: string
  readonly investigation: string | null
  readonly risk: 'NO' | 'ASSESSING' | 'YES'
  readonly actionTaken: string | null
}

const W = {
  it: {
    decision: { NOT_CONFORMING: 'DPI non conforme', RISK: 'DPI che presenta un rischio' } satisfies Record<NoticeDecision, string>,
    risk: { NO: 'nessun rischio', ASSESSING: 'in valutazione', YES: 'il DPI può presentare un rischio' },
    kind: { RECALL: 'Richiamo', WITHDRAWAL: 'Ritiro dal mercato' } satisfies Record<RecallKind, string>,
    noticeTitle: 'Comunicazione all’autorità di vigilanza del mercato',
    maker: 'Fabbricante',
    product: 'Prodotto',
    batches: 'Lotti',
    wholeStyle: 'tutti i lotti del modello',
    serials: (n: number) => `${n} numeri di serie`,
    entry: 'Registro DPI',
    reportedOn: 'segnalato il',
    found: 'Cosa è stato riscontrato',
    assessment: 'Valutazione',
    riskLine: 'Rischio',
    action: 'Misure correttive',
    actionPending: 'in corso di decisione',
    law: 'Riferimento: Reg. (UE) 2016/425 art. 8, paragrafo 8',
    distributorSubject: (kind: RecallKind | null, style: string) => (kind ? `${kind === 'RECALL' ? 'Richiamo' : 'Ritiro'} del prodotto ${style}` : `Informazione di sicurezza sul prodotto ${style}`),
    distributorOpen: 'Gentile cliente,',
    distributorBody: (facts: DraftFacts, what: string) =>
      `la informiamo che il prodotto ${facts.styleCode} ${facts.styleName} (${what}) è oggetto della pratica ${facts.entryReference} del nostro registro DPI.`,
    distributorAsk: 'Le chiediamo di sospendere la vendita dei capi interessati ancora in magazzino, di informare i suoi clienti se necessario e di confermarci la ricezione di questo messaggio rispondendo a questa e-mail.',
    distributorClose: 'Cordiali saluti',
    publicTitle: (kind: RecallKind, style: string) => `${kind === 'RECALL' ? 'Richiamo' : 'Ritiro'} di sicurezza: ${style}`,
    publicAction: (kind: RecallKind) =>
      kind === 'RECALL' ? 'Smetta di usare il capo e lo restituisca al venditore o a noi: sarà riparato, sostituito o rimborsato.' : 'Il prodotto è ritirato dalla vendita. Se lo ha acquistato, ci contatti per sapere cosa fare.',
    publicContact: (company: string) => `Contatti ${company} usando il modulo "Segnala un problema" su questa pagina.`,
  },
  en: {
    decision: { NOT_CONFORMING: 'PPE not in conformity', RISK: 'PPE presenting a risk' } satisfies Record<NoticeDecision, string>,
    risk: { NO: 'no risk', ASSESSING: 'being assessed', YES: 'the PPE may present a risk' },
    kind: { RECALL: 'Recall', WITHDRAWAL: 'Withdrawal from the market' } satisfies Record<RecallKind, string>,
    noticeTitle: 'Notice to the market surveillance authority',
    maker: 'Manufacturer',
    product: 'Product',
    batches: 'Batches',
    wholeStyle: 'every batch of the style',
    serials: (n: number) => `${n} serial numbers`,
    entry: 'PPE register',
    reportedOn: 'reported on',
    found: 'What was found',
    assessment: 'Assessment',
    riskLine: 'Risk',
    action: 'Corrective measures',
    actionPending: 'being decided',
    law: 'Reference: Reg. (EU) 2016/425 art. 8(8)',
    distributorSubject: (kind: RecallKind | null, style: string) => (kind ? `${kind === 'RECALL' ? 'Recall' : 'Withdrawal'} of product ${style}` : `Safety information about product ${style}`),
    distributorOpen: 'Dear customer,',
    distributorBody: (facts: DraftFacts, what: string) => `we inform you that product ${facts.styleCode} ${facts.styleName} (${what}) is the subject of case ${facts.entryReference} of our PPE register.`,
    distributorAsk: 'Please stop selling the garments concerned that you still hold, inform your own customers where needed, and confirm that you received this message by replying to this e-mail.',
    distributorClose: 'Kind regards',
    publicTitle: (kind: RecallKind, style: string) => `Safety ${kind === 'RECALL' ? 'recall' : 'withdrawal'}: ${style}`,
    publicAction: (kind: RecallKind) =>
      kind === 'RECALL' ? 'Stop using the garment and return it to the seller or to us: it will be repaired, replaced or refunded.' : 'The product is withdrawn from sale. If you bought it, contact us to know what to do.',
    publicContact: (company: string) => `Contact ${company} with the "Report a problem" form on this page.`,
  },
} as const

function scopeWords(facts: DraftFacts, words: (typeof W)[Lang]): string {
  if (facts.wholeStyle) return words.wholeStyle
  const parts = [...(facts.batchNumbers.length > 0 ? [`${words.batches} ${facts.batchNumbers.slice(0, 20).join(', ')}${facts.batchNumbers.length > 20 ? ' …' : ''}`] : [])]
  if (facts.serialCount > 0) parts.push(words.serials(facts.serialCount))
  return parts.length > 0 ? parts.join('; ') : words.wholeStyle
}

/** The words of a notice to an authority in one language, drafted from the entry. */
export function draftNoticeWords(facts: DraftFacts, decision: NoticeDecision, language: string): string {
  const words = W[langOf(language)]
  return [
    `${words.noticeTitle} — ${words.decision[decision]}`,
    '',
    `${words.maker}: ${facts.companyName}`,
    `${words.product}: ${facts.styleCode} ${facts.styleName}`,
    `${words.batches}: ${scopeWords(facts, words)}`,
    `${words.entry}: ${facts.entryReference}, ${words.reportedOn} ${facts.reportedOn}`,
    '',
    `${words.found}:`,
    facts.description,
    ...(facts.investigation ? ['', `${words.assessment}:`, facts.investigation] : []),
    '',
    `${words.riskLine}: ${words.risk[facts.risk]}`,
    '',
    `${words.action}:`,
    facts.actionTaken ?? words.actionPending,
    '',
    words.law,
  ].join('\n')
}

/** A notice to an authority in each language asked (the market's DoC languages), drafted from the entry. */
export function draftNotice(facts: DraftFacts, decision: NoticeDecision, languages: readonly string[]): Record<string, string> {
  const asked = languages.length > 0 ? languages : ['en']
  return Object.fromEntries(asked.map((language) => [language, draftNoticeWords(facts, decision, language)]))
}

/** The subject and message to one distributor in their language. */
export function draftDistributorMessage(facts: DraftFacts, kind: RecallKind | null, language: string): { subject: string; message: string } {
  const words = W[langOf(language)]
  return {
    subject: words.distributorSubject(kind, facts.styleCode),
    message: [words.distributorOpen, '', words.distributorBody(facts, scopeWords(facts, words)), '', words.distributorAsk, '', words.distributorClose, facts.companyName].join('\n'),
  }
}

/** A recall's public notice in each language asked, drafted from the entry (the person writes what is wrong in plain words). */
export function draftPublicNotice(facts: DraftFacts, kind: RecallKind, languages: readonly string[]): Record<string, PublicNoticeWords> {
  const asked = languages.length > 0 ? languages : ['it', 'en']
  return Object.fromEntries(
    asked.map((language) => {
      const words = W[langOf(language)]
      return [
        language,
        {
          title: words.publicTitle(kind, `${facts.styleCode} ${facts.styleName}`).slice(0, 200),
          problem: `${facts.description}`.slice(0, 2000),
          action: words.publicAction(kind),
          contact: words.publicContact(facts.companyName).slice(0, 1000),
        },
      ]
    }),
  )
}
