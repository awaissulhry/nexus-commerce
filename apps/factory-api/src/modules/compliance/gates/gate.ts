import type { Prisma } from '@nexus/factory-db'
import { decide, explanationOf, refusalIssues, type GateDecision, type GateRefusal, type GateTarget } from '@nexus/factory-domain/compliance/gates/gate'
import { checkOf, type ComplianceGate, type RequirementRow } from '@nexus/factory-domain/compliance/requirements/rules'
import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import type { Reader } from '../register-of-rules/common'
import { ensureW1Requirement, gateRequirements } from '../requirements/store'
import { checkerFor, checksAsked, countryOf, marketOfCountry, overridesFor, readGateStyle, readMarkets, styleLabelTemplateId } from './facts'

/**
 * The one gate through the API (B-W2b-254; PRD-272): work-order release, label print, final release and shipment call it
 * (each in its own step, marked B-W2b-254 there). `decideGate(db, ask)` reads the facts and the domain decides (factory-
 * domain compliance/gates/gate.ts `decide`): every line, the first missing requirement that blocks the gate, in words.
 *
 * A refusal is a GateEvent (REFUSED). The step that refuses rolls its own transaction back, so the refusal is written
 * after it, in a command of its own in the tenant's system context (`recordRefusals`; the floor role may write its site's
 * refusals, but a first refusal may also have to write W1's certificate requirement row, which only the office side may):
 * `withGateRecords(caller, key, work)` wraps the step and writes the refusals its error (or its answer, for a label print
 * that printed the other sizes) carries. A failure to write a refusal never hides the step's own answer (it is logged).
 */

export interface GateAsk {
  readonly gate: ComplianceGate
  readonly subjectType: 'WorkOrder' | 'Shipment'
  readonly subjectId: string
  /** "Work order WO-00012". */
  readonly subjectWords: string
  readonly companyId: string
  readonly siteId: string | null
  readonly styleId: string
  /** The label template the label checks read (null: the style's released revision's). */
  readonly labelTemplateId?: string | null | undefined
  readonly targets: readonly GateTarget[]
  readonly day: BusinessDate
  readonly now: Date
}

export interface GateAnswer {
  readonly ask: GateAsk
  readonly decision: GateDecision
}

/** The gate's answer with this reader (a request's client, or a command's transaction). */
export async function decideGate(db: Reader, ask: GateAsk): Promise<GateAnswer> {
  const style = await readGateStyle(db, ask.styleId)
  if (!style) throw new DomainError('not_found', 'Style not found.')
  const requirements = await gateRequirements(db)
  const overrides = await overridesFor(db, ask.gate, ask.subjectType, ask.subjectId, ask.now)
  const labelTemplateId = ask.labelTemplateId ?? (await styleLabelTemplateId(db, ask.styleId))
  const check = await checkerFor(db, {
    style,
    labelTemplateId,
    day: ask.day,
    checks: checksAsked(requirements, checkOf),
    marketCodes: ask.targets.flatMap((target) => (target.market ? [target.market.code] : [])),
    targets: ask.targets,
    subject: { type: ask.subjectType, id: ask.subjectId },
    companyId: ask.companyId,
  })
  const decision = decide({ gate: ask.gate, subjectWords: ask.subjectWords, style: style.subject, targets: ask.targets, requirements, check, overrides, day: ask.day, now: ask.now })
  return { ask, decision }
}

// ---- targets ----------------------------------------------------------------------------------------------------------

/**
 * The cells of a work order as the gate's targets: colourway × size for the market its order goes to (the order's
 * delivery address, as accepted). The style × market link is a schema need: `sellsThere` is false, so a language rule for
 * every market waits (see the domain gate) and a rule for one market applies to goods going there.
 */
export async function workOrderTargets(db: Reader, workOrderId: string, cellIds?: readonly string[]): Promise<GateTarget[]> {
  const cells = await db.workOrderSize.findMany({
    where: { workOrderId, ...(cellIds ? { id: { in: [...cellIds] } } : {}) },
    select: { id: true, colourwayId: true, size: true, colourway: { select: { code: true } }, salesOrderLine: { select: { order: { select: { shipTo: true } } } } },
    orderBy: [{ id: 'asc' }],
  })
  const markets = await readMarkets(db)
  return cells.map((cell) => {
    const destination = countryOf((cell.salesOrderLine as { order?: { shipTo?: unknown } } | null)?.order?.shipTo ?? null)
    const market = marketOfCountry(destination, markets)
    return { key: cell.id, label: `${cell.colourway.code} ${cell.size}`, colourwayId: cell.colourwayId, colourwayCode: cell.colourway.code, size: cell.size, destination, market, sellsThere: false }
  })
}

/** A shipment's lines as the gate's targets, per style (one decision per style), for the shipment's destination. */
export async function shipmentTargets(db: Reader, shipmentId: string): Promise<{ number: string; companyId: string; siteId: string; styles: Map<string, GateTarget[]> } | null> {
  const shipment = await db.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, number: true, companyId: true, siteId: true, shipTo: true } })
  if (!shipment) return null
  const lines = await db.shipmentLine.findMany({
    where: { shipmentId },
    select: { id: true, size: true, workOrderSize: { select: { colourwayId: true, colourway: { select: { code: true } }, workOrder: { select: { styleId: true } } } } },
    orderBy: [{ id: 'asc' }],
  })
  const markets = await readMarkets(db)
  const destination = countryOf(shipment.shipTo)
  const market = marketOfCountry(destination, markets)
  const styles = new Map<string, GateTarget[]>()
  const seen = new Set<string>()
  for (const line of lines) {
    const styleId = line.workOrderSize.workOrder.styleId
    const key = `${styleId}|${line.workOrderSize.colourwayId}|${line.size}`
    if (seen.has(key)) continue
    seen.add(key)
    styles.set(styleId, [
      ...(styles.get(styleId) ?? []),
      { key: line.id, label: `${line.workOrderSize.colourway.code} ${line.size}`, colourwayId: line.workOrderSize.colourwayId, colourwayCode: line.workOrderSize.colourway.code, size: line.size, destination, market, sellsThere: false },
    ])
  }
  return { number: shipment.number, companyId: shipment.companyId, siteId: shipment.siteId, styles }
}

// ---- refusals -----------------------------------------------------------------------------------------------------------

/** A refusal to write as a GateEvent once the refused step has rolled back. */
export interface PendingRefusal {
  readonly gate: ComplianceGate
  readonly subjectType: string
  readonly subjectId: string
  readonly companyId: string
  readonly siteId: string | null
  readonly styleId: string
  readonly marketCode: string | null
  /** null: W1's built-in certificate requirement (its row is written first). */
  readonly requirementId: string | null
  readonly requirementCode: string
  readonly words: string
  readonly explanation: Record<string, unknown>
  /** The person who asked (an office user or a floor worker; null: a station that records nobody). */
  readonly createdById: string | null
  /** Within one step, one event per requirement and target. */
  readonly targetKey: string
}

export function pendingOf(answer: GateAnswer, refusal: GateRefusal, createdById: string | null, words = refusal.words): PendingRefusal {
  const { ask } = answer
  return {
    gate: ask.gate,
    subjectType: ask.subjectType,
    subjectId: ask.subjectId,
    companyId: ask.companyId,
    siteId: ask.siteId,
    styleId: ask.styleId,
    marketCode: refusal.line.target.market?.code ?? null,
    requirementId: refusal.line.requirement.id,
    requirementCode: refusal.line.requirement.code,
    words: words.slice(0, 2000),
    explanation: explanationOf(refusal.line),
    createdById,
    targetKey: refusal.line.target.key,
  }
}

/** The gate's refusal of a step (409 invalid_state, issues `gate/<CODE>`), carrying the refusals to write. */
export class GateRefusedError extends DomainError {
  override name = 'GateRefusedError'
  constructor(
    message: string,
    issues: readonly Issue[],
    readonly gateRefusals: readonly PendingRefusal[],
  ) {
    super('invalid_state', message, issues)
  }
}

/** The refusal of a decision as the step's error (the first missing requirement), or null when the gate lets it pass. */
export function refusalError(answer: GateAnswer, createdById: string | null): GateRefusedError | null {
  const refusal = answer.decision.refusal
  if (!refusal) return null
  return new GateRefusedError(refusal.words, refusalIssues(refusal), [pendingOf(answer, refusal, createdById)])
}

type Carrying = Error & { gateRefusals?: readonly PendingRefusal[] }

/** Lets one of W1's own refusals carry the gate's refusals (W1's words stay the answer; the GateEvent says the requirement's). */
export function attachRefusals<E extends Error>(error: E, refusals: readonly PendingRefusal[]): E {
  if (refusals.length > 0) (error as Carrying).gateRefusals = [...((error as Carrying).gateRefusals ?? []), ...refusals]
  return error
}

/** The caller in the tenant's system context (the refusal record writes what the floor role may not). */
function asSystem(caller: CommandCaller): CommandCaller {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) throw new DomainError('forbidden', 'You may not do this.')
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(context.tenantId, context.requestId)
  return view
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

/**
 * Writes refusals as GateEvents (REFUSED), one command in the tenant's system context: W1's certificate requirement row
 * first when a refusal names the built-in one; a requirement that no longer blocks the gate (switched off meanwhile) is
 * skipped; one event per requirement, subject and target; the audit row on the subject and `compliance_gates.refused`.
 * A step's Idempotency-Key makes a resent step write its refusals once. Never throws: a failure is logged.
 */
export async function recordRefusals(caller: CommandCaller, refusals: readonly PendingRefusal[], idempotencyKey?: string | null): Promise<void> {
  const unique = [...new Map(refusals.map((entry) => [`${entry.requirementCode}|${entry.gate}|${entry.subjectId}|${entry.targetKey}`, entry])).values()]
  if (unique.length === 0) return
  const context = caller.factoryContext
  const tenantId = context && 'tenantId' in context ? context.tenantId : null
  if (!tenantId) return
  const derived = idempotencyKey ? `gate:${idempotencyKey}`.slice(0, 128) : null
  try {
    await runCommand(
      asSystem(caller),
      { name: 'compliance.gates.recordRefusal', idempotencyKey: derived && KEY.test(derived) ? derived : null, input: unique },
      async (tools) => {
        const { tx, now } = tools
        let w1: string | null = null
        let written = 0
        for (const entry of unique) {
          let requirementId = entry.requirementId
          if (requirementId === null) {
            w1 ??= (await ensureW1Requirement(tx, tenantId, now)).id
            requirementId = w1
          }
          const requirement = await tx.complianceRequirement.findUnique({ where: { id: requirementId }, select: { id: true, code: true, status: true, switchedOn: true, blocks: true } })
          if (!requirement || requirement.status !== 'ACTIVE' || !requirement.switchedOn || !requirement.blocks.includes(entry.gate)) continue
          const id = newId()
          written += 1
          await tx.gateEvent.create({
            data: {
              id,
              companyId: entry.companyId,
              siteId: entry.siteId,
              gate: entry.gate,
              subjectType: entry.subjectType,
              subjectId: entry.subjectId,
              outcome: 'REFUSED',
              requirementId,
              styleId: entry.styleId,
              marketCode: entry.marketCode,
              reason: entry.words,
              explanation: entry.explanation as Prisma.InputJsonValue,
              createdAt: now,
              createdById: entry.createdById,
            },
            select: { id: true },
          })
          tools.audit({ recordType: entry.subjectType, recordId: entry.subjectId, companyId: entry.companyId, siteId: entry.siteId, after: { gate: entry.gate, outcome: 'REFUSED', requirement: requirement.code, gateEventId: id, target: entry.targetKey }, reason: entry.words })
          tools.emit({
            type: 'compliance_gates.refused',
            subject: entry.subjectId,
            companyId: entry.companyId,
            siteId: entry.siteId,
            payload: { gateEventId: id, gate: entry.gate, subjectType: entry.subjectType, subjectId: entry.subjectId, requirementId, requirementCode: requirement.code, styleId: entry.styleId, marketCode: entry.marketCode },
          })
        }
        // command() wants an audit row even when every refusal was skipped.
        if (written === 0) tools.audit({ recordType: unique[0]!.subjectType, recordId: unique[0]!.subjectId, companyId: unique[0]!.companyId, after: { gate: unique[0]!.gate, skipped: true } })
        return { written }
      },
      COMMAND_SETTINGS,
    )
  } catch (error) {
    ;(caller as { log?: { warn?: (object: unknown, message: string) => void } }).log?.warn?.({ err: error, refusals: unique.map((entry) => entry.requirementCode) }, 'compliance gate: a refusal could not be recorded')
  }
}

/**
 * Runs a gated step; the refusals its error carries (GateRefusedError, or W1's own error with refusals attached, or what
 * `failed(error)` names) are written after it rolled back, then the error goes on unchanged. `after(result)` names
 * refusals of a step that went through (a label print that printed the other sizes).
 */
export async function withGateRecords<T>(
  caller: CommandCaller,
  idempotencyKey: string | null | undefined,
  work: () => Promise<T>,
  after?: (result: T) => readonly PendingRefusal[],
  failed?: (error: unknown) => readonly PendingRefusal[],
): Promise<T> {
  let result: T
  try {
    result = await work()
  } catch (error) {
    const refusals = [...((error as Carrying | null)?.gateRefusals ?? []), ...(failed ? failed(error) : [])]
    if (refusals.length > 0) await recordRefusals(caller, refusals, idempotencyKey)
    throw error
  }
  const later = after ? after(result) : []
  if (later.length > 0) await recordRefusals(caller, later, idempotencyKey)
  return result
}

export type { RequirementRow }
