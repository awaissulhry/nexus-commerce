import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { entryKey, type LedgerPlan, type Wanted } from '@nexus/factory-domain/people/earnings/ledger'
import { monthAfter, monthOf } from '@nexus/factory-domain/people/earnings/rules'
import { monthPeriod } from '@nexus/factory-domain/people/overtime/timesheets'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { actorIdOf, dateOf } from '../employees/access'
import { payGuarded } from './access'
import { PERIOD_SELECT, periodOfMonth, type EntryRecord, type PeriodRecord } from './store'

/**
 * The ONE writer of the earnings ledger (B-W2b-43; MES-256; c.c. art. 2101): an entry is added, never edited; a wrong one is
 * reversed (the same worker, kind, scan, rate, day; the opposite pieces, minutes and amount) and a new one follows. An entry
 * goes in the period of its work day; once that month is LOCKED, in the next period not locked, naming the month it corrects.
 * The …_pay_w2b_guards triggers hold every line again: nothing piece-pay outside the site's window, nothing on a held scan.
 */

/** Where an entry of a work day goes. */
export interface Place {
  readonly period: PeriodRecord
  /** The LOCKED period of the work day, when the entry is paid in a later one. */
  readonly correctsPeriodId: string | null
}

/** The period of a month, made when missing (OPEN). */
async function periodFor(tools: CommandTools, companyId: string, month: string): Promise<PeriodRecord> {
  const found = await periodOfMonth(tools.tx, companyId, month)
  if (found) return found
  const bounds = monthPeriod(month)!
  const id = newId()
  // Two commands may make it together: the second keeps the first one's row.
  await tools.tx.payPeriod.createMany({ data: [{ id, companyId, periodStart: dateOf(bounds.periodStart), periodEnd: dateOf(bounds.periodEnd), createdById: actorIdOf(tools.context) }], skipDuplicates: true })
  const row = (await periodOfMonth(tools.tx, companyId, month))!
  if (row.id === id) {
    tools.audit({ action: 'people.createPayPeriod', recordType: 'PayPeriod', recordId: id, companyId, after: { month, status: 'OPEN' } })
    tools.emit({ type: 'pay_period.changed', subject: id, companyId, siteId: null, payload: { periodId: id, companyId, month, status: 'OPEN', change: 'CREATED' } })
  }
  return row
}

export async function placeOf(tools: CommandTools, companyId: string, day: BusinessDate): Promise<Place> {
  const own = await periodFor(tools, companyId, monthOf(day))
  if (own.status !== 'LOCKED') return { period: own, correctsPeriodId: null }
  const later = await tools.tx.payPeriod.findFirst({ where: { companyId, status: { not: 'LOCKED' }, periodStart: { gt: own.periodStart } }, orderBy: { periodStart: 'asc' }, select: PERIOD_SELECT })
  if (later) return { period: later, correctsPeriodId: own.id }
  const latest = (await tools.tx.payPeriod.findFirst({ where: { companyId }, orderBy: { periodStart: 'desc' }, select: { periodStart: true } }))!
  return { period: await periodFor(tools, companyId, monthAfter(latest.periodStart.toISOString().slice(0, 7))), correctsPeriodId: own.id }
}

/** One line for the ledger: what it pays (Wanted) and what it rests on. */
export interface EntryDraft extends Wanted {
  readonly kind: 'SCAN' | 'TEAM_SPLIT' | 'MAKE_UP' | 'OFF_STANDARD' | 'ADJUSTMENT' | 'BONUS'
  readonly siteId: string
  readonly employeeId: string
  readonly workerId: string
  readonly workDate: BusinessDate
  readonly currency: string
  readonly operationScanId?: string | null
  readonly rateEntryId?: string | null
  readonly sharePct?: string | null
  readonly heldScanId?: string | null
  readonly sourceType?: string | null
  readonly sourceId?: string | null
  readonly reason?: string | null
}

/** Adds one entry under its key, in the period of its work day. */
export async function addEntry(tools: CommandTools, companyId: string, draft: EntryDraft, idempotencyKey: string): Promise<string> {
  const place = await placeOf(tools, companyId, draft.workDate)
  const id = newId()
  await payGuarded(() =>
    tools.tx.earningsEntry.create({
      data: {
        id,
        companyId,
        siteId: draft.siteId,
        payPeriodId: place.period.id,
        employeeId: draft.employeeId,
        workerId: draft.workerId,
        workDate: dateOf(draft.workDate),
        kind: draft.kind,
        operationScanId: draft.operationScanId ?? null,
        rateEntryId: draft.rateEntryId ?? null,
        pieces: draft.pieces,
        minutes: draft.minutes,
        rate: draft.rate,
        sharePct: draft.sharePct ?? null,
        amount: draft.amount,
        currency: draft.currency,
        heldScanId: draft.heldScanId ?? null,
        sourceType: draft.sourceType ?? null,
        sourceId: draft.sourceId ?? null,
        correctsPeriodId: place.correctsPeriodId,
        reason: draft.reason ?? null,
        idempotencyKey,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    }),
  )
  return id
}

const opposite = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).negated().toFixed())

/** The mirror of an entry, with why. `key`: the system's reversal or a person's (entryKey.reverse, entryKey.correct). */
export async function reverseEntry(tools: CommandTools, original: EntryRecord, reason: string, key: string = entryKey.reverse(original.id)): Promise<string> {
  const day = original.workDate.toISOString().slice(0, 10)
  const place = await placeOf(tools, original.companyId, day)
  const id = newId()
  await payGuarded(() =>
    tools.tx.earningsEntry.create({
      data: {
        id,
        companyId: original.companyId,
        siteId: original.siteId,
        payPeriodId: place.period.id,
        employeeId: original.employeeId,
        workerId: original.workerId,
        workDate: original.workDate,
        kind: original.kind,
        operationScanId: original.operationScanId,
        rateEntryId: original.rateEntryId,
        pieces: original.pieces === null ? null : 0 - original.pieces,
        minutes: opposite(original.minutes),
        rate: original.rate,
        sharePct: original.sharePct,
        amount: 0 - original.amount,
        currency: original.currency,
        heldScanId: original.heldScanId,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        correctsPeriodId: place.correctsPeriodId,
        reversalOfId: original.id,
        reason,
        idempotencyKey: key,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    }),
  )
  return id
}

/** A plan into the ledger: the reversals first, then the new entries. How many of each. */
export async function applyPlan(tools: CommandTools, companyId: string, plan: LedgerPlan<EntryDraft>, rows: readonly EntryRecord[], reason: string): Promise<{ readonly added: number; readonly reversed: number }> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const row of plan.reverse) await reverseEntry(tools, byId.get(row.id)!, reason)
  for (const item of plan.add) await addEntry(tools, companyId, item, item.entryKey)
  return { added: plan.add.length, reversed: plan.reverse.length }
}
