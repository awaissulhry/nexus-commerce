import { toUtcIso } from '@nexus/factory-domain/core/time'
import { OPENING_IMPORTER_KEY, stockWords } from '@nexus/factory-domain/inventory/opening/rules'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { lotStateWords } from '@nexus/factory-domain/inventory/receipts/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { seesCost, siteFor, stockContextOf } from '../ledger/access'
import type { WAITING } from './contract'

/**
 * A site's opening stock (B-W1-35; A2 SCR-060 st-import, admin.overview "Opening stock imported"): what the OPENING moves
 * put in (less their reversals) per material and colour, in two numbers for leather ("37 hides · 412.5 m²"), the opening
 * lots with their state in words and why each one waits (its chromium VI result, a failed result to reject, a PPE
 * component's documents, or only the release by a quality person who did not import it: B-W1-34), the lines no cost
 * valued, the value (the cost grain) and the company's opening-stock imports. inventory.stock.view over the site.
 */

type Waiting = (typeof WAITING)[number]

const plain = (value: Decimal): string => value.toFixed(4)
/** A value of the cost grain (marked: the answer's grain filter drops it for anyone without money.cost); null: none. */
const valueOf = (amount: number | null, currency: string | null) => asMoney('cost', amount === null || currency === null ? null : { currency, valueAmount: asMoney('cost', amount) })

export async function openingSummary(caller: CommandCaller, siteId: string) {
  const context = stockContextOf(caller)
  const site = await siteFor(caller, siteId, INVENTORY_STOCK_VIEW)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const moves = await client.stockMove.findMany({
      where: { siteId: site.id, reason: 'OPENING' },
      select: { id: true, itemId: true, itemColourId: true, lotId: true, hideId: true, toLocationId: true, baseQuantity: true, reversalOfId: true, idempotencyKey: true },
    })
    const items = await client.item.findMany({ where: { id: { in: [...new Set(moves.map((move) => move.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true, currency: true, isPpeComponent: true } })
    const colours = await client.itemColour.findMany({ where: { id: { in: [...new Set(moves.flatMap((move) => (move.itemColourId ? [move.itemColourId] : [])))] } }, select: { id: true, code: true } })
    const lots = await client.lot.findMany({
      where: { id: { in: [...new Set(moves.flatMap((move) => (move.lotId ? [move.lotId] : [])))] }, receiptLineId: null },
      select: { id: true, code: true, itemId: true, itemColourId: true, supplierLotRef: true, dyeBatch: true, qualityStatus: true, crViStatus: true, requiresCrViTest: true, crViLimitMgKg: true, createdById: true, createdAt: true },
      orderBy: [{ code: 'asc' }],
    })
    // Which moves are valued (counted for everyone); their amounts only reach the cost grain.
    const valuations = await client.stockValuation.findMany({ where: { moveId: { in: moves.map((move) => move.id) } }, select: { moveId: true, valueAmount: true } })
    const jobs = await client.importJob.findMany({
      where: { importerKey: OPENING_IMPORTER_KEY, companyId: site.companyId },
      select: { id: true, status: true, rowCount: true, createCount: true, unchangedCount: true, errorCount: true, appliedCount: true, skippedCount: true, createdAt: true, appliedAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    })

    const itemOf = new Map(items.map((item) => [item.id, item]))
    const colourOf = new Map(colours.map((colour) => [colour.id, colour]))
    const valueByMove = new Map(valuations.map((valuation) => [valuation.moveId, valuation]))
    // A move in adds, its reversal (out of the location) takes away; a hide counts while it holds stock.
    const signed = (move: (typeof moves)[number]) => (move.toLocationId ? new Dec(move.baseQuantity.toString()) : new Dec(move.baseQuantity.toString()).negated())
    const hideNet = new Map<string, Decimal>()
    for (const move of moves) if (move.hideId) hideNet.set(move.hideId, (hideNet.get(move.hideId) ?? ZERO).plus(signed(move)))
    const liveHide = (hideId: string) => (hideNet.get(hideId) ?? ZERO).greaterThan(0)

    const totals = new Map<string, { itemId: string; colourId: string | null; quantity: Decimal; hides: Set<string>; lots: Set<string>; value: number; valued: boolean }>()
    const lotTotals = new Map<string, { quantity: Decimal; hides: Set<string> }>()
    for (const move of moves) {
      const key = `${move.itemId}|${move.itemColourId ?? '-'}`
      const total = totals.get(key) ?? { itemId: move.itemId, colourId: move.itemColourId, quantity: ZERO, hides: new Set<string>(), lots: new Set<string>(), value: 0, valued: false }
      total.quantity = total.quantity.plus(signed(move))
      if (move.hideId && liveHide(move.hideId)) total.hides.add(move.hideId)
      if (move.lotId) total.lots.add(move.lotId)
      const valuation = valueByMove.get(move.id)
      if (valuation) {
        total.value += valuation.valueAmount
        total.valued = true
      }
      totals.set(key, total)
      if (move.lotId) {
        const lot = lotTotals.get(move.lotId) ?? { quantity: ZERO, hides: new Set<string>() }
        lot.quantity = lot.quantity.plus(signed(move))
        if (move.hideId && liveHide(move.hideId)) lot.hides.add(move.hideId)
        lotTotals.set(move.lotId, lot)
      }
    }

    const lotViews = lots.map((lot) => {
      const item = itemOf.get(lot.itemId)!
      const limit = lot.crViLimitMgKg === null ? null : new Dec(lot.crViLimitMgKg.toString()).toFixed(3)
      const waitsFor: Waiting | null =
        lot.qualityStatus !== 'QUARANTINE'
          ? null
          : lot.crViStatus === 'FAIL'
            ? 'CR_VI_FAILED'
            : lot.requiresCrViTest && lot.crViStatus !== 'PASS'
              ? 'CR_VI_RESULT'
              : item.isPpeComponent
                ? 'PPE_DOCUMENTS'
                : 'RELEASE'
      const own = lotTotals.get(lot.id)
      return {
        id: lot.id,
        code: lot.code,
        item: { id: item.id, code: item.code },
        colour: lot.itemColourId ? (colourOf.get(lot.itemColourId) ?? null) : null,
        supplierLotRef: lot.supplierLotRef,
        dyeBatch: lot.dyeBatch,
        qualityStatus: lot.qualityStatus,
        crViStatus: lot.crViStatus,
        words: lotStateWords({ qualityStatus: lot.qualityStatus, requiresCrViTest: lot.requiresCrViTest, crViStatus: lot.crViStatus, crViLimitMgKg: limit, holdNote: null, isPpeComponent: item.isPpeComponent }),
        quantity: plain(own?.quantity ?? ZERO),
        hides: own?.hides.size ?? 0,
        waitsFor,
        importedById: lot.createdById,
        importedAt: toUtcIso(lot.createdAt),
      }
    })

    const totalViews = [...totals.values()]
      .map((total) => {
        const item = itemOf.get(total.itemId)!
        return {
          item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom },
          colour: total.colourId ? (colourOf.get(total.colourId) ?? null) : null,
          quantity: plain(total.quantity),
          hides: total.hides.size,
          lots: total.lots.size,
          words: stockWords([{ baseUom: item.baseUom, quantity: total.quantity, hides: total.hides.size }]),
          ...(withCost ? { value: valueOf(total.valued ? total.value : null, item.currency) } : {}),
        }
      })
      .sort((a, b) => (a.item.code === b.item.code ? ((a.colour?.code ?? '') < (b.colour?.code ?? '') ? -1 : 1) : a.item.code < b.item.code ? -1 : 1))

    const waiting = lotViews.filter((lot) => lot.waitsFor !== null)
    const byReason = Object.fromEntries((['CR_VI_RESULT', 'CR_VI_FAILED', 'PPE_DOCUMENTS', 'RELEASE'] as const).map((reason) => [reason, waiting.filter((lot) => lot.waitsFor === reason).length])) as Record<Waiting, number>
    // The imported lines (their moves' keys, `inventory.opening:<company>:<line>:<n>`), and those no cost valued.
    const imported = moves.filter((move) => move.reversalOfId === null && move.idempotencyKey.startsWith('inventory.opening:'))
    const lineOf = (move: (typeof moves)[number]) => move.idempotencyKey.slice(0, move.idempotencyKey.lastIndexOf(':'))
    const lines = new Set(imported.map(lineOf))
    const unvalued = new Set(imported.filter((move) => !valueByMove.has(move.id)).map(lineOf))
    const currencies = new Set(items.map((item) => item.currency))
    const totalValue = valuations.reduce((sum, valuation) => sum + valuation.valueAmount, 0)
    const waitWords = [
      byReason.CR_VI_RESULT > 0 ? `${byReason.CR_VI_RESULT} for their chromium VI result` : null,
      byReason.CR_VI_FAILED > 0 ? `${byReason.CR_VI_FAILED} failed it (reject them)` : null,
      byReason.PPE_DOCUMENTS > 0 ? `${byReason.PPE_DOCUMENTS} for their PPE certificate and documents` : null,
      byReason.RELEASE > 0 ? `${byReason.RELEASE} only for a quality person who did not import them to release them` : null,
    ].filter(Boolean)

    return {
      site: { id: site.id, code: site.code, name: site.name, companyId: site.companyId },
      lines: lines.size,
      words: stockWords(totalViews.map((total) => ({ baseUom: total.item.baseUom, quantity: total.quantity, hides: total.hides }))),
      byMaterial: totalViews,
      lots: lotViews,
      waiting: {
        lots: waiting.length,
        hides: waiting.reduce((sum, lot) => sum + lot.hides, 0),
        byReason,
        words: waiting.length === 0 ? 'No opening lot waits for release.' : `${waiting.length} opening lot${waiting.length === 1 ? ' waits' : 's wait'} for release: ${waitWords.join('; ')}.`,
      },
      unvaluedLines: unvalued.size,
      ...(withCost ? { value: valueOf(valuations.length > 0 ? totalValue : null, currencies.size === 1 ? [...currencies][0]! : null) } : {}),
      jobs: jobs.map((job) => ({ ...job, status: String(job.status), createdAt: toUtcIso(job.createdAt), appliedAt: job.appliedAt ? toUtcIso(job.appliedAt) : null })),
    }
  })
}
