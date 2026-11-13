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
  // A notice version's PDF per language and the signed DPIA (platform/privacy, B-W1-36): every kind; the notice's PDF
  // carries the fingerprint acknowledgements store, the DPIA's opens the floor's gate.
  PrivacyNotice: { route: 'POST /privacy/notices/:noticeId/texts/:locale/pdf, then POST …/pdf/:fileId/complete' },
  PrivacyDpia: { route: 'POST /privacy/dpia/:dpiaId/pdf, then POST …/pdf/:fileId/complete' },
  // A lot's chromium VI reports and supplier documents (modules/quality/lab): CERTIFICATE files only, the evidence its
  // release rests on; photos and attachments of the lot stay open to the generic routes.
  Lot: { kinds: ['CERTIFICATE'], route: 'POST /quality/lots/:lotId/results/report then POST …/results, or POST /quality/lots/:lotId/documents/upload then POST …/documents' },
  // A company's existing chromium VI reports for its opening stock (modules/inventory/opening, B-W1-35; record id = the
  // company's id): CERTIFICATE files only, the evidence the imported lots' results rest on.
  OpeningStock: { kinds: ['CERTIFICATE'], route: 'POST /inventory/opening/reports, then POST /inventory/opening/reports/:fileId/complete' },
  // The notified body's answer to a change of the approved type (modules/compliance/type-changes, B-W2a-66): every kind; the
  // decision APPROVED or REFUSED rests on it.
  TypeChangeReview: { route: 'POST /compliance/type-changes/:reviewId/answer-file, then POST …/answer-file/:fileId/complete' },
  // B-W2b-14: a supplier claim's photos of what is wrong (modules/purchasing/claims): PHOTO files only, of category
  // CLAIM_PHOTO; the claim letter is made by the API; attachments of the claim's thread stay open.
  SupplierClaim: { kinds: ['PHOTO'], route: 'POST /purchasing/claims/:claimId/photos, then POST …/photos/:fileId/complete' },
  // B-W2b-48: a closed month's LUL calendar (modules/people/close): every kind; only ever made by the API at the close.
  AttendanceMonthClose: { route: 'POST /people/month-close, or POST /people/month-close/:closeId/seal for a calendar not sealed yet (made by the API, never uploaded)' },
  // B-W2b-54: a payroll export's data file and summary (modules/people/payroll): every kind; only ever made by the API.
  PayrollExport: { route: 'POST /people/payroll/exports (made by the API, never uploaded)' },
  // B-W2b-62, B-W2b-68: an approved worker statement's PDF (modules/people/earnings, modules/people/myday): every kind; only ever made by the API.
  WorkerStatement: { route: 'POST /people/statements/:statementId/pdf, or POST /people/myday/statements/:statementId/print (made by the API, never uploaded)' },
  // B-W2b-125: an incident's photos (office, or the tablet that reported it) and INAIL's receipt of a filing (modules/safety/incidents):
  // every kind; office only (a photo may show an injury or a face, the receipt names the injured person; GDPR art. 9).
  Incident: { route: 'POST /safety/incidents/:incidentId/photos (or POST /safety/floor/incidents/:incidentId/photos), then POST …/photos/:fileId/complete' },
  InailFiling: { route: 'POST /safety/incidents/:incidentId/filings/:filingId/receipt, then POST …/receipt/:fileId/complete' },
  // B-W2b-135: the doctor's written fitness judgement (modules/safety/health): every kind, office only (GDPR art. 9); a visit keeps no
  // file (its judgement's copy is the judgement's).
  FitnessJudgement: { route: 'POST /safety/health/judgements/:judgementId/copy, then POST …/copy/:fileId/complete' },
  HealthVisit: { route: 'none: a visit keeps no file (the doctor’s copy is its judgement’s: POST /safety/health/judgements/:judgementId/copy)' },
  // B-W2b-161: a company's logos (platform/branding; record id = the company's id): PHOTO files only, PNG or JPEG of at most
  // 1 MiB checked by their first bytes; the public logo route serves only the one the branding names.
  CompanyBranding: { kinds: ['PHOTO'], route: 'POST /branding/:companyId/logo, then POST …/logo/:fileId/complete' },
  // B-W2b-165 (SAL-199): a quote version's proofs (modules/sales/quote-proofs): every kind; added, given a new version and
  // removed only while the version is unsent, shared with the customer and kept by the send.
  QuoteVersion: { route: 'POST /sales/quotes/:quoteId/proofs (or …/proofs/:fileId/versions), then POST …/proofs/:fileId/complete' },
  // B-W2b-171 (SAL-286): a rider's body photos (front, side, back) sent with measurements by link (modules/sales/measure-link):
  // PHOTO files only, after the privacy notice, kept until their retention ends (GDPR: body photos are personal data).
  MeasurementProfile: { kinds: ['PHOTO'], route: 'POST /link/measure/photos, then POST /link/measure/photos/:fileId/complete (the rider\'s MEASUREMENTS link)' },
  // B-W2b-224 (PRD-062): a point of measure's how-to picture (modules/product/measures): PHOTO files only; the database takes
  // only an AVAILABLE PHOTO of the point as its picture, set by the completion.
  PointOfMeasure: { kinds: ['PHOTO'], route: 'POST /product/points-of-measure/:pomId/picture, then POST …/picture/:fileId/complete' },
  // B-W2b-278 (FU4:02; B-W2b-251's technical files, modules/compliance/techfiles): an evidence pack's PDF and ZIP, only ever made
  // by the API when the pack is built; every kind.
  EvidencePack: { route: 'POST /compliance/techfiles/:fileId/packs (the pack\'s PDF and ZIP are made by the API, never uploaded)' },
  // B-W2b-278 (FU4:02): a production-control test's lab report, kept ten years with the recorded result (QHS-110); every kind.
  ProductionControlTest: { route: 'POST /compliance/production-tests/:testId/report, then POST …/report/:fileId/complete' },
  // B-W2b-288 (FU2:01): the PPE consultant's file of a PPE text approval (modules/compliance/ppe-texts): every kind; the
  // approval rests on it (GATE-PPE-TEXTS), announced before the approval is recorded with its id.
  PpeTextApproval: { route: 'POST /compliance/ppe-texts/evidence, then POST /compliance/ppe-texts' },
  // B-W2b-351: a product-safety report's photos (modules/sales/safety-reports): every kind, office only (a photo may show an injury;
  // GDPR art. 9); from the office, and after the send from the public DoC page or the portal with the report's own rights.
  ProductSafetyReport: { route: 'POST /sales/safety-reports/:reportId/photos (or POST /public/safety-reports/photos, POST /portal/safety-reports/:reportId/photos), then POST …/:fileId/complete' },
})

/**
 * Record types whose files are READ only through their module (B-W2b-48): the file names people and their hours, so files.read
 * is not enough: its module asks its own permission and the legal gate, and records each opening. The generic routes do not
 * find these files; the module calls downloadFile with `{ viaModule: true }`.
 */
export const MODULE_READ_FILES: Readonly<Record<string, string>> = Object.freeze({
  AttendanceMonthClose: 'POST /people/month-close/:closeId/lul/open',
  // B-W2b-54: everyone's hours and pay by employee code.
  PayrollExport: 'POST /people/payroll/exports/:exportId/files/:fileId/open',
  // B-W2b-62, B-W2b-68: one person's pay: the office with people.earnings.records and the pay grain, each opening recorded; the
  // worker's own through My day; files.read never reaches it.
  WorkerStatement: 'POST /people/statements/:statementId/pdf, or GET /people/myday/statements/:statementId/pdf',
  // B-W2b-125: an incident's photos (safety.incidents.view) and INAIL's receipt (safety.incidents.people, each opening a view in the
  // protected view log); files.read never reaches them.
  Incident: 'GET /safety/incidents/:incidentId/photos/:fileId/download',
  InailFiling: 'POST /safety/incidents/:incidentId/filings/:filingId/receipt/:fileId/open',
  // B-W2b-135: a judgement's copy (safety.health.view, each opening a COPY view in the protected view log); files.read never reaches it.
  FitnessJudgement: 'POST /safety/health/judgements/:judgementId/copy/:fileId/open',
  HealthVisit: 'none: a visit keeps no file',
  // B-W2b-171: a rider's body photos (sales.measurements.view, each opening recorded); files.read never reaches them.
  MeasurementProfile: 'POST /sales/measurement-profiles/:profileId/photos/:fileId/open',
  // B-W2b-351: a product-safety report's photos (sales.safety.view, each opening recorded on the report); files.read never reaches them.
  ProductSafetyReport: 'POST /sales/safety-reports/:reportId/photos/:fileId/open',
})

export const readsThroughModule = (recordType: string): boolean => Object.hasOwn(MODULE_READ_FILES, recordType)

/** How a caller of requestUpload / completeUpload reaches them: the generic files routes, or a module's own route. */
export interface UploadPath {
  /** Set only by a module whose record type is in MODULE_OWNED_FILES, from its own route. */
  readonly viaModule?: boolean
  /** B-W2b-47 (COL-017): this PHOTO may be a short clip (FLOOR_CLIP_TYPES); only the floor notes' route says so. */
  readonly clip?: boolean
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
