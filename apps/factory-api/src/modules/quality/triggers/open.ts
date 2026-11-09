import { Decimal } from 'decimal.js'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import type { Chip } from '@nexus/factory-domain/quality/plans/rules'
import { acceptanceOf, aqlStored, levelText } from '@nexus/factory-domain/quality/aql/sampling'
import { fixedSampling } from '@nexus/factory-domain/quality/final/plan'
import { aqlText, planProblems, type SamplingPlan } from '@nexus/factory-domain/quality/final/rules'
import { garmentsToInspect } from '@nexus/factory-domain/quality/queue/rules'
import { RELEASE_STATUSES } from '@nexus/factory-domain/quality/release/rules'
import { dueAtOf, RECORD_KIND_WORDS, skipWords, type RecordKind, type SkipReason, type TriggerEvent } from '@nexus/factory-domain/quality/triggers/rules'
import type { CommandTools } from '../../../core/command'
import { allocateNumber, assertNumberUniqueInTenant } from '../../../platform/numbering/allocate'
import { scanProgressOf } from '../../production/scans/progress'
import { aqlPlanFor } from '../aql/chain'
import { releasedPerCell } from '../final/store'
import { holdOnInspection } from '../holds/checks'
import type { BundleSubject, LotSubject, Subject, WorkshopSubject } from './facts'
import { becauseWords, OPENED_ACTION, SKIPPED_ACTION, TRIGGER_RECORD, type PlanFacts, type TriggerRow } from './store'

/**
 * Opening a record by rule, inside the system command of the event (B-W2b-101; the worker's handler, ./handler.ts). One
 * record per kind and subject, never a second OPEN one:
 *
 *   an incoming inspection   of a supplier's lot or of a workshop's receipt (IncomingInspection, INCOMING plan): under the
 *                            subject's lock (advisory `factory.incoming-inspection|tenant|<lot or receipt>`, ALSO taken by
 *                            the incoming inspection step's own open command, B-W2b-98: `lockIncomingSubject`), refused
 *                            while one is OPEN; numbered from the company's INCOMING_INSPECTION series; sampled by the
 *                            plan version (a fixed sample, or the AQL profile that applies: aqlPlanFor, B-W2b-93); no
 *                            inspector yet (who takes it is the bench's).
 *   an in-process check      of a bundle at an operation (InProcessCheck: CUTTING, FIRST_PIECE, ROVING, END_OF_LINE),
 *                            under the work order's lock (advisory `factory.inprocess-check|tenant|<work order>`, also for
 *                            B-W2b-99: `lockWorkOrderChecks`): refused while one of its kind is OPEN at that bundle and
 *                            operation (every lot: at that operation); a first piece while one not cancelled is there
 *                            (the database holds the run on it), and only while its bundle is the only one at the
 *                            operation (it would stop work already in hand). No number (the plan names none).
 *   a final inspection       (B-W2b-213, a PACKING rule) of the garments of the bundle's work order that wait: finished,
 *                            neither released nor in an open inspection (`garmentsToInspect`), under the work order's
 *                            lock (advisory `factory.final-inspection|tenant|<work order>`); none when nothing waits, the
 *                            work order is held or not in production; numbered from the company's INSPECTION series;
 *                            sampled by the plan version (a fixed sample, or the AQL profile that applies); NO inspector:
 *                            the first inspector who records it is written then (the database lets it wait so, B-W2b-204).
 * Every record a rule opens names the rule (openedByTriggerId) and, when the rule says so, is due its hours after the
 * opening (dueAt = now + dueHours; the office moves it later). B-W2b-213.
 * Nothing opened is said on the rule's audit trail (SKIPPED_ACTION, with the words); what opened, too (OPENED_ACTION),
 * beside the record's own audit row and the event `inspection_trigger.inspection_opened`.
 */

type Tools = CommandTools
type Tx = Tools['tx']

export const lockIncomingSubject = (tx: Tx, subjectId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.incoming-inspection', current_setting('factory.tenant_id', true), ${subjectId}::text), 0))`

export const lockWorkOrderChecks = (tx: Tx, workOrderId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.inprocess-check', current_setting('factory.tenant_id', true), ${workOrderId}::text), 0))`

/** B-W2b-213: one final inspection opened by rule at a time per work order (two packing reports never open two). */
export const lockFinalSubject = (tx: Tx, workOrderId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.final-inspection', current_setting('factory.tenant_id', true), ${workOrderId}::text), 0))`

export interface Opening {
  readonly rule: Pick<TriggerRow, 'id' | 'companyId' | 'event' | 'dueHours'>
  readonly plan: PlanFacts
  readonly kind: RecordKind
  readonly because: readonly Chip[]
}

export type OpenedType = 'IncomingInspection' | 'InProcessCheck' | 'Inspection'
export type Outcome = { readonly opened: { readonly recordType: OpenedType; readonly id: string; readonly number: string | null } } | { readonly skipped: SkipReason }

function skip(tools: Tools, opening: Opening, subject: Subject, reason: SkipReason, extra: { count?: number; uom?: string } = {}): Outcome {
  const words = skipWords(reason, { subject: subject.label, plan: opening.plan.code, ...extra })
  tools.audit({ action: SKIPPED_ACTION, recordType: TRIGGER_RECORD, recordId: opening.rule.id, companyId: opening.rule.companyId, siteId: subject.siteId, after: { subject: subject.key, kind: opening.kind, reason, words: { ...words } } })
  return { skipped: reason }
}

async function opened(tools: Tools, opening: Opening, subject: Subject, record: { recordType: OpenedType; id: string; number: string | null }): Promise<Outcome> {
  const words = await becauseWords(tools.tx, `${opening.plan.code} v${opening.plan.approved!.number}`, opening.because)
  tools.audit({ action: OPENED_ACTION, recordType: TRIGGER_RECORD, recordId: opening.rule.id, companyId: opening.rule.companyId, siteId: subject.siteId, after: { subject: subject.key, kind: opening.kind, recordType: record.recordType, recordId: record.id, number: record.number, words } })
  tools.emit({
    type: 'inspection_trigger.inspection_opened',
    subject: record.id,
    companyId: subject.companyId,
    siteId: subject.siteId,
    payload: {
      triggerId: opening.rule.id,
      event: opening.rule.event as TriggerEvent,
      recordType: record.recordType,
      recordId: record.id,
      kind: opening.kind,
      inspectionNumber: record.number,
      planId: opening.plan.id,
      planVersionId: opening.plan.approved!.id,
      lotId: subject.type === 'LOT' ? subject.lotId : null,
      workOrderId: subject.type === 'LOT' ? null : subject.workOrderId,
      bundleId: subject.type === 'BUNDLE' ? subject.bundleId : null,
    },
  })
  return { opened: record }
}

/** The plan version records open on, as it is inside this command (it may have been retired since the rules were read). */
async function versionNow(tx: Tx, plan: PlanFacts) {
  return tx.inspectionPlanVersion.findFirst({ where: { planId: plan.id, status: 'APPROVED' }, select: { id: true, number: true, samplingMethod: true, fixedSampleSize: true } })
}

// ---- an incoming inspection ----------------------------------------------------------------------------------------------

/** Opens an incoming inspection of the lot or workshop receipt, or says why not. */
export async function openIncoming(tools: Tools, opening: Opening, subject: LotSubject | WorkshopSubject): Promise<Outcome> {
  const { tx, now } = tools
  const subjectId = subject.type === 'LOT' ? subject.lotId : subject.subcontractReceiptId
  await lockIncomingSubject(tx, subjectId)
  const open = await tx.incomingInspection.count({ where: { status: 'OPEN', ...(subject.type === 'LOT' ? { lotId: subject.lotId } : { subcontractReceiptId: subject.subcontractReceiptId }) } })
  if (open > 0) return skip(tools, opening, subject, 'ALREADY_OPEN')
  const version = await versionNow(tx, opening.plan)
  if (!version) return skip(tools, opening, subject, 'NO_APPROVED_VERSION')
  const lot = new Decimal(subject.lotSize)
  const whole = lot.floor().toNumber()
  let sampling: { aqlProfileId: string | null; codeLetter: string | null; sampleSize: number; inspectionLevel: string | null; aqlMajor: string | null; aqlMinor: string | null; acceptMajor: number | null; acceptMinor: number | null; note: string | null }
  if (version.samplingMethod === 'FIXED') {
    if (whole < 1) return skip(tools, opening, subject, 'LOT_EMPTY')
    sampling = { aqlProfileId: null, codeLetter: null, sampleSize: Math.min(version.fixedSampleSize ?? 1, whole), inspectionLevel: null, aqlMajor: null, aqlMinor: null, acceptMajor: null, acceptMinor: null, note: null }
  } else {
    if (!subject.countable || !lot.isInteger()) return skip(tools, opening, subject, 'LOT_NOT_COUNTED', { uom: subject.uom })
    if (whole < 1) return skip(tools, opening, subject, 'LOT_EMPTY')
    const answer = await aqlPlanFor(tx, { companyId: subject.companyId, planVersionId: version.id, styleId: subject.styleId, customerIds: subject.customerIds, lotSize: whole })
    if (answer.plan && answer.profile) {
      const plan = answer.plan
      const acceptance = acceptanceOf(plan)
      const aql = (defectClass: 'MAJOR' | 'MINOR') => aqlStored(plan.classes.find((entry) => entry.defectClass === defectClass)!.aql)
      sampling = { aqlProfileId: answer.profile.id, codeLetter: plan.codeLetter, sampleSize: plan.sampleSize, inspectionLevel: levelText(plan.level as InspectionLevel), aqlMajor: aql('MAJOR'), aqlMinor: aql('MINOR'), ...acceptance, note: null }
    } else {
      // No AQL profile applies (none named, no style, customer or company default): the whole lot, said on the record.
      sampling = { aqlProfileId: null, codeLetter: null, sampleSize: whole, inspectionLevel: null, aqlMajor: null, aqlMinor: null, acceptMajor: null, acceptMinor: null, note: 'No AQL profile applies to this lot (no style, customer or company default): the whole lot is inspected.' }
    }
  }
  const id = newId()
  let number: string
  try {
    const issued = await allocateNumber(tools, { companyId: subject.companyId, kind: 'INCOMING_INSPECTION' }, { type: 'IncomingInspection', id })
    await assertNumberUniqueInTenant(tools, issued)
    number = issued.formatted
  } catch (error) {
    if (error instanceof NotFoundError) return skip(tools, opening, subject, 'NO_SERIES')
    throw error
  }
  await tx.incomingInspection.create({
    data: {
      id,
      companyId: subject.companyId,
      siteId: subject.siteId,
      number,
      ...(subject.type === 'LOT' ? { lotId: subject.lotId, itemId: subject.itemId } : { subcontractReceiptId: subject.subcontractReceiptId, workOrderId: subject.workOrderId }),
      planVersionId: version.id,
      aqlProfileId: sampling.aqlProfileId,
      codeLetter: sampling.codeLetter,
      lotSize: subject.lotSize,
      uom: subject.uom,
      sampleSize: sampling.sampleSize,
      inspectionLevel: sampling.inspectionLevel,
      aqlMajor: sampling.aqlMajor,
      aqlMinor: sampling.aqlMinor,
      acceptMajor: sampling.acceptMajor,
      acceptMinor: sampling.acceptMinor,
      note: sampling.note,
      // B-W2b-213: the rule that opened it, and by when it is due (the rule's hours).
      openedByTriggerId: opening.rule.id,
      dueAt: dueAtOf(now, opening.rule.dueHours),
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  tools.audit({
    recordType: 'IncomingInspection',
    recordId: id,
    companyId: subject.companyId,
    siteId: subject.siteId,
    after: { number, subject: subject.key, planVersionId: version.id, plan: `${opening.plan.code} v${version.number}`, lotSize: subject.lotSize, uom: subject.uom, sampleSize: sampling.sampleSize, aqlProfileId: sampling.aqlProfileId, codeLetter: sampling.codeLetter, status: 'OPEN', byRule: opening.rule.id, dueHours: opening.rule.dueHours },
  })
  return opened(tools, opening, subject, { recordType: 'IncomingInspection', id, number })
}

// ---- an in-process check -------------------------------------------------------------------------------------------------

const IN_PROCESS_KIND: Readonly<Record<Exclude<RecordKind, 'INCOMING' | 'FINAL'>, 'CUTTING' | 'FIRST_PIECE' | 'ROVING' | 'END_OF_LINE'>> = { CUTTING: 'CUTTING', FIRST_PIECE: 'FIRST_PIECE', ROVING: 'ROVING', END_OF_LINE: 'END_OF_LINE' }

/** Opens an in-process check of the bundle at its operation, or says why not. */
export async function openInProcess(tools: Tools, opening: Opening & { readonly kind: Exclude<RecordKind, 'INCOMING' | 'FINAL'> }, subject: BundleSubject, frequency: string): Promise<Outcome> {
  const { tx, now } = tools
  await lockWorkOrderChecks(tx, subject.workOrderId)
  const kind = IN_PROCESS_KIND[opening.kind]
  if (kind === 'FIRST_PIECE') {
    const held = await tx.inProcessCheck.count({ where: { workOrderId: subject.workOrderId, kind: 'FIRST_PIECE', status: { not: 'CANCELLED' }, OR: [{ workOrderOperationId: subject.workOrderOperationId }, { workOrderOperationId: null }] } })
    if (held > 0) return skip(tools, opening, subject, 'FIRST_PIECE_DONE')
    // Read again under the lock: other bundles reached the operation since the event; a hold now would stop them mid-work.
    const others = new Set((await tx.operationScan.findMany({ where: { workOrderId: subject.workOrderId, workOrderOperationId: subject.workOrderOperationId, bundleId: { not: subject.bundleId }, kind: { notIn: ['UNDO', 'CORRECTION'] } }, select: { bundleId: true } })).map((row) => row.bundleId)).size
    if (others > 0) return skip(tools, opening, subject, 'FIRST_PIECE_LATE', { count: others + 1 })
  } else {
    // Every lot: one open at the operation of the work order; otherwise one open per bundle there.
    const open = await tx.inProcessCheck.count({ where: { workOrderId: subject.workOrderId, kind, status: 'OPEN', workOrderOperationId: subject.workOrderOperationId, ...(frequency === 'EVERY_LOT' ? {} : { bundleId: subject.bundleId }) } })
    if (open > 0) return skip(tools, opening, subject, 'ALREADY_OPEN')
  }
  const version = await versionNow(tx, opening.plan)
  if (!version) return skip(tools, opening, subject, 'NO_APPROVED_VERSION')
  let profile: { id: string; codeLetter: string | null; sampleSize: number } | null = null
  if (version.samplingMethod === 'AQL_PROFILE' && subject.bundleQuantity >= 1) {
    const answer = await aqlPlanFor(tx, { companyId: subject.companyId, planVersionId: version.id, styleId: subject.styleId, customerIds: subject.customerIds, lotSize: subject.bundleQuantity })
    if (answer.plan && answer.profile) profile = { id: answer.profile.id, codeLetter: answer.plan.codeLetter, sampleSize: answer.plan.sampleSize }
  }
  const id = newId()
  await tx.inProcessCheck.create({
    data: {
      id,
      companyId: subject.companyId,
      siteId: subject.siteId,
      kind,
      lineId: subject.lineId,
      workOrderId: subject.workOrderId,
      bundleId: subject.bundleId,
      workOrderOperationId: subject.workOrderOperationId,
      planVersionId: version.id,
      aqlProfileId: profile?.id ?? null,
      codeLetter: profile?.codeLetter ?? null,
      // B-W2b-213: the AQL sample frozen at opening, the rule that opened it, by when it is due.
      sampleSize: profile?.sampleSize ?? null,
      openedByTriggerId: opening.rule.id,
      dueAt: dueAtOf(now, opening.rule.dueHours),
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  tools.audit({
    recordType: 'InProcessCheck',
    recordId: id,
    companyId: subject.companyId,
    siteId: subject.siteId,
    after: { kind, kindWords: { ...RECORD_KIND_WORDS[opening.kind] }, subject: subject.key, planVersionId: version.id, plan: `${opening.plan.code} v${version.number}`, aqlProfileId: profile?.id ?? null, codeLetter: profile?.codeLetter ?? null, sampleSize: profile?.sampleSize ?? null, status: 'OPEN', byRule: opening.rule.id, dueHours: opening.rule.dueHours },
  })
  return opened(tools, opening, subject, { recordType: 'InProcessCheck', id, number: null })
}

// ---- a final inspection at packing (B-W2b-213) ---------------------------------------------------------------------------

/**
 * Opens the final inspection of the garments of the bundle's work order that wait (finished, neither released nor in an
 * open inspection), with no inspector, or says why not. Sampled as the bench opens one (B-W2b-97): the plan version's fixed
 * sample on the lot, else the AQL profile the chain gives (`aqlPlanFor`: plan version › style of the customer › style ›
 * customer › company default).
 */
export async function openFinal(tools: Tools, opening: Opening, subject: BundleSubject): Promise<Outcome> {
  const { tx, now } = tools
  await lockFinalSubject(tx, subject.workOrderId)
  const order = await tx.workOrder.findUnique({ where: { id: subject.workOrderId }, select: { id: true, number: true, status: true, siteId: true, companyId: true, styleId: true } })
  if (!order || !(RELEASE_STATUSES as readonly string[]).includes(order.status)) return skip(tools, opening, subject, 'WORK_ORDER_HELD')
  // B-W2a-F1's hook (wave 5's Inspection_awaits_hold): a work order on hold has its garments inspected after the hold.
  if (await holdOnInspection(tx, tools.context, { workOrderId: order.id })) return skip(tools, opening, subject, 'WORK_ORDER_HELD')
  const cells = await tx.workOrderSize.findMany({ where: { workOrderId: order.id }, select: { id: true, quantity: true } })
  const pieces = cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const progress = [...(await scanProgressOf(tx, order)).values()].map((cell) => cell.finished)
  const finished = progress.length === 0 ? 0 : progress.some((value) => value === null) ? null : progress.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  const released = [...(await releasedPerCell(tx, cells.map((cell) => cell.id))).values()].reduce((sum, entry) => sum + entry.released - entry.reversed, 0)
  const inOpen = (await tx.inspection.findMany({ where: { workOrderId: order.id, status: 'OPEN' }, select: { lotSize: true } })).reduce((sum, row) => sum + row.lotSize, 0)
  const waiting = garmentsToInspect({ finished, released, inOpenInspections: inOpen })
  if (waiting < 1) return skip(tools, opening, subject, 'NOTHING_WAITING')
  const version = await versionNow(tx, opening.plan)
  if (!version) return skip(tools, opening, subject, 'NO_APPROVED_VERSION')
  let plan: SamplingPlan
  let profile: { id: string; codeLetter: string | null } | null = null
  if (version.samplingMethod === 'FIXED') {
    plan = fixedSampling(version.fixedSampleSize ?? 1, waiting)
  } else {
    const answer = await aqlPlanFor(tx, { companyId: order.companyId, planVersionId: version.id, styleId: order.styleId, customerIds: subject.customerIds, lotSize: waiting })
    if (!answer.plan || !answer.profile) return skip(tools, opening, subject, 'NO_PROFILE')
    const accept = acceptanceOf(answer.plan)
    const aql = (defectClass: 'MAJOR' | 'MINOR') => aqlStored(answer.plan!.classes.find((entry) => entry.defectClass === defectClass)!.aql)
    plan = { lotSize: waiting, sampleSize: answer.plan.sampleSize, inspectionLevel: levelText(answer.plan.level as InspectionLevel), aqlMajor: aql('MAJOR'), aqlMinor: aql('MINOR'), acceptMajor: accept.acceptMajor, acceptMinor: accept.acceptMinor }
    profile = { id: answer.profile.id, codeLetter: answer.plan.codeLetter }
  }
  if (planProblems(plan, { pieces, finished }).length > 0) return skip(tools, opening, subject, 'NOTHING_WAITING')
  const id = newId()
  let number: string
  try {
    const issued = await allocateNumber(tools, { companyId: order.companyId, kind: 'INSPECTION' }, { type: 'Inspection', id })
    await assertNumberUniqueInTenant(tools, issued)
    number = issued.formatted
  } catch (error) {
    if (error instanceof NotFoundError) return skip(tools, opening, subject, 'NO_INSPECTION_SERIES')
    throw error
  }
  const dueAt = dueAtOf(now, opening.rule.dueHours)
  await tx.inspection.create({
    data: {
      id,
      companyId: order.companyId,
      siteId: order.siteId,
      workOrderId: order.id,
      number,
      lotSize: plan.lotSize,
      sampleSize: plan.sampleSize,
      inspectionLevel: plan.inspectionLevel,
      aqlMajor: aqlText(plan.aqlMajor),
      aqlMinor: aqlText(plan.aqlMinor),
      acceptMajor: plan.acceptMajor,
      acceptMinor: plan.acceptMinor,
      planVersionId: version.id,
      aqlProfileId: profile?.id ?? null,
      codeLetter: profile?.codeLetter ?? null,
      inspectedCount: 0,
      // No inspector: the first who records it is written then (the database allows it on a rule's OPEN inspection).
      inspectorWorkerId: null,
      inspectorUserId: null,
      openedByTriggerId: opening.rule.id,
      dueAt,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  tools.audit({
    recordType: 'Inspection',
    recordId: id,
    companyId: order.companyId,
    siteId: order.siteId,
    after: { number, workOrderId: order.id, subject: subject.key, planVersionId: version.id, plan: `${opening.plan.code} v${version.number}`, ...plan, aqlProfileId: profile?.id ?? null, codeLetter: profile?.codeLetter ?? null, status: 'OPEN', inspector: null, byRule: opening.rule.id, dueHours: opening.rule.dueHours },
  })
  return opened(tools, opening, subject, { recordType: 'Inspection', id, number })
}
