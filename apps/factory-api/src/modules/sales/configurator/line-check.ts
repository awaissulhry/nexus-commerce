import { findingMessage, findingSeverity, optionsPriced, optionSourceIds, type ConfiguratorLineCode } from '@nexus/factory-domain/sales/configurator/rules'
import type { WaterfallStep } from '@nexus/factory-domain/sales/price-waterfall/rules'
import type { LineCheck, LineFinding } from '../line-checks/index'
import { checkStyleOptions } from '../../product/options/check'
import { storedSteps } from '../price-waterfall/quote-price'
import { decimal } from '../quotes/store'

/**
 * The configurator's line rule (B-W2b-340; SAL-133, SAL-136; one line of api sales/line-checks LINE_CHECKS): every goods line
 * of the quote version or order whose style offers options, or that has options, read by its id (a typed office order line
 * has none yet: the rule reads it when it has). Codes: factory-domain sales/configurator CONFIGURATOR_LINE_CODES (sales/quotes/
 * send SEND_CHECK_CODES lists them).
 *
 *   OPTIONS_REFUSED              the options chosen no longer pass B-W2b-229's check (a rule or an offer changed since): BLOCKS
 *                                a quote's send
 *   OPTIONS_MISSING              nothing chosen, and the style asks a choice its defaults do not give: BLOCKS a quote's send
 *   OPTIONS_OUTSIDE_CERTIFICATE  a chosen value takes the garment outside its certificate (its note): WARNING
 *   OPTIONS_NOT_PRICED           the options add to the price but the line's waterfall does not hold them (priced by hand
 *                                after the picks): WARNING, quotes only
 *
 * On an order every finding is a WARNING: its customer accepted it, and it is made as accepted.
 */
export const configuratorLineCheck: LineCheck = {
  key: 'configurator',
  async run(db, document) {
    const ids = document.lines.flatMap((line) => (line.id ? [line.id] : []))
    if (ids.length === 0) return []
    const quote = document.kind === 'QUOTE'
    const lines = quote
      ? await db.quoteLine.findMany({ where: { id: { in: ids }, kind: { not: 'FEE' } }, select: { id: true, seq: true, kind: true, styleId: true, priceSteps: true } })
      : await db.salesOrderLine.findMany({ where: { id: { in: ids }, kind: { not: 'FEE' } }, select: { id: true, seq: true, kind: true, styleId: true, priceSteps: true } })
    if (lines.length === 0) return []
    const offered = new Set((await db.styleOptionGroup.findMany({ where: { styleId: { in: [...new Set(lines.map((line) => line.styleId))] }, status: 'ACTIVE' }, select: { styleId: true } })).map((row) => row.styleId))
    const rows = quote
      ? await db.quoteLineOption.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, valueId: true, freeText: true, surchargeAmount: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      : await db.salesOrderLineOption.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, valueId: true, freeText: true, surchargeAmount: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const findings: LineFinding[] = []
    const add = (code: ConfiguratorLineCode, line: { id: string; seq: number }, detail: string | null, details: Record<string, unknown> = {}) =>
      findings.push({ check: 'configurator', code, severity: findingSeverity(code, document.kind), lineIds: [line.id], seqs: [line.seq], message: findingMessage(code, line.seq, detail), details })
    for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
      const own = rows.filter((row) => row.lineId === line.id)
      if (own.length === 0 && !offered.has(line.styleId)) continue
      const check = await checkStyleOptions(db, line.styleId, own.map((row) => ({ valueId: row.valueId, text: row.freeText })), { useDefaults: own.length === 0 })
      if (!check.check.ok) add(own.length === 0 ? 'OPTIONS_MISSING' : 'OPTIONS_REFUSED', line, check.check.blocks[0]?.message.en ?? null, { codes: check.check.blocks.map((block) => block.code) })
      if (check.summary.outsideCertificate) add('OPTIONS_OUTSIDE_CERTIFICATE', line, check.summary.certificateNotes.map((note) => note.note).filter((note) => note !== '').join(' ') || null, { valueIds: check.summary.certificateNotes.map((note) => note.valueId) })
      if (quote && line.kind === 'SIZE_GRID' && own.length > 0) {
        const steps: WaterfallStep[] | null = storedSteps(line.priceSteps)
        const sourceIds = optionSourceIds(steps)
        const sources = sourceIds.length === 0 ? [] : await db.quoteLineOption.findMany({ where: { id: { in: sourceIds } }, select: { id: true, valueId: true, surchargeAmount: true } })
        const priced = optionsPriced(steps, new Map(sources.map((row) => [row.id, { valueId: row.valueId, amount: decimal(row.surchargeAmount) }])), own.map((row) => ({ valueId: row.valueId, amount: decimal(row.surchargeAmount) })))
        if (!priced) add('OPTIONS_NOT_PRICED', line, null)
      }
    }
    return findings
  },
}
