import type { Decimal } from '../../tax/decimal'

/**
 * Formats and text rules of the FatturaPA schema (VFPR12 v1.2.3): numbers with a dot and fixed decimals, ISO dates,
 * and the two character sets the schema allows.
 */

/** Amount2DecimalType: [-]digits.dd */
export function formatAmount(value: Decimal): string {
  return value.toFixed(2)
}

/** Amount8DecimalType / QuantitaType: 2 to 8 decimals, as many as the value has. */
export function formatPrice(value: Decimal): string {
  return value.toFixed(Math.min(8, Math.max(2, value.decimalPlaces())))
}

/** RateType: a percentage, 22 -> "22.00". */
export function formatRate(value: Decimal): string {
  return value.toFixed(2)
}

/** "2026-10-31" -> "31/10/2026", for text read by people. */
export function formatDateIt(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** A real calendar date written YYYY-MM-DD, from 1970 (DataFatturaType's lower bound) to 2099. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(19[7-9]\d|20\d\d)-(\d\d)-(\d\d)$/.exec(value)
  if (!match) return false
  const year = parseInt(match[1]!, 10)
  const month = parseInt(match[2]!, 10)
  const day = parseInt(match[3]!, 10)
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= lengths[month - 1]!
}

/** "YYYY-MM" of a date. */
export function monthOf(date: string): string {
  return date.slice(0, 7)
}

/** The 15th of the month after the date's month: the last day to issue a deferred invoice (art. 21 c.4). */
export function fifteenthOfNextMonth(date: string): string {
  const year = parseInt(date.slice(0, 4), 10)
  const month = parseInt(date.slice(5, 7), 10)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-15`
}

/** Printable ASCII only (the schema's \p{IsBasicLatin} types, without control characters). */
export function isBasicLatinText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/** Printable Latin-1 (the schema's *LatinType types, without control characters). */
export function isLatin1Text(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || (code > 0x7e && code < 0xa0) || code > 0xff) return false
  }
  return true
}

/**
 * What FatturaPA carries of typed text, at XML build: every free-text field passes here (validate.ts `text`), so the
 * file holds the same words in the schema's character set instead of being refused for a typographic character.
 *
 *   1. Unicode NFC (an "e" + combining accent is one "é").
 *   2. Typographic forms to their plain ones: dashes and the minus sign "-", curly and prime quotes straight quotes,
 *      the ellipsis "...", every no-break, narrow or wide space a space, line breaks and tabs a space, invisible
 *      characters (zero-width, BOM) nothing, the bullet "-", "€" "EUR", "™" "(TM)", "Œ"/"œ" "OE"/"oe".
 *   3. Any other character outside the field's set: its compatibility form without accents (NFKD less the combining
 *      marks: full-width letters, ligatures, "ő" → "o"), or a letter of the short list below ("ł" → "l"); for a
 *      basic-Latin field, Latin-1 letters lose their accent the same way ("à" → "a").
 *   4. A character with none of these is NOT guessed: the answer names it, and the caller refuses the field.
 *
 * Charsets: LATIN1 = the schema's *LatinType (printable ISO 8859-1), ASCII = its \p{IsBasicLatin} types.
 */
export type FatturaPaCharset = 'LATIN1' | 'ASCII'

const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\t\n\r\f\v]/g
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g
const COMBINING = /[\u0300-\u036f]/g
const TYPOGRAPHIC: Readonly<Record<string, string>> = Object.freeze({
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-', '\ufe58': '-', '\ufe63': '-',
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u2035': "'", '\u2039': "'", '\u203a': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"', '\u2036': '"',
  '\u2026': '...', '\u2022': '-', '\u2023': '-', '\u2043': '-',
  '\u20ac': 'EUR', '\u2122': '(TM)', '\u0152': 'OE', '\u0153': 'oe',
})
/** Letters with no decomposition, to their closest base letter. */
const LETTERS: Readonly<Record<string, string>> = Object.freeze({
  '\u0141': 'L', '\u0142': 'l', '\u0110': 'D', '\u0111': 'd', '\u0126': 'H', '\u0127': 'h', '\u0131': 'i', '\u0166': 'T', '\u0167': 't',
})
/** Latin-1 letters a basic-Latin field cannot hold and NFKD does not split. */
const ASCII_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  '\u00df': 'ss', '\u00c6': 'AE', '\u00e6': 'ae', '\u00d8': 'O', '\u00f8': 'o', '\u00de': 'TH', '\u00fe': 'th', '\u00d0': 'D', '\u00f0': 'd',
  '\u00ab': '"', '\u00bb': '"', '\u00b7': '-', '\u00ad': '',
})

const fits = (char: string, charset: FatturaPaCharset): boolean => (charset === 'ASCII' ? isBasicLatinText(char) : isLatin1Text(char))

export type FatturaPaTextResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly character: string; readonly codePoint: string }

/** The text as FatturaPA carries it in a field of `charset`, or the first character that has no close form there. */
export function fatturaPaText(value: string, charset: FatturaPaCharset = 'LATIN1'): FatturaPaTextResult {
  const plain = value.normalize('NFC').replace(INVISIBLE, '').replace(SPACES, ' ')
  let out = ''
  for (const char of plain) {
    if (fits(char, charset)) {
      out += char
      continue
    }
    const mapped = TYPOGRAPHIC[char] ?? LETTERS[char] ?? (charset === 'ASCII' ? ASCII_LETTERS[char] : undefined)
    if (mapped !== undefined && [...mapped].every((piece) => fits(piece, charset))) {
      out += mapped
      continue
    }
    const decomposed = char.normalize('NFKD').replace(COMBINING, '')
    if (decomposed !== '' && [...decomposed].every((piece) => fits(piece, charset))) {
      out += decomposed
      continue
    }
    if (char.codePointAt(0)! < 0x20 || (char.codePointAt(0)! >= 0x7f && char.codePointAt(0)! < 0xa0)) {
      // A stray control character (C0 or C1): a space, as a line break is.
      out += ' '
      continue
    }
    return { ok: false, character: char, codePoint: `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}` }
  }
  return { ok: true, text: out }
}

/** Splits text into pieces of at most `size` characters (Causale is repeated per 200 characters). */
export function chunkText(value: string, size: number): string[] {
  const pieces: string[] = []
  for (let start = 0; start < value.length; start += size) pieces.push(value.slice(start, start + size))
  return pieces
}
