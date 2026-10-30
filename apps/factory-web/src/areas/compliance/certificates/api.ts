import { z } from 'zod'
import { GATE_REASON_CODES } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { fileSchema, presignedSchema, type ApiFile, type Presigned } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call the certificate register (SCR-050) and the certificate record (SCR-051) make, each answer checked against a
 * local copy of the API's contract (apps/factory-api modules/compliance/certificates/contract.ts: the register has no
 * factory-domain contract of its own). Unknown fields are ignored, so a new API field never breaks a page. No money.
 * Every write sends the version it was made on (COL-078) and an idempotency key; a 409 reads the record again.
 */

const enc = encodeURIComponent
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const path = (certificateId: string) => `/compliance/certificates/${enc(certificateId)}`

export const certificateStatus = z.enum(CERTIFICATE_STATUSES)
export type CertificateStatus = z.infer<typeof certificateStatus>

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const coverageSchema = z.object({
  id: z.string(),
  certificateId: z.string(),
  styleId: z.string().nullable(),
  itemId: z.string().nullable(),
  style: ref.nullable(),
  item: ref.nullable(),
  /** Empty: every colourway of the style. */
  colourwayIds: z.array(z.string()),
  /** Empty: the style's whole size range. */
  sizes: z.array(z.string()),
  allowsMadeToMeasure: z.boolean(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Coverage = z.infer<typeof coverageSchema>

export const certificateSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  holderPartyId: z.string().nullable(),
  standard: z.string(),
  ppeClass: z.string().nullable(),
  number: z.string(),
  notifiedBodyName: z.string(),
  notifiedBodyNumber: z.string(),
  modelReference: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string(),
  status: certificateStatus,
  statusReason: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  note: z.string().nullable(),
  /** Days from today to the last valid day: 0 on that day, negative once past it. */
  daysToExpiry: z.number().int(),
  nextStatuses: z.array(certificateStatus),
  coverageCount: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Certificate = z.infer<typeof certificateSchema>

export const certificateDetailSchema = certificateSchema.extend({ coverage: z.array(coverageSchema), hasPdf: z.boolean() })
export type CertificateDetail = z.infer<typeof certificateDetailSchema>

const one = z.object({ certificate: certificateDetailSchema })

// ---- the register (SCR-050) ---------------------------------------------------------------------------------------------

/** The API answers at most this many certificates in one read (no cursor). */
export const REGISTER_MAX = 500

const register = z.object({ certificates: z.array(certificateSchema), today: z.string() })
export type Register = z.infer<typeof register>

/** `GET /compliance/certificates`: the whole register the person may see (≤ 500, by last valid day), and today's date. */
export function listCertificates(api: ApiClient, signal?: AbortSignal): Promise<Register> {
  return api.get('/compliance/certificates', { schema: register, signal })
}

export function getCertificate(api: ApiClient, certificateId: string, signal?: AbortSignal): Promise<CertificateDetail> {
  return api.get(path(certificateId), { schema: one, signal }).then((answer) => answer.certificate)
}

export interface CertificateInput {
  companyId: string | null
  holderPartyId: string | null
  standard: string
  ppeClass: string | null
  number: string
  notifiedBodyName: string
  notifiedBodyNumber: string
  modelReference: string | null
  validFrom: string
  validTo: string
  note: string | null
}

export function createCertificate(api: ApiClient, input: CertificateInput): Promise<CertificateDetail> {
  return api.post('/compliance/certificates', { body: input, schema: one, ...key() }).then((answer) => answer.certificate)
}

/** A draft's fields (only a draft is edited). */
export function updateCertificate(api: ApiClient, certificate: Pick<Certificate, 'id' | 'version'>, input: CertificateInput): Promise<CertificateDetail> {
  return api.request('PATCH', path(certificate.id), { body: { ...input, version: certificate.version }, schema: one, ...key() }).then((answer) => answer.certificate)
}

export type StatusMove = 'issue' | 'suspend' | 'withdraw' | 'reinstate'

/** Register a draft (VALID), suspend, withdraw (final) or reinstate a suspended one: one move with the version read. */
export function moveCertificate(api: ApiClient, certificate: Pick<Certificate, 'id' | 'version'>, move: StatusMove, reason: string | null): Promise<CertificateDetail> {
  // Suspend and withdraw need the notified body's words (the dialog holds the move without them); reinstate may say why.
  const body = move === 'issue' ? { version: certificate.version } : { version: certificate.version, reason: reason?.trim() || null }
  return api.post(`${path(certificate.id)}/${move}`, { body, schema: one, ...key() }).then((answer) => answer.certificate)
}

export interface CoverageInput {
  styleId?: string
  itemId?: string
  colourwayIds: string[]
  sizes: string[]
  allowsMadeToMeasure: boolean
  note: string | null
}

const added = z.object({ coverage: coverageSchema, certificate: certificateDetailSchema })

export function addCoverage(api: ApiClient, certificate: Pick<Certificate, 'id' | 'version'>, input: CoverageInput): Promise<CertificateDetail> {
  return api.post(`${path(certificate.id)}/coverage`, { body: { ...input, version: certificate.version }, schema: added, ...key() }).then((answer) => answer.certificate)
}

/** End a coverage (archived, never deleted). */
export function archiveCoverage(api: ApiClient, certificateId: string, coverage: Pick<Coverage, 'id' | 'version'>, reason: string | null): Promise<Coverage> {
  return api
    .post(`${path(certificateId)}/coverage/${enc(coverage.id)}/archive`, { body: { version: coverage.version, reason: reason?.trim() || null }, schema: z.object({ coverage: coverageSchema }), ...key() })
    .then((answer) => answer.coverage)
}

// ---- the certificate gate (Check a garment, the lapse check) -----------------------------------------------------------

const gateCertificate = z.object({
  id: z.string(),
  number: z.string(),
  standard: z.string(),
  ppeClass: z.string().nullable(),
  notifiedBodyName: z.string(),
  notifiedBodyNumber: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
})

export const gateReasonCode = z.enum(GATE_REASON_CODES)
export type GateReasonCode = z.infer<typeof gateReasonCode>

export const gateResultSchema = z.object({
  allowed: z.boolean(),
  outcome: z.enum(['covered', 'not_required', 'refused']),
  route: z.enum(['SIZE', 'MADE_TO_MEASURE']),
  date: z.string(),
  styleId: z.string(),
  colourwayId: z.string(),
  size: z.string().nullable(),
  certificate: gateCertificate.nullable(),
  coverageId: z.string().nullable(),
  message: z.string().nullable(),
  reasons: z.array(z.object({ code: gateReasonCode, message: z.string(), certificateId: z.string().optional(), point: z.string().optional() })),
})
export type GateResult = z.infer<typeof gateResultSchema>

export interface GateQuestion {
  styleId: string
  colourwayId: string
  size: string
  date: string
}

/** `POST /compliance/certificates/gate`: may this garment be labelled, released and shipped on that day, and why. */
export function checkGarment(api: ApiClient, question: GateQuestion): Promise<GateResult> {
  return api.post('/compliance/certificates/gate', { body: question, schema: gateResultSchema })
}

// ---- what the dialogs pick from ----------------------------------------------------------------------------------------

const styleRow = z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable() })
export type StyleOption = z.infer<typeof styleRow>

/** `GET /product/styles` (product.styles.view): the open styles matching the words. */
export function searchStyles(api: ApiClient, q: string, signal?: AbortSignal): Promise<StyleOption[]> {
  return api
    .get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 20 }, schema: z.object({ styles: z.array(styleRow) }), signal })
    .then((answer) => answer.styles)
}

const styleFacts = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  companyId: z.string().nullable(),
  sizes: z.array(z.string()),
  mtmAllowed: z.boolean(),
  ppeCategory: z.string(),
  ppeStandard: z.string().nullable(),
  ppeClass: z.string().nullable(),
  colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']), offeredSizes: z.array(z.string()) })),
})
export type StyleFacts = z.infer<typeof styleFacts>

/** `GET /product/styles/:id`: the style's colourways and size range, for the coverage grid and the dialogs. */
export function getStyleFacts(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleFacts> {
  return api.get(`/product/styles/${enc(styleId)}`, { schema: z.object({ style: styleFacts }), signal }).then((answer) => answer.style)
}

const materialRow = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), isPpeComponent: z.boolean() })
export type MaterialOption = z.infer<typeof materialRow>

/** `GET /product/materials` (product.materials.view): a protector or a material a certificate covers. */
export function searchMaterials(api: ApiClient, q: string, signal?: AbortSignal): Promise<MaterialOption[]> {
  return api
    .get('/product/materials', { query: { q: q.trim() || undefined, limit: 20 }, schema: z.object({ materials: z.array(materialRow) }), signal })
    .then((answer) => answer.materials)
}

const brandRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type BrandOption = z.infer<typeof brandRow>

/** `GET /parties?role=BRAND` (parties.view): a brand that holds a private-label certificate. */
export function listBrands(api: ApiClient): Promise<BrandOption[]> {
  return api.get('/parties', { query: { role: 'BRAND', status: 'ACTIVE', limit: 200 }, schema: z.object({ parties: z.array(brandRow) }) }).then((answer) => answer.parties)
}

// ---- the certificate's PDF ---------------------------------------------------------------------------------------------

export interface PickedFile {
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly bytes: ArrayBuffer
}

export async function pickedFile(file: File): Promise<PickedFile> {
  return { name: file.name, contentType: file.type || 'application/pdf', size: file.size, bytes: await file.arrayBuffer() }
}

const announced = z.object({ file: z.object({ id: z.string() }).passthrough(), upload: presignedSchema })

/**
 * The notified body's PDF on the certificate (its own route, never the generic POST /files): announce with the SHA-256
 * worked out here, send the bytes straight to the store with the presigned request, then confirm. A registered
 * certificate keeps it ten years after its last valid day.
 */
export async function uploadPdf(api: ApiClient, certificateId: string, file: PickedFile): Promise<CertificateDetail> {
  const sha256 = await sha256Hex(file.bytes)
  const answer = await api.post(`${path(certificateId)}/pdf`, { body: { originalName: file.name, contentType: file.contentType, sizeBytes: file.size, sha256 }, schema: announced, ...key() })
  await putToStore(answer.upload as Presigned, file.bytes)
  const done = await api.post(`${path(certificateId)}/pdf/${enc(answer.file.id)}/complete`, { body: {}, schema: z.object({ certificate: certificateDetailSchema }), ...key() })
  return done.certificate
}

export type CertificateFile = ApiFile

/** `GET /files` of the certificate (files.read): its PDFs (kind CERTIFICATE) and any other paper filed on it. */
export function listCertificateFiles(api: ApiClient, certificateId: string, signal?: AbortSignal): Promise<CertificateFile[]> {
  return api.get('/files', { query: { recordType: 'Certificate', recordId: certificateId }, schema: z.object({ files: z.array(fileSchema) }), signal }).then((answer) => answer.files)
}

/** A 60-second download address of a file, as this browser reaches it. */
export async function downloadAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${enc(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}
