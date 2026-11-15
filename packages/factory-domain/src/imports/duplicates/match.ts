/**
 * Likely duplicates (B-W2b-427; feature PLT-178; design admin.import "possible duplicates", customers.new and
 * materials.new "Duplicate warning"): the keys two records are compared by, and how alike two names are. Pure: the
 * API finds the candidates in the database and judges them with these; the web shows the reasons in its own words.
 *
 *   a VAT number      compared without its country prefix (IT01234567890 = 01234567890), with the codice fiscale of
 *                     a company (11 digits) read as its VAT number too
 *   a name            accents, case and punctuation dropped, legal forms (S.r.l., SpA, GmbH, Ltd …) and small words
 *                     (di, della, and …) left out, the words in alphabetical order: "Pelletteria Rossi S.r.l." and
 *                     "ROSSI PELLETTERIA SRL" have the same key; a similar name is a Sørensen–Dice score of the keys'
 *                     letter pairs from 0.82 (only for keys of 5 letters or more: "ABC" and "ABD" are never alike)
 *   an e-mail domain  the part after @, never a public mailbox or a certified-mail provider (gmail.com, libero.it,
 *                     pec.it …): many companies share those
 *   a website         its host without www.
 *   a code            upper case, letters and digits only ("PEL-001" = "pel 001")
 */

/** Legal forms and words that say nothing about who a business is (compared after the dotted ones are joined). */
const NOISE = new Set([
  // Italian legal forms
  'srl', 'srls', 'spa', 'sapa', 'sas', 'snc', 'ss', 'sc', 'scarl', 'scrl', 'scpa', 'coop', 'societa', 'soc', 'ditta', 'dittaindividuale', 'impresa', 'unipersonale', 'cooperativa',
  // other legal forms
  'ltd', 'limited', 'llc', 'llp', 'inc', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'kg', 'ohg', 'ug', 'sa', 'sarl', 'sl', 'slu', 'bv', 'nv', 'oy', 'ab', 'as', 'aps', 'kft', 'sro', 'spzoo', 'eurl', 'sasu',
  // small words
  'di', 'de', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'e', 'ed', 'and', 'the', 'la', 'il', 'lo', 'le', 'gli', 'i', 'of', 'und', 'et', 'y',
])

/** Public mailboxes and certified-mail (PEC) providers: a shared domain says nothing about who sent it. */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.it', 'hotmail.com', 'hotmail.it', 'live.com', 'live.it', 'msn.com', 'yahoo.com', 'yahoo.it',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'yandex.com',
  'libero.it', 'virgilio.it', 'alice.it', 'tin.it', 'tim.it', 'tiscali.it', 'fastwebnet.it', 'email.it', 'inwind.it', 'iol.it', 'katamail.com', 'teletu.it', 'vodafone.it', 'aruba.it',
  'pec.it', 'legalmail.it', 'arubapec.it', 'pec.aruba.it', 'postacert.it', 'cert.legalmail.it', 'pecimprese.it', 'registerpec.it', 'gigapec.it', 'mypec.eu', 'sicurezzapostale.it', 'postecert.it', 'pec.libero.it', 'casellapec.com', 'pecveloce.it',
])

/** The smallest name key (letters, without spaces) a similar name may be found for; shorter keys match only when equal. */
export const SIMILAR_NAME_MIN_LETTERS = 5
/** From this score (0..1) two names are similar. */
export const SIMILAR_NAME_SCORE = 0.82

const accentless = (value: string): string => value.normalize('NFKD').replace(/[̀-ͯ]/g, '')

/**
 * The words of a name as compared: lower case, without accents and punctuation, single letters run together
 * ("s.r.l." → "srl"), legal forms and small words left out, in alphabetical order. Empty for a name of noise only.
 */
export function nameWords(name: string | null | undefined): string[] {
  if (!name) return []
  const raw = accentless(name)
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
  // "s r l" → "srl": a run of single letters is one abbreviation.
  const joined: string[] = []
  let run = ''
  for (const word of raw) {
    if (word.length === 1 && /[a-z]/.test(word)) {
      run += word
      continue
    }
    if (run) joined.push(run)
    run = ''
    joined.push(word)
  }
  if (run) joined.push(run)
  return joined.filter((word) => !NOISE.has(word)).sort()
}

/** The key two names are compared by ("" for none). */
export const nameKey = (name: string | null | undefined): string => nameWords(name).join(' ')

function letterPairs(value: string): Map<string, number> {
  const pairs = new Map<string, number>()
  for (let i = 0; i < value.length - 1; i++) {
    const pair = value.slice(i, i + 2)
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  }
  return pairs
}

/**
 * How alike two name keys are, 0..1: 1 for equal keys; else the Sørensen–Dice coefficient of their letter pairs
 * (spaces dropped). Keys shorter than SIMILAR_NAME_MIN_LETTERS letters score 0 unless equal.
 */
export function nameScore(a: string, b: string): number {
  if (a === '' || b === '') return 0
  if (a === b) return 1
  const left = a.replace(/ /g, '')
  const right = b.replace(/ /g, '')
  if (left === right) return 1
  if (left.length < SIMILAR_NAME_MIN_LETTERS || right.length < SIMILAR_NAME_MIN_LETTERS) return 0
  const one = letterPairs(left)
  const two = letterPairs(right)
  let shared = 0
  for (const [pair, count] of one) shared += Math.min(count, two.get(pair) ?? 0)
  return (2 * shared) / (left.length - 1 + (right.length - 1))
}

/** The words of a name worth searching by (long enough, not noise): what narrows the candidates in the database. */
export function searchWords(name: string | null | undefined, max = 3): string[] {
  return [...new Set(nameWords(name).filter((word) => word.length >= 4))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, max)
}

/** An e-mail's domain, lower case; null for none, a malformed address or a shared mailbox (SHARED_MAIL_DOMAINS). */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.trim().toLowerCase().lastIndexOf('@')
  if (at < 1) return null
  const domain = email
    .trim()
    .toLowerCase()
    .slice(at + 1)
    .replace(/\.+$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null
  return SHARED_MAIL_DOMAINS.has(domain) ? null : domain
}

/** A website's host without www., lower case; null for none or one that is not a host. */
export function websiteHost(website: string | null | undefined): string | null {
  if (!website) return null
  const host = website
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#:]/)[0]!
    .replace(/^www\./, '')
    .replace(/\.+$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

/** A code as compared: upper case, letters and digits only. */
export const codeKey = (code: string | null | undefined): string => (code ? accentless(code).toUpperCase().replace(/[^A-Z0-9]/g, '') : '')

/** A tax number without spaces, dots and dashes, upper case. */
const compact = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The keys of a VAT number and a codice fiscale: the VAT numbers without their country prefix (two letters before a
 * digit), the codici fiscali as typed (compact) — a company's 11-digit codice fiscale is also its Italian VAT number,
 * and an Italian VAT number also its codice fiscale.
 */
export function taxKeys(vatNumbers: readonly (string | null | undefined)[], fiscalCodes: readonly (string | null | undefined)[]): { readonly vat: readonly string[]; readonly fiscal: readonly string[] } {
  const vat = new Set<string>()
  const fiscal = new Set<string>()
  for (const value of vatNumbers) {
    if (!value) continue
    const number = compact(value)
    if (number.length < 5) continue
    const core = number.replace(/^[A-Z]{2}(?=[0-9])/, '')
    vat.add(core)
    if (/^[0-9]{11}$/.test(core) && (number === core || number.startsWith('IT'))) fiscal.add(core)
  }
  for (const value of fiscalCodes) {
    if (!value) continue
    const code = compact(value)
    if (code.length < 5) continue
    fiscal.add(code)
    if (/^[0-9]{11}$/.test(code)) vat.add(code)
  }
  return { vat: [...vat].sort(), fiscal: [...fiscal].sort() }
}

/**
 * The stored VAT numbers a probe may equal (the parties keep them with their prefix: IT…, DE…; a number outside the
 * EU as typed): each key as it is and with the prefix of the probe's country (IT when none is known).
 */
export function storedVatNumbers(keys: readonly string[], country: string | null | undefined): string[] {
  const prefix = (country ?? 'IT').trim().toUpperCase() === 'GR' ? 'EL' : (country ?? 'IT').trim().toUpperCase().slice(0, 2) || 'IT'
  return [...new Set(keys.flatMap((key) => (/^[A-Z]{2}/.test(key) ? [key] : [key, `${prefix}${key}`, `IT${key}`])))].sort()
}
