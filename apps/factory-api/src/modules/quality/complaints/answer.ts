import { createHash } from 'node:crypto'
import type { Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { addressLine, legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal, DocumentLanguage } from '@nexus/factory-domain/documents/model'
import {
  ANSWER_LIMITS,
  answerDraftProblems,
  answerHeld,
  complaintLetter,
  investigationHeld,
  investigationProblems,
  letterFingerprintText,
  letterMailBody,
  letterMailSubject,
  sendHeld,
  type AnswerTemplate,
  type LetterInput,
} from '@nexus/factory-domain/quality/complaints/answer'
import { QUALITY_COMPLAINTS_MANAGE } from '@nexus/factory-domain/quality/complaints/permissions'
import { COMPLAINT_RECORD, type ChangedField, type ComplaintStatus, type HeldCode } from '@nexus/factory-domain/quality/complaints/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { sendEmail } from '../../../platform/email-out/outbound'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { renderEightD } from '../capa/report-pdf'
import { held, officeComplaint } from './access'
import { recordOf, refuse } from './log'
import { customerLanguage, lockComplaint, touchComplaint, type ComplaintRow, type ComplaintView, type Reader } from './store'

/**
 * A complaint's investigation and its answer to the customer (B-W2b-113; QHS-116; design quality.complaints record tabs
 * "Investigation" and "Answer", the new tab "Answer letter (PDF)"). quality.complaints.manage over the complaint's company
 * and customer. The rules and words are factory-domain quality/complaints/answer; Complaint_answer_guard holds the same for
 * every login.
 *
 *   PATCH /quality/complaints/:id/investigation  findings and root cause, in words (office only), from TRIAGED on
 *   PUT   /quality/complaints/:id/answer         the letter as written: template, language, words, the complaint's files
 *                                               with it; frozen while ANSWERED
 *   GET   /quality/complaints/:id/answer/check   what a send would do: the customer's contacts with an e-mail, the subject
 *                                               and words of the mail, why it cannot go yet
 *   GET   /quality/complaints/:id/answer/letter  the letter as the customer would get it, "preview" banner, stored nowhere
 *   POST  /quality/complaints/:id/answer/send    send = review then send, never by itself: the letter kept as a version
 *                                               (GeneratedDocument COMPLAINT_ANSWER, no site, shared with the customer's
 *                                               party), mailed on the complaint's thread to the contacts chosen with the
 *                                               files that go with it (email out: QUEUED, the worker delivers it; FAKE
 *                                               SES locally and in tests), and the complaint ANSWERED — answeredAt,
 *                                               answerDocumentId, answeredById, answeredVia EMAIL — in ONE command with
 *                                               ONE update. The portal (answeredVia PORTAL) is W2b-3.
 *
 * Every write: ONE command(), the complaint's row FOR UPDATE at the screen's version (lockComplaint: a closed one is
 * refused in words), the version moved on, an audit row that names the fields (never the customer's or the investigation's
 * words), complaint.changed {fields}; the send also complaint.status_changed {to: ANSWERED}.
 */

const refusal = (issues: readonly Issue[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'The answer letter cannot be made as it stands.', [...issues])

const HELD_WORDS: Readonly<Partial<Record<HeldCode, (number: string) => string>>> = {
  CLOSED: (number) => `Complaint ${number} is closed: it changes no more.`,
  NOT_TRIAGED: (number) => `Complaint ${number} is new: triage it first.`,
  ANSWER_SENT: (number) => `Complaint ${number} is answered: its letter changes once it goes back to investigating.`,
  NO_ANSWER: (number) => `Complaint ${number}'s letter has no words yet: write it first.`,
}
const heldError = (code: HeldCode, number: string) => held(code, HELD_WORDS[code]?.(number) ?? `Complaint ${number} cannot do this now.`)

const blank = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// ---- the investigation ----------------------------------------------------------------------------------------------------

/** PATCH /quality/complaints/:complaintId/investigation */
export async function investigateComplaint(caller: CommandCaller, complaintId: string, body: { readonly version: number; readonly findings?: string | null | undefined; readonly rootCause?: string | null | undefined }, idempotencyKey?: string): Promise<{ complaint: ComplaintView }> {
  const { complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  await command(caller, { name: 'complaints.investigate', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const row = await lockComplaint(tools, seen.id, body.version)
    const code = investigationHeld(row.status as ComplaintStatus)
    if (code) throw heldError(code, row.number)
    const problems = investigationProblems(body)
    if (problems.length > 0) refuse(problems, problems[0]!.message)
    const data: Prisma.ComplaintUncheckedUpdateInput = {}
    const fields: ChangedField[] = []
    if (body.findings !== undefined && blank(body.findings) !== row.findings) {
      data.findings = blank(body.findings)
      fields.push('findings')
    }
    if (body.rootCause !== undefined && blank(body.rootCause) !== row.rootCause) {
      data.rootCause = blank(body.rootCause)
      fields.push('rootCause')
    }
    if (fields.length === 0) {
      tools.audit({ action: 'complaints.investigate', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, after: { unchanged: true, version: row.version } })
      return { changed: 0 }
    }
    const after = await touchComplaint(tools, row, data)
    // The investigation's words are named, never copied into the audit row.
    tools.audit({ action: 'complaints.investigate', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { fields, version: after.version } })
    tools.emit({ type: 'complaint.changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, fields } })
    return { changed: fields.length }
  })
  return { complaint: await recordOf(caller, seen.id) }
}

// ---- the letter as written --------------------------------------------------------------------------------------------------

export interface AnswerBody {
  readonly version: number
  readonly template?: AnswerTemplate | null | undefined
  readonly language?: DocumentLanguage | null | undefined
  readonly text?: string | null | undefined
  readonly fileIds?: readonly string[] | undefined
}

/** The files named: files of this complaint (record type Complaint), not deleted. */
async function fileProblems(tx: Reader, row: ComplaintRow, fileIds: readonly string[]): Promise<Issue[]> {
  if (fileIds.length === 0) return []
  const files = await tx.storedFile.findMany({ where: { id: { in: fileIds.filter(isUuid) } }, select: { id: true, recordType: true, recordId: true, status: true } })
  const byId = new Map(files.map((file) => [file.id, file]))
  const problems: Issue[] = []
  fileIds.forEach((fileId, index) => {
    const file = byId.get(fileId)
    if (!file || file.recordType !== COMPLAINT_RECORD || file.recordId !== row.id) problems.push({ path: `body/fileIds/${index}`, message: 'Only a file of this complaint goes with its letter (add it on the Activity tab first).' })
    else if (file.status === 'DELETED' || file.status === 'QUARANTINED') problems.push({ path: `body/fileIds/${index}`, message: `This file is ${file.status.toLowerCase()}.` })
  })
  return problems
}

/** PUT /quality/complaints/:complaintId/answer: the letter as written (the screen saves it before a preview or a send). */
export async function saveAnswer(caller: CommandCaller, complaintId: string, body: AnswerBody, idempotencyKey?: string): Promise<{ complaint: ComplaintView }> {
  const { complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  await command(caller, { name: 'complaints.saveAnswer', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const row = await lockComplaint(tools, seen.id, body.version)
    const code = answerHeld(row.status as ComplaintStatus)
    if (code) throw heldError(code, row.number)
    const problems = [...answerDraftProblems(body), ...(await fileProblems(tools.tx, row, body.fileIds ?? []))]
    if (problems.length > 0) refuse(problems, problems[0]!.message)
    const data: Prisma.ComplaintUncheckedUpdateInput = {}
    if (body.template !== undefined && (body.template ?? null) !== row.answerTemplate) data.answerTemplate = body.template ?? null
    if (body.language !== undefined && (body.language ?? null) !== row.answerLanguage) data.answerLanguage = body.language ?? null
    if (body.text !== undefined && blank(body.text) !== row.answerText) data.answerText = blank(body.text)
    if (body.fileIds !== undefined && JSON.stringify(body.fileIds) !== JSON.stringify(row.answerFileIds)) data.answerFileIds = [...body.fileIds]
    if (Object.keys(data).length === 0) {
      tools.audit({ action: 'complaints.saveAnswer', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, after: { unchanged: true, version: row.version } })
      return { changed: 0 }
    }
    const after = await touchComplaint(tools, row, data)
    // The letter's words stay on the complaint: the audit names what changed.
    tools.audit({ action: 'complaints.saveAnswer', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { changed: Object.keys(data), language: after.answerLanguage, template: after.answerTemplate, files: after.answerFileIds.length, version: after.version } })
    tools.emit({ type: 'complaint.changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, fields: ['answer'] } })
    return { changed: Object.keys(data).length }
  })
  return { complaint: await recordOf(caller, seen.id) }
}

// ---- the letter as printed ------------------------------------------------------------------------------------------------

/** The customer's active contacts with an e-mail, the complaint's own contact first. */
async function contactsOf(db: Reader, row: ComplaintRow) {
  const contacts = await db.partyContact.findMany({ where: { partyId: row.partyId, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  return [...contacts].sort((a, b) => (a.id === row.contactId ? -1 : b.id === row.contactId ? 1 : 0))
}

/** The facts the letter prints (the customer, their address, the words written, the names of the files with it). */
async function letterInputOf(db: Reader, row: ComplaintRow, company: CompanyLegal, options: { readonly language: DocumentLanguage; readonly sample: boolean; readonly signedBy: string | null }): Promise<LetterInput> {
  const { language } = options
  const party = await db.party.findUniqueOrThrow({ where: { id: row.partyId }, select: { legalName: true } })
  const addresses = await db.partyAddress.findMany({ where: { partyId: row.partyId, status: 'ACTIVE' }, select: { kinds: true, isDefaultBillTo: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const address = addresses.find((entry) => entry.kinds.includes('REGISTERED')) ?? addresses.find((entry) => entry.isDefaultBillTo) ?? addresses[0] ?? null
  const contact = row.contactId ? await db.partyContact.findUnique({ where: { id: row.contactId }, select: { name: true } }) : null
  const files = row.answerFileIds.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: row.answerFileIds } }, select: { id: true, originalName: true } })
  const names = new Map(files.map((file) => [file.id, file.originalName]))
  return {
    language,
    date: businessDate(serverClock.now()),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    number: row.number,
    customer: { name: party.legalName, address: address ? addressLine(address, language) : null, contact: contact?.name ?? null },
    customerRef: row.customerRef,
    receivedOn: businessDate(row.receivedAt),
    text: row.answerText ?? '',
    attachments: row.answerFileIds.flatMap((id) => (names.get(id) ? [names.get(id)!] : [])),
    signedBy: options.signedBy,
    sample: options.sample,
  }
}

const languageFor = async (db: Reader, row: ComplaintRow, asked?: DocumentLanguage | undefined): Promise<DocumentLanguage> =>
  asked ?? (row.answerLanguage === 'it' || row.answerLanguage === 'en' ? row.answerLanguage : await customerLanguage(db, row.partyId))

const displayName = async (db: Reader, userId: string): Promise<{ name: string; email: string | null }> => {
  const user = await db.user.findUnique({ where: { id: userId }, select: { displayName: true, email: true } })
  return { name: user?.displayName ?? 'Qualità', email: user?.email ?? null }
}

/** GET /quality/complaints/:complaintId/answer/letter: the letter as the customer would get it, with the preview banner. */
export async function previewAnswerLetter(caller: CommandCaller, complaintId: string, query: { readonly language?: DocumentLanguage | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { context, complaint } = await officeComplaint(caller, complaintId)
  if (!complaint.answerText) throw heldError('NO_ANSWER', complaint.number)
  const company = await companyLegalOf(caller, complaint.companyId)
  const legal = legalProblems(company)
  if (legal.length > 0) throw refusal(legal)
  const letter = await caller.withClient(async (client) =>
    complaintLetter(await letterInputOf(client, complaint, company, { language: await languageFor(client, complaint, query.language), sample: true, signedBy: (await displayName(client, context.actorId)).name })),
  )
  return { pdf: await renderEightD(letter), fileName: letter.fileName }
}

/** Why the letter cannot go now, besides its state: the letterhead, the sender's files.read, the files not shared. */
async function sendProblemsOf(caller: CommandCaller, context: OfficeContext, row: ComplaintRow, db: Reader): Promise<Issue[]> {
  const problems: Issue[] = legalProblems(await companyLegalOf(caller, row.companyId)).map((issue) => ({ ...issue, path: `letter/${issue.path}` }))
  if (!can(actorOf(context), FILES_READ, { companyId: row.companyId })) problems.push({ path: 'letter/filesRead', message: 'The letter goes by mail only from a sender who may read files (files.read).' })
  if (row.answerFileIds.length > 0) {
    const files = await db.storedFile.findMany({ where: { id: { in: row.answerFileIds } }, select: { id: true, originalName: true, visibility: true, partyId: true, status: true } })
    for (const file of files) {
      if (file.status !== 'AVAILABLE') problems.push({ path: 'fileIds', message: `${file.originalName} is ${file.status.toLowerCase()}: take it off the letter or wait.` })
      else if (!file.visibility.includes('PARTNER') || file.partyId !== row.partyId) problems.push({ path: 'fileIds', message: `${file.originalName} is not shared with the customer: share it first.` })
    }
  }
  return problems
}

/** GET /quality/complaints/:complaintId/answer/check */
export async function answerCheck(caller: CommandCaller, complaintId: string) {
  const { context, complaint } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  return caller.withClient(async (client) => {
    const contacts = await contactsOf(client, complaint)
    const language = await languageFor(client, complaint)
    const code = sendHeld({ status: complaint.status as ComplaintStatus, answerText: complaint.answerText, answerLanguage: complaint.answerLanguage })
    const problems: Issue[] = [
      ...(code ? [{ path: `held/${code}`, message: HELD_WORDS[code]?.(complaint.number) ?? code }] : []),
      ...(contacts.length === 0 ? [{ path: 'contactIds', message: 'The customer has no active contact with an e-mail: add one to the customer first.' }] : []),
      ...(await sendProblemsOf(caller, context, complaint, client)),
    ]
    const suggested = contacts[0] ?? null
    return {
      ready: problems.length === 0,
      problems,
      recipients: contacts.map((contact) => ({ contactId: contact.id, name: contact.name, email: contact.email!, language: contact.language, suggested: contact.id === suggested?.id })),
      language,
      subject: letterMailSubject(language, complaint.number, complaint.customerRef),
      message: letterMailBody(language, suggested?.name ?? null, complaint.number),
    }
  })
}

interface PreparedLetter {
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  readonly earlierFileId: string | null
  readonly file: PreparedGeneratedFile | null
}

/** Prepares the letter OUTSIDE any transaction (the store put): shared with the customer's party, so the mail carries it. */
async function prepareLetter(files: FilesRuntime, caller: CommandCaller, context: OfficeContext, row: ComplaintRow): Promise<PreparedLetter> {
  const company = await companyLegalOf(caller, row.companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw refusal(problems)
  const { letter, versions } = await caller.withClient(async (client) => ({
    letter: complaintLetter(await letterInputOf(client, row, company, { language: await languageFor(client, row), sample: false, signedBy: (await displayName(client, context.actorId)).name })),
    versions: await client.generatedDocument.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: row.id, kind: 'COMPLAINT_ANSWER' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } }),
  }))
  const fingerprint = createHash('sha256').update(letterFingerprintText(letter)).digest('hex')
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === letter.language) return { fingerprint, language: letter.language, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, earlierFileId: null, file: null }
  const earlier = versions.find((version) => version.fingerprint === fingerprint && version.language === letter.language)
  if (earlier) return { fingerprint, language: letter.language, current: null, earlierFileId: earlier.fileId, file: null }
  const file = await putGeneratedFile(files, caller, {
    companyId: row.companyId,
    recordType: COMPLAINT_RECORD,
    recordId: row.id,
    kind: 'DOCUMENT',
    originalName: letter.fileName,
    contentType: 'application/pdf',
    body: await renderEightD(letter),
    // The mail's attachment: shared with the customer's party (the letter says what they read; no price, no internal words).
    visibility: ['OFFICE', 'PARTNER'],
    partyId: row.partyId,
  })
  return { fingerprint, language: letter.language, current: null, earlierFileId: null, file }
}

export interface SendBody {
  readonly version: number
  readonly contactIds: readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  readonly message?: string | null | undefined
}

/** POST /quality/complaints/:complaintId/answer/send (see the file's comment). A repeated Idempotency-Key sends no second mail. */
export async function sendAnswer(files: FilesRuntime, caller: CommandCaller, complaintId: string, body: SendBody, idempotencyKey?: string) {
  const { context, complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  const code = sendHeld({ status: seen.status as ComplaintStatus, answerText: seen.answerText, answerLanguage: seen.answerLanguage })
  if (code) throw heldError(code, seen.number)
  const early = await caller.withClient((client) => sendProblemsOf(caller, context, seen, client))
  if (early.length > 0) throw refusal(early)
  const prepared = await prepareLetter(files, caller, context, seen)
  const { result } = await command(caller, { name: 'complaints.sendAnswer', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockComplaint(tools, seen.id, body.version)
    const held = sendHeld({ status: row.status as ComplaintStatus, answerText: row.answerText, answerLanguage: row.answerLanguage })
    if (held) throw heldError(held, row.number)
    // The letter prepared is the one written now (the version read above is the one locked: nothing changed meanwhile).
    const contacts = await contactsOf(tx, row)
    const issues: Issue[] = []
    const chosen = [...new Set(body.contactIds)].flatMap((contactId, index) => {
      const contact = contacts.find((entry) => entry.id === contactId)
      if (!contact) issues.push({ path: `body/contactIds/${index}`, message: 'Not an active contact of the customer with an e-mail.' })
      return contact ? [contact] : []
    })
    if (chosen.length > ANSWER_LIMITS.recipients) issues.push({ path: 'body/contactIds', message: `At most ${ANSWER_LIMITS.recipients} recipients.` })
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    const language = row.answerLanguage as DocumentLanguage
    const kept = await keepLetterInCommand(tools, row, prepared)
    const sender = await displayName(tx, context.actorId)
    const sent = await sendEmail(tools, {
      record: { type: COMPLAINT_RECORD, id: row.id },
      sender: { userId: context.actorId, name: sender.name, email: sender.email },
      to: chosen.map((contact) => contact.email!),
      cc: [...(body.cc ?? [])],
      subject: blank(body.subject) ?? letterMailSubject(language, row.number, row.customerRef),
      body: blank(body.message) ?? letterMailBody(language, chosen.length === 1 ? chosen[0]!.name : null, row.number),
      attachments: [kept.fileId, ...row.answerFileIds],
      locale: language,
    })
    const from = row.status as ComplaintStatus
    const after = await touchComplaint(tools, row, { status: 'ANSWERED', answeredAt: now, answerDocumentId: kept.id, answeredById: context.actorId, answeredVia: 'EMAIL' })
    tools.audit({
      action: 'complaints.sendAnswer',
      recordType: COMPLAINT_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { status: from, answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null, version: row.version },
      after: { status: 'ANSWERED', answeredAt: toUtcIso(now), answerDocumentId: kept.id, version: kept.version, via: 'EMAIL', outboundId: sent.outbound.id, recipients: chosen.length + (body.cc?.length ?? 0), language, files: row.answerFileIds.length, rowVersion: after.version },
    })
    tools.emit({ type: 'complaint.changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, fields: ['answer'] } })
    tools.emit({ type: 'complaint.status_changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, from, to: 'ANSWERED' } })
    return { emailId: sent.outbound.id, document: { id: kept.id, version: kept.version, fileId: kept.fileId } }
  })
  return { complaint: await recordOf(caller, seen.id), emailId: result.emailId, document: result.document }
}

/** Keeps the prepared letter inside the send's command (the complaint's row is held): the next version and its file's row. */
async function keepLetterInCommand(tools: CommandTools, row: ComplaintRow, prepared: PreparedLetter): Promise<{ id: string; version: number; fileId: string }> {
  const { tx, now } = tools
  if (prepared.current) return prepared.current
  const last = await tx.generatedDocument.findFirst({ where: { recordType: COMPLAINT_RECORD, recordId: row.id, kind: 'COMPLAINT_ANSWER' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } })
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language) return { id: last.id, version: last.version, fileId: last.fileId }
  const fileId = prepared.file ? (await recordGeneratedFile(tools, prepared.file, { details: { documentType: 'COMPLAINT_ANSWER', number: row.number, language: prepared.language } })).id : prepared.earlierFileId!
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: row.companyId, siteId: null, recordType: COMPLAINT_RECORD, recordId: row.id, kind: 'COMPLAINT_ANSWER', version, fingerprint: prepared.fingerprint, language: prepared.language, number: row.number, fileId, createdAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  return { id, version, fileId }
}
