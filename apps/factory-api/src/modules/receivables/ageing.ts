import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { AgeingQuery } from '@nexus/factory-domain/receivables/contracts'
import { AGEING_BUCKETS, addToAgeing, BUCKET_WORDS, daysBetween, emptyAgeing, firstOpenDueDate, mergeAgeing, type AgeingTotals } from '@nexus/factory-domain/receivables/ledger'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { CommandCaller } from '../../core/command'
import { mayOn, officeContextOf, openInvoices, receivablesClock, today } from './store'

/**
 * What customers owe (B-W2a-55; FIN-110; design finance.receivables "What customers owe": Open · Overdue · 0–30 · 31–60 ·
 * 61–90 · Over 90 days, each tile filters the table; "By customer": open, overdue, buckets, oldest due, last payment,
 * reminders sent, credit limit used (W2b)). GET /receivables/ageing (receivables.view; each row over its company AND its
 * customer, can()): the open TD01/TD24 invoices as of a day (store.ts openInvoices: the same sums as payments' open items),
 * each instalment aged by its due date (factory-domain receivables/ledger), summed per company, customer and currency.
 * Amounts by the price grain (dropped without it); the counts stay. Read only, nothing stored. Many customers: one
 * query for the open invoices, one per kind of fact for the page's customers.
 */

interface Group {
  readonly companyId: string
  readonly partyId: string
  readonly currency: string
  readonly totals: AgeingTotals
  invoices: number
  oldestDueDate: string | null
}

export async function ageing(caller: CommandCaller, query: AgeingQuery) {
  const context = officeContextOf(caller)
  const asOf = query.asOf ?? today()
  return caller.withClient(async (db) => {
    const rows = (await openInvoices(db, { companyId: query.companyId ?? null, partyId: query.partyId ?? null, asOf })).filter((row) => mayOn(context, RECEIVABLES_VIEW, row))
    const groups = new Map<string, Group>()
    for (const row of rows) {
      const key = `${row.companyId}|${row.partyId}|${row.currency}`
      const group = groups.get(key) ?? { companyId: row.companyId, partyId: row.partyId, currency: row.currency, totals: emptyAgeing(), invoices: 0, oldestDueDate: null }
      addToAgeing(group.totals, row.instalments, asOf)
      group.invoices++
      const due = firstOpenDueDate(row.instalments)
      if (due && (group.oldestDueDate === null || due < group.oldestDueDate)) group.oldestDueDate = due
      groups.set(key, group)
    }
    const partyIds = [...new Set([...groups.values()].map((group) => group.partyId))]
    const companyIds = [...new Set([...groups.values()].map((group) => group.companyId))]
    const parties = new Map((await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
    const companies = new Map((await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, code: true, legalName: true } })).map((company) => [company.id, company]))
    const needle = query.q?.toLowerCase() ?? null
    const matching = [...groups.values()].filter((group) => {
      if (!needle) return true
      const party = parties.get(group.partyId)
      return party ? party.code.toLowerCase().includes(needle) || party.legalName.toLowerCase().includes(needle) : false
    })

    // The tiles over every matching customer (the table's filter by tile does not change them).
    const tiles = new Map<string, { currency: string; customers: Set<string>; invoices: number; totals: AgeingTotals }>()
    for (const group of matching) {
      const tile = tiles.get(group.currency) ?? { currency: group.currency, customers: new Set<string>(), invoices: 0, totals: emptyAgeing() }
      tile.customers.add(`${group.companyId}|${group.partyId}`)
      tile.invoices += group.invoices
      mergeAgeing(tile.totals, group.totals)
      tiles.set(group.currency, tile)
    }

    const filtered = matching
      .filter((group) => (query.bucket === undefined ? true : query.bucket === 'OVERDUE' ? group.totals.overdue > 0 : group.totals.buckets[query.bucket] > 0))
      .sort((a, b) => b.totals.overdue - a.totals.overdue || b.totals.open - a.totals.open || (parties.get(a.partyId)?.legalName ?? '').localeCompare(parties.get(b.partyId)?.legalName ?? '') || a.partyId.localeCompare(b.partyId))
    const start = query.cursor ?? 0
    const page = filtered.slice(start, start + query.limit)

    const pagePartyIds = [...new Set(page.map((group) => group.partyId))]
    const pageCompanyIds = [...new Set(page.map((group) => group.companyId))]
    const payments = pagePartyIds.length === 0 ? [] : await db.payment.groupBy({ by: ['companyId', 'partyId'], where: { status: 'RECEIVED', partyId: { in: pagePartyIds }, companyId: { in: pageCompanyIds }, receivedOn: { lte: new Date(`${asOf}T00:00:00.000Z`) } }, _max: { receivedOn: true } })
    const reminders = pagePartyIds.length === 0 ? [] : await db.paymentReminder.groupBy({ by: ['companyId', 'partyId', 'status'], where: { partyId: { in: pagePartyIds }, companyId: { in: pageCompanyIds } }, _count: { _all: true }, _max: { sentAt: true } })
    const of = <T extends { companyId: string; partyId: string }>(list: readonly T[], group: Group) => list.filter((entry) => entry.companyId === group.companyId && entry.partyId === group.partyId)

    return {
      asOf,
      readAt: toUtcIso(receivablesClock().now()),
      tiles: [...tiles.values()]
        .sort((a, b) => a.currency.localeCompare(b.currency))
        .map((tile) => ({ currency: tile.currency, customers: tile.customers.size, invoices: tile.invoices, open: asMoney('price', tile.totals.open), overdue: asMoney('price', tile.totals.overdue), buckets: asMoney('price', { ...tile.totals.buckets }) })),
      customers: page.map((group) => {
        const party = parties.get(group.partyId)
        const company = companies.get(group.companyId)
        const lastPayment = of(payments, group)[0]?._max.receivedOn ?? null
        const own = of(reminders, group)
        const sent = own.find((entry) => entry.status === 'SENT')
        const lateDays = group.oldestDueDate ? daysBetween(group.oldestDueDate, asOf) : null
        return {
          company: { id: group.companyId, code: company?.code ?? '', name: company?.legalName ?? '' },
          customer: { id: group.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
          currency: group.currency,
          open: asMoney('price', group.totals.open),
          overdue: asMoney('price', group.totals.overdue),
          buckets: asMoney('price', { ...group.totals.buckets }),
          invoices: group.invoices,
          oldestDueDate: group.oldestDueDate,
          daysLate: lateDays !== null && lateDays > 0 ? lateDays : null,
          lastPaymentOn: lastPayment ? lastPayment.toISOString().slice(0, 10) : null,
          remindersSent: sent?._count._all ?? 0,
          lastReminderAt: sent?._max.sentAt ? toUtcIso(sent._max.sentAt) : null,
          remindersWaiting: own.filter((entry) => entry.status === 'PREPARED' || entry.status === 'APPROVED').reduce((sum, entry) => sum + entry._count._all, 0),
          creditLimitUsed: null,
        }
      }),
      count: filtered.length,
      next: start + query.limit < filtered.length ? start + query.limit : null,
      bucketWords: Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, BUCKET_WORDS[bucket]])) as Record<(typeof AGEING_BUCKETS)[number], { en: string; it: string }>,
    }
  })
}
