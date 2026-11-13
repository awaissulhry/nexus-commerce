import { scopeFinding } from '@nexus/factory-domain/sales/quote-warnings/rules'
import type { LineCheck, LineFinding } from './index'
import { findingOf, labelsOf } from './warning-facts'

/**
 * A colourway or size outside the released scope (B-W2b-294; follow-up QT1:01 "Quote lines refuse a colourway or size outside
 * the released scope (inScope)"; PRD-191, B-W2b-231): BLOCKS. A line of a RELEASED revision names only the colourways and
 * sizes that revision is released for (StyleRevision.releasedColourwayIds / releasedSizes, as product/release readScope reads
 * them; factory-domain inScope; empty lists: every one). A line of a DRAFT revision is an estimate (W1's COST_ESTIMATE says
 * so) and is not checked here: it is released later, whole or in part, and its work order is held by the release then. It
 * stops the quote's send and refuses an office order; a quote started from a template leaves such a line out (./refuse.ts).
 */
export const releasedScopeCheck: LineCheck = {
  key: 'released-scope',
  async run(db, document) {
    const revisionIds = [...new Set(document.lines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
    if (revisionIds.length === 0) return []
    const revisions = new Map(
      (await db.styleRevision.findMany({ where: { id: { in: revisionIds }, status: 'RELEASED' }, select: { id: true, styleId: true, revision: true, releasedColourwayIds: true, releasedSizes: true } })).map((row) => [row.id, row]),
    )
    if (revisions.size === 0) return []
    const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set([...revisions.values()].map((row) => row.styleId))] } }, select: { id: true, code: true, sizes: true } })).map((row) => [row.id, row]))
    const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const labels = await labelsOf(db, document)
    const findings: LineFinding[] = []
    for (const line of document.lines) {
      const revision = line.styleRevisionId ? revisions.get(line.styleRevisionId) : undefined
      const style = revision ? styles.get(revision.styleId) : undefined
      if (!revision || !style) continue
      const scope = { colourwayIds: revision.releasedColourwayIds, sizes: revision.releasedSizes }
      const finding = scopeFinding({ seq: line.seq, label: labels.label(line), colourwayId: line.colourwayId, sizes: line.sizes ?? [] }, style, revision, scope, colourways.get(line.colourwayId) ?? '')
      if (finding) findings.push(findingOf('released-scope', finding, [line], { styleId: style.id, revisionId: revision.id }))
    }
    return findings
  },
}
