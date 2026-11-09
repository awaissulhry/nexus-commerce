import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, matchesLinkHash, mintLinkToken, parseLinkToken } from '@nexus/factory-domain/links/token'
import { viesRequesterOf } from '@nexus/factory-domain/parties/vies'
import { answerProblems, cleanAnswers, cleanSites, filesOf, vatProblem, viesTarget, type AnswerEntry, type SiteRow } from '@nexus/factory-domain/purchasing/questionnaire/answers'
import { codeOfConduct, questionsOf } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { questionData } from '@nexus/factory-domain/purchasing/questionnaire/schema'
import { answerReport, codeReport } from '@nexus/factory-domain/purchasing/questionnaire/report'
import { questionnaireMail, reviewDueOf, reviewTaskWords } from '@nexus/factory-domain/purchasing/questionnaire/rules'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { idempotencyKeyFrom, type CommandCaller, type CommandTools } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type RequestContext, type SystemContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { completeUpload, putGeneratedFile, recordGeneratedFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { dropLinkDraft } from '../../../platform/links/drafts'
import { deliverLinkMail } from '../../../platform/links/mail'
import { linkCommand, useLink } from '../../../platform/links/use'
import { systemContext } from '../../../platform/outbox/system'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { followInCommand } from '../../../platform/threads/followers'
import { processVies } from '../../parties/vies'
import { renderAnswerPdf, renderCodePdf } from './pdf'
import { identityFor, QUESTIONNAIRE_MAIL_TEMPLATE } from './send'
import { ANSWER_PDF_ACTION, currentVersion, RECORD, reviewTaskId, supplierFacts, UPLOAD_CATEGORY } from './store'
import { formatInZone } from './time'

/**
 * The supplier questionnaire by link (B-W2b-172; SCM-023; design links.onboard, SCR-269; SUPPLIER_ONBOARD of
 * B-W2b-154/163: the record is the supplier itself, `links.open` and `links.submit` its grants, no grain):
 *
 *   GET  /link/supplier-questionnaire?language=   who asks and who reviews, the buyer's note, the supplier as we hold it
 *                                                 (the form's start), the questionnaire's newest published version (its
 *                                                 questions in both languages), the documents this link uploaded. The
 *                                                 version is read in the tenant's system scope: the partner role reads none.
 *   POST /link/supplier-questionnaire/vat-check   the VAT number typed: its shape; an EU number outside Italy checked live
 *                                                 in VIES (the company's VIES account, FAKE locally; nothing kept)
 *   POST /link/supplier-questionnaire/documents (+ /:fileId/complete)   a document of a FILE question (a certificate, a
 *                                                 test report, a declaration: PDF, JPEG or PNG up to 20 MB), as the
 *                                                 tenant's system caller: a CERTIFICATE file of the supplier's record,
 *                                                 OFFICE and LINK, category QUESTIONNAIRE (it counts for nothing until the
 *                                                 buyer accepts the answer). Uploads from outside wait for the virus scanner
 *                                                 in a live environment (GATE-SPEND: assertOutsideUploadsOpen).
 *   GET  /link/supplier-questionnaire/code-of-conduct?language=   the code to read before signing, a PDF (a new tab)
 *   POST /link/supplier-questionnaire?language=   the signed answer: checked whole first (a refusal uses nothing); then
 *                                                 ONE link command uses the link (SUBMITTED, the typed name = the signer)
 *                                                 and inserts the answer in the link's own scope (with `linkId`); then the
 *                                                 answer's PDF is painted and ONE system command keeps it on the supplier's
 *                                                 files, drops the link's draft and opens the buyer's review task. A repeat
 *                                                 with the same Idempotency-Key replays both.
 *
 * "Ask for a new link" on a dead questionnaire link: renewQuestionnaireLink (registered for SUPPLIER_ONBOARD × Party).
 * Nothing here is money.
 */

const MAX_BYTES = 20 * 1_048_576
const DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png'])
const FILE_COLUMNS = { id: true, originalName: true, contentType: true, sizeBytes: true, status: true, createdAt: true } as const satisfies Prisma.StoredFileSelect
const [taskCreated, taskAssigned] = taskEvents

/** The request's link, when it is a supplier questionnaire's; anything else is the one 404. */
function questionnaireLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'SUPPLIER_ONBOARD' || link.record.type !== 'Party' || link.record.id !== link.partyId) throw linkUnavailable()
  return link
}

const systemOf = (request: FastifyRequest, link: { readonly tenantId: string }): CommandCaller => systemCallerOf(request)(link.tenantId)
const localeOf = (value: string | null | undefined): 'it' | 'en' => (value === 'en' ? 'en' : 'it')

/** The tenant's system caller with files.upload and files.manage over the link's company and supplier only. */
function supplierUploader(request: FastifyRequest, link: LinkSession): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [link.companyId], sites: 'all', parties: [link.partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId: link.tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** What the link sees of its own: the link's maker and note, its creation (for the documents it uploaded). */
async function linkFacts(request: FastifyRequest, link: LinkSession) {
  return systemOf(request, link).withClient(async (client) => {
    const row = await client.oneOffLink.findUnique({ where: { id: link.id }, select: { createdAt: true, createdById: true, note: true } })
    const maker = row ? await client.user.findUnique({ where: { id: row.createdById }, select: { displayName: true, status: true, locale: true } }) : null
    return { createdAt: row?.createdAt ?? new Date(0), makerId: row?.createdById ?? null, maker, note: row?.note ?? null }
  })
}

/** The documents this link uploaded: the supplier's questionnaire files since the link was made, not deleted. */
async function uploadedOf(request: FastifyRequest, link: LinkSession, since: Date) {
  return systemOf(request, link).withClient((client) =>
    client.storedFile.findMany({
      where: { recordType: 'Party', recordId: link.partyId, partyId: link.partyId, category: UPLOAD_CATEGORY, createdAt: { gte: since }, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: FILE_COLUMNS,
    }),
  )
}

const uploadedView = (row: { id: string; originalName: string; contentType: string; sizeBytes: number; status: string }) => ({ id: row.id, name: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, status: row.status })

/** GET /link/supplier-questionnaire?language=. */
export async function linkQuestionnaire(app: FastifyInstance, request: FastifyRequest, language?: 'it' | 'en') {
  const link = questionnaireLinkOf(request)
  const now = appClock(app).now()
  const facts = await linkFacts(request, link)
  const page = await systemOf(request, link).withClient(async (client) => ({
    version: await currentVersion(client, link.companyId),
    supplier: await supplierFacts(client, link.partyId, now),
    company: await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } }),
  }))
  if (!page.version || !page.supplier) throw linkUnavailable()
  const questions = questionsOf(page.version.questions)
  const uploaded = await uploadedOf(request, link, facts.createdAt)
  return {
    sender: { companyName: page.company?.tradeName ?? page.company?.legalName ?? '' },
    reviewer: facts.maker && facts.maker.status === 'ACTIVE' ? { name: facts.maker.displayName } : null,
    note: facts.note,
    supplier: { code: page.supplier.code, legalName: page.supplier.legalName, vatNumber: page.supplier.vatNumber, address: page.supplier.address, website: page.supplier.website },
    questionnaire: { id: page.version.id, revision: page.version.revision, title: page.version.title, questions: questionData(questions), hasCode: codeOfConduct(questions) !== null },
    uploaded: uploaded.map(uploadedView),
    link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses) },
    locale: language ?? localeOf(page.supplier.language),
  }
}

/** GET /link/supplier-questionnaire/code-of-conduct?language=: the PDF, painted on request (never stored). */
export async function linkCodeOfConduct(request: FastifyRequest, language?: 'it' | 'en') {
  const link = questionnaireLinkOf(request)
  const read = await systemOf(request, link).withClient(async (client) => ({
    version: await currentVersion(client, link.companyId),
    company: await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } }),
    party: await client.party.findUnique({ where: { id: link.partyId }, select: { language: true } }),
  }))
  const code = read.version ? codeOfConduct(questionsOf(read.version.questions)) : null
  if (!read.version || !code) throw new NotFoundError('This questionnaire has no code of conduct to read.')
  const locale = language ?? localeOf(read.party?.language)
  const report = codeReport(code.document, locale, read.company?.tradeName ?? read.company?.legalName ?? '')
  const pdf = await renderCodePdf(report, read.version.publishedAt ?? read.version.updatedAt)
  return { pdf, fileName: `${report.title.replace(/[\\/"]/g, '-')}.pdf` }
}

// ---- the VAT number --------------------------------------------------------------------------------------------------------

const NAME_NOISE = /\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|gmbh|ag|sa|sas|sarl|bv|nv|ltd|limited|inc|llc|spa|srl|kg|ohg|sl|slu|oy|ab|as|aps)\b/g
const simpleName = (value: string): string => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim()

/** POST /link/supplier-questionnaire/vat-check {vatNumber, legalName?}. */
export async function linkVatCheck(request: FastifyRequest, body: { readonly vatNumber: string; readonly legalName?: string | undefined }) {
  const link = questionnaireLinkOf(request)
  const compact = body.vatNumber.replace(/[\s./-]/g, '').toUpperCase()
  if (vatProblem(body.vatNumber)) return { result: 'FORMAT' as const, nameMatches: null, vatNumber: compact }
  const target = viesTarget(body.vatNumber)
  if (!target) return { result: 'NOT_CHECKED' as const, nameMatches: null, vatNumber: compact }
  const system = systemOf(request, link)
  const setup = await system.withClient(async (client) => ({
    company: await client.company.findUnique({ where: { id: link.companyId }, select: { vatNumber: true } }),
    accounts: await client.integrationAccount.findMany({ where: { provider: 'VIES', status: { not: 'DISABLED' }, OR: [{ companyId: null }, { companyId: link.companyId }] }, select: { id: true, companyId: true }, orderBy: { id: 'asc' } }),
  }))
  const requester = viesRequesterOf(setup.company?.vatNumber ?? null)
  const own = setup.accounts.filter((account) => account.companyId === link.companyId)
  const chosen = own.length > 0 ? own : setup.accounts.filter((account) => account.companyId === null)
  // No VIES connection, or none we can name: VIES did not answer (we check the number ourselves later).
  if (!requester || chosen.length !== 1) return { result: 'ERROR' as const, nameMatches: null, vatNumber: compact }
  const outcome = await processVies().check(system, chosen[0]!.id, { countryCode: target.countryCode, vatNumber: target.vatNumber, requester })
  const typed = body.legalName ? simpleName(body.legalName) : ''
  const found = outcome.traderName ? simpleName(outcome.traderName) : ''
  const nameMatches = outcome.result === 'VALID' && typed !== '' && found !== '' ? found === typed || found.includes(typed) || typed.includes(found) : null
  return { result: outcome.result, nameMatches, vatNumber: compact }
}

// ---- documents -------------------------------------------------------------------------------------------------------------

export interface DocumentUpload {
  readonly questionKey: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** POST /link/supplier-questionnaire/documents. */
export async function linkAnnounceDocument(request: FastifyRequest, body: DocumentUpload) {
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  const link = questionnaireLinkOf(request)
  const version = await systemOf(request, link).withClient((client) => currentVersion(client, link.companyId))
  if (!version) throw linkUnavailable()
  const question = questionsOf(version.questions).find((entry) => entry.key === body.questionKey)
  const contentType = normaliseContentType(body.contentType)
  const problems: Issue[] = [
    ...(question?.kind === 'FILE' ? [] : [{ path: 'body/questionKey', message: 'A question of this questionnaire that asks for a document.' }]),
    ...(DOCUMENT_TYPES.has(contentType) ? [] : [{ path: 'body/contentType', message: 'A PDF, JPEG or PNG.' }]),
    ...(body.sizeBytes <= MAX_BYTES ? [] : [{ path: 'body/sizeBytes', message: 'At most 20 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems)
  const facts = await linkFacts(request, link)
  const held = (await uploadedOf(request, link, facts.createdAt)).length
  if (held >= 20) throw new ConflictError('This link holds 20 documents already: send your answer, or ask us for a new link.')
  const answer = await requestUpload(
    processFiles(),
    supplierUploader(request, link),
    { companyId: link.companyId, recordType: 'Party', recordId: link.partyId, kind: 'CERTIFICATE', category: UPLOAD_CATEGORY, originalName: body.originalName, contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'LINK'], partyId: link.partyId },
    idempotencyKeyFrom(request),
  )
  return { file: uploadedView(answer.file), upload: answer.upload }
}

/** POST /link/supplier-questionnaire/documents/:fileId/complete. */
export async function linkCompleteDocument(request: FastifyRequest, fileId: string) {
  const link = questionnaireLinkOf(request)
  const facts = await linkFacts(request, link)
  const mine = isUuid(fileId) ? (await uploadedOf(request, link, facts.createdAt)).find((row) => row.id === fileId) : undefined
  if (!mine) throw new NotFoundError('File not found.')
  const view = await completeUpload(processFiles(), supplierUploader(request, link), fileId, idempotencyKeyFrom(request))
  return { file: uploadedView(view) }
}

// ---- the answer ------------------------------------------------------------------------------------------------------------

export interface SubmitBody {
  readonly questionnaireId: string
  readonly answers: Readonly<Record<string, AnswerEntry>>
  readonly sites: readonly SiteRow[]
  readonly subTierSites: readonly SiteRow[]
  readonly signedName: string
  readonly signedRole: string
  readonly truthful: boolean
}

const withBody = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

/** The review task, written as platform/tasks writes one, by the system (no maker). */
async function openReviewTask(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, input: { readonly id: string; readonly companyId: string; readonly partyId: string; readonly label: string; readonly assigneeId: string | null; readonly assignedById: string | null; readonly title: string; readonly description: string; readonly dueDate: string }) {
  const { tx, now } = tools
  await tx.task.create({
    data: {
      id: input.id,
      companyId: input.companyId,
      siteId: null,
      partyId: input.partyId,
      title: input.title,
      description: input.description,
      recordType: 'Party',
      recordId: input.partyId,
      recordLabel: input.label,
      assigneeId: input.assigneeId,
      assignedById: input.assigneeId ? input.assignedById : null,
      assignedAt: input.assigneeId ? now : null,
      dueDate: new Date(`${input.dueDate}T00:00:00.000Z`),
      checklist: [],
      createdAt: now,
      updatedAt: now,
      createdById: null,
    },
    select: { id: true },
  })
  const scope = { companyId: input.companyId, siteId: null }
  tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: input.id, ...scope, after: { title: input.title, dueDate: input.dueDate, assigneeId: input.assigneeId, status: 'OPEN', recordType: 'Party', recordId: input.partyId, by: 'questionnaire' } })
  const about = { taskId: input.id, recordType: 'Party', recordId: input.partyId }
  tools.emit(eventFor(taskCreated, { subject: input.id, ...scope, payload: { ...about, assigneeId: input.assigneeId } }))
  if (input.assigneeId) tools.emit(eventFor(taskAssigned, { subject: input.id, ...scope, payload: { ...about, assigneeId: input.assigneeId, assignedById: null } }))
}

/** POST /link/supplier-questionnaire?language=. */
export async function linkSubmit(app: FastifyInstance, request: FastifyRequest, body: SubmitBody, language?: 'it' | 'en') {
  const link = questionnaireLinkOf(request)
  const system = systemOf(request, link)
  const clock = appClock(app)
  const today = businessDate(clock.now())
  const facts = await linkFacts(request, link)
  const read = await system.withClient(async (client) => ({
    version: await currentVersion(client, link.companyId),
    party: await client.party.findUnique({ where: { id: link.partyId }, select: { code: true, legalName: true, tradeName: true, language: true } }),
    company: await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } }),
  }))
  if (!read.version || !read.party) throw linkUnavailable()
  if (read.version.id !== body.questionnaireId) throw new ConflictError('The questionnaire changed meanwhile: read it again (your answers are kept where the questions are the same).')
  const questions = questionsOf(read.version.questions)
  // Checked whole before the link is used: a send that cannot go uses nothing.
  const problems = answerProblems(questions, body, today)
  if (problems.length > 0) throw new ValidationError('The questionnaire cannot be sent like this.', withBody(problems))
  const documents = filesOf(questions, body.answers)
  const uploaded = await uploadedOf(request, link, facts.createdAt)
  const missing = documents.filter((document) => uploaded.find((row) => row.id === document.fileId)?.status !== 'AVAILABLE')
  if (missing.length > 0) {
    throw new ValidationError(
      'A document has not arrived, or is still being checked: wait a moment, or upload it again.',
      missing.map((document) => ({ path: `body/answers/${document.key}/value`, message: 'This document has not arrived, or is still being checked.' })),
    )
  }
  const answers = cleanAnswers(questions, body.answers)
  const sites = cleanSites(body.sites)
  const subTierSites = cleanSites(body.subTierSites)
  const signedName = body.signedName.trim()
  const signedRole = body.signedRole.trim()
  const key = idempotencyKeyFrom(request)

  // 1. The link used (SUBMITTED, the signer's typed name) and the answer inserted in the link's own scope.
  const responseId = newId()
  const sent = await linkCommand(request, { name: 'purchasing.questionnaire.answer', idempotencyKey: key, input: { questionnaireId: read.version.id, documents: documents.length } }, async (tools) => {
    const used = await useLink(tools, request, { action: 'submit', typedName: signedName })
    await tools.tx.supplierQuestionnaireResponse.create({
      data: {
        id: responseId,
        companyId: link.companyId,
        partyId: link.partyId,
        questionnaireId: read.version!.id,
        linkId: link.id,
        answers: answers as Prisma.InputJsonValue,
        sites: sites as unknown as Prisma.InputJsonValue,
        subTierSites: subTierSites as unknown as Prisma.InputJsonValue,
        signedName,
        signedRole,
        submittedAt: tools.now,
        createdAt: tools.now,
        updatedAt: tools.now,
      },
      select: { id: true },
    })
    tools.audit({ action: 'purchasing.questionnaire.answer', recordType: RECORD, recordId: responseId, companyId: link.companyId, after: { partyId: link.partyId, questionnaireId: read.version!.id, revision: read.version!.revision, linkId: link.id, evidenceId: used.evidenceId, documents: documents.length, sites: sites.length, subTierSites: subTierSites.length } })
    return { responseId, submittedAt: toUtcIso(tools.now) }
  })
  const answer = sent.result

  // 2. The answer's PDF, in the language the supplier answered in, put in the store (outside any transaction).
  const locale = language ?? localeOf(read.party.language)
  const companyName = read.company?.tradeName ?? read.company?.legalName ?? ''
  const submittedAt = new Date(answer.submittedAt)
  const fileNames = new Map(uploaded.map((row) => [row.id, row.originalName] as const))
  const report = answerReport({
    locale,
    companyName,
    supplier: { code: read.party.code, name: read.party.tradeName ?? read.party.legalName },
    revision: read.version.revision,
    title: read.version.title,
    questions,
    answers,
    sites,
    subTierSites,
    signedName,
    signedRole,
    sentWords: formatInZone(submittedAt, locale),
    sentAt: answer.submittedAt,
    viaLink: true,
    fileNames,
  })
  const pdf = await renderAnswerPdf(report)
  const prepared = await putGeneratedFile(processFiles(), system, {
    companyId: link.companyId,
    recordType: 'Party',
    recordId: link.partyId,
    kind: 'DOCUMENT',
    originalName: `${report.title} - ${read.party.code} - ${answer.submittedAt.slice(0, 10)}.pdf`.replace(/[\\/"]/g, '-'),
    contentType: 'application/pdf',
    body: pdf,
    visibility: ['OFFICE'],
  })

  // 3. ONE system command: the PDF on the supplier's files, the link's draft dropped, the buyer's review task.
  const taskId = reviewTaskId(answer.responseId)
  const assignee = facts.maker?.status === 'ACTIVE' ? facts.makerId : null
  const words = reviewTaskWords(localeOf(facts.maker?.locale), { party: read.party.code, revision: read.version.revision })
  const systemKey = key ? `questionnaire.${createHash('sha256').update(`${link.id}|${key}`).digest('hex').slice(0, 48)}` : undefined
  await commandOn(app, system, { name: 'purchasing.questionnaire.kept', idempotencyKey: systemKey, input: { responseId: answer.responseId, linkId: link.id } }, async (tools) => {
    const file = await recordGeneratedFile(tools, prepared, { details: { documentType: 'SUPPLIER_QUESTIONNAIRE', revision: read.version!.revision, language: locale } })
    await tools.tx.storedFile.update({ where: { id: file.id }, data: { category: UPLOAD_CATEGORY }, select: { id: true } })
    tools.audit({ action: ANSWER_PDF_ACTION, recordType: RECORD, recordId: answer.responseId, companyId: link.companyId, after: { fileId: file.id, partyId: link.partyId, language: locale } })
    await dropLinkDraft(tools, link.id)
    const known = await tools.tx.task.findUnique({ where: { id: taskId }, select: { id: true } })
    if (!known) {
      await openReviewTask(tools, { id: taskId, companyId: link.companyId, partyId: link.partyId, label: read.party!.code, assigneeId: assignee, assignedById: facts.makerId, title: words.title, description: words.description, dueDate: reviewDueOf(businessDate(submittedAt)) })
      if (assignee) await followInCommand(tools, { type: 'Party', id: link.partyId, companyId: link.companyId, siteId: null }, assignee, 'ASSIGNEE', null)
    }
    tools.emit({
      type: 'supplier_questionnaire.answered',
      subject: answer.responseId,
      companyId: link.companyId,
      payload: { responseId: answer.responseId, partyId: link.partyId, questionnaireId: read.version!.id, revision: read.version!.revision, linkId: link.id, documents: documents.length, pdfFileId: file.id, taskId },
    })
    return { fileId: file.id }
  })
  return {
    sent: { id: answer.responseId, revision: read.version.revision, submittedAt: answer.submittedAt, documents: documents.length },
    reviewer: facts.maker && facts.maker.status === 'ACTIVE' ? { name: facts.maker.displayName } : null,
    sender: { companyName },
  }
}

// ---- "Ask for a new link" --------------------------------------------------------------------------------------------------

const RENEW_COALESCE_MS = 10 * 60_000

function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

/**
 * The renewer of a dead questionnaire link (B-W2b-163's registerLinkRenewer, after POST /link/renew answered): the token's
 * link in its tenant's system scope; a questionnaire link that expired unanswered (never a withdrawn or an answered one),
 * sent to an address, whose company still has a published version, with no open questionnaire link of the supplier and
 * none renewed in the last 10 minutes → a new link to the same address, mailed (FAKE locally). The outcome is only logged.
 */
export async function renewQuestionnaireLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
  const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
  if (!token) return 'NOT_A_TOKEN'
  const requestId = String(request.id)
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId })
  const tenant = await platform.withClient((client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
  if (tenant?.status !== 'ACTIVE') return 'UNKNOWN'
  const system = asContext(request, systemContext(token.tenantId, requestId))
  const clock = officeAuthOf(request.server).clock
  const now = clock.now()
  const found = await system.withClient(async (client) => {
    const link = await client.oneOffLink.findUnique({ where: { id: token.linkId }, select: { id: true, partyId: true, companyId: true, purpose: true, recordType: true, recordId: true, tokenHash: true, email: true, contactId: true, note: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true, createdById: true } })
    if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash)) return null
    const others = await client.oneOffLink.findMany({ where: { companyId: link.companyId, partyId: link.partyId, purpose: 'SUPPLIER_ONBOARD', id: { not: link.id } }, select: { revokedAt: true, uses: true, maxUses: true, expiresAt: true, createdAt: true } })
    const company = await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    const party = await client.party.findUnique({ where: { id: link.partyId }, select: { language: true, status: true } })
    return { link, others, company, party, version: await currentVersion(client, link.companyId) }
  })
  if (!found || found.link.purpose !== 'SUPPLIER_ONBOARD' || found.link.recordType !== 'Party') return 'UNKNOWN'
  const { link } = found
  const state = linkState(link, now)
  if (state === 'REVOKED') return 'WITHDRAWN'
  if (state === 'LIVE') return 'STILL_LIVE'
  if (state === 'USED_UP') return 'ANSWERED'
  if (!found.version || found.party?.status === 'ARCHIVED') return 'NOTHING_TO_ASK'
  if (!link.email) return 'NO_ADDRESS'
  if (found.others.some((other) => linkState(other, now) === 'LIVE')) return 'NEWER_LINK'
  if (found.others.some((other) => other.createdAt.getTime() > now.getTime() - RENEW_COALESCE_MS)) return 'ASKED_RECENTLY'
  const locale = localeOf(found.party?.language)
  const companyName = found.company?.tradeName ?? found.company?.legalName ?? ''
  const linkId = newId()
  const fresh = mintLinkToken({ tenantId: token.tenantId, partyId: link.partyId, linkId })
  const { result } = await commandOn(request.server, system, { name: 'purchasing.questionnaire.renewLink', input: { linkId: link.id } }, async (tools) => {
    const terms = linkTerms('SUPPLIER_ONBOARD', {}, tools.now)
    await tools.tx.oneOffLink.createMany({
      data: [{ id: linkId, companyId: link.companyId, partyId: link.partyId, purpose: 'SUPPLIER_ONBOARD', recordType: 'Party', recordId: link.partyId, tokenHash: linkTokenHash(fresh.value), email: link.email, note: link.note, expiresAt: terms.expiresAt, maxUses: terms.maxUses, contactId: link.contactId, renewalOfId: link.id, createdAt: tools.now, updatedAt: tools.now, createdById: link.createdById }],
    })
    tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: link.companyId, after: { purpose: 'SUPPLIER_ONBOARD', recordType: 'Party', recordId: link.partyId, partyId: link.partyId, email: link.email, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses, renewalOfId: link.id } })
    const identity = await identityFor(tools, link.companyId)
    const from = fromLine(identity, null)
    const mail = questionnaireMail(locale, { companyName, expiresOn: businessDate(terms.expiresAt), note: link.note }, '')
    const outboundId = newId()
    await tools.tx.emailOutbound.create({
      data: { id: outboundId, companyId: identity.companyId, identityId: identity.id, recordType: 'OneOffLink', recordId: linkId, templateKey: QUESTIONNAIRE_MAIL_TEMPLATE, locale, fromAddress: from.address, fromName: from.name, to: [link.email!], subject: mail.subject, emailMessageId: messageIdFor(outboundId, identity.domain), status: 'QUEUED', queuedAt: tools.now, createdAt: tools.now, updatedAt: tools.now, createdById: null },
      select: { id: true },
    })
    tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: QUESTIONNAIRE_MAIL_TEMPLATE, linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
    tools.emit({ type: 'supplier_questionnaire.link_sent', subject: link.partyId, companyId: link.companyId, payload: { linkId, partyId: link.partyId, questionnaireId: found.version!.id, mailed: true, withdrawn: 0, expiresAt: toUtcIso(terms.expiresAt) } })
    return { outboundId, expiresAt: toUtcIso(terms.expiresAt) }
  })
  const url = officeAuthOf(request.server).link('/l', fresh.value)
  const text = questionnaireMail(locale, { companyName, expiresOn: businessDate(new Date(result.expiresAt)), note: link.note }, url).body
  await deliverLinkMail(email, system, result.outboundId, text, null, clock)
  return 'SENT'
}
