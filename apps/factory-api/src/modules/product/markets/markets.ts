import { editRefusal } from '@nexus/factory-domain/product/lifecycle/rules'
import { ConflictError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { SetStyleMarketsBody, StyleMarketsView } from '@nexus/factory-domain/product/markets/contracts'
import { fitsStyle, marketChanges, marketCodesProblems, normaliseCode, orderedCodes } from '@nexus/factory-domain/product/markets/rules'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { FactoryClient } from '@nexus/factory-db'
import { editRuleOf, requireEditRule } from '../lifecycle/edit-rule'
import { mayWrite } from '../materials/store'
import { assertMayWrite, contextOf, readStyle } from '../styles/store'
import { choiceOf, marketRows } from './store'

/**
 * The markets a style is sold in (B-W2b-283, FU1:01; design products.styles rec:Style › Overview "Markets: a pick of the
 * company's market profiles"; factory-domain product/markets). Office.
 *
 *   GET /product/styles/:styleId/markets   product.styles.view: the list ([] = every market), the markets the pick offers
 *                                          (the style's company's and every company's; a tenant-wide style: every market)
 *                                          and every market it names, whether the caller may change it and why not now
 *   PUT /product/styles/:styleId/markets   product.styles.manage over the style's company: {version, marketCodes, reason?},
 *                                          the whole list at the style's version
 *
 * Where a style is sold is one of its details (the edit rule's DETAILS, B-W2b-221: it changes in every state but a blocked
 * one, as its season and names): it changes no spec, no revision. ONE command on the Style (its version is the
 * compare-and-set): the list in the markets' order, an audit row with what was added and removed, `style.updated`
 * {fields: ['marketCodes']}. Refused in words before the database's Style_w2b5_market_codes (400 `body/marketCodes/<i>`); a
 * database refusal all the same (two writes at once) answers 409 in words. The requirements gate reads the list
 * (./store.ts `soldThereTargets`).
 */

type Reader = FactoryClient | CommandTx

async function viewOf(db: Reader, styleId: string, mayChange: boolean): Promise<StyleMarketsView> {
  const style = await db.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, code: true, name: true, companyId: true, version: true, status: true, marketCodes: true } })
  const rows = await marketRows(db)
  const named = new Set(style.marketCodes)
  const markets = rows
    .filter((row) => named.has(row.code) || (row.status === 'ACTIVE' && fitsStyle(row, style.companyId)))
    .map((row) => ({
      code: row.code,
      name: row.name,
      nameI18n: textsOf(row.nameI18n),
      companyId: row.companyId,
      status: row.status === 'ARCHIVED' ? ('ARCHIVED' as const) : ('ACTIVE' as const),
      switchedOn: row.switchedOn,
      docLanguages: row.docLanguages,
      userInfoLanguages: row.userInfoLanguages,
      labelLanguages: row.labelLanguages,
      picked: named.has(row.code),
      offered: row.status === 'ACTIVE' && fitsStyle(row, style.companyId),
    }))
  let refusal: StyleMarketsView['refusal'] = null
  if (style.status === 'ARCHIVED') refusal = { code: 'STYLE_ARCHIVED', message: `Style ${style.code} is archived: reactivate it before changing where it is sold.` }
  else {
    const rule = await editRuleOf(db, styleId)
    refusal = editRefusal(rule.rule, 'DETAILS', rule.facts)
  }
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, version: style.version, status: style.status },
    marketCodes: orderedCodes(style.marketCodes, rows),
    standing: style.marketCodes.length === 0 ? 'EVERY_MARKET' : 'SOLD_THERE',
    markets,
    mayChange,
    refusal,
  }
}

const textsOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}

/** GET /product/styles/:styleId/markets */
export async function readStyleMarkets(caller: CommandCaller, styleId: string): Promise<StyleMarketsView> {
  const row = await readStyle(caller, styleId)
  const mayChange = mayWrite(actorOf(contextOf(caller)), PRODUCT_STYLES_MANAGE, row.companyId)
  return caller.withClient((client) => viewOf(client, styleId, mayChange))
}

/**
 * The database's own refusal of the list (Style_w2b5_market_codes: check_violation 'product: style … names …'), when a write
 * reached it past the checks above (a market archived or removed between the read and the write): a 409 in its words.
 */
function marketRefusal(error: unknown): never {
  const original = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string' && original.originalMessage.startsWith('product: style ') && original.originalMessage.includes(' market')) {
    const words = original.originalMessage.slice('product: '.length)
    throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}: read the markets again and pick again.`)
  }
  throw error
}

/** PUT /product/styles/:styleId/markets */
export async function setStyleMarkets(caller: CommandCaller, styleId: string, body: SetStyleMarketsBody, idempotencyKey?: string): Promise<StyleMarketsView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const codes = body.marketCodes.map(normaliseCode)
  // The same list again changes nothing (like a PATCH with no change): no command, no version bump.
  const stored = await caller.withClient((client) => client.style.findUniqueOrThrow({ where: { id: styleId }, select: { marketCodes: true, version: true } }))
  if (stored.version === body.version && codes.length === stored.marketCodes.length && codes.every((code) => stored.marketCodes.includes(code)) && new Set(codes).size === codes.length) return readStyleMarkets(caller, styleId)
  const { result } = await command(
    caller,
    { name: 'product.styles.setMarkets', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, companyId: true, status: true, marketCodes: true } })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`Style ${row.code} is archived: reactivate it before changing where it is sold.`)
      const rows = await marketRows(tx)
      const problems = marketCodesProblems({ codes, before: row.marketCodes, markets: new Map(rows.map((market) => [market.code, choiceOf(market)])), styleCompanyId: row.companyId })
      if (problems.length > 0) throw new ValidationError('The markets are not valid.', problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
      const next = orderedCodes(codes, rows)
      const { added, removed } = marketChanges(row.marketCodes, next)
      const moved = added.length > 0 || removed.length > 0 || next.join('|') !== row.marketCodes.join('|')
      if (moved) {
        // Where it is sold is a detail of the style (its season, its names): every state but a blocked one.
        await requireEditRule(tx, styleId, 'DETAILS')
        await tx.style.update({ where: { id: styleId }, data: { marketCodes: next }, select: { id: true } })
        tools.emit({ type: 'style.updated', subject: styleId, companyId: row.companyId, payload: { styleId, code: row.code, fields: ['marketCodes'] } })
      }
      tools.audit({
        action: 'product.styles.setMarkets',
        recordType: 'Style',
        recordId: styleId,
        companyId: row.companyId,
        before: { marketCodes: row.marketCodes },
        after: { marketCodes: next, added, removed },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return viewOf(tx, styleId, true)
    },
  ).catch(marketRefusal)
  return result
}
