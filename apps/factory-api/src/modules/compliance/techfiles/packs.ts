import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { hashPassword } from '@nexus/factory-domain/auth/password/password'
import { TECHFILES_MANAGE, TECHFILES_SHARE, TECHFILES_VIEW } from '@nexus/factory-domain/compliance/techfiles/permissions'
import { PACK_CONTENTS, PACK_LINK_DAYS_MAX, packRequestProblems, retentionState, type PackContent, type PackPurpose, type PackScope, type PackStatus } from '@nexus/factory-domain/compliance/techfiles/rules'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { linkFilesMail } from '@nexus/factory-domain/links/mail'
import { linkPasswordProblem } from '@nexus/factory-domain/links/password'
import { linkState, PURPOSE_RULES } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { deliverLinkMail, LINK_MAIL_TEMPLATES, queueLinkMail } from '../../../platform/links/mail'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { scopeOf, scopeOrders } from './build'
import { assertMay, dayOf, guarded, namesFor, officeOf, settings, techfilesClock, todayOf, type Reader } from './common'
import { readFile, readStyle } from './store'

/**
 * Evidence packs of a technical file (B-W2b-251; PRD-299; design compliance.techfiles › Evidence pack, tf-pack "Build evidence
 * pack", the pack PDF and the authority link preview; PPE Reg. art. 8(9), Reg. (EU) 2019/1020 art. 4(3)): for a market
 * surveillance authority or a customer, in the language the recipient understands, the chosen kinds of document over a scope
 * (the whole style, batch numbers, a serial range, a shipment). Asking numbers the pack from its company's EVIDENCE_PACK series
 * and starts its build (BUILDING; the worker's handler builds it: build.ts); BUILT lists every document with its SHA-256, the
 * pack's fingerprint, its PDF and ZIP, kept ten years. A built pack goes to the recipient by a DOCUMENT_VIEW link of its PDF
 * and ZIP (W2b-3, B-W2b-163) with a password and an end date — the sender's own act with a fresh code (step-up); the link's
 * opens and downloads are its evidence. Costs, prices and wages are never included.
 *
 *   GET    /compliance/techfiles/:fileId/packs                          certificates.view
 *   POST   /compliance/techfiles/:fileId/packs                          techfiles.manage: number, BUILDING, technical_file.pack_requested
 *   GET    /compliance/evidence-packs/:packId                           certificates.view
 *   GET    /compliance/evidence-packs/:packId/download?file=PDF|ZIP     certificates.view + files.read: a presigned GET (60 s)
 *   DELETE /compliance/evidence-packs/:packId?version=                  techfiles.manage: a FAILED pack (or one stuck BUILDING an hour)
 *   POST   /compliance/evidence-packs/:packId/link                      techfiles.share + step-up: the DOCUMENT_VIEW link
 *   POST   /compliance/evidence-packs/:packId/links/:linkId/withdraw    techfiles.share: the link opens nothing more
 */

const NOT_FOUND = 'Evidence pack not found.'
const STUCK_MS = 60 * 60 * 1000

const PACK_SELECT = {
  id: true,
  companyId: true,
  number: true,
  purpose: true,
  technicalFileId: true,
  shipmentId: true,
  scope: true,
  language: true,
  recipient: true,
  recipientPartyId: true,
  status: true,
  contents: true,
  fingerprint: true,
  fileId: true,
  zipFileId: true,
  failureReason: true,
  builtAt: true,
  retainUntil: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  recipientParty: { select: { legalName: true, tradeName: true } },
  file: { select: { originalName: true, sizeBytes: true, sha256: true } },
  zipFile: { select: { originalName: true, sizeBytes: true, sha256: true } },
} as const satisfies Prisma.EvidencePackSelect
type PackRow = Prisma.EvidencePackGetPayload<{ select: typeof PACK_SELECT }>

const contentsOf = (value: unknown): { title: string; sha256: string; recordType: string | null; recordId: string | null; fileId: string | null }[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          title: String(entry.title ?? ''),
          sha256: String(entry.sha256 ?? ''),
          recordType: typeof entry.recordType === 'string' ? entry.recordType : null,
          recordId: typeof entry.recordId === 'string' ? entry.recordId : null,
          fileId: typeof entry.fileId === 'string' ? entry.fileId : null,
        }))
    : []

async function linksOf(db: Reader, rows: readonly PackRow[], now: Date) {
  const fileIds = rows.flatMap((row) => [row.fileId, row.zipFileId]).filter((value): value is string => value !== null)
  if (fileIds.length === 0) return new Map<string, ReturnType<typeof linkView>[]>()
  const files = await db.linkFile.findMany({ where: { fileId: { in: fileIds } }, select: { linkId: true, fileId: true } })
  const links = files.length
    ? await db.oneOffLink.findMany({
        where: { id: { in: [...new Set(files.map((row) => row.linkId))] } },
        select: { id: true, partyId: true, email: true, expiresAt: true, revokedAt: true, uses: true, maxUses: true, createdAt: true, passwordHash: true, evidence: { select: { action: true } } },
        orderBy: [{ createdAt: 'desc' }],
      })
    : []
  const out = new Map<string, ReturnType<typeof linkView>[]>()
  for (const row of rows) {
    const own = new Set(files.filter((entry) => entry.fileId === row.fileId || entry.fileId === row.zipFileId).map((entry) => entry.linkId))
    out.set(row.id, links.filter((link) => own.has(link.id)).map((link) => linkView(link, now)))
  }
  return out
}

function linkView(link: { id: string; partyId: string; email: string | null; expiresAt: Date; revokedAt: Date | null; uses: number; maxUses: number; createdAt: Date; passwordHash: string | null; evidence: { action: string }[] }, now: Date) {
  return {
    id: link.id,
    partyId: link.partyId,
    email: link.email,
    state: linkState(link, now),
    expiresAt: toUtcIso(link.expiresAt),
    password: link.passwordHash !== null,
    opens: link.evidence.filter((entry) => entry.action === 'OPENED').length,
    downloads: link.evidence.filter((entry) => entry.action === 'DOWNLOADED').length,
    revokedAt: link.revokedAt ? toUtcIso(link.revokedAt) : null,
    createdAt: toUtcIso(link.createdAt),
  }
}

async function packViews(db: Reader, rows: readonly PackRow[], actor: Actor) {
  const now = techfilesClock().now()
  const today = todayOf(now)
  const links = await linksOf(db, rows, now)
  const names = await namesFor(db, rows.map((row) => row.createdById))
  return rows.map((row) => {
    const scope = scopeOf(row.scope)
    const contents = row.status === 'BUILT' ? contentsOf(row.contents) : null
    const retainUntil = dayOf(row.retainUntil)
    return {
      id: row.id,
      number: row.number,
      companyId: row.companyId,
      purpose: row.purpose as PackPurpose,
      status: row.status as PackStatus,
      technicalFileId: row.technicalFileId,
      scope: { kind: scope.kind, batchNumbers: scope.batchNumbers ? [...scope.batchNumbers] : null, serialFrom: scope.serialFrom ?? null, serialTo: scope.serialTo ?? null, shipmentId: scope.shipmentId ?? null },
      include: [...scope.include],
      language: row.language,
      recipient: row.recipient,
      recipientParty: row.recipientPartyId && row.recipientParty ? { id: row.recipientPartyId, name: row.recipientParty.tradeName ?? row.recipientParty.legalName } : null,
      contents,
      documents: contents?.length ?? null,
      fingerprint: row.fingerprint,
      pdf: row.fileId && row.file ? { id: row.fileId, name: row.file.originalName, sizeBytes: row.file.sizeBytes, sha256: row.file.sha256 } : null,
      zip: row.zipFileId && row.zipFile ? { id: row.zipFileId, name: row.zipFile.originalName, sizeBytes: row.zipFile.sizeBytes, sha256: row.zipFile.sha256 } : null,
      failureReason: row.failureReason,
      builtAt: row.builtAt ? toUtcIso(row.builtAt) : null,
      builtBy: names(row.createdById),
      retainUntil,
      retention: retentionState(retainUntil, today),
      links: links.get(row.id) ?? [],
      note: row.note,
      may: { share: row.status === 'BUILT' && can(actor, TECHFILES_SHARE, { companyId: row.companyId }), remove: can(actor, TECHFILES_MANAGE, { companyId: row.companyId }) && (row.status === 'FAILED' || (row.status === 'BUILDING' && now.getTime() - row.createdAt.getTime() > STUCK_MS)) },
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}
export type PackView = Awaited<ReturnType<typeof packViews>>[number]

/** GET /compliance/techfiles/:fileId/packs */
export async function listPacks(request: FastifyRequest, fileId: string) {
  const actor = actorOf(officeOf(request))
  return request.withClient(async (db) => {
    const file = await readFile(db, actor, fileId)
    const rows = await db.evidencePack.findMany({ where: { technicalFileId: file.id }, select: PACK_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    return { technicalFileId: file.id, packs: await packViews(db, rows, actor), contents: [...PACK_CONTENTS], asOf: toUtcIso(techfilesClock().now()) }
  })
}

async function readPack(db: Reader, actor: Actor, packId: string): Promise<PackRow> {
  const row = isUuid(packId) ? await db.evidencePack.findUnique({ where: { id: packId }, select: PACK_SELECT }) : null
  if (!row || row.technicalFileId === null || !can(actor, TECHFILES_VIEW, { companyId: row.companyId })) throw new NotFoundError(NOT_FOUND)
  return row
}

const packAnswer = async (caller: CommandCaller, packId: string): Promise<{ pack: PackView }> => {
  const actor = actorOf(officeOf(caller))
  return caller.withClient(async (db) => ({ pack: (await packViews(db, [await readPack(db, actor, packId)], actor))[0]! }))
}

/** GET /compliance/evidence-packs/:packId */
export async function getPack(request: FastifyRequest, packId: string): Promise<{ pack: PackView }> {
  return packAnswer(request, packId)
}

export interface RequestPackBody {
  readonly purpose: PackPurpose
  readonly language: string
  readonly recipient: string
  readonly recipientPartyId?: string | null | undefined
  readonly scope: PackScope
  /** The contents checklist; left out: every kind (all on by default). */
  readonly include?: readonly PackContent[] | undefined
  readonly note?: string | null | undefined
}

const packEvent = (tools: Pick<CommandTools, 'emit'>, row: { id: string; number: string; technicalFileId: string; companyId: string; status: PackStatus }, change: 'BUILT' | 'FAILED' | 'SHARED' | 'LINK_WITHDRAWN' | 'REMOVED', documents: number | null) =>
  tools.emit({ type: 'technical_file.pack_changed', subject: row.technicalFileId, companyId: row.companyId, payload: { packId: row.id, number: row.number, technicalFileId: row.technicalFileId, status: row.status, change, documents } })

/** POST /compliance/techfiles/:fileId/packs: the pack numbered and BUILDING; the worker builds it (technical_file.pack_requested). */
export async function requestPack(caller: CommandCaller, fileId: string, body: RequestPackBody, key: string | null | undefined): Promise<{ pack: PackView }> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const include = body.include ?? [...PACK_CONTENTS]
  const problems = packRequestProblems({ ...body, include })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The evidence pack request is not valid.', problems)
  const file = await caller.withClient((db) => readFile(db, actor, fileId))
  assertMay(context, TECHFILES_MANAGE, file.companyId, 'Building an evidence pack')
  // The scope names something of this style (batches, serials or a shipment that carried it).
  await caller.withClient(async (db) => {
    if (body.recipientPartyId) {
      const party = await db.party.findUnique({ where: { id: body.recipientPartyId }, select: { companyId: true } })
      if (!party || (party.companyId !== null && party.companyId !== file.companyId)) throw new ValidationError('The recipient is not a party of this company.', [{ path: 'body/recipientPartyId', message: 'Choose a party of this company (or of every company), or only name the recipient in words.' }])
    }
    if (body.scope.kind === 'SHIPMENT') {
      const shipment = isUuid(body.scope.shipmentId ?? '') ? await db.shipment.findUnique({ where: { id: body.scope.shipmentId! }, select: { companyId: true } }) : null
      if (!shipment || shipment.companyId !== file.companyId) throw new ValidationError('The shipment is not one of this company.', [{ path: 'body/scope/shipmentId', message: 'Choose a shipment of this company.' }])
    }
    if (body.scope.kind !== 'STYLE') {
      const { orders, typed } = await scopeOrders(db, file.styleId, body.scope)
      const style = await readStyle(db, file.styleId)
      if (orders.length === 0 && typed.length === 0) throw new ValidationError('The scope names no batch of this style.', [{ path: 'body/scope', message: `No batch of style ${style.code} is in this scope.` }])
      if (body.scope.kind === 'BATCHES' && typed.length > 0 && orders.length === 0 && !(await db.productionControlTest.findFirst({ where: { styleId: file.styleId, batchNumber: { in: [...typed] } }, select: { id: true } }))) {
        throw new ValidationError('The scope names no batch of this style.', [{ path: 'body/scope/batchNumbers', message: `No batch ${typed.join(', ')} of style ${style.code}.` }])
      }
    }
  })
  const scope: Prisma.InputJsonObject = {
    kind: body.scope.kind,
    ...(body.scope.kind === 'BATCHES' ? { batchNumbers: (body.scope.batchNumbers ?? []).map((value) => value.trim()) } : {}),
    ...(body.scope.kind === 'SERIALS' ? { serialFrom: body.scope.serialFrom!.trim().toUpperCase(), serialTo: body.scope.serialTo!.trim().toUpperCase() } : {}),
    ...(body.scope.kind === 'SHIPMENT' ? { shipmentId: body.scope.shipmentId! } : {}),
    include: [...include],
  }
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.requestPack', idempotencyKey: key, input: { fileId, ...body, include } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        const id = newId()
        const issued = await allocateNumber(tools, { companyId: file.companyId, kind: 'EVIDENCE_PACK' }, { type: 'EvidencePack', id })
        await tx.evidencePack.create({
          data: { id, companyId: file.companyId, number: issued.formatted, purpose: body.purpose, technicalFileId: file.id, scope, language: body.language, recipient: body.recipient.trim(), recipientPartyId: body.recipientPartyId ?? null, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true },
        })
        audit({ recordType: 'EvidencePack', recordId: id, companyId: file.companyId, after: { number: issued.formatted, purpose: body.purpose, technicalFileId: file.id, scope, language: body.language, recipient: body.recipient, recipientPartyId: body.recipientPartyId ?? null, status: 'BUILDING' } })
        emit({ type: 'technical_file.pack_requested', subject: file.id, companyId: file.companyId, payload: { packId: id, number: issued.formatted, technicalFileId: file.id, purpose: body.purpose } })
        return { id }
      },
      settings(),
    ),
  )
  return packAnswer(caller, result.id)
}

/** GET /compliance/evidence-packs/:packId/download?file=PDF|ZIP: a presigned GET of the pack's PDF or ZIP. */
export async function downloadPack(request: FastifyRequest, packId: string, which: 'PDF' | 'ZIP') {
  const actor = actorOf(officeOf(request))
  const pack = await request.withClient((db) => readPack(db, actor, packId))
  const fileId = which === 'PDF' ? pack.fileId : pack.zipFileId
  if (pack.status !== 'BUILT' || fileId === null) throw new InvalidStateError(pack.status === 'BUILT' ? `Evidence pack ${pack.number} has no ${which}.` : `Evidence pack ${pack.number} is ${pack.status}: only a built pack is downloaded.`)
  return { download: await downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, fileId), fileName: which === 'PDF' ? (pack.file?.originalName ?? `${pack.number}.pdf`) : (pack.zipFile?.originalName ?? `${pack.number}.zip`) }
}

/** DELETE /compliance/evidence-packs/:packId?version= — a pack that failed (or never built in an hour). */
export async function removePack(caller: CommandCaller, packId: string, version: number, key: string | null | undefined): Promise<{ removed: string }> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.removePack', idempotencyKey: key, input: { packId, version } },
      async (tools) => {
        const { tx, now, audit } = tools
        await tx.$queryRaw`SELECT id FROM "EvidencePack" WHERE id = ${packId}::uuid FOR UPDATE`
        const row = await readPack(tx, actor, packId)
        assertMay(context, TECHFILES_MANAGE, row.companyId, 'Removing an evidence pack')
        if (row.version !== version) throw new ConflictError(`This pack changed since it was read (version ${version}); it is now at version ${row.version}. Reload it.`)
        const stuck = row.status === 'BUILDING' && now.getTime() - row.createdAt.getTime() > STUCK_MS
        if (row.status !== 'FAILED' && !stuck) {
          throw new ConflictError(row.status === 'BUILT' ? `Evidence pack ${row.number} was built and is kept until ${dayOf(row.retainUntil)} (PPE Reg. art. 8(3)): it is not removed.` : `Evidence pack ${row.number} is still building: wait for it.`)
        }
        await tx.evidencePack.delete({ where: { id: packId } })
        audit({ recordType: 'EvidencePack', recordId: packId, companyId: row.companyId, before: { number: row.number, status: row.status, failureReason: row.failureReason } })
        packEvent(tools, { id: row.id, number: row.number, technicalFileId: row.technicalFileId!, companyId: row.companyId, status: row.status as PackStatus }, 'REMOVED', null)
        return { removed: packId }
      },
      settings(),
    ),
  )
  return { removed: packId }
}

export interface ShareBody {
  readonly partyId?: string | undefined
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  /** Sent to the recipient apart (never stored as typed, never answered). */
  readonly password: string
  /** The last day the link opens (Europe/Rome), at most a year ahead. */
  readonly expiresOn: BusinessDate
  readonly maxUses?: number | undefined
  /** Mail the link now (FAKE locally); else the answer shows its address this once. */
  readonly send?: boolean | undefined
  readonly language?: 'it' | 'en' | undefined
  readonly message?: string | undefined
}

/**
 * POST /compliance/evidence-packs/:packId/link: the pack's PDF and ZIP by a DOCUMENT_VIEW link of a set of files (W2b-3), with a
 * password and an end date, to the party's contact (or an address typed): the sender's own act with a fresh code. An authority
 * is a party (OneOffLink names one).
 */
export async function sharePack(request: FastifyRequest, packId: string, body: ShareBody, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | null | undefined }) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const auth = officeAuthOf(request.server)
  const pack = await request.withClient((db) => readPack(db, actor, packId))
  assertMay(context, TECHFILES_SHARE, pack.companyId, 'Sending an evidence pack')
  if (pack.status !== 'BUILT' || pack.fileId === null) throw new InvalidStateError(`Evidence pack ${pack.number} is ${pack.status}: only a built pack is sent.`)
  const partyId = body.partyId ?? pack.recipientPartyId
  if (!partyId) throw new ValidationError('Choose the party the link goes to.', [{ path: 'body/partyId', message: 'A link names a party: choose the authority or the customer (add the authority as a party first).' }])
  const problem = linkPasswordProblem(body.password)
  if (problem) throw new ValidationError(problem, [{ path: 'body/password', message: problem }])
  const now = auth.clock.now()
  const today = todayOf(now)
  const expiresAt = businessDayRange(body.expiresOn).end
  const latest = new Date(now.getTime() + PACK_LINK_DAYS_MAX * 24 * 60 * 60 * 1000)
  if (body.expiresOn < today || expiresAt.getTime() > latest.getTime()) throw new ValidationError('The end date is not valid.', [{ path: 'body/expiresOn', message: `Give a day from today (${today}) to a year ahead.` }])
  const rule = PURPOSE_RULES.DOCUMENT_VIEW
  const maxUses = body.maxUses ?? rule.uses.default
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > rule.uses.max) throw new ValidationError('The opens are not valid.', [{ path: 'body/maxUses', message: `A pack link opens 1 to ${rule.uses.max} times.` }])
  const typed = body.email === undefined ? null : emailOrThrow(body.email)
  if (!body.contactId && typed === null) throw new ValidationError('Choose the contact, or type the address.', [{ path: 'body/contactId', message: 'Choose the contact the link goes to.' }])
  const facts = await request.withClient(async (db) => ({
    party: await db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, language: true } }),
    contact: body.contactId ? await db.partyContact.findUnique({ where: { id: body.contactId }, select: { partyId: true, email: true, status: true, language: true } }) : null,
    company: await db.company.findUnique({ where: { id: pack.companyId }, select: { legalName: true, tradeName: true } }),
    user: await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }),
  }))
  if (!facts.party || (facts.party.companyId !== null && facts.party.companyId !== pack.companyId)) throw new ValidationError('The party is not one of this company.', [{ path: 'body/partyId', message: 'Choose a party of this company (or of every company).' }])
  if (body.contactId) {
    if (!facts.contact || facts.contact.partyId !== partyId) throw new ValidationError('Not a contact of this party.', [{ path: 'body/contactId', message: 'Not a contact of this party.' }])
    if (facts.contact.status !== 'ACTIVE' || !facts.contact.email) throw new ValidationError('This contact has no address to send to.', [{ path: 'body/contactId', message: 'This contact is archived or has no e-mail address.' }])
  }
  const to = body.contactId ? facts.contact!.email!.trim().toLowerCase() : typed!
  options.stepUp()

  const passwordHash = await hashPassword(body.password)
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId, linkId })
  const locale = localeOf(body.language ?? facts.contact?.language ?? facts.party.language)
  const companyName = facts.company?.tradeName ?? facts.company?.legalName ?? ''
  const fileIds = [pack.fileId, ...(pack.zipFileId ? [pack.zipFileId] : [])]
  const fileNames = [pack.file?.originalName ?? `${pack.number}.pdf`, ...(pack.zipFileId ? [pack.zipFile?.originalName ?? `${pack.number}.zip`] : [])]
  const sender = facts.user ? { userId: context.actorId, name: facts.user.displayName, email: facts.user.email } : null
  const { result, replayed } = await guarded(() =>
    runCommand(
      request,
      { name: 'compliance.techfiles.sharePack', idempotencyKey: options.idempotencyKey, input: { packId, ...body, password: 'set' } },
      async (tools) => {
        const { tx, audit } = tools
        if (body.send && (await suppressedAmong(tx, [to])).size > 0) throw new ConflictError('This address bounced or complained: correct it first.')
        await tx.oneOffLink.createMany({
          data: [{ id: linkId, companyId: pack.companyId, partyId, purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile', recordId: fileIds[0]!, tokenHash: linkTokenHash(token.value), email: to, note: `Evidence pack ${pack.number}`, expiresAt, maxUses, passwordHash, contactId: body.contactId ?? null, createdAt: now, updatedAt: now, createdById: context.actorId }],
        })
        await tx.linkFile.createMany({ data: fileIds.map((fileId, index) => ({ id: newId(), partyId, linkId, fileId, position: index + 1, createdAt: now })) })
        audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: pack.companyId, after: { purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile', recordId: fileIds[0], partyId, contactId: body.contactId ?? null, email: to, files: fileIds, password: true, expiresAt: toUtcIso(expiresAt), maxUses, evidencePackId: packId } })
        audit({ recordType: 'EvidencePack', recordId: packId, companyId: pack.companyId, after: { shared: linkId, partyId, email: to, expiresAt: toUtcIso(expiresAt) } })
        packEvent(tools, { id: pack.id, number: pack.number, technicalFileId: pack.technicalFileId!, companyId: pack.companyId, status: 'BUILT' }, 'SHARED', contentsOf(pack.contents).length)
        const mail = linkFilesMail({ locale, companyName, secure: false, fileNames, expiresAt, uses: maxUses, password: true, renewal: false, message: body.message ?? null }, '')
        const outboundId = body.send ? await queueLinkMail(tools, { companyId: pack.companyId, linkId, to, locale, subject: mail.subject, template: LINK_MAIL_TEMPLATES.files, sender }) : null
        return { outboundId }
      },
      settings(),
    ),
  )
  const answer = await packAnswer(request, packId)
  if (replayed) return { ...answer, linkId, url: null, delivery: null }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { ...answer, linkId, url, delivery: null }
  const text = linkFilesMail({ locale, companyName, secure: false, fileNames, expiresAt, uses: maxUses, password: true, renewal: false, message: body.message ?? null }, url).body
  const delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, text, sender?.name ?? null, auth.clock)
  return { ...answer, linkId, url: null, delivery }
}

/** POST /compliance/evidence-packs/:packId/links/:linkId/withdraw {reason?}: the link opens nothing from now on (its evidence stays). */
export async function withdrawLink(caller: CommandCaller, packId: string, linkId: string, body: { readonly reason?: string | undefined }, key: string | null | undefined): Promise<{ pack: PackView }> {
  const context: OfficeContext = officeOf(caller)
  const actor = actorOf(context)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.withdrawLink', idempotencyKey: key, input: { packId, linkId, reason: body.reason ?? null } },
      async (tools) => {
        const { tx, now, audit } = tools
        const pack = await readPack(tx, actor, packId)
        assertMay(context, TECHFILES_SHARE, pack.companyId, 'Withdrawing an evidence pack link')
        const own = isUuid(linkId) ? await tx.linkFile.findFirst({ where: { linkId, fileId: { in: [pack.fileId, pack.zipFileId].filter((value): value is string => value !== null) } }, select: { id: true } }) : null
        if (!own) throw new NotFoundError('Link not found.')
        const { count } = await tx.oneOffLink.updateMany({ where: { id: linkId, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId, updatedAt: now, version: { increment: 1 } } })
        if (count === 0) throw new InvalidStateError('This link is withdrawn already.')
        audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: linkId, companyId: pack.companyId, after: { revokedAt: toUtcIso(now), evidencePackId: packId }, ...(body.reason ? { reason: body.reason } : {}) })
        packEvent(tools, { id: pack.id, number: pack.number, technicalFileId: pack.technicalFileId!, companyId: pack.companyId, status: pack.status as PackStatus }, 'LINK_WITHDRAWN', null)
        return { withdrawn: linkId }
      },
      settings(),
    ),
  )
  return packAnswer(caller, packId)
}

