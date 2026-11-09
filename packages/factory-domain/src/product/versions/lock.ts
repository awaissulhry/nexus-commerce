/**
 * Released data is locked (B-W2b-220; feature PRD-167 "a released version is read-only; editing starts a new draft
 * version"), pure: the parts of a style revision, and the words every write path of a part says when the revision is not a
 * DRAFT (a 409 before the database is asked). The database keeps its own guard for every login (W1's
 * …_product_guards `factory_style_revision_part_guard` on each part, `factory_style_revision_guard` on the revision row, as
 * B-W2b-205 and B-W2b-212 redefined it); `databaseLockWords` says its refusal in the same words, should a write reach it.
 */

/** The tables that are parts of a revision (each under the part guard), and what a person calls them. */
export const REVISION_PARTS = {
  BomLine: 'BOM',
  BomLineSize: 'BOM quantities per size',
  BomLineColour: 'BOM colour grid',
  BomLineAlternate: 'BOM alternates',
  RoutingOperation: 'routing',
  RoutingOperationSizeTime: 'minutes per size',
  OperationMachineSetting: 'machine settings',
  PatternPiece: 'pattern pieces',
  MeasurementSpec: 'measurement spec',
  MeasurementSpecValue: 'measurement spec',
  ProtectorPlacement: 'protector placement',
  StyleRevisionFile: 'pattern files',
  StyleImage: 'pictures',
  StyleRevision: 'revision',
} as const
export type RevisionPart = keyof typeof REVISION_PARTS

export const isRevisionPart = (value: string): value is RevisionPart => Object.hasOwn(REVISION_PARTS, value)

export interface LockFacts {
  readonly revision: number
  readonly status: string
}

/** Is the revision's data locked (anything but a DRAFT)? */
export const isLocked = (revision: Pick<LockFacts, 'status'>): boolean => revision.status !== 'DRAFT'

/**
 * Why this part of the revision cannot change now, or null (a DRAFT). Released: "Revision 2 is released and locked: its
 * BOM cannot change. Start a new revision (a copy of it, as a draft) to change it." Obsolete: kept as it was.
 */
export function lockedRefusal(revision: LockFacts, part: RevisionPart = 'StyleRevision'): string | null {
  if (!isLocked(revision)) return null
  const what = part === 'StyleRevision' ? 'it' : `its ${REVISION_PARTS[part]}`
  if (revision.status === 'RELEASED') return `Revision ${revision.revision} is released and locked: ${what} cannot change. Start a new revision (a copy of it, as a draft) to change it.`
  if (revision.status === 'OBSOLETE') return `Revision ${revision.revision} is obsolete and kept as it was: ${what} cannot change. Start a new revision from the released one to change the spec.`
  return `Revision ${revision.revision} is ${revision.status.toLowerCase()}: ${what} cannot change.`
}

/** The issue path a lock refusal carries (`refusal/REVISION_LOCKED`), so a screen can say it in its own words. */
export const LOCKED_ISSUE = 'refusal/REVISION_LOCKED'

const PART_REFUSAL = /^product: revision ([0-9a-f-]{36}) is (RELEASED|OBSOLETE); its "([A-Za-z]+)" rows never change/
const ROW_REFUSAL = /^product: revision ([0-9a-f-]{36}) is (RELEASED|OBSOLETE); it never changes/

/**
 * The database's refusal of a write to a locked revision (W1's part guard: 'product: revision <id> is RELEASED; its
 * "BomLine" rows never change, a change is a new revision'; the revision guard: '… is RELEASED; it never changes, …'), in
 * the words above; null for any other message. `revisionNumber` names the revision when the caller knows it.
 */
export function databaseLockWords(message: string, revisionNumber?: number): { readonly revisionId: string; readonly message: string } | null {
  const part = PART_REFUSAL.exec(message)
  const row = part ? null : ROW_REFUSAL.exec(message)
  const match = part ?? row
  if (!match) return null
  const [, revisionId, status] = match
  const table = part ? part[3]! : 'StyleRevision'
  const words = lockedRefusal({ revision: revisionNumber ?? 0, status: status! }, isRevisionPart(table) ? table : 'StyleRevision')!
  return { revisionId: revisionId!, message: revisionNumber === undefined ? words.replace(/^Revision 0 /, 'This revision ') : words }
}
