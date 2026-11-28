import type { Prisma } from '@nexus/factory-db'
import { businessDate } from '@nexus/factory-domain/core/time'
import { standardPartsOf } from '@nexus/factory-domain/costing/keep/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { finishedItemFor } from '../../inventory/finished/post'
import { linesOf } from '../sheet-versions/store'
import { keepStandardInCommand } from '../standards/standards'

/**
 * owb-pd3 (S4; pd3 addendum "Keep must leave a StandardCost behind") — the standards a kept cost leaves: when a cost sheet made by
 * Keep is APPROVED (at once by the same person where the company lets one person keep a cost, or later by Finance through the
 * approval engine), each active SKU of the product in its range gets a FROZEN standard cost from today — its parts from the sheet's
 * lines of its size (factory-domain costing/keep standardPartsOf: the 9 categories in the 4 parts, adding up to the size's cost),
 * the item's open frozen standard ended the day before, its waiting stock moves valued (standards.ts keepStandardInCommand). A SKU
 * without a finished item gets one (as Finance's prepare does). Every colourway takes the costed colourway's figures (one sheet per
 * product and company). owb-pd1's list margin and the price against cost read the dearest of them as KEPT.
 *
 * A standard that starts today already (a second Keep the same day): nothing is written, `keptToday` says so — the Keep command
 * refuses it in words (KEPT_TODAY), the approval of a sheet sent earlier stays approved and its standards follow from Finance.
 */

/** A sheet Keep made: its inputs carry `keep` (the reason and who asked). */
export function keptSheetOf(inputs: Prisma.JsonValue | null): { readonly reason: string } | null {
  const object = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? (inputs as Record<string, unknown>) : null
  const keep = object?.keep && typeof object.keep === 'object' && !Array.isArray(object.keep) ? (object.keep as Record<string, unknown>) : null
  return keep && typeof keep.reason === 'string' ? { reason: keep.reason } : null
}

export interface KeptSheet {
  readonly id: string
  readonly styleId: string
  readonly revisionId: string
  readonly companyId: string
  readonly currency: string
  readonly sheetVersion: number
}

/** The active SKUs of the style in its range, with their finished item when they have one. */
async function skusOf(tools: CommandTools, styleId: string) {
  const { tx } = tools
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, name: true, companyId: true, garmentTracking: true, sizes: true } })
  const variants = (await tx.variant.findMany({ where: { styleId, status: 'ACTIVE' }, select: { id: true, sku: true, colourwayId: true, size: true }, orderBy: { sku: 'asc' } })).filter((variant) => style.sizes.includes(variant.size))
  const items = variants.length === 0 ? [] : await tx.item.findMany({ where: { variantId: { in: variants.map((variant) => variant.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true } })
  return { style, variants, itemOf: new Map(items.flatMap((item) => (item.variantId ? [[item.variantId, item.id] as const] : []))) }
}

/** True when one of the product's finished items has a frozen standard of the company starting today or later. */
export async function keptTodayOf(tools: CommandTools, styleId: string, companyId: string): Promise<boolean> {
  const { variants, itemOf } = await skusOf(tools, styleId)
  const items = variants.flatMap((variant) => (itemOf.has(variant.id) ? [itemOf.get(variant.id)!] : []))
  if (items.length === 0) return false
  const today = new Date(`${businessDate(tools.now)}T00:00:00.000Z`)
  return (await tools.tx.standardCost.count({ where: { companyId, itemId: { in: items }, status: 'FROZEN', validFrom: { gte: today } } })) > 0
}

/** The standards of an approved kept sheet (see the module comment): how many were written, or `keptToday`. */
export async function keepStandardsInCommand(tools: CommandTools, sheet: KeptSheet, reason: string): Promise<{ readonly written: number; readonly keptToday: boolean }> {
  const { tx } = tools
  if (await keptTodayOf(tools, sheet.styleId, sheet.companyId)) return { written: 0, keptToday: true }
  const { style, variants, itemOf } = await skusOf(tools, sheet.styleId)
  if (variants.length === 0) return { written: 0, keptToday: false }
  const lines = await linesOf(tx, sheet.id)
  const colourways = new Map((await tx.colourway.findMany({ where: { styleId: sheet.styleId }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
  const day = businessDate(tools.now)
  let written = 0
  for (const variant of variants) {
    const itemId =
      itemOf.get(variant.id) ??
      (await finishedItemFor(tools, { variantId: variant.id, sku: variant.sku, colourwayId: variant.colourwayId, size: variant.size, itemId: null, itemCurrency: null }, { styleName: style.name, colourwayName: colourways.get(variant.colourwayId) ?? '', garmentTracking: style.garmentTracking, companyId: style.companyId }))
    // The routing's labour lines hold the step's minutes (a piece-rate line holds pieces: no minutes known for it).
    const minutes = lines.filter((line) => line.category === 'LABOUR' && line.source === 'ROUTING' && (line.size === null || line.size === variant.size)).reduce((sum, line) => sum.plus(line.quantity), new Dec(0))
    await keepStandardInCommand(tools, {
      companyId: sheet.companyId,
      itemId,
      currency: sheet.currency,
      validFrom: day,
      parts: standardPartsOf(lines, variant.size),
      labourMinutes: minutes.gt(0) ? decimalText(minutes.toString()) : null,
      breakdown: { basis: 'KEEP', sheetId: sheet.id, sheetVersion: sheet.sheetVersion, styleId: sheet.styleId, revisionId: sheet.revisionId, size: variant.size, colourwayId: variant.colourwayId, on: day },
      note: reason,
    })
    written += 1
  }
  return { written, keptToday: false }
}
