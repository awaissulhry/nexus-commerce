import type { Prisma } from '@nexus/factory-db'
import { CERTIFICATES_MANAGE, CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { bodyProblems, certificateKindOf, cleanScopes, scopeCheck, type CertificateKind } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { CERTIFICATE_SCOPE, certificatesClock, dayOf } from '../certificates/certificates'
import { assertMayKeep, officeOf, type Reader } from '../register-of-rules/common'
import type { BodyView, CertificateSummary } from './contract'
import { inWords } from './guarded'

/**
 * The notified body directory (B-W2b-255; PRD-286; design compliance.certificates › pop:ce-nb "Notified bodies": name,
 * 4-digit number, address, scope, the NANDO link in a new tab, a warning when the body is not listed for protective
 * clothing). B-W2b-216's NotifiedBody is tenant-wide (a body is the same for every company): reading needs
 * compliance.certificates.view; keeping it needs compliance.certificates.manage over every company (403 in words). One
 * ACTIVE body per number; archived, never deleted; its number fixed once a certificate links it. Each write is ONE command
 * on the body's version with its audit row and `certificates_depth.notified_body_changed`. NANDO itself is read by a
 * person (plan GATE-SPEND): nothing here fetches it.
 */

export const BODY_SELECT = {
  id: true,
  number: true,
  name: true,
  address: true,
  country: true,
  nandoUrl: true,
  scopes: true,
  contactEmail: true,
  contactPhone: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.NotifiedBodySelect
export type BodyRow = Prisma.NotifiedBodyGetPayload<{ select: typeof BODY_SELECT }>

export const SUMMARY_SELECT = {
  id: true,
  number: true,
  standard: true,
  ppeClass: true,
  status: true,
  validFrom: true,
  validTo: true,
  companyId: true,
  holderPartyId: true,
  notifiedBodyNumber: true,
} as const satisfies Prisma.CertificateSelect
export type SummaryRow = Prisma.CertificateGetPayload<{ select: typeof SUMMARY_SELECT }>

export const summaryOf = (row: SummaryRow): CertificateSummary => ({
  id: row.id,
  number: row.number,
  standard: row.standard,
  kind: certificateKindOf(row.standard),
  ppeClass: row.ppeClass,
  status: row.status,
  validFrom: dayOf(row.validFrom),
  validTo: dayOf(row.validTo),
  companyId: row.companyId,
  holderPartyId: row.holderPartyId,
  notifiedBodyNumber: row.notifiedBodyNumber,
})

const WHAT = 'The notified body directory'
const settings = () => ({ ...COMMAND_SETTINGS, clock: certificatesClock() })

/** The certificates a person may see (W1's scope: the certificate's company and holder party). */
export const visibleCertificates = (context: OfficeContext): Prisma.CertificateWhereInput => scopeWhere(actorOf(context), CERTIFICATES_VIEW, CERTIFICATE_SCOPE) as Prisma.CertificateWhereInput

/** The certificates that name a body: linked from the directory, or typed with its number. */
export const namingBody = (body: Pick<BodyRow, 'id' | 'number'>): Prisma.CertificateWhereInput => ({ OR: [{ notifiedBodyId: body.id }, { notifiedBodyId: null, notifiedBodyNumber: body.number }] })

/** Bodies as the screens read them, with how many certificates (that the caller sees) name each. */
export async function bodyViews(db: Reader, context: OfficeContext, rows: readonly BodyRow[], kind: CertificateKind = 'GARMENT'): Promise<BodyView[]> {
  if (rows.length === 0) return []
  const visible = visibleCertificates(context)
  const named = await db.certificate.findMany({
    where: { AND: [visible, { OR: [{ notifiedBodyId: { in: rows.map((row) => row.id) } }, { notifiedBodyId: null, notifiedBodyNumber: { in: rows.map((row) => row.number) } }] }] },
    select: { notifiedBodyId: true, notifiedBodyNumber: true },
  })
  // The links count every certificate (the number's freeze), whoever may see it.
  const linked = await db.certificate.groupBy({ by: ['notifiedBodyId'], where: { notifiedBodyId: { in: rows.map((row) => row.id) } }, _count: { _all: true } })
  const linksOf = new Map(linked.map((entry) => [entry.notifiedBodyId, entry._count._all]))
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    name: row.name,
    address: row.address,
    country: row.country,
    nandoUrl: row.nandoUrl,
    scopes: [...row.scopes],
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    note: row.note,
    status: row.status,
    clothing: scopeCheck(row.scopes, kind === 'OTHER' ? 'GARMENT' : kind),
    certificates: named.filter((entry) => entry.notifiedBodyId === row.id || (entry.notifiedBodyId === null && entry.notifiedBodyNumber === row.number && row.status === 'ACTIVE')).length,
    linked: linksOf.get(row.id) ?? 0,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }))
}

export const mayKeepBodies = (context: OfficeContext): boolean => mayWrite(actorOf(context), CERTIFICATES_MANAGE, null)

/** GET /compliance/notified-bodies — the directory: active bodies first, by number. */
export async function listBodies(caller: CommandCaller, query: { readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined; readonly q?: string | undefined }) {
  const context = officeOf(caller)
  const words = (query.q ?? '').trim()
  const where: Prisma.NotifiedBodyWhereInput = {
    ...(query.status === 'ALL' ? {} : { status: query.status ?? 'ACTIVE' }),
    ...(words ? { OR: [{ number: { contains: words } }, { name: { contains: words, mode: 'insensitive' } }, { country: { equals: words.toUpperCase() } }] } : {}),
  }
  return caller.withClient(async (db) => {
    const rows = await db.notifiedBody.findMany({ where, select: BODY_SELECT, orderBy: [{ status: 'asc' }, { number: 'asc' }, { createdAt: 'asc' }], take: 500 })
    return { bodies: await bodyViews(db, context, rows), mayManage: mayKeepBodies(context), asOf: toUtcIso(certificatesClock().now()) }
  })
}

async function readBody(db: Reader, bodyId: string): Promise<BodyRow> {
  const row = isUuid(bodyId) ? await db.notifiedBody.findUnique({ where: { id: bodyId }, select: BODY_SELECT }) : null
  if (!row) throw new NotFoundError('Notified body not found.')
  return row
}

/** GET /compliance/notified-bodies/:bodyId — one body and the certificates (the caller may see) that name it. */
export async function getBody(caller: CommandCaller, bodyId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const row = await readBody(db, bodyId)
    const certificates = await db.certificate.findMany({ where: { AND: [visibleCertificates(context), namingBody(row)] }, select: SUMMARY_SELECT, orderBy: [{ validTo: 'desc' }, { number: 'asc' }], take: 200 })
    return { body: (await bodyViews(db, context, [row]))[0]!, certificates: certificates.map(summaryOf), mayManage: mayKeepBodies(context) }
  })
}

export interface BodyBody {
  readonly number: string
  readonly name: string
  readonly address: string
  readonly country: string
  readonly nandoUrl?: string | null | undefined
  readonly scopes?: readonly string[] | undefined
  readonly contactEmail?: string | null | undefined
  readonly contactPhone?: string | null | undefined
  readonly note?: string | null | undefined
}

const atBody = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
function check(problems: readonly Issue[]): void {
  if (problems.length > 0) throw new ValidationError('The notified body is not valid.', atBody(problems))
}
const blankToNull = (value: string | null | undefined): string | null | undefined => (value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim())
const takenWords = (number: string, name: string) => `Notified body ${number} is in the directory already (${name}): edit that entry, or archive it first.`

const auditOf = (row: BodyRow) => ({ number: row.number, name: row.name, address: row.address, country: row.country, nandoUrl: row.nandoUrl, scopes: row.scopes, contactEmail: row.contactEmail, contactPhone: row.contactPhone, note: row.note, status: row.status })

function changed(tools: Pick<CommandTools, 'emit'>, row: BodyRow, change: 'CREATED' | 'EDITED' | 'ARCHIVED' | 'RESTORED'): void {
  tools.emit({ type: 'certificates_depth.notified_body_changed', subject: row.id, companyId: null, payload: { bodyId: row.id, number: row.number, status: row.status, change } })
}

/** POST /compliance/notified-bodies — a body typed in from its NANDO entry (ACTIVE). */
export async function createBody(caller: CommandCaller, body: BodyBody, key: string | null | undefined): Promise<{ body: BodyView }> {
  const context = officeOf(caller)
  assertMayKeep(context, CERTIFICATES_MANAGE, null, WHAT)
  const scopes = cleanScopes(body.scopes ?? [])
  const fields = { number: body.number.trim(), name: body.name.trim(), address: body.address.trim(), country: body.country.trim().toUpperCase(), nandoUrl: blankToNull(body.nandoUrl) ?? null, scopes, contactEmail: blankToNull(body.contactEmail) ?? null, contactPhone: blankToNull(body.contactPhone) ?? null, note: blankToNull(body.note) ?? null }
  check(bodyProblems(fields))
  const { result } = await inWords(() =>
    runCommand(
      caller,
      { name: 'compliance.notifiedBodies.create', idempotencyKey: key, input: body },
      async (tools) => {
        const { tx, now, audit } = tools
        const twin = await tx.notifiedBody.findFirst({ where: { number: fields.number, status: 'ACTIVE' }, select: { name: true } })
        if (twin) throw new ConflictError(takenWords(fields.number, twin.name))
        const id = newId()
        const row = await tx.notifiedBody.create({ data: { id, ...fields, createdAt: now, updatedAt: now, createdById: context.actorId }, select: BODY_SELECT })
        audit({ recordType: 'NotifiedBody', recordId: id, companyId: null, after: auditOf(row) })
        changed(tools, row, 'CREATED')
        return { body: (await bodyViews(tx, context, [row]))[0]! }
      },
      settings(),
    ),
  )
  return result
}

export interface EditBodyBody extends Partial<BodyBody> {
  readonly version: number
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined
}

/** PATCH /compliance/notified-bodies/:bodyId — edit, archive or restore (the number only while no certificate links it). */
export async function editBody(caller: CommandCaller, bodyId: string, body: EditBodyBody, key: string | null | undefined): Promise<{ body: BodyView }> {
  const context = officeOf(caller)
  assertMayKeep(context, CERTIFICATES_MANAGE, null, WHAT)
  const known = await caller.withClient((db) => readBody(db, bodyId))
  const fields = {
    ...(body.number !== undefined ? { number: body.number.trim() } : {}),
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.address !== undefined ? { address: body.address.trim() } : {}),
    ...(body.country !== undefined ? { country: body.country.trim().toUpperCase() } : {}),
    ...(body.nandoUrl !== undefined ? { nandoUrl: blankToNull(body.nandoUrl) ?? null } : {}),
    ...(body.scopes !== undefined ? { scopes: cleanScopes(body.scopes) } : {}),
    ...(body.contactEmail !== undefined ? { contactEmail: blankToNull(body.contactEmail) ?? null } : {}),
    ...(body.contactPhone !== undefined ? { contactPhone: blankToNull(body.contactPhone) ?? null } : {}),
    ...(body.note !== undefined ? { note: blankToNull(body.note) ?? null } : {}),
  }
  check(bodyProblems(fields))
  const { result } = await inWords(() =>
    runCommand(
      caller,
      { name: 'compliance.notifiedBodies.edit', idempotencyKey: key, input: { bodyId, ...body }, record: { type: 'NotifiedBody', id: known.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await tx.notifiedBody.findUniqueOrThrow({ where: { id: known.id }, select: BODY_SELECT })
        const number = fields.number ?? before.number
        const nextStatus = body.status ?? before.status
        if (number !== before.number && (await tx.certificate.count({ where: { notifiedBodyId: before.id } })) > 0) {
          throw new DomainError('conflict', `Certificates name notified body ${before.number} from the directory: its number never changes. A body with another number is another entry.`, [{ path: 'body/number', message: 'Fixed while certificates name the body.' }])
        }
        if (nextStatus === 'ACTIVE' && (number !== before.number || before.status !== 'ACTIVE')) {
          const twin = await tx.notifiedBody.findFirst({ where: { number, status: 'ACTIVE', id: { not: before.id } }, select: { name: true } })
          if (twin) throw new ConflictError(takenWords(number, twin.name))
        }
        const row = await tx.notifiedBody.update({ where: { id: before.id }, data: { ...fields, ...(body.status !== undefined ? { status: body.status } : {}), updatedAt: now }, select: BODY_SELECT })
        audit({ recordType: 'NotifiedBody', recordId: row.id, companyId: null, before: auditOf(before), after: auditOf(row) })
        changed(tools, row, before.status !== row.status ? (row.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED')
        return { body: (await bodyViews(tx, context, [row]))[0]! }
      },
      settings(),
    ),
  )
  return result
}
