import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { frozenSurcharges, netOfBasis, picksProblems, surchargeTotal, type LinePick } from '@nexus/factory-domain/sales/configurator/rules'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { Dec, HUNDRED, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { PriceBasis } from '@nexus/factory-domain/tax/vat-summary'
import type { CommandTools } from '../../../../core/command'
import { checkStyleOptions } from '../../../product/options/check'
import { picksTakesProblems } from '../../../product/options/takes'
import { extrasProblems, rowsToWrite } from '../../configurator/line'
import { valuePrices } from '../../configurator/style'
import type { LineDraft } from '../pricing'
import type { Reader } from '../store'

/**
 * Options on an order line the office types (B-W2b-374; XF3:02; B-W2b-340's gap): a line of a manual order ("New order",
 * orders/manual.ts) and a NEW line of an amendment (orders/amend.ts) take the options chosen when they are made, as the
 * order line's configurator would keep them —
 *
 *   checked      B-W2b-229's check of the style's rules (a refused combination in the rule's words), each colour or material
 *                active and of the line's company, and of the kind its group takes (B-W2b-363's OptionGroup.takes)
 *   priced       each value's surcharge frozen at today's prices (an amount of the order's currency, a percent of the line's
 *                price as typed or listed, net), and ADDED to the line's unit price and to each size's own price, as a quote's
 *                waterfall adds its OPTION steps after the start (a VAT-included order adds them with the line's VAT)
 *   written      SalesOrderLineOption rows of the new line, in the same command (the database takes them while the order is
 *                CONFIRMED, IN_PRODUCTION or READY: a typed order that would wait for a yes is refused in words while it has
 *                options — `assertMayTakeOptions`; it is made without them and they are chosen on its lines after the yes)
 *
 * The problems are said with the order's other problems (a 400 with every one, the preview's `problems`); nothing is written
 * before "Confirm order" or Apply.
 */

/** What a typed line's options will be written as, and what they add a piece (net). */
export interface EntryOptions {
  readonly rows: ReturnType<typeof rowsToWrite>
  /** What the options add a piece, net (on the order's currency). */
  readonly addsNet: string
}

const six = (value: Decimal): string => priceText(value.toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed())

/**
 * A typed line's options planned (no write): the problems at `at`, or the rows to write and the draft with the options in its
 * price. A line without picks comes back as it was.
 */
export async function planEntryOptions(
  db: Reader,
  ctx: { readonly companyId: string; readonly currency: string; readonly basis: PriceBasis; readonly vatRatePct: string | null },
  draft: LineDraft,
  picks: readonly LinePick[] | undefined,
  at: string,
): Promise<{ readonly draft: LineDraft; readonly options: EntryOptions | null } | Issue[]> {
  if (!picks || picks.length === 0) return { draft, options: null }
  const issues: Issue[] = picksProblems(picks).map((issue) => ({ path: issue.path.replace(/^body\/picks/, at), message: issue.message }))
  if (draft.kind !== 'SIZE_GRID') issues.push({ path: at, message: 'A made-to-measure unit takes its options on its line afterwards.' })
  if (issues.length > 0) return issues
  const check = await checkStyleOptions(db, draft.styleId, picks, { useDefaults: true })
  if (!check.check.ok) return check.check.blocks.map((finding) => ({ path: `${at}/${finding.path}`, message: finding.message.en }))
  issues.push(...(await extrasProblems(db, ctx.companyId, picks, at)), ...(await picksTakesProblems(db, picks, at)))
  if (issues.length > 0) return issues
  const base = netOfBasis(draft.unitPrice, ctx.basis, ctx.vatRatePct)
  const frozen = frozenSurcharges(check.check.chosen.map((entry) => entry.valueId), await valuePrices(db, check.check.chosen.map((entry) => entry.valueId)), base, ctx.currency)
  if (!frozen.ok) return [{ path: at, message: frozen.message.en }]
  const rows = rowsToWrite(check.check.chosen, picks, frozen.rows)
  const addsNet = surchargeTotal(rows.map((row) => ({ amount: row.surchargeAmount })))
  // On the order's basis: a VAT-included order adds the options with the line's VAT.
  const adds = ctx.basis === 'GROSS' && ctx.vatRatePct !== null ? new Dec(addsNet).times(HUNDRED.plus(ctx.vatRatePct)).dividedBy(HUNDRED) : new Dec(addsNet)
  const plus = (price: string) => {
    const next = new Dec(price).plus(adds)
    return six(next.lt(0) ? new Dec(0) : next)
  }
  return {
    draft: { ...draft, unitPrice: plus(draft.unitPrice), sizes: draft.sizes.map((size) => (size.unitPrice === null ? size : { ...size, unitPrice: plus(size.unitPrice) })) },
    options: { rows, addsNet },
  }
}

/** A typed order with options is made only CONFIRMED (the database's states for options): else refused in words (409). */
export function assertMayTakeOptions(status: string, withOptions: number): void {
  if (withOptions === 0 || status === 'CONFIRMED') return
  const words = `This order would wait for a yes (${status === 'PENDING_APPROVAL' ? 'a credit or approval rule holds it' : status}) and an order takes options only once it is confirmed: make it without the options, then choose them on its lines after the yes.`
  throw new DomainError('conflict', words, [{ path: 'body/lines', message: words }])
}

/** The planned options written on the lines made (lineId → its options), in the command that made them. */
export async function writeEntryOptions(tools: CommandTools, partyId: string, written: readonly { readonly lineId: string; readonly options: EntryOptions }[]): Promise<string[]> {
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const lineIds: string[] = []
  for (const entry of written) {
    if (entry.options.rows.length === 0) continue
    await tools.tx.salesOrderLineOption.createMany({ data: entry.options.rows.map((row) => ({ id: newId(), lineId: entry.lineId, partyId, ...row, createdById: actorId })) })
    lineIds.push(entry.lineId)
  }
  return lineIds
}

/** The audit of the options written (values, texts, picks; the surcharges in the price grain). */
export const entryOptionsAudit = (written: readonly { readonly lineId: string; readonly options: EntryOptions }[]) =>
  written.map((entry) => ({
    lineId: entry.lineId,
    options: entry.options.rows.map((row) => ({ valueId: row.valueId, freeText: row.freeText, colourId: row.colourId, itemId: row.itemId, itemColourId: row.itemColourId, surcharge: markMoney('price', { amount: row.surchargeAmount, pct: row.surchargePct }) })),
    adds: markMoney('price', entry.options.addsNet),
  }))
