import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import { developmentStyleRefusal, sampleLineDescription, sampleLineRefusal, sampleRoundRefusal, type SampleLineKind } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import type { SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import { command, type CommandCaller } from '../../../core/command'
import { insertLine, linesChanged } from '../lines'
import { assertBuyable, insertDraft } from '../orders'
import { assertMay, ITEM_COLUMNS, officeContextOf, PARTY_COLUMNS, readOrder, SITE_COLUMNS, type ItemRow } from '../store'
import { sampleRowOf } from './list'
import { refuseSample } from './store'

/**
 * POST /purchasing/sample-orders (purchasing.manage over the company, delivery site and supplier; design pop "New sample order",
 * "Create draft"): ONE command makes a DRAFT purchase order of kind SAMPLE — W1's own draft (the company's PURCHASE_ORDER series,
 * the supplier's currency, terms and orders contact; purchase_order.created) — for a style in development (of the company or
 * tenant-wide, not archived or discontinued) and, when named, one of its open sample rounds of the company; and its lines, each
 * W1's own line (the approved source's or the material's unit, price and codes; purchase_order.lines_changed) with what it buys
 * first in its description, in the supplier's language ("Pelle campione", "Swatch", "Cartella colori"). A sample hide is
 * leather; a sample order buys materials only. From then on it is an ordinary order: the record edits, sends and cancels it.
 * A database refusal that a race lets through is a 409 in words, never a 500.
 */

export interface CreateSampleOrderLine {
  readonly what: SampleLineKind
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
  readonly quantity: string
  readonly uom?: Uom | undefined
  readonly needDate: string
  readonly description?: string | null | undefined
}

export interface CreateSampleOrderInput {
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly developmentStyleId: string
  readonly sampleRoundId?: string | null | undefined
  readonly requestedDate?: string | null | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly CreateSampleOrderLine[]
}

const invalid = (path: string, message: string): never => {
  throw new ValidationError(message, [{ path, message }])
}

/** A W1 line refusal (`body/quantity`) said at the dialog's line (`body/lines/2/quantity`). */
function atLine(error: unknown, index: number): unknown {
  if (!(error instanceof ValidationError)) return error
  const issues: Issue[] = (error.issues ?? []).map((issue) => ({ path: issue.path.replace(/^body\//, `body/lines/${index}/`), message: issue.message }))
  return new ValidationError(error.message, issues)
}

/** The last net: a supply guard's own refusal (check_violation 'supply: …') that a race let past these checks, as a 409 in its words. */
function databaseRefusal(error: unknown): unknown {
  const original = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string' && original.originalMessage.startsWith('supply: ')) {
    const words = original.originalMessage.slice('supply: '.length)
    return new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  return error
}

export async function createSampleOrder(caller: CommandCaller, body: CreateSampleOrderInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertMay(context, PURCHASING_MANAGE, { companyId: body.companyId, siteId: body.siteId, partyId: body.partyId }, 'Supplier')
  try {
    const { result } = await command(caller, { name: 'purchasing.sampleOrders.create', idempotencyKey, input: body }, async (tools) => {
      const { tx, now } = tools
      const today = businessDate(now)
      const site = await tx.site.findUnique({ where: { id: body.siteId }, select: SITE_COLUMNS })
      if (!site || site.companyId !== body.companyId) throw new NotFoundError('Site not found.')
      if (site.status !== 'ACTIVE') throw new InvalidStateError('The site is archived: nothing is delivered there.')
      const party = await tx.party.findUnique({ where: { id: body.partyId }, select: PARTY_COLUMNS })
      if (!party || (party.companyId !== null && party.companyId !== body.companyId)) throw new NotFoundError('Supplier not found.')
      assertBuyable(party)

      // The development project: a style the company may develop, and one of its open rounds of the company.
      const style = await tx.style.findUnique({ where: { id: body.developmentStyleId }, select: { id: true, companyId: true, code: true, name: true, status: true, lifecycle: true } })
      if (!style || (style.companyId !== null && style.companyId !== body.companyId)) invalid('body/developmentStyleId', 'Style not found: choose a style of this company.')
      refuseSample(developmentStyleRefusal(style!), 'body/developmentStyleId')
      let round: { id: string; number: string } | null = null
      if (body.sampleRoundId) {
        const found = isUuid(body.sampleRoundId) ? await tx.sampleRound.findUnique({ where: { id: body.sampleRoundId }, select: { id: true, companyId: true, styleId: true, number: true, stage: true } }) : null
        if (!found || found.companyId !== body.companyId) invalid('body/sampleRoundId', 'Sample round not found: choose a round of this company.')
        refuseSample(sampleRoundRefusal({ number: found!.number, styleId: found!.styleId, stage: found!.stage as SampleStage }, style!.id), 'body/sampleRoundId')
        round = { id: found!.id, number: found!.number }
      }
      if (body.requestedDate && body.requestedDate < today) invalid('body/requestedDate', 'The delivery date asked for is today or later.')

      // Every line's material first, so a refusal names its line before anything is written.
      const items: ItemRow[] = []
      for (const [index, line] of body.lines.entries()) {
        const item = await tx.item.findUnique({ where: { id: line.itemId }, select: ITEM_COLUMNS })
        if (!item || (item.companyId !== null && item.companyId !== body.companyId)) invalid(`body/lines/${index}/itemId`, 'Material not found: choose a material of this company.')
        refuseSample(sampleLineRefusal(line.what, item!), `body/lines/${index}/itemId`)
        if (line.needDate < today) invalid(`body/lines/${index}/needDate`, 'The day it is needed is today or later.')
        items.push(item!)
      }

      const draft = await insertDraft(tools, { companyId: body.companyId, siteId: site.id, party, header: { requestedDate: body.requestedDate ?? null, note: body.note ?? null }, source: 'OFFICE' })
      await tx.purchaseOrder.update({ where: { id: draft.id }, data: { kind: 'SAMPLE', developmentStyleId: style!.id, sampleRoundId: round?.id ?? null }, select: { id: true } })
      const order = (await readOrder(tx, draft.id))!
      const contact = order.contactId ? await tx.partyContact.findUnique({ where: { id: order.contactId }, select: { language: true } }) : null
      const language = supplierLanguageOf(contact?.language, party.language)
      const lineIds: string[] = []
      for (const [index, line] of body.lines.entries()) {
        try {
          const made = await insertLine(tools, order, items[index]!, {
            itemColourId: line.itemColourId ?? null,
            quantity: line.quantity,
            ...(line.uom ? { uom: line.uom } : {}),
            needDate: line.needDate,
            // A swatch or a colour card of a leather is no lot of hides: no "one dye batch" asked of it.
            ...(line.what !== 'HIDE' && items[index]!.kind === 'LEATHER' ? { oneDyeBatch: false } : {}),
            description: sampleLineDescription(line.what, language, line.description),
          })
          lineIds.push(made.id)
        } catch (error) {
          throw atLine(error, index)
        }
      }
      await linesChanged(tools, order, { added: lineIds.length }, {
        action: 'purchasing.sampleOrders.create',
        after: { kind: 'SAMPLE', developmentStyleId: style!.id, style: style!.code, sampleRoundId: round?.id ?? null, round: round?.number ?? null, lineIds, what: body.lines.map((line) => line.what) },
      })
      // The order's header changed after its draft was made: it is a sample order now (the list and the record read it again).
      tools.emit({ type: 'purchase_order.updated', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, fields: ['kind', 'developmentStyleId', 'sampleRoundId'] } })
      return { order: await sampleRowOf(tx, order.id) }
    })
    return result
  } catch (error) {
    throw databaseRefusal(error)
  }
}
