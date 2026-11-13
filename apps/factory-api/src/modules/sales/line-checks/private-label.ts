import { privateLabelFinding } from '@nexus/factory-domain/sales/quote-warnings/rules'
import type { LineCheck, LineFinding } from './index'
import { findingOf, labelsOf } from './warning-facts'

/**
 * Another customer's private-label style (B-W2b-294; follow-up QT1:02 "Quotes refuse another customer's private-label style";
 * PRD-010; Style.brandPartyId, B-W2b-206/227): BLOCKS. Only the brand buys its own style, or a rider of the brand's team
 * (B-W2b-290: a person whose team is the brand). The brand is not named (a reader limited to some customers may not know
 * it). It stops the quote's send and refuses an office order (its plan); a quote started from a template leaves such a
 * line out (./refuse.ts).
 */
export const privateLabelCheck: LineCheck = {
  key: 'private-label',
  async run(db, document) {
    if (!document.partyId) return []
    const styles = await db.style.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.styleId))] }, brandPartyId: { not: null } }, select: { id: true, code: true, brandPartyId: true } })
    if (styles.length === 0) return []
    const party = await db.party.findUnique({ where: { id: document.partyId }, select: { id: true, teamPartyId: true } })
    if (!party) return []
    const labels = await labelsOf(db, document)
    const findings: LineFinding[] = []
    for (const line of document.lines) {
      const style = styles.find((row) => row.id === line.styleId)
      if (!style) continue
      const finding = privateLabelFinding({ seq: line.seq, label: labels.label(line) }, style, party, null)
      if (finding) findings.push(findingOf('private-label', finding, [line], { styleId: style.id }))
    }
    return findings
  },
}
