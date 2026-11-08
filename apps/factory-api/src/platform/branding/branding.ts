import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_UPLOAD, DOCUMENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { BrandingBody, BrandingLogo, BrandingView, LogoUploadBody, PublicBranding } from '@nexus/factory-domain/branding/contracts'
import { BRANDING_MANAGE } from '@nexus/factory-domain/branding/permissions'
import {
  BRANDING_RECORD_TYPE,
  brandingOf,
  changedFields,
  companyNameOf,
  LOGO_CONTENT_TYPES,
  LOGO_FILE_KIND,
  logoUploadProblems,
  NO_BRANDING,
  publicLogoPath,
  shownNames,
  type BrandingValues,
  type LogoContentType,
} from '@nexus/factory-domain/branding/rules'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type LinkContext, type OfficeContext, type RequestContext } from '../../core/context'
import type { FileView } from '../files/contract'
import { completeUpload, getFile, requestUpload, systemCallerOf } from '../files/files'
import { normaliseContentType } from '../files/rules'
import { processFiles } from '../files/service'
import { systemContext } from '../outbox/system'
import { logoBytes, usableLogoFile, type LogoBytes } from './logo'

/**
 * Company branding (B-W2b-161; PLT-228, SAL-064; design admin.documents › Branding, portal.signin › brand head,
 * links.frame › sender head; factory-db CompanyBranding, one row per company, its id the company's).
 *
 *   GET  /branding?companyId                          documents.view: the company's branding with the fallbacks partners see
 *   PUT  /branding/:companyId                         documents.branding.manage + a fresh step-up: the whole branding at the
 *                                                     version read (none for a company without one); ONE command, audited
 *                                                     before → after, `company_branding.changed` naming the fields
 *   POST /branding/:companyId/logo                    documents.branding.manage + files.upload: a PNG or JPEG of at most
 *        …/logo/:fileId/complete                       1 MiB (record CompanyBranding, kind PHOTO, office only), confirmed and
 *                                                     checked by its first bytes; it becomes the logo only when saved
 *   GET  /branding/public/:companyId                  anyone: what the portal's sign-in page shows before anything is typed
 *   GET  /branding/public/:companyId/logo/:fileId     anyone: the picture, only while it is that company's logo
 *   GET  /link/branding                               a link session: its sender's branding (the link page's head)
 *   GET  /branding/portal-sign-in                    anyone (B-W2b-164, portal-head.ts): the portal sign-in page's head by its
 *                                                     address (tenant + company code) or company id; contact and legal block
 *
 * The later portal steps call `publicBrandingOf` with the company of their session (in the tenant's system scope: the
 * branding has no partner grant). An unbranded company keeps the design system's colours and shows its name.
 */

const BRANDING_COLUMNS = {
  id: true,
  companyId: true,
  logoFileId: true,
  logoDarkFileId: true,
  accentColour: true,
  senderDisplayName: true,
  portalLabel: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.CompanyBrandingSelect
type BrandingRow = Prisma.CompanyBrandingGetPayload<{ select: typeof BRANDING_COLUMNS }>

type Reader = Pick<FactoryClient, 'company' | 'companyBranding' | 'storedFile'>

const valuesOf = (row: BrandingRow | null): BrandingValues =>
  row ? { logoFileId: row.logoFileId, logoDarkFileId: row.logoDarkFileId, accentColour: row.accentColour, senderDisplayName: row.senderDisplayName, portalLabel: row.portalLabel } : NO_BRANDING

/** The company's branding row (its id is the company's; a row naming another company is not this one's). */
async function brandingRowOf(client: Pick<FactoryClient, 'companyBranding'>, companyId: string): Promise<BrandingRow | null> {
  const row = await client.companyBranding.findUnique({ where: { id: companyId }, select: BRANDING_COLUMNS })
  return row && row.companyId === companyId ? row : null
}

// ---- who may ------------------------------------------------------------------------------------------------------------

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const mayOn = (context: OfficeContext, permission: Permission, companyId: string): boolean => can(actorOf(context), permission, { companyId })

/** 404 when the caller may not see the company's documents, 403 when it may not do `permission` there. */
function assertMay(context: OfficeContext, companyId: string, ...permissions: Permission[]): void {
  if (!isUuid(companyId) || !mayOn(context, DOCUMENTS_VIEW, companyId)) throw new NotFoundError('Company not found.')
  for (const permission of permissions) if (!mayOn(context, permission, companyId)) throw new ForbiddenError()
}

// ---- reads ----------------------------------------------------------------------------------------------------------------

const asLogoType = (value: string): LogoContentType | null => ((LOGO_CONTENT_TYPES as readonly string[]).includes(value) ? (value as LogoContentType) : null)

/** A saved logo as the office sees it; null when its file is gone or no longer usable. */
async function logoView(client: Reader, companyId: string, fileId: string | null): Promise<BrandingLogo | null> {
  if (!fileId) return null
  const row = await client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, originalName: true, contentType: true, status: true, recordType: true, recordId: true } })
  const contentType = row ? asLogoType(row.contentType) : null
  if (!row || !contentType || row.status !== 'AVAILABLE' || row.recordType !== BRANDING_RECORD_TYPE || row.recordId !== companyId) return null
  return { fileId: row.id, path: publicLogoPath(companyId, row.id), name: row.originalName, contentType }
}

/** The office's view of a company's branding (the fallbacks applied in `shown`). */
async function brandingViewOf(client: Reader, companyId: string, mayChange: boolean): Promise<BrandingView> {
  const company = await client.company.findUnique({ where: { id: companyId }, select: { id: true, legalName: true, tradeName: true } })
  if (!company) throw new NotFoundError('Company not found.')
  const row = await brandingRowOf(client, companyId)
  const values = valuesOf(row)
  return {
    companyId,
    companyName: companyNameOf(company),
    saved: row !== null,
    logo: await logoView(client, companyId, values.logoFileId),
    logoDark: await logoView(client, companyId, values.logoDarkFileId),
    accentColour: values.accentColour,
    senderDisplayName: values.senderDisplayName,
    portalLabel: values.portalLabel,
    shown: shownNames(company, values),
    version: row?.version ?? null,
    updatedAt: row ? toUtcIso(row.updatedAt) : null,
    mayChange,
  }
}

/** GET /branding?companyId (documents.view over the company). */
export async function getBranding(caller: CommandCaller, query: { readonly companyId: string }): Promise<{ branding: BrandingView }> {
  const context = officeOf(caller)
  assertMay(context, query.companyId)
  return { branding: await caller.withClient((client) => brandingViewOf(client, query.companyId, mayOn(context, BRANDING_MANAGE, query.companyId))) }
}

/**
 * What anyone may see of a company's branding: the portal's name, the company's name, the logos' public paths, the accent
 * as given. Read with a client of the tenant's system scope (the later portal steps: the company of their session).
 */
export async function publicBrandingOf(client: Reader, companyId: string): Promise<PublicBranding | null> {
  const company = await client.company.findFirst({ where: { id: companyId, status: 'ACTIVE' }, select: { id: true, legalName: true, tradeName: true } })
  if (!company) return null
  const row = await brandingRowOf(client, companyId)
  const values = valuesOf(row)
  const logo = await logoView(client, companyId, values.logoFileId)
  const dark = logo ? await logoView(client, companyId, values.logoDarkFileId) : null
  return {
    companyId,
    name: shownNames(company, values).portal,
    companyName: companyNameOf(company),
    logoPath: logo?.path ?? null,
    logoDarkPath: dark?.path ?? null,
    accentColour: values.accentColour,
  }
}

// ---- save ------------------------------------------------------------------------------------------------------------------

/** A logo the save names that is not already the company's: an AVAILABLE picture of its branding, PNG or JPEG by its bytes. */
async function checkNewLogo(caller: CommandCaller, companyId: string, fileId: string, path: string, current: BrandingValues): Promise<Issue | null> {
  if (fileId === current.logoFileId || fileId === current.logoDarkFileId) return null
  const file = await caller.withClient((client) => usableLogoFile(client, companyId, fileId))
  if (!file) return { path, message: 'Not a logo uploaded for this company (upload it with POST /branding/:companyId/logo), or not available yet.' }
  // Read now, outside the command: a store call never runs inside its transaction. The bytes are kept for the PDFs.
  return (await logoBytes(caller, file)) ? null : { path, message: 'This file is not a PNG or JPEG picture, or the file store did not answer.' }
}

/** PUT /branding/:companyId (documents.branding.manage + a fresh step-up when something changes). */
export async function saveBranding(caller: CommandCaller, companyId: string, body: BrandingBody, stepUp: () => void, idempotencyKey?: string): Promise<{ branding: BrandingView; changed: string[] }> {
  const context = officeOf(caller)
  assertMay(context, companyId, BRANDING_MANAGE)
  const { values, problems } = brandingOf(body)
  if (problems.length > 0) throw new ValidationError('The branding is not valid.', problems)
  const current = await caller.withClient(async (client) => {
    if (!(await client.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    return brandingRowOf(client, companyId)
  })
  if (current && body.version === undefined) {
    throw new DomainError('conflict', `This company's branding is at version ${current.version}: send the version you read.`, [{ path: 'body/version', message: `The current version is ${current.version}.` }])
  }
  if (!current && body.version !== undefined) throw new DomainError('conflict', 'This company has no branding yet: send no version to make it.', [{ path: 'body/version', message: 'Leave it out for a first save.' }])
  const changed = changedFields(valuesOf(current), values)
  // Nothing to change: nothing is written (and no code is asked for).
  if (changed.length === 0 && (!current || current.version === body.version)) {
    return { branding: await caller.withClient((client) => brandingViewOf(client, companyId, true)), changed: [] }
  }
  stepUp()
  const logoProblems = (
    await Promise.all([
      values.logoFileId ? checkNewLogo(caller, companyId, values.logoFileId, 'body/logoFileId', valuesOf(current)) : null,
      values.logoDarkFileId ? checkNewLogo(caller, companyId, values.logoDarkFileId, 'body/logoDarkFileId', valuesOf(current)) : null,
    ])
  ).filter((issue): issue is Issue => issue !== null)
  if (logoProblems.length > 0) throw new ValidationError('A logo cannot be used.', logoProblems)

  await command(
    caller,
    {
      name: 'documents.branding.save',
      idempotencyKey,
      input: { companyId, ...values, version: body.version ?? null },
      ...(current ? { record: { type: 'CompanyBranding' as const, id: companyId, expectedVersion: body.version } } : {}),
    },
    async (tools: CommandTools) => {
      const before = valuesOf(current)
      const fields = changedFields(before, values)
      let version: number
      if (current) {
        // The record guard locked the row and moved its version (an edit that raced this one is refused on the version).
        const row = await tools.tx.companyBranding.update({ where: { id: companyId }, data: { ...values, updatedAt: tools.now }, select: { version: true } })
        version = row.version
      } else {
        const row = await tools.tx.companyBranding.create({ data: { id: companyId, companyId, ...values, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { version: true } })
        version = row.version
      }
      tools.audit({ recordType: 'CompanyBranding', recordId: companyId, companyId, before: current ? before : null, after: { ...values, fields } })
      if (fields.length > 0) tools.emit({ type: 'company_branding.changed', subject: companyId, companyId, payload: { companyId, fields, version } })
      return { companyId, version, fields }
    },
  )
  return { branding: await caller.withClient((client) => brandingViewOf(client, companyId, true)), changed }
}

// ---- the logo's upload ----------------------------------------------------------------------------------------------------

/** POST /branding/:companyId/logo: the picture announced; its bytes go straight to the store with the presigned PUT. */
export async function announceLogo(caller: CommandCaller, companyId: string, body: LogoUploadBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMay(context, companyId, BRANDING_MANAGE, FILES_UPLOAD)
  const problems = logoUploadProblems(body)
  if (problems.length > 0) throw new ValidationError('The logo is not valid.', problems)
  return requestUpload(
    processFiles(),
    caller,
    { companyId, recordType: BRANDING_RECORD_TYPE, recordId: companyId, kind: LOGO_FILE_KIND, originalName: body.originalName, contentType: normaliseContentType(body.contentType), sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /branding/:companyId/logo/:fileId/complete: confirmed, then checked by its first bytes. */
export async function completeLogo(caller: CommandCaller, companyId: string, fileId: string, idempotencyKey?: string): Promise<{ file: FileView; logo: { fileId: string; contentType: LogoContentType } }> {
  const context = officeOf(caller)
  assertMay(context, companyId, BRANDING_MANAGE, FILES_UPLOAD)
  const before = isUuid(fileId)
    ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: BRANDING_RECORD_TYPE, recordId: companyId, kind: LOGO_FILE_KIND }, select: { id: true } }))
    : null
  if (!before) throw new NotFoundError('File not found.')
  const file = await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true })
  if (file.status !== 'AVAILABLE') throw new InvalidStateError(`The picture is not available (${file.quarantineReason ?? file.status.toLowerCase()}): upload it again.`)
  const stored = await caller.withClient((client) => usableLogoFile(client, companyId, fileId))
  const bytes = stored ? await logoBytes(caller, stored) : null
  if (!bytes) throw new ValidationError('The logo cannot be used.', [{ path: 'params/fileId', message: 'This file is not a PNG or JPEG picture (its first bytes say otherwise), or the file store did not answer.' }])
  return { file: await getFile(caller, fileId), logo: { fileId, contentType: bytes.contentType } }
}

// ---- anyone, and link sessions --------------------------------------------------------------------------------------------

/** A view of the request in another context (the platform's, a tenant's system), as the public privacy notice reads. */
export function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

/**
 * The company's tenant and branding for anyone. The address names the company only, so the tenant is found as the public
 * privacy notice finds it: the platform scope lists the ACTIVE tenants, then each is read in its own system context
 * (row-level security stays forced) until the ACTIVE company is found. One answer for every miss.
 */
async function findPublic(request: FastifyRequest, companyId: string): Promise<{ tenantId: string; branding: PublicBranding; row: BrandingRow | null } | null> {
  if (!isUuid(companyId)) return null
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId: String(request.id) })
  const tenants = await platform.withClient(async (client) => (await client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id))
  for (const tenantId of tenants) {
    const found = await asContext(request, systemContext(tenantId, String(request.id))).withClient(async (client) => {
      const branding = await publicBrandingOf(client, companyId)
      return branding ? { branding, row: await brandingRowOf(client, companyId) } : null
    })
    if (found) return { tenantId, ...found }
  }
  return null
}

const MISSING = () => new NotFoundError('No company is known at this address.')

/** GET /branding/public/:companyId (anyone). */
export async function publicBranding(request: FastifyRequest, companyId: string): Promise<{ branding: PublicBranding }> {
  const found = await findPublic(request, companyId)
  if (!found) throw MISSING()
  return { branding: found.branding }
}

/** GET /branding/public/:companyId/logo/:fileId (anyone): the picture's bytes, only while it is the company's logo. */
export async function publicLogo(request: FastifyRequest, companyId: string, fileId: string): Promise<LogoBytes> {
  const found = isUuid(fileId) ? await findPublic(request, companyId) : null
  if (!found?.row || (found.row.logoFileId !== fileId && found.row.logoDarkFileId !== fileId)) throw new NotFoundError('No logo at this address.')
  const system = systemCallerOf(request)(found.tenantId)
  const file = await system.withClient((client) => usableLogoFile(client, companyId, fileId))
  const bytes = file ? await logoBytes(system, file) : null
  if (!bytes) throw new NotFoundError('No logo at this address.')
  return bytes
}

/** GET /link/branding (a link session): the branding of the company whose record the link opens, for the link page's head. */
export async function linkBranding(caller: CommandCaller): Promise<{ branding: PublicBranding }> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'link') throw new ForbiddenError()
  const link = context as LinkContext
  const companyId = await caller.withClient(async (client) => (await client.oneOffLink.findUnique({ where: { id: link.linkId }, select: { companyId: true } }))?.companyId ?? null)
  if (!companyId) throw new NotFoundError('Not found.')
  const request = caller as FastifyRequest
  const branding = await asContext(request, systemContext(link.tenantId, String(request.id))).withClient((client) => publicBrandingOf(client, companyId))
  if (!branding) throw new NotFoundError('Not found.')
  return { branding }
}
