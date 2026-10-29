import { MAX_NUMBER, type ScanIdKind } from './kinds'
import { formatScanId, parseScanId, tenantTag, type ScanType } from './scan-id'

/**
 * Number blocks: how scan ids (BUNDLE, HIDE, GARMENT_SERIAL) are handed out, online and offline (design 02-sections-floor
 * "tags print offline from numbers reserved per tablet"; features PLT-126, PLT-237, PLT-238).
 *
 * Each scan-id kind has ONE counter per tenant: the scan id carries the tenant's tag, never the company, so a reference
 * is handed out once in the whole tenant. The counter is the tenant's ledger of blocks (factory-db NumberBlock): every
 * reference ever handed out lies in exactly one block, and a new block always starts above every block before it of
 * the same kind. A block is
 *   - ONLINE: taken by one command and used by it at once (a bundle make, a receipt's hide tags, a garment's serial);
 *   - DEVICE: reserved for one floor tablet, which numbers from it offline and prints its tags at once. When the tablet
 *     sends what it did, the server checks every number it used lies in a block of THAT tablet, still open, and was
 *     never used before (one NumberBlockUse row per number).
 * Gaps are fine (a ticket thrown away, a block closed with numbers left): these are not fiscal series.
 *
 * This file is the pure part: sizes, ranges, codes, the checks of a used number and the top-up rule. apps/factory-api's
 * platform/numbering/scan-ids.ts does the I/O.
 */

/** The scan type (letters on the label) of each scan-id kind. */
export const SCAN_TYPE_OF: Readonly<Record<ScanIdKind, ScanType>> = Object.freeze({ BUNDLE: 'BUNDLE', HIDE: 'HIDE', GARMENT_SERIAL: 'SERIAL' })

/** The kind in words, for messages. */
export const SCAN_KIND_WORDS: Readonly<Record<ScanIdKind, string>> = Object.freeze({ BUNDLE: 'bundle ticket', HIDE: 'hide tag', GARMENT_SERIAL: 'garment serial' })

/** The most references one block holds (the database's guard refuses a larger one). */
export const MAX_BLOCK_SIZE = 1000

/** What a tablet gets when it runs low: about a shift's worth of labels. */
export const DEVICE_BLOCK_SIZE: Readonly<Record<ScanIdKind, number>> = Object.freeze({ BUNDLE: 200, HIDE: 200, GARMENT_SERIAL: 500 })

/** Below this many numbers left (of a kind, over its open blocks) a tablet gets a new block. */
export const LOW_WATER: Readonly<Record<ScanIdKind, number>> = Object.freeze({ BUNDLE: 50, HIDE: 50, GARMENT_SERIAL: 125 })

/** At most this many blocks of a kind with numbers left per tablet: a tablet never hoards the counter. */
export const MAX_LIVE_BLOCKS = 3

export const BLOCK_PURPOSES = ['ONLINE', 'DEVICE'] as const
export type BlockPurpose = (typeof BLOCK_PURPOSES)[number]
export const BLOCK_STATUSES = ['ACTIVE', 'CLOSED'] as const
export type BlockStatus = (typeof BLOCK_STATUSES)[number]

export interface RefRange {
  readonly fromRef: number
  readonly toRef: number
}

/**
 * The next `count` references of a kind, after the highest one handed out (`highestToRef`: the highest block's last
 * reference, null when none). Throws a RangeError for a count out of 1..MAX_BLOCK_SIZE or past the counter's end.
 */
export function nextRange(highestToRef: number | null, count: number): RefRange {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BLOCK_SIZE) throw new RangeError(`a block holds 1 to ${MAX_BLOCK_SIZE} numbers, not ${String(count)}`)
  const fromRef = (highestToRef ?? 0) + 1
  const toRef = fromRef + count - 1
  if (toRef > MAX_NUMBER) throw new RangeError('this kind of scan id has used up its numbers')
  return { fromRef, toRef }
}

export const blockSize = (block: RefRange): number => block.toRef - block.fromRef + 1

/** The printed scan ids of a range, in order: `HD-7K-000001-X` … */
export function scanCodes(tenantId: string, kind: ScanIdKind, range: RefRange): string[] {
  const tag = tenantTag(tenantId)
  return Array.from({ length: blockSize(range) }, (_, index) => formatScanId({ type: SCAN_TYPE_OF[kind], tenantTag: tag, ref: range.fromRef + index }))
}

// ---- a number a tablet used ------------------------------------------------------------------------------------------------

export const BLOCK_USE_REFUSALS = ['NOT_A_CODE', 'OTHER_FACTORY', 'WRONG_KIND', 'NOT_RESERVED', 'BLOCK_CLOSED', 'USED_TWICE', 'ALREADY_USED'] as const
export type BlockUseRefusalCode = (typeof BLOCK_USE_REFUSALS)[number]

/** Why a number a tablet used is refused: a code, the words for the person at the tablet, and the one fix. */
export interface BlockUseRefusal {
  readonly code: BlockUseRefusalCode
  /** The code as sent. */
  readonly scanned: string
  readonly message: string
  readonly fix: string
}

/** A device block as the check needs it. */
export interface DeviceBlock extends RefRange {
  readonly id: string
  readonly status: BlockStatus
}

/** The numbers of one kind a tablet used in one request, checked: each one's block, or why it is refused. */
export type BlockUseCheck =
  | { readonly ok: true; readonly uses: readonly { readonly code: string; readonly ref: number; readonly blockId: string }[] }
  | { readonly ok: false; readonly refusals: readonly (BlockUseRefusal & { readonly index: number })[] }

export interface BlockUseFacts {
  readonly tenantId: string
  readonly kind: ScanIdKind
  /** The codes as the tablet sent them (scanned, typed, or printed by it). */
  readonly codes: readonly string[]
  /** EVERY block of this kind reserved for the tablet (open and closed). */
  readonly blocks: readonly DeviceBlock[]
  /** The canonical codes of these blocks already used, with when (for the words). */
  readonly used: ReadonlyMap<string, Date>
}

/**
 * Checks the numbers a tablet used against its own blocks: each code must be this tenant's, of this kind, inside one of
 * the tablet's blocks (another tablet's or an online one is NOT_RESERVED), in a block still open (BLOCK_CLOSED: the office
 * closed it, e.g. a lost tablet), named once in the request (USED_TWICE) and never used before (ALREADY_USED). All
 * refusals are listed, so the queue shows each one with its fix.
 */
export function checkBlockUses(facts: BlockUseFacts): BlockUseCheck {
  const words = SCAN_KIND_WORDS[facts.kind]
  const refusals: (BlockUseRefusal & { index: number })[] = []
  const uses: { code: string; ref: number; blockId: string }[] = []
  const seen = new Set<string>()
  const refuse = (index: number, code: BlockUseRefusalCode, scanned: string, message: string, fix: string) => refusals.push({ index, code, scanned, message, fix })
  facts.codes.forEach((scanned, index) => {
    const parsed = parseScanId(scanned)
    if (!parsed.ok) return refuse(index, 'NOT_A_CODE', String(scanned), `"${String(scanned)}" is not a ${words}: ${parsed.message}`, 'Print the label again from this tablet.')
    if (parsed.tenantTag !== tenantTag(facts.tenantId)) {
      return refuse(index, 'OTHER_FACTORY', scanned, `${parsed.text} belongs to another factory.`, 'Use a label printed in this factory.')
    }
    if (parsed.type !== SCAN_TYPE_OF[facts.kind]) {
      return refuse(index, 'WRONG_KIND', scanned, `${parsed.text} is a ${parsed.type.toLowerCase()} label, not a ${words}.`, `Print a ${words} from this tablet.`)
    }
    const block = facts.blocks.find((candidate) => parsed.ref >= candidate.fromRef && parsed.ref <= candidate.toRef)
    if (!block) {
      return refuse(index, 'NOT_RESERVED', scanned, `${parsed.text} is not a number this tablet was given: it cannot be used here.`, `Print a new ${words} from this tablet and put it on instead.`)
    }
    if (block.status !== 'ACTIVE') {
      return refuse(index, 'BLOCK_CLOSED', scanned, `${parsed.text} comes from a block of numbers the office closed.`, `Print a new ${words} from this tablet and put it on instead.`)
    }
    if (seen.has(parsed.text)) {
      return refuse(index, 'USED_TWICE', scanned, `${parsed.text} is named twice in this request.`, `Give each item its own ${words}.`)
    }
    seen.add(parsed.text)
    const usedAt = facts.used.get(parsed.text)
    if (usedAt) {
      return refuse(index, 'ALREADY_USED', scanned, `${parsed.text} was used already (${usedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC).`, `Print a new ${words} from this tablet and put it on instead.`)
    }
    uses.push({ code: parsed.text, ref: parsed.ref, blockId: block.id })
  })
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, uses }
}

// ---- top-up --------------------------------------------------------------------------------------------------------------

/** One of a tablet's open blocks of a kind, with how many of its numbers the server saw used. */
export interface BlockCount extends RefRange {
  readonly used: number
}

export interface TopUp {
  /** Numbers left, as the decision counted them. */
  readonly remaining: number
  /** The size of the block to reserve now, or null when the tablet has enough. */
  readonly reserve: number | null
}

/**
 * Whether a tablet gets a new block of a kind: when fewer than LOW_WATER numbers are left over its open blocks, and it
 * holds fewer than MAX_LIVE_BLOCKS blocks with numbers left. The tablet may say how many it has left itself (`claimed`):
 * it knows the labels it printed and has not sent yet; the lower of its count and the server's counts.
 */
export function topUpFor(kind: ScanIdKind, open: readonly BlockCount[], claimed?: number): TopUp {
  const left = open.map((block) => Math.max(0, blockSize(block) - block.used))
  const server = left.reduce((sum, value) => sum + value, 0)
  const remaining = claimed === undefined ? server : Math.max(0, Math.min(server, claimed))
  const live = left.filter((value) => value > 0).length
  return { remaining, reserve: remaining < LOW_WATER[kind] && live < MAX_LIVE_BLOCKS ? DEVICE_BLOCK_SIZE[kind] : null }
}
