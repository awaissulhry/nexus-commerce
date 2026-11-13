import { marketFinding } from '@nexus/factory-domain/sales/quote-warnings/rules'
import { marketOfCountry, readMarkets } from '../../compliance/gates/facts'
import type { LineCheck, LineFinding } from './index'
import { findingOf, labelsOf } from './warning-facts'

/**
 * A style not sold in the market the goods go to (B-W2b-294; SAL-147 "no certificate for the market"; Style.marketCodes of
 * B-W2b-275/283: empty means every market): WARNING. The market is the delivery address's country as the compliance gate reads
 * it (compliance/gates/facts marketOfCountry: the code, else its alias UK/GB, EL/GR). Each size's certificate at the promise
 * date stays W1's CERTIFICATE issue; the requirements of a market are the compliance gate's at release, label and shipment.
 */
export const marketsCheck: LineCheck = {
  key: 'markets',
  async run(db, document) {
    const country = document.shipToCountry?.trim().toUpperCase() || null
    if (!country) return []
    const styles = await db.style.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.styleId))] }, NOT: { marketCodes: { isEmpty: true } } }, select: { id: true, code: true, marketCodes: true } })
    if (styles.length === 0) return []
    const market = marketOfCountry(country, await readMarkets(db))
    const labels = await labelsOf(db, document)
    const findings: LineFinding[] = []
    for (const line of document.lines) {
      const style = styles.find((row) => row.id === line.styleId)
      if (!style) continue
      const finding = marketFinding({ seq: line.seq, label: labels.label(line) }, style, market ? { code: market.code, name: market.name } : null, country)
      if (finding) findings.push(findingOf('markets', finding, [line], { styleId: style.id, country, marketCode: market?.code ?? null, soldIn: style.marketCodes }))
    }
    return findings
  },
}
