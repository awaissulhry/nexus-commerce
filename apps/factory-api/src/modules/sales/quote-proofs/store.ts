import type { Prisma } from '@nexus/factory-db'
import { PROOF_RECORD_TYPE, proofSeries, proofShapeOf, proofStateOf, type ProofFileFacts } from '@nexus/factory-domain/sales/quote-proofs/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTools } from '../../../core/command'
import type { Reader } from '../quotes/store'

/**
 * The proofs' rows (B-W2b-165): every StoredFile of record type `QuoteVersion` is a proof of that version (owned.ts keeps
 * the generic files routes off them), each version of a proof a row of its series (B-W2b-160). Reads take the caller's
 * client or the command's transaction; nothing here writes.
 */

export const PROOF_COLUMNS = {
  id: true,
  companyId: true,
  recordId: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  status: true,
  visibility: true,
  partyId: true,
  retainUntil: true,
  quarantineReason: true,
  seriesId: true,
  versionNo: true,
  supersededAt: true,
  sourceFileId: true,
  storeAccountId: true,
  storageKey: true,
  legalHold: true,
  availableAt: true,
  createdAt: true,
  createdById: true,
  version: true,
} as const satisfies Prisma.StoredFileSelect
export type ProofRow = Prisma.StoredFileGetPayload<{ select: typeof PROOF_COLUMNS }>

/** Every proof file of these versions (every status), first made first. */
export async function proofFilesOf(db: Reader, versionIds: readonly string[]): Promise<ProofRow[]> {
  if (versionIds.length === 0) return []
  return db.storedFile.findMany({ where: { recordType: PROOF_RECORD_TYPE, recordId: { in: [...versionIds] } }, select: PROOF_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

/** The rules' view of a row. */
export const factsOf = (row: ProofRow): ProofFileFacts & { readonly row: ProofRow } => ({
  id: row.id,
  seriesId: row.seriesId,
  versionNo: row.versionNo,
  originalName: row.originalName,
  status: row.status,
  supersededAt: row.supersededAt,
  quarantineReason: row.quarantineReason,
  row,
})

/** A proof as the office reads it: its newest version and whether the customer is shown it. */
export function proofView(newest: ProofRow, current: ProofRow | null, people: ReadonlyMap<string, string>) {
  return {
    fileId: newest.id,
    seriesId: newest.seriesId ?? newest.id,
    name: newest.originalName,
    contentType: newest.contentType,
    shape: proofShapeOf(newest.contentType),
    sizeBytes: newest.sizeBytes,
    sha256: newest.sha256,
    versionNo: newest.versionNo,
    state: proofStateOf(newest),
    /** The version the customer would see (null while the first one is not ready). */
    currentFileId: current?.id ?? null,
    /** Shared with the customer's portal and links: the send froze it. */
    sharedWithCustomer: current !== null && current.visibility.includes('LINK'),
    /** Copied from an earlier quote version's proof (carried over). */
    sourceFileId: newest.sourceFileId,
    addedAt: toUtcIso(newest.createdAt),
    addedBy: newest.createdById ? (people.get(newest.createdById) ?? null) : null,
  }
}
export type ProofView = ReturnType<typeof proofView>

/** The proofs of one version, one per series, as proofView says them. */
export function proofsOf(rows: readonly ProofRow[], people: ReadonlyMap<string, string>): ProofView[] {
  return proofSeries(rows.map(factsOf)).map(({ newest, current }) => proofView(newest.row, current?.row ?? null, people))
}

/**
 * The version's row, locked for the rest of the command (FOR UPDATE): a send updates the same row, so a proof's change
 * and a send of its version never cross — whichever commits second sees the other.
 */
export async function lockVersionRow(tx: CommandTools['tx'], versionId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "QuoteVersion" WHERE "id" = ${versionId}::uuid FOR UPDATE`
}
