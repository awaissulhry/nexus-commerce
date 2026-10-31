import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { assignmentPlan, type AssignmentRow } from '@nexus/factory-domain/sales/pricelists/pricelists'
import type { CommandTools } from '../../../core/command'
import type { Reader } from '../quotes/store'
import { dayText, dayValue } from './store'

/**
 * A customer's price list with its "From" day (B-W2b-16; design pricelist.customers "Customer or group · From"; the
 * PartyPriceListAssignment rows of B-W2b-03): Party.priceListId says which list prices the customer now; its rows say
 * since when, and which lists it had before. The database has no tie between them, so EVERY write of Party.priceListId
 * calls `givePriceListInCommand` in the same command: the price list's Customers tab (lists.ts setCustomers) and the
 * customer's commercial terms (modules/parties commercial-terms.ts). The open row ends the day before the new one starts
 * (factory-domain `assignmentPlan`; only an end moves, nothing is deleted); a day holds one list (a second change on the
 * same day is refused in words, 409 at body/validFrom).
 *
 * A customer given its list before W2b has no row: the first change writes the row it was missing (from the day of the
 * latest audit row that gave it that list, else the day the customer was made) before ending it, and the Customers tab
 * reads that day from the audit until then (`assignmentStartsOf`, source AUDIT).
 */

const SET_LIST_ACTIONS = ['parties.setPriceList', 'parties.setCommercialTerms'] as const

const rowOf = (row: { id: string; priceListId: string; validFrom: Date; validTo: Date | null }): AssignmentRow => ({ id: row.id, priceListId: row.priceListId, validFrom: dayText(row.validFrom)!, validTo: dayText(row.validTo) })

/** The day the audit says a customer was given `listId` last (null: no such row). */
async function auditDayOf(db: Reader, partyId: string, listId: string): Promise<BusinessDate | null> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Party', recordId: partyId, action: { in: [...SET_LIST_ACTIONS] } }, select: { at: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 50 })
  const row = rows.find((entry) => ((entry.after ?? {}) as { listId?: unknown }).listId === listId)
  return row ? businessDate(row.at) : null
}

export interface AssignParty {
  readonly id: string
  readonly code: string
  /** Party.priceListId before this command changes it. */
  readonly priceListId: string | null
  readonly createdAt: Date
}

/**
 * Inside the command that sets Party.priceListId to `listId` (null: no list of its own): the customer's rows follow, from
 * `from` (default today). The caller updates the party itself. Refused in words (409) when the day already holds a change.
 */
export async function givePriceListInCommand(tools: CommandTools, party: AssignParty, listId: string | null, codes: (id: string) => string, from?: BusinessDate): Promise<{ endedId: string | null; startedId: string | null }> {
  const { tx, now } = tools
  const today = businessDate(now)
  const columns = { id: true, priceListId: true, validFrom: true, validTo: true } as const
  let rows = (await tx.partyPriceListAssignment.findMany({ where: { partyId: party.id }, select: columns, orderBy: { validFrom: 'asc' } })).map(rowOf)
  // A list given before W2b has no row: write it first (from its audit day, after the last row, at the latest today).
  if (party.priceListId !== null && !rows.some((row) => row.validTo === null)) {
    const lastEnd = rows.reduce<BusinessDate | null>((latest, row) => (row.validTo !== null && (latest === null || row.validTo > latest) ? row.validTo : latest), null)
    const known = (await auditDayOf(tx, party.id, party.priceListId)) ?? businessDate(party.createdAt)
    const start = [known, lastEnd === null ? known : addDays(lastEnd, 1)].sort().at(-1)!
    const backfill = { id: newId(), partyId: party.id, priceListId: party.priceListId, validFrom: dayValue(start > today ? today : start), validTo: null, createdAt: now, updatedAt: now, createdById: null }
    await tx.partyPriceListAssignment.create({ data: backfill, select: { id: true } })
    tools.audit({ action: 'priceLists.assignmentBackfilled', recordType: 'Party', recordId: party.id, after: { listId: party.priceListId, validFrom: dayText(backfill.validFrom) }, reason: 'The list was given before its history was kept: its row is written from the audit before it changes.' })
    rows = [...rows, rowOf(backfill)]
  }
  const plan = assignmentPlan(rows, listId, from ?? today, today, { party: party.code, listCode: codes })
  if (plan.kind === 'NOTHING') return { endedId: null, startedId: null }
  if (plan.kind === 'REFUSED') throw new DomainError(from !== undefined && from > today ? 'validation_failed' : 'conflict', plan.message, [{ path: `body/${plan.path}`, message: plan.message }])
  if (plan.end) await tx.partyPriceListAssignment.update({ where: { id: plan.end.id }, data: { validTo: dayValue(plan.end.validTo), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  const startedId = plan.start ? newId() : null
  if (plan.start && startedId) {
    await tx.partyPriceListAssignment.create({
      data: { id: startedId, partyId: party.id, priceListId: plan.start.priceListId, validFrom: dayValue(plan.start.validFrom), validTo: null, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
  }
  tools.audit({
    action: 'priceLists.assign',
    recordType: 'Party',
    recordId: party.id,
    before: { listId: party.priceListId, endedId: plan.end?.id ?? null },
    after: { listId, validFrom: plan.start?.validFrom ?? null, endedOn: plan.end?.validTo ?? null, assignmentId: startedId },
  })
  return { endedId: plan.end?.id ?? null, startedId }
}

/**
 * The day each customer got the list it has now (the Customers tab's "From"): its open row (ROW), else — given before
 * W2b — the day of the latest audit row that gave it that list (AUDIT), else unknown.
 */
export async function assignmentStartsOf(db: Reader, parties: readonly { readonly id: string; readonly priceListId: string | null }[]): Promise<Map<string, { from: BusinessDate | null; source: 'ROW' | 'AUDIT' | null }>> {
  const out = new Map<string, { from: BusinessDate | null; source: 'ROW' | 'AUDIT' | null }>()
  const ids = parties.map((party) => party.id)
  if (ids.length === 0) return out
  const open = await db.partyPriceListAssignment.findMany({ where: { partyId: { in: ids }, validTo: null }, select: { partyId: true, priceListId: true, validFrom: true } })
  const openOf = new Map(open.map((row) => [row.partyId, row]))
  for (const party of parties) {
    const row = openOf.get(party.id)
    if (row && row.priceListId === party.priceListId) out.set(party.id, { from: dayText(row.validFrom), source: 'ROW' })
    else if (party.priceListId !== null) {
      const day = await auditDayOf(db, party.id, party.priceListId)
      out.set(party.id, { from: day, source: day ? 'AUDIT' : null })
    }
  }
  return out
}
