import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { FileKind } from './rules'

/**
 * Record types whose files are written ONLY through their own module (B-W1-20). Such a module decides which of a
 * record's files is the one in force — the signed DoC's current version, the certificate's PDF that registering needs —
 * and attaches its own checks, permission, retention, audit and events to the upload. A file announced with the generic
 * POST /files, or confirmed with POST /files/:fileId/complete, would skip all of that and could still become "the" file.
 * So requestUpload and completeUpload refuse these record types (and kinds) with a 409 that names the module's route,
 * unless the module's own code calls them with `{ viaModule: true }`. Files the API makes itself (storeGeneratedFile)
 * are the calling module's business and are not affected. Add a record type here in the step that makes its upload
 * route (or with its generated files' step).
 */

export interface ModuleOwnedFiles {
  /** The kinds the module owns; none listed: every kind (another kind of file stays open to the generic routes). */
  readonly kinds?: readonly FileKind[]
  /** The module's route, for the refusal. */
  readonly route: string
}

export const MODULE_OWNED_FILES: Readonly<Record<string, ModuleOwnedFiles>> = Object.freeze({
  // The signed EU Declaration of Conformity and user information leaflet (modules/product/compliance): every kind.
  ComplianceDocument: { route: 'POST /product/styles/:styleId/compliance/documents, then POST …/documents/:documentId/files/:fileId/complete' },
  // The notified body's PDF (modules/compliance/certificates): CERTIFICATE files only; attachments of the certificate's
  // thread (test reports, mail) stay open to the generic routes.
  Certificate: { kinds: ['CERTIFICATE'], route: 'POST /compliance/certificates/:certificateId/pdf, then POST …/pdf/:fileId/complete' },
  // A parcel's carrier label files (modules/shipping/labels): only ever generated when the label is bought; every kind.
  Parcel: { route: 'POST /shipping/shipments/:shipmentId/labels (the carrier label is made by the API, never uploaded)' },
  // The DDT's legal PDF (modules/shipping/ddt): FISCAL_ARCHIVE files only, made at the issue or by a print of a missing
  // one; the first stored is the document. A scan of the signed delivery note (another kind) stays open.
  Ddt: { kinds: ['FISCAL_ARCHIVE'], route: 'POST /shipping/shipments/:shipmentId/ddt, or POST /shipping/ddts/:ddtId/pdf for a missing PDF (made by the API, never uploaded)' },
})

/** How a caller of requestUpload / completeUpload reaches them: the generic files routes, or a module's own route. */
export interface UploadPath {
  /** Set only by a module whose record type is in MODULE_OWNED_FILES, from its own route. */
  readonly viaModule?: boolean
}

/** The module that owns this record type's files of this kind, or null. */
export function ownerOf(recordType: string, kind: FileKind): ModuleOwnedFiles | null {
  const owned = Object.hasOwn(MODULE_OWNED_FILES, recordType) ? MODULE_OWNED_FILES[recordType]! : null
  return owned && (owned.kinds === undefined || owned.kinds.includes(kind)) ? owned : null
}

/** 409 when the generic routes reach a module's files. */
export function assertGenericPath(recordType: string, kind: FileKind, path: UploadPath): void {
  if (path.viaModule) return
  const owner = ownerOf(recordType, kind)
  if (owner) throw new ConflictError(`A ${kind} file of a ${recordType} is uploaded and confirmed only through its own route: ${owner.route}.`)
}
