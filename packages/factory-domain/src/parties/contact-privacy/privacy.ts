import type { Issue } from '../../core/errors'

/**
 * Personal-data controls on a party's contacts (B-W2b-290; SAL-022; GDPR arts. 6, 7, 15, 17, 21; design sales.customers
 * record › Addresses & contacts › Contacts "Consent and lawful basis (W2b)", "Personal-data actions (W2b): access copy,
 * erasure (keeps what law requires)"), pure. The columns are factory-db's PartyContact (B-W2b-279): lawfulBasis (null: not
 * recorded yet), consentAt + consentSource, objectedAt, erasedAt + erasedById.
 *
 *   lawful basis   CONTRACT (art. 6(1)(b)) · CONSENT (6(1)(a), with when and how it was given: art. 7(1)) · LEGITIMATE_
 *                  INTEREST (6(1)(f): the person may object, art. 21) · LEGAL_DUTY (6(1)(c): invoices, tax, PPE records)
 *   objection      when the person objected (art. 21) or withdrew their consent (art. 7(3)); set once, recorded, never cleared
 *   access copy    everything we hold about the person, in one answer (art. 15): the contact, and the records that name it
 *   erasure        ONE update (art. 17): name '', no e-mail, no phone, ARCHIVED, with when and by whom, for good; the row
 *                  stays for the quotes, orders, invoices and DDTs that name it (they keep their own copies of what they
 *                  printed: art. 17(3)(b) and (e), the legal duty to keep invoices and the PPE records)
 *
 * What erasure cannot blank yet (factory-db holds these rows immutable for every login, so a schema step must open a
 * guarded erasure path first): the mails received from the person (InboundEmail), the messages of record threads
 * (Message) and the audit rows (AuditLog). The access copy lists them, and the erasure answer counts them as kept.
 */

export const LAWFUL_BASES = ['CONTRACT', 'CONSENT', 'LEGITIMATE_INTEREST', 'LEGAL_DUTY'] as const
export type LawfulBasis = (typeof LAWFUL_BASES)[number]

export const PRIVACY_LIMITS = Object.freeze({ consentSource: 500, words: 2000 })

export const BASIS_WORDS: Readonly<Record<LawfulBasis, { readonly en: string; readonly it: string; readonly article: string }>> = Object.freeze({
  CONTRACT: { en: 'The contract with the customer, or steps before it at their request', it: 'Il contratto con il cliente, o misure precontrattuali su sua richiesta', article: 'GDPR art. 6(1)(b)' },
  CONSENT: { en: "The person's consent", it: "Il consenso dell'interessato", article: 'GDPR art. 6(1)(a)' },
  LEGITIMATE_INTEREST: { en: 'Our legitimate interest (the person may object)', it: "Il nostro legittimo interesse (l'interessato può opporsi)", article: 'GDPR art. 6(1)(f)' },
  LEGAL_DUTY: { en: 'A legal obligation (invoices, tax, PPE records)', it: 'Un obbligo di legge (fatture, fisco, registri DPI)', article: 'GDPR art. 6(1)(c)' },
})

/** The name an erased contact keeps (the database's rule: '', for good). Shown as "Erased contact". */
export const ERASED_NAME = ''
export const ERASED_WORDS = Object.freeze({ en: 'Erased contact', it: 'Contatto cancellato' })

export interface BasisInput {
  readonly lawfulBasis: LawfulBasis
  readonly consentAt?: Date | null | undefined
  readonly consentSource?: string | null | undefined
}

/** The lawful basis with its consent, as the database holds it: CONSENT needs when and how; at and how both or neither. */
export function basisProblems(input: BasisInput, now: Date): Issue[] {
  const issues: Issue[] = []
  const source = (input.consentSource ?? '').trim()
  const at = input.consentAt ?? null
  if (input.lawfulBasis === 'CONSENT' && (at === null || source === '')) issues.push({ path: 'consentAt', message: 'Consent is recorded with when and how it was given (GDPR art. 7(1)).' })
  if ((at === null) !== (source === '')) issues.push({ path: at === null ? 'consentAt' : 'consentSource', message: 'When and how the consent was given go together.' })
  if (at !== null && at.getTime() > now.getTime()) issues.push({ path: 'consentAt', message: 'Consent is given today or before, not in the future.' })
  if (source.length > PRIVACY_LIMITS.consentSource) issues.push({ path: 'consentSource', message: `At most ${PRIVACY_LIMITS.consentSource} characters.` })
  return issues
}

/** The words that say why: 1 to 2000 characters (an objection, an erasure request). */
export function privacyWordsProblem(words: string | null | undefined, what: string): Issue | null {
  const text = (words ?? '').trim()
  if (text === '') return { path: 'words', message: `Say ${what}.` }
  if (text.length > PRIVACY_LIMITS.words) return { path: 'words', message: `At most ${PRIVACY_LIMITS.words} characters.` }
  return null
}

/** What erasure keeps, by record kind, and why (the answer's `kept`, the access copy's notes). */
export const KEPT_WHY = Object.freeze({
  documents: 'Quotes, orders, DDTs and invoices keep their own copies of what they printed (legal duty to keep them: GDPR art. 17(3)(b)).',
  inboundMails: 'Mails received from the person stay as they arrived until a schema step lets an erasure blank them (they are immutable today).',
  messages: 'Messages on record threads stay as they were written until a schema step lets an erasure blank them (they are immutable today).',
  auditRows: 'The audit trail keeps what each change recorded (append-only: the proof of who changed what).',
  links: 'Links sent to the person keep the address they went to (the proof of what was sent).',
  measurementProfiles: "A rider's measurement profiles stay with the made-to-measure orders that used them.",
})
export type KeptKind = keyof typeof KEPT_WHY

/** The changes its event names (party.contact_privacy_changed): BASIS (with its consent), OBJECTED (or consent withdrawn). */
export const CONTACT_PRIVACY_CHANGES = ['BASIS', 'OBJECTED'] as const
