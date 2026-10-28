/**
 * Scannable ids (feature PLT-126; PLT-155 scans them): a short code for a physical thing — a hide, a bundle, a lot, a
 * carton — that a scanner reads from its label (Code 128 or QR) and a person can type when the label is torn.
 *
 *   HD-7K-0003RJ-M
 *   │  │  │      └ check symbol: catches every single wrong symbol and every swap of two symbols
 *   │  │  └ reference: the thing's number (a positive integer, at least 6 symbols)
 *   │  └ tenant tag: 2 symbols from the tenant's id, so a label from another factory is refused, not misread
 *   └ type: what the thing is (SCAN_TYPES)
 *
 * The reference and tenant tag use Crockford's base 32 (0-9 and A-Z without I, L, O, U): typed in any case, with or
 * without the hyphens, and with O for 0 or I and L for 1, it reads the same. Only uppercase letters, digits and `-`,
 * so the code fits QR's alphanumeric mode and Code 128.
 *
 * The reference is what the code points at; the module that prints a label chooses it and keeps it unique per tenant
 * and type (normally the thing's number in a series that never resets). Resolving a code to a record is that
 * module's lookup; this file only writes and reads codes.
 *
 * The check: each symbol is its Crockford value 0-31 (the type's letters too), and the code is valid when folding
 * `r → 2·r ⊕ v` over all of them in GF(32) (x⁵ + x² + 1) ends at 0. That operation is a totally anti-symmetric
 * quasigroup (Damm's construction over a field), so one wrong symbol, or two different neighbours swapped, always
 * changes the result; so does a swap of two symbols up to 30 places apart.
 */

/** The kinds of physical things that carry a scannable id, with their 2-letter type codes. New types are additive. */
export const SCAN_TYPES = {
  HIDE: 'HD',
  BUNDLE: 'BN',
  LOT: 'LT',
  BATCH: 'BT',
  SERIAL: 'SN',
  CARTON: 'CT',
  LOCATION: 'LC',
  WORK_ORDER: 'WO',
} as const
export type ScanType = keyof typeof SCAN_TYPES

const TYPE_OF_CODE: ReadonlyMap<string, ScanType> = new Map(Object.entries(SCAN_TYPES).map(([type, code]) => [code, type as ScanType]))

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const VALUE_OF: ReadonlyMap<string, number> = new Map([...ALPHABET].map((symbol, value) => [symbol, value]))
/** The symbols people mistake for others, read as Crockford intends. */
const SAME_AS: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' }

const REF_MIN_SYMBOLS = 6
const REF_MAX_SYMBOLS = 8
/** The largest reference: 8 symbols. */
export const MAX_SCAN_REF = 32 ** REF_MAX_SYMBOLS - 1

/** Multiplication by 2 in GF(32), reduced by x⁵ + x² + 1. */
const double = (value: number): number => {
  const shifted = value << 1
  return shifted & 0x20 ? (shifted ^ 0x25) & 0x1f : shifted
}
const fold = (values: readonly number[]): number => values.reduce((interim, value) => double(interim) ^ value, 0)

// A type letter counts as its Crockford value (L as 1, O as 0), so a swap between the type and the rest is caught too.
const typeValues = (code: string): number[] => [...code].map((letter) => VALUE_OF.get(SAME_AS[letter] ?? letter)!)
const symbolValues = (text: string): number[] => [...text].map((symbol) => VALUE_OF.get(symbol)!)

function base32(value: number, width: number): string {
  let text = ''
  let rest = value
  while (rest > 0) {
    text = ALPHABET[rest % 32] + text
    rest = Math.floor(rest / 32)
  }
  return text.padStart(width, '0')
}

/** The tenant tag: 2 symbols (10 bits) of a FNV-1a hash of the tenant id. Two tenants share one in 1,024. */
export function tenantTag(tenantId: string): string {
  if (typeof tenantId !== 'string' || tenantId === '') throw new TypeError('a tenant id is needed')
  let hash = 0x811c9dc5
  for (const char of tenantId.toLowerCase()) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return base32(hash & 0x3ff, 2)
}

export interface ScanId {
  readonly type: ScanType
  /** `tenantTag(tenantId)` of the tenant the thing belongs to. */
  readonly tenantTag: string
  /** What the code points at: 1 to MAX_SCAN_REF. */
  readonly ref: number
}

/** The printed code, `HD-7K-0003RJ-M`. Throws a RangeError for an unknown type, a bad tag or a reference out of range. */
export function formatScanId({ type, tenantTag: tag, ref }: ScanId): string {
  const code = SCAN_TYPES[type]
  if (code === undefined) throw new RangeError(`not a scan type: ${String(type)}`)
  if (typeof tag !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{2}$/.test(tag)) throw new RangeError(`not a tenant tag: ${String(tag)}`)
  if (!Number.isSafeInteger(ref) || ref < 1 || ref > MAX_SCAN_REF) throw new RangeError(`a reference is a whole number from 1 to ${MAX_SCAN_REF}, not ${String(ref)}`)
  const reference = base32(ref, REF_MIN_SYMBOLS)
  const check = ALPHABET[double(fold([...typeValues(code), ...symbolValues(tag + reference)]))]!
  return `${code}-${tag}-${reference}-${check}`
}

/** Why a scanned or typed code was refused. */
export type ScanIdProblem = 'format' | 'type' | 'check' | 'tenant'

export type ScanIdResult =
  | ({ readonly ok: true; /** The code as printed. */ readonly text: string } & ScanId)
  | { readonly ok: false; readonly problem: ScanIdProblem; readonly message: string }

export interface ParseScanIdOptions {
  /** The tenant of the session: a code with another tag is refused. */
  readonly tenantTag?: string
  /** The types the screen expects (a hide scan screen takes only hides). */
  readonly types?: readonly ScanType[]
}

const refuse = (problem: ScanIdProblem, message: string): ScanIdResult => ({ ok: false, problem, message })

/** Reads a scanned or typed code. Never throws; a refusal says what is wrong, for the person at the scanner. */
export function parseScanId(input: unknown, options: ParseScanIdOptions = {}): ScanIdResult {
  if (typeof input !== 'string') return refuse('format', 'This is not a label code.')
  const compact = input.toUpperCase().replace(/[\s-]+/g, '')
  if (compact.length < 2 + 2 + REF_MIN_SYMBOLS + 1 || compact.length > 2 + 2 + REF_MAX_SYMBOLS + 1) {
    return refuse('format', 'This code is too short or too long for a label code.')
  }
  const code = compact.slice(0, 2)
  const type = TYPE_OF_CODE.get(code)
  if (type === undefined) return refuse('type', `"${code}" is not a kind of label this factory prints.`)
  const rest = [...compact.slice(2)].map((symbol) => SAME_AS[symbol] ?? symbol).join('')
  if ([...rest].some((symbol) => !VALUE_OF.has(symbol))) return refuse('format', 'This code holds a character no label code has.')
  if (fold([...typeValues(code), ...symbolValues(rest)]) !== 0) {
    return refuse('check', 'This code has a typo: its check symbol does not match. Scan it again or type it again.')
  }
  const tag = rest.slice(0, 2)
  const reference = rest.slice(2, -1)
  // Only the form formatScanId prints: zeros in front only up to 6 symbols.
  if (reference.length > REF_MIN_SYMBOLS && reference.startsWith('0')) return refuse('format', 'This code is not written the way labels print it.')
  const ref = symbolValues(reference).reduce((total, value) => total * 32 + value, 0)
  if (ref < 1) return refuse('format', 'This code points at nothing.')
  if (options.tenantTag !== undefined && tag !== options.tenantTag) return refuse('tenant', 'This label belongs to another factory.')
  if (options.types !== undefined && !options.types.includes(type)) return refuse('type', `This is a ${type.toLowerCase().replace('_', ' ')} label, not one this screen takes.`)
  return { ok: true, type, tenantTag: tag, ref, text: `${code}-${tag}-${reference}-${rest.slice(-1)}` }
}
