import { partnerLocaleOf } from '../partner/rules'

/**
 * B-CP-079 (customer page plan C7, D12; 12 §5; review B6, C4, F4; lead pick B6: the excerpt is cut to the first 80 characters, the
 * bell and the mail name who asks and on which record, never the excerpt): "Ask the factory designer" from a portal thread. Pure:
 * apps/factory-api's platform/threads/partner/designer-ask.ts applies these rules.
 *
 *   before the post   a factory designer is named for the customer (B-CP-078: the designer while active, else the backup), the
 *                     record is of a type the customer writes on, and at least one slot person reads that record's thread; else a
 *                     409 in the portal's words and NOTHING is posted (the box keeps the text)
 *   the ask           the customer's message is posted as always; then ONE system command writes an office-only INTERNAL NOTE
 *                     "<customer> asks the factory designer: «first 80 characters»" that mentions the slot people who read the
 *                     thread (MessageMention, a MENTIONED follow, the urgent MENTION bell and the mail by preference); its own
 *                     shape (DESIGNER_ASK_NOTE: a SYSTEM internal note written in the app — the threads guard's only channel for
 *                     a note — whose author is "<customer> (portal)", which nothing else writes) lets the bell say "<customer>
 *                     asks you, the factory designer, on <record>" without the note's words
 *   the cap           one ask per message (a flag of the post); at most DESIGNER_ASKS_PER_DAY asks per customer in 24 hours: the
 *                     next message is posted WITHOUT the ask, and the answer says so
 * The customer never sees the note, who read it, or when (no "seen by"; Statuto art. 4).
 */

/** The records a customer writes on whose thread may ask the factory designer (a draft order included). */
export const DESIGNER_ASK_RECORD_TYPES = ['PortalOrderRequest', 'SalesOrder', 'Inquiry', 'SampleRound', 'Project', 'Party', 'ReturnAuthorisation', 'Complaint'] as const
export type DesignerAskRecordType = (typeof DESIGNER_ASK_RECORD_TYPES)[number]
export const mayAskOn = (recordType: string): boolean => (DESIGNER_ASK_RECORD_TYPES as readonly string[]).includes(recordType)

/** At most this many asks per customer within 24 hours (the abuse brake; review F4 says it may be cut). */
export const DESIGNER_ASKS_PER_DAY = 20
export const DESIGNER_ASK_WINDOW_MS = 24 * 60 * 60_000

/** The note quotes at most this many characters of the customer's message (review B6: it may hold a price the customer typed). */
export const DESIGNER_ASK_EXCERPT = 80

/** The author's name of the note: the customer, through its portal. */
export const designerAskAuthor = (customer: string): string => `${customer} (portal)`

/** The note's own shape: an office-only SYSTEM note written in the app (the threads guard's channel for every note), by "<customer> (portal)". */
export const DESIGNER_ASK_NOTE = Object.freeze({ direction: 'INTERNAL_NOTE', channel: 'APP', authorKind: 'SYSTEM' } as const)
/** Whether a message is the note of a customer's ask (its customer's name as the thread's party has it now). */
export const isDesignerAskNote = (message: { readonly direction: string; readonly authorKind: string; readonly authorName: string | null }, customer: string): boolean =>
  message.direction === DESIGNER_ASK_NOTE.direction && message.authorKind === DESIGNER_ASK_NOTE.authorKind && message.authorName === designerAskAuthor(customer)

/** The first DESIGNER_ASK_EXCERPT characters of the message on one line ("…" when cut; whole characters, never half a pair). */
export function askExcerpt(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length <= DESIGNER_ASK_EXCERPT ? line : `${chars.slice(0, DESIGNER_ASK_EXCERPT).join('').trimEnd()}…`
}

/** The office-only note, in both of the office's languages (as the other system lines: "it · en"). */
export function designerAskNote(customer: string, body: string): string {
  return `${customer} chiede al designer della fabbrica · asks the factory designer: «${askExcerpt(body)}»`
}

export const DESIGNER_ASK_REFUSALS = ['NO_DESIGNER', 'NOT_HERE'] as const
export type DesignerAskRefusal = (typeof DESIGNER_ASK_REFUSALS)[number]

/** The portal's words ("voi"); {name} the factory designer's display name. Never naming another customer. */
export const DESIGNER_ASK_WORDS = Object.freeze({
  NO_DESIGNER: { it: "Non c'è ancora un designer della fabbrica per voi: scrivete qui, risponde il nostro team.", en: 'No factory designer is named for you yet: write here, our team answers.' },
  NOT_HERE: { it: 'Qui il designer della fabbrica non si può chiedere: il messaggio arriva al nostro team.', en: 'The factory designer cannot be asked here: your message reaches our team.' },
  ASKED: { it: 'Abbiamo chiesto a {name}.', en: 'We asked {name}.' },
  CAPPED: {
    it: `Messaggio inviato. Oggi avete già chiesto ${DESIGNER_ASKS_PER_DAY} volte al designer della fabbrica: questo messaggio arriva al nostro team.`,
    en: `Message sent. You asked the factory designer ${DESIGNER_ASKS_PER_DAY} times today already: this message reaches our team.`,
  },
} satisfies Record<string, { readonly it: string; readonly en: string }>)
export type DesignerAskWord = keyof typeof DESIGNER_ASK_WORDS

/** A word in the person's language, with the designer's name in it. */
export function designerAskWords(word: DesignerAskWord, locale: string | null | undefined, name = ''): string {
  return DESIGNER_ASK_WORDS[word][partnerLocaleOf(locale)].replaceAll('{name}', name)
}
