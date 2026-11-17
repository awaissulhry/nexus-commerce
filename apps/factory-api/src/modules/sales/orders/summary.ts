import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { INVOICED_STATES, type InvoicedState } from '@nexus/factory-domain/sales/orders/invoiced'
import { atRiskOf, openUnitsOf, riskDaysFor } from '@nexus/factory-domain/sales/orders/later-columns'
import { daysLate, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from './access'
import { limitedToSomeCustomers } from './customers'
import { viewWhere, type ListFilters } from './orders'
import { dayOrNull } from './store'
import { invoicedByOrder, piecesOf, riskRulesOf, type OrderPieces, type RiskRule } from './view-facts'

/**
 * The overall view's honest totals (B-TH-058; threads plan TH-4; SHEET-G08; features SHEET.overall-F02 group by customer,
 * -F03 totals per customer and grand total, -F08 the invoicing rhythm, -F11 totals open their rows; wall W30 / T30):
 *
 *   GET /sales/orders/summary   the list's own terms (status, open, late, deposit, reaccept, company, customer, promise range,
 *                               search, brand, `cf`, invoiced, atRisk, customerUrgency, currency) + `group=party`
 *
 * The figures are the server's, for every order the terms keep that the reader's orders.view reaches (./orders viewWhere: the
 * list's one filter), never only the rows the screen has loaded: orders; pieces ordered, shipped and still owed; late; at
 * risk; Invoiced None / Part / All; the net per currency (price grain only: the field is absent without it, and amounts of
 * two currencies are never added). With group=party the same figures per customer, by name, with its invoicing rhythm.
 *
 * Every figure is a door: its `filter` is the list's terms (GET /sales/orders, the same names) that read exactly the rows it
 * counts — the view's terms, plus the customer for a group, plus the figure's own term (`late=true`, `open=true`, `atRisk=true`,
 * `invoiced=PART`, `currency=EUR`). Pieces sum over those rows (`units`, `shippedUnits`, `openUnits`). A figure whose term the
 * view already pins to another value counts nothing and opens nothing (filter null).
 *
 * The wall (T30): the figures come from the orders the reader may see only, so a person limited to customer A reads A's
 * figures and A's group, and nothing — no name, id or count — of another customer; `limited` says the figures are of "Your
 * customers".
 */

export interface SummaryQuery extends ListFilters {
  readonly group?: 'party' | undefined
}

type Terms = Readonly<Record<string, string>>

/** The list's row terms, as the address names them (the door filters are made of these). */
const VIEW_KEYS = ['status', 'open', 'late', 'deposit', 'reaccept', 'companyId', 'partyId', 'promiseFrom', 'promiseTo', 'q', 'brand', 'cf', 'invoiced', 'atRisk', 'customerUrgency', 'currency', 'shippedNotInvoiced' /* B-TH-244 */] as const
/** Flags whose `false` narrows nothing (a door's `true` takes its place). */
const FLAGS: ReadonlySet<string> = new Set(['open', 'late', 'reaccept', 'atRisk', 'shippedNotInvoiced' /* B-TH-244 */])

function termsOf(query: SummaryQuery): Terms {
  const out: Record<string, string> = {}
  for (const key of VIEW_KEYS) {
    const value = query[key]
    if (value !== undefined && value !== '') out[key] = String(value)
  }
  return out
}

/** The view's terms with a figure's own; null when the view pins one of them to another value (the figure counts nothing). */
function doorOf(view: Terms, extra: Terms): Terms | null {
  const out: Record<string, string> = { ...view }
  for (const [key, value] of Object.entries(extra)) {
    const pinned = view[key]
    if (pinned !== undefined && pinned !== value && !(FLAGS.has(key) && pinned === 'false')) return null
    out[key] = value
  }
  return out
}

interface ViewRow {
  readonly id: string
  readonly partyId: string
  readonly companyId: string
  readonly status: SalesOrderStatus
  readonly promiseDate: BusinessDate | null
  readonly currency: string
  readonly netAmount: number
}

interface Facts {
  readonly pieces: ReadonlyMap<string, OrderPieces>
  readonly invoiced: ReadonlyMap<string, { readonly state: InvoicedState }>
  readonly rules: readonly RiskRule[]
  readonly today: BusinessDate
  readonly withPrice: boolean
}

const NO_PIECES: OrderPieces = { ordered: 0, closedShort: 0, shipped: 0 }
const sumOf = <T>(rows: readonly T[], value: (row: T) => number): number => rows.reduce((total, row) => total + value(row), 0)
const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true })

/** The figures of some orders of the view (all of it, or one customer's), each with the filter that opens its rows. */
function figuresOf(rows: readonly ViewRow[], terms: Terms, facts: Facts) {
  const door = (count: number, extra: Terms = {}) => {
    const filter = doorOf(terms, extra)
    return { count: filter ? count : 0, filter }
  }
  const piecesOfRow = (row: ViewRow) => facts.pieces.get(row.id) ?? NO_PIECES
  const stateOf = (row: ViewRow): InvoicedState => facts.invoiced.get(row.id)?.state ?? 'NONE'
  const currencies = [...new Set(rows.map((row) => row.currency))].sort()
  return {
    orders: door(rows.length),
    pieces: {
      ordered: door(sumOf(rows, (row) => piecesOfRow(row).ordered)),
      shipped: door(sumOf(rows, (row) => piecesOfRow(row).shipped)),
      open: door(
        sumOf(rows, (row) => {
          const pieces = piecesOfRow(row)
          return openUnitsOf(row.status, pieces.ordered, pieces.closedShort, pieces.shipped)
        }),
        { open: 'true' },
      ),
    },
    late: door(rows.filter((row) => (daysLate(row.status, row.promiseDate, facts.today) ?? 0) > 0).length, { late: 'true' }),
    atRisk: door(rows.filter((row) => atRiskOf(row.status, row.promiseDate, facts.today, riskDaysFor(facts.rules, row.companyId)) !== null).length, { atRisk: 'true' }),
    invoiced: Object.fromEntries(INVOICED_STATES.map((state) => [state, door(rows.filter((row) => stateOf(row) === state).length, { invoiced: state })])) as Record<InvoicedState, { count: number; filter: Terms | null }>,
    net: asMoney(
      'price',
      facts.withPrice
        ? currencies.map((currency) => {
            const filter = doorOf(terms, { currency })
            return { currency, amount: asMoney('price', filter ? sumOf(rows.filter((row) => row.currency === currency), (row) => row.netAmount) : 0), filter }
          })
        : [],
    ),
  }
}

export async function orderSummary(caller: CommandCaller, query: SummaryQuery) {
  const context = officeContextOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const where = await viewWhere(client, context, query, today)
    const found = await client.salesOrder.findMany({ where, select: { id: true, partyId: true, companyId: true, status: true, promiseDate: true, currency: true, netAmount: true } })
    const rows: ViewRow[] = found.map((row) => ({ id: row.id, partyId: row.partyId, companyId: row.companyId, status: row.status, promiseDate: dayOrNull(row.promiseDate), currency: row.currency, netAmount: row.netAmount }))
    const facts: Facts = {
      pieces: await piecesOf(client, where),
      invoiced: await invoicedByOrder(client, where),
      rules: await riskRulesOf(client),
      today,
      withPrice: heldGrains(actorOf(context)).has('price'),
    }
    const terms = termsOf(query)
    let groups = null
    if (query.group === 'party') {
      const partyIds = [...new Set(rows.map((row) => row.partyId))]
      const parties = partyIds.length > 0 ? await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, invoiceTiming: true } }) : []
      groups = parties
        .sort((a, b) => collator.compare(a.legalName, b.legalName) || (a.id < b.id ? -1 : 1))
        .map((party) => ({
          partyId: party.id,
          code: party.code,
          name: party.legalName,
          invoiceTiming: party.invoiceTiming,
          figures: figuresOf(
            rows.filter((row) => row.partyId === party.id),
            { ...terms, partyId: party.id },
            facts,
          ),
        }))
    }
    return { all: figuresOf(rows, terms, facts), groups, limited: limitedToSomeCustomers(context), asOf: toUtcIso(serverClock.now()) }
  })
}
