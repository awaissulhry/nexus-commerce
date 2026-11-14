/**
 * The mis-send guard's pure rules (B-W2b-397; COL-004 "Mis-send guard"; design shell.panels pop:mis-send "Send to Pista
 * Racing?": "Recipients with their organisation; warnings: 'Mentions cost', 'Names another customer: Rider Club',
 * '@Marco is internal'. Attachments with their audience."). A mail that went to the wrong customer cannot be taken back, so
 * before a person sends a message to a party the API says what it found in what they typed; the person decides. Nothing
 * here refuses a send: these are warnings, read in the person's own text.
 *
 * Words are compared without case or accents and only as whole words, so "costumi" never reads as "cost" and an address
 * (`marco@…`) never reads as an @mention.
 */

/** The warnings, each with the words, names or addresses it found (the screen says them from the code). */
export const MIS_SEND_WARNINGS = [
  /** A recipient is a contact (or at the company domain) of another organisation than the record's party. */
  'OTHER_ORGANISATION',
  /** Nothing is known of a recipient: no contact, no portal person, no colleague, no domain of a party. */
  'UNKNOWN_RECIPIENT',
  /** The subject or the text speaks of cost, margin or a purchase price. */
  'MENTIONS_COST',
  /** The subject or the text names another customer of the company. */
  'NAMES_OTHER_CUSTOMER',
  /** The text @mentions a colleague: an internal note's habit, in a mail the party reads. */
  'INTERNAL_MENTION',
  /** An attachment is not shared with the party (the send refuses it). */
  'OFFICE_FILE',
] as const
export type MisSendWarning = (typeof MIS_SEND_WARNINGS)[number]

/** Whose a recipient is, as far as we know. */
export const RECIPIENT_KINDS = ['PARTY', 'OTHER_PARTY', 'OURS', 'UNKNOWN'] as const
export type RecipientKind = (typeof RECIPIENT_KINDS)[number]

/** How we know it: a contact of the party, a person of its portal, a colleague, our own domain, the party's company domain. */
export const RECIPIENT_SOURCES = ['CONTACT', 'PORTAL_PERSON', 'COLLEAGUE', 'OUR_DOMAIN', 'DOMAIN'] as const
export type RecipientSource = (typeof RECIPIENT_SOURCES)[number]

/** At most this many other customers are read for the name check, and this many items are said per warning. */
export const MIS_SEND_LIMITS = Object.freeze({ parties: 5000, items: 10, colleagues: 2000 })

/** Lower case, no accents, curly apostrophes made straight. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’`´]/g, "'")
    .toLowerCase()
}

/** The words of a text (letters, digits, apostrophes and hyphens inside a word), folded. */
export function wordsOf(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? []
}

/** Whether `needle` (a word list) stands in `haystack` (a word list) as consecutive whole words. */
function standsIn(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true
  }
  return false
}

/**
 * Cost words, Italian and English (the office writes in both): cost and its plurals, margin, markup, the purchase price and
 * the supplier's price list. "Costumi", "costante" or "costa" (it costs: a price, said to customers every day) are not
 * among them.
 */
const COST_TERMS: readonly string[] = [
  'cost',
  'costs',
  'costing',
  'cogs',
  'costo',
  'costi',
  'margin',
  'margins',
  'margine',
  'margini',
  'marginalita',
  'markup',
  'mark-up',
  'ricarico',
  'ricarichi',
  'purchase price',
  'buying price',
  'supplier price',
  "prezzo d'acquisto",
  'prezzo di acquisto',
  'prezzo fornitore',
  'listino fornitore',
]
const COST_WORDS = COST_TERMS.map((term) => ({ term, words: wordsOf(term) }))

/** The cost words a text uses (folded, each once, in the list's order). */
export function costWordsIn(text: string): string[] {
  const words = wordsOf(text)
  return COST_WORDS.filter((entry) => standsIn(words, entry.words)).map((entry) => entry.term)
}

/** Legal forms left out of a company's name before it is looked for ("Rider Club S.r.l." is named "Rider Club"). */
const LEGAL_FORMS = new Set(['srl', 'srls', 'spa', 'snc', 'sas', 'sapa', 'scarl', 'scrl', 'soc', 'coop', 'gmbh', 'ag', 'kg', 'ltd', 'limited', 'llc', 'inc', 'plc', 'sa', 'sl', 'sarl', 'sas', 'bv', 'nv', 'co', 'c'])

/** A name's words to look for: folded, dotted legal forms joined ("s.r.l." → "srl") and left out at the end. */
export function nameWords(name: string): string[] {
  const words = wordsOf(name.replace(/\b((?:\p{L}\.){2,})/gu, (dotted) => dotted.replace(/\./g, '')))
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1]!)) words.pop()
  return words
}

/** A name worth looking for: two words or more, or one of at least four letters ("Moto" yes, "Ab" no). */
const lookable = (words: readonly string[]): boolean => words.length > 1 || (words[0]?.length ?? 0) >= 4

export interface NamedParty {
  readonly id: string
  readonly legalName: string
  readonly tradeName: string | null
}

/** The parties a text names by their legal or trade name (whole words, without the legal form), in the list's order. */
export function partiesNamedIn<T extends NamedParty>(text: string, parties: readonly T[]): T[] {
  const words = wordsOf(text)
  if (words.length === 0) return []
  return parties.filter((party) =>
    [party.legalName, party.tradeName].some((name) => {
      if (!name) return false
      const needle = nameWords(name)
      return lookable(needle) && standsIn(words, needle)
    }),
  )
}

export interface Colleague {
  readonly id: string
  readonly displayName: string
}

/**
 * The colleagues a text @mentions: `@` at the start of a word (not inside an address) followed by a person's full name or
 * first name. The longest name wins ("@Marco Rossi" is Marco Rossi, not every Marco); a first name two colleagues share
 * names both.
 */
export function mentionedIn<T extends Colleague>(text: string, people: readonly T[]): T[] {
  const found = new Set<T>()
  for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}@._%+-])@([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2})/gu)) {
    const said = wordsOf(match[1]!)
    const full = people.filter((person) => {
      const name = wordsOf(person.displayName)
      return name.length > 0 && name.length <= said.length && name.every((word, index) => said[index] === word)
    })
    const longest = Math.max(0, ...full.map((person) => wordsOf(person.displayName).length))
    const chosen = full.length > 0 ? full.filter((person) => wordsOf(person.displayName).length === longest) : people.filter((person) => wordsOf(person.displayName)[0] === said[0])
    for (const person of chosen) found.add(person)
  }
  return [...found]
}

export interface RecipientFacts {
  /** The parties the address is a contact or a portal person of. */
  readonly parties: readonly { readonly partyId: string; readonly source: 'CONTACT' | 'PORTAL_PERSON'; readonly name: string | null }[]
  /** An office person of ours has it. */
  readonly colleague: boolean
  /** It is at a domain we send from or receive replies at. */
  readonly ourDomain: boolean
  /** The one party whose contacts share its company domain, when exactly one does. */
  readonly domainParty: string | null
}

export interface RecipientFinding {
  readonly kind: RecipientKind
  readonly source: RecipientSource | null
  readonly partyId: string | null
  /** The contact's or portal person's name, when the address is theirs. */
  readonly personName: string | null
}

/**
 * Whose an address is, against the record's party: one of the party's own (a contact, a portal person, its company domain),
 * another organisation's, ours, or nobody we know. The record's party wins when the address is known to several.
 */
export function recipientOf(facts: RecipientFacts, recordParty: string | null): RecipientFinding {
  const own = facts.parties.find((entry) => entry.partyId === recordParty)
  if (own) return { kind: 'PARTY', source: own.source, partyId: own.partyId, personName: own.name }
  const other = facts.parties[0]
  if (other) return { kind: 'OTHER_PARTY', source: other.source, partyId: other.partyId, personName: other.name }
  if (facts.colleague) return { kind: 'OURS', source: 'COLLEAGUE', partyId: null, personName: null }
  if (facts.ourDomain) return { kind: 'OURS', source: 'OUR_DOMAIN', partyId: null, personName: null }
  if (facts.domainParty !== null) return { kind: facts.domainParty === recordParty ? 'PARTY' : 'OTHER_PARTY', source: 'DOMAIN', partyId: facts.domainParty, personName: null }
  return { kind: 'UNKNOWN', source: null, partyId: null, personName: null }
}

/** The first items of a warning, each once. */
export const firstItems = (items: readonly string[]): string[] => [...new Set(items)].slice(0, MIS_SEND_LIMITS.items)
