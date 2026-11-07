import type { Issue } from '@nexus/factory-domain/core/errors'
import { KIND_RULES, normaliseContentType, type FileKind } from '../rules'

/**
 * Large uploads in parts (COL-052 "large pattern uploads"; B-W2b-160), pure: how big a file sent in parts may be, which
 * types it may hold, how it is cut into parts and which parts are still missing. A tech pack, a pattern plot or a phone's
 * video of a sample is too big for one 5-minute PUT over a slow line; in parts, a dropped line costs one part, not the file.
 *
 *   parts      every part but the last is `partSizeBytes` (5 to 64 MiB, default 8: the store's minimum is 5), the last
 *              one the rest; the parts are numbered from 1
 *   limits     the kind's own large limit and the tenant's (TENANT_LARGE_FILE_MAX_BYTES; the API's constant: no tenant
 *              setting yet), whichever is smaller; never a fiscal archive file (its documents are small and made by us)
 *   types      the kind's own types; a DOCUMENT or an ATTACHMENT may also be a CAD pattern (DXF, HP-GL plot)
 *   session    open for seven days at most (R2 gives an unfinished upload up after that); at most
 *              TENANT_OPEN_UPLOADS_MAX open at once per tenant
 */

const MIB = 1_048_576

export const PART_SIZE_MIN = 5 * MIB
export const PART_SIZE_MAX = 64 * MIB
export const PART_SIZE_DEFAULT = 8 * MIB
/** A part's presigned PUT lives 15 minutes (a slow phone line sends 8 MiB well within it). */
export const PART_URL_SECONDS = 900
/** How many parts one request may ask a presigned PUT for. */
export const PARTS_PER_REQUEST = 50
export const SESSION_DAYS = 7
/** The tenant's limit for one file sent in parts (no tenant setting yet: see the step's notes). */
export const TENANT_LARGE_FILE_MAX_BYTES = 200 * MIB
/** How many uploads in parts a tenant may have open at once. */
export const TENANT_OPEN_UPLOADS_MAX = 50

/** Each kind's largest file in parts; a fiscal archive file is never sent in parts. */
export const LARGE_KIND_MAX_BYTES: Readonly<Partial<Record<FileKind, number>>> = Object.freeze({
  DOCUMENT: 200 * MIB,
  ATTACHMENT: 200 * MIB,
  PHOTO: 50 * MIB,
  CERTIFICATE: 100 * MIB,
  AUDIO: 100 * MIB,
})

/** CAD pattern files (DXF, the AAMA/ASTM exchange; HP-GL plot files) a large DOCUMENT or ATTACHMENT may be. */
export const PATTERN_TYPES: readonly string[] = Object.freeze(['application/dxf', 'application/vnd.hp-hpgl'])

const SHA256 = /^[0-9a-f]{64}$/

/** The types a file of this kind may be when sent in parts. */
export function largeTypesOf(kind: FileKind): readonly string[] {
  const own = KIND_RULES[kind].contentTypes
  return kind === 'DOCUMENT' || kind === 'ATTACHMENT' ? [...own, ...PATTERN_TYPES] : own
}

/** The largest file of this kind in parts (0: none). */
export const largeMaxOf = (kind: FileKind): number => Math.min(LARGE_KIND_MAX_BYTES[kind] ?? 0, TENANT_LARGE_FILE_MAX_BYTES)

/** The problems of a large upload as announced (empty when it may start). */
export function largeUploadProblems(input: { kind: FileKind; contentType: string; sizeBytes: number; sha256: string; partSizeBytes: number }): Issue[] {
  const problems: Issue[] = []
  const max = largeMaxOf(input.kind)
  if (max === 0) return [{ path: 'body/kind', message: `A ${input.kind} file is not sent in parts.` }]
  const types = largeTypesOf(input.kind)
  if (!types.includes(normaliseContentType(input.contentType))) problems.push({ path: 'body/contentType', message: `A ${input.kind} file may be ${types.join(', ')}.` })
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > max) {
    problems.push({ path: 'body/sizeBytes', message: `A ${input.kind} file sent in parts holds 1 byte to ${max / MIB} MiB.` })
  }
  if (!SHA256.test(input.sha256)) problems.push({ path: 'body/sha256', message: 'Expected the SHA-256 of the whole file, 64 lower-case hex digits.' })
  if (!Number.isSafeInteger(input.partSizeBytes) || input.partSizeBytes < PART_SIZE_MIN || input.partSizeBytes > PART_SIZE_MAX) {
    problems.push({ path: 'body/partSizeBytes', message: `A part holds ${PART_SIZE_MIN / MIB} to ${PART_SIZE_MAX / MIB} MiB.` })
  }
  return problems
}

export const partCountOf = (sizeBytes: number, partSizeBytes: number): number => Math.ceil(sizeBytes / partSizeBytes)

/** The size part `partNumber` must have: the part size, the last one the rest. */
export function partSizeOf(partNumber: number, sizeBytes: number, partSizeBytes: number): number {
  const count = partCountOf(sizeBytes, partSizeBytes)
  return partNumber < count ? partSizeBytes : sizeBytes - (count - 1) * partSizeBytes
}

/** The part numbers not done yet, in order. */
export function missingParts(done: readonly { readonly partNumber: number }[], count: number): number[] {
  const have = new Set(done.map((part) => part.partNumber))
  return Array.from({ length: count }, (_, index) => index + 1).filter((number) => !have.has(number))
}

/** A part done, as FileUploadSession.partsDone holds it. */
export interface PartDone {
  readonly partNumber: number
  readonly etag: string
  readonly sizeBytes: number
}

/** The parts done read back from the JSON column (anything else is ignored: the database checks the shape). */
export function partsDoneOf(value: unknown): PartDone[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((part) =>
    part && typeof part === 'object' && typeof part.partNumber === 'number' && typeof part.etag === 'string' && typeof part.sizeBytes === 'number'
      ? [{ partNumber: part.partNumber, etag: part.etag, sizeBytes: part.sizeBytes }]
      : [],
  )
}
