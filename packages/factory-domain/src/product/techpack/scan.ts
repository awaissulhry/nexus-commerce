import type { TechPackAudience } from './rules'

/**
 * The QR to the current version (B-W2b-230; PRD-138 "QR to current version, with versions"): every page of a tech pack PDF
 * carries a QR to the factory web's `/tech-pack/<code>`; a scan of an older page says that a newer one exists.
 *
 * The code names ONE stored version (GeneratedDocument of kind TECH_PACK): the last 48 bits of its id (the last group of the
 * UUID, 12 hex digits) in Crockford's base 32, 10 symbols, printed in two groups (`TP 7K3QM-2XA9B`). The ids are UUIDv7 made
 * by the app: their last 62 bits are random, so the code carries no column and is as hard to guess as 48 random bits; the
 * check route needs a signed-in reader on top. Two versions sharing a code (one pair in about 2^24 among 2^24 versions) make
 * the check answer the newest of them.
 *
 * Which page is current: the printed version's revision is the style's revision in force (or still the newest when nothing is
 * released), and no newer version of the SAME audience and language says something else (the same contents again are the
 * same page: a version that reused an earlier one's file has the same fingerprint).
 */

export const TECH_PACK_CODE_LENGTH = 10
/** The id's last 12 hex digits (48 bits) a code stands for. */
export const TECH_PACK_CODE_HEX = 12

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const VALUE_OF: ReadonlyMap<string, number> = new Map([...ALPHABET].map((symbol, value) => [symbol, value]))
const SAME_AS: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The path's first part on the factory web. */
export const TECH_PACK_PATH = '/tech-pack/'

/** The code of a stored version by its id: its last 48 bits in base 32, 10 symbols. Throws a RangeError for anything else. */
export function techPackCodeOf(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new RangeError(`not a record id: ${String(id)}`)
  let value = BigInt(`0x${id.slice(-TECH_PACK_CODE_HEX)}`)
  let code = ''
  for (let index = 0; index < TECH_PACK_CODE_LENGTH; index++) {
    code = ALPHABET[Number(value & 31n)] + code
    value >>= 5n
  }
  return code
}

/**
 * A typed or scanned code: upper case, hyphens, spaces and a leading "TP" dropped, O → 0, I and L → 1; a whole address
 * (`https://…/tech-pack/7K3QM2XA9B`) reads as its code; null when it is not 10 symbols of the alphabet standing for at most 48
 * bits.
 */
export function readTechPackCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  const fromAddress = /\/tech-pack\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(trimmed)?.[1]
  let raw = fromAddress !== undefined ? safeDecode(fromAddress) : trimmed
  if (raw === null || raw.length > 40) return null
  raw = raw.toUpperCase().replace(/[\s-]+/g, '')
  if (raw.startsWith('TP') && raw.length === TECH_PACK_CODE_LENGTH + 2) raw = raw.slice(2)
  const compact = [...raw].map((symbol) => SAME_AS[symbol] ?? symbol).join('')
  if (compact.length !== TECH_PACK_CODE_LENGTH || ![...compact].every((symbol) => VALUE_OF.has(symbol))) return null
  // 10 symbols hold 50 bits; a code stands for 48: its first symbol is 0 to 7.
  return VALUE_OF.get(compact[0]!)! < 8 ? compact : null
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** The 12 hex digits (lower case) a code stands for: the last group of the version's id. */
export function techPackCodeHex(code: string): string {
  const read = readTechPackCode(code)
  if (read === null) throw new RangeError(`not a tech pack code: ${String(code)}`)
  let value = 0n
  for (const symbol of read) value = (value << 5n) | BigInt(VALUE_OF.get(symbol)!)
  return value.toString(16).padStart(TECH_PACK_CODE_HEX, '0')
}

/** `TP 7K3QM-2XA9B`: as printed under the QR. */
export function formatTechPackCode(code: string): string {
  const read = readTechPackCode(code)
  if (read === null) throw new RangeError(`not a tech pack code: ${String(code)}`)
  return `TP ${read.slice(0, 5)}-${read.slice(5)}`
}

/** What the QR holds: the factory web's page of the code (FACTORY_WEB_ORIGIN + `/tech-pack/<code>`). */
export function techPackAddress(webOrigin: string, code: string): string {
  const read = readTechPackCode(code)
  if (read === null) throw new RangeError(`not a tech pack code: ${String(code)}`)
  return `${webOrigin.replace(/\/+$/, '')}${TECH_PACK_PATH}${read}`
}

// ---- the verdict of a scan --------------------------------------------------------------------------------------------------

export const SCAN_STATES = ['CURRENT', 'NEWER_VERSION', 'NEWER_REVISION', 'DRAFT', 'OBSOLETE'] as const
export type ScanState = (typeof SCAN_STATES)[number]

export interface ScannedVersion {
  readonly id: string
  readonly revisionId: string
  readonly version: number
  readonly audience: TechPackAudience | null
  readonly language: string
  readonly fingerprint: string
  readonly createdAt: string
}

export interface ScanRevision {
  readonly id: string
  readonly revision: number
  readonly status: 'DRAFT' | 'RELEASED' | 'OBSOLETE'
}

export interface ScanVerdict {
  readonly state: ScanState
  readonly words: string
  readonly newer: { readonly revisionId: string; readonly revision: number; readonly version: number | null; readonly createdAt: string | null } | null
}

/**
 * Whether a printed page is the current one, in words. `versions`: every stored TECH_PACK version of the style (any revision);
 * `revisions`: every revision of the style.
 *
 *   NEWER_REVISION   the style has a revision in force other than the page's (released later): its tech pack is the one
 *   OBSOLETE         the page's revision is obsolete and nothing is released any more
 *   NEWER_VERSION    the same revision has a newer version for the same audience and language that says something else
 *   DRAFT            the page is the newest, but its revision is still a draft: it can change before release
 *   CURRENT          the page is the newest of a released revision
 */
export function scanVerdict(printed: ScannedVersion, printedRevision: ScanRevision, versions: readonly ScannedVersion[], revisions: readonly ScanRevision[]): ScanVerdict {
  const label = `version ${printed.version} of revision ${printedRevision.revision}`
  const inForce = [...revisions].filter((revision) => revision.status === 'RELEASED').sort((a, b) => b.revision - a.revision)[0] ?? null
  const sameKind = (version: ScannedVersion) => version.audience === printed.audience && version.language === printed.language
  const newestOf = (revisionId: string) =>
    versions.filter((version) => version.revisionId === revisionId && sameKind(version)).sort((a, b) => b.version - a.version)[0] ?? null

  if (inForce && inForce.id !== printedRevision.id && inForce.revision > printedRevision.revision) {
    const newest = newestOf(inForce.id)
    return {
      state: 'NEWER_REVISION',
      words: `A newer tech pack exists: revision ${inForce.revision} is in force${newest ? ` (its newest copy is version ${newest.version})` : ''}. This page is ${label}: do not work from it.`,
      newer: { revisionId: inForce.id, revision: inForce.revision, version: newest?.version ?? null, createdAt: newest?.createdAt ?? null },
    }
  }
  if (printedRevision.status === 'OBSOLETE') {
    return { state: 'OBSOLETE', words: `This page is ${label}, which is obsolete and no revision is in force: ask the office before you work from it.`, newer: null }
  }
  const newest = newestOf(printedRevision.id)
  if (newest && newest.version > printed.version && newest.fingerprint !== printed.fingerprint) {
    return {
      state: 'NEWER_VERSION',
      words: `A newer version exists: version ${newest.version} of revision ${printedRevision.revision}. This page is version ${printed.version}: do not work from it.`,
      newer: { revisionId: printedRevision.id, revision: printedRevision.revision, version: newest.version, createdAt: newest.createdAt },
    }
  }
  if (printedRevision.status === 'DRAFT') {
    return { state: 'DRAFT', words: `This page is the newest copy (${label}), but revision ${printedRevision.revision} is still a draft: it can change before it is released.`, newer: null }
  }
  return { state: 'CURRENT', words: `This page is current: ${label}, the revision in force.`, newer: null }
}
