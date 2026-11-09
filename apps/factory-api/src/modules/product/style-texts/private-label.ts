import type { FactoryClient, Prisma, QuoteStatus, SalesOrderStatus } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { PrivateLabelBody, PrivateLabelView } from '@nexus/factory-domain/product/style-texts/contracts'
import { declarationSender, privateLabelRefusal, shownTo } from '@nexus/factory-domain/product/style-texts/private-label'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { OPEN_STATES } from '@nexus/factory-domain/product/where-used/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { requireEditRule } from '../lifecycle/edit-rule'
import { assertMayWrite, brandProblems, contextOf, readStyle } from '../styles/store'

/**
 * A private-label style (B-W2b-227; PRD-010; factory-domain product/style-texts/private-label): the brand it is made for
 * (W1's Style.brandPartyId) and under whose name it is sold (Style.soldUnderOurName, Owner 11-09 question 3). Office.
 *
 *   GET /product/styles/:styleId/private-label   product.styles.view: the mark (brand, sold under whose name, who sees it in
 *                                                the portal, who sends its declaration of conformity) and the other
 *                                                customers' open quotes and orders that name it
 *   PUT /product/styles/:styleId/private-label   product.styles.manage: {version, brandPartyId, soldUnderOurName} at the
 *                                                style's version; the style's SPEC (its edit rule, B-W2b-221)
 *
 * The portal shows a private-label style to its brand only (sales/portal-ordering mayOffer; threads and approval requests
 * name the brand as their party). Refused in words before the database (Style_w2b4_depth): sold under our name without a
 * brand; and, as W1's PATCH, another brand while the style's thread is shared with the one it had.
 */

type Reader = FactoryClient | CommandTx

const partyRef = (row: { id: string; code: string; legalName: string; tradeName: string | null }) => ({ id: row.id, code: row.code, name: row.tradeName?.trim() || row.legalName })

/** Other customers' open quotes and orders naming the style (the records `context` may read). */
async function otherCustomers(db: Reader, context: RequestContext, styleId: string, brandPartyId: string | null): Promise<PrivateLabelView['otherCustomers']> {
  if (brandPartyId === null) return { openQuotes: 0, openOrders: 0, parties: [] }
  const actor = actorOf(context)
  const quoteLines = await db.quoteLine.findMany({ where: { styleId, partyId: { not: brandPartyId } }, select: { versionId: true }, distinct: ['versionId'] })
  const versions = quoteLines.length === 0 ? [] : await db.quoteVersion.findMany({ where: { id: { in: quoteLines.map((line) => line.versionId) } }, select: { quoteId: true, revision: true } })
  const quotes =
    versions.length === 0
      ? []
      : await db.quote.findMany({
          where: { AND: [{ id: { in: [...new Set(versions.map((row) => row.quoteId))] } }, { status: { in: OPEN_STATES.QUOTES as QuoteStatus[] } }, scopeWhere(actor, 'quotes.view', { company: 'companyId' }) as Prisma.QuoteWhereInput] },
          select: { id: true, partyId: true, currentRevision: true },
        })
  const current = quotes.filter((quote) => versions.some((row) => row.quoteId === quote.id && row.revision === quote.currentRevision))
  const orderLines = await db.salesOrderLine.findMany({ where: { styleId, partyId: { not: brandPartyId } }, select: { orderId: true }, distinct: ['orderId'] })
  const orders =
    orderLines.length === 0
      ? []
      : await db.salesOrder.findMany({
          where: { AND: [{ id: { in: orderLines.map((line) => line.orderId) } }, { status: { in: OPEN_STATES.SALES_ORDERS as SalesOrderStatus[] } }, scopeWhere(actor, 'orders.view', { company: 'companyId' }) as Prisma.SalesOrderWhereInput] },
          select: { id: true, partyId: true },
        })
  const partyIds = [...new Set([...current.map((row) => row.partyId), ...orders.map((row) => row.partyId)])]
  const parties = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true }, orderBy: { code: 'asc' } })
  return { openQuotes: current.length, openOrders: orders.length, parties: parties.map(partyRef) }
}

/** The private-label view of a style (a read, or a command's answer with its transaction). */
export async function privateLabelViewOf(db: Reader, context: RequestContext, styleId: string): Promise<PrivateLabelView> {
  const style = await db.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, code: true, name: true, companyId: true, version: true, brandPartyId: true, soldUnderOurName: true } })
  const brand = style.brandPartyId === null ? null : await db.party.findUnique({ where: { id: style.brandPartyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const others = await otherCustomers(db, context, styleId, style.brandPartyId)
  const warnings =
    others.openQuotes + others.openOrders > 0
      ? [
          {
            code: 'OTHER_CUSTOMERS_OPEN',
            message: `${others.openQuotes} open quote(s) and ${others.openOrders} open order(s) of other customers (${others.parties.map((party) => party.code).join(', ')}) name this private-label style: they go on as they are, but the portal offers the style to its brand only.`,
          },
        ]
      : []
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, version: style.version },
    brand: brand ? partyRef(brand) : null,
    soldUnderOurName: style.soldUnderOurName,
    shownTo: shownTo(style),
    declarationSender: declarationSender(style),
    otherCustomers: others,
    warnings,
  }
}

/** GET /product/styles/:styleId/private-label */
export async function readPrivateLabel(caller: CommandCaller, styleId: string): Promise<PrivateLabelView> {
  await readStyle(caller, styleId)
  const context = contextOf(caller)
  return caller.withClient((client) => privateLabelViewOf(client, context, styleId))
}

/** PUT /product/styles/:styleId/private-label */
export async function setPrivateLabel(caller: CommandCaller, styleId: string, body: PrivateLabelBody, idempotencyKey?: string): Promise<PrivateLabelView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const words = privateLabelRefusal(seen.code, body)
  if (words) throw new ValidationError('The private label is not valid.', [{ path: 'body/soldUnderOurName', message: words }])
  const { result } = await command(
    caller,
    { name: 'product.styles.setPrivateLabel', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, companyId: true, status: true, brandPartyId: true, soldUnderOurName: true } })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`Style ${row.code} is archived: reactivate it before changing who it is made for.`)
      const changed = [...(body.brandPartyId !== row.brandPartyId ? ['brandPartyId'] : []), ...(body.soldUnderOurName !== row.soldUnderOurName ? ['soldUnderOurName'] : [])]
      if (changed.length > 0) {
        // Who a style is made for and under whose name it is sold are its spec (its label, its declaration's sender).
        await requireEditRule(tx, styleId, 'SPEC')
        if (changed.includes('brandPartyId')) {
          const problems = await brandProblems(tx, body.brandPartyId, row.companyId)
          if (problems.length > 0) throw new ValidationError('The private label is not valid.', problems)
          if (row.brandPartyId !== null) {
            // As W1's PATCH: the style's thread shares its messages with the brand it had; another brand would read them.
            const shared = await tx.thread.findFirst({ where: { recordType: 'Style', recordId: styleId, partyId: row.brandPartyId }, select: { id: true } })
            if (shared) throw new ConflictError(`Style ${row.code}'s thread is shared with its brand: its brand stays (another brand's style is a new style).`)
          }
        }
        await tx.style.update({ where: { id: styleId }, data: { brandPartyId: body.brandPartyId, soldUnderOurName: body.soldUnderOurName }, select: { id: true } })
        tools.emit({ type: 'style.updated', subject: styleId, companyId: row.companyId, payload: { styleId, code: row.code, fields: changed } })
      }
      tools.audit({
        action: 'product.styles.setPrivateLabel',
        recordType: 'Style',
        recordId: styleId,
        companyId: row.companyId,
        before: { brandPartyId: row.brandPartyId, soldUnderOurName: row.soldUnderOurName },
        after: { brandPartyId: body.brandPartyId, soldUnderOurName: body.soldUnderOurName },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return privateLabelViewOf(tx, tools.context, styleId)
    },
  )
  return result
}
