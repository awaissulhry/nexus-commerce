import type { FastifyRequest } from 'fastify'
import { monthLabel } from '@nexus/factory-domain/accounting/periods'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { hashPassword } from '@nexus/factory-domain/auth/password/password'
import { linkPasswordProblem } from '@nexus/factory-domain/links/password'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { payrollLinkMail } from '@nexus/factory-domain/people/payroll/mail'
import { layoutConfirmed } from '@nexus/factory-domain/people/payroll/layouts'
import { PEOPLE_PAYROLL_MANAGE } from '@nexus/factory-domain/people/payroll/permissions'
import { PAYROLL_LINK_TERMS } from '@nexus/factory-domain/people/payroll/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { deliverOutbound, sendingIdentity, suppressedAmong, type ClaimedOutbound } from '../../../platform/email-out/outbound'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { linkLock, requireLinkUnlocked } from '../../../platform/links/files'
import { assertNoPayByLink } from '../../../platform/links/pay'
import { linkCommand, useLink } from '../../../platform/links/use'
import { placeOf } from '../close/store'
import type { SendBody, WithdrawBody } from './contract'
import { visibleExport } from './exports'
import { layoutUsedOf, monthGatesOpen, monthOfRow, refusePayroll, requireMonthGates, type ExportRow } from './store'
import { DOWNLOAD_ACTION, exportById } from './views'

/**
 * The file travels by a secure link (B-W2b-54; MES-274; GDPR art. 32; design people.payroll pop-up "Send to the labour consultant"):
 * an expiring link, never an attachment; each download logged. B-W2b-GF1 (G212): a SECURE_FILE link (it was a DOCUMENT_VIEW one):
 * an optional password the office gives the consultant apart (hashed outside the command, never stored as typed, never
 * answered; the mail says it comes apart), each download a counted use, the receipt "I received these files" once.
 *
 *   send       people.payroll.manage, the month's latest exported file only. The token is minted OUTSIDE the command (only its
 *              hash goes in); ONE command withdraws the address's older live link of the export, makes the new one and the
 *              EmailOutbound row (QUEUED, no body). After the commit the mail is composed WITH its link in memory and sent at
 *              once (deliverOutbound, never retried by a job: a failed one is FAILED and the office sends again). The token
 *              is in the sent mail only: never in an answer, a command's result, an audit row, an event or a log. Mail goes
 *              through the tenant's mail account: FAKE locally and in tests.
 *   withdraw   people.payroll.manage: the link opens nothing from then on; its evidence stays.
 *   the page   GET /people/payroll/link/files (the link's session): what was sent, the password's state (asked, given in
 *              this visit, held) and the receipt; the files, with name, size and checksum, only once the password was given
 *              (header x-factory-link-unlock) or when there is none. Reading uses nothing.
 *   download   POST /people/payroll/link/files/:fileId/download: one of the export's files, behind the password, one counted
 *              use of the link (DOWNLOADED), its evidence row and audit row in one command, then a 60-second link.
 *   password   POST /link/password and the receipt POST /link/files/received are platform/links' (they are the link's, whatever
 *              it opens).
 *   a new link "Ask for a new link" on a dead one tells the person who sent it (platform/links renew: no renewer of its own,
 *              B-W2b-F17): whether everyone's hours go out again is a person's call, never automatic.
 *
 * The link is a SECURE_FILE link of the PayrollExport. The consultant is no Party
 * (PartyRole has no such value), so the link's party is the export's own id: a wall nothing else stands behind. The partner
 * role is granted nothing on payroll, so the link's two routes read one export's files in the tenant's system scope, after
 * the session named exactly that export.
 */

const RECORD = 'PayrollExport'
/** B-W2b-GF1 (G212): the secure file (password apart, receipt, each download a use). */
const PURPOSE = 'SECURE_FILE' as const
const TEMPLATE_KEY = 'people.payroll_file'

const linkUrl = (email: EmailRuntime, token: string): string => `${email.webOrigin}/l#token=${encodeURIComponent(token)}`

/** The file may travel: EXPORTED, and not replaced by a correction. */
function assertLatest(row: ExportRow): void {
  if (row.status !== 'EXPORTED') refusePayroll('NOT_EXPORTED', `This export is ${row.status}: only an exported file is sent.`)
  if (row.correctedBy.length > 0) refusePayroll('REPLACED', 'A correction replaced this file: send the latest one.')
}

/** POST /people/payroll/exports/:exportId/send. */
export async function sendExport(request: FastifyRequest, exportId: string, body: SendBody, key?: string) {
  const email = processEmail()
  const { context, row, place } = await visibleExport(request, exportId, PEOPLE_PAYROLL_MANAGE)
  assertLatest(row)
  const month = monthOfRow(row)
  await request.withClient((db) => requireMonthGates(db, place, month))
  const address = emailOrThrow(body.email)
  // B-W2b-GF1 (G212): the password, checked and hashed outside the command (the slow hash never holds a transaction).
  if (body.password !== undefined) {
    const problem = linkPasswordProblem(body.password)
    if (problem) throw new ValidationError(problem, [{ path: 'body/password', message: problem }])
  }
  const passwordHash = body.password === undefined ? null : await hashPassword(body.password)
  const locale = body.language ?? 'it'
  const user = await request.withClient((db) => db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }))
  const used = layoutUsedOf(row.layoutSnapshot)
  const provider = (row.layoutSnapshot as { provider?: string | null } | null)?.provider ?? null
  const asked = { expiresInDays: body.expiresInDays ?? PAYROLL_LINK_TERMS.expiryDays.default, maxUses: body.maxUses ?? PAYROLL_LINK_TERMS.uses.default }
  // Minted here, outside the command: only its hash enters the transaction.
  const linkId = newId()
  const outboundId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: exportId, linkId }).value
  const mailFor = (expiresAt: Date, url: string) => payrollLinkMail({ locale, companyName: row.company.legalName, month, number: row.number ?? '', revision: row.revision, expiresAt, uses: asked.maxUses, message: body.message ?? null, notConfirmed: !layoutConfirmed({ provider, definition: used.definition }), password: passwordHash !== null }, url)

  const { result, replayed } = await command(request, { name: 'people.sendPayrollExport', idempotencyKey: key, input: { exportId, ...body, password: body.password === undefined ? null : 'set' } }, async (tools) => {
    const { tx, now } = tools
    const current = await exportById(tx, exportId)
    if (!current) throw new NotFoundError('Payroll export not found.')
    assertLatest(current)
    // B-W2b-163: pay figures never go by link (Owner, 11-02): a file with amounts is refused (409 refusal/PAY_FIGURES).
    await assertNoPayByLink(tx, { recordType: RECORD, recordId: exportId })
    if ((await suppressedAmong(tx, [address])).size > 0) refusePayroll('SUPPRESSED', 'This address bounced or complained: correct it first.', 'email')
    const older = await tx.oneOffLink.findMany({ where: { recordType: RECORD, recordId: exportId, email: address, revokedAt: null }, select: { id: true, expiresAt: true, revokedAt: true, uses: true, maxUses: true } })
    const withdrawn: string[] = []
    for (const link of older.filter((entry) => linkState(entry, now) === 'LIVE')) {
      await tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId } })
      tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId: row.companyId, after: { revokedAt: toUtcIso(now) }, reason: 'Replaced by a new link to the same address.' })
      withdrawn.push(link.id)
    }
    const terms = linkTerms(PURPOSE, asked, now)
    await tx.oneOffLink.createMany({ data: [{ id: linkId, companyId: row.companyId, partyId: exportId, purpose: PURPOSE, recordType: RECORD, recordId: exportId, tokenHash: linkTokenHash(token), email: address, note: 'The payroll file for the labour consultant.', expiresAt: terms.expiresAt, maxUses: terms.maxUses, passwordHash, createdAt: now, updatedAt: now, createdById: context.actorId }] })
    tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: row.companyId, after: { purpose: PURPOSE, recordType: RECORD, recordId: exportId, partyId: exportId, email: address, password: passwordHash !== null, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses } })
    const identity = await sendingIdentity(tx, row.companyId, null, 'CONVERSATION')
    const from = fromLine(identity, user ? { name: user.displayName, email: user.email } : null)
    await tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: RECORD,
        recordId: exportId,
        templateKey: TEMPLATE_KEY,
        locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [address],
        subject: mailFor(terms.expiresAt, '').subject,
        emailMessageId: messageIdFor(outboundId, identity.domain),
        status: 'QUEUED',
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: TEMPLATE_KEY, exportId, linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
    tools.audit({ recordType: RECORD, recordId: exportId, companyId: row.companyId, after: { sentTo: address, linkId, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses } })
    tools.emit({ type: 'payroll_export.sent', subject: exportId, companyId: row.companyId, payload: { exportId, companyId: row.companyId, month, linkId } })
    return { link: { id: linkId, email: address, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses }, withdrawn, outboundId }
  })
  const delivery = systemCallerOf(request)(context.tenantId)
  if (replayed) {
    const status = await request.withClient((db) => db.emailOutbound.findUnique({ where: { id: result.outboundId }, select: { status: true } }))
    return { link: result.link, withdrawn: result.withdrawn, delivery: status?.status ?? 'QUEUED' }
  }
  const expiresAt = new Date(result.link.expiresAt)
  const url = linkUrl(email, token)
  const outcome = await deliverOutbound(email, delivery, result.outboundId, {
    retry: false,
    clock: serverClock,
    build: (claimed) => mimeOf(email, delivery, claimed, mailFor(expiresAt, url).body, user?.displayName ?? null),
  })
  return { link: result.link, withdrawn: result.withdrawn, delivery: outcome === 'sent' ? 'SENT' : outcome === 'failed' ? 'FAILED' : 'QUEUED' }
}

/** The MIME of the mail: its text WITH the link (in memory only), the sender's signature, the footer. No thread, so no reply address. */
async function mimeOf(email: EmailRuntime, caller: CommandCaller, row: ClaimedOutbound, body: string, senderName: string | null): Promise<string> {
  const company = await companyLegalOf(caller, row.companyId)
  const locale = row.locale === 'en' ? 'en' : 'it'
  const mail = compose({ template: 'thread.message', body: cleanBody(body), senderName, companyName: row.identity.displayName, attachmentNames: [] }, { locale, company, privacyUrl: privacyNoticeUrl(email.webOrigin, row.companyId) })
  return buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: row.cc, replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: serverClock.now(), text: mail.text, html: mail.html, automatic: false })
}

/** POST /people/payroll/exports/:exportId/links/:linkId/withdraw. */
export async function withdrawLink(caller: CommandCaller, exportId: string, linkId: string, body: WithdrawBody, key?: string) {
  const { context, row } = await visibleExport(caller, exportId, PEOPLE_PAYROLL_MANAGE)
  const { result } = await command(caller, { name: 'people.withdrawPayrollLink', idempotencyKey: key, input: { exportId, linkId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const { count } = await tx.oneOffLink.updateMany({ where: { id: linkId, recordType: RECORD, recordId: exportId, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId } })
    if (count !== 1) refusePayroll('LINK_NOT_LIVE', 'This link is withdrawn already, or is not a link of this export.')
    tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: linkId, companyId: row.companyId, after: { revokedAt: toUtcIso(now) }, ...(body.reason ? { reason: body.reason } : {}) })
    tools.emit({ type: 'payroll_export.link_withdrawn', subject: exportId, companyId: row.companyId, payload: { exportId, companyId: row.companyId, linkId } })
    return { id: linkId, state: 'REVOKED' as const, revokedAt: toUtcIso(now) }
  })
  return result
}

// ---- the consultant's side ---------------------------------------------------------------------------------------------

function payrollLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== PURPOSE || link.record.type !== RECORD) throw linkUnavailable()
  return link
}

/**
 * The link's export and its files, in the tenant's system scope. A file replaced by a correction opens nothing, nor does one of
 * a month whose legal gate is off now: the same answer as every link that opens nothing.
 */
async function exportOfLink(request: FastifyRequest, link: LinkSession) {
  const row = await systemCallerOf(request)(link.tenantId).withClient(async (db) => {
    const found = await exportById(db, link.record.id)
    const place = found ? await placeOf(db, found.companyId) : null
    return found && place && (await monthGatesOpen(db, place, monthOfRow(found))) ? found : null
  })
  if (!row || row.status !== 'EXPORTED' || row.correctedBy.length > 0) throw linkUnavailable()
  return row
}

/** GET /people/payroll/link/files: what was sent; the files once the password was given (or with none). Reading uses nothing. */
export async function linkFiles(request: FastifyRequest) {
  const link = payrollLinkOf(request)
  const row = await exportOfLink(request, link)
  const lock = await linkLock(request, link)
  const month = monthOfRow(row)
  return {
    sender: row.company.legalName,
    month,
    label: monthLabel(month, 'it'),
    number: row.number,
    revision: row.revision,
    link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses), password: lock.password, receipt: lock.receipt },
    count: row.files.length,
    files: lock.open ? row.files.map((file) => ({ id: file.fileId, kind: file.kind, name: file.file.originalName, sizeBytes: file.file.sizeBytes, sha256: file.file.sha256 })) : [],
  }
}

/** POST /people/payroll/link/files/:fileId/download: a counted use, logged, then a link that lives 60 seconds. */
export async function downloadLinkFile(request: FastifyRequest, fileId: string, key?: string) {
  const link = payrollLinkOf(request)
  const row = await exportOfLink(request, link)
  await requireLinkUnlocked(request, link)
  const file = row.files.find((entry) => entry.fileId === fileId)
  if (!file) throw new NotFoundError('File not found.')
  const { result } = await linkCommand(request, { name: 'people.downloadPayrollFile', idempotencyKey: key, input: { fileId } }, async (tools) => {
    // B-W2b-GF1 (G212): a download of a secure file — evidence DOWNLOADED, one counted use.
    const use = await useLink(tools, request, { action: 'download' })
    tools.audit({ action: DOWNLOAD_ACTION, recordType: RECORD, recordId: row.id, companyId: row.companyId, after: { linkId: link.id, fileId, kind: file.kind, evidenceId: use.evidenceId } })
    tools.emit({ type: 'payroll_export.downloaded', subject: row.id, companyId: row.companyId, payload: { exportId: row.id, companyId: row.companyId, linkId: link.id, fileId } })
    return { usesLeft: use.usesLeft }
  })
  const system = systemCallerOf(request)
  const caller = system(link.tenantId)
  const download = await downloadFile(processFiles(), { caller, system }, fileId, { viaModule: true })
  return { fileId, fileName: file.file.originalName, usesLeft: result.usesLeft, download }
}

