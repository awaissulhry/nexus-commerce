import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { RULES_MANAGE } from '@nexus/factory-domain/compliance/register-of-rules/permissions'
import {
  assessRefusal,
  impactTask,
  reviewChangeEntry,
  standardLabel,
  TOUCHED_CERTIFICATE_STATUSES,
  type Locale,
  type StandardChangeImpact,
  type StandardChangeKind,
  type StandardChangeStatus,
} from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { createTask } from '../../../platform/tasks/tasks'
import { assertMayKeep, officeOf, rulesClock, rulesGuarded } from './common'
import type { ChangeView } from './contract'
import { CHANGE_SELECT, changeViews, stylesCovered, todayOf, touchedCertificates, type ChangeRow } from './store'

/**
 * The harmonised-standard watch (B-W2b-249; PRD-274; PPE Reg. (EU) 2016/425 Annex V 7.1-7.3: the notified body keeps
 * itself apprised of the state of the art and is told of what may affect the approved type; met by people, as today).
 * Nobody reads the Official Journal or NANDO for the factory (no paid feed, GATE-SPEND): a person records a change they
 * noticed, or the register raises one when an entry is superseded or withdrawn (register.ts). A change names, when it is
 * raised, the registered certificates in force that cite the standard (more can be added while it is open).
 *
 *   assess   OPEN → ASSESSED: the impact (NONE | REVIEW | RETEST) and the assessment in words, filed once. With REVIEW or
 *            RETEST, W2a's type-change review opens for each certificate the person names, on the current revision of
 *            every style it covers (its RELEASED revision, else the newest) — and holds that revision's class label until
 *            the review is decided (W2a's rule, modules/compliance/type-changes).
 *   task     the impact task (platform/tasks): what changed, the transition's end, one checklist item per affected style;
 *            named once on the change.
 *   close    ASSESSED → CLOSED; frozen from then on (the database's rule).
 *
 * Each move is ONE command on the change's version with its audit row and `compliance_rules.change_moved` (raising:
 * `compliance_rules.change_raised`). compliance.rules.manage over every company (the watch is the tenant's).
 */

const WHAT = 'The watch on standards'
const settings = () => ({ ...COMMAND_SETTINGS, clock: rulesClock() })
const dateOf = (value: BusinessDate | null): Date | null => (value === null ? null : new Date(`${value}T00:00:00.000Z`))

/** A move refused by its rule: 409 with `refusal/<CODE>`. */
const refused = (refusal: { code: string; message: string }) => new DomainError('conflict', refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])

export interface RaiseInput {
  readonly kind: StandardChangeKind
  readonly whatChanged: string
  readonly sourceReference: string | null
  readonly transitionEndsOn: BusinessDate | null
  readonly newStandardId: string | null
  readonly raisedBy: 'PERSON' | 'REGISTER'
}

/** Inside a command: records a change of the entry, naming the registered certificates in force that cite it. */
export async function raiseChangeInCommand(tools: CommandTools, entry: { readonly id: string; readonly code: string; readonly edition: string | null }, input: RaiseInput): Promise<ChangeRow> {
  const { tx, now, audit, emit } = tools
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const certificates = await touchedCertificates(tx, entry)
  const id = newId()
  const row = await tx.standardChange.create({
    data: {
      id,
      standardId: entry.id,
      newStandardId: input.newStandardId,
      kind: input.kind,
      whatChanged: input.whatChanged,
      sourceReference: input.sourceReference,
      noticedAt: now,
      noticedById: actorId,
      transitionEndsOn: dateOf(input.transitionEndsOn),
      certificateIds: certificates.map((certificate) => certificate.id),
      createdAt: now,
      updatedAt: now,
      createdById: actorId,
    },
    select: CHANGE_SELECT,
  })
  audit({
    action: 'compliance.rules.raiseChange',
    recordType: 'StandardChange',
    recordId: id,
    companyId: null,
    after: { standardId: entry.id, standard: standardLabel(entry.code, entry.edition), kind: input.kind, raisedBy: input.raisedBy, certificateIds: row.certificateIds, newStandardId: input.newStandardId, transitionEndsOn: input.transitionEndsOn },
  })
  emit({ type: 'compliance_rules.change_raised', subject: id, companyId: null, payload: { changeId: id, standardId: entry.id, kind: input.kind, raisedBy: input.raisedBy, certificates: certificates.length } })
  return row
}

// ---- reads ------------------------------------------------------------------------------------------------------------

/** GET /compliance/rules/standard-changes */
export async function listChanges(request: FastifyRequest, query: { readonly status?: StandardChangeStatus | undefined; readonly standardId?: string | undefined; readonly open?: 'true' | 'false' | undefined }) {
  officeOf(request)
  const now = rulesClock().now()
  const filters: Prisma.StandardChangeWhereInput[] = []
  if (query.status) filters.push({ status: query.status })
  if (query.standardId) filters.push({ standardId: query.standardId })
  if (query.open === 'true') filters.push({ status: { not: 'CLOSED' } })
  if (query.open === 'false') filters.push({ status: 'CLOSED' })
  const changes = await request.withClient(async (db) => {
    const rows = await db.standardChange.findMany({ where: { AND: filters }, select: CHANGE_SELECT, orderBy: [{ noticedAt: 'desc' }, { id: 'desc' }], take: 500 })
    return changeViews(db, rows, todayOf(now))
  })
  // Open first, the transition ending soonest first; then the closed ones, newest first.
  const rank = (change: ChangeView) => (change.status === 'CLOSED' ? 1 : 0)
  changes.sort((a, b) => rank(a) - rank(b) || (a.status !== 'CLOSED' ? (a.transitionEndsOn ?? '9999-12-31').localeCompare(b.transitionEndsOn ?? '9999-12-31') : 0) || b.noticedAt.localeCompare(a.noticedAt))
  return { changes, asOf: toUtcIso(now) }
}

/** GET /compliance/rules/standard-changes/:changeId */
export async function getChange(request: FastifyRequest, changeId: string) {
  officeOf(request)
  const now = rulesClock().now()
  return request.withClient(async (db) => {
    const row = await db.standardChange.findUnique({ where: { id: changeId }, select: CHANGE_SELECT })
    if (!row) throw new NotFoundError('There is no such change in the watch.')
    return { change: (await changeViews(db, [row], todayOf(now)))[0]!, asOf: toUtcIso(now) }
  })
}

// ---- writes -----------------------------------------------------------------------------------------------------------

export interface RecordBody {
  readonly kind: StandardChangeKind
  readonly whatChanged: string
  readonly sourceReference?: string | null | undefined
  readonly transitionEndsOn?: BusinessDate | null | undefined
  readonly newStandardId?: string | null | undefined
}

/** POST /compliance/rules/standards/:standardId/changes — a change a person noticed. */
export async function recordChange(caller: CommandCaller, standardId: string, body: RecordBody, key: string | null | undefined): Promise<{ change: ChangeView }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  if (body.newStandardId === standardId) throw new ValidationError('The change is not valid.', [{ path: 'body/newStandardId', message: 'The new edition is another entry of the register, not the standard itself.' }])
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.recordChange', idempotencyKey: key, input: { standardId, ...body } },
      async (tools) => {
        const entry = await tools.tx.regulationOrStandard.findUnique({ where: { id: standardId }, select: { id: true, code: true, edition: true } })
        if (!entry) throw new NotFoundError('There is no such entry in the register.')
        if (body.newStandardId && !(await tools.tx.regulationOrStandard.findUnique({ where: { id: body.newStandardId }, select: { id: true } }))) {
          throw new ValidationError('The change is not valid.', [{ path: 'body/newStandardId', message: 'Name an entry of the register (add the new edition first).' }])
        }
        const row = await raiseChangeInCommand(tools, entry, {
          kind: body.kind,
          whatChanged: body.whatChanged,
          sourceReference: body.sourceReference ?? null,
          transitionEndsOn: body.transitionEndsOn ?? null,
          newStandardId: body.newStandardId ?? null,
          raisedBy: 'PERSON',
        })
        return { change: (await changeViews(tools.tx, [row], todayOf(tools.now)))[0]! }
      },
      settings(),
    ),
  )
  return result
}

/** The change locked, at the version read; refused in words when it is CLOSED. */
async function lockedChange(tools: CommandTools, changeId: string): Promise<ChangeRow> {
  const row = await tools.tx.standardChange.findUniqueOrThrow({ where: { id: changeId }, select: CHANGE_SELECT })
  if (row.status === 'CLOSED') throw refused({ code: 'CLOSED', message: 'This change is closed: it never changes.' })
  return row
}

function moved(tools: CommandTools, row: ChangeRow, move: 'ASSESSED' | 'TASK' | 'CERTIFICATES' | 'CLOSED'): void {
  tools.emit({
    type: 'compliance_rules.change_moved',
    subject: row.id,
    companyId: null,
    payload: { changeId: row.id, standardId: row.standardId, status: row.status as StandardChangeStatus, impact: (row.impact ?? null) as StandardChangeImpact | null, move, taskId: row.taskId, reviews: row.typeChangeReviewIds.length },
  })
}

export interface AssessBody {
  readonly version: number
  readonly impact: StandardChangeImpact
  readonly assessment: string
  readonly reviewCertificateIds?: readonly string[] | undefined
}

/** POST /compliance/rules/standard-changes/:changeId/assess */
export async function assessChange(caller: CommandCaller, changeId: string, body: AssessBody, key: string | null | undefined): Promise<{ change: ChangeView }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  const reviewFor = [...new Set(body.reviewCertificateIds ?? [])]
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.assessChange', idempotencyKey: key, input: { changeId, ...body }, record: { type: 'StandardChange', id: changeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        const row = await lockedChange(tools, changeId)
        const refusal = assessRefusal({ status: row.status as StandardChangeStatus, impact: body.impact, reviewCertificateIds: reviewFor, named: row.certificateIds })
        if (refusal) throw refused(refusal)
        const entries = await tx.regulationOrStandard.findMany({ where: { id: { in: [row.standardId, row.newStandardId].filter((value): value is string => value !== null) } }, select: { id: true, code: true, edition: true } })
        const label = (entryId: string | null) => {
          const entry = entries.find((candidate) => candidate.id === entryId)
          return entry ? standardLabel(entry.code, entry.edition) : null
        }
        const standard = label(row.standardId) ?? '?'
        const entryChange = reviewChangeEntry(standard, row.kind as StandardChangeKind, label(row.newStandardId))

        // W2a's type-change review per certificate named × style it covers, on the style's current revision.
        const styles = await stylesCovered(tx, reviewFor)
        const opened: string[] = []
        for (const certificateId of reviewFor) {
          const certificate = await tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: { id: true, number: true, companyId: true } })
          for (const style of styles.get(certificateId) ?? []) {
            const revision =
              (await tx.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED' }, select: { id: true, revision: true }, orderBy: { revision: 'desc' } })) ??
              (await tx.styleRevision.findFirst({ where: { styleId: style.id }, select: { id: true, revision: true }, orderBy: { revision: 'desc' } }))
            if (!revision) continue
            const waiting = await tx.typeChangeReview.findFirst({ where: { revisionId: revision.id, certificateId, status: { in: ['OPEN', 'NOTIFIED'] } }, select: { id: true, changes: true } })
            if (waiting && JSON.stringify(waiting.changes).includes(standard)) {
              opened.push(waiting.id)
              continue
            }
            const reviewId = newId()
            await tx.typeChangeReview.create({
              data: { id: reviewId, styleId: style.id, revisionId: revision.id, certificateId, changes: [entryChange] as unknown as Prisma.InputJsonValue, createdAt: now, updatedAt: now, createdById: context.actorId },
              select: { id: true },
            })
            audit({ action: 'compliance.typeChanges.found', recordType: 'TypeChangeReview', recordId: reviewId, companyId: certificate.companyId, after: { styleId: style.id, revisionId: revision.id, certificateId, comparedRevisionId: null, kinds: ['OTHER'], standardChangeId: changeId } })
            emit({ type: 'compliance.type_change_found', subject: reviewId, companyId: certificate.companyId, payload: { reviewId, styleId: style.id, revisionId: revision.id, revision: revision.revision, certificateId, comparedRevisionId: null, kinds: ['OTHER'] } })
            opened.push(reviewId)
          }
        }
        const next = await tx.standardChange.update({
          where: { id: changeId },
          data: {
            status: 'ASSESSED',
            impact: body.impact,
            assessment: body.assessment,
            assessedAt: now,
            assessedById: context.actorId,
            typeChangeReviewIds: [...new Set([...row.typeChangeReviewIds, ...opened])],
            updatedAt: now,
          },
          select: CHANGE_SELECT,
        })
        audit({ recordType: 'StandardChange', recordId: changeId, companyId: null, before: { status: row.status }, after: { status: 'ASSESSED', impact: body.impact, typeChangeReviewIds: next.typeChangeReviewIds }, reason: body.assessment })
        moved(tools, next, 'ASSESSED')
        return { change: (await changeViews(tx, [next], todayOf(now)))[0]! }
      },
      settings(),
    ),
  )
  return result
}

/** POST /compliance/rules/standard-changes/:changeId/certificates — more certificates the change touches (registered, in force). */
export async function addCertificates(caller: CommandCaller, changeId: string, body: { readonly version: number; readonly certificateIds: readonly string[] }, key: string | null | undefined): Promise<{ change: ChangeView }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.addChangeCertificates', idempotencyKey: key, input: { changeId, ...body }, record: { type: 'StandardChange', id: changeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await lockedChange(tools, changeId)
        const fresh = [...new Set(body.certificateIds)].filter((id) => !row.certificateIds.includes(id))
        if (fresh.length === 0) throw refused({ code: 'NOTHING_NEW', message: 'The change names these certificates already.' })
        const found = await tx.certificate.findMany({ where: { id: { in: fresh }, status: { in: [...TOUCHED_CERTIFICATE_STATUSES] } }, select: { id: true } })
        if (found.length !== fresh.length) throw new ValidationError('The certificates are not valid.', [{ path: 'body/certificateIds', message: 'Name registered certificates in force (valid or suspended), not drafts or ended ones.' }])
        const next = await tx.standardChange.update({ where: { id: changeId }, data: { certificateIds: [...row.certificateIds, ...fresh], updatedAt: now }, select: CHANGE_SELECT })
        audit({ recordType: 'StandardChange', recordId: changeId, companyId: null, before: { certificateIds: row.certificateIds }, after: { certificateIds: next.certificateIds } })
        moved(tools, next, 'CERTIFICATES')
        return { change: (await changeViews(tx, [next], todayOf(now)))[0]! }
      },
      settings(),
    ),
  )
  return result
}

/** POST /compliance/rules/standard-changes/:changeId/task — the impact task (design rm-regs "Open impact task"). */
export async function openImpactTask(caller: CommandCaller, changeId: string, body: { readonly version: number; readonly assigneeId?: string | null | undefined; readonly language?: Locale | undefined }, key: string | null | undefined): Promise<{ change: ChangeView }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  // The task's words from the change as read now; the command below checks the version and that no task is named yet.
  const words = await caller.withClient(async (db) => {
    const row = await db.standardChange.findUnique({ where: { id: changeId }, select: CHANGE_SELECT })
    if (!row) throw new NotFoundError('There is no such change in the watch.')
    if (row.version !== body.version) throw new ConflictError(`This change changed since it was read (version ${body.version}); it is now at version ${row.version}. Reload it.`)
    if (row.status === 'CLOSED') throw refused({ code: 'CLOSED', message: 'This change is closed: it never changes.' })
    if (row.taskId) throw refused({ code: 'TASK_NAMED', message: 'This change has its impact task already.' })
    const [view] = await changeViews(db, [row], todayOf(rulesClock().now()))
    const certificateOf = new Map(view!.certificates.map((certificate) => [certificate.id, certificate.number]))
    return impactTask(
      {
        standard: view!.standard.label,
        kind: row.kind as StandardChangeKind,
        whatChanged: row.whatChanged,
        transitionEndsOn: view!.transitionEndsOn,
        styles: view!.styles.map((style) => ({ code: style.code, name: style.name, certificate: certificateOf.get(style.certificateIds[0]!) ?? '?' })),
      },
      body.language ?? 'it',
    )
  })
  const { task } = await createTask(
    caller,
    {
      title: words.title,
      description: words.description,
      ...(body.assigneeId === undefined ? {} : { assigneeId: body.assigneeId }),
      ...(words.dueDate ? { dueDate: words.dueDate } : {}),
      ...(words.checklist.length > 0 ? { checklist: words.checklist.map((text) => ({ text })) } : {}),
    },
    key ? `${key}:task` : undefined,
  )
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.changeTask', idempotencyKey: key, input: { changeId, ...body }, record: { type: 'StandardChange', id: changeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await lockedChange(tools, changeId)
        if (row.taskId) throw refused({ code: 'TASK_NAMED', message: 'This change has its impact task already.' })
        const next = await tx.standardChange.update({ where: { id: changeId }, data: { taskId: task.id, updatedAt: now }, select: CHANGE_SELECT })
        audit({ recordType: 'StandardChange', recordId: changeId, companyId: null, after: { taskId: task.id } })
        moved(tools, next, 'TASK')
        return { change: (await changeViews(tx, [next], todayOf(now)))[0]! }
      },
      settings(),
    ),
  )
  return result
}

/** POST /compliance/rules/standard-changes/:changeId/close */
export async function closeChange(caller: CommandCaller, changeId: string, body: { readonly version: number }, key: string | null | undefined): Promise<{ change: ChangeView }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.closeChange', idempotencyKey: key, input: { changeId, ...body }, record: { type: 'StandardChange', id: changeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await lockedChange(tools, changeId)
        if (row.status !== 'ASSESSED') throw refused({ code: 'NOT_ASSESSED', message: 'Assess the impact of this change before closing it.' })
        const next = await tx.standardChange.update({ where: { id: changeId }, data: { status: 'CLOSED', closedAt: now, closedById: context.actorId, updatedAt: now }, select: CHANGE_SELECT })
        audit({ recordType: 'StandardChange', recordId: changeId, companyId: null, before: { status: 'ASSESSED' }, after: { status: 'CLOSED' } })
        moved(tools, next, 'CLOSED')
        return { change: (await changeViews(tx, [next], todayOf(now)))[0]! }
      },
      settings(),
    ),
  )
  return result
}
