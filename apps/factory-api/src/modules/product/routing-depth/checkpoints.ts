import { createHash } from 'node:crypto'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { checkpointKindOf, stepIsFor } from '@nexus/factory-domain/product/routing-depth/rules'
import { RECORD_KIND_WORDS, selects, skipWords, type RecordKind, type SkipReason } from '@nexus/factory-domain/quality/triggers/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { aqlPlanFor } from '../../quality/aql/chain'
import { bundleSubject, type BundleSubject } from '../../quality/triggers/facts'
import { lockWorkOrderChecks } from '../../quality/triggers/open'
import type { Db as TriggerDb } from '../../quality/triggers/store'
import { readPlans, variantsOfRow, type Db, type PlanRow } from './store'

/**
 * Quality checkpoints in the routing (B-W2b-225; PRD-119; "a routing operation names an inspection plan as its checkpoint;
 * the in-process trigger of B-W2b-101 reads it"): the worker's handler `product.routingCheckpoints`, listed in
 * background.ts (W2B_225_HANDLERS). On `production.scan_recorded` REPORT — the bundle's first report at a work order's
 * operation (the rules' OPERATION_FINISHED, quality/triggers facts `bundleSubject`) — it reads the operation's routing step
 * (WorkOrderOperation styleRevisionId + routingSeq: the revision's step, frozen with it) and, when the step names a plan:
 *
 *   for the cell   only a bundle of a size and colourway the step is for (a step for every cell: every bundle)
 *   the plan       of the work order's company, a cutting, in-line or end-of-line plan with an APPROVED version; its record
 *                  kind and how often from that version (factory-domain product/routing-depth `checkpointKindOf`; the
 *                  rules' `selects` with the step's id as the draw's key: every lot = the work order's first bundle there,
 *                  every Nth bundle, a share of operations, first piece)
 *   one open     ONE system command per bundle and operation, under the work order's check lock that the rules and the
 *                in-process step take too (quality/triggers open.ts `lockWorkOrderChecks`): never a second OPEN check of
 *                the kind at that bundle and operation (every lot: at the operation), whoever opened the first — a rule or
 *                the checkpoint; a first piece only while its bundle is the only one at the operation and none is there
 *                yet (as the rules). The check names no operator.
 *
 * Read first, as the tenant's system caller: an operation whose step names no plan costs three reads and writes nothing.
 * What opened is on the check's audit row (`byCheckpoint`) and the step's trail (product.checkpointOpened), with the event
 * `routing_checkpoint.check_opened`; a check not opened inside the command says why on the step's trail
 * (product.checkpointSkipped, the rules' words).
 */

export const OPENED_ACTION = 'product.checkpointOpened'
export const SKIPPED_ACTION = 'product.checkpointSkipped'

type InProcessKind = Exclude<RecordKind, 'INCOMING'>

interface Planned {
  readonly subject: BundleSubject
  readonly step: { readonly id: string; readonly seq: number; readonly code: string }
  readonly plan: PlanRow & { readonly approved: NonNullable<PlanRow['approved']> }
  readonly kind: InProcessKind
}

/** What a scan's checkpoint would open, read as the caller (no write); null: nothing. */
export async function plannedCheckpoint(db: Db, event: Pick<EventEnvelope, 'type' | 'payload'>): Promise<Planned | null> {
  const payload = event.payload as { kind?: unknown; scanId?: unknown } | null
  if (event.type !== 'production.scan_recorded' || payload?.kind !== 'REPORT' || typeof payload.scanId !== 'string') return null
  const scan = await db.operationScan.findUnique({ where: { id: payload.scanId }, select: { workOrderOperationId: true, bundleId: true } })
  if (!scan) return null
  const operation = await db.workOrderOperation.findUnique({ where: { id: scan.workOrderOperationId }, select: { styleRevisionId: true, routingSeq: true } })
  if (!operation || operation.routingSeq === null) return null
  const step = await db.routingOperation.findFirst({
    where: { revisionId: operation.styleRevisionId, seq: operation.routingSeq },
    select: { id: true, seq: true, code: true, inspectionPlanId: true, appliesToSizes: true, appliesToColourwayIds: true, appliesToOptionValueIds: true },
  })
  if (!step?.inspectionPlanId) return null
  const bundle = await db.bundle.findUnique({ where: { id: scan.bundleId }, select: { workOrderSizeId: true } })
  const cell = bundle ? await db.workOrderSize.findUnique({ where: { id: bundle.workOrderSizeId }, select: { colourwayId: true, size: true } }) : null
  if (!cell || !stepIsFor(variantsOfRow(step), cell)) return null
  const subject = await bundleSubject(db as unknown as TriggerDb, payload.scanId, ['REPORT'])
  if (!subject) return null
  const plan = (await readPlans(db, [step.inspectionPlanId])).get(step.inspectionPlanId)
  if (!plan?.approved || plan.companyId !== subject.companyId) return null
  const kind = checkpointKindOf(plan.stage, plan.approved.frequency)
  if (!kind) return null
  if (!selects({ id: step.id, frequency: plan.approved.frequency ?? 'EVERY_LOT', frequencyValue: plan.approved.frequencyValue }, subject.occurrence)) return null
  return { subject, step: { id: step.id, seq: step.seq, code: step.code }, plan: { ...plan, approved: plan.approved }, kind }
}

type Outcome = { readonly opened: { readonly id: string; readonly kind: InProcessKind } } | { readonly skipped: SkipReason }

function skip(tools: CommandTools, planned: Planned, reason: SkipReason, count?: number): Outcome {
  const words = skipWords(reason, { subject: planned.subject.label, plan: planned.plan.code, ...(count === undefined ? {} : { count }) })
  tools.audit({ action: SKIPPED_ACTION, recordType: 'RoutingOperation', recordId: planned.step.id, companyId: planned.subject.companyId, siteId: planned.subject.siteId, after: { subject: planned.subject.key, kind: planned.kind, reason, words: { ...words } } })
  return { skipped: reason }
}

/** Opens the checkpoint's check of the bundle at its operation, or says why not (inside the system command). */
export async function openCheckpointInCommand(tools: CommandTools, planned: Planned): Promise<Outcome> {
  const { tx, now } = tools
  const { subject, kind } = planned
  await lockWorkOrderChecks(tx, subject.workOrderId)
  if (kind === 'FIRST_PIECE') {
    const held = await tx.inProcessCheck.count({ where: { workOrderId: subject.workOrderId, kind: 'FIRST_PIECE', status: { not: 'CANCELLED' }, OR: [{ workOrderOperationId: subject.workOrderOperationId }, { workOrderOperationId: null }] } })
    if (held > 0) return skip(tools, planned, 'FIRST_PIECE_DONE')
    const others = new Set((await tx.operationScan.findMany({ where: { workOrderId: subject.workOrderId, workOrderOperationId: subject.workOrderOperationId, bundleId: { not: subject.bundleId }, kind: { notIn: ['UNDO', 'CORRECTION'] } }, select: { bundleId: true } })).map((row) => row.bundleId)).size
    if (others > 0) return skip(tools, planned, 'FIRST_PIECE_LATE', others + 1)
  } else {
    const everyLot = (planned.plan.approved.frequency ?? 'EVERY_LOT') === 'EVERY_LOT'
    const open = await tx.inProcessCheck.count({ where: { workOrderId: subject.workOrderId, kind, status: 'OPEN', workOrderOperationId: subject.workOrderOperationId, ...(everyLot ? {} : { bundleId: subject.bundleId }) } })
    if (open > 0) return skip(tools, planned, 'ALREADY_OPEN')
  }
  // The version records open on, as it is inside this command (it may have been retired since the read).
  const version = await tx.inspectionPlanVersion.findFirst({ where: { planId: planned.plan.id, status: 'APPROVED' }, select: { id: true, number: true, samplingMethod: true } })
  if (!version) return skip(tools, planned, 'NO_APPROVED_VERSION')
  let profile: { id: string; codeLetter: string | null } | null = null
  if (version.samplingMethod === 'AQL_PROFILE' && subject.bundleQuantity >= 1) {
    const answer = await aqlPlanFor(tx, { companyId: subject.companyId, planVersionId: version.id, styleId: subject.styleId, customerIds: subject.customerIds, lotSize: subject.bundleQuantity })
    if (answer.plan && answer.profile) profile = { id: answer.profile.id, codeLetter: answer.plan.codeLetter }
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
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  const plan = `${planned.plan.code} v${version.number}`
  tools.audit({
    recordType: 'InProcessCheck',
    recordId: id,
    companyId: subject.companyId,
    siteId: subject.siteId,
    after: { kind, kindWords: { ...RECORD_KIND_WORDS[kind] }, subject: subject.key, planVersionId: version.id, plan, aqlProfileId: profile?.id ?? null, codeLetter: profile?.codeLetter ?? null, status: 'OPEN', byCheckpoint: planned.step.id },
  })
  tools.audit({
    action: OPENED_ACTION,
    recordType: 'RoutingOperation',
    recordId: planned.step.id,
    companyId: subject.companyId,
    siteId: subject.siteId,
    after: {
      subject: subject.key,
      kind,
      recordId: id,
      words: { it: `${RECORD_KIND_WORDS[kind].it} ${plan}: ${subject.label} (punto di controllo della fase ${planned.step.seq} ${planned.step.code}).`, en: `${RECORD_KIND_WORDS[kind].en} ${plan}: ${subject.label} (the checkpoint of step ${planned.step.seq} ${planned.step.code}).` },
    },
  })
  tools.emit({
    type: 'routing_checkpoint.check_opened',
    subject: id,
    companyId: subject.companyId,
    siteId: subject.siteId,
    payload: { routingStepId: planned.step.id, recordId: id, kind, planId: planned.plan.id, planVersionId: version.id, workOrderId: subject.workOrderId, workOrderOperationId: subject.workOrderOperationId, bundleId: subject.bundleId },
  })
  return { opened: { id, kind } }
}

const keyOf = (eventId: string, subjectKey: string): string => `checkpoint-open.${createHash('sha256').update(`${eventId}|${subjectKey}`).digest('hex').slice(0, 56)}`

/** What a scan's checkpoint comes to: nothing (null), or one system command's outcome. */
export async function applyCheckpoint(caller: CommandCaller, event: EventEnvelope): Promise<Outcome | null> {
  const planned = await caller.withClient((client) => plannedCheckpoint(client, event))
  if (!planned) return null
  const { result } = await runCommand(
    caller,
    {
      name: 'product.openCheckpointCheck',
      idempotencyKey: keyOf(event.eventId, planned.subject.key),
      input: { eventId: event.eventId, subject: planned.subject.key, routingStepId: planned.step.id, planId: planned.plan.id, kind: planned.kind },
      causationId: event.eventId,
    },
    (tools) => openCheckpointInCommand(tools, planned),
    COMMAND_SETTINGS,
  )
  return result
}

export function routingCheckpointHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'product.routingCheckpoints',
      events: ['production.scan_recorded'],
      async handle(event, { caller }) {
        await applyCheckpoint(caller, event)
      },
    }),
  ]
}
