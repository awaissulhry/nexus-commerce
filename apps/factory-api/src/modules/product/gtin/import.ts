import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import type { ImportBody, ImportView } from '@nexus/factory-domain/product/gtin/contracts'
import { importVerdicts, type RowVerdict, type SkuFacts } from '@nexus/factory-domain/product/gtin/rules'
import { editRefusal } from '@nexus/factory-domain/product/lifecycle/rules'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { parseGtin } from '@nexus/factory-domain/product/styles/sku'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { editRuleOf, requireEditRule } from '../lifecycle/edit-rule'
import { emitSkus } from '../styles/skus'
import { contextOf, isUniqueViolation, lockStyle } from '../styles/store'
import { mayWrite } from '../materials/store'
import { gtinGuarded, shippedCells } from './store'

/**
 * A brand's own barcodes typed or imported (B-W2b-227; PRD-006: "type or import a brand's own barcodes per SKU"; a brand
 * sells under its own name and barcodes): a list of SKU code + GTIN rows, from any styles of the tenant.
 *
 *   POST /product/gtins/import  {rows: [{sku, gtin | null}], dryRun: true}    every row's verdict, nothing written
 *                               {rows, dryRun: false}                         written all together, or not at all
 *
 * product.styles.manage (W1's "SKUs and barcodes") over each SKU's style company. A row is refused in words when: no SKU of
 * that code among the styles the person sees; the SKU twice in the list; a GTIN not well formed (check digit, length); the
 * same GTIN twice in the list or on another SKU already; a shipped SKU's GTIN changed or removed; its style archived, its
 * edit rule blocking (DETAILS, B-W2b-221) or of a company the person may not change. The write is ONE command: every style
 * locked in id order (lockStyle, then its SKUs, as W1), the rows checked again inside it, then each SKU written with its own
 * audit row and one style.skus_changed per style.
 */

type Reader = FactoryClient | CommandTx

/** The facts of each SKU code of the rows, as `context` may know them (a style it may not see: no SKU). */
async function factsOf(db: Reader, context: RequestContext, codes: readonly string[]): Promise<{ facts: Map<string, SkuFacts>; styles: Map<string, { code: string; companyId: string | null }> }> {
  const actor = actorOf(context)
  const variants = await db.variant.findMany({ where: { sku: { in: [...codes] } }, select: { id: true, styleId: true, colourwayId: true, size: true, sku: true, gtin: true } })
  const styleRows = variants.length === 0 ? [] : await db.style.findMany({ where: { id: { in: [...new Set(variants.map((row) => row.styleId))] } }, select: { id: true, code: true, companyId: true, status: true } })
  const styles = new Map(styleRows.filter((row) => can(actor, PRODUCT_STYLES_VIEW, { companyId: row.companyId })).map((row) => [row.id, row]))
  const refusals = new Map<string, string | null>()
  const shipped = new Map<string, Set<string>>()
  for (const style of styles.values()) {
    let refusal: string | null = null
    if (!mayWrite(actor, PRODUCT_STYLES_MANAGE, style.companyId)) refusal = `You may not change the SKUs of style ${style.code}.`
    else if (style.status === 'ARCHIVED') refusal = `Style ${style.code} is archived: reactivate it before changing its barcodes.`
    else {
      const rule = await editRuleOf(db, style.id)
      refusal = editRefusal(rule.rule, 'DETAILS', rule.facts)?.message ?? null
    }
    refusals.set(style.id, refusal)
    shipped.set(style.id, await shippedCells(db, style.id))
  }
  const facts = new Map<string, SkuFacts>()
  for (const row of variants) {
    if (!styles.has(row.styleId)) continue
    facts.set(row.sku, { skuId: row.id, styleId: row.styleId, gtin: row.gtin, shipped: shipped.get(row.styleId)?.has(`${row.colourwayId}|${row.size}`) ?? false, refusal: refusals.get(row.styleId) ?? null })
  }
  return { facts, styles: new Map([...styles].map(([id, row]) => [id, { code: row.code, companyId: row.companyId }])) }
}

/** Who holds each GTIN of the rows (by SKU code); a SKU of a style the person cannot see still holds its GTIN. */
async function holdersOf(db: Reader, rows: ImportBody['rows']): Promise<Map<string, string>> {
  const gtins = [...new Set(rows.flatMap((row) => (row.gtin === null || row.gtin.trim() === '' ? [] : [parseGtin(row.gtin)])).flatMap((outcome) => (outcome.ok ? [outcome.gtin] : [])))]
  if (gtins.length === 0) return new Map()
  const held = await db.variant.findMany({ where: { gtin: { in: gtins } }, select: { gtin: true, sku: true } })
  return new Map(held.flatMap((row) => (row.gtin ? [[row.gtin, row.sku] as const] : [])))
}

async function verdictsOf(db: Reader, context: RequestContext, rows: ImportBody['rows']) {
  const lines = rows.map((row, index) => ({ line: index + 1, sku: row.sku.trim().toUpperCase(), gtin: row.gtin }))
  const known = await factsOf(
    db,
    context,
    lines.map((row) => row.sku),
  )
  const verdicts = importVerdicts(lines, known.facts, await holdersOf(db, rows))
  return { verdicts, styles: known.styles }
}

const countsOf = (verdicts: readonly RowVerdict[]) => ({
  set: verdicts.filter((row) => row.outcome === 'SET').length,
  cleared: verdicts.filter((row) => row.outcome === 'CLEARED').length,
  unchanged: verdicts.filter((row) => row.outcome === 'UNCHANGED').length,
  refused: verdicts.filter((row) => row.outcome === 'REFUSED').length,
})

const refusedError = (verdicts: readonly RowVerdict[]) =>
  new ValidationError(
    `${verdicts.filter((row) => row.outcome === 'REFUSED').length} row(s) cannot be written: correct them and check the list again.`,
    verdicts.filter((row) => row.outcome === 'REFUSED').slice(0, 50).map((row) => ({ path: `body/rows/${row.line - 1}`, message: row.message ?? 'Refused.' })),
  )

/** POST /product/gtins/import */
export async function importGtins(caller: CommandCaller, body: ImportBody, idempotencyKey?: string): Promise<ImportView> {
  const context = contextOf(caller)
  if (body.dryRun) {
    const { verdicts } = await caller.withClient((client) => verdictsOf(client, context, body.rows))
    return { dryRun: true, rows: verdicts, counts: countsOf(verdicts), applied: false }
  }
  const first = await caller.withClient((client) => verdictsOf(client, context, body.rows))
  if (first.verdicts.some((row) => row.outcome === 'REFUSED')) throw refusedError(first.verdicts)

  const { result } = await gtinGuarded(() =>
    command(caller, { name: 'product.gtins.import', idempotencyKey, input: body }, async (tools) => {
      const { tx } = tools
      // Every style of the list, locked in id order (two lists never wait on each other in a circle), each asked its rule.
      const styleIds = [...new Set(first.verdicts.flatMap((row) => (row.styleId ? [row.styleId] : [])))].sort()
      const locked = new Map<string, { code: string; companyId: string | null }>()
      for (const styleId of styleIds) {
        const style = await lockStyle(tx, styleId)
        locked.set(styleId, { code: style.code, companyId: style.companyId })
      }
      const { verdicts } = await verdictsOf(tx, tools.context, body.rows)
      if (verdicts.some((row) => row.outcome === 'REFUSED')) throw refusedError(verdicts)
      const changed = verdicts.filter((row) => row.outcome === 'SET' || row.outcome === 'CLEARED')
      for (const styleId of new Set(changed.map((row) => row.styleId!))) await requireEditRule(tx, styleId, 'DETAILS')
      // A GTIN on another SKU is refused even when its row frees it, so no order of the writes trips the unique key.
      for (const row of changed) {
        const { count } = await tx.variant.updateMany({ where: { id: row.skuId!, gtin: row.before }, data: { gtin: row.gtin, version: { increment: 1 } } })
        if (count !== 1) throw new ConflictError(`SKU ${row.sku} changed meanwhile: check the list again.`)
        const style = locked.get(row.styleId!)
        tools.audit({ recordType: 'Variant', recordId: row.skuId!, companyId: style?.companyId ?? null, before: { sku: row.sku, gtin: row.before }, after: { sku: row.sku, gtin: row.gtin }, ...(body.reason ? { reason: body.reason } : {}) })
      }
      for (const styleId of styleIds) {
        const style = locked.get(styleId)!
        const updated = changed.filter((row) => row.styleId === styleId).length
        emitSkus(tools, { id: styleId, code: style.code, companyId: style.companyId }, { created: [], archived: 0, restored: 0 }, updated)
      }
      // Nothing to write is still an answer: one audit row says the list was checked and applied.
      if (changed.length === 0) tools.audit({ recordType: 'Variant', recordId: verdicts[0]!.skuId!, after: { gtins: 'unchanged' } })
      return { dryRun: false, rows: verdicts, counts: countsOf(verdicts), applied: true }
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictError('A GTIN of the list was given to another SKU at the same time: check the list again.')
      throw error
    }),
  )
  return result
}
