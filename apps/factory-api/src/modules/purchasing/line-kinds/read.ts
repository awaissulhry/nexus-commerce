import type { z } from 'zod'
import { boughtInCheck } from '@nexus/factory-domain/compliance/certificates-depth/bought-in'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ItemKind, ItemTracking } from '@nexus/factory-domain/product/materials/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { certificateWords, endsBefore, isPpeLine } from '@nexus/factory-domain/purchasing/line-kinds/certificates'
import { rollsMatch, rollsOf, rollsQuantity, rollsWords, widthNote, ROLL_KINDS } from '@nexus/factory-domain/purchasing/line-kinds/rolls'
import { keepsVariantsApart } from '@nexus/factory-domain/purchasing/line-kinds/variants'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import type { CommandCaller } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { dayOf, mayOn, officeContextOf, officeOrder, quantityText, readLines, readOrder, type Reader as OrderReader } from '../store'
import type { lineKindsView } from './contract'
import { certificateCheckOf, kindChecks, readKindFacts, variantOf, widthOfItem, type LineKindFacts, type VariantRow } from './store'

/**
 * GET /purchasing/orders/:purchaseOrderId/line-kinds (purchasing.view over the order; B-W2b-328): each line by its kind —
 * a fabric or trim line's rolls with what they make, a protector line's certificate with its check today and the
 * register's certificates that cover it from this supplier, any line's variant with the material's variants that fit its
 * colour — and what a send checks of them now.
 */

export type LineKindsView = z.infer<typeof lineKindsView>

const buysAs = (kind: string, ppe: boolean): LineKindsView['lines'][number]['buysAs'] => (ppe ? 'PROTECTOR' : kind === 'TRIM' ? 'TRIM' : (ROLL_KINDS as readonly string[]).includes(kind) ? 'FABRIC' : 'OTHER')

const variantWords = (row: VariantRow, colours: ReadonlyMap<string, string>) => ({
  code: row.code,
  itemColourId: row.itemColourId,
  colourCode: row.itemColourId ? (colours.get(row.itemColourId) ?? null) : null,
  size: row.size,
  supplierCode: row.supplierCode,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
})

/** The view inside a command or a read (the caller's scope). */
export async function lineKindsOf(db: OrderReader, context: RequestContext, orderId: string, now: Date): Promise<LineKindsView> {
  const order = (await readOrder(db, orderId))!
  const lines = await readLines(db, order.id)
  const facts: LineKindFacts = await readKindFacts(db, order, lines)
  const today = businessDate(now)
  const colourIds = [...new Set([...facts.variants.values()].flat().flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const colours = new Map(colourIds.length === 0 ? [] : (await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const office = context.audience === 'office' ? context : null
  const mayChange = order.status === 'DRAFT' && office !== null && mayOn(office, PURCHASING_MANAGE, order)
  const open = lines.filter((line) => line.cancelledAt === null)
  return {
    orderId: order.id,
    number: order.number,
    status: order.status as PurchaseOrderStatus,
    version: order.version,
    kind: facts.sample ? 'SAMPLE' : 'STANDARD',
    mayChange,
    lines: lines.map((line) => {
      const item = facts.items.get(line.itemId)!
      const kind = facts.kinds.get(line.id)
      const ppe = isPpeLine(item)
      const rolls = kind ? rollsOf(kind) : null
      const width = widthOfItem(item)
      const named = certificateCheckOf(facts, line, kind?.certificateId ?? null, order.partyId, today)
      const variant = variantOf(facts, line, kind?.variantCode ?? null)
      const coverages = facts.coverages.get(line.itemId) ?? []
      // The register's certificates that hold today for this supplier: each one's own coverages, by the bought-in rule.
      const choices = ppe
        ? [...new Set(coverages.map((coverage) => coverage.certificate.id))].flatMap((certificateId) => {
            const check = boughtInCheck(
              coverages.filter((coverage) => coverage.certificate.id === certificateId),
              order.partyId,
              today,
            )
            if (check.state !== 'COVERED' && check.state !== 'COVERED_ANY_SUPPLIER') return []
            const certificate = facts.certificates.get(certificateId)!
            return [{ ...certificate, coverage: check.state === 'COVERED' ? ('THIS_SUPPLIER' as const) : ('ANY_SUPPLIER' as const) }]
          })
        : []
      return {
        id: line.id,
        seq: line.seq,
        itemId: line.itemId,
        itemCode: item.code,
        itemKind: item.kind as ItemKind,
        tracking: item.tracking as ItemTracking,
        itemColourId: line.itemColourId,
        quantity: quantityText(line.quantity),
        uom: line.uom as Uom,
        ended: line.cancelledAt !== null || line.closedShortAt !== null,
        buysAs: buysAs(item.kind, ppe),
        rolls: rolls
          ? { count: rolls.count, lengthM: rolls.lengthM, widthCm: rolls.widthCm, words: rollsWords(rolls), makes: rollsQuantity(rolls, line.uom as Uom), matches: rollsMatch(rolls, { quantity: line.quantity.toString(), uom: line.uom as Uom }) }
          : null,
        materialWidthCm: width,
        widthNote: widthNote(rolls, width),
        ppe,
        certificate:
          named && named.facts
            ? { ...named.facts, state: named.check.state, words: certificateWords(named.check, named.facts, item.code), endsBeforeNeed: endsBefore(named.facts, dayOf(line.needDate)!) }
            : null,
        certificateChoices: choices.sort((a, b) => (a.validTo === b.validTo ? a.number.localeCompare(b.number) : a.validTo < b.validTo ? 1 : -1)),
        variant: variant ? { ...(variant.row ? variantWords(variant.row, colours) : { code: kind!.variantCode!, itemColourId: null, colourCode: null, size: null, supplierCode: null, status: 'ARCHIVED' as const }), problem: variant.problem } : null,
        variantChoices: (facts.variants.get(line.itemId) ?? [])
          .filter((row) => row.status === 'ACTIVE' && (row.itemColourId === null || line.itemColourId === null || row.itemColourId === line.itemColourId))
          .map((row) => variantWords(row, colours)),
        keepsVariantsApart: keepsVariantsApart(item.tracking),
      }
    }),
    checks: order.status === 'DRAFT' ? kindChecks(facts, open, order.partyId, today) : [],
  }
}

/** GET …/line-kinds. */
export async function getLineKinds(caller: CommandCaller, orderId: string): Promise<{ kinds: LineKindsView }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return { kinds: await caller.withClient((client) => lineKindsOf(client, context, order.id, serverClock.now())) }
}
