import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { AssignBody, AssignView } from '@nexus/factory-domain/product/gtin/contracts'
import { PRODUCT_GTINS_MANAGE } from '@nexus/factory-domain/product/gtin/permissions'
import { candidates, planAllocation, type AllocationPlan, type RangeState, type SkuToNumber } from '@nexus/factory-domain/product/gtin/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { requireEditRule } from '../lifecycle/edit-rule'
import { emitSkus } from '../styles/skus'
import { assertMayWrite, contextOf, isUniqueViolation, lockStyle, readStyle } from '../styles/store'
import { allocationGate, gtinGuarded, RANGE_COLUMNS, rangeViewOf, readRange, type RangeRow } from './store'

/**
 * GTINs for a style's SKUs from the company's GS1 range (B-W2b-227; PRD-006; design products.styles › "Assign GTINs": GS1
 * prefix range, next free numbers, preview per SKU, never reuses a GTIN, "Assign N GTINs").
 *
 *   POST /product/styles/:styleId/gtins/assign  {rangeId, skuIds?, dryRun: true}    the preview: which SKU gets which GTIN
 *                                               {rangeId, skuIds?, dryRun: false, rangeVersion, count}   the confirm
 *
 * product.gtins.manage over the range's company AND the style's (a company's style takes its own company's numbers; a
 * tenant-wide style any company's). SKUs: those asked, else every SKU switched on without a GTIN, colourway by colourway in
 * the range's size order. A reference whose GTIN is on a SKU already is skipped, never given twice. The confirm is ONE
 * command: the range row locked at the version the preview read (command()'s record guard), then the style (lockStyle,
 * its edit rule DETAILS), the SKUs again; when what it would give is not what the preview showed (another assignment, a
 * SKU changed) it refuses (409, preview again) rather than give other numbers. GATE-SPEND: the confirm is refused in words
 * outside local and test runs until the Owner's word (factory-domain product/gtin allocationRefusal); the preview works.
 */

type Reader = FactoryClient | CommandTx

interface Selection {
  readonly skus: SkuToNumber[]
  readonly notNumbered: { skuId: string; sku: string; message: string }[]
}

/** The SKUs to number, in matrix order, and the ones asked for that are not numbered (with why). */
async function selectSkus(db: Reader, styleId: string, skuIds: readonly string[] | undefined): Promise<Selection> {
  const style = await db.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })
  const colourways = await db.colourway.findMany({ where: { styleId }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
  const variants = await db.variant.findMany({ where: skuIds ? { id: { in: [...skuIds] } } : { styleId }, select: { id: true, styleId: true, colourwayId: true, size: true, sku: true, gtin: true, status: true } })
  const colourwayOrder = new Map(colourways.map((row, index) => [row.id, index]))
  const sizeOrder = new Map(style.sizes.map((size, index) => [size, index]))
  const ordered = [...variants].sort((a, b) => (colourwayOrder.get(a.colourwayId) ?? 0) - (colourwayOrder.get(b.colourwayId) ?? 0) || (sizeOrder.get(a.size) ?? 999) - (sizeOrder.get(b.size) ?? 999) || a.sku.localeCompare(b.sku))
  const skus: SkuToNumber[] = []
  const notNumbered: Selection['notNumbered'] = []
  for (const id of skuIds ?? []) if (!variants.some((row) => row.id === id)) notNumbered.push({ skuId: id, sku: '', message: 'Not a SKU of this style.' })
  for (const row of ordered) {
    const asked = skuIds !== undefined
    if (row.styleId !== styleId) notNumbered.push({ skuId: row.id, sku: row.sku, message: 'Not a SKU of this style.' })
    else if (row.gtin !== null) {
      if (asked) notNumbered.push({ skuId: row.id, sku: row.sku, message: `SKU ${row.sku} has GTIN ${row.gtin} already.` })
    } else if (row.status !== 'ACTIVE') {
      if (asked) notNumbered.push({ skuId: row.id, sku: row.sku, message: `SKU ${row.sku} is switched off: switch it on first.` })
    } else skus.push({ skuId: row.id, sku: row.sku })
  }
  return { skus, notNumbered }
}

/** The plan with every reference it would give checked against the GTINs on SKUs (window by window). */
async function planFor(db: Reader, range: RangeState, skus: readonly SkuToNumber[]): Promise<AllocationPlan> {
  const held = new Set<string>()
  let checkedUpTo = range.nextReference - 1
  for (;;) {
    const plan = planAllocation(range, skus, held)
    const lastUsed = plan.nextReference - 1
    if (lastUsed <= checkedUpTo) return plan
    const window = candidates(range, checkedUpTo + 1, lastUsed - checkedUpTo)
    const rows = await db.variant.findMany({ where: { gtin: { in: window } }, select: { gtin: true } })
    checkedUpTo = lastUsed
    if (rows.length === 0) return plan
    for (const row of rows) if (row.gtin) held.add(row.gtin)
  }
}

function checkRangeFits(range: RangeRow, style: { code: string; companyId: string | null }): void {
  if (range.status !== 'ACTIVE') throw new InvalidStateError(`GTIN range ${range.name} is archived: restore it, or pick another.`)
  if (style.companyId !== null && range.companyId !== style.companyId) {
    throw new ValidationError('The GTIN range does not fit.', [{ path: 'body/rangeId', message: `Style ${style.code} takes GTINs of its own company's ranges.` }])
  }
}

const viewOf = (dryRun: boolean, range: RangeRow, plan: AllocationPlan, selection: Selection): AssignView => ({
  dryRun,
  range: rangeViewOf(range),
  rangeVersion: range.version,
  assignments: [...plan.assignments],
  skipped: [...plan.skipped],
  count: plan.assignments.length,
  short: plan.short,
  notNumbered: selection.notNumbered,
  allocation: allocationGate(),
})

/** POST /product/styles/:styleId/gtins/assign */
export async function assignGtins(caller: CommandCaller, styleId: string, body: AssignBody, idempotencyKey?: string): Promise<AssignView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  const range = await readRange(caller, body.rangeId)
  assertMayWrite(context, PRODUCT_GTINS_MANAGE, range.companyId)
  if (seen.companyId !== null) assertMayWrite(context, PRODUCT_GTINS_MANAGE, seen.companyId)
  checkRangeFits(range, seen)
  if (seen.status === 'ARCHIVED') throw new InvalidStateError(`Style ${seen.code} is archived: reactivate it before giving its SKUs GTINs.`)

  if (body.dryRun) {
    return caller.withClient(async (client) => {
      const selection = await selectSkus(client, styleId, body.skuIds)
      return viewOf(true, range, await planFor(client, range, selection.skus), selection)
    })
  }

  const gate = allocationGate()
  if (!gate.open) throw new ConflictError(gate.message ?? 'Assigning GTINs from a range is not open here.')
  if (body.rangeVersion === undefined || body.count === undefined) {
    throw new ValidationError('Preview first.', [{ path: 'body/rangeVersion', message: 'Send the preview\'s rangeVersion and count with the confirm.' }])
  }
  const { result } = await gtinGuarded(() =>
    command(
      caller,
      { name: 'product.gtins.assign', idempotencyKey, input: { styleId, ...body }, record: { type: 'GtinRange', id: body.rangeId, expectedVersion: body.rangeVersion } },
      async (tools) => {
        const { tx } = tools
        const current = await tx.gtinRange.findUniqueOrThrow({ where: { id: body.rangeId }, select: RANGE_COLUMNS })
        const locked = await lockStyle(tx, styleId)
        if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before giving its SKUs GTINs.`)
        checkRangeFits(current, locked)
        await requireEditRule(tx, styleId, 'DETAILS')
        const selection = await selectSkus(tx, styleId, body.skuIds)
        const plan = await planFor(tx, current, selection.skus)
        if (plan.assignments.length !== body.count) {
          throw new ConflictError(`The preview gave ${body.count} GTIN(s); now it would give ${plan.assignments.length} (SKUs changed meanwhile): preview again.`)
        }
        if (plan.assignments.length === 0) throw new InvalidStateError(selection.skus.length === 0 ? 'No SKU of this style waits for a GTIN.' : `GTIN range ${current.name} has no number left.`)
        for (const entry of plan.assignments) {
          const { count } = await tx.variant.updateMany({ where: { id: entry.skuId, styleId, gtin: null }, data: { gtin: entry.gtin, version: { increment: 1 } } })
          if (count !== 1) throw new ConflictError(`SKU ${entry.sku} was given a GTIN meanwhile: preview again.`)
          tools.audit({ recordType: 'Variant', recordId: entry.skuId, companyId: locked.companyId, before: { sku: entry.sku, gtin: null }, after: { sku: entry.sku, gtin: entry.gtin, gtinRangeId: current.id, reference: entry.reference } })
        }
        await tx.gtinRange.update({ where: { id: current.id }, data: { nextReference: plan.nextReference }, select: { id: true } })
        tools.audit({
          recordType: 'GtinRange',
          recordId: current.id,
          companyId: current.companyId,
          before: { nextReference: current.nextReference },
          after: { nextReference: plan.nextReference, given: plan.assignments.length, skipped: plan.skipped.map((entry) => entry.gtin), styleId },
          ...(body.reason ? { reason: body.reason } : {}),
        })
        emitSkus(tools, { id: styleId, code: locked.code, companyId: locked.companyId }, { created: [], archived: 0, restored: 0 }, plan.assignments.length)
        tools.emit({ type: 'gtin_range.changed', subject: current.id, companyId: current.companyId, payload: { gtinRangeId: current.id, companyId: current.companyId, name: current.name, change: 'ASSIGNED', given: plan.assignments.length } })
        const after = await tx.gtinRange.findUniqueOrThrow({ where: { id: current.id }, select: RANGE_COLUMNS })
        return viewOf(false, after, plan, selection)
      },
    ).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictError('A GTIN of this preview was given to another SKU at the same time: preview again.')
      throw error
    }),
  )
  return result
}
