/**
 * The public DoC code (B-W2b-166; PRD-294, PRD-356; Reg. (EU) 2016/425 art. 8(8) and Reg. (EU) 2023/988 (GPSR) art. 19;
 * design links.doc "/doc/<code> — permanent, public, printed as a QR on the label and in the instructions (kept at least
 * 10 years); not a token", sec:lookup "Type the 8-character code under the QR").
 *
 * The code names ONE record: a batch (a work order, once released with its batch number) or a style (its current
 * declaration, for a store's product page or the printed instructions). It is 8 symbols of Crockford's base 32 (0-9 and
 * A-Z without I, L, O, U), typed in any case, with or without a hyphen or spaces, with O for 0 and I or L for 1:
 *
 *   7K3Q-M2XA   printed;   /doc/7K3QM2XA   the address
 *
 * It is the last 40 bits of the record's id, written in base 32. The ids are UUIDv7 made by the app (core/ids): their
 * last 62 bits are random, so a code is as hard to guess as 40 random bits (the lookup route is rate-limited on top), it
 * needs no column, and it never changes — not with a new batch number series, a new declaration, a new sender name or a
 * new web address: a code printed today keeps working for the ten years the declaration is kept. Nothing about the
 * record can be read from it but the record's existence, and only through the rate-limited lookup.
 *
 * Two records could share a code (two ids with the same last 40 bits: about one pair in 2 million among 1,000 ids): the
 * lookup then names both and the reader picks the product on their label (resolve.ts in the API). No code is ever "given"
 * twice on purpose, so the page never mixes two products' documents.
 */

/** Symbols in a code. */
export const PUBLIC_DOC_CODE_LENGTH = 8

/** The bits of the id a code holds (5 per symbol). */
export const PUBLIC_DOC_CODE_BITS = PUBLIC_DOC_CODE_LENGTH * 5

/** The hex digits of the id a code stands for: its last 10 (40 bits). */
export const PUBLIC_DOC_CODE_HEX = PUBLIC_DOC_CODE_BITS / 4

/** What a code names. */
export const PUBLIC_DOC_KINDS = ['BATCH', 'STYLE'] as const
export type PublicDocKind = (typeof PUBLIC_DOC_KINDS)[number]

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const VALUE_OF: ReadonlyMap<string, number> = new Map([...ALPHABET].map((symbol, value) => [symbol, value]))
/** The symbols people mistake for others, read as Crockford intends. */
const SAME_AS: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The code of a record by its id (a UUID): its last 40 bits in base 32, 8 symbols. Throws a RangeError for anything else. */
export function publicDocCodeOf(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new RangeError(`not a record id: ${String(id)}`)
  const hex = id.replace(/-/g, '').slice(-PUBLIC_DOC_CODE_HEX).toLowerCase()
  let value = BigInt(`0x${hex}`)
  let code = ''
  for (let index = 0; index < PUBLIC_DOC_CODE_LENGTH; index++) {
    code = ALPHABET[Number(value & 31n)] + code
    value >>= 5n
  }
  return code
}

/**
 * A typed or scanned code as the page and the API read it: upper case, hyphens and spaces dropped, O → 0, I and L → 1;
 * null when it is not 8 symbols of the alphabet. A whole address (`https://…/doc/7K3QM2XA`) reads as its code.
 */
export function readPublicDocCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  const fromAddress = /\/doc\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(trimmed)?.[1]
  const raw = fromAddress !== undefined ? decodeURIComponent(fromAddress) : trimmed
  if (raw.length > 32) return null
  const compact = [...raw.toUpperCase().replace(/[\s-]+/g, '')].map((symbol) => SAME_AS[symbol] ?? symbol).join('')
  if (compact.length !== PUBLIC_DOC_CODE_LENGTH) return null
  return [...compact].every((symbol) => VALUE_OF.has(symbol)) ? compact : null
}

/** The 10 hex digits (lower case) a read code stands for: the end of the record's id. Throws for a code readPublicDocCode refuses. */
export function publicDocCodeHex(code: string): string {
  const read = readPublicDocCode(code)
  if (read === null) throw new RangeError(`not a public DoC code: ${String(code)}`)
  let value = 0n
  for (const symbol of read) value = (value << 5n) | BigInt(VALUE_OF.get(symbol)!)
  return value.toString(16).padStart(PUBLIC_DOC_CODE_HEX, '0')
}

/** True when the record's id ends with what the code stands for. */
export function codeNames(code: string, id: string): boolean {
  return UUID.test(id) && id.replace(/-/g, '').toLowerCase().endsWith(publicDocCodeHex(code))
}

/** `7K3Q-M2XA`: the code as printed under the QR and shown on the page (two groups of four). */
export function formatPublicDocCode(code: string): string {
  const read = readPublicDocCode(code)
  if (read === null) throw new RangeError(`not a public DoC code: ${String(code)}`)
  return `${read.slice(0, 4)}-${read.slice(4)}`
}

/** The page's path: `/doc/7K3QM2XA` (the code without its hyphen: the QR stays small). */
export function publicDocPath(code: string): string {
  const read = readPublicDocCode(code)
  if (read === null) throw new RangeError(`not a public DoC code: ${String(code)}`)
  return `/doc/${read}`
}

/** The page's whole address on the factory web (FACTORY_WEB_ORIGIN): what the QR holds and a store links to. */
export function publicDocAddress(webOrigin: string, code: string): string {
  return `${webOrigin.replace(/\/+$/, '')}${publicDocPath(code)}`
}
