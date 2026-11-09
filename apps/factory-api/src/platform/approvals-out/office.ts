import type { FastifyRequest } from 'fastify'
import { APPROVAL_MAIL_TEMPLATES, requestMail } from '@nexus/factory-domain/approvals-out/mail'
import { KIND_RULES, type ApprovalKind, type ApprovalLocale, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { PARTNERS_APPROVALS_ASK, PARTNERS_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { askProblems, dueAtFor, reasonProblems, withdrawProblem } from '@nexus/factory-domain/approvals-out/rules'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import type { FactoryClient } from '@nexus/factory-db'
import { command, type CommandTx } from '../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../core/context'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { emailOrThrow } from '../auth/users/email'
import { suppressedAmong } from '../email-out/outbound'
import { prepareFileCopy, recordGeneratedFile, systemCallerOf, type PreparedGeneratedFile } from '../files/files'
import { processFiles } from '../files/service'
import { assertNoPayByLink, LinkRefusedError } from '../links/pay'
import { openTaskInCommand, closeTasksInCommand } from '../portal/tasks/store'
import type { RecordAdapter } from './adapter'
import { deliverMail, queueMail } from './mail'
import { sameWords } from './adapter'
import { adapterFor, adapterOf } from './records'
import { filesOf, localeOf, lockRequest, OFFICE_COLUMNS, RECORD, readOfficeRow, revokeLinksInCommand, sourceKeyOf, type OfficeRow } from './store'

/**
 * The office's side of approval requests (B-W2b-184; COL-064; design links.approve conn "Office: sales.orders › Changes,
 * sales.mtm › Proofs, quality.ncr, products.samples › Approval"; the "Ask a partner to approve" of the record panels,
 * B-W2b-188's screens):
 *
 *   POST /approvals-out  {kind, recordType, recordId, partyId?, contactId? | email?, question, dueAt?, fileIds?, send,
 *                        language?}   partners.approvals.ask + the record's own write permission (its adapter's), over the
 *                        record's company, site and party. The record read in the person's scope (./records.ts), then the
 *                        files of the record copied outside the command (each a StoredFile of the request, shared with the
 *                        party's portal and links), the link's token minted outside; ONE command: the request (OPEN, v1),
 *                        the record names it (a concession), its files, its APPROVAL link (expires at the due time, one use),
 *                        the partner's task (APPROVE, or RECONFIRM_ORDER for a revised order) and, with `send`, the QUEUED
 *                        mail; after the commit the mail (FAKE locally) or, without `send`, the link ONCE.
 *   POST /approvals-out/:requestId/withdraw {version, reason?}   an OPEN request: WITHDRAWN, its live links revoked, its
 *                        task cancelled, in one command.
 *   GET  /approvals-out?recordType&recordId · GET /approvals-out/:requestId   partners.approvals.view + the record's view.
 */

type Client = FactoryClient | CommandTx

function officeOf(request: FastifyRequest): { context: OfficeContext; actor: Actor } {
  const context = requireContext(request)
  if (context.audience !== 'office') throw new ForbiddenError()
  return { context, actor: actorOf(context) }
}

const scopeOf = (record: { readonly companyId: string; readonly siteId: string | null; readonly partyId: string | null }) => ({ companyId: record.companyId, ...(record.siteId ? { siteId: record.siteId } : {}), ...(record.partyId ? { partyId: record.partyId } : {}) })

function needs(actor: Actor, adapter: RecordAdapter, scope: ReturnType<typeof scopeOf>, mode: 'view' | 'ask'): void {
  const platform = mode === 'ask' ? PARTNERS_APPROVALS_ASK : PARTNERS_APPROVALS_VIEW
  if (!can(actor, platform, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, mode === 'ask' ? adapter.ask : adapter.view, scope)) throw new ForbiddenError(mode === 'ask' ? `Asking a partner to approve this record needs ${adapter.ask}.` : `Seeing the approvals of this record needs ${adapter.view}.`)
}

// ---- what the office reads ----------------------------------------------------------------------------------------------

// B-W2b-F16: codes (kind, status, dueAt) and the record's label in both languages (`words`); the screens say the rest in
// their own words. No kindName, stateWords or dueWords any more (they were English only).
async function officeView(client: Client, row: OfficeRow) {
  const kind = row.kind as ApprovalKind
  const adapter = adapterOf(kind, row.recordType)
  const record = adapter ? await adapter.read(client, row.recordId, kind, { partyId: row.partyId, now: new Date() }) : null
  const party = await client.party.findUnique({ where: { id: row.partyId }, select: { legalName: true } })
  const links = await client.oneOffLink.findMany({ where: { purpose: 'APPROVAL', recordType: RECORD, recordId: row.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, email: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true, lastUsedAt: true } })
  const people = [row.createdById, row.withdrawnById, row.answeredByUserId].filter((id): id is string => id !== null)
  const names = new Map((await client.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const markup = row.markupFileId ? await client.fileMarkup.findFirst({ where: { fileId: row.markupFileId, partyId: row.partyId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { page: true, shapes: true, note: true, createdAt: true } }) : null
  const status = row.status as ApprovalStatus
  return {
    id: row.id,
    companyId: row.companyId,
    kind,
    record: { type: row.recordType, id: row.recordId, words: record?.label ?? sameWords(row.recordId) },
    party: { id: row.partyId, name: party?.legalName ?? '' },
    contactId: row.contactId,
    question: row.question,
    dueAt: toUtcIso(row.dueAt),
    status,
    answer:
      row.answeredAt === null
        ? null
        : {
            at: toUtcIso(row.answeredAt),
            typedName: row.typedName ?? '',
            words: row.answer,
            via: row.answeredViaLinkId ? ('LINK' as const) : ('PORTAL' as const),
            personName: row.answeredByUserId ? (names.get(row.answeredByUserId) ?? null) : null,
            markup: row.markupFileId ? { fileId: row.markupFileId, page: markup?.page ?? null, shapes: (markup?.shapes ?? []) as unknown[], note: markup?.note ?? null } : null,
          },
    withdrawn: row.withdrawnAt ? { at: toUtcIso(row.withdrawnAt), byName: row.withdrawnById ? (names.get(row.withdrawnById) ?? null) : null, reason: row.withdrawReason } : null,
    askedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
    createdAt: toUtcIso(row.createdAt),
    files: (await filesOf(client, row.id)).map((file) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes })),
    links: links.map((link) => ({ id: link.id, email: link.email, expiresAt: toUtcIso(link.expiresAt), used: link.uses >= link.maxUses, revoked: link.revokedAt !== null, lastUsedAt: link.lastUsedAt ? toUtcIso(link.lastUsedAt) : null })),
    may: { withdraw: status === 'OPEN' },
    version: row.version,
  }
}

/** GET /approvals-out/:requestId. */
export async function officeRequest(request: FastifyRequest, requestId: string) {
  const { actor } = officeOf(request)
  const row = isUuid(requestId) ? await request.withClient((client) => readOfficeRow(client, requestId)) : null
  const adapter = row ? adapterOf(row.kind as ApprovalKind, row.recordType) : undefined
  if (!row || !adapter) throw new NotFoundError('Approval request not found.')
  needs(actor, adapter, { companyId: row.companyId, partyId: row.partyId }, 'view')
  return { request: await request.withClient((client) => officeView(client, row)) }
}

/** GET /approvals-out?recordType&recordId: the requests of one record, newest first. */
export async function recordRequests(request: FastifyRequest, recordType: string, recordId: string) {
  const { actor } = officeOf(request)
  const adapter = adapterFor(recordType)
  if (!adapter) throw new ValidationError('No approval is asked on this record type.', [{ path: 'query/recordType', message: 'Not a record an approval names.' }])
  const record = isUuid(recordId) ? await request.withClient((client) => adapter.read(client, recordId, adapter.kinds[0]!, { partyId: null, now: new Date() })) : null
  if (!record) throw new NotFoundError('Record not found.')
  needs(actor, adapter, scopeOf(record), 'view')
  const rows = await request.withClient((client) => client.approvalRequest.findMany({ where: { recordType, recordId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: OFFICE_COLUMNS }))
  const views = []
  for (const row of rows) views.push(await request.withClient((client) => officeView(client, row)))
  return { record: { type: recordType, id: recordId, words: record.label }, kinds: [...adapter.kinds], held: record.held, requests: views }
}

// ---- ask ---------------------------------------------------------------------------------------------------------------------

export interface AskBody {
  readonly kind: ApprovalKind
  readonly recordType: string
  readonly recordId: string
  readonly partyId?: string | undefined
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly question: string
  readonly dueAt?: string | undefined
  readonly fileIds?: readonly string[] | undefined
  readonly send: boolean
  readonly language?: ApprovalLocale | undefined
}

const fail = (issues: Issue[], what: string): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : what, issues)

/** POST /approvals-out. */
export async function askApproval(request: FastifyRequest, body: AskBody, idempotencyKey?: string) {
  const { context, actor } = officeOf(request)
  const auth = officeAuthOf(request.server)
  const now = auth.clock.now()
  const adapter = adapterOf(body.kind, body.recordType)
  if (!adapter) throw fail([{ path: 'body/recordType', message: `A ${KIND_RULES[body.kind].name.en.toLowerCase()} is asked on ${KIND_RULES[body.kind].recordTypes.join(', ')}.` }], 'Not a record this kind is asked on.')
  const record = await request.withClient((client) => adapter.read(client, body.recordId, body.kind, { partyId: body.partyId ?? null, now }))
  if (!record) throw new NotFoundError('Record not found.')
  needs(actor, adapter, scopeOf(record), 'ask')
  if (record.held) throw new InvalidStateError(record.held)
  const partyId = record.partyId!
  if (body.partyId && body.partyId !== partyId) throw fail([{ path: 'body/partyId', message: 'Not the partner of this record.' }], 'Not the partner of this record.')

  const dueAt = body.dueAt === undefined ? dueAtFor(body.kind, null, now) : parseInstant(body.dueAt)
  const picked = [...new Set(body.fileIds ?? [])]
  const auto = adapter.autoFiles ? await request.withClient((client) => adapter.autoFiles!(client, body.recordId)) : []
  const fileIds = [...new Set([...auto, ...picked])]
  const problems = dueAt ? askProblems({ kind: body.kind, recordType: body.recordType, question: body.question, dueAt, fileCount: fileIds.length }, now) : [{ path: 'body/dueAt', message: 'When the answer is due: an instant.' }]

  const facts = await request.withClient(async (client) => {
    const allowed = await adapter.fileRecords(client, body.recordId)
    const files = await client.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, recordType: true, recordId: true, status: true, supersededAt: true } })
    const contact = body.contactId ? await client.partyContact.findFirst({ where: { id: body.contactId, partyId, status: 'ACTIVE' }, select: { email: true, language: true } }) : null
    const party = await client.party.findUnique({ where: { id: partyId }, select: { language: true } })
    const company = await client.company.findUnique({ where: { id: record.companyId }, select: { legalName: true, tradeName: true } })
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return { allowed, files, contact, party, company, user }
  })
  fileIds.forEach((fileId, index) => {
    const file = facts.files.find((row) => row.id === fileId)
    if (!file || !facts.allowed.some((own) => own.type === file.recordType && own.id === file.recordId)) problems.push({ path: `body/fileIds/${index}`, message: 'Not a file of this record (or of the records that go with it).' })
    else if (file.status !== 'AVAILABLE' || file.supersededAt !== null) problems.push({ path: `body/fileIds/${index}`, message: 'Only the current, available version of a file goes with a request.' })
  })
  if (body.contactId && !facts.contact?.email) problems.push({ path: 'body/contactId', message: 'Not an active contact of this partner with an e-mail.' })
  if (problems.length > 0) throw fail(problems, 'The request is not complete.')
  const typed = body.email === undefined ? null : emailOrThrow(body.email, 'body/email')
  const to = facts.contact?.email?.trim().toLowerCase() ?? typed
  if (body.send && !to) throw fail([{ path: 'body/email', message: 'An address to send the link to.' }], 'Give the address the request goes to, or take the link to pass it on yourself.')
  const locale: ApprovalLocale = body.language ?? localeOf(facts.contact?.language ?? facts.party?.language)

  // Outside the command: the copies of the files (store calls) and the link's token.
  const requestId = newId()
  const linkId = newId()
  const files = processFiles()
  const copies: PreparedGeneratedFile[] = []
  for (const fileId of fileIds) {
    copies.push(await prepareFileCopy(files, request, fileId, { companyId: record.companyId, recordType: RECORD, recordId: requestId, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId }))
  }
  const token = mintLinkToken({ tenantId: context.tenantId, partyId, linkId })
  const companyName = facts.company?.tradeName ?? facts.company?.legalName ?? ''
  const mailFacts = { companyName, kind: body.kind, label: record.label[locale], question: body.question.trim(), dueAt: dueAt! }
  const sender = facts.user ? { userId: context.actorId, name: facts.user.displayName, email: facts.user.email } : null

  const { result, replayed } = await command(
    request,
    { name: 'partners.approvals.ask', idempotencyKey, input: { ...body, requestId } },
    async (tools) => {
      const { tx, now: at } = tools
      const again = await adapter.read(tx, body.recordId, body.kind, { partyId, now: at })
      if (!again || again.partyId !== partyId) throw new NotFoundError('Record not found.')
      if (again.held) throw new InvalidStateError(again.held)
      const open = await tx.approvalRequest.count({ where: { kind: body.kind, recordType: body.recordType, recordId: body.recordId, partyId, status: 'OPEN' } })
      if (open > 0) throw new ConflictError(`An open ${KIND_RULES[body.kind].name.en.toLowerCase()} request waits on this record already: withdraw it first.`)
      await assertNoPayByLink(tx, { recordType: body.recordType, recordId: body.recordId })
      if (body.send && to && (await suppressedAmong(tx, [to])).size > 0) throw new LinkRefusedError('SUPPRESSED', 'This address bounced or complained: correct it first.')
      await tx.approvalRequest.create({
        data: { id: requestId, companyId: record.companyId, recordType: body.recordType, recordId: body.recordId, partyId, contactId: body.contactId ?? null, kind: body.kind, question: body.question.trim(), dueAt: dueAt!, createdAt: at, updatedAt: at, createdById: context.actorId },
        select: { id: true },
      })
      for (const copy of copies) await recordGeneratedFile(tools, copy, { details: { approvalRequestId: requestId } })
      const ref = { id: requestId, companyId: record.companyId, kind: body.kind, recordType: body.recordType, recordId: body.recordId, partyId, status: 'OPEN', answer: null, typedName: null, answeredAt: null }
      if (adapter.onAsked) await adapter.onAsked(tools, ref)
      await tx.oneOffLink.createMany({
        data: [{ id: linkId, companyId: record.companyId, partyId, purpose: 'APPROVAL', recordType: RECORD, recordId: requestId, tokenHash: linkTokenHash(token.value), email: to, expiresAt: dueAt!, maxUses: 1, contactId: body.contactId ?? null, createdAt: at, updatedAt: at, createdById: context.actorId }],
      })
      tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: record.companyId, after: { purpose: 'APPROVAL', recordType: RECORD, recordId: requestId, partyId, email: to, expiresAt: toUtcIso(dueAt!), maxUses: 1 } })
      const { task } = await openTaskInCommand(tools, {
        companyId: record.companyId,
        partyId,
        kind: KIND_RULES[body.kind].task,
        record: { type: RECORD, id: requestId, label: `${KIND_RULES[body.kind].name[locale]} · ${record.label[locale]}` },
        sourceKey: sourceKeyOf(requestId),
        dueAt: dueAt!,
        askedBy: sender ? { id: sender.userId, name: sender.name } : null,
      })
      const outboundId = body.send && to ? await queueMail(tools, { companyId: record.companyId, record: { type: 'OneOffLink', id: linkId }, template: APPROVAL_MAIL_TEMPLATES.request, to, locale, subject: requestMail(locale, mailFacts, '').subject, sender }) : null
      tools.audit({ recordType: RECORD, recordId: requestId, companyId: record.companyId, siteId: record.siteId, after: { kind: body.kind, recordType: body.recordType, recordId: body.recordId, partyId, dueAt: toUtcIso(dueAt!), files: copies.length, linkId, taskId: task.id, mailed: outboundId !== null } })
      tools.emit({ type: 'approval_request.asked', subject: requestId, companyId: record.companyId, payload: { requestId, kind: body.kind, recordType: body.recordType, recordId: body.recordId, partyId, dueAt: toUtcIso(dueAt!), linkId, taskId: task.id, files: copies.length } })
      return { requestId, outboundId }
    },
  )
  const row = (await request.withClient((client) => readOfficeRow(client, result.requestId)))!
  const view = await request.withClient((client) => officeView(client, row))
  if (replayed) return { request: view, url: null, delivery: null }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { request: view, url, delivery: null }
  const delivery = await deliverMail(systemCallerOf(request)(context.tenantId), result.outboundId, requestMail(locale, mailFacts, url).body, sender?.name ?? null, auth.clock)
  return { request: view, url: null, delivery }
}

// ---- withdraw ----------------------------------------------------------------------------------------------------------------

/** POST /approvals-out/:requestId/withdraw. */
export async function withdrawApproval(request: FastifyRequest, requestId: string, body: { readonly version: number; readonly reason?: string | null | undefined }, idempotencyKey?: string) {
  const { context, actor } = officeOf(request)
  const row = isUuid(requestId) ? await request.withClient((client) => readOfficeRow(client, requestId)) : null
  const adapter = row ? adapterOf(row.kind as ApprovalKind, row.recordType) : undefined
  if (!row || !adapter) throw new NotFoundError('Approval request not found.')
  needs(actor, adapter, { companyId: row.companyId, partyId: row.partyId }, 'ask')
  const problems = reasonProblems(body.reason)
  if (problems.length > 0) throw fail(problems, 'The reason is too long.')
  const reason = body.reason?.trim() || null
  await command(request, { name: 'partners.approvals.withdraw', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const current = await lockRequest(tools.tx, requestId, body.version)
    const problem = withdrawProblem(current.status as ApprovalStatus)
    if (problem) throw new InvalidStateError(problem)
    await tools.tx.approvalRequest.update({ where: { id: requestId }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawnById: context.actorId, withdrawReason: reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    const revoked = await revokeLinksInCommand(tools, current, context.actorId)
    await closeTasksInCommand(tools, { recordType: RECORD, recordId: requestId, sourceKey: sourceKeyOf(requestId), status: 'CANCELLED', doneById: null })
    tools.audit({ recordType: RECORD, recordId: requestId, companyId: current.companyId, ...(reason ? { reason } : {}), before: { status: 'OPEN' }, after: { status: 'WITHDRAWN', linksRevoked: revoked.length } })
    tools.emit({ type: 'approval_request.withdrawn', subject: requestId, companyId: current.companyId, payload: { requestId, kind: current.kind as ApprovalKind, recordType: current.recordType, recordId: current.recordId, partyId: current.partyId } })
    return null
  })
  return officeRequest(request, requestId)
}
