import { markMoney } from '@nexus/factory-domain/money/marked'
import type { ProductType } from '@nexus/factory-domain/product/styles/rules'
import { minimumFindings, PRODUCT_TYPE_WORDS, type MinimumLine } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { activeMinimumsOf, minimumRuleOf } from '../pricing-depth/store'
import type { Reader } from '../quotes/store'
import type { LineCheck, LineCheckDocument, LineFinding } from './index'

/**
 * Minimum order quantities (B-W2b-325; SAL-178; factory-db MoqRule): the active rules of the document's company (and
 * every company's) for its price list (or every list), counted over its goods lines (factory-domain sales/pricing-depth
 * minimumFindings). A line is of a style; of a kind of garment through its style; of a material through its style
 * revision's BOM (the line's revision, else the style's released one) or a material chosen on the line as an option.
 *
 *   BLOCK      BLOCKS: the quote is not sent, an office order not made, below the minimum
 *   WARN       WARNING: said, nothing stops
 *   SURCHARGE  WARNING with the small-run surcharge (price grain) in its details: the line's price takes it with the
 *              waterfall (B-W2b-330); the waterfall has no step kind for it yet (named in the step's notes)
 */

async function linesOf(db: Reader, document: LineCheckDocument, needsMaterials: boolean): Promise<MinimumLine[]> {
  const styleIds = [...new Set(document.lines.map((line) => line.styleId))]
  const styles = new Map((await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, productType: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const materialsOf = new Map<string, string[]>()
  if (needsMaterials) {
    const released = await db.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: 'RELEASED' }, select: { id: true, styleId: true, revision: true }, orderBy: { revision: 'desc' } })
    const revisionOf = (line: LineCheckDocument['lines'][number]): string | null => line.styleRevisionId ?? released.find((row) => row.styleId === line.styleId)?.id ?? null
    const revisionIds = [...new Set(document.lines.flatMap((line) => { const id = revisionOf(line); return id ? [id] : [] }))]
    const bom = revisionIds.length === 0 ? [] : await db.bomLine.findMany({ where: { revisionId: { in: revisionIds } }, select: { revisionId: true, itemId: true } })
    for (const line of document.lines) {
      const revisionId = revisionOf(line)
      materialsOf.set(`${line.seq}`, [...new Set([...bom.filter((row) => row.revisionId === revisionId).map((row) => row.itemId), ...line.optionItemIds])])
    }
  }
  return document.lines.map((line) => {
    const style = styles.get(line.styleId)
    return {
      id: line.id,
      seq: line.seq,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      productType: (style?.productType ?? null) as ProductType | null,
      itemIds: materialsOf.get(`${line.seq}`) ?? line.optionItemIds,
      quantity: line.quantity,
      label: [style?.code, colourways.get(line.colourwayId)].filter(Boolean).join(' '),
    }
  })
}

export const minimumsCheck: LineCheck = {
  key: 'minimums',
  async run(db, document) {
    const rules = (await activeMinimumsOf(db, document.companyId)).map(minimumRuleOf)
    const binding = rules.filter((rule) => rule.priceListId === null || rule.priceListId === document.priceListId)
    if (binding.length === 0) return []
    const lines = await linesOf(db, document, binding.some((rule) => rule.itemId !== null))
    const styles = new Map((await db.style.findMany({ where: { id: { in: binding.flatMap((rule) => (rule.styleId ? [rule.styleId] : [])) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const items = new Map((await db.item.findMany({ where: { id: { in: binding.flatMap((rule) => (rule.itemId ? [rule.itemId] : [])) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const subjectOf = (rule: (typeof binding)[number]): string =>
      rule.styleId ? (styles.get(rule.styleId) ?? 'The style') : rule.productType ? `${PRODUCT_TYPE_WORDS[rule.productType].charAt(0).toUpperCase()}${PRODUCT_TYPE_WORDS[rule.productType].slice(1)}` : `Material ${items.get(rule.itemId!) ?? ''}`.trim()
    return minimumFindings(binding, { kind: document.kind, companyId: document.companyId, priceListId: document.priceListId, lines }, subjectOf).map(
      (finding): LineFinding => ({
        check: 'minimums',
        code: 'BELOW_MINIMUM',
        severity: finding.action === 'BLOCK' ? 'BLOCKS' : 'WARNING',
        lineIds: finding.lineIds,
        seqs: finding.seqs,
        message: finding.message,
        details: {
          ruleId: finding.ruleId,
          action: finding.action,
          per: finding.per,
          minQuantity: finding.minQuantity,
          quantity: finding.quantity,
          colourwayId: finding.colourwayId,
          // Each amount marked on its own: inside free JSON a key that looks like money is never shown unmarked.
          surcharge: finding.surcharge === null ? null : { amount: markMoney('price', finding.surcharge.amount), currency: finding.surcharge.currency, pct: markMoney('price', finding.surcharge.pct) },
        },
      }),
    )
  },
}
