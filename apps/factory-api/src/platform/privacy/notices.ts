import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  defaultLabel,
  isLocale,
  labelProblems,
  nextVersionNo,
  noticeFingerprint,
  normaliseNoticeBody,
  publishProblems,
  textProblems,
  NOTICE_KIND_WORDS,
  type NoticeKind,
} from '@nexus/factory-domain/privacy/notices'
import { PRIVACY_MANAGE, PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import type { OfficeContext } from '../../core/context'
import { retainFilesInCommand } from '../files/files'
import { assertMay, companyFor, lockPrivacy, mayOn, officeOf, refuse } from './access'
import type { NoticeView } from './contract'

/**
 * A company's privacy notices in their versions and languages (B-W1-36; A2 SCR-086 Admin › Privacy & notices; GDPR art.
 * 13; Statuto dei Lavoratori art. 4 c.3; PLT-208, MES-277, GAP-005; Q15), for the office: privacy.view to read,
 * privacy.manage to write, over the notice's company.
 *
 *   draft      one DRAFT per company and kind at a time; its number is the next one; it starts from the texts of the
 *              version in force (not its PDFs: a PDF belongs to its version). Deleted while a DRAFT only.
 *   languages  a text per language (Italian and English on screens, Q15) and/or a PDF (platform/privacy files.ts); each
 *              with the SHA-256 of what is shown. Only while a DRAFT (the notice's version is the edit guard).
 *   publish    a fresh code (step-up), then ONE command: the version in force is SUPERSEDED, this one PUBLISHED and frozen,
 *              its PDFs kept ten years, the event privacy.notice_published. For the worker notice every worker must
 *              acknowledge it before their next scan (the floor's gate and the database's rule).
 *   paper      a worker's signed paper copy of the version in force, recorded by the office (channel PAPER).
 * The …_privacy_guards triggers hold the same for every login.
 */

/** How long a published notice's PDFs are kept: acknowledgements name them (accountability, GDPR art. 5(2)). */
export const NOTICE_FILE_RETENTION_YEARS = 10

export const NOTICE_SELECT = {
  id: true,
  companyId: true,
  kind: true,
  versionNo: true,
  label: true,
  status: true,
  publishedAt: true,
  publishedById: true,
  supersededAt: true,
  version: true,
  texts: { select: { locale: true, body: true, fileId: true, sha256: true }, orderBy: { locale: 'asc' } },
} as const satisfies Prisma.PrivacyNoticeSelect

export type NoticeRow = Prisma.PrivacyNoticeGetPayload<{ select: typeof NOTICE_SELECT }>
type Reader = Pick<CommandTx, 'privacyNotice' | 'worker' | 'user'>

/** Who should acknowledge a version and who did: workers of the company (worker notice) or office people (staff notice). */
async function ackCounts(db: Reader, row: Pick<NoticeRow, 'id' | 'companyId' | 'kind'>) {
  if (row.kind === 'WORKER_FLOOR') {
    const active = await db.worker.count({ where: { companyId: row.companyId, status: 'ACTIVE' } })
    const acknowledged = await db.worker.count({ where: { companyId: row.companyId, status: 'ACTIVE', noticeAcks: { some: { noticeId: row.id } } } })
    return { active, acknowledged, notAcknowledged: active - acknowledged }
  }
  if (row.kind === 'OFFICE_STAFF') {
    const active = await db.user.count({ where: { status: 'ACTIVE' } })
    const acknowledged = await db.user.count({ where: { status: 'ACTIVE', staffNoticeAcks: { some: { noticeId: row.id } } } })
    return { active, acknowledged, notAcknowledged: active - acknowledged }
  }
  return null
}

export async function noticeViewOf(db: Reader, row: NoticeRow, withBodies: boolean): Promise<NoticeView> {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    versionNo: row.versionNo,
    label: row.label,
    status: row.status,
    publishedAt: row.publishedAt ? toUtcIso(row.publishedAt) : null,
    publishedById: row.publishedById,
    supersededAt: row.supersededAt ? toUtcIso(row.supersededAt) : null,
    version: row.version,
    languages: row.texts.map((text) => ({ locale: text.locale, body: withBodies ? text.body : null, hasText: text.body !== null, fileId: text.fileId, sha256: text.sha256 })),
    acknowledgements: await ackCounts(db, row),
  }
}

const readRow = (db: Pick<CommandTx, 'privacyNotice'>, noticeId: string) => db.privacyNotice.findUnique({ where: { id: noticeId }, select: NOTICE_SELECT })

/** The notice, when the caller may know it (404) and do `permission` on it (403). */
export async function readNotice(caller: CommandCaller, noticeId: string, permission: typeof PRIVACY_VIEW | typeof PRIVACY_MANAGE): Promise<{ context: OfficeContext; row: NoticeRow }> {
  const context = officeOf(caller)
  const row = isUuid(noticeId) ? await caller.withClient((client) => readRow(client, noticeId)) : null
  if (!row) throw new NotFoundError('Notice not found.')
  assertMay(context, permission, row.companyId, 'Notice not found.')
  return { context, row }
}

const assertDraft = (row: Pick<NoticeRow, 'status' | 'label'>): void => {
  if (row.status !== 'DRAFT') throw new InvalidStateError(`Version ${row.label} is ${row.status.toLowerCase()}: its texts never change. Make a new version.`)
}

const answer = async (tx: CommandTx, noticeId: string) => ({ notice: await noticeViewOf(tx, (await readRow(tx, noticeId))!, true) })

/** privacy.view: a company's notice versions (newest first per kind), without their texts. */
export async function listNotices(caller: CommandCaller, query: { companyId: string; kind?: NoticeKind | undefined }) {
  const { company } = await companyFor(caller, query.companyId, PRIVACY_VIEW)
  return caller.withClient(async (client) => {
    const rows = await client.privacyNotice.findMany({ where: { companyId: company.id, ...(query.kind ? { kind: query.kind } : {}) }, select: NOTICE_SELECT, orderBy: [{ kind: 'asc' }, { versionNo: 'desc' }] })
    const notices: NoticeView[] = []
    for (const row of rows) notices.push(await noticeViewOf(client, row, false))
    return { company, notices }
  })
}

/** privacy.view: one version with its texts, PDFs, fingerprints and acknowledgement counts. */
export async function getNotice(caller: CommandCaller, noticeId: string) {
  const { row } = await readNotice(caller, noticeId, PRIVACY_VIEW)
  return { notice: await caller.withClient((client) => noticeViewOf(client, row, true)) }
}

/** privacy.manage: a new DRAFT version, numbered next, from the texts of the version in force unless told otherwise. */
export async function createNotice(caller: CommandCaller, body: { companyId: string; kind: NoticeKind; label?: string | undefined; copyTexts?: boolean | undefined }, idempotencyKey?: string) {
  const { context, company } = await companyFor(caller, body.companyId, PRIVACY_MANAGE)
  if (body.label !== undefined) refuse(labelProblems(body.label), 'The label is not valid.')
  const { result } = await command(caller, { name: 'privacy.createNotice', idempotencyKey, input: body }, async (tools) => {
    await lockPrivacy(tools, `notice:${body.kind}`, company.id)
    const existing = await tools.tx.privacyNotice.findMany({ where: { companyId: company.id, kind: body.kind }, select: { id: true, versionNo: true, label: true, status: true } })
    const draft = existing.find((row) => row.status === 'DRAFT')
    if (draft) throw new ConflictError(`Version ${draft.label} of ${NOTICE_KIND_WORDS[body.kind]} is still a draft: edit it, publish it or delete it first.`)
    const versionNo = nextVersionNo(existing.map((row) => row.versionNo))
    const label = body.label?.trim() || defaultLabel(versionNo)
    if (existing.some((row) => row.label === label)) throw new ConflictError(`${NOTICE_KIND_WORDS[body.kind]} already has a version ${label}; choose another label.`)
    const id = newId()
    await tools.tx.privacyNotice.create({ data: { id, companyId: company.id, kind: body.kind, versionNo, label, createdById: context.actorId }, select: { id: true } })
    const inForce = existing.find((row) => row.status === 'PUBLISHED')
    const copied: string[] = []
    if (inForce && body.copyTexts !== false) {
      const texts = await tools.tx.privacyNoticeText.findMany({ where: { noticeId: inForce.id, body: { not: null } }, select: { locale: true, body: true, sha256: true }, orderBy: { locale: 'asc' } })
      for (const text of texts) {
        await tools.tx.privacyNoticeText.create({ data: { id: newId(), noticeId: id, locale: text.locale, body: text.body, sha256: text.sha256, createdById: context.actorId }, select: { id: true } })
        copied.push(text.locale)
      }
    }
    tools.audit({ recordType: 'PrivacyNotice', recordId: id, companyId: company.id, after: { kind: body.kind, versionNo, label, status: 'DRAFT', copiedFrom: inForce && copied.length > 0 ? inForce.id : null, languages: copied } })
    return answer(tools.tx, id)
  })
  return result
}

/** One command on a DRAFT notice at the version the caller read. */
async function draftCommand<T>(caller: CommandCaller, row: NoticeRow, spec: { name: `privacy.${string}`; input: unknown; version: number | undefined; idempotencyKey?: string | undefined }, work: (tools: CommandTools) => Promise<T>) {
  assertDraft(row)
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'PrivacyNotice', id: row.id, expectedVersion: spec.version } }, async (tools) => {
    const now = await tools.tx.privacyNotice.findUnique({ where: { id: row.id }, select: { status: true, label: true } })
    if (!now) throw new NotFoundError('Notice not found.')
    assertDraft(now)
    return work(tools)
  })
  return result
}

/** privacy.manage: the text of one language of a DRAFT (replaces it; its PDF stays). */
export async function putText(caller: CommandCaller, noticeId: string, locale: string, body: { body: string; version: number }, idempotencyKey?: string) {
  refuse(textProblems({ locale, body: body.body }), 'The text is not valid.')
  const { context, row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  const text = normaliseNoticeBody(body.body)
  const sha256 = noticeFingerprint(text)
  return draftCommand(caller, row, { name: 'privacy.writeNoticeText', input: { noticeId, locale, body: text }, version: body.version, idempotencyKey }, async (tools) => {
    const existing = await tools.tx.privacyNoticeText.findFirst({ where: { noticeId, locale }, select: { id: true, sha256: true } })
    if (existing) await tools.tx.privacyNoticeText.update({ where: { id: existing.id }, data: { body: text, sha256 }, select: { id: true } })
    else await tools.tx.privacyNoticeText.create({ data: { id: newId(), noticeId, locale, body: text, sha256, createdById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: 'PrivacyNotice', recordId: noticeId, companyId: row.companyId, before: existing ? { locale, sha256: existing.sha256 } : null, after: { locale, sha256, characters: text.length } })
    return answer(tools.tx, noticeId)
  })
}

/** privacy.manage: removes one language (its text and PDF) from a DRAFT. */
export async function deleteText(caller: CommandCaller, noticeId: string, locale: string, version: number, idempotencyKey?: string) {
  const { row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  if (!isLocale(locale) || !row.texts.some((text) => text.locale === locale)) throw new NotFoundError(`Version ${row.label} has no language ${locale}.`)
  return draftCommand(caller, row, { name: 'privacy.deleteNoticeText', input: { noticeId, locale }, version, idempotencyKey }, async (tools) => {
    const { count } = await tools.tx.privacyNoticeText.deleteMany({ where: { noticeId, locale } })
    if (count !== 1) throw new ConflictError('This language was just removed; reload the notice.')
    tools.audit({ recordType: 'PrivacyNotice', recordId: noticeId, companyId: row.companyId, before: { locale }, after: null })
    return answer(tools.tx, noticeId)
  })
}

/** privacy.manage: deletes a DRAFT version and its languages (a published one is kept: acknowledgements name it). */
export async function deleteNotice(caller: CommandCaller, noticeId: string, version: number, idempotencyKey?: string) {
  const { row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  return draftCommand(caller, row, { name: 'privacy.deleteNotice', input: { noticeId }, version, idempotencyKey }, async (tools) => {
    await tools.tx.privacyNoticeText.deleteMany({ where: { noticeId } })
    await tools.tx.privacyNotice.delete({ where: { id: noticeId }, select: { id: true } })
    tools.audit({ recordType: 'PrivacyNotice', recordId: noticeId, companyId: row.companyId, before: { kind: row.kind, versionNo: row.versionNo, label: row.label, status: 'DRAFT' }, after: null })
    return { deleted: true as const }
  })
}

const publishWords = (kind: NoticeKind, label: string): string[] => {
  if (kind === 'WORKER_FLOOR') return [`Version ${label} is in force. Every worker reads and acknowledges it on the tablet at their next sign-in; until then no scan or cut log names them (L. 300/1970 art. 4 c.3).`]
  if (kind === 'OFFICE_STAFF') return [`Version ${label} is in force. Each office person sees it once at their next sign-in.`]
  return [`Version ${label} is in force at the company's public address, linked from every link page and e-mail.`]
}

/**
 * privacy.manage + a fresh code: the DRAFT comes into force. Its languages are checked first (400 with every missing one,
 * no code asked); then ONE command: the version in force is superseded, this one published and frozen, its PDFs kept.
 */
export async function publishNotice(caller: CommandCaller, noticeId: string, body: { version: number }, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined }) {
  const { context, row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  const problems = publishProblems({ kind: row.kind, status: row.status, languages: row.texts.map((text) => ({ locale: text.locale, hasBody: text.body !== null, hasPdf: text.fileId !== null })) })
  if (row.status !== 'DRAFT') throw new InvalidStateError(problems[0]!.message)
  if (problems.length > 0) throw new DomainError('invalid_state', `Version ${row.label} cannot be published yet.`, problems)
  options.stepUp()
  const { result } = await command(
    caller,
    { name: 'privacy.publishNotice', idempotencyKey: options.idempotencyKey, input: { noticeId, ...body }, record: { type: 'PrivacyNotice', id: noticeId, expectedVersion: body.version } },
    async (tools) => {
      await lockPrivacy(tools, `notice:${row.kind}`, row.companyId)
      const now = (await readRow(tools.tx, noticeId))!
      assertDraft(now)
      const previous = await tools.tx.privacyNotice.findFirst({ where: { companyId: row.companyId, kind: row.kind, status: 'PUBLISHED' }, select: { id: true, label: true, versionNo: true } })
      if (previous && previous.versionNo > now.versionNo) throw new ConflictError(`A later version (${previous.label}) is already in force.`)
      if (previous) {
        await tools.tx.privacyNotice.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', supersededAt: tools.now, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'privacy.supersedeNotice', recordType: 'PrivacyNotice', recordId: previous.id, companyId: row.companyId, before: { status: 'PUBLISHED' }, after: { status: 'SUPERSEDED', supersededBy: noticeId } })
      }
      await tools.tx.privacyNotice.update({ where: { id: noticeId }, data: { status: 'PUBLISHED', publishedAt: tools.now, publishedById: context.actorId }, select: { id: true } })
      const files = now.texts.flatMap((text) => (text.fileId ? [text.fileId] : []))
      if (files.length > 0) {
        const until = new Date(tools.now)
        until.setUTCFullYear(until.getUTCFullYear() + NOTICE_FILE_RETENTION_YEARS)
        await retainFilesInCommand(tools, files, until, `A published privacy notice is kept ${NOTICE_FILE_RETENTION_YEARS} years: acknowledgements name it (GDPR art. 5(2)).`)
      }
      tools.audit({
        recordType: 'PrivacyNotice',
        recordId: noticeId,
        companyId: row.companyId,
        before: { status: 'DRAFT' },
        after: { status: 'PUBLISHED', kind: row.kind, label: now.label, languages: now.texts.map((text) => ({ locale: text.locale, sha256: text.sha256 })), superseded: previous?.id ?? null },
      })
      tools.emit({
        type: 'privacy.notice_published',
        subject: noticeId,
        companyId: row.companyId,
        payload: { noticeId, companyId: row.companyId, kind: row.kind, versionNo: now.versionNo, label: now.label, supersededId: previous?.id ?? null },
      })
      return { ...(await answer(tools.tx, noticeId)), superseded: previous ? { id: previous.id, label: previous.label } : null, words: publishWords(row.kind, now.label) }
    },
  )
  return result
}

/**
 * privacy.view: who acknowledged a version: counts for every viewer; by name only with privacy.manage (never read
 * otherwise), sorted by name: no order here says anything about what a person did.
 */
export async function noticeAcks(caller: CommandCaller, noticeId: string) {
  const { context, row } = await readNotice(caller, noticeId, PRIVACY_VIEW)
  const withNames = mayOn(context, PRIVACY_MANAGE, row.companyId)
  return caller.withClient(async (client) => {
    const counts = await ackCounts(client, row)
    let people: { id: string; displayName: string; siteId: string | null; acknowledgedAt: string | null; channel: 'DEVICE' | 'PAPER' | 'OFFICE' | null; locale: string | null }[] | null = null
    if (withNames && row.kind === 'WORKER_FLOOR') {
      const workers = await client.worker.findMany({
        where: { companyId: row.companyId, status: 'ACTIVE' },
        select: { id: true, displayName: true, siteId: true, noticeAcks: { where: { noticeId }, select: { serverTime: true, channel: true, locale: true }, take: 1 } },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      })
      people = workers.map((worker) => {
        const ack = worker.noticeAcks[0]
        return { id: worker.id, displayName: worker.displayName, siteId: worker.siteId, acknowledgedAt: ack ? toUtcIso(ack.serverTime) : null, channel: ack?.channel ?? null, locale: ack?.locale ?? null }
      })
    } else if (withNames && row.kind === 'OFFICE_STAFF') {
      const users = await client.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, displayName: true, staffNoticeAcks: { where: { noticeId }, select: { serverTime: true, locale: true }, take: 1 } },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      })
      people = users.map((user) => {
        const ack = user.staffNoticeAcks[0]
        return { id: user.id, displayName: user.displayName, siteId: null, acknowledgedAt: ack ? toUtcIso(ack.serverTime) : null, channel: ack ? ('OFFICE' as const) : null, locale: ack?.locale ?? null }
      })
    }
    return { notice: { id: row.id, kind: row.kind, label: row.label, status: row.status }, counts, people }
  })
}

/**
 * privacy.manage over the worker's company and site: a worker's signed paper copy of the worker notice in force, in the
 * language they signed (a text or a PDF of the version), recorded by the office (channel PAPER). The same worker and
 * version again changes nothing.
 */
export async function paperAck(caller: CommandCaller, noticeId: string, body: { workerId: string; locale: string }, idempotencyKey?: string) {
  const { context, row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  if (row.kind !== 'WORKER_FLOOR') throw new InvalidStateError('Only the worker notice is acknowledged on paper here.')
  if (row.status !== 'PUBLISHED') throw new InvalidStateError(`Version ${row.label} is not in force: a signed copy is recorded for the version in force.`)
  const text = row.texts.find((entry) => entry.locale === body.locale)
  if (!text) throw new DomainError('validation_failed', `Version ${row.label} has no language ${body.locale}.`, [{ path: 'body/locale', message: `Languages: ${row.texts.map((entry) => entry.locale).join(', ')}.` }])
  const worker = await caller.withClient((client) => client.worker.findUnique({ where: { id: body.workerId }, select: { id: true, siteId: true, companyId: true, status: true } }))
  if (!worker || worker.companyId !== row.companyId || !mayOn(context, PRIVACY_VIEW, worker.companyId, worker.siteId)) throw new NotFoundError('Worker not found.')
  if (!mayOn(context, PRIVACY_MANAGE, worker.companyId, worker.siteId)) throw new ForbiddenError()
  if (worker.status !== 'ACTIVE') throw new InvalidStateError('This worker is not active.')
  const { result } = await command(caller, { name: 'privacy.recordPaperAck', idempotencyKey, input: { noticeId, ...body } }, async (tools) => {
    const existing = await tools.tx.workerNoticeAck.findFirst({ where: { workerId: worker.id, noticeId }, select: { id: true } })
    if (existing) {
      tools.audit({ recordType: 'WorkerNoticeAck', recordId: existing.id, companyId: row.companyId, siteId: worker.siteId, after: { unchanged: true } })
      return { acknowledgementId: existing.id, changed: false }
    }
    const inForce = await tools.tx.privacyNotice.findUnique({ where: { id: noticeId }, select: { status: true } })
    if (inForce?.status !== 'PUBLISHED') throw new ConflictError('A later version came into force meanwhile; record the copy of that one.')
    const id = newId()
    await tools.tx.workerNoticeAck.create({
      data: { id, siteId: worker.siteId, workerId: worker.id, noticeId, noticeVersion: row.label, locale: body.locale, noticeSha256: text.sha256, channel: 'PAPER', createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: 'WorkerNoticeAck', recordId: id, companyId: row.companyId, siteId: worker.siteId, after: { workerId: worker.id, noticeId, label: row.label, locale: body.locale, sha256: text.sha256, channel: 'PAPER' } })
    tools.emit({ type: 'privacy.notice_acknowledged', subject: noticeId, companyId: row.companyId, siteId: worker.siteId, payload: { noticeId, kind: row.kind, channel: 'PAPER' } })
    return { acknowledgementId: id, changed: true }
  })
  return result
}
