import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { hashPassword, verifyPassword } from '@nexus/factory-domain/auth/password/password'
import { dispositionOf, PREVIEW_URL_SECONDS, previewModeOf } from '@nexus/factory-domain/files/preview/rules'
import { fileSetProblems, newerVersionOf, newerVersionWords, type CandidateFile, type NewerVersion } from '@nexus/factory-domain/links/files'
import { linkFilesMail } from '@nexus/factory-domain/links/mail'
import { linkPasswordProblem, mintUnlock, passwordHeld, passwordStep, passwordWords, unlockOpens } from '@nexus/factory-domain/links/password'
import { PAY_BY_LINK_REFUSAL, PAYROLL_EXPORT, payByLinkProblem } from '@nexus/factory-domain/links/pay'
import { LINKS_MANAGE } from '@nexus/factory-domain/links/permissions'
import { linkTerms, PURPOSE_RULES, type LinkPurpose } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import type { CommandCaller } from '../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../core/context'
import { abuseKey } from '../abuse/guard'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { emailOrThrow } from '../auth/users/email'
import { suppressedAmong } from '../email-out/outbound'
import { processEmail } from '../email-out/service'
import { presignedView, storeCall, systemCallerOf } from '../files/files'
import { readsThroughModule } from '../files/owned'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../files/rules'
import { processFiles } from '../files/service'
import { keyShownTo } from '../files/thumbs/outside'
import { seriesOf } from '../files/versions/supersede'
import { linkSessionOf, linkUnavailable, type LinkSession } from './authenticator'
import { UNLOCK_HEADER, type LinkView } from './contract'
import { linkViewOf, loadLink } from './links'
import { deliverLinkMail, LINK_MAIL_TEMPLATES, queueLinkMail } from './mail'
import { LinkRefusedError, payrollCarriesPay } from './pay'
import { linkCommand, useLink } from './use'

/**
 * A set of files by link (COL-051 "Expiring share links", MES-274 the secure file; B-W2b-163; design links.document
 * "Several files", "Password", "A newer version exists" and links.file). A DOCUMENT_VIEW or SECURE_FILE link of a
 * StoredFile: its record is the set's first file, its files are links-depth.prisma LinkFile rows, in order.
 *
 * Office
 *   POST /links/files      links.manage over the company and the party, files.read over each file's company: the files
 *                          (AVAILABLE, of the company or tenant-wide, none with pay figures — links/pay —, none that only
 *                          its own module hands out), the address on file (the party's ACTIVE contact) or one typed, an
 *                          optional password (hashed outside the command; never stored as typed, never answered), the
 *                          purpose's terms. The token and the hash are made OUTSIDE the command; ONE command writes the
 *                          link, its LinkFile rows, the audit and, when `send`, the outbound mail row (no body); after the
 *                          commit the mail goes with the link (FAKE locally), else the answer shows the URL this once.
 *
 * The link's session (the link authenticator opened a live link of this kind; anything else is the one 404)
 *   GET  /link/files                    what was sent: the count, and — once the password was given, or with none —
 *                                       each file (name, size, checksum, whether it shows in the page, a newer version
 *                                       named from its series). Reading uses nothing.
 *   POST /link/password                 the password: checked in the tenant's system scope (the link's own session
 *                                       never reads the hash), the count of wrong ones moved in ONE command under the
 *                                       link's row lock (links/password); right: an unlock key for 30 minutes.
 *   POST /link/files/:fileId/download   one of its files: evidence DOWNLOADED (a counted use on SECURE_FILE only), an
 *                                       audit row on the file, then a presigned GET (60 s). A picture goes outside the
 *                                       office only as its stripped copy (files thumbs/outside).
 *   GET  /link/files/:fileId/preview    DOCUMENT_VIEW only: a PDF or a picture in the page (inline, 60 s). A secure file
 *                                       is never shown in the browser: it is downloaded.
 *   POST /link/files/received           SECURE_FILE: "I received these files", once (receivedAt, the typed name, evidence
 *                                       RECEIVED; never a use).
 * The files are read in the tenant's system scope after the session named the link: they may be office files (a tech
 * pack, a payroll file of hours); the set is the only list the session ever sees, and the unlock key opens it.
 */

const SET_FILE = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  status: true,
  seriesId: true,
  versionNo: true,
  supersededAt: true,
  storeAccountId: true,
  storageKey: true,
  thumbnailKey: true,
} as const satisfies Prisma.StoredFileSelect
type SetFile = Prisma.StoredFileGetPayload<{ select: typeof SET_FILE }> & { readonly position: number }

// ---- the office: make a link of a set of files -------------------------------------------------------------------------

export interface FileLinkInput {
  readonly purpose: string
  readonly companyId: string
  readonly partyId: string
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly fileIds: readonly string[]
  readonly password?: string | undefined
  readonly note?: string | undefined
  readonly expiresInDays?: number | undefined
  readonly maxUses?: number | undefined
  readonly send?: boolean | undefined
  readonly language?: 'it' | 'en' | undefined
  readonly message?: string | undefined
}

const CANDIDATE = { id: true, companyId: true, status: true, recordType: true, recordId: true, originalName: true } as const satisfies Prisma.StoredFileSelect

/** The files as the link maker judges them: a payroll file says whether it carries amounts. */
async function candidatesOf(client: Parameters<typeof payrollCarriesPay>[0], fileIds: readonly string[]): Promise<Map<string, CandidateFile & { readonly recordId: string }>> {
  const rows = await client.storedFile.findMany({ where: { id: { in: [...new Set(fileIds)] } }, select: CANDIDATE })
  const found = new Map<string, CandidateFile & { readonly recordId: string }>()
  for (const row of rows) {
    const carries = row.recordType === PAYROLL_EXPORT ? await payrollCarriesPay(client, row.recordId) : false
    found.set(row.id, { ...row, payrollCarriesPay: carries })
  }
  return found
}

/** POST /links/files (see above). */
export async function createFileLink(request: FastifyRequest, body: FileLinkInput, idempotencyKey?: string): Promise<{ link: LinkView; url: string | null; delivery: 'SENT' | 'FAILED' | 'QUEUED' | null }> {
  const context = requireContext(request) as OfficeContext
  const actor = actorOf(context)
  const auth = officeAuthOf(request.server)
  const purpose = body.purpose as LinkPurpose
  const rule = PURPOSE_RULES[purpose]
  if (!rule?.fileSet) throw new ValidationError('This purpose shares no files.', [{ path: 'body/purpose', message: 'A set of files goes by a DOCUMENT_VIEW or SECURE_FILE link.' }])
  if (!can(actor, LINKS_MANAGE, { companyId: body.companyId, partyId: body.partyId })) throw new ForbiddenError()
  if (body.password !== undefined) {
    const problem = linkPasswordProblem(body.password)
    if (problem) throw new ValidationError(problem, [{ path: 'body/password', message: problem }])
  }
  const typed = body.email === undefined ? null : emailOrThrow(body.email)
  if (!body.contactId && typed === null) throw new ValidationError('Choose the contact, or type the address.', [{ path: 'body/contactId', message: 'Choose the contact the files go to.' }])

  // Read as the office person: what their scope shows, and only files their files.read reaches.
  const facts = await request.withClient(async (client) => {
    const party = await client.party.findUnique({ where: { id: body.partyId }, select: { id: true, companyId: true, language: true } })
    const contact = body.contactId ? await client.partyContact.findUnique({ where: { id: body.contactId }, select: { id: true, partyId: true, email: true, status: true, language: true, name: true } }) : null
    const company = await client.company.findUnique({ where: { id: body.companyId }, select: { legalName: true, tradeName: true } })
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return { party, contact, company, user, files: await candidatesOf(client, body.fileIds) }
  })
  if (!facts.party || (facts.party.companyId !== null && facts.party.companyId !== body.companyId)) throw new NotFoundError('Party not found.')
  if (!facts.company) throw new NotFoundError('Company not found.')
  if (body.contactId) {
    if (!facts.contact || facts.contact.partyId !== body.partyId) throw new ValidationError('Not a contact of this party.', [{ path: 'body/contactId', message: 'Not a contact of this party.' }])
    if (facts.contact.status !== 'ACTIVE' || !facts.contact.email) throw new ValidationError('This contact has no address to send to.', [{ path: 'body/contactId', message: 'This contact is archived or has no e-mail address.' }])
    if (typed !== null && typed !== facts.contact.email.trim().toLowerCase()) throw new ValidationError('That is not the address on file.', [{ path: 'body/email', message: "The link goes to the contact's address on file." }])
  }
  const to = body.contactId ? facts.contact!.email!.trim().toLowerCase() : typed!
  const visible = new Map([...facts.files].filter(([, file]) => can(actor, FILES_READ, { companyId: file.companyId })))
  // Pay figures never go by link (Owner, 11-02): said first, as the payroll Send says it (409 refusal/PAY_FIGURES).
  for (const [index, fileId] of body.fileIds.entries()) {
    const file = visible.get(fileId)
    const pay = file ? payByLinkProblem({ recordType: file.recordType, payrollCarriesPay: file.payrollCarriesPay, fileName: file.originalName }) : null
    if (pay) throw new LinkRefusedError(PAY_BY_LINK_REFUSAL, pay, [{ path: `body/fileIds/${index}`, message: pay }])
  }
  const problems = fileSetProblems(body.fileIds, visible, body.companyId).map((issue) => ({ ...issue, path: `body/${issue.path}` }))
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  for (const [index, fileId] of body.fileIds.entries()) {
    const file = visible.get(fileId)!
    if (readsThroughModule(file.recordType)) {
      const message = `"${file.originalName}" is handed out by its own page, not by a share link.`
      throw new ValidationError(message, [{ path: `body/fileIds/${index}`, message }])
    }
  }

  const passwordHash = body.password === undefined ? null : await hashPassword(body.password)
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: body.partyId, linkId })
  const locale = localeOf(body.language ?? facts.contact?.language ?? facts.party.language)
  const companyName = facts.company.tradeName ?? facts.company.legalName
  const names = body.fileIds.map((fileId) => visible.get(fileId)!.originalName)
  const sender = facts.user ? { userId: context.actorId, name: facts.user.displayName, email: facts.user.email } : null

  const { result, replayed } = await linkCommand(request, { name: 'links.shareFiles', idempotencyKey, input: { ...body, password: body.password === undefined ? null : 'set' } }, async (tools) => {
    const { tx, now } = tools
    // Again under the transaction: the files may have moved since they were read.
    const current = await candidatesOf(tx, body.fileIds)
    const again = fileSetProblems(body.fileIds, current, body.companyId).map((issue) => ({ ...issue, path: `body/${issue.path}` }))
    if (again.length > 0) throw new ValidationError(again[0]!.message, again)
    if (body.send && (await suppressedAmong(tx, [to])).size > 0) throw new LinkRefusedError('SUPPRESSED', 'This address bounced or complained: correct it first.')
    const terms = linkTerms(purpose, body, now)
    await tx.oneOffLink.createMany({
      data: [
        {
          id: linkId,
          companyId: body.companyId,
          partyId: body.partyId,
          purpose,
          recordType: 'StoredFile',
          recordId: body.fileIds[0]!,
          tokenHash: linkTokenHash(token.value),
          email: to,
          note: body.note ?? null,
          expiresAt: terms.expiresAt,
          maxUses: terms.maxUses,
          passwordHash,
          contactId: body.contactId ?? null,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
      ],
    })
    await tx.linkFile.createMany({ data: body.fileIds.map((fileId, index) => ({ id: newId(), partyId: body.partyId, linkId, fileId, position: index + 1, createdAt: now })) })
    tools.audit({
      action: 'links.create',
      recordType: 'OneOffLink',
      recordId: linkId,
      companyId: body.companyId,
      after: { purpose, recordType: 'StoredFile', recordId: body.fileIds[0], partyId: body.partyId, contactId: body.contactId ?? null, email: to, files: body.fileIds, password: passwordHash !== null, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses },
    })
    const mail = linkFilesMail({ locale, companyName, secure: purpose === 'SECURE_FILE', fileNames: names, expiresAt: terms.expiresAt, uses: terms.maxUses, password: passwordHash !== null, renewal: false, message: body.message ?? null }, '')
    const outboundId = body.send ? await queueLinkMail(tools, { companyId: body.companyId, linkId, to, locale, subject: mail.subject, template: LINK_MAIL_TEMPLATES.files, sender }) : null
    return { link: linkViewOf(await loadLink(tx, linkId), now), outboundId, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses }
  })
  if (replayed) {
    const status = result.outboundId ? await request.withClient((client) => client.emailOutbound.findUnique({ where: { id: result.outboundId! }, select: { status: true } })) : null
    return { link: result.link, url: null, delivery: status ? (status.status === 'SENT' ? 'SENT' : status.status === 'FAILED' ? 'FAILED' : 'QUEUED') : null }
  }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { link: result.link, url, delivery: null }
  const text = linkFilesMail({ locale, companyName, secure: purpose === 'SECURE_FILE', fileNames: names, expiresAt: new Date(result.expiresAt), uses: result.maxUses, password: passwordHash !== null, renewal: false, message: body.message ?? null }, url).body
  const delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, text, sender?.name ?? null, auth.clock)
  return { link: result.link, url: null, delivery }
}

// ---- the link's session ------------------------------------------------------------------------------------------------

/** The request's link, when it is a set of files; anything else is the one 404. */
function fileLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (!PURPOSE_RULES[link.purpose].fileSet || link.record.type !== 'StoredFile') throw linkUnavailable()
  return link
}

const unlockKey = (request: FastifyRequest): Buffer => abuseKey(officeAuthOf(request.server).secrets, 'link-unlock')

interface ReadSet {
  readonly companyName: string
  readonly password: { readonly set: boolean; readonly tries: number; readonly heldUntil: Date | null }
  readonly receipt: { readonly at: Date; readonly name: string | null } | null
  readonly files: readonly SetFile[]
  readonly newer: ReadonlyMap<string, NewerVersion>
}

/** The link's set, its password state and receipt, and the newer versions, in the tenant's system scope. */
async function readSet(request: FastifyRequest, link: LinkSession): Promise<ReadSet> {
  const system = systemCallerOf(request)(link.tenantId)
  return system.withClient(async (client) => {
    const row = await client.oneOffLink.findUnique({
      where: { id: link.id },
      select: { partyId: true, passwordHash: true, passwordTries: true, passwordHeldUntil: true, receivedAt: true, receivedName: true, company: { select: { legalName: true, tradeName: true } } },
    })
    if (!row || row.partyId !== link.partyId) throw linkUnavailable()
    const rows = await client.linkFile.findMany({ where: { linkId: link.id }, orderBy: { position: 'asc' }, select: { position: true, file: { select: SET_FILE } } })
    let files: SetFile[] = rows.map((entry) => ({ ...entry.file, position: entry.position }))
    // A W0 link of one stored file (POST /links) has no set: its record is its one file.
    if (files.length === 0) {
      const own = await client.storedFile.findUnique({ where: { id: link.record.id }, select: SET_FILE })
      files = own ? [{ ...own, position: 1 }] : []
    }
    const shared = new Set(files.map((file) => file.id))
    const newer = new Map<string, NewerVersion>()
    for (const file of files) {
      if (file.supersededAt === null) continue
      const found = newerVersionOf(file, await seriesOf(client, file.seriesId ?? file.id), shared)
      if (found) newer.set(file.id, found)
    }
    return {
      companyName: row.company.tradeName ?? row.company.legalName,
      password: { set: row.passwordHash !== null, tries: row.passwordTries, heldUntil: row.passwordHeldUntil },
      receipt: row.receivedAt ? { at: row.receivedAt, name: row.receivedName } : null,
      files,
      newer,
    }
  })
}

const unlocked = (request: FastifyRequest, link: LinkSession, set: ReadSet, now: Date): boolean =>
  !set.password.set || unlockOpens(unlockKey(request), request.headers[UNLOCK_HEADER], link.id, now)

/** The password must have been given (its unlock key), else 403 in words (issue `password`). */
function requireUnlocked(request: FastifyRequest, link: LinkSession, set: ReadSet, now: Date): void {
  if (!unlocked(request, link, set, now)) throw new DomainError('forbidden', 'Type the password the sender gave you first.', [{ path: 'password', message: 'Required.' }])
}

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** GET /link/files. */
export async function linkFilesView(request: FastifyRequest) {
  const link = fileLinkOf(request)
  const now = officeAuthOf(request.server).clock.now()
  const set = await readSet(request, link)
  const open = unlocked(request, link, set, now)
  const rule = PURPOSE_RULES[link.purpose]
  return {
    link: {
      purpose: link.purpose,
      expiresAt: toUtcIso(link.expiresAt),
      usesLeft: Math.max(0, link.maxUses - link.uses),
      password: { asked: set.password.set, unlocked: set.password.set && open, heldUntil: set.password.heldUntil && passwordHeld(set.password, now) ? toUtcIso(set.password.heldUntil) : null },
      receipt: { asked: rule.receipt, at: iso(set.receipt?.at ?? null), name: set.receipt?.name ?? null },
    },
    sender: { companyName: set.companyName },
    count: set.files.length,
    files: open
      ? set.files.map((file) => {
          const newer = set.newer.get(file.id) ?? null
          return {
            id: file.id,
            position: file.position,
            name: file.originalName,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            contentType: file.contentType,
            preview: link.purpose === 'DOCUMENT_VIEW' && previewModeOf(file.contentType) === 'inline' ? ('inline' as const) : null,
            available: file.status === 'AVAILABLE',
            newer: newer ? { versionNo: newer.versionNo, replacedAt: toUtcIso(newer.replacedAt), sharedFileId: newer.sharedFileId, words: newerVersionWords(newer) } : null,
          }
        })
      : [],
  }
}

/** POST /link/password (see the file's comment). Wrong: 400 at `body/password` in words; held: 429 with Retry-After. */
export async function checkLinkPassword(request: FastifyRequest, reply: FastifyReply, password: string, idempotencyKey?: string) {
  const link = fileLinkOf(request)
  const clock = officeAuthOf(request.server).clock
  const system = systemCallerOf(request)(link.tenantId)
  const stored = await system.withClient((client) => client.oneOffLink.findUnique({ where: { id: link.id }, select: { passwordHash: true, passwordTries: true, passwordHeldUntil: true } }))
  if (!stored?.passwordHash) throw new LinkRefusedError('NO_PASSWORD', 'This link has no password: its files are listed as they are.')
  const before = { tries: stored.passwordTries, heldUntil: stored.passwordHeldUntil }
  const heldNow = passwordStep(before, false, clock.now())
  if (heldNow.kind === 'held') return refuseHeld(reply, heldNow.until, clock.now())
  // The slow check runs outside any transaction; its outcome is applied under the link's row lock.
  const check = await verifyPassword(password, stored.passwordHash)

  const { result } = await linkCommand(request, { name: 'links.password', idempotencyKey, input: { attempt: true } }, async ({ tx, now, audit }) => {
    const [row] = await tx.$queryRaw<{ passwordTries: number; passwordHeldUntil: Date | null }[]>`SELECT "passwordTries", "passwordHeldUntil" FROM "OneOffLink" WHERE id = ${link.id}::uuid FOR UPDATE`
    if (!row) throw linkUnavailable()
    const step = passwordStep({ tries: row.passwordTries, heldUntil: row.passwordHeldUntil }, check.ok, now)
    if (step.kind === 'held') return { kind: 'held' as const, until: toUtcIso(step.until), words: passwordWords(step, now) }
    if (step.kind === 'right') {
      if (step.next) await tx.oneOffLink.updateMany({ where: { id: link.id }, data: { passwordTries: 0, passwordHeldUntil: null } })
      // Every command is audited: when the files were opened with the password (never the password).
      audit({ action: 'links.passwordRight', recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { triesBefore: row.passwordTries } })
      return { kind: 'right' as const, until: null, words: null }
    }
    await tx.oneOffLink.updateMany({ where: { id: link.id }, data: { passwordTries: step.next.tries, passwordHeldUntil: step.next.heldUntil } })
    audit({ action: 'links.passwordWrong', recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { tries: step.next.tries, heldUntil: iso(step.next.heldUntil) } })
    return { kind: step.triesLeft > 0 ? ('wrong' as const) : ('held' as const), until: iso(step.next.heldUntil), words: passwordWords(step, now) }
  })
  if (result.kind === 'held') return refuseHeld(reply, new Date(result.until!), clock.now(), result.words)
  if (result.kind === 'wrong') throw new ValidationError(result.words!, [{ path: 'body/password', message: result.words! }])
  const unlock = mintUnlock(unlockKey(request), link.id, clock.now(), link.expiresAt)
  return { unlock: unlock.value, unlockedUntil: toUtcIso(unlock.until) }
}

function refuseHeld(reply: FastifyReply, until: Date, now: Date, words?: string | null): never {
  const seconds = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000))
  void reply.header('retry-after', String(seconds))
  const message = words ?? passwordWords({ kind: 'held', until }, now)
  throw new DomainError('rate_limited', message, [{ path: 'password/HELD', message: toUtcIso(until) }, { path: 'retryAfter', message: String(seconds) }])
}

/** One file of the set, available, behind the password. */
async function fileOfSet(request: FastifyRequest, fileId: string) {
  const link = fileLinkOf(request)
  const now = officeAuthOf(request.server).clock.now()
  const set = await readSet(request, link)
  requireUnlocked(request, link, set, now)
  const file = set.files.find((entry) => entry.id === fileId)
  if (!file) throw new NotFoundError('File not found.')
  if (file.status !== 'AVAILABLE') throw new InvalidStateError('This file is no longer available. Ask the sender for it.')
  return { link, file, system: systemCallerOf(request)(link.tenantId) }
}

/** The key the link is shown: a picture only as its stripped copy. Made before the use counts, so a refusal uses nothing. */
const shownKey = (request: FastifyRequest, system: CommandCaller, file: SetFile) => keyShownTo(processFiles(), requireContext(request), system, file)

/** POST /link/files/:fileId/download. */
export async function downloadSetFile(request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const { link, file, system } = await fileOfSet(request, fileId)
  const key = await shownKey(request, system, file)
  const { result } = await linkCommand(request, { name: 'links.downloadFile', idempotencyKey, input: { fileId } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'download' })
    tools.audit({ action: 'links.downloadFile', recordType: 'StoredFile', recordId: file.id, companyId: file.companyId ?? link.companyId, after: { linkId: link.id, evidenceId: use.evidenceId, counted: use.counted, useNumber: use.useNumber } })
    return { usesLeft: use.usesLeft }
  })
  const runtime = processFiles()
  const download = await storeCall(() =>
    runtime.storage.presignDownload(system, file.storeAccountId, { key, contentType: file.contentType, disposition: attachmentDisposition(file.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: runtime.clock.now() }),
  )
  return { fileId: file.id, name: file.originalName, usesLeft: result.usesLeft, download: presignedView(download) }
}

/** GET /link/files/:fileId/preview: DOCUMENT_VIEW, a PDF or a picture, in the page; reading uses nothing. */
export async function previewSetFile(request: FastifyRequest, fileId: string) {
  const { link, file, system } = await fileOfSet(request, fileId)
  if (link.purpose !== 'DOCUMENT_VIEW') throw new LinkRefusedError('NO_PREVIEW', 'These files are never shown in the browser: download them.')
  if (previewModeOf(file.contentType) !== 'inline') throw new LinkRefusedError('NO_PREVIEW', 'This file cannot be shown in the page: download it.')
  const key = await shownKey(request, system, file)
  const runtime = processFiles()
  const preview = await storeCall(() =>
    runtime.storage.presignDownload(system, file.storeAccountId, { key, contentType: file.contentType, disposition: dispositionOf('inline', file.originalName), expiresInSeconds: PREVIEW_URL_SECONDS, now: runtime.clock.now() }),
  )
  return { fileId: file.id, mode: 'inline' as const, preview: presignedView(preview) }
}

/** POST /link/files/received: "I received these files" (SECURE_FILE), once. */
export async function confirmReceipt(request: FastifyRequest, body: { readonly typedName?: string | undefined }, idempotencyKey?: string) {
  const link = fileLinkOf(request)
  if (!PURPOSE_RULES[link.purpose].receipt) throw new ForbiddenError('This link takes no receipt.')
  const now = officeAuthOf(request.server).clock.now()
  const set = await readSet(request, link)
  requireUnlocked(request, link, set, now)
  if (set.receipt) throw new LinkRefusedError('RECEIVED', `You confirmed it already, on ${toUtcIso(set.receipt.at)}.`)
  const { result } = await linkCommand(request, { name: 'links.receive', idempotencyKey, input: { typedName: body.typedName ?? null } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'receive', typedName: body.typedName })
    const { count } = await tools.tx.oneOffLink.updateMany({ where: { id: link.id, receivedAt: null, revokedAt: null }, data: { receivedAt: tools.now, receivedName: use.typedName } })
    if (count !== 1) throw new LinkRefusedError('RECEIVED', 'You confirmed it already.')
    return { receipt: { at: toUtcIso(tools.now), name: use.typedName } }
  })
  return result
}
