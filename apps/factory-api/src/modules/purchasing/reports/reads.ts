import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { figuresOf, groupsOf, monthsOf, shareOf, SPEND_CATEGORIES, SPEND_LIMITS, type SpendFigures, type SpendGroup } from '@nexus/factory-domain/purchasing/reports/rules'
import type { CommandCaller } from '../../../core/command'
import { headOf, placeOf } from './access'
import type { SpendLinesQuery, SpendQuery } from './contract'
import { spendLinesOf, type SpendRead } from './facts'

/**
 * The purchasing reports' answers (B-W2b-350): what facts.ts reads, folded by factory-domain purchasing/reports/rules. Amounts
 * are marked with the cost grain (the HTTP filter drops them for a caller without it); a share of spend is given only with the
 * cost grain, and the groups are ranked by amount only for a caller who may see amounts (else by orders).
 */

const cost = <T>(value: T) => asMoney('cost', value)

function figuresView(figures: SpendFigures) {
  return {
    byCurrency: figures.byCurrency.map((entry) => ({ currency: entry.currency, production: cost(entry.production), samples: cost(entry.samples) })),
    production: cost(figures.production),
    samples: cost(figures.samples),
    currency: figures.currency,
    mixedCurrencies: figures.mixedCurrencies,
    orders: figures.orders,
    lines: figures.lines,
    sampleOrders: figures.sampleOrders,
    sampleLines: figures.sampleLines,
  }
}

/** A group's code and name: a supplier's, a material's or a company's; a category or a month is its key (said in words on screen). */
function labelOf(by: SpendGroup, key: string, read: Pick<SpendRead, 'suppliers' | 'items' | 'companies'>): { code: string | null; name: string } {
  const named = by === 'supplier' ? read.suppliers.get(key) : by === 'material' ? read.items.get(key) : by === 'company' ? read.companies.get(key) : undefined
  return named ? { code: named.code, name: named.name } : { code: null, name: key }
}

/**
 * GET /purchasing/reports/spend (sec spend): the period's spend of the orders the caller reaches, by supplier, category,
 * material, company or month, sample orders apart; each group per month (the pivot), the largest first (at most 50).
 */
export async function spendAnswer(caller: CommandCaller, query: SpendQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const months = monthsOf(place.period)
    const read = await spendLinesOf(db, place)
    const byValue = place.sight.values
    const all = figuresOf(read.lines, place.companyCurrency)
    const groups = groupsOf(read.lines, query.by, months, { byValue, companyCurrency: place.companyCurrency })
    const shown = groups.slice(0, SPEND_LIMITS.groups)
    return {
      ...headOf(place),
      sight: place.sight,
      by: query.by,
      months,
      companyCurrency: place.companyCurrency,
      all: figuresView(all),
      groups: shown.map((group) => ({
        key: group.key,
        ...labelOf(query.by, group.key, read),
        share: byValue && !all.mixedCurrencies ? shareOf(group.figures.production, all.production) : null,
        ...figuresView(group.figures),
        months: group.months.map((month) => ({
          month: month.month,
          production: cost(month.figures.production),
          samples: cost(month.figures.samples),
          currency: month.figures.currency,
          orders: month.figures.orders,
          lines: month.figures.lines,
          sampleOrders: month.figures.sampleOrders,
          sampleLines: month.figures.sampleLines,
        })),
      })),
      more: Math.max(0, groups.length - shown.length),
      complete: read.complete,
    }
  })
}

/** The lines a group key names (400 in words for a key that cannot be one of the group's). */
function keyWhere(by: SpendGroup, key: string, months: readonly string[]): Prisma.PurchaseOrderLineWhereInput {
  const refuse = (message: string) => new ValidationError(message, [{ path: 'querystring/key', message }])
  switch (by) {
    case 'supplier':
      if (!isUuid(key)) throw refuse('Name a supplier by its id.')
      return { purchaseOrder: { partyId: key } }
    case 'material':
      if (!isUuid(key)) throw refuse('Name a material by its id.')
      return { itemId: key }
    case 'company':
      if (!isUuid(key)) throw refuse('Name a company by its id.')
      return { purchaseOrder: { companyId: key } }
    case 'category':
      if (!(SPEND_CATEGORIES as readonly string[]).includes(key)) throw refuse(`A category is one of ${SPEND_CATEGORIES.join(', ')}.`)
      return { item: { kind: key as (typeof SPEND_CATEGORIES)[number] } } as Prisma.PurchaseOrderLineWhereInput
    case 'month':
      if (!months.includes(key)) throw refuse(`A month of the period: ${months.join(', ')}.`)
      return {}
  }
}

/**
 * GET /purchasing/reports/spend/lines (pop drill "POs behind this bar"): the purchase order lines that make one group's number,
 * the newest placing first (at most 500), production and sample orders (or one kind), each with its spend.
 */
export async function spendLinesAnswer(caller: CommandCaller, query: SpendLinesQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const months = monthsOf(place.period)
    const read = await spendLinesOf(db, place, keyWhere(query.by, query.key, months), query.kind === 'all' ? undefined : query.kind)
    const lines = read.lines.filter((line) => line.keys[query.by] === query.key).sort((a, b) => b.placedOn.localeCompare(a.placedOn) || a.number.localeCompare(b.number) || a.seq - b.seq)
    const shown = lines.slice(0, SPEND_LIMITS.drillLines)
    return {
      ...headOf(place),
      sight: place.sight,
      by: query.by,
      key: query.key,
      ...labelOf(query.by, query.key, read),
      figures: figuresView(figuresOf(lines, place.companyCurrency)),
      lines: shown.map((line) => {
        const supplier = read.suppliers.get(line.partyId)
        const item = read.items.get(line.itemId)
        const colour = line.itemColourId ? read.colours.get(line.itemColourId) : undefined
        return {
          lineId: line.lineId,
          seq: line.seq,
          purchaseOrderId: line.purchaseOrderId,
          number: line.number,
          status: line.status,
          kind: line.kind,
          placedOn: line.placedOn,
          supplier: { id: line.partyId, code: supplier?.code ?? '', name: supplier?.name ?? '' },
          item: { id: line.itemId, code: item?.code ?? '', name: item?.name ?? '' },
          category: line.category,
          colour: colour ? { code: colour.code, name: colour.name } : null,
          quantity: line.quantity,
          uom: line.uom,
          ended: line.closedShort ? ('CLOSED_SHORT' as const) : null,
          spend: cost(line.spend),
          currency: line.currency,
        }
      }),
      more: Math.max(0, lines.length - shown.length),
    }
  })
}
