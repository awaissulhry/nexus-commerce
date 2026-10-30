import { createHash } from 'node:crypto'
import type { Prisma, Uom } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DefectClass, QualityStage } from '@nexus/factory-domain/quality/defects/rules'
import type { NcrChangedField } from '@nexus/factory-domain/quality/ncr/changes'
import { QUALITY_NCR_APPROVE, QUALITY_NCR_CLOSE, QUALITY_NCR_MANAGE, QUALITY_NCR_RAISE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import {
  allMet,
  closeChecklist,
  closeStatement,
  isOpenStage,
  NCR_LIMITS,
  ncrActions,
  ncrDraftProblems,
  nextStage,
  opensRegisterEntry,
  problemEditable,
  stageChecks,
  stagesToClose,
  stageWords,
  type NcrFromType,
  type NcrSource,
  type NcrStage,
  type StageCheck,
} from '@nexus/factory-domain/quality/ncr/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { openRegisterEntryFor } from '../../compliance/register/hook'
import { closeHoldInCommand } from '../holds/holds'
import { linkTarget, prefillFrom, type Prefill } from './sources'
import {
  actionViews,
  decisionViews,
  factsOf,
  NCR_COLUMNS,
  NCR_RECORD,
  ncrSummary,
  readActions,
  readDecisions,
  readLinks,
  readNcr,
  readNcrHolds,
  summaryFactsOf,
  type NcrRow,
  type Reader,
} from './store'

/**
 * Nonconformances: raise, change, move on the board, close, cancel, link (B-W2a-47; QHS-080 from anywhere, QHS-081
 * content, QHS-089 board, QHS-090 closure rules; design quality.ncr ncr-new, ncr-what, ncr-side, ncr-board, ncr-close,
 * ncr-links). Each write is ONE command(); the refusals come first, in words; the …_quality_plant_w2a_guards triggers
 * hold the same rules for every login. Every write locks the NCR row first (FOR UPDATE) and bumps its version: two
 * writes of one NCR take turns, and the board and the record see every change. Containment is ./containment.ts, the
 * decisions ./decisions.ts, the reads ./reads.ts.
 *
 *   raise    (quality.ncr.raise over the site) by hand or from a record (sources.ts prefills what the body leaves out):
 *            its number from the company's NCR series (allocateNumber), found by the person raising it unless the
 *            source names the finder, containment due 24 hours after it was found unless said; linked to its source's
 *            records; raised from a hold, it decides that hold (the hold's NCR set once) and its first containment
 *            action is the hold, done; a PPE nonconformity that may present a risk opens its PPE register entry.
 *   change   (quality.ncr.manage) the problem while OPEN or CONTAINED; the owner and the containment due time until it
 *            is closed. The quantity affected never goes below what is decided.
 *   stage    (quality.ncr.manage) CONTAINED or DECIDED, each check in words (409 `stage/<CHECK>`).
 *   close    (quality.ncr.close, the office's step-up: an e-signature) from any open stage whose checks are all met: the
 *            stages it skips in the same command, the holds it decides closed (holds.ts closeHoldInCommand: their work
 *            orders lifted), then CLOSED with the SHA-256 of what was signed.
 *   cancel   (quality.ncr.manage) while OPEN or CONTAINED and nothing is carried out, with the reason.
 *   links    link (quality.ncr.raise) and unlink (quality.ncr.manage) records; the PPE register entry
 *            (quality.ncr.manage); a hold it decides closed now (quality.ncr.manage: before an ISSUE of the held goods).
 */

/** A record type in words: "work order", "goods receipt". */
export const typeWords = (recordType: string): string => recordType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

const SCOPE_FIELDS = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })
/** The containment is due a day after the problem was found, unless the person says otherwise. */
const DEFAULT_CONTAINMENT_HOURS = 24

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function contextOf(tools: Pick<CommandTools, 'context'>): OfficeContext {
  if (tools.context.audience !== 'office') throw new ForbiddenError()
  return tools.context
}

export const may = (context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string }): boolean => can(actorOf(context), permission, SCOPE_FIELDS(row))

export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))
}

/** A move refused by its checks: a 409 with `stage/<CHECK>` and their words. */
export class StageRefusedError extends ConflictError {
  override name = 'StageRefusedError'
  override readonly issues: readonly Issue[]
  constructor(checks: readonly StageCheck[]) {
    const failed = checks.filter((check) => !check.ok)
    super(failed[0]?.words ?? 'The NCR cannot move.')
    this.issues = failed.map((check) => ({ path: `stage/${check.key}`, message: check.words }))
  }
}

/** The NCR the caller sees (another site's or company's: not found), with the right to act on it (403 in words). */
export async function visibleNcr(caller: CommandCaller, ncrId: string, permission?: Permission): Promise<{ context: OfficeContext; row: NcrRow }> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readNcr(client, ncrId))
  if (!row || !may(context, QUALITY_NCR_VIEW, row)) throw new NotFoundError('NCR not found.')
  if (permission && !may(context, permission, row)) throw new ForbiddenError(`This needs ${permission} at the NCR's site.`)
  return { context, row }
}

export const frozenWords = (stage: NcrStage): string | null => (stage === 'CLOSED' || stage === 'CANCELLED' ? `The NCR is ${stageWords(stage)}: it never changes.` : null)

/** Refused before the command when the NCR never changes any more. */
export function assertOpen(row: Pick<NcrRow, 'stage'>): void {
  const frozen = frozenWords(row.stage as NcrStage)
  if (frozen) throw new InvalidStateError(frozen)
}

/**
 * Inside the command: the NCR's row locked FOR UPDATE, open (not CLOSED or CANCELLED), at the version the caller read
 * (when given), and its version bumped (one bump per command). Answers the row as it is now.
 */
export async function lockNcrRow(tools: CommandTools, ncrId: string, expectedVersion?: number): Promise<NcrRow> {
  const { tx, now } = tools
  const [locked] = await tx.$queryRaw<{ version: number; stage: NcrStage }[]>`SELECT "version", "stage"::text AS "stage" FROM "Nonconformance" WHERE "id" = ${ncrId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('NCR not found.')
  const frozen = frozenWords(locked.stage)
  if (frozen) throw new InvalidStateError(frozen)
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError('Nonconformance', ncrId, locked.version, expectedVersion)
  return tx.nonconformance.update({ where: { id: ncrId }, data: { version: { increment: 1 }, updatedAt: now }, select: NCR_COLUMNS })
}

// ---- the record --------------------------------------------------------------------------------------------------------

/** The NCR record (GET /quality/ncr/:ncrId and the answer of every write). */
export async function recordOf(db: Reader, row: NcrRow, context: OfficeContext, now: Date) {
  const actions = await readActions(db, [row.id])
  const decisions = await readDecisions(db, [row.id])
  const links = await readLinks(db, row.id)
  const holds = await readNcrHolds(db, row.id)
  const activeHolds = holds.filter((hold) => hold.ncrId === row.id && hold.status === 'ACTIVE').length
  const facts = factsOf(row, actions, decisions, activeHolds)
  const summary = ncrSummary(row, await summaryFactsOf(db, [row]), now)
  const labels: (string | null)[] = []
  for (const link of links) labels.push((await linkTarget(db, link.recordType, link.recordId))?.label ?? null)
  const entry = await db.ppeRegisterEntry.findFirst({ where: { sourceType: NCR_RECORD, sourceId: row.id }, select: { id: true, reference: true, status: true } })
  const next = nextStage(row.stage as NcrStage)
  const nextChecks = next ? stageChecks(facts, next) : []
  const closing = closeChecklist(facts)
  return {
    ncr: {
      ...summary,
      description: row.description,
      foundBy: row.foundById ? { kind: 'USER' as const, userId: row.foundById, workerId: null } : row.foundByWorkerId ? { kind: 'WORKER' as const, userId: null, workerId: row.foundByWorkerId } : { kind: 'NONE' as const, userId: null, workerId: null },
      closedById: row.closedById,
      closeNote: row.closeNote,
      closeSignatureSha256: row.closeSignatureSha256,
      cancelReason: row.cancelReason,
      createdById: row.createdById,
    },
    containment: await actionViews(db, actions, now),
    decisions: await decisionViews(db, decisions, { userId: context.actorId, mayApprove: may(context, QUALITY_NCR_APPROVE, row) }),
    links: links.map((link, index) => ({ id: link.id, recordType: link.recordType, recordId: link.recordId, label: labels[index] ?? null, note: link.note, createdAt: link.createdAt.toISOString(), createdById: link.createdById })),
    holds: holds.map((hold) => ({ id: hold.id, status: hold.status, subjectType: hold.subjectType, subjectIds: [...hold.subjectIds], reasonCode: hold.reasonCode, reasonNote: hold.reasonNote, placedAt: hold.placedAt.toISOString(), decidedHere: hold.ncrId === row.id })),
    register: entry ? { id: entry.id, reference: entry.reference, status: entry.status } : null,
    next: { stage: next, checks: nextChecks, ready: next !== null && allMet(nextChecks) },
    closing: { checks: closing, ready: isOpenStage(row.stage as NcrStage) && allMet(closing) },
    actions: ncrActions(facts),
    may: { manage: may(context, QUALITY_NCR_MANAGE, row), approve: may(context, QUALITY_NCR_APPROVE, row), close: may(context, QUALITY_NCR_CLOSE, row), raise: may(context, QUALITY_NCR_RAISE, row) },
  }
}
export type NcrRecordView = Awaited<ReturnType<typeof recordOf>>

export async function answerOf(tools: Pick<CommandTools, 'tx' | 'now' | 'context'>, ncrId: string) {
  const row = (await readNcr(tools.tx, ncrId))!
  return { record: await recordOf(tools.tx, row, contextOf(tools), tools.now) }
}

export function emitChanged(tools: CommandTools, row: Pick<NcrRow, 'id' | 'number' | 'companyId' | 'siteId'>, fields: readonly NcrChangedField[]): void {
  if (fields.length === 0) return
  tools.emit({ type: 'ncr.changed', subject: row.id, ...SCOPE_FIELDS(row), payload: { ncrId: row.id, number: row.number, fields: [...new Set(fields)] } })
}

// ---- content: what the NCR names --------------------------------------------------------------------------------------

export interface NcrContent {
  readonly title?: string | undefined
  readonly description?: string | null | undefined
  readonly source?: NcrSource | undefined
  readonly foundAt?: QualityStage | undefined
  readonly foundOn?: string | undefined
  readonly foundById?: string | null | undefined
  readonly foundByWorkerId?: string | null | undefined
  readonly quantityAffected?: string | undefined
  readonly quantitySuspect?: string | null | undefined
  readonly uom?: Uom | undefined
  readonly defectCodeId?: string | null | undefined
  readonly severity?: DefectClass | undefined
  readonly zone?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly workOrderId?: string | null | undefined
  readonly itemId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly containmentDueAt?: string | null | undefined
}

interface Resolved {
  readonly defectCodeId: string | null
  readonly severity: DefectClass | null
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly workOrderId: string | null
  readonly itemId: string | null
  readonly lotId: string | null
  readonly supplierId: string | null
  readonly foundById: string | null
  readonly foundByWorkerId: string | null
  readonly ownerId: string | null
}

/** What the NCR names, checked in the command's scope (its site and company): problems in words at the field. */
async function resolveReferences(tx: Reader, site: { readonly id: string; readonly companyId: string }, values: Resolved, changed: (field: keyof Resolved) => boolean, self: string): Promise<Resolved> {
  const problems: Issue[] = []
  let { severity, itemId, styleId } = values
  if (values.defectCodeId && changed('defectCodeId')) {
    const defect = isUuid(values.defectCodeId) ? await tx.defectCode.findUnique({ where: { id: values.defectCodeId }, select: { parentId: true, active: true, severity: true } }) : null
    if (!defect || defect.parentId === null || !defect.active) problems.push({ path: 'defectCodeId', message: 'Pick an active defect of the library (not a category).' })
    else severity ??= defect.severity as DefectClass | null
  }
  if (values.workOrderId && (changed('workOrderId') || changed('styleId'))) {
    const order = isUuid(values.workOrderId) ? await tx.workOrder.findUnique({ where: { id: values.workOrderId }, select: { siteId: true, styleId: true } }) : null
    if (!order || order.siteId !== site.id) problems.push({ path: 'workOrderId', message: "Not a work order of the NCR's site." })
    else if (styleId && styleId !== order.styleId) problems.push({ path: 'styleId', message: 'The work order makes another style.' })
    else styleId ??= order.styleId
  }
  if (styleId && (changed('styleId') || changed('workOrderId'))) {
    const style = isUuid(styleId) ? await tx.style.findUnique({ where: { id: styleId }, select: { companyId: true } }) : null
    if (!style || (style.companyId !== null && style.companyId !== site.companyId)) problems.push({ path: 'styleId', message: "Not a style of the site's company." })
  }
  if (values.colourwayId && (changed('colourwayId') || changed('styleId'))) {
    const colourway = isUuid(values.colourwayId) ? await tx.colourway.findUnique({ where: { id: values.colourwayId }, select: { styleId: true } }) : null
    if (!colourway || colourway.styleId !== styleId) problems.push({ path: 'colourwayId', message: 'A colourway of the style named.' })
  }
  if (values.lotId && (changed('lotId') || changed('itemId'))) {
    const lot = isUuid(values.lotId) ? await tx.lot.findUnique({ where: { id: values.lotId }, select: { siteId: true, itemId: true } }) : null
    if (!lot || lot.siteId !== site.id) problems.push({ path: 'lotId', message: "Not a lot of the NCR's site." })
    else if (itemId && itemId !== lot.itemId) problems.push({ path: 'itemId', message: 'The lot is of another material.' })
    else itemId ??= lot.itemId
  }
  if (itemId && changed('itemId')) {
    const item = isUuid(itemId) ? await tx.item.findUnique({ where: { id: itemId }, select: { companyId: true } }) : null
    if (!item || (item.companyId !== null && item.companyId !== site.companyId)) problems.push({ path: 'itemId', message: "Not a material of the site's company." })
  }
  if (values.supplierId && changed('supplierId')) {
    const party = isUuid(values.supplierId) ? await tx.party.findUnique({ where: { id: values.supplierId }, select: { companyId: true } }) : null
    if (!party || (party.companyId !== null && party.companyId !== site.companyId)) problems.push({ path: 'supplierId', message: "Not a supplier of the site's company." })
  }
  if (values.foundById && values.foundByWorkerId) problems.push({ path: 'foundByWorkerId', message: 'Found by one person: an office user or a worker.' })
  for (const field of ['foundById', 'ownerId'] as const) {
    const userId = values[field]
    // The caller themself (found it, follows it up) is a person of the office already.
    if (!userId || !changed(field) || userId === self) continue
    const user = isUuid(userId) ? await tx.user.findUnique({ where: { id: userId }, select: { status: true } }) : null
    if (!user || user.status !== 'ACTIVE') problems.push({ path: field, message: 'An active person of the office.' })
  }
  if (values.foundByWorkerId && changed('foundByWorkerId')) {
    const worker = isUuid(values.foundByWorkerId) ? await tx.worker.findUnique({ where: { id: values.foundByWorkerId }, select: { siteId: true } }) : null
    if (!worker || worker.siteId !== site.id) problems.push({ path: 'foundByWorkerId', message: "A worker of the NCR's site." })
  }
  if (problems.length > 0) refuse(problems, 'Some of what the NCR names is not found.')
  return { ...values, severity, itemId, styleId }
}

/** Opens the NCR's PPE register entry in the command (Reg. (EU) 2016/425 art. 8(4)) and links it. Null: no PPE style. */
async function openRegister(tools: CommandTools, row: NcrRow, description: string | null): Promise<{ id: string; reference: string; opened: boolean } | null> {
  if (!row.styleId) return null
  const style = await tools.tx.style.findUnique({ where: { id: row.styleId }, select: { ppeCategory: true } })
  if (!style || style.ppeCategory === 'NOT_PPE') return null
  const workOrder = row.workOrderId ? await tools.tx.workOrder.findUnique({ where: { id: row.workOrderId }, select: { id: true, styleId: true } }) : null
  const opened = await openRegisterEntryFor(tools, {
    companyId: row.companyId,
    kind: 'NON_CONFORMITY',
    styleId: row.styleId,
    workOrderIds: workOrder && workOrder.styleId === row.styleId ? [workOrder.id] : [],
    serials: row.serial ? [row.serial] : [],
    description: (description?.trim() || `Nonconformance ${row.number}: ${row.title}.${row.description ? ` ${row.description}` : ''}`).slice(0, 2000),
    reportedAt: row.foundOn,
    source: { type: NCR_RECORD, id: row.id },
  })
  const linked = await tools.tx.ncrLink.findFirst({ where: { ncrId: row.id, recordType: 'PpeRegisterEntry', recordId: opened.entryId }, select: { id: true } })
  if (!linked) await tools.tx.ncrLink.create({ data: { id: newId(), siteId: row.siteId, ncrId: row.id, recordType: 'PpeRegisterEntry', recordId: opened.entryId, note: null, createdAt: tools.now, createdById: contextOf(tools).actorId }, select: { id: true } })
  return { id: opened.entryId, reference: opened.reference, opened: opened.opened }
}

// ---- raise --------------------------------------------------------------------------------------------------------------

export interface RaiseBody extends NcrContent {
  readonly from?: { readonly recordType: NcrFromType; readonly recordId: string } | undefined
  readonly siteId?: string | undefined
  readonly links?: readonly { readonly recordType: string; readonly recordId: string; readonly note?: string | null | undefined }[] | undefined
  readonly register?: boolean | undefined
}

const take = <Key extends keyof Prefill & keyof RaiseBody>(body: RaiseBody, prefill: Prefill | null, key: Key): NonNullable<RaiseBody[Key]> | NonNullable<Prefill[Key]> | null =>
  (body[key] !== undefined ? body[key] : (prefill?.[key] ?? null)) as never

/** POST /quality/ncr: raise an NCR, by hand or from a record (its prefill fills what the body leaves out). */
export async function raiseNcr(caller: CommandCaller, body: RaiseBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'quality.raiseNcr', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const prefill = body.from ? await prefillFrom(tx, body.from.recordType, body.from.recordId) : null
    if (body.from && !prefill) throw new NotFoundError(`${typeWords(body.from.recordType).replace(/^./, (first) => first.toUpperCase())} not found.`)
    if (prefill?.problem) throw new ConflictError(prefill.problem)
    if (prefill?.siteId && body.siteId && prefill.siteId !== body.siteId) refuse([{ path: 'siteId', message: `${prefill.label} is at another site.` }], 'The record is at another site.')
    const siteId = prefill?.siteId ?? body.siteId
    if (!siteId) refuse([{ path: 'siteId', message: 'Name the site where the problem is handled.' }], 'Name the site.')
    const site = isUuid(siteId) ? await tx.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }) : null
    if (!site || (prefill?.companyId && prefill.companyId !== site.companyId)) refuse([{ path: 'siteId', message: 'Not a site you can see.' }], 'The site is not found.')
    if (!may(context, QUALITY_NCR_RAISE, { companyId: site!.companyId, siteId: site!.id })) throw new ForbiddenError('You raise NCRs only at the sites your role reaches.')

    // A record's own time is kept unless it is after now (a device clock ahead): then now.
    const foundOn = body.foundOn ? new Date(body.foundOn) : prefill?.foundOn && prefill.foundOn.getTime() < now.getTime() ? prefill.foundOn : now
    const named = await resolveReferences(
      tx,
      site!,
      {
        defectCodeId: take(body, prefill, 'defectCodeId'),
        severity: take(body, prefill, 'severity'),
        styleId: take(body, prefill, 'styleId'),
        colourwayId: take(body, prefill, 'colourwayId'),
        workOrderId: take(body, prefill, 'workOrderId'),
        itemId: take(body, prefill, 'itemId'),
        lotId: take(body, prefill, 'lotId'),
        supplierId: take(body, prefill, 'supplierId'),
        foundById: body.foundById !== undefined || body.foundByWorkerId !== undefined ? (body.foundById ?? null) : (prefill?.foundById ?? (prefill?.foundByWorkerId ? null : context.actorId)),
        foundByWorkerId: body.foundById !== undefined || body.foundByWorkerId !== undefined ? (body.foundByWorkerId ?? null) : (prefill?.foundByWorkerId ?? null),
        ownerId: body.ownerId ?? null,
      },
      () => true,
      context.actorId,
    )
    const draft = {
      title: body.title ?? prefill?.title ?? undefined,
      description: take(body, prefill, 'description'),
      quantityAffected: body.quantityAffected ?? prefill?.quantityAffected ?? undefined,
      quantitySuspect: body.quantitySuspect !== undefined ? body.quantitySuspect : null,
      zone: take(body, prefill, 'zone'),
      size: take(body, prefill, 'size'),
      serial: take(body, prefill, 'serial'),
      foundOn,
    }
    const problems = ncrDraftProblems(draft, true, now)
    if (!named.severity) problems.push({ path: 'severity', message: 'How serious it is: critical, major or minor.' })
    if (problems.length > 0) refuse(problems, 'The NCR is not complete.')
    if (body.containmentDueAt && new Date(body.containmentDueAt).getTime() < foundOn.getTime()) refuse([{ path: 'containmentDueAt', message: 'The containment is due after the problem was found.' }], 'The containment due time is before the problem.')

    const id = newId()
    const issued = await allocateNumber(tools, { companyId: site!.companyId, kind: 'NCR' }, { type: NCR_RECORD, id })
    const data: Prisma.NonconformanceUncheckedCreateInput = {
      id,
      companyId: site!.companyId,
      siteId: site!.id,
      number: issued.formatted,
      title: draft.title!.trim(),
      description: draft.description?.trim() || null,
      source: body.source ?? prefill?.source ?? 'OTHER',
      sourceType: prefill ? prefill.fromType : null,
      sourceId: prefill ? prefill.fromId : null,
      foundAt: body.foundAt ?? prefill?.foundAt ?? 'IN_LINE',
      foundOn,
      foundById: named.foundById,
      foundByWorkerId: named.foundByWorkerId,
      quantityAffected: draft.quantityAffected!,
      quantitySuspect: draft.quantitySuspect,
      uom: body.uom ?? prefill?.uom ?? 'PCS',
      defectCodeId: named.defectCodeId,
      severity: named.severity!,
      zone: draft.zone,
      styleId: named.styleId,
      colourwayId: named.colourwayId,
      size: draft.size?.trim() || null,
      serial: draft.serial?.trim() || null,
      workOrderId: named.workOrderId,
      itemId: named.itemId,
      lotId: named.lotId,
      supplierId: named.supplierId,
      ownerId: named.ownerId,
      containmentDueAt: body.containmentDueAt !== undefined ? (body.containmentDueAt ? new Date(body.containmentDueAt) : null) : new Date(foundOn.getTime() + DEFAULT_CONTAINMENT_HOURS * 3_600_000),
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    }
    const row = await tx.nonconformance.create({ data, select: NCR_COLUMNS })
    const scope = SCOPE_FIELDS(row)
    tools.audit({ action: 'quality.raiseNcr', recordType: NCR_RECORD, recordId: id, ...scope, after: { ...data, createdAt: undefined, updatedAt: undefined } })

    // Its links: the source's records, then the ones named (each a record the caller sees, of the NCR's company).
    const links: { recordType: string; recordId: string; note: string | null }[] = [...(prefill?.links ?? [])]
    for (const [index, link] of (body.links ?? []).entries()) {
      const target = await linkTarget(tx, link.recordType, link.recordId)
      if (!target || (target.companyId !== null && target.companyId !== row.companyId)) refuse([{ path: `links/${index}/recordId`, message: `Not a ${typeWords(link.recordType)} of the NCR's company.` }], 'A linked record is not found.')
      links.push({ recordType: link.recordType, recordId: link.recordId, note: link.note?.trim() || null })
    }
    const seen = new Set<string>()
    for (const link of links) {
      const key = `${link.recordType}|${link.recordId}`
      if (seen.has(key)) continue
      seen.add(key)
      await tx.ncrLink.create({ data: { id: newId(), siteId: row.siteId, ncrId: id, recordType: link.recordType, recordId: link.recordId, note: link.note, createdAt: now, createdById: context.actorId }, select: { id: true } })
    }

    // Raised from a hold: the NCR decides it, and its first containment action is that hold, done.
    for (const [index, holdId] of (prefill?.holdIds ?? []).entries()) {
      const hold = await tx.qualityHold.update({ where: { id: holdId }, data: { ncrId: id, version: { increment: 1 }, updatedAt: now }, select: { id: true, subjectType: true, subjectIds: true, reasonCode: true } })
      tools.audit({ action: 'quality.decideHoldInNcr', recordType: 'QualityHold', recordId: hold.id, ...scope, before: { ncrId: null }, after: { ncrId: id } })
      const actionId = newId()
      await tx.ncrContainmentAction.create({
        data: {
          id: actionId,
          siteId: row.siteId,
          ncrId: id,
          seq: index + 1,
          kind: 'HOLD_STOCK',
          ownerId: named.ownerId,
          status: 'DONE',
          doneAt: now,
          doneById: context.actorId,
          evidenceNote: `The goods are on hold (${hold.reasonCode.toLowerCase().replace(/_/g, ' ')}): ${hold.subjectIds.length} ${hold.subjectType === 'GarmentSerial' ? 'garment serial' : hold.subjectType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}${hold.subjectIds.length === 1 ? '' : 's'}.`,
          recordType: 'QualityHold',
          recordId: hold.id,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
    }

    // A PPE nonconformity that may present a risk goes to the PPE register.
    const style = row.styleId ? await tx.style.findUnique({ where: { id: row.styleId }, select: { ppeCategory: true } }) : null
    const ppe = style !== null && style.ppeCategory !== 'NOT_PPE'
    const wanted = body.register ?? opensRegisterEntry({ ppe, severity: row.severity as DefectClass, foundAt: row.foundAt as QualityStage, source: row.source as NcrSource })
    if (body.register && !ppe) refuse([{ path: 'register', message: 'The PPE register keeps PPE: the NCR names no PPE style.' }], 'No PPE style.')
    const entry = wanted ? await openRegister(tools, row, null) : null

    tools.emit({
      type: 'ncr.created',
      subject: id,
      ...scope,
      payload: { ncrId: id, number: row.number, source: row.source as NcrSource, sourceType: row.sourceType, sourceId: row.sourceId, severity: row.severity as DefectClass, workOrderId: row.workOrderId, lotId: row.lotId, holdIds: [...(prefill?.holdIds ?? [])], registerEntryId: entry?.id ?? null },
    })
    return answerOf(tools, id)
  })
  return result
}

// ---- change -------------------------------------------------------------------------------------------------------------

export interface EditBody extends NcrContent {
  readonly version: number
}

const PROBLEM_FIELDS = ['title', 'description', 'source', 'foundAt', 'foundOn', 'foundById', 'foundByWorkerId', 'quantityAffected', 'quantitySuspect', 'uom', 'defectCodeId', 'severity', 'zone', 'styleId', 'colourwayId', 'size', 'serial', 'workOrderId', 'itemId', 'lotId', 'supplierId'] as const
const FOLLOW_FIELDS = ['ownerId', 'containmentDueAt'] as const

/** PATCH /quality/ncr/:ncrId: the problem while OPEN or CONTAINED; the owner and containment due until it is closed. */
export async function editNcr(caller: CommandCaller, ncrId: string, body: EditBody, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const touched = PROBLEM_FIELDS.filter((field) => body[field] !== undefined)
  if (touched.length > 0 && !problemEditable(row.stage as NcrStage)) throw new InvalidStateError('The NCR is decided: its problem is read-only now (only its owner and containment due time change).')
  const { result } = await command(caller, { name: 'quality.editNcr', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const before = await readNcr(tx, ncrId)
    const current = await lockNcrRow(tools, ncrId, body.version)
    if (touched.length > 0 && !problemEditable(current.stage as NcrStage)) throw new InvalidStateError('The NCR is decided: its problem is read-only now (only its owner and containment due time change).')
    const value = <Field extends keyof NcrRow>(field: Field, given: unknown): unknown => (given !== undefined ? given : current[field])
    const changedFields = new Set<string>([...touched, ...FOLLOW_FIELDS.filter((field) => body[field] !== undefined)])
    const changed = (field: string) => changedFields.has(field)
    const named = await resolveReferences(
      tx,
      { id: current.siteId, companyId: current.companyId },
      {
        defectCodeId: value('defectCodeId', body.defectCodeId) as string | null,
        severity: (body.severity ?? current.severity) as DefectClass,
        styleId: value('styleId', body.styleId) as string | null,
        colourwayId: value('colourwayId', body.colourwayId) as string | null,
        workOrderId: value('workOrderId', body.workOrderId) as string | null,
        itemId: value('itemId', body.itemId) as string | null,
        lotId: value('lotId', body.lotId) as string | null,
        supplierId: value('supplierId', body.supplierId) as string | null,
        foundById: body.foundByWorkerId !== undefined && body.foundById === undefined ? null : (value('foundById', body.foundById) as string | null),
        foundByWorkerId: body.foundById !== undefined && body.foundByWorkerId === undefined ? null : (value('foundByWorkerId', body.foundByWorkerId) as string | null),
        ownerId: value('ownerId', body.ownerId) as string | null,
      },
      changed,
      context.actorId,
    )
    const problems = ncrDraftProblems({ title: body.title, description: body.description, quantityAffected: body.quantityAffected, quantitySuspect: body.quantitySuspect, zone: body.zone, size: body.size, serial: body.serial, foundOn: body.foundOn ? new Date(body.foundOn) : undefined }, false, now)
    if (body.quantityAffected !== undefined) {
      const decided = (await readDecisions(tx, [ncrId])).reduce((sum, decision) => sum.plus(decision.quantity.toString()), ZERO)
      if (new Dec(body.quantityAffected).lt(decided)) problems.push({ path: 'quantityAffected', message: `${decided.toFixed(4)} ${current.uom} are decided already: change or remove a decision first.` })
    }
    if (body.uom !== undefined && body.uom !== current.uom && (await readDecisions(tx, [ncrId])).length > 0) problems.push({ path: 'uom', message: 'Decisions are made in the unit: remove them before changing it.' })
    if (body.severity !== undefined && body.severity !== 'MINOR' && current.severity === 'MINOR') {
      const decided = await readDecisions(tx, [ncrId])
      const asIs = decided.length === 0 ? 0 : await tx.dispositionCode.count({ where: { id: { in: decided.map((decision) => decision.dispositionCodeId) }, outcome: 'USE_AS_IS' } })
      if (asIs > 0) problems.push({ path: 'severity', message: `A ${body.severity.toLowerCase()} nonconformance is never used as is: remove the "use as is" decision first.` })
    }
    if (problems.length > 0) refuse(problems, 'The change is not valid.')

    const data: Prisma.NonconformanceUncheckedUpdateInput = {}
    const fields: NcrChangedField[] = []
    const set = (field: NcrChangedField, column: keyof Prisma.NonconformanceUncheckedUpdateInput, next: unknown, previous: unknown) => {
      const a = next instanceof Date ? next.getTime() : next === undefined ? undefined : (next?.toString() ?? null)
      const b = previous instanceof Date ? previous.getTime() : (previous?.toString() ?? null)
      if (a === undefined || a === b) return
      ;(data as Record<string, unknown>)[column] = next
      fields.push(field)
    }
    set('title', 'title', body.title?.trim(), current.title)
    set('description', 'description', body.description === undefined ? undefined : body.description?.trim() || null, current.description)
    set('source', 'source', body.source, current.source)
    set('foundAt', 'foundAt', body.foundAt, current.foundAt)
    set('foundOn', 'foundOn', body.foundOn ? new Date(body.foundOn) : undefined, current.foundOn)
    if (changed('foundById') || changed('foundByWorkerId')) {
      set('foundBy', 'foundById', named.foundById, current.foundById)
      set('foundBy', 'foundByWorkerId', named.foundByWorkerId, current.foundByWorkerId)
    }
    set('quantityAffected', 'quantityAffected', body.quantityAffected, current.quantityAffected)
    set('quantitySuspect', 'quantitySuspect', body.quantitySuspect, current.quantitySuspect)
    set('uom', 'uom', body.uom, current.uom)
    set('defectCodeId', 'defectCodeId', body.defectCodeId, current.defectCodeId)
    set('severity', 'severity', body.severity ?? (changed('defectCodeId') && named.severity !== current.severity ? named.severity : undefined), current.severity)
    set('zone', 'zone', body.zone, current.zone)
    set('styleId', 'styleId', changed('styleId') || changed('workOrderId') ? named.styleId : undefined, current.styleId)
    set('colourwayId', 'colourwayId', body.colourwayId, current.colourwayId)
    set('size', 'size', body.size === undefined ? undefined : body.size?.trim() || null, current.size)
    set('serial', 'serial', body.serial === undefined ? undefined : body.serial?.trim() || null, current.serial)
    set('workOrderId', 'workOrderId', body.workOrderId, current.workOrderId)
    set('itemId', 'itemId', changed('itemId') || changed('lotId') ? named.itemId : undefined, current.itemId)
    set('lotId', 'lotId', body.lotId, current.lotId)
    set('supplierId', 'supplierId', body.supplierId, current.supplierId)
    set('ownerId', 'ownerId', body.ownerId, current.ownerId)
    set('containmentDueAt', 'containmentDueAt', body.containmentDueAt === undefined ? undefined : body.containmentDueAt ? new Date(body.containmentDueAt) : null, current.containmentDueAt)
    if (data.colourwayId === undefined && data.styleId !== undefined && current.colourwayId && named.styleId !== current.styleId) {
      data.colourwayId = null
      fields.push('colourwayId')
    }
    const after = fields.length > 0 ? await tx.nonconformance.update({ where: { id: ncrId }, data, select: NCR_COLUMNS }) : current
    const pick = (source: NcrRow | null) => (source ? Object.fromEntries(Object.keys(data).map((key) => [key, (source as Record<string, unknown>)[key] ?? null])) : null)
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), before: pick(before), after: pick(after) })
    // A PPE style or a critical severity named now: the register entry, once.
    if (fields.some((field) => field === 'styleId' || field === 'severity' || field === 'foundAt' || field === 'source')) {
      const style = after.styleId ? await tx.style.findUnique({ where: { id: after.styleId }, select: { ppeCategory: true } }) : null
      const exists = await tx.ppeRegisterEntry.findFirst({ where: { sourceType: NCR_RECORD, sourceId: ncrId }, select: { id: true } })
      if (!exists && opensRegisterEntry({ ppe: style !== null && style.ppeCategory !== 'NOT_PPE', severity: after.severity as DefectClass, foundAt: after.foundAt as QualityStage, source: after.source as NcrSource })) {
        if (await openRegister(tools, after, null)) fields.push('register')
      }
    }
    emitChanged(tools, after, fields)
    return { record: await recordOf(tx, after, context, now) }
  })
  return result
}

// ---- stages -------------------------------------------------------------------------------------------------------------

async function factsNow(tools: CommandTools, row: NcrRow) {
  const actions = await readActions(tools.tx, [row.id])
  const decisions = await readDecisions(tools.tx, [row.id])
  const activeHolds = await tools.tx.qualityHold.count({ where: { ncrId: row.id, status: 'ACTIVE' } })
  return { facts: factsOf(row, actions, decisions, activeHolds), decisions }
}

const STAGE_TIMES = (to: NcrStage, now: Date): Prisma.NonconformanceUncheckedUpdateInput => (to === 'CONTAINED' ? { stage: 'CONTAINED', containedAt: now } : to === 'DECIDED' ? { stage: 'DECIDED', decidedAt: now } : { stage: to })

/** POST /quality/ncr/:ncrId/stage: the board's move to CONTAINED or DECIDED (a move to CLOSED is the close). */
export async function moveNcr(caller: CommandCaller, ncrId: string, body: { readonly version: number; readonly to: 'CONTAINED' | 'DECIDED' }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.moveNcr', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockNcrRow(tools, ncrId, body.version)
    const { facts } = await factsNow(tools, current)
    const checks = stageChecks(facts, body.to)
    if (!allMet(checks)) throw new StageRefusedError(checks)
    const after = await tx.nonconformance.update({ where: { id: ncrId }, data: STAGE_TIMES(body.to, now), select: NCR_COLUMNS })
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), before: { stage: current.stage }, after: { stage: body.to } })
    tools.emit({ type: 'ncr.stage_changed', subject: ncrId, ...SCOPE_FIELDS(current), payload: { ncrId, number: current.number, from: current.stage as NcrStage, to: body.to, holdsClosed: [] } })
    return { record: await recordOf(tx, after, context, now) }
  })
  return result
}

/** POST /quality/ncr/:ncrId/close (the route asks the office's step-up first): the closing e-signature (QHS-090). */
export async function closeNcr(caller: CommandCaller, ncrId: string, body: { readonly version: number; readonly note: string }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_CLOSE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.closeNcr', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockNcrRow(tools, ncrId, body.version)
    const { facts, decisions } = await factsNow(tools, current)
    const checks = closeChecklist(facts)
    if (!allMet(checks)) throw new StageRefusedError(checks)
    const note = body.note.trim()
    // The stages it skips, each move checked by the database at its UPDATE (the checks above met them all).
    for (const stage of stagesToClose(current.stage as NcrStage).filter((stage) => stage !== 'CLOSED')) {
      await tx.nonconformance.update({ where: { id: ncrId }, data: STAGE_TIMES(stage, now), select: { id: true } })
    }
    // The holds it decides: closed with it (decided here), their work orders lifted.
    const holdsClosed: string[] = []
    for (const hold of await tx.qualityHold.findMany({ where: { ncrId, status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })) {
      const closed = await closeHoldInCommand(tools, { holdId: hold.id, ncrId, note: `Decided in ${current.number}: ${note}`, closedById: context.actorId })
      holdsClosed.push(hold.id)
      tools.emit({ type: 'ncr.hold_closed', subject: ncrId, ...SCOPE_FIELDS(current), payload: { ncrId, number: current.number, holdId: hold.id, workOrdersLifted: closed.workOrdersLifted.map((entry) => entry.id) } })
    }
    const codes = new Map((await tx.dispositionCode.findMany({ where: { id: { in: decisions.map((decision) => decision.dispositionCodeId) } }, select: { id: true, code: true } })).map((code) => [code.id, code.code]))
    const signature = createHash('sha256')
      .update(
        closeStatement({
          ncrId,
          number: current.number,
          closedBy: `user ${context.actorId}`,
          closedAt: toUtcIso(now),
          quantityAffected: current.quantityAffected.toString(),
          uom: current.uom,
          decisions: decisions.map((decision) => ({ seq: decision.seq, code: codes.get(decision.dispositionCodeId) ?? decision.dispositionCodeId, quantity: decision.quantity.toString(), followUp: decision.followUpType ? `${decision.followUpType} ${decision.followUpId}` : null, stockMoveId: decision.stockMoveId })),
          note,
        }),
      )
      .digest('hex')
    const after = await tx.nonconformance.update({ where: { id: ncrId }, data: { stage: 'CLOSED', closedAt: now, closedById: context.actorId, closeNote: note, closeSignatureSha256: signature }, select: NCR_COLUMNS })
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), before: { stage: current.stage }, after: { stage: 'CLOSED', closeSignatureSha256: signature, holdsClosed, checks: checks.map((check) => check.words) }, reason: note })
    tools.emit({ type: 'ncr.stage_changed', subject: ncrId, ...SCOPE_FIELDS(current), payload: { ncrId, number: current.number, from: current.stage as NcrStage, to: 'CLOSED', holdsClosed } })
    return { record: await recordOf(tx, after, context, now), holdsClosed, signature }
  })
  return result
}

/** POST /quality/ncr/:ncrId/cancel: raised by mistake (OPEN or CONTAINED, nothing carried out), with the reason. */
export async function cancelNcr(caller: CommandCaller, ncrId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.cancelNcr', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockNcrRow(tools, ncrId, body.version)
    const { facts } = await factsNow(tools, current)
    const checks = stageChecks(facts, 'CANCELLED')
    if (!allMet(checks)) throw new StageRefusedError(checks)
    const reason = body.reason.trim()
    const after = await tx.nonconformance.update({ where: { id: ncrId }, data: { stage: 'CANCELLED', cancelledAt: now, cancelReason: reason }, select: NCR_COLUMNS })
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), before: { stage: current.stage }, after: { stage: 'CANCELLED' }, reason })
    tools.emit({ type: 'ncr.stage_changed', subject: ncrId, ...SCOPE_FIELDS(current), payload: { ncrId, number: current.number, from: current.stage as NcrStage, to: 'CANCELLED', holdsClosed: [] } })
    return { record: await recordOf(tx, after, context, now) }
  })
  return result
}

// ---- links, the register, a hold closed now -----------------------------------------------------------------------------

/** POST /quality/ncr/:ncrId/links: link a record (quality.ncr.raise). */
export async function linkRecord(caller: CommandCaller, ncrId: string, body: { readonly version: number; readonly recordType: string; readonly recordId: string; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_RAISE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.linkNcr', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockNcrRow(tools, ncrId, body.version)
    const target = await linkTarget(tx, body.recordType, body.recordId)
    if (!target || (target.companyId !== null && target.companyId !== current.companyId)) refuse([{ path: 'recordId', message: `Not a ${typeWords(body.recordType)} of the NCR's company.` }], 'The record is not found.')
    if (await tx.ncrLink.findFirst({ where: { ncrId, recordType: body.recordType, recordId: body.recordId }, select: { id: true } })) throw new ConflictError(`${target!.label} is linked already.`)
    if ((await tx.ncrLink.count({ where: { ncrId } })) >= NCR_LIMITS.links) throw new ConflictError(`An NCR links at most ${NCR_LIMITS.links} records.`)
    const id = newId()
    await tx.ncrLink.create({ data: { id, siteId: current.siteId, ncrId, recordType: body.recordType, recordId: body.recordId, note: body.note?.trim() || null, createdAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), after: { link: { id, recordType: body.recordType, recordId: body.recordId } } })
    emitChanged(tools, current, ['links'])
    return answerOf(tools, ncrId)
  })
  return result
}

/** DELETE /quality/ncr/:ncrId/links/:linkId (quality.ncr.manage; the audit log keeps it). */
export async function unlinkRecord(caller: CommandCaller, ncrId: string, linkId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.unlinkNcr', idempotencyKey, input: { ncrId, linkId, ...query } }, async (tools) => {
    const current = await lockNcrRow(tools, ncrId, query.version)
    const link = await tools.tx.ncrLink.findUnique({ where: { id: linkId }, select: { id: true, ncrId: true, recordType: true, recordId: true } })
    if (!link || link.ncrId !== ncrId) throw new NotFoundError('Link not found.')
    if (current.sourceType === link.recordType && current.sourceId === link.recordId) throw new ConflictError('This is the record the NCR was raised from: it stays linked.')
    await tools.tx.ncrLink.delete({ where: { id: linkId }, select: { id: true } })
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), before: { link } })
    emitChanged(tools, current, ['links'])
    return answerOf(tools, ncrId)
  })
  return result
}

/** POST /quality/ncr/:ncrId/register: open the NCR's PPE register entry now (a PPE style; once). */
export async function registerNcr(caller: CommandCaller, ncrId: string, body: { readonly version: number; readonly description?: string | null | undefined }, idempotencyKey?: string) {
  const { row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.registerNcr', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const current = await lockNcrRow(tools, ncrId, body.version)
    const entry = await openRegister(tools, current, body.description ?? null)
    if (!entry) throw new ConflictError('The PPE register keeps PPE: name the NCR\'s PPE style first.')
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), after: { registerEntryId: entry.id, reference: entry.reference, opened: entry.opened } })
    emitChanged(tools, current, ['register'])
    return answerOf(tools, ncrId)
  })
  return result
}

/** POST /quality/ncr/:ncrId/holds/:holdId/close: close a hold the NCR decides now (before an ISSUE of the held goods). */
export async function closeNcrHold(caller: CommandCaller, ncrId: string, holdId: string, body: { readonly version: number; readonly note: string }, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  assertOpen(row)
  const { result } = await command(caller, { name: 'quality.closeNcrHold', idempotencyKey, input: { ncrId, holdId, ...body } }, async (tools) => {
    const { tx } = tools
    const current = await lockNcrRow(tools, ncrId, body.version)
    const hold = isUuid(holdId) ? await tx.qualityHold.findUnique({ where: { id: holdId }, select: { id: true, ncrId: true, status: true } }) : null
    if (!hold || hold.ncrId !== ncrId) throw new NotFoundError('This NCR decides no such hold.')
    if (hold.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${hold.status.toLowerCase()} already.`)
    const closed = await closeHoldInCommand(tools, { holdId, ncrId, note: `Decided in ${current.number}: ${body.note.trim()}`, closedById: context.actorId })
    tools.audit({ recordType: NCR_RECORD, recordId: ncrId, ...SCOPE_FIELDS(current), after: { holdClosed: holdId }, reason: body.note.trim() })
    tools.emit({ type: 'ncr.hold_closed', subject: ncrId, ...SCOPE_FIELDS(current), payload: { ncrId, number: current.number, holdId, workOrdersLifted: closed.workOrdersLifted.map((entry) => entry.id) } })
    return { ...(await answerOf(tools, ncrId)), workOrdersLifted: closed.workOrdersLifted.map((entry) => entry.id) }
  })
  return result
}
