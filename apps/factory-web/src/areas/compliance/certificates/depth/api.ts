import { z } from 'zod'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { CERTIFICATE_KINDS } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { LEVEL_FAMILIES } from '@nexus/factory-domain/compliance/certificates-depth/levels'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Every call of certificates in depth (B-W2b-255; SCR-050, SCR-051, SCR-291): the notified body directory, a certificate's
 * depth and its four writes, the suppliers a bought-in part's coverage may name. Each answer is checked against a local
 * copy of the API's contract (apps/factory-api modules/compliance/certificates-depth/contract.ts); unknown fields are
 * ignored. No money, no person's name. Every write sends the version it was made on and an idempotency key.
 */

const enc = encodeURIComponent
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const status = z.enum(CERTIFICATE_STATUSES)
const kind = z.enum(CERTIFICATE_KINDS)
const span = z.object({ years: z.number().int(), months: z.number().int(), days: z.number().int() })

export const scopeCheckSchema = z.object({ state: z.enum(['LISTED', 'NOT_LISTED', 'NO_SCOPES']), scope: z.string().nullable(), kind })
export type ScopeCheckView = z.infer<typeof scopeCheckSchema>

export const bodySchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  address: z.string(),
  country: z.string(),
  nandoUrl: z.string().nullable(),
  scopes: z.array(z.string()),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  clothing: scopeCheckSchema,
  certificates: z.number().int(),
  linked: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type NotifiedBody = z.infer<typeof bodySchema>

export const summarySchema = z.object({
  id: z.string(),
  number: z.string(),
  standard: z.string(),
  kind,
  ppeClass: z.string().nullable(),
  status,
  validFrom: z.string(),
  validTo: z.string(),
  companyId: z.string().nullable(),
  holderPartyId: z.string().nullable(),
  notifiedBodyNumber: z.string(),
})
export type CertificateSummary = z.infer<typeof summarySchema>

export const depthSchema = z.object({
  certificate: summarySchema.extend({ version: z.number().int(), notifiedBodyName: z.string(), registered: z.boolean() }),
  validity: z.object({ state: z.enum(['OK', 'TOO_LONG', 'ORDER', 'INCOMPLETE']), span: span.nullable(), latest: z.string().nullable(), over: span.nullable(), maxYears: z.number().int() }),
  body: z.object({
    typed: z.object({ name: z.string(), number: z.string() }),
    directory: bodySchema.nullable(),
    matching: z.array(bodySchema),
    scope: scopeCheckSchema.nullable(),
    others: z.array(summarySchema),
  }),
  levels: z.object({
    family: z.enum(LEVEL_FAMILIES).nullable(),
    properties: z.array(z.object({ key: z.string(), values: z.array(z.string()), required: z.boolean(), zone: z.boolean() })),
    values: z.record(z.string(), z.string()).nullable(),
    marking: z.string().nullable(),
    problems: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
  ownBrand: z.object({
    brandHeld: z.boolean(),
    base: summarySchema.nullable(),
    standing: z.object({ state: z.enum(['HOLDS', 'NOT_REGISTERED', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED', 'NOT_YET']), number: z.string(), validFrom: z.string(), validTo: z.string() }).nullable(),
    outlivesBaseDays: z.number().int(),
    sameStandard: z.boolean().nullable(),
    restingOnThis: z.array(summarySchema),
    candidates: z.array(summarySchema),
  }),
  boughtIn: z.array(
    z.object({
      coverageId: z.string(),
      version: z.number().int(),
      item: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
      supplierArticleCode: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  mayManage: z.boolean(),
  today: z.string(),
})
export type Depth = z.infer<typeof depthSchema>
export type BoughtInPart = Depth['boughtIn'][number]

const answer = z.object({ depth: depthSchema })
const certificatePath = (certificateId: string) => `/compliance/certificates/${enc(certificateId)}`

// ---- a certificate in depth -------------------------------------------------------------------------------------------

/** `GET /compliance/certificates/:id/depth`: the five-year check, the body, the levels, the own-brand base, the bought-in parts. */
export function getDepth(api: ApiClient, certificateId: string, signal?: AbortSignal): Promise<Depth> {
  return api.get(`${certificatePath(certificateId)}/depth`, { schema: answer, signal }).then((read) => read.depth)
}

type Versioned = { readonly id: string; readonly version: number }

/** Pick the body from the directory (a draft takes its number and name); null clears it (a draft only). */
export function setNotifiedBody(api: ApiClient, certificate: Versioned, notifiedBodyId: string | null): Promise<Depth> {
  return api.request('PUT', `${certificatePath(certificate.id)}/notified-body`, { body: { version: certificate.version, notifiedBodyId }, schema: answer, ...key() }).then((read) => read.depth)
}

/** The performance levels in the standard's vocabulary (null: none, a draft only). */
export function setLevels(api: ApiClient, certificate: Versioned, levels: Record<string, string> | null): Promise<Depth> {
  return api.request('PUT', `${certificatePath(certificate.id)}/levels`, { body: { version: certificate.version, levels }, schema: answer, ...key() }).then((read) => read.depth)
}

/** An own-brand certificate's base: the factory's certificate it rests on (null: none, a draft only). */
export function setBase(api: ApiClient, certificate: Versioned, baseCertificateId: string | null): Promise<Depth> {
  return api.request('PUT', `${certificatePath(certificate.id)}/base`, { body: { version: certificate.version, baseCertificateId }, schema: answer, ...key() }).then((read) => read.depth)
}

/** A bought-in part's supplier on its coverage (named once) and the supplier's article code; the coverage's version. */
export function setSupplier(api: ApiClient, certificateId: string, part: { readonly coverageId: string; readonly version: number }, supplierPartyId: string, supplierArticleCode: string | null): Promise<Depth> {
  return api
    .request('PUT', `${certificatePath(certificateId)}/coverage/${enc(part.coverageId)}/supplier`, { body: { version: part.version, supplierPartyId, supplierArticleCode }, schema: answer, ...key() })
    .then((read) => read.depth)
}

const supplierRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type SupplierOption = z.infer<typeof supplierRow>

/** `GET /parties?role=SUPPLIER` (parties.view): the suppliers a bought-in part is bought from. */
export function listSuppliers(api: ApiClient, signal?: AbortSignal): Promise<SupplierOption[]> {
  return api.get('/parties', { query: { role: 'SUPPLIER', status: 'ACTIVE', limit: 200 }, schema: z.object({ parties: z.array(supplierRow) }), signal }).then((read) => read.parties)
}

// ---- the directory ------------------------------------------------------------------------------------------------------

const directory = z.object({ bodies: z.array(bodySchema), mayManage: z.boolean(), asOf: z.string() })
export type Directory = z.infer<typeof directory>

/** `GET /compliance/notified-bodies`: the directory (active bodies by default; `ALL` adds the archived ones). */
export function listBodies(api: ApiClient, query: { status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; q?: string } = {}, signal?: AbortSignal): Promise<Directory> {
  return api.get('/compliance/notified-bodies', { query: { status: query.status, q: query.q?.trim() || undefined }, schema: directory, signal })
}

export interface BodyInput {
  number: string
  name: string
  address: string
  country: string
  nandoUrl: string | null
  scopes: string[]
  contactEmail: string | null
  contactPhone: string | null
  note: string | null
}

const oneBody = z.object({ body: bodySchema })

export function createBody(api: ApiClient, input: BodyInput): Promise<NotifiedBody> {
  return api.post('/compliance/notified-bodies', { body: input, schema: oneBody, ...key() }).then((read) => read.body)
}

/** Edit a body (the number only while no certificate links it), archive or restore it. */
export function editBody(api: ApiClient, body: Versioned, input: Partial<BodyInput> & { status?: 'ACTIVE' | 'ARCHIVED' }): Promise<NotifiedBody> {
  return api.request('PATCH', `/compliance/notified-bodies/${enc(body.id)}`, { body: { ...input, version: body.version }, schema: oneBody, ...key() }).then((read) => read.body)
}
