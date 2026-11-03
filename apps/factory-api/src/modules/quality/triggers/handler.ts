import { createHash } from 'node:crypto'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import type { Frequency } from '@nexus/factory-domain/quality/plans/rules'
import { decide, SCAN_KINDS, selects, type RecordKind, type TriggerEvent } from '@nexus/factory-domain/quality/triggers/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { bundleSubject, lotSubjects, workshopSubject, type Subject } from './facts'
import { openIncoming, openInProcess, type Opening, type Outcome } from './open'
import { plansOf, ruleFactsOf, TRIGGER_COLUMNS, type Db } from './store'

/**
 * Inspections opened by rule (B-W2b-101; QHS-010, QHS-011; "Nobody remembers to open an inspection by hand on a busy
 * day"): the worker's handler `quality.inspectionTriggers`, listed in background.ts (W2B_101_HANDLERS). It follows
 *
 *   inventory.receipt_posted     GOODS_RECEIPT: each lot of the receipt (office or floor receiving)
 *   subcontract_order.received   GOODS_RECEIPT: the pieces a workshop sent back
 *   production.scan_recorded     a REPORT: OPERATION_FINISHED (the bundle's first report at the operation) and BUNDLE_SCAN
 *                                (when it is the bundle's first scan there: a one-tap report)
 *   production.operation_timed   a START: BUNDLE_SCAN (the bundle's first scan at the operation)
 *
 * Read first, as the tenant's system caller (the floor has no grant on the rules): a company with no active rule for the
 * event costs one read and writes nothing. Then, per subject, the company's rules of the event in their order decide for
 * each kind of record (factory-domain quality/triggers `decide`), the frequency picks or not (`selects`), and ONE system
 * command per subject opens what was picked (./open.ts: never a second OPEN one; a reason on the rule's trail when
 * nothing opens), keyed by the event and the subject: a repeated job answers from its receipt. The event's own command
 * is not slowed or failed by a rule: the record opens a moment after the receipt or the scan (a first piece is opened
 * only while its bundle is the only one at the operation, so the hold never stops work in hand).
 */

const EVENTS = ['inventory.receipt_posted', 'subcontract_order.received', 'production.scan_recorded', 'production.operation_timed'] as const

/** The trigger events an outbox event stands for. */
export function triggerEventsOf(event: Pick<EventEnvelope, 'type' | 'payload'>): TriggerEvent[] {
  const kind = (event.payload as { kind?: unknown } | null)?.kind
  switch (event.type) {
    case 'inventory.receipt_posted':
    case 'subcontract_order.received':
      return ['GOODS_RECEIPT']
    case 'production.scan_recorded':
      return kind === 'REPORT' ? ['OPERATION_FINISHED', 'BUNDLE_SCAN'] : []
    case 'production.operation_timed':
      return kind === 'START' ? ['BUNDLE_SCAN'] : []
    default:
      return []
  }
}

interface Work {
  readonly subject: Subject
  readonly openings: (Opening & { readonly frequency: Frequency })[]
}

/** What the company's rules open for this event, read as the caller (no write). */
export async function plannedOpenings(db: Db, event: Pick<EventEnvelope, 'type' | 'payload' | 'companyId'>): Promise<Work[]> {
  const triggerEvents = triggerEventsOf(event)
  if (!event.companyId || triggerEvents.length === 0) return []
  const rows = await db.inspectionTrigger.findMany({ where: { companyId: event.companyId, active: true, event: { in: triggerEvents } }, select: TRIGGER_COLUMNS })
  if (rows.length === 0) return []
  const plans = await plansOf(db, rows.map((row) => row.planId))
  const payload = event.payload as { lotIds?: string[]; receiptId?: string; scanId?: string }
  const work = new Map<string, Work>()
  for (const triggerEvent of new Set(rows.map((row) => row.event as TriggerEvent))) {
    const rules = rows.filter((row) => row.event === triggerEvent).flatMap((row) => ruleFactsOf(row, plans.get(row.planId)) ?? [])
    if (rules.length === 0) continue
    let subjects: Subject[] = []
    if (triggerEvent === 'GOODS_RECEIPT') {
      if (event.type === 'inventory.receipt_posted') subjects = await lotSubjects(db, payload.lotIds ?? [])
      else if (payload.receiptId) subjects = [await workshopSubject(db, payload.receiptId)].flatMap((subject) => subject ?? [])
    } else if (payload.scanId) {
      subjects = [await bundleSubject(db, payload.scanId, SCAN_KINDS[triggerEvent] ?? [])].flatMap((subject) => subject ?? [])
    }
    // Only the company's own subjects (an event names its company; a lot of another company is never judged by these rules).
    for (const subject of subjects.filter((entry) => entry.companyId === event.companyId)) {
      const occurrence = subject.type === 'BUNDLE' ? subject.occurrence : { ordinal: 1, sampleKey: subject.key }
      for (const [kind, decision] of decide(rules, subject.facts)) {
        const row = decision.rule.row
        // An incoming inspection is of a lot or a workshop's receipt; an in-process check of a bundle (the stage matrix).
        if ((kind === 'INCOMING') !== (subject.type !== 'BUNDLE')) continue
        if (!selects({ id: row.id, frequency: row.frequency as Frequency, frequencyValue: row.frequencyValue }, occurrence)) continue
        const entry = work.get(subject.key) ?? { subject, openings: [] }
        // Two events of one scan (finished and scanned) may pick the same kind: the first rule in order keeps it.
        if (!entry.openings.some((opening) => opening.kind === kind)) entry.openings.push({ rule: row, plan: decision.rule.plan, kind: kind as RecordKind, because: decision.because, frequency: row.frequency as Frequency })
        work.set(subject.key, entry)
      }
    }
  }
  return [...work.values()]
}

const keyOf = (eventId: string, subjectKey: string): string => `rule-open.${createHash('sha256').update(`${eventId}|${subjectKey}`).digest('hex').slice(0, 56)}`

/** Opens what the rules pick for one event: one system command per subject. Answers what each opening came to. */
export async function applyTriggers(caller: CommandCaller, event: EventEnvelope): Promise<Outcome[]> {
  const work = await caller.withClient((client) => plannedOpenings(client as unknown as Db, event))
  const outcomes: Outcome[] = []
  for (const item of work) {
    const { result } = await runCommand(
      caller,
      {
        name: 'quality.openInspectionsByRule',
        idempotencyKey: keyOf(event.eventId, item.subject.key),
        input: { eventId: event.eventId, subject: item.subject.key, rules: item.openings.map((opening) => ({ triggerId: opening.rule.id, kind: opening.kind })) },
        causationId: event.eventId,
      },
      async (tools) => {
        const done: Outcome[] = []
        for (const opening of item.openings) {
          if (opening.kind === 'INCOMING') {
            if (item.subject.type !== 'BUNDLE') done.push(await openIncoming(tools, opening, item.subject))
          } else if (item.subject.type === 'BUNDLE') {
            done.push(await openInProcess(tools, { ...opening, kind: opening.kind as Exclude<RecordKind, 'INCOMING'> }, item.subject, opening.frequency))
          }
        }
        return done
      },
      COMMAND_SETTINGS,
    )
    outcomes.push(...result)
  }
  return outcomes
}

export function inspectionTriggerHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'quality.inspectionTriggers',
      events: [...EVENTS],
      async handle(event, { caller }) {
        await applyTriggers(caller, event)
      },
    }),
  ]
}
